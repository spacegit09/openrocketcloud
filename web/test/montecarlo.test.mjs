// The launch planner's Monte Carlo study (src/flight/montecarlo.js): the varied conditions, wind
// turning, the landing ellipses and the ground grid.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SPREAD, ensembleWinds, groundFunction, landingStats, randomSource, variations, varyWind, windAt } from '../src/flight/montecarlo.js';
import { packStudy, unpackStudy } from '../src/flight/study.js';

const deg = Math.PI / 180;

test('the first flight is the forecast as is; the rest vary as asked, the same every time', () => {
  const rail = { angle: 5 * deg, direction: 90 * deg };
  const v = variations(4000, DEFAULT_SPREAD, rail, 7);
  assert.equal(v.length, 4000);
  assert.deepEqual(v[0], { windScale: 1, windTurn: 0, windSet: -1, thrustScale: 1, dragScale: 1, massScale: 1, recoveryScale: 1, rodAngle: rail.angle, rodDirection: rail.direction, ejectionDelta: 0 });
  assert.deepEqual(variations(10, DEFAULT_SPREAD, rail, 7), v.slice(0, 10));
  const rest = v.slice(1);
  const sd = (xs) => {
    const m = xs.reduce((a, b) => a + b, 0) / xs.length;
    return [m, Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1))];
  };
  const [mt, st] = sd(rest.map((x) => x.thrustScale));
  assert.ok(Math.abs(mt - 1) < 0.003 && Math.abs(st - DEFAULT_SPREAD.thrust) < 0.003);
  const [, sw] = sd(rest.map((x) => x.windTurn / deg));
  assert.ok(Math.abs(sw - DEFAULT_SPREAD.windDirection) < 1);
  const [ma] = sd(rest.map((x) => x.rodAngle / deg));
  assert.ok(Math.abs(ma - 5) < 0.2, 'the rail stays about where it was set');
});

test('turning the wind turns where it comes from, clockwise', () => {
  const [l] = varyWind([{ agl: 10, u: 5, v: 0, t: 280, p: 1e5 }], 1, 90 * deg); // from the west
  assert.ok(Math.abs(l.u) < 1e-9 && Math.abs(l.v + 5) < 1e-9, 'now from the north');
  assert.equal(l.t, 280);
  const [s] = varyWind([{ agl: 10, u: 3, v: 4 }], 2, 0);
  assert.deepEqual([s.u, s.v], [6, 8]);
});

test('landing ellipses hold their share of a normal spread', () => {
  const r = randomSource(3);
  // 300 m spread east-west, 100 m north-south, centred 500 m east of the pad.
  const results = Array.from({ length: 20000 }, () => ({ landingEast: 500 + 300 * r.normal(), landingNorth: 100 * r.normal(), apogee: 1000 + 10 * r.normal(), flightTime: 60 }));
  const s = landingStats(results);
  assert.ok(Math.abs(s.mean[0] - 500) < 10 && Math.abs(s.mean[1]) < 5);
  const e95 = s.ellipses.find((e) => e.p === 0.95);
  assert.ok(Math.abs(e95.a / 2.448 - 300) < 10 && Math.abs(e95.b / 2.448 - 100) < 5);
  assert.ok(Math.abs(Math.abs(Math.sin(e95.angle)) - 1) < 0.01, 'the long axis runs east-west');
  // The share of landings inside each ellipse.
  for (const e of s.ellipses) {
    const inside = results.filter((p) => {
      const x = p.landingEast - s.mean[0];
      const y = p.landingNorth - s.mean[1];
      const along = x * Math.sin(e.angle) + y * Math.cos(e.angle);
      const across = x * Math.cos(e.angle) - y * Math.sin(e.angle);
      return (along / e.a) ** 2 + (across / e.b) ** 2 <= 1;
    }).length / results.length;
    assert.ok(Math.abs(inside - e.p) < 0.01, `${e.p}: ${inside}`);
  }
  assert.ok(s.apogee.p5 < 1000 && s.apogee.p95 > 1000);
});

test('the ground between grid points', () => {
  const ground = groundFunction({ x0: -10, y0: -10, dx: 10, nx: 3, ny: 3, heights: Float32Array.from([0, 0, 0, 0, 0, 10, 0, 0, 20]) });
  assert.equal(ground(0, 0), 0);
  assert.equal(ground(10, 0), 10);
  assert.equal(ground(5, 0), 5);
  assert.equal(ground(10, 5), 15);
  assert.equal(ground(50, 50), 20, 'beyond the grid: its edge');
  assert.equal(groundFunction(null)(1, 2), 0);
});

test('with an ensemble, flights take turns with its members and the wind is not varied otherwise', () => {
  const v = variations(65, DEFAULT_SPREAD, { angle: 0, direction: 0 }, 1, { windSets: 31 });
  assert.equal(v[0].windSet, -1);
  assert.deepEqual(v.slice(1, 4).map((x) => x.windSet), [0, 1, 2]);
  assert.equal(v[32].windSet, 0);
  assert.ok(v.slice(1).every((x) => x.windScale === 1 && x.windTurn === 0));
  assert.ok(v.slice(1).some((x) => x.thrustScale !== 1), 'the rocket still varies');
});

test('ensemble winds: the detailed forecast shifted by each member\'s difference from the average', () => {
  const gfs = [{ agl: 10, u: 2, v: 0, t: 285, p: null }, { agl: 50, u: 3, v: 0 }, { agl: 500, u: 5, v: 1, t: 280, p: 95000 }];
  // Two members, coarse: one 1 m/s faster east than the other everywhere, one turning north higher up.
  const members = [
    { member: 0, levels: [{ agl: 10, u: 1, v: 0 }, { agl: 1000, u: 4, v: 0 }] },
    { member: 1, levels: [{ agl: 10, u: 2, v: 0 }, { agl: 1000, u: 5, v: 2 }] },
  ];
  assert.deepEqual(windAt(members[1].levels, 505), [3.5, 1]);
  const sets = ensembleWinds(gfs, members);
  assert.equal(sets.length, 2);
  for (const [k, l] of gfs.entries()) {
    const mean = [(sets[0][k].u + sets[1][k].u) / 2, (sets[0][k].v + sets[1][k].v) / 2];
    assert.ok(Math.abs(mean[0] - l.u) < 1e-9 && Math.abs(mean[1] - l.v) < 1e-9, 'the members average to the forecast');
    assert.ok(Math.abs(sets[1][k].u - sets[0][k].u - 1) < 1e-9);
  }
  assert.equal(sets[0][2].t, 280, 'temperature and pressure stay the forecast\'s');
  assert.ok(sets[1][2].v > sets[0][2].v);
  assert.deepEqual(ensembleWinds(gfs, []), []);
});

test('a study packs small and comes back as it was', () => {
  const results = [{ landingEast: 12.345, landingNorth: -6.789, apogee: 600.04, flightTime: 64.21, landed: true }, null,
    { landingEast: 1, landingNorth: 2, apogee: 3, flightTime: 4, landed: false }];
  const study = { design: { id: 'd1', name: 'Rocket' }, simulation: { index: 0, name: 'Sim', configuration: '[C6-5]' }, site: { lat: 40.9, lon: -119.06, altitude: 1191.26 },
    when: '2026-11-08T00:00:00.000Z', rail: { length: 1, angle: 0, direction: 1 }, mode: 'ensemble', spread: DEFAULT_SPREAD, n: 3,
    wind: { model: 'NOAA GFS 0.25°', run: 'r', valid: 'v', levels: [{ agl: 10, u: 1.234, v: 2.345, t: 280.12, p: null }] }, ensemble: { count: 31, range: [[1, 2]] }, notes: [],
    nominal: { path: [[0.123, 1.26, 2.34, 3.45]], apogee: 600, apogeeEast: 1, apogeeNorth: 2, landingEast: 3, landingNorth: 4, flightTime: 60, maxVelocity: 100, groundHitVelocity: 5 },
    results };
  const back = unpackStudy(JSON.parse(JSON.stringify(packStudy(study))));
  assert.deepEqual(back.results, [{ landingEast: 12.3, landingNorth: -6.8, apogee: 600, flightTime: 64.2, landed: true }, null,
    { landingEast: 1, landingNorth: 2, apogee: 3, flightTime: 4, landed: false }]);
  assert.deepEqual(back.nominal.path, [[0.12, 1.3, 2.3, 3.5]]);
  assert.deepEqual(back.wind.levels[0], { agl: 10, u: 1.23, v: 2.35, t: 280.1, p: null });
  assert.equal(back.mode, 'ensemble');
  assert.throws(() => unpackStudy({ v: 99 }), /different version/);
});
