// The forecast winds and air for a launch (the launch planner), from NOAA's GFS, and with
// `ensemble` its 31-run ensemble (GEFS) too: see gfs.js.
// Signed-in people only, so the site does not pass on requests for anyone.
import { createClientFromRequest } from "npm:@base44/sdk";
import { gefsProfiles, gfsProfile } from "./gfs.js";

export default async function (req: Request): Promise<Response> {
  const base44 = createClientFromRequest(req);
  const me = await base44.auth.me().catch(() => null);
  if (!me?.email) return Response.json({ error: "Please sign in." }, { status: 401 });
  const { lat, lon, time, ensemble } = await req.json().catch(() => ({}));
  const when = new Date(String(time ?? ""));
  if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lon)) || Number.isNaN(when.getTime())) {
    return Response.json({ error: "Give a launch site (lat, lon) and time." }, { status: 400 });
  }
  try {
    const forecast = await gfsProfile({ lat: Number(lat), lon: Number(lon), time: when });
    if (!ensemble) return Response.json(forecast);
    // NOAA's ensemble too; without it the planner falls back to a fixed spread and says so.
    const members = await gefsProfiles({ lat: Number(lat), lon: Number(lon), time: when, ground: forecast.ground })
      .catch((e) => ({ error: e instanceof Error ? e.message : String(e) }));
    return Response.json({ ...forecast, ensemble: members });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
