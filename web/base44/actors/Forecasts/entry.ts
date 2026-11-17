// The Forecasts actor: one session ("noaa") for the whole site, through which the launch planner
// gets its forecast winds from NOAA. Everyone then shares one budget under NOAA's limit on
// requests, and the forecasts already downloaded (lib/forecaster.js and lib/nomads.js, copied
// from functions/gfsWinds by web/scripts/prebuild.mjs).
//
// Messages: { type: "forecast", rid, lat, lon, time, ensemble } -> { type: "progress", rid, text }
// while it waits its turn, then { type: "reply", rid, ok, data | error } (data as gfsWinds gives).
// Signed-in people with a plan only (lib/billing.js, copied from shared/ by scripts/prebuild.mjs).
import { Actor } from "base44:runtime/actors";
import { lookAccess, PLAN_MESSAGE, UPGRADE_MESSAGE } from "./lib/billing.js";
import { Forecaster } from "./lib/forecaster.js";

const forecaster = new Forecaster();

export default class Forecasts extends Actor {
  async handleConnect(conn: any) {
    if (conn.identity?.type !== "authenticated") {
      conn.reject(4001, "Please sign in.");
      return;
    }
    const access = await this.client.asServiceRole.entities.User.get(String(conn.identity.userId))
      .then((u: any) => lookAccess(this.client.asServiceRole.entities, { id: String(conn.identity.userId), created: u?.created_date ?? null, role: u?.role ?? null }))
      .catch(() => ({ ok: true, full: true })); // not known: let them in
    if (!access.ok) {
      conn.reject(4002, PLAN_MESSAGE);
      return;
    }
    if (access.full === false) {
      // The Launch Planner is not part of a plan for OpenRocket only.
      conn.reject(4002, UPGRADE_MESSAGE);
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
