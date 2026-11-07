// The launch planner's forecasts shared by the whole site (base44/functions/gfsWinds: nomads.js,
// forecaster.js): within NOAA's limit on requests, shared between sites in the same square, and
// the ensemble left out rather than waited for too long.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NoaaBusy, NotPublished, filterUrl, gefsUrl } from '../base44/functions/gfsWinds/gfs.js';
import { NomadsSource } from '../base44/functions/gfsWinds/nomads.js';
import { Forecaster } from '../base44/functions/gfsWinds/forecaster.js';

const gfs = readFileSync(join(import.meta.dirname, 'fixtures', 'gfs-black-rock-f012.grb2'));
const gefs = readFileSync(join(import.meta.dirname, 'fixtures', 'gefs-black-rock-p01-f012.grb2'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A stand-in for NOMADS: every run published, answering after `delay` ms; `asked` lists the requests. */
function nomads({ delay = 5, answer = null } = {}) {
  const asked = [];
  const fetch = async (url) => {
    asked.push({ url, at: Date.now() });
    await sleep(delay);
    if (answer) return answer(url);
    return new Response(url.includes('gefs') ? gefs : gfs);
  };
  return { fetch, asked };
}

test('sites in the same 1° square ask for the same files; others do not', () => {
  const run = new Date('2026-11-07T00:00:00Z');
  assert.equal(filterUrl(run, 12, 40.9, -119.06), filterUrl(run, 12, 40.2, -119.9));
  assert.notEqual(filterUrl(run, 12, 40.9, -119.06), filterUrl(run, 12, 41.1, -119.06));
  assert.equal(gefsUrl(run, 3, 12, 40.9, -119.06), gefsUrl(run, 3, 12, 40.01, -119.99));
  const q = new URL(filterUrl(run, 12, 40.9, -119.06)).searchParams;
  assert.deepEqual([q.get('bottomlat'), q.get('toplat'), q.get('leftlon'), q.get('rightlon')], ['39.75', '41.25', '-120.25', '-118.75']);
});

test('within the budget per minute: the rest wait their turn', async () => {
  const n = nomads();
  const src = new NomadsSource({ fetch: n.fetch, perMinute: 3, windowMs: 300 });
  const t0 = Date.now();
  await Promise.all([1, 2, 3, 4, 5].map((k) => src.fields(`https://x/f${k}?gefs`)));
  const late = n.asked.filter((a) => a.at - t0 >= 250).length;
  assert.equal(n.asked.length, 5);
  assert.equal(late, 2, 'the 4th and 5th went in the next window');
});

test('one request for a file several want at once, and none for a file already here', async () => {
  const n = nomads({ delay: 30 });
  const src = new NomadsSource({ fetch: n.fetch });
  const [a, b, c] = await Promise.all([1, 2, 3].map(() => src.fields('https://x/same?gefs')));
  assert.equal(n.asked.length, 1);
  assert.ok(a === b && b === c);
  await src.fields('https://x/same?gefs');
  assert.equal(n.asked.length, 1);
  assert.equal(src.waitFor(['https://x/same?gefs']), 0);
});

test('a run found unpublished is not asked for again for a while', async () => {
  const n = nomads({ answer: () => new Response('<html>No files</html>') });
  const src = new NomadsSource({ fetch: n.fetch });
  await assert.rejects(src.fields('https://x/a', 'gefs run1 12'), NotPublished);
  await assert.rejects(src.fields('https://x/b', 'gefs run1 12'), NotPublished);
  assert.equal(n.asked.length, 1);
});

test('when NOAA refuses: no more requests for a while, and those waiting are told', async () => {
  const n = nomads({ answer: () => new Response('Too many', { status: 429 }) });
  const src = new NomadsSource({ fetch: n.fetch, parallel: 1 });
  const results = await Promise.allSettled([src.fields('https://x/1'), src.fields('https://x/2'), src.fields('https://x/3')]);
  assert.ok(results.every((r) => r.status === 'rejected' && r.reason instanceof NoaaBusy));
  assert.equal(n.asked.length, 1);
  await assert.rejects(src.fields('https://x/4'), NoaaBusy);
  assert.equal(n.asked.length, 1);
  assert.ok(src.waitFor(['https://x/5']) > 200);
});

test('a second study nearby is answered from what the first downloaded', async () => {
  const n = nomads();
  const f = new Forecaster({ fetch: n.fetch });
  const time = new Date(Date.now() + 12 * 3600e3).toISOString();
  const one = await f.forecast({ lat: 40.9, lon: -119.06, time, ensemble: true });
  const first = n.asked.length;
  assert.equal(one.ensemble.members.length, 31);
  const two = await f.forecast({ lat: 40.6, lon: -119.4, time, ensemble: true });
  assert.equal(n.asked.length, first, 'no new requests');
  assert.equal(two.ensemble.members.length, 31);
  assert.ok(Math.abs(two.lat - 40.6) < 1e-9, 'the forecast is for the second site');
});

test('with others ahead, the ensemble is left out rather than waited for too long', async () => {
  const n = nomads();
  const f = new Forecaster({ fetch: n.fetch, perMinute: 10, windowMs: 2000, maxEnsembleWait: 0.5 });
  const notes = [];
  const time = new Date(Date.now() + 12 * 3600e3).toISOString();
  const r = await f.forecast({ lat: 40.9, lon: -119.06, time, ensemble: true }, (t) => notes.push(t));
  assert.ok(r.levels.length > 5, 'the main forecast');
  assert.match(r.ensemble.error, /busy/);
  assert.ok(n.asked.length <= 10, `${n.asked.length} requests`);
});
