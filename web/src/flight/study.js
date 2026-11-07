// Launch Planner studies as kept (SavedFlight records, see saved.js): rounded, with the flights'
// results in columns. Plain JavaScript without the page, so the tests run it in Node.

export const VERSION = 1;
const r1 = (x) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : null);
const r2 = (x) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : null);

/** A study as kept: rounded, with the flights' results in columns. */
export function packStudy(study) {
  const col = (f) => study.results.map((r) => (r ? f(r) : null));
  return {
    v: VERSION,
    design: study.design,
    simulation: study.simulation,
    site: { lat: study.site.lat, lon: study.site.lon, altitude: r1(study.site.altitude) },
    when: study.when,
    rail: study.rail,
    mode: study.mode,
    spread: study.spread,
    n: study.n,
    wind: { ...study.wind, levels: study.wind.levels.map((l) => ({ agl: r1(l.agl), u: r2(l.u), v: r2(l.v), t: r1(l.t), p: l.p })) },
    ensemble: study.ensemble,
    notes: study.notes,
    nominal: { ...study.nominal, path: study.nominal.path.map(([t, e, n, u]) => [r2(t), r1(e), r1(n), r1(u)]) },
    results: {
      le: col((r) => r1(r.landingEast)),
      ln: col((r) => r1(r.landingNorth)),
      ap: col((r) => r1(r.apogee)),
      ft: col((r) => r1(r.flightTime)),
      ld: col((r) => (r.landed === false ? 0 : 1)),
    },
  };
}

/** The study again from packStudy's form. */
export function unpackStudy(p) {
  if (!p || p.v !== VERSION) throw new Error('This saved flight was made by a different version of the planner.');
  const c = p.results;
  const results = c.le.map((le, i) => (le === null ? null
    : { landingEast: le, landingNorth: c.ln[i], apogee: c.ap[i], flightTime: c.ft[i], landed: c.ld[i] !== 0 }));
  return { ...p, results };
}

