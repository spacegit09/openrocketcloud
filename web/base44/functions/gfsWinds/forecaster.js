// The launch planner's forecasts for the whole site (the Forecasts actor): GFS winds and air for a
// launch, and with `ensemble` NOAA's 31-run ensemble too, all through one shared NomadsSource. A
// study that would wait too long for the ensemble's 31 files (others planning at the same time)
// gets the main forecast without it, as when the ensemble is not available, and the planner flies
// it with a fixed spread and says why.
import { NoaaBusy, gefsProfiles, gfsProfile } from './gfs.js';
import { NomadsSource } from './nomads.js';

export const MAX_ENSEMBLE_WAIT = 40; // s

export class Forecaster {
  constructor(options = {}) {
    this.source = options.source ?? new NomadsSource(options);
    this.maxEnsembleWait = options.maxEnsembleWait ?? MAX_ENSEMBLE_WAIT;
  }

  /** { lat, lon, time, ensemble } -> the forecast, as the gfsWinds function gives it; progress(text) while waiting. */
  async forecast({ lat, lon, time, ensemble }, progress = () => {}) {
    const when = new Date(String(time ?? ''));
    if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lon)) || Number.isNaN(when.getTime())) {
      throw new Error('Give a launch site (lat, lon) and time.');
    }
    const site = { lat: Number(lat), lon: Number(lon), time: when };
    const ahead = this.source.waitFor?.([]) ?? 0;
    if (ahead > 3) progress(`Waiting for NOAA's forecast server (about ${Math.round(ahead)} s: others are planning launches too)…`);
    const forecast = await gfsProfile({ ...site, source: this.source });
    if (!ensemble) return forecast;
    const members = await gefsProfiles({
      ...site, ground: forecast.ground, source: this.source, maxWait: this.maxEnsembleWait,
      onWait: (s) => progress(`Waiting for NOAA's ensemble forecast (about ${s} s: others are planning launches too)…`),
    }).catch((e) => ({ error: e instanceof NoaaBusy ? e.message : e instanceof Error ? e.message : String(e) }));
    return { ...forecast, ensemble: members };
  }
}

