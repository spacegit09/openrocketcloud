// Winds and air for a launch from NOAA's GFS forecast (0.25°, public domain): the newest published
// run that covers the launch time, read from NOMADS's grib filter for the 1° square around the site
// (one small file per forecast hour, the same for every site in the square, so they can be shared),
// interpolated to the site and between forecast hours.
//
// Where the files come from is a `source` ({ fields(url, key) } resolving to the decoded GRIB
// fields): by default straight from NOMADS, kept a while (simpleSource); the site's Forecasts actor
// shares one source for everyone, under NOAA's limit on requests (nomads.js).
import { readGrib2, profileAt } from './grib2.js';

const FILTER = 'https://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_0p25.pl';
export const AGL_LEVELS = [10, 20, 30, 40, 50, 80, 100]; // m above ground
export const PRESSURE_LEVELS = [1000, 975, 950, 925, 900, 850, 800, 750, 700, 650, 600, 550, 500, 450, 400, 350, 300, 250, 200,
  150, 100, 70, 50, 30, 20, 10]; // hPa, up to about 30 km
const HOUR = 3600e3;
const PUBLISHED_AFTER = 3.5 * HOUR; // a run's files appear on NOMADS about this long after its start
const MAX_HOURS = 384;

/** The forecast hours a run has: every hour to 120, then every 3 hours to 384. */
export function hasHour(h) {
  return h >= 0 && h <= MAX_HOURS && (h <= 120 || h % 3 === 0);
}

/** The forecast hours either side of `time` in the run starting at `cycle`, and how far between them it is. */
export function bracket(cycle, time) {
  const h = (time - cycle) / HOUR;
  if (h < 0 || h > MAX_HOURS) return null;
  let h0 = Math.floor(h);
  while (!hasHour(h0)) h0--;
  let h1 = h0 === h ? h0 : h0 + 1;
  while (!hasHour(h1)) h1++;
  return { h0, h1, f: h1 === h0 ? 0 : (h - h0) / (h1 - h0) };
}

/** Runs (start times) that may be published by `now`, newest first. */
export function recentCycles(now, count = 8) {
  const latest = Math.floor((now - PUBLISHED_AFTER) / (6 * HOUR)) * 6 * HOUR;
  return Array.from({ length: count }, (_, k) => new Date(latest - k * 6 * HOUR));
}

const pad = (n) => String(n).padStart(2, '0');

/**
 * The area to ask for around a site: the 1° square it is in, one grid step wider on every side
 * (`step`, the grid's spacing), so the grid points around the site are always inside.
 */
export function square(lat, lon, step) {
  const s = Math.floor(lat);
  const w = Math.floor(lon);
  return {
    top: Math.min(90, s + 1 + step).toFixed(2),
    bottom: Math.max(-90, s - step).toFixed(2),
    left: (w - step).toFixed(2),
    right: (w + 1 + step).toFixed(2),
  };
}

export function filterUrl(cycle, hour, lat, lon) {
  const day = `${cycle.getUTCFullYear()}${pad(cycle.getUTCMonth() + 1)}${pad(cycle.getUTCDate())}`;
  const hh = pad(cycle.getUTCHours());
  const q = new URLSearchParams({
    dir: `/gfs.${day}/${hh}/atmos`,
    file: `gfs.t${hh}z.pgrb2.0p25.f${String(hour).padStart(3, '0')}`,
    var_UGRD: 'on', var_VGRD: 'on', var_HGT: 'on', var_TMP: 'on', lev_surface: 'on',
  });
  for (const l of AGL_LEVELS) q.set(`lev_${l}_m_above_ground`, 'on');
  for (const p of PRESSURE_LEVELS) q.set(`lev_${p}_mb`, 'on');
  const box = square(lat, lon, 0.25);
  q.set('subregion', '');
  q.set('toplat', box.top);
  q.set('bottomlat', box.bottom);
  q.set('leftlon', box.left);
  q.set('rightlon', box.right);
  return `${FILTER}?${q}`;
}

/** The file is not on NOMADS (yet): that run or forecast hour is not published. */
export class NotPublished extends Error {}

/** NOAA's server is refusing requests (too many from this site), or the site's share is used up. */
export class NoaaBusy extends Error {}

/** Downloads one file from NOMADS's grib filter and decodes it. */
export async function download(url, fetchFn = fetch) {
  const res = await fetchFn(url, { headers: { 'user-agent': 'RocketInCloud/1.0 (launch planner)' }, signal: AbortSignal.timeout(20_000) })
    .catch(() => {
      throw new Error("NOAA's forecast server did not answer. Try again in a moment.");
    });
  if (res.status === 403 || res.status === 429 || res.status === 503) {
    throw new NoaaBusy("NOAA's forecast server is busy. Try again in a few minutes.");
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  const grib = bytes.length > 4 && bytes[0] === 0x47 && bytes[1] === 0x52 && bytes[2] === 0x49 && bytes[3] === 0x42;
  if (!res.ok || !grib) {
    // NOMADS answers a page instead of data when the file is not there (yet).
    if (res.status === 404 || !grib) throw new NotPublished(`${url} is not available`);
    throw new Error(`NOAA's server answered ${res.status}.`);
  }
  return readGrib2(bytes);
}

/** Files straight from NOMADS, kept for 6 hours (`fetchFn` for tests). */
export function simpleSource(fetchFn = fetch) {
  const cache = new Map(); // url -> { at, fields }
  return {
    async fields(url) {
      const hit = cache.get(url);
      if (hit && Date.now() - hit.at < 6 * HOUR) return hit.fields;
      const fields = await download(url, fetchFn);
      if (cache.size > 500) cache.clear();
      cache.set(url, { at: Date.now(), fields });
      return fields;
    },
  };
}

const defaultSource = simpleSource();
const sourceFor = (source, fetchFn) => source ?? (fetchFn ? simpleSource(fetchFn) : defaultSource);

async function profileFor(source, key, url, lat, lon, ground = null) {
  return profileAt(await source.fields(url, key), lat, lon, { ground });
}

function mix(a, b, f) {
  return a === null || b === null ? (f < 0.5 ? a : b) : a + (b - a) * f;
}

/**
 * The forecast for a launch at `lat`, `lon` (degrees) and `time` (a Date): { model, run, valid,
 * lat, lon, ground (the model's ground height, m above sea level), levels: [{ agl, u, v, t, p }] }
 * (see profileAt in grib2.js), from the newest published run that covers the time.
 */
export async function gfsProfile({ lat, lon, time, now = new Date(), fetch: fetchFn = null, source = null }) {
  if (!(Math.abs(lat) <= 89.5) || !(Math.abs(lon) <= 180)) throw new Error('That is not a place on Earth.');
  const files = sourceFor(source, fetchFn);
  let missing = 0;
  for (const cycle of recentCycles(now)) {
    const b = bracket(cycle, time);
    if (!b) {
      if (time < cycle) continue; // an older run covers it
      throw new Error('GFS forecasts reach 16 days ahead: choose an earlier launch time.');
    }
    try {
      const [p0, p1] = await Promise.all([b.h0, b.h1].map((h, k) => (k && h === b.h0 ? null
        : profileFor(files, `gfs ${cycle.toISOString()} ${h}`, filterUrl(cycle, h, lat, lon), lat, lon))));
      const second = p1 ?? p0;
      const key = (l) => (l.p === null ? `agl ${l.agl}` : `p ${l.p}`);
      const later = new Map(second.levels.map((l) => [key(l), l]));
      const levels = p0.levels.map((l) => {
        const m = later.get(key(l)) ?? l;
        return { agl: mix(l.agl, m.agl, b.f), u: mix(l.u, m.u, b.f), v: mix(l.v, m.v, b.f), t: mix(l.t, m.t, b.f), p: l.p };
      });
      return { model: 'NOAA GFS 0.25°', run: cycle.toISOString(), valid: time.toISOString(), lat, lon, ground: mix(p0.ground, second.ground, b.f), levels };
    } catch (e) {
      if (!(e instanceof NotPublished) || ++missing > 3) throw e instanceof NotPublished ? new Error('No GFS forecast is available right now. Try again later.') : e;
    }
  }
  throw new Error('That launch time is too far in the past for the forecast.');
}

// ------------------------------------------------------------------ the ensemble (GEFS)

const GEFS_FILTER = 'https://nomads.ncep.noaa.gov/cgi-bin/filter_gefs_atmos_0p50a.pl';
export const GEFS_MEMBERS = 31; // the control run (gec00) and 30 perturbed runs (gep01-gep30)
export const GEFS_PRESSURE_LEVELS = [1000, 925, 850, 700, 500, 400, 300, 250, 200, 100, 50, 10];

/** The forecast hours an ensemble run has: every 3 hours to 240, then every 6 hours to 384. */
export function gefsHasHour(h) {
  return h >= 0 && h <= MAX_HOURS && (h <= 240 ? h % 3 === 0 : h % 6 === 0);
}

/** The ensemble's forecast hour nearest `time` in the run starting at `cycle`, or null. */
export function gefsHour(cycle, time) {
  const h = (time - cycle) / HOUR;
  if (h < -1.5 || h > MAX_HOURS + 1.5) return null;
  let best = null;
  for (let k = 0; k <= MAX_HOURS; k += 3) {
    if (gefsHasHour(k) && (best === null || Math.abs(k - h) < Math.abs(best - h))) best = k;
  }
  return best;
}

export function gefsUrl(cycle, member, hour, lat, lon) {
  const day = `${cycle.getUTCFullYear()}${pad(cycle.getUTCMonth() + 1)}${pad(cycle.getUTCDate())}`;
  const hh = pad(cycle.getUTCHours());
  const name = member === 0 ? 'gec00' : `gep${pad(member)}`;
  const q = new URLSearchParams({
    dir: `/gefs.${day}/${hh}/atmos/pgrb2ap5`,
    file: `${name}.t${hh}z.pgrb2a.0p50.f${String(hour).padStart(3, '0')}`,
    var_UGRD: 'on', var_VGRD: 'on', var_HGT: 'on', var_TMP: 'on', lev_10_m_above_ground: 'on',
  });
  for (const p of GEFS_PRESSURE_LEVELS) q.set(`lev_${p}_mb`, 'on');
  const box = square(lat, lon, 0.5);
  q.set('subregion', '');
  q.set('toplat', box.top);
  q.set('bottomlat', box.bottom);
  q.set('leftlon', box.left);
  q.set('rightlon', box.right);
  return `${GEFS_FILTER}?${q}`;
}

/** Runs `jobs` (functions returning promises) at most `limit` at a time; failures resolve to null. */
async function pool(jobs, limit) {
  const out = new Array(jobs.length);
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const k = next++;
      out[k] = await jobs[k]().catch(() => null);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, worker));
  return out;
}

/**
 * NOAA's ensemble forecast (GEFS, 0.5°, 31 runs from slightly different starting points) for a
 * launch: { model, run, valid (the forecast hour nearest the launch time), members: [{ member,
 * levels }] } with levels as in profileAt, heights above `ground` (the GFS ground height there).
 * With a source that knows its waits (waitFor(urls), seconds) and `maxWait`: NoaaBusy rather than
 * waiting longer for the members, and onWait(seconds) when there is a wait.
 */
export async function gefsProfiles({ lat, lon, time, ground, now = new Date(), fetch: fetchFn = null, source = null, maxWait = null, onWait = null }) {
  const files = sourceFor(source, fetchFn);
  let missing = 0;
  for (const cycle of recentCycles(now, 12)) {
    const hour = gefsHour(cycle, time);
    if (hour === null) {
      if (time < cycle) continue;
      throw new Error('Ensemble forecasts reach 16 days ahead: choose an earlier launch time.');
    }
    const key = `gefs ${cycle.toISOString()} ${hour}`;
    const get = (m) => profileFor(files, key, gefsUrl(cycle, m, hour, lat, lon), lat, lon, ground);
    try {
      await get(0); // the control run first: is this run published yet?
    } catch (e) {
      if (!(e instanceof NotPublished) || ++missing > 4) throw e instanceof NotPublished ? new Error('No ensemble forecast is available right now.') : e;
      continue;
    }
    const wait = files.waitFor?.(Array.from({ length: GEFS_MEMBERS }, (_, m) => gefsUrl(cycle, m, hour, lat, lon))) ?? 0;
    if (maxWait !== null && wait > maxWait) throw new NoaaBusy("NOAA's forecast server is busy with other launch plans right now");
    if (wait > 3) onWait?.(Math.round(wait));
    const profiles = await pool(Array.from({ length: GEFS_MEMBERS }, (_, m) => () => get(m)), 8);
    const members = profiles.map((p, m) => (p ? { member: m, levels: p.levels } : null)).filter(Boolean);
    if (members.length < 20) throw new Error("NOAA's ensemble forecast did not come through. Try again in a moment.");
    return { model: 'NOAA GEFS 0.5°', run: cycle.toISOString(), valid: new Date(cycle.getTime() + hour * HOUR).toISOString(), members };
  }
  throw new Error('That launch time is too far in the past for the ensemble forecast.');
}
