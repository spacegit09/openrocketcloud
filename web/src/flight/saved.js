// Saved Launch Planner flights (SavedFlight records, which only their owner sees): a study packed
// small — its settings, the forecast it flew in, the nominal flight's path and every flight's
// landing — so it can be shown again later without flying it again.
import { db } from '../base44.js';
import { packStudy, unpackStudy } from './study.js';

async function gzipBase64(text) {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function gunzipBase64(b64) {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

/** Saves a study under `name`; the record's summary line is `summary`. */
export async function saveFlight(name, study, summary, me) {
  return db.SavedFlight.create({
    owner_email: me.email,
    name,
    design_id: study.design.id,
    design_name: study.design.name,
    launch_time: study.when,
    summary,
    data: await gzipBase64(JSON.stringify(packStudy(study))),
  });
}

/** Your saved flights, newest first. */
export async function listFlights() {
  return db.SavedFlight.list('-created_date', 200);
}

export async function openFlight(record) {
  const r = typeof record === 'string' ? await db.SavedFlight.get(record) : record;
  if (!r) throw new Error('That saved flight no longer exists.');
  return { record: r, study: unpackStudy(JSON.parse(await gunzipBase64(r.data))) };
}

export async function deleteFlight(id) {
  return db.SavedFlight.delete(id);
}
