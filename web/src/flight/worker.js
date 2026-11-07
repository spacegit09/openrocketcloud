// A Web Worker for Monte Carlo studies (montecarlo.js): flies batches of flights with the engine.
import { environment, fly } from './engine.js';
import { groundFunction, varyWind } from './montecarlo.js';

let setup = null;
let ground = null;

self.onmessage = ({ data }) => {
  try {
    if (data.type === 'init') {
      setup = data.setup;
      ground = groundFunction(setup.ground);
      return;
    }
    if (data.type === 'run') {
      const results = data.jobs.map(({ i, v }) => {
        const env = environment({
          wind: varyWind(setup.levels, v.windScale, v.windTurn),
          air: setup.air,
          latitude: setup.latitude,
          altitude: setup.altitude,
        });
        const r = fly(setup.tables, env, { ...v, ground, coriolis: setup.coriolis });
        return {
          i,
          landingEast: r.landingEast,
          landingNorth: r.landingNorth,
          apogee: r.apogee,
          apogeeEast: r.apogeeEast,
          apogeeNorth: r.apogeeNorth,
          flightTime: r.flightTime,
          maxVelocity: r.maxVelocity,
          groundHitVelocity: r.groundHitVelocity,
          landed: r.landed,
        };
      });
      self.postMessage({ type: 'done', results });
    }
  } catch (e) {
    self.postMessage({ type: 'error', message: e?.message ?? String(e) });
  }
};
