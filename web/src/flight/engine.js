// The launch planner's flight engine: flies a rocket the way OpenRocket's simulation does, from the
// tables OpenRocket computes for it (worker/bridge/src/orcloud/flight/FlightTables.java), fast
// enough for Monte Carlo studies of thousands of flights. Plain JavaScript without the page, so it
// runs in Web Workers and in Node (web/test/flight.test.mjs checks it against OpenRocket).
//
// Ascent follows OpenRocket's RK4 stepper: six degrees of freedom with normal force, drag scaled by
// angle of attack, pitch damping and moments about the centre of gravity, the launch guide, gravity
// by latitude and height, and Coriolis acceleration. After a recovery device opens, the rocket is a
// point mass with the drag of the devices that are out, as in OpenRocket's landing stepper.
//
// Coordinates: east, north and up in metres from the launch site; wind is where the air goes.

const R_AIR = 287.053;
const R_EARTH = 6371000;
const EROT = 7.2921150e-5;

// ---------------------------------------------------------------- small helpers

function interp(xs, ys, x) {
  const n = xs.length;
  if (x <= xs[0]) return ys[0];
  if (x >= xs[n - 1]) return ys[n - 1];
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] <= x) lo = mid;
    else hi = mid;
  }
  const f = (x - xs[lo]) / (xs[hi] - xs[lo]);
  return ys[lo] + (ys[hi] - ys[lo]) * f;
}

function index(xs, x) {
  const n = xs.length;
  if (x <= xs[0]) return [0, 0];
  if (x >= xs[n - 1]) return [n - 2, 1];
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] <= x) lo = mid;
    else hi = mid;
  }
  return [lo, (x - xs[lo]) / (xs[hi] - xs[lo])];
}

/** grid[i][j] over xs[i], ys[j], bilinear and clamped at the edges. */
function bilinear(xs, ys, grid, x, y) {
  const [i, fx] = index(xs, x);
  const [j, fy] = index(ys, y);
  const a = grid[i][j] * (1 - fy) + grid[i][j + 1] * fy;
  const b = grid[i + 1][j] * (1 - fy) + grid[i + 1][j + 1] * fy;
  return a * (1 - fx) + b * fx;
}

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a) => Math.hypot(a[0], a[1], a[2]);

// Quaternions [w, x, y, z], rotating body vectors into the world.
function rotate(q, v) {
  const [w, x, y, z] = q;
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
}

function invRotate(q, v) {
  return rotate([q[0], -q[1], -q[2], -q[3]], v);
}

function mul(a, b) {
  return [
    a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
    a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
    a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
    a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
  ];
}

/** The rotation by a rotation vector (axis times angle). */
function rotation(rv) {
  const angle = len(rv);
  if (angle < 1e-12) return [1, 0, 0, 0];
  const s = Math.sin(angle / 2) / angle;
  return [Math.cos(angle / 2), rv[0] * s, rv[1] * s, rv[2] * s];
}

function normalize(q) {
  const n = Math.hypot(q[0], q[1], q[2], q[3]);
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

/** The rotation taking the body's axis (0, 0, 1) to the unit vector d. */
function pointing(d) {
  const c = d[2];
  if (c > 1 - 1e-12) return [1, 0, 0, 0];
  if (c < -1 + 1e-12) return [0, 1, 0, 0];
  const axis = [-d[1], d[0], 0]; // (0, 0, 1) x d
  const a = Math.hypot(axis[0], axis[1]);
  const angle = Math.acos(c);
  return rotation([(axis[0] / a) * angle, (axis[1] / a) * angle, 0]);
}

// ---------------------------------------------------------------- the environment

/**
 * Wind and air from a profile by height above the launch site: levels [{ agl, u, v, t?, p? }]
 * (the planner's forecast) or rows [agl, u, v]. Air comes from `air` rows [agl, T (K), p (Pa)]
 * when given, otherwise from the levels' temperature and pressure (filled in between by the
 * barometric formula), otherwise from the standard atmosphere above the launch altitude.
 */
export function environment({ wind = [[0, 0, 0]], air = null, latitude = 0, altitude = 0 }) {
  const rows = wind.map((l) => (Array.isArray(l) ? l : [l.agl, l.u, l.v]));
  rows.sort((a, b) => a[0] - b[0]);
  const wh = rows.map((r) => r[0]);
  const wu = rows.map((r) => r[1]);
  const wv = rows.map((r) => r[2]);
  let airRows = air;
  if (!airRows) {
    const known = wind.filter((l) => !Array.isArray(l) && l.t != null && l.p != null).map((l) => [l.agl, l.t, l.p]);
    airRows = known.length >= 2 ? known.sort((a, b) => a[0] - b[0]) : standardAtmosphere(altitude);
  }
  const ah = airRows.map((r) => r[0]);
  const at = airRows.map((r) => r[1]);
  const lnp = airRows.map((r) => Math.log(r[2]));
  const lat = (latitude * Math.PI) / 180;
  const sin2 = Math.sin(lat) ** 2;
  const g0 = 9.7803267714 * ((1 + 0.00193185138639 * sin2) / Math.sqrt(1 - 0.00669437999013 * sin2));
  return {
    latitude,
    altitude,
    sinLat: Math.sin(lat),
    cosLat: Math.cos(lat),
    wind: (h) => [interp(wh, wu, h), interp(wh, wv, h)],
    air(h) {
      const t = interp(ah, at, h);
      // Pressure falls off exponentially: interpolate its logarithm, extrapolating above the top.
      let p;
      const n = ah.length;
      if (h > ah[n - 1]) p = Math.exp(lnp[n - 1] - ((h - ah[n - 1]) * 9.80665) / (R_AIR * at[n - 1]));
      else if (h < ah[0]) p = Math.exp(lnp[0] + ((ah[0] - h) * 9.80665) / (R_AIR * at[0]));
      else p = Math.exp(interp(ah, lnp, h));
      return { t, p };
    },
    gravity: (h) => g0 * (R_EARTH / (R_EARTH + altitude + h)) ** 2,
  };
}

/** The International Standard Atmosphere above a launch site at `altitude` m, every 500 m to 40 km. */
export function standardAtmosphere(altitude = 0) {
  const layers = [[0, 288.15, -0.0065], [11000, 216.65, 0], [20000, 216.65, 0.001], [32000, 228.65, 0.0028], [47000, 270.65, 0]];
  const at = (z) => {
    let p = 101325;
    let t = 288.15;
    for (let i = 0; i < layers.length; i++) {
      const [base, tb, lapse] = layers[i];
      const top = i + 1 < layers.length ? layers[i + 1][0] : Infinity;
      const dz = Math.min(z, top) - base;
      if (dz <= 0) break;
      const tt = tb + lapse * dz;
      p = lapse ? p * (tt / tb) ** (-9.80665 / (R_AIR * lapse)) : p * Math.exp((-9.80665 * dz) / (R_AIR * tb));
      t = tt;
      if (z < top) break;
    }
    return [t, p];
  };
  const rows = [];
  for (let h = 0; h <= 40000; h += 500) rows.push([h, ...at(altitude + h)]);
  return rows;
}

// ---------------------------------------------------------------- the flight

/**
 * One flight. `tables` from FlightTables, `env` from environment(). Options (all optional):
 * rodLength, rodAngle, rodDirection (rad, clockwise from north): the launch guide (default the
 * simulation's); thrustScale, dragScale, massScale, recoveryScale: multipliers for Monte Carlo
 * studies; ejectionDelta (s): shifts motor ejection; ground(east, north): the ground's height
 * above the launch site (default 0); coriolis (default true); path: record the flight every
 * `path` seconds; dt, dtCoast, dtDescent (s): time steps.
 *
 * Returns { apogee, timeToApogee, maxVelocity, flightTime, landingEast, landingNorth,
 * groundHitVelocity, apogeeEast, apogeeNorth, events: [{ type, time }], path?: [[t, e, n, u]] }.
 */
export function fly(tables, env, opts = {}) {
  const aero = tables.aero;
  const refArea = tables.ref.area;
  const refLength = tables.ref.length;
  const aeroLength = tables.ref.aeroLength;
  const launch = tables.launch;
  const rodLength = opts.rodLength ?? launch.rodLength;
  const rodAngle = opts.rodAngle ?? launch.rodAngle;
  const rodDirection = opts.rodDirection ?? launch.rodDirection;
  const thrustScale = opts.thrustScale ?? 1;
  const dragScale = opts.dragScale ?? 1;
  const massScale = opts.massScale ?? 1;
  const recoveryScale = opts.recoveryScale ?? 1;
  const ground = opts.ground ?? (() => 0);
  const dtAscent = opts.dt ?? 0.01;
  const record = opts.path ?? 0;
  const withCoriolis = opts.coriolis ?? true;
  const maxTime = opts.maxTime ?? 1200;

  const rod = [Math.sin(rodAngle) * Math.sin(rodDirection), Math.sin(rodAngle) * Math.cos(rodDirection), Math.cos(rodAngle)];
  const mass = tables.mass;
  const thrust = tables.thrust;
  const tEnd = thrust.time[thrust.time.length - 1];
  const thrustAt = (t) => (t < thrust.time[0] || t > tEnd ? 0 : interp(thrust.time, thrust.force, t) * thrustScale);
  const alphas = aero.alpha;
  const axialAt = (deg) => {
    const i = Math.min(179, Math.max(0, Math.floor(deg)));
    const f = Math.min(1, Math.max(0, deg - i));
    return aero.axial[i] * (1 - f) + aero.axial[i + 1] * f;
  };

  // Events, in flight time.
  const events = [{ type: 'LAUNCH', time: 0 }];
  const deployAt = new Map(); // device index -> time it opens
  const ejections = (tables.ejections ?? []).map((t) => t + (opts.ejectionDelta ?? 0));
  const devices = tables.recovery ?? [];
  for (const [k, d] of devices.entries()) {
    if (d.event === 'LAUNCH') deployAt.set(k, Math.max(0.001, d.delay));
    if (d.event === 'EJECTION' && ejections.length) deployAt.set(k, Math.min(...ejections) + Math.max(0.001, d.delay));
  }
  const deployed = new Set();

  let t = 0;
  let pos = [0, 0, 0];
  let vel = [0, 0, 0];
  let q = pointing(rod);
  let omega = [0, 0, 0];
  let liftoff = false;
  let rodCleared = false;
  let apogee = 0;
  let apogeeTime = 0;
  let apogeeAt = [0, 0];
  let apogeeReached = false;
  let maxVelocity = 0;
  let burnoutLogged = false;
  let pitchFrequency = 0;
  let dragRate = 0;
  const path = record ? [[0, 0, 0, 0]] : null;
  let nextRecord = record;

  function massAt(time) {
    return {
      m: interp(mass.time, mass.mass, time) * massScale,
      cg: interp(mass.time, mass.cg, time),
      iLong: interp(mass.time, mass.iLong, time) * massScale,
    };
  }

  function airAt(h) {
    const { t: temp, p } = env.air(h);
    const rho = p / (R_AIR * temp);
    return { rho, a: 165.77 + 0.606 * temp, nu: (3.7291e-6 + 4.9944e-8 * temp) / rho };
  }

  function coriolis(v) {
    if (!withCoriolis) return [0, 0, 0];
    const vn = v[1];
    const ve = -v[0];
    const vu = v[2];
    return [2 * EROT * (vn * env.sinLat - vu * env.cosLat), 2 * EROT * (-ve * env.sinLat), 2 * EROT * (ve * env.cosLat)];
  }

  /** Accelerations (linear, angular, both in the world frame) in powered or coasting flight. */
  function flightDerivs(time, p, v, quat, w) {
    const h = p[2];
    const [wu, wv] = env.wind(h);
    const airRel = [v[0] - wu, v[1] - wv, v[2]];
    const ab = invRotate(quat, airRel);
    const V = len(ab);
    const lat = Math.hypot(ab[0], ab[1]);
    let alpha = 0;
    if (V > 0.01) alpha = Math.acos(Math.max(-1, Math.min(1, ab[2] / V)));
    let ex = 1;
    let ey = 0;
    if (lat > 0.0001) {
      ex = ab[0] / lat;
      ey = ab[1] / lat;
    }
    const air = airAt(h);
    const mach = V / air.a;
    const re = (V * aeroLength) / air.nu;
    const deg = (alpha * 180) / Math.PI;
    const look = deg > 90 ? 180 - deg : deg; // the tables reach 90 degrees; beyond, the flow is mirrored
    const cn = bilinear(aero.mach, alphas, aero.cn, mach, look);
    const cp = bilinear(aero.mach, alphas, aero.cp, mach, look);
    const cd = bilinear(aero.mach, aero.logRe, aero.cd, mach, Math.log10(Math.max(re, 1))) * dragScale;
    const cdAxial = axialAt(deg) * cd;
    const dynP = 0.5 * air.rho * V * V;
    // How fast the rocket swings about its centre of gravity (rad/s), to keep time steps stable.
    const slope = bilinear(aero.mach, alphas, aero.cn, mach, 1) * (180 / Math.PI);
    pitchFrequency = Math.sqrt((Math.abs(slope) * dynP * refArea * Math.abs(cp - massAt(time).cg)) / massAt(time).iLong);
    const fN = cn * dynP * refArea;
    const drag = cdAxial * dynP * refArea;
    const F = thrustAt(time);
    const { m, cg, iLong } = massAt(time);
    const fb = [(-fN * ex) / m, (-fN * ey) / m, (F - drag) / m];
    let a = rotate(quat, fb);
    a[2] -= env.gravity(h);
    const c = coriolis(v);
    a = [a[0] + c[0], a[1] + c[1], a[2] + c[2]];

    let ang = [0, 0, 0];
    if (!liftoff) {
      if (a[2] < 0) a = [0, 0, 0];
    } else if (!rodCleared) {
      const along = dot(a, rod);
      a = [rod[0] * along, rod[1] * along, rod[2] * along];
    } else {
      const wb = invRotate(quat, w);
      const yAxis = [-ey, ex, 0];
      const pitchRate = lat < 0.001 ? 0 : dot(wb, yAxis);
      const cmStatic = (cn * cp) / refLength;
      const damp = Math.min(tables.damping * (pitchRate / V) ** 2, cmStatic);
      const cm = cmStatic - (pitchRate < 0 ? -1 : 1) * damp;
      const cmCg = cm - (cn * cg) / refLength;
      const mom = (cmCg * dynP * refArea * refLength) / iLong;
      ang = rotate(quat, [yAxis[0] * mom, yAxis[1] * mom, 0]);
    }
    return { a, ang, V };
  }

  function step(dt) {
    const k1 = flightDerivs(t, pos, vel, q, omega);
    const p2 = add(pos, vel, dt / 2);
    const v2 = add(vel, k1.a, dt / 2);
    const q2 = normalize(mul(rotation(scale(omega, dt / 2)), q));
    const w2 = add(omega, k1.ang, dt / 2);
    const k2 = flightDerivs(t + dt / 2, p2, v2, q2, w2);
    const p3 = add(pos, v2, dt / 2);
    const v3 = add(vel, k2.a, dt / 2);
    const q3 = normalize(mul(rotation(scale(w2, dt / 2)), q));
    const w3 = add(omega, k2.ang, dt / 2);
    const k3 = flightDerivs(t + dt / 2, p3, v3, q3, w3);
    const p4 = add(pos, v3, dt);
    const v4 = add(vel, k3.a, dt);
    const q4 = normalize(mul(rotation(scale(w3, dt)), q));
    const w4 = add(omega, k3.ang, dt);
    const k4 = flightDerivs(t + dt, p4, v4, q4, w4);
    pos = [0, 1, 2].map((i) => pos[i] + (dt / 6) * (vel[i] + 2 * v2[i] + 2 * v3[i] + v4[i]));
    vel = [0, 1, 2].map((i) => vel[i] + (dt / 6) * (k1.a[i] + 2 * k2.a[i] + 2 * k3.a[i] + k4.a[i]));
    const wAvg = [0, 1, 2].map((i) => (omega[i] + 2 * w2[i] + 2 * w3[i] + w4[i]) / 6);
    q = normalize(mul(rotation(scale(wAvg, dt)), q));
    omega = [0, 1, 2].map((i) => omega[i] + (dt / 6) * (k1.ang[i] + 2 * k2.ang[i] + 2 * k3.ang[i] + k4.ang[i]));
  }

  function descentAccel(p, v) {
    const [wu, wv] = env.wind(p[2]);
    const airRel = [v[0] - wu, v[1] - wv, v[2]];
    const V = len(airRel);
    const air = airAt(p[2]);
    let cdA = 0;
    for (const k of deployed) cdA += devices[k].count * devices[k].cd * devices[k].area * recoveryScale;
    if (!deployed.size) cdA = tables.tumbleCD * refArea * dragScale;
    const { m } = massAt(t);
    const drag = 0.5 * cdA * air.rho * V * V;
    dragRate = (cdA * air.rho * V) / m; // how fast drag pulls the speed to the air's (1/s)
    const a = V > 1e-9 ? scale(airRel, -drag / m / V) : [0, 0, 0];
    a[2] -= env.gravity(p[2]);
    const c = coriolis(v);
    return [a[0] + c[0], a[1] + c[1], a[2] + c[2]];
  }

  function descentStep(dt) {
    const a1 = descentAccel(pos, vel);
    const v2 = add(vel, a1, dt / 2);
    const a2 = descentAccel(add(pos, vel, dt / 2), v2);
    const v3 = add(vel, a2, dt / 2);
    const a3 = descentAccel(add(pos, v2, dt / 2), v3);
    const v4 = add(vel, a3, dt);
    const a4 = descentAccel(add(pos, v3, dt), v4);
    pos = [0, 1, 2].map((i) => pos[i] + (dt / 6) * (vel[i] + 2 * v2[i] + 2 * v3[i] + v4[i]));
    vel = [0, 1, 2].map((i) => vel[i] + (dt / 6) * (a1[i] + 2 * a2[i] + 2 * a3[i] + a4[i]));
  }

  function deploy(k, time) {
    if (deployed.has(k)) return;
    deployed.add(k);
    events.push({ type: 'RECOVERY_DEVICE_DEPLOYMENT', time, device: devices[k].name });
  }

  let landed = false;
  let steps = 0;
  while (!landed && t < maxTime && steps++ < 3_000_000) {
    // The next scheduled event: the step ends on it.
    let next = Infinity;
    for (const [k, at] of deployAt) if (!deployed.has(k) && at > t + 1e-9) next = Math.min(next, at);
    if (!burnoutLogged && tables.burnout > t) next = Math.min(next, tables.burnout);
    const descending = deployed.size > 0;
    let dt = descending ? (opts.dtDescent ?? 0.5) : liftoff && t > tables.burnout + 0.5 ? (opts.dtCoast ?? 0.05) : dtAscent;
    if (!descending && pitchFrequency > 0) dt = Math.max(0.0005, Math.min(dt, 0.4 / pitchFrequency));
    if (descending) {
      descentAccel(pos, vel); // sets dragRate for the state now
      if (dragRate > 0) dt = Math.max(0.0005, Math.min(dt, 1 / dragRate));
    }
    dt = Math.min(dt, next - t);
    const before = pos;
    const oldAlt = pos[2];
    if (descending) descentStep(dt);
    else step(dt);
    t += dt;

    // Like OpenRocket after each step: stay on the pad until lift-off, then the guide.
    if (!liftoff) {
      if (pos[2] < 0) {
        pos = [0, 0, 0];
        vel = [0, 0, 0];
      }
      if (pos[2] > 0.02) {
        liftoff = true;
        events.push({ type: 'LIFTOFF', time: t });
      }
    }
    if (liftoff && !rodCleared && len(pos) > rodLength) {
      rodCleared = true;
      events.push({ type: 'LAUNCHROD', time: t });
    }
    if (!burnoutLogged && t >= tables.burnout - 1e-9) {
      burnoutLogged = true;
      events.push({ type: 'BURNOUT', time: t });
      for (const e of ejections) events.push({ type: 'EJECTION_CHARGE', time: e });
    }
    maxVelocity = Math.max(maxVelocity, len(vel));
    if (pos[2] > apogee) {
      apogee = pos[2];
      apogeeTime = t;
      apogeeAt = [pos[0], pos[1]];
    }
    if (!apogeeReached && liftoff && pos[2] < apogee - 0.01) {
      apogeeReached = true;
      events.push({ type: 'APOGEE', time: apogeeTime });
      for (const [k, d] of devices.entries()) {
        if (d.event === 'APOGEE') deployAt.set(k, apogeeTime + Math.max(0.001, d.delay));
      }
    }
    // Altitude deployment, when the rocket descends through the device's altitude.
    for (const [k, d] of devices.entries()) {
      if (d.event === 'ALTITUDE' && !deployAt.has(k) && oldAlt >= d.altitude && pos[2] <= d.altitude && liftoff) {
        deployAt.set(k, t + Math.max(0.001, d.delay));
      }
    }
    for (const [k, at] of deployAt) if (!deployed.has(k) && at <= t + 1e-9) deploy(k, at);

    if (record && t >= nextRecord) {
      path.push([t, pos[0], pos[1], pos[2]]);
      nextRecord += record;
    }
    const g = ground(pos[0], pos[1]);
    if (liftoff && pos[2] <= g && vel[2] < 0) {
      // Back to where it crossed the ground.
      const back = before[2] - pos[2] > 1e-9 ? Math.max(0, Math.min(1, (before[2] - g) / (before[2] - pos[2]))) : 1;
      pos = [before[0] + (pos[0] - before[0]) * back, before[1] + (pos[1] - before[1]) * back, g];
      t = t - dt + dt * back;
      landed = true;
      events.push({ type: 'GROUND_HIT', time: t });
      if (record) path.push([t, pos[0], pos[1], pos[2]]);
    }
  }
  return {
    apogee,
    timeToApogee: apogeeTime,
    apogeeEast: apogeeAt[0],
    apogeeNorth: apogeeAt[1],
    maxVelocity,
    flightTime: t,
    landingEast: pos[0],
    landingNorth: pos[1],
    groundHitVelocity: len(vel),
    landed,
    events,
    ...(record ? { path } : {}),
  };
}

function add(a, b, s) {
  return [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
}

function scale(a, s) {
  return [a[0] * s, a[1] * s, a[2] * s];
}
