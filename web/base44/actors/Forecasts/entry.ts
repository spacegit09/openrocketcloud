// The Forecasts actor: one session ("noaa") for the whole site, through which the launch planner
// gets its forecast winds from NOAA. Everyone then shares one budget under NOAA's limit on
// requests, and the forecasts already downloaded (lib/forecaster.js and lib/nomads.js, copied
// from functions/gfsWinds by web/scripts/prebuild.mjs).
//
// Messages: { type: "forecast", rid, lat, lon, time, ensemble } -> { type: "progress", rid, text }
// while it waits its turn, then { type: "reply", rid, ok, data | error } (data as gfsWinds gives).
import { Actor } from "base44:runtime/actors";
import { Forecaster } from "./lib/forecaster.js";

const forecaster = new Forecaster();

export default class Forecasts extends Actor {
  async handleConnect(conn: any) {
    if (conn.identity?.type !== "authenticated") {
      conn.reject(4001, "Please sign in.");
      return;
    }
    conn.send({ type: "hi" });
  }

  async handleMessage(conn: any, msg: any) {
    if (msg?.type !== "forecast" || typeof msg.rid !== "string") return;
    const send = (m: unknown) => {
      try {
        conn.send(m);
      } catch {
        // the page has gone
      }
    };
    // Not awaited: a study may wait its turn for NOAA, and others are answered meanwhile.
    forecaster
      .forecast(msg, (text: string) => send({ type: "progress", rid: msg.rid, text }))
      .then(
        (data: unknown) => send({ type: "reply", rid: msg.rid, ok: true, data }),
        (e: unknown) => send({ type: "reply", rid: msg.rid, ok: false, error: e instanceof Error ? e.message : String(e) }),
      );
  }

  async handleClose() {}

  handleTick() {}
}
