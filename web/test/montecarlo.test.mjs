// The launch planner's Monte Carlo study (src/flight/montecarlo.js): the varied conditions, wind
// turning, the landing ellipses and the ground grid.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SPREAD, groundFunction, landingStats, randomSource, variations, varyWind } from '../src/flight/montecarlo.js';

const deg = Math.PI / 180;

test('the first flight is the forecast as is; the rest vary as asked, the same every time', () => {
  const rail = { angle: 5 * deg, direction: 90 * deg };
  const v = variations(4000, DEFAULT_SPREAD, rail, 7);
  assert.equal(v.length, 4000);
  assert.deepEqual(v[0], { windScale: 1, windTurn: 0, thrustScale: 1, dragScale: 1, massScale: 1, recoveryScale: 1, rodAngle: rail.angle, rodDirection: rail.direction, ejectionDelta: 0 });
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
