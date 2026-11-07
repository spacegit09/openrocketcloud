// The launch planner's flight engine (src/flight/engine.js) against OpenRocket itself: fixtures from
// orcloud.flight.FlightCheck (scripts/test.sh writes them to worker/.cache/flight) hold, for each
// example design bundled with OpenRocket, its flight tables and OpenRocket's results in three
// winds. Examples the engine does not fly (several stages, air starts) or only approximates (fin
// sets of fewer than three fins) are left out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { environment, fly } from '../src/flight/engine.js';

const dir = process.env.FLIGHT_FIXTURES ?? join(import.meta.dirname, '..', '..', 'worker', '.cache', 'flight');
const fixtures = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8'))) : [];

test('flight fixtures present', { skip: fixtures.length ? false : `no fixtures in ${dir}` }, () => {
  assert.ok(fixtures.length > 0);
});

for (const fx of fixtures) {
  const t = fx.tables;
  const skip = t.unsupported || t.approximate || t.extensions;
  test(`flies like OpenRocket: ${fx.example}`, { skip: skip ?? false }, () => {
    for (const [i, w] of fx.winds.entries()) {
      const o = w.openrocket;
      if (!o) continue;
      const env = environment({ wind: w.levels, air: t.atmosphere, latitude: t.launch.latitude, altitude: t.launch.altitude });
      const r = fly(t, env, { coriolis: t.launch.geodetic !== 'FLAT' });
      const drift = Math.hypot(o.landingEast, o.landingNorth);
      const miss = Math.hypot(r.landingEast - o.landingEast, r.landingNorth - o.landingNorth);
      const at = `${fx.example}, wind ${i}`;
      assert.ok(Math.abs(r.apogee - o.apogee) <= 0.01 * o.apogee + 0.5, `${at}: apogee ${r.apogee} vs ${o.apogee}`);
      assert.ok(Math.abs(r.maxVelocity - o.maxVelocity) <= 0.01 * o.maxVelocity, `${at}: max velocity ${r.maxVelocity} vs ${o.maxVelocity}`);
      assert.ok(Math.abs(r.flightTime - o.flightTime) <= 0.04 * o.flightTime, `${at}: flight time ${r.flightTime} vs ${o.flightTime}`);
      assert.ok(miss <= Math.max(10, 0.05 * drift), `${at}: lands ${miss.toFixed(1)} m from OpenRocket's landing point (drift ${drift.toFixed(0)} m)`);
    }
  });
}
