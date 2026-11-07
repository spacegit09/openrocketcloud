// NOAA GFS winds for the launch planner (base44/functions/gfsWinds). The fixture is a real NOMADS
// grib-filter subset: run 2026-11-06 18 UTC, 12 h ahead, 40.5–41.25°N 119.5–118.75°W (Black Rock
// Desert); its decoded values were checked against Open-Meteo's GFS for the same time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readGrib2, profileAt } from '../base44/functions/gfsWinds/grib2.js';
import { bracket, gefsHasHour, gefsHour, gefsProfiles, gfsProfile, hasHour, recentCycles } from '../base44/functions/gfsWinds/gfs.js';

const grib = readFileSync(join(import.meta.dirname, 'fixtures', 'gfs-black-rock-f012.grb2'));
// A member of NOAA's ensemble (GEFS run 2026-11-07 00 UTC, perturbed run 1, 12 h ahead), same place.
const gefs = readFileSync(join(import.meta.dirname, 'fixtures', 'gefs-black-rock-p01-f012.grb2'));
const direction = (l) => (Math.atan2(-l.u, -l.v) * 180 / Math.PI + 360) % 360; // where the wind comes from

test('reads the fields of a GRIB2 subset', () => {
  const fields = readGrib2(grib);
  assert.equal(fields.length, 122);
  assert.equal(fields[0].ref.toISOString(), '2026-11-06T18:00:00.000Z');
  assert.equal(fields[0].hours, 12);
  assert.deepEqual(fields[0].grid, { ni: 4, nj: 4, lat1: 40.5, lon1: -119.5, di: 0.25, dj: 0.25 });
  assert.deepEqual([...new Set(fields.map((f) => f.param))].sort(), ['HGT', 'TMP', 'UGRD', 'VGRD']);
});

test('the wind and air at a launch site, from the ground up', () => {
  const p = profileAt(readGrib2(grib), 40.9, -119.06);
  assert.equal(Math.round(p.ground), 1339);
  assert.deepEqual(p.levels.slice(0, 7).map((l) => l.agl), [10, 20, 30, 40, 50, 80, 100]);
  assert.ok(p.levels.every((l, k) => !k || l.agl > p.levels[k - 1].agl));
  assert.ok(!p.levels.some((l) => l.p === 90000 || l.p === 100000), 'pressure levels under the ground are left out');
  const at500 = p.levels.find((l) => l.p === 50000);
  // Open-Meteo's GFS: 8.7 m/s from 314°, −12.6 °C, 5820 m (a newer run, so close rather than equal).
  assert.ok(Math.abs(Math.hypot(at500.u, at500.v) - 9.2) < 0.1);
  assert.ok(Math.abs(direction(at500) - 318) < 1);
  assert.ok(Math.abs(at500.t - 273.15 + 12.5) < 0.1);
  assert.ok(Math.abs(at500.agl + p.ground - 5814) < 2);
});

test('forecast hours: hourly to 120 h, then every 3 h to 384 h', () => {
  assert.ok(hasHour(0) && hasHour(120) && hasHour(123) && hasHour(384));
  assert.ok(!hasHour(121) && !hasHour(385) && !hasHour(-1));
  const run = new Date('2026-11-06T18:00:00Z');
  assert.deepEqual(bracket(run, new Date('2026-11-07T06:30:00Z')), { h0: 12, h1: 13, f: 0.5 });
  assert.deepEqual(bracket(run, new Date('2026-11-11T19:00:00Z')), { h0: 120, h1: 123, f: 1 / 3 });
  assert.deepEqual(bracket(run, new Date('2026-11-07T06:00:00Z')), { h0: 12, h1: 12, f: 0 });
  assert.equal(bracket(run, new Date('2026-11-23T00:00:00Z')), null);
  assert.deepEqual(recentCycles(new Date('2026-11-07T02:50:00Z'), 2).map((d) => d.toISOString()),
    ['2026-11-06T18:00:00.000Z', '2026-11-06T12:00:00.000Z']);
});

test('uses the newest run that is published, between two forecast hours', async () => {
  const asked = [];
  const fetch = async (url) => {
    asked.push(new URL(url).searchParams.get('file'));
    const published = url.includes('gfs.20261106%2F18') || url.includes('gfs.20261106/18');
    return published ? new Response(grib) : new Response('<html>No files</html>', { status: 200 });
  };
  const r = await gfsProfile({ lat: 40.9, lon: -119.06, time: new Date('2026-11-07T06:30:00Z'), now: new Date('2026-11-07T04:00:00Z'), fetch });
  assert.equal(r.run, '2026-11-06T18:00:00.000Z');
  assert.deepEqual(asked.slice(-2), ['gfs.t18z.pgrb2.0p25.f012', 'gfs.t18z.pgrb2.0p25.f013']);
  assert.equal(r.levels.length, profileAt(readGrib2(grib), 40.9, -119.06).levels.length);
  await assert.rejects(gfsProfile({ lat: 40.9, lon: -119.06, time: new Date('2026-12-01T00:00:00Z'), now: new Date('2026-11-07T04:00:00Z'), fetch }), /16 days/);
});

test('ensemble files: the member, and heights above the ground GFS gives', () => {
  const fields = readGrib2(gefs);
  assert.equal(fields[0].member, 1);
  assert.equal(fields[0].grid.di, 0.5);
  assert.throws(() => profileAt(fields, 40.9, -119.06), /no ground height/);
  const p = profileAt(fields, 40.9, -119.06, { ground: 1339 });
  assert.equal(p.ground, 1339);
  assert.equal(p.levels[0].agl, 10);
  assert.ok(p.levels.length >= 8 && p.levels.every((l, k) => !k || l.agl > p.levels[k - 1].agl));
});

test('ensemble forecast hours: every 3 h to 240 h, then every 6 h to 384 h; the nearest is used', () => {
  assert.ok(gefsHasHour(237) && gefsHasHour(246) && !gefsHasHour(243) && !gefsHasHour(13));
  const run = new Date('2026-11-07T00:00:00Z');
  assert.equal(gefsHour(run, new Date('2026-11-07T13:00:00Z')), 12);
  assert.equal(gefsHour(run, new Date('2026-11-07T14:00:00Z')), 15);
  assert.equal(gefsHour(run, new Date('2026-11-17T04:00:00Z')), 246);
  assert.equal(gefsHour(run, new Date('2026-11-25T00:00:00Z')), null);
});

test('the ensemble: all 31 members from the newest published run', async () => {
  const asked = new Set();
  const fetch = async (url) => {
    const q = new URL(url).searchParams;
    asked.add(q.get('file').slice(0, 5));
    return q.get('dir').includes('gefs.20261107/00') ? new Response(gefs) : new Response('<html>No files</html>');
  };
  const e = await gefsProfiles({ lat: 40.9, lon: -119.06, time: new Date('2026-11-07T12:00:00Z'), ground: 1339, now: new Date('2026-11-07T07:30:00Z'), fetch });
  assert.equal(e.run, '2026-11-07T00:00:00.000Z');
  assert.equal(e.valid, '2026-11-07T12:00:00.000Z');
  assert.equal(e.members.length, 31);
  assert.ok(asked.has('gec00') && asked.has('gep30'));
});
