// Monte Carlo studies for the launch planner: many flights with the uncertain things varied (wind,
// motor, drag, mass, parachutes, rail aim, ejection delay), flown in Web Workers with the engine
// (engine.js), and the landing area they make.

/** How much each thing varies (one standard deviation). */
export const DEFAULT_SPREAD = {
  windSpeed: 0.2, // fraction of the forecast speed, at all heights together
  windDirection: 15, // degrees
  thrust: 0.03, // fraction of the motor's total impulse
  drag: 0.05, // fraction of the rocket's drag
  mass: 0.02, // fraction of the rocket's mass
  recovery: 0.08, // fraction of the parachutes' drag
  railAim: 1, // degrees the rail actually points off its setting
  ejection: 0.5, // seconds the motor's ejection charge fires early or late
};

/** A seeded random source: uniform() in [0, 1) and normal() with mean 0 and deviation 1. */
export function randomSource(seed = 1) {
  let s = seed >>> 0;
  const uniform = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const normal = () => {
    const u = Math.max(uniform(), 1e-12);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * uniform());
  };
  return { uniform, normal };
}

/**
 * The conditions of `n` flights; the first is the forecast as it is (the nominal flight). Each:
 * { windScale, windTurn (rad), thrustScale, dragScale, massScale, recoveryScale, rodAngle,
 * rodDirection (rad), ejectionDelta (s) }.
 */
export function variations(n, spread, rail, seed = 1) {
  const r = randomSource(seed);
  const out = [];
  const deg = Math.PI / 180;
  for (let i = 0; i < n; i++) {
    if (i === 0) {
      out.push({ windScale: 1, windTurn: 0, thrustScale: 1, dragScale: 1, massScale: 1, recoveryScale: 1, rodAngle: rail.angle,
        rodDirection: rail.direction, ejectionDelta: 0 });
      continue;
    }
    // The rail's actual direction: its set direction tilted a little either way.
    const d = [Math.sin(rail.angle) * Math.sin(rail.direction), Math.sin(rail.angle) * Math.cos(rail.direction), Math.cos(rail.angle)];
    const e = Math.tan(spread.railAim * deg);
    const v = [d[0] + r.normal() * e, d[1] + r.normal() * e, d[2]];
    const len = Math.hypot(...v);
    out.push({
      windScale: Math.max(0, 1 + r.normal() * spread.windSpeed),
      windTurn: r.normal() * spread.windDirection * deg,
      thrustScale: Math.max(0.5, 1 + r.normal() * spread.thrust),
      dragScale: Math.max(0.5, 1 + r.normal() * spread.drag),
      massScale: Math.max(0.5, 1 + r.normal() * spread.mass),
      recoveryScale: Math.max(0.2, 1 + r.normal() * spread.recovery),
      rodAngle: Math.acos(v[2] / len),
      rodDirection: Math.atan2(v[0], v[1]),
      ejectionDelta: r.normal() * spread.ejection,
    });
  }
  return out;
}

/** Wind profile levels with the wind turned (clockwise, rad) and scaled. */
export function varyWind(levels, scale, turn) {
  const c = Math.cos(turn);
  const s = Math.sin(turn);
  // Turning the direction the wind comes from clockwise turns where it goes clockwise too.
  return levels.map((l) => ({ ...l, u: scale * (l.u * c + l.v * s), v: scale * (-l.u * s + l.v * c) }));
}

/** The ground's height above the launch site at (east, north), from a grid made by terrain.js. */
export function groundFunction(grid) {
  if (!grid) return () => 0;
  const { x0, y0, dx, nx, ny, heights } = grid;
  return (east, north) => {
    const x = Math.min(nx - 1, Math.max(0, (east - x0) / dx));
    const y = Math.min(ny - 1, Math.max(0, (north - y0) / dx));
    const i = Math.min(Math.floor(x), nx - 2);
    const j = Math.min(Math.floor(y), ny - 2);
    const fx = x - i;
    const fy = y - j;
    const h = (a, b) => heights[b * nx + a];
    return (h(i, j) * (1 - fx) + h(i + 1, j) * fx) * (1 - fy) + (h(i, j + 1) * (1 - fx) + h(i + 1, j + 1) * fx) * fy;
  };
}

function percentile(sorted, p) {
  if (!sorted.length) return NaN;
  const x = (sorted.length - 1) * p;
  const i = Math.floor(x);
  return sorted[i] + (sorted[Math.min(i + 1, sorted.length - 1)] - sorted[i]) * (x - i);
}

/**
 * Where the flights landed: { count, mean: [east, north], ellipses: [{ p, a, b, angle }] (semi-axes
 * in m; angle of the long axis clockwise from north, rad) holding the share p of landings for a
 * normal spread, farthest (m from the pad), apogee: { mean, p5, p95 }, flightTime: { mean, p5, p95 } }.
 */
export function landingStats(results, probabilities = [0.5, 0.95, 0.99]) {
  const ok = results.filter((r) => r && r.landed !== false && Number.isFinite(r.landingEast) && Number.isFinite(r.landingNorth));
  const n = ok.length;
  const me = ok.reduce((s, r) => s + r.landingEast, 0) / n;
  const mn = ok.reduce((s, r) => s + r.landingNorth, 0) / n;
  let see = 0;
  let snn = 0;
  let sen = 0;
  for (const r of ok) {
    see += (r.landingEast - me) ** 2;
    snn += (r.landingNorth - mn) ** 2;
    sen += (r.landingEast - me) * (r.landingNorth - mn);
  }
  const div = Math.max(1, n - 1);
  see /= div;
  snn /= div;
  sen /= div;
  // Eigenvalues of [[see, sen], [sen, snn]].
  const tr = see + snn;
  const det = see * snn - sen * sen;
  const disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
  const l1 = tr / 2 + disc;
  const l2 = Math.max(0, tr / 2 - disc);
  // The long axis's direction (east, north), as a bearing.
  const ve = Math.abs(sen) > 1e-12 ? l1 - snn : see >= snn ? 1 : 0;
  const vn = Math.abs(sen) > 1e-12 ? sen : see >= snn ? 0 : 1;
  const angle = Math.atan2(ve, vn);
  const ellipses = probabilities.map((p) => {
    const k = Math.sqrt(-2 * Math.log(1 - p));
    return { p, a: k * Math.sqrt(l1), b: k * Math.sqrt(l2), angle };
  });
  const sortedBy = (f) => ok.map(f).sort((a, b) => a - b);
  const apo = sortedBy((r) => r.apogee);
  const time = sortedBy((r) => r.flightTime);
  const spread = (s) => ({ mean: s.reduce((a, b) => a + b, 0) / s.length, p5: percentile(s, 0.05), p95: percentile(s, 0.95) });
  return {
    count: n,
    mean: [me, mn],
    ellipses,
    farthest: Math.max(...ok.map((r) => Math.hypot(r.landingEast, r.landingNorth))),
    apogee: spread(apo),
    flightTime: spread(time),
  };
}

/** Points around an ellipse (east, north), for drawing. */
export function ellipsePoints(center, { a, b, angle }, count = 72) {
  const pts = [];
  for (let k = 0; k <= count; k++) {
    const t = (2 * Math.PI * k) / count;
    const x = a * Math.cos(t); // along the long axis
    const y = b * Math.sin(t);
    pts.push([center[0] + x * Math.sin(angle) + y * Math.cos(angle), center[1] + x * Math.cos(angle) - y * Math.sin(angle)]);
  }
  return pts;
}

/**
 * Flies the study in Web Workers: `setup` { tables, levels, air, latitude, altitude, ground,
 * coriolis } and the flights' `conditions` (from variations()). Calls onProgress(done, total) and
 * resolves to the results in the conditions' order. A batch that takes far too long (a worker
 * starved or stuck) is given up: its flights' results stay empty and its worker is replaced.
 */
export function runStudy(setup, conditions, { onProgress, workers: count, signal, batchTimeoutMs = 30_000 } = {}) {
  const n = conditions.length;
  const results = new Array(n);
  const size = Math.max(1, Math.min(count ?? Math.max(1, (navigator.hardwareConcurrency || 4) - 1), 8, n));
  const batch = 20;
  let next = 0;
  let done = 0;
  return new Promise((resolve, reject) => {
    const pool = new Set();
    let ended = false;
    const finish = (err) => {
      if (ended) return;
      ended = true;
      clearInterval(watch);
      for (const w of pool) w.worker.terminate();
      if (err) reject(err);
      else resolve(results);
    };
    signal?.addEventListener('abort', () => finish(new Error('Stopped.')));
    const settle = (count) => {
      done += count;
      onProgress?.(done, n);
      if (done >= n) finish();
    };
    const feed = (slot) => {
      slot.jobs = [];
      for (let k = 0; k < batch && next < n; k++, next++) slot.jobs.push({ i: next, v: conditions[next] });
      if (!slot.jobs.length) return;
      slot.since = Date.now();
      slot.worker.postMessage({ type: 'run', jobs: slot.jobs });
    };
    const spawn = () => {
      const slot = { worker: new Worker(new URL('./worker.js', import.meta.url), { type: 'module' }), jobs: [], since: 0 };
      pool.add(slot);
      slot.worker.onerror = (e) => finish(new Error(e.message || 'A simulation worker failed.'));
      slot.worker.onmessage = ({ data }) => {
        if (data.type === 'error') return finish(new Error(data.message));
        for (const r of data.results) results[r.i] = r;
        slot.jobs = [];
        settle(data.results.length);
        if (!ended) feed(slot);
      };
      slot.worker.postMessage({ type: 'init', setup });
      feed(slot);
    };
    const watch = setInterval(() => {
      for (const slot of [...pool]) {
        if (slot.jobs.length && Date.now() - slot.since > batchTimeoutMs) {
          slot.worker.terminate();
          pool.delete(slot);
          const lost = slot.jobs.length;
          slot.jobs = [];
          settle(lost);
          if (!ended && next < n) spawn();
        }
      }
    }, 1000);
    for (let k = 0; k < size; k++) spawn();
  });
}
