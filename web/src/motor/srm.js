// The motor designer's worksheets, as Richard Nakka's SRM_2023.xls works them out
// (nakka-rocketry.net/softw.html#SRM): its propellant data, the Kn table and the throat that gives
// the target pressure (Data and Kn), the nozzle's lengths (Nozzle Design), the thrust-time table
// (Output) and the cells of the Pressure and Performance worksheets that follow from the
// calculation's lines. The calculation itself (chamber pressure, thrust, impulse) is JSRM's, the
// Java version of SRM that METEOR runs (orcloud.bridge.MotorLab); here the formulas are the
// spreadsheet's own, cell for cell, in the same order, so the numbers are the spreadsheet's.
// Plain JavaScript: the page uses it, and test/srm.test.mjs checks it against SRM_2023's numbers.

/** SRM_2023's propellants, in its list's order (Data and Kn, Note [1]; Propellant data; Burnrate). */
export const PROPELLANTS = [
  {
    name: 'KNDX', note: 'potassium nitrate/dextrose, 65/35 O/F ratio, oxidizer finely milled',
    density: 1.879, k: 1.1308, M: 42.42, T0: 1710,
    // Burn rate r = a·P^n (r in mm/s, P in MPa), by pressure range (lower bound, MPa).
    burn: [[0.1, 8.875444967785356, 0.6193], [0.779135, 7.55278442387944, -0.0087], [2.571835, 3.8408799049960156, 0.6882],
      [5.9297, 17.20418640980624, -0.1481], [8.501535, 4.775240863476593, 0.4417]],
    burnUpTo: 11.204375,
    // Kn as a function of pressure (MPa): least-squares fits, a + b·P + c·P² + ...; KNDX has
    // three, below 3 MPa, below 6 MPa and above.
    kn: [[3, [43.5, 0.24168, 50.48413, -9.91148]], [6, [163.8, 22.22414, -0.224]], [Infinity, [5095, -2460.426, 453.4805, -35.53239, 1.01745]]],
  },
  {
    name: 'KNSB fine', note: 'potassium nitrate/sorbitol 65/35 O/F ratio, oxidizer finely milled',
    density: 1.841, k: 1.137, M: 39.9, T0: 1600,
    burn: [[0.101, 10.707683798033065, 0.6247], [0.806715, 8.763280071017734, -0.3142], [1.50311, 7.852165794978407, -0.013],
      [3.79225, 3.9067683041390504, 0.5354], [7.0329, 9.653203619876852, 0.0638]],
    burnUpTo: 10.67346,
    kn: [[Infinity, [34.5, -10.975, 69.667, -19.664, 2.1478, -0.081463]]],
  },
  {
    name: 'KNSB coarse', note: 'potassium nitrate/sorbitol 65/35 O/F ratio, oxidizer granular or lightly milled prills',
    density: 1.841, k: 1.137, M: 39.9, T0: 1600,
    burn: [[0.101, 5.13, 0.22]], burnUpTo: 10.3,
    kn: [[Infinity, [38, 92.391, -2.0438]]],
  },
  {
    name: 'KNSU', note: 'potassium nitrate/sucrose 65/35 O/F ratio, oxidizer finely milled',
    density: 1.889, k: 1.133, M: 42.02, T0: 1720,
    burn: [[0.101, 8.26, 0.319]], burnUpTo: 10.3,
    kn: [[Infinity, [32.9539, 44.1079, -1.10248]]],
  },
  {
    name: 'KNER coarse', note: 'potassium nitrate/erythritol 65/35 O/F ratio, oxidizer granular or lightly milled prills',
    density: 1.82, k: 1.14, M: 38.58, T0: 1608,
    burn: [[0.101, 2.9, 0.4]], burnUpTo: 10.3,
    kn: [[Infinity, [50.410353, 211.194019, -47.797596, 8.779018, -0.830282, 0.030519]]],
  },
  {
    name: 'KNMN coarse', note: 'potassium nitrate/mannitol 65/35 O/F ratio, oxidizer granular or lightly milled prills',
    density: 1.854, k: 1.1363, M: 39.826, T0: 1616,
    burn: [[0.101, 5.13, 0.22]], burnUpTo: 10.3,
    kn: [[Infinity, [38, 92.391, -2.0438]]],
  },
  {
    name: 'KNPSB', note: 'potassium nitrate/potassium perchlorate/sorbitol 35/30/35 O/O/F ratio, oxidizers finely milled',
    density: 1.923, k: 1.163, M: 36.39, T0: 1858,
    burn: [[0.101, 6.5, 0.628]], burnUpTo: 10.3,
    kn: [[Infinity, [54.53, 33.652, -3.4185, 0.1545]]],
  },
  {
    name: 'KNFR', note: 'potassium nitrate/fructose, 65/35 O/F ratio, oxidizer finely milled',
    density: 1.942, k: 1.1308, M: 42.42, T0: 1710,
    burn: [[0.101, 7.4, 0.25]], burnUpTo: 10.3,
    kn: [[Infinity, [39.748, 51.618, -0.9264]]],
  },
];

export const propellant = (name) => PROPELLANTS.find((p) => p.name === name) ?? PROPELLANTS[0];

/** SRM's choice of target maximum chamber pressure (Data and Kn, "Target MEOP"), in MPa. */
export const TARGETS = [
  ...[9, 8.5, 8, 7.5, 7, 6.5, 6, 5.5, 5, 4.5, 4, 3.5, 3, 2.5, 2, 1.5, 1].map((v) => [`${v} MPa`, v]),
  ['1300 psi', 8.9635], ['1250 psi', 8.61875], ['1200 psi', 8.274], ['1150 psi', 7.92925], ['1100 psi', 7.5845],
  ['1050 psi', 7.23975], ['1000 psi', 6.895], ['950 psi', 6.55025], ['900 psi', 6.2055], ['850 psi', 5.86075],
  ['800 psi', 5.516], ['750 psi', 5.17125], ['700 psi', 4.8265], ['650 psi', 4.48175], ['600 psi', 4.137],
  ['550 psi', 3.79225], ['500 psi', 3.4475], ['450 psi', 3.10275], ['400 psi', 2.758], ['350 psi', 2.41325],
  ['300 psi', 2.0685], ['250 psi', 1.72375], ['200 psi', 1.379], ['150 psi', 1.03425],
];

/** The grain shapes: SRM's own (hollow cylinder, BATES) and the ones METEOR adds (JSRM). */
export const GRAINS = {
  hollow: { label: 'Hollow cylinder (BATES)', srm: true },
  rodTube: { label: 'Rod and tube' },
  cSlot: { label: 'C-slot' },
  finocyl: { label: 'Finocyl' },
  moonBurner: { label: 'Moon burner' },
  star: { label: 'Star' },
  endBurner: { label: 'End burner' },
};

/** SRM_2023's example: an L-class KNDX motor, as the spreadsheet comes. */
export function exampleMotor() {
  return {
    title: 'Example Rocket Motor (L-Class)',
    subtitle: 'utilizing KNDX propellant.',
    propellant: 'KNDX',
    chamber: { diameter: 75, length: 470 },
    grain: {
      type: 'hollow', outerDiameter: 69, coreDiameter: 20, segmentLength: 115, segments: 4,
      outer: 'inhibited', core: 'exposed', ends: 'exposed',
    },
    throat: { mode: 'target', target: '900 psi', diameter: 16.79 },
    settings: {
      densityRatio: 0.95, nozzleErosion: 0, combustionEfficiency: 0.95, ambientPressure: 0.101,
      erosiveThreshold: 6, erosiveCoefficient: 0, nozzleEfficiency: 0.85, expansionRatio: 8, optimal: false,
      convergence: 35, divergence: 12,
    },
    eng: { name: '', diameter: null, length: null, delays: 'P', hardwareMass: null, manufacturer: 'Custom' },
  };
}

/**
 * Default dimensions for a grain shape newly chosen, in millimetres: a starting point scaled to the
 * chamber, with SRM_2023's example segments. The C-slot is METEOR's own C-slot example (a 30 mm
 * grain: core 10, slot 5 wide and 15 deep, offset 7), scaled.
 */
export function grainDefaults(type, chamberDiameter = 75) {
  const od = Math.max(10, Math.round(chamberDiameter * 0.92));
  switch (type) {
    case 'rodTube': return { type, rodDiameter: Math.round(od * 0.2), tubeOuterDiameter: od, tubeInnerDiameter: Math.round(od * 0.55), segmentLength: 115, segments: 4, ends: 'exposed' };
    case 'cSlot': return { type, outerDiameter: od, coreDiameter: od / 3, slotWidth: od / 6, slotDepth: od / 2, slotOffset: Math.round((od * 7) / 30), segmentLength: 115, segments: 4, ends: 'exposed' };
    case 'finocyl': return { type, outerDiameter: od, innerDiameter: Math.round(od * 0.29), finWidth: Math.round(od * 0.07), finDiameter: Math.round(od * 0.58), finCount: 5, segmentLength: 115, segments: 4, ends: 'exposed' };
    case 'moonBurner': return { type, outerDiameter: od, coreDiameter: Math.round(od * 0.29), coreOffset: Math.round(od * 0.2), segmentLength: 115, segments: 4, ends: 'exposed' };
    case 'star': return { type, outerDiameter: od, innerDiameter: Math.round(od * 0.29), pointDiameter: Math.round(od * 0.58), pointCount: 6, segmentLength: 115, segments: 4, ends: 'exposed' };
    case 'endBurner': return { type, outerDiameter: od, length: 200, holeDiameter: 0, holeDepth: 0 };
    default: return { type: 'hollow', outerDiameter: od, coreDiameter: Math.round(od * 0.29), segmentLength: 115, segments: 4, outer: 'inhibited', core: 'exposed', ends: 'exposed' };
  }
}

/**
 * The holes in a grain's cross-section at the start, as JSRM builds them (its grain classes, after
 * Bill Kuker's motorsim), in its coordinates: millimetres from the grain's centre, x to the right
 * and y down. Each is { circle: [x, y, r] } or { polygon: [[x, y], ...] }, and they may overlap.
 * The rod and tube is two pieces instead: null.
 */
export function grainHoles(g) {
  switch (g.type) {
    case 'hollow': return [{ circle: [0, 0, g.coreDiameter / 2] }];
    case 'endBurner': return g.holeDiameter > 0 ? [{ circle: [0, 0, g.holeDiameter / 2] }] : [];
    case 'moonBurner': return [{ circle: [g.coreOffset, 0, g.coreDiameter / 2] }]; // MoonBurnerGrain
    case 'cSlot': {
      // CSlotGrain: the slot is cut from the grain's outer edge (x = Do/2) inward by its depth, its
      // centre line the offset away from the grain's; the core, if any, is centred at its inner end.
      const edge = g.outerDiameter / 2;
      const [x0, y0, w] = [edge - g.slotDepth, -g.slotOffset, g.slotWidth / 2];
      const slot = { polygon: [[x0, y0 - w], [edge, y0 - w], [edge, y0 + w], [x0, y0 + w]] };
      return g.coreDiameter > 0 ? [slot, { circle: [x0, y0, g.coreDiameter / 2] }] : [slot];
    }
    case 'finocyl': {
      // FinocylGrain: the core, and each fin from the centre out to half the fin diameter, turned by 2π/n.
      const [w, r] = [g.finWidth / 2, g.finDiameter / 2];
      const fins = Array.from({ length: g.finCount }, (_, i) => {
        const a = (2 * Math.PI * i) / g.finCount;
        return { polygon: [[-w, 0], [w, 0], [w, r], [-w, r]].map(([x, y]) => [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)]) };
      });
      return [{ circle: [0, 0, g.innerDiameter / 2] }, ...fins];
    }
    case 'star': {
      // StarGrain: from the inner diameter on the y axis, the point and the inner diameter by turns, every π/n.
      const polygon = Array.from({ length: 2 * g.pointCount }, (_, i) => {
        const r = (i % 2 ? g.pointDiameter : g.innerDiameter) / 2;
        const a = (Math.PI * i) / g.pointCount;
        return [r * Math.sin(a), r * Math.cos(a)];
      });
      return [{ polygon }];
    }
    default: return null;
  }
}

/**
 * Each grain shape's dimensions, as the Data and Kn worksheet asks for them: [key, symbol,
 * description, kind], kind 'count' for a whole number and 'zero' for one that may be 0 (as METEOR
 * allows); the rest must be more than 0. The meanings are JSRM's (its grain classes).
 */
export const GRAIN_FIELDS = {
  hollow: [['outerDiameter', 'Do', 'Outer diameter (initial)'], ['coreDiameter', 'do', 'Core diameter (initial)'],
    ['segmentLength', 'Lo', 'Segment length (initial)'], ['segments', 'N', 'Number of segments', 'count']],
  rodTube: [['rodDiameter', 'Dr', 'Rod diameter'], ['tubeOuterDiameter', 'Do', 'Tube outer diameter'], ['tubeInnerDiameter', 'do', 'Tube inner diameter'],
    ['segmentLength', 'Lo', 'Segment length'], ['segments', 'N', 'Number of segments', 'count']],
  cSlot: [['outerDiameter', 'Do', 'Outer diameter'], ['coreDiameter', 'do', 'Core diameter, centred at the slot’s inner end (0: none)', 'zero'],
    ['slotWidth', 'ws', 'Slot width'], ['slotDepth', 'hs', 'Slot depth, from the grain’s outer edge inward'],
    ['slotOffset', 'os', 'Slot offset, from the grain’s centre line to the slot’s', 'zero'],
    ['segmentLength', 'Lo', 'Segment length'], ['segments', 'N', 'Number of segments', 'count']],
  finocyl: [['outerDiameter', 'Do', 'Outer diameter'], ['innerDiameter', 'do', 'Core diameter'], ['finWidth', 'wf', 'Fin width'],
    ['finDiameter', 'Df', 'Fin tip diameter (centre to fin tip × 2)'], ['finCount', 'nf', 'Number of fins', 'count'],
    ['segmentLength', 'Lo', 'Segment length'], ['segments', 'N', 'Number of segments', 'count']],
  moonBurner: [['outerDiameter', 'Do', 'Outer diameter'], ['coreDiameter', 'do', 'Core diameter'], ['coreOffset', 'oc', 'Core offset (from the centre)', 'zero'],
    ['segmentLength', 'Lo', 'Segment length'], ['segments', 'N', 'Number of segments', 'count']],
  star: [['outerDiameter', 'Do', 'Outer diameter'], ['innerDiameter', 'Di', 'Star inner diameter (centre to inner points × 2)'],
    ['pointDiameter', 'Dp', 'Star point diameter (centre to outer points × 2)'], ['pointCount', 'np', 'Number of points', 'count'],
    ['segmentLength', 'Lo', 'Segment length'], ['segments', 'N', 'Number of segments', 'count']],
  endBurner: [['outerDiameter', 'Do', 'Outer diameter'], ['length', 'Lo', 'Grain length'], ['holeDiameter', 'dh', 'Ignition hole diameter (0: none)', 'zero'],
    ['holeDepth', 'hh', 'Ignition hole depth', 'zero']],
};

const exposed = (v) => (v === 'inhibited' ? 0 : 1);

/** The grain's total length (SRM's Lgo), whatever its shape. */
export function grainLength(g) {
  if (g.type === 'endBurner') return g.length;
  return g.segments * g.segmentLength;
}

/** The grain's outer diameter (SRM's Do; the tube's, for a rod and tube). */
export const grainOuterDiameter = (g) => (g.type === 'rodTube' ? g.tubeOuterDiameter : g.outerDiameter);

/**
 * Kn as a function of pressure for the target pressure (Data and Kn, columns AN and AO): the
 * propellant's polynomial, evaluated as the cell does, term by term.
 */
export function knForPressure(name, p) {
  const fits = propellant(name).kn;
  const [, c] = fits.find(([below]) => p < below) ?? fits[fits.length - 1];
  const t = [0, 0, 0, 0, 0, 0, 0].map((z, i) => c[i] ?? 0);
  return t[0] + t[1] * p + t[2] * p ** 2 + t[3] * p ** 3 + t[4] * p ** 4 + t[5] * p ** 5 + t[6] * p ** 6;
}

export const targetPressure = (label) => (TARGETS.find(([l]) => l === label) ?? TARGETS.find(([l]) => l === '900 psi'))[1];

/**
 * The Data and Kn worksheet for a hollow-cylinder grain, cell by cell: the chamber and grain
 * figures (C12 to C33) and the Kn table (rows 45 to 95: x, d, D, L, tweb, Abe, Abc, Abs, Ab).
 * Without `throat`, the table's At and Kn columns are left for knTable() once the throat is known.
 */
export function hollowData(m) {
  const g = m.grain;
  const dc = m.chamber.diameter;
  const lc = m.chamber.length;
  const doo = g.outerDiameter;
  const dio = g.coreDiameter;
  const lo = g.segmentLength;
  const n = g.segments;
  const osi = exposed(g.outer);
  const ci = exposed(g.core);
  const ei = exposed(g.ends);
  const p = propellant(m.propellant);
  const out = {};
  out.vc = Math.PI / 4 * dc ** 2 * lc;
  out.lgo = n * lo;
  out.vg = Math.PI / 4 * (doo ** 2 - dio ** 2) * out.lgo;
  out.vl = out.vg / out.vc;
  out.idealDensity = p.density;
  out.density = m.settings.densityRatio * p.density;
  out.mgrain = out.density * out.vg / 1000 / 1000;
  out.abeo = n * 2 * ei * Math.PI / 4 * (doo ** 2 - dio ** 2);
  out.abco = n * ci * Math.PI * dio * lo;
  out.abso = n * osi * Math.PI * doo * lo;
  out.abo = out.abeo + out.abco + out.abso;
  // Solve 1: xinc such that the web is gone at the table's last row (C96 = two − xfinal·(ci+osi) = 0).
  const two = (doo - dio) / 2;
  out.web = two;
  out.xinc = ci + osi > 0 ? two / (ci + osi) / 50 : NaN;
  const rows = [];
  let x = 0;
  for (let i = 0; i <= 50; i++) {
    if (i > 0) x = out.xinc + x;
    const d = dio + ci * (2 * x);
    const D = doo - osi * (2 * x);
    const L = out.lgo - ei * (2 * n * x);
    const tweb = (D - d) / 2;
    const abe = ei * 2 * n * Math.PI / 4 * (D ** 2 - d ** 2);
    const abc = ci * Math.PI * d * L;
    const abs = osi * Math.PI * D * L;
    rows.push({ i, x, d, D, L, tweb, abe, abc, abs, ab: abe + abc + abs });
  }
  out.rows = rows;
  out.abmax = Math.max(...rows.map((r) => r.ab));
  return out;
}

/**
 * The rest of Data and Kn once the grain's areas are known (hollow cylinders: hollowData;
 * other shapes: JSRM's areas at 50 steps of web regression): the throat, from the target
 * pressure (C34 to C37) or as given, the At and Kn columns, and Kn max, min and average (J35:J37).
 * `rows` are { ab, tweb } with tweb the web left (only for the throat's erosion).
 */
export function knTable(m, rows, abmax, web) {
  const erate = m.settings.nozzleErosion;
  let at;
  let dto;
  let kn = null;
  if (m.throat.mode === 'target') {
    kn = knForPressure(m.propellant, targetPressure(m.throat.target));
    at = abmax / kn;
    dto = Math.sqrt(4 * at / Math.PI);
  } else {
    dto = m.throat.diameter;
    at = Math.PI / 4 * dto ** 2;
  }
  const table = rows.map((r) => {
    const atRow = Math.PI / 4 * (dto + erate * (web - r.tweb) / web) ** 2;
    return { ...r, at: atRow, kn: r.ab / atRow };
  });
  // (A shape METEOR models has no area left once its web is gone: such points are not its Kn min.)
  const kns = table.filter((r) => r.ab > 0).map((r) => r.kn);
  return {
    knTarget: kn,
    at,
    dto,
    dtf: Math.sqrt(4 * at / Math.PI) + erate,
    rows: table,
    knMax: Math.max(...kns),
    knMin: Math.min(...kns),
    knAvg: kns.reduce((a, b) => a + b, 0) / kns.length,
  };
}

/** Rows for knTable() from JSRM's areas of any grain (50 equal steps of the web). */
export function shapeRows(areas, web = 1) {
  return areas.burningArea.map((ab, i) => ({ i, progress: i / 50, ab, tweb: web * (1 - i / 50) }));
}

/** The Pressure worksheet's constants (C9 to C17). */
export function pressureConstants(m) {
  const p = propellant(m.propellant);
  const runiv = 8314;
  const rat = runiv / p.M;
  const to = m.settings.combustionEfficiency * p.T0;
  const k = p.k;
  return {
    runiv, M: p.M, R: rat, k, etac: m.settings.combustionEfficiency, T0: p.T0, To: to,
    patm: m.settings.ambientPressure,
    cstar: Math.sqrt(rat * to / k * ((k + 1) / 2) ** ((k + 1) / (k - 1))),
    gstar: m.settings.erosiveThreshold, kv: m.settings.erosiveCoefficient,
  };
}

/** Burn rate (mm/s) at pressure p (MPa absolute), from the propellant's table (VLOOKUP, as SRM). */
export function burnRate(name, p) {
  const t = propellant(name).burn;
  let row = t[0];
  for (const r of t) if (p >= r[0]) row = r;
  return row[1] * p ** row[2];
}

/**
 * Performance and Pressure worksheet cells that follow from the calculation's lines (JSRM's):
 * `result` is MotorLab's reply, `kn` knTable()'s. Pressures in the lines are gauge (SRM's AC).
 */
export function performance(m, result, kn) {
  const pc = pressureConstants(m);
  const { k, patm } = pc;
  const s = result.summary;
  const L = result.lines;
  const burnLines = s.burnLines; // lines 0 to burnLines − 1 burn the grain (SRM rows 28 to 862)
  const last = burnLines - 1;
  const erate = m.settings.nozzleErosion;
  const atAt = (i) => Math.PI / 4 * (kn.dto + erate * Math.min(i, last) / last) ** 2;
  const optimum = (po) => 1 / (((k + 1) / 2) ** (1 / (k - 1)) * (patm * 1e6 / po) ** (1 / k) * Math.sqrt((k + 1) / (k - 1) * (1 - (patm * 1e6 / po) ** ((k - 1) / k))));
  let cfMax = m.settings.nozzleEfficiency; // line 0: no thrust yet (Performance I28)
  for (let i = 1; i < L.t.length; i++) {
    const po = (L.pressure[i] + patm) * 1e6;
    cfMax = Math.max(cfMax, L.thrust[i] / (atAt(i) / 1e6 * po));
  }
  const pmaxAbs = (s.maxPressure + patm) * 1e6;
  // Web fraction (C14): 2·ravg·tbout/do, ravg the average burn rate of the burning lines, each at the
  // previous line's pressure (Pressure!P, M); only without erosive burning, for the hollow cylinder.
  let webFraction = null;
  if (m.grain.type === 'hollow' && !(pc.kv > 0)) {
    let sum = 0;
    for (let i = 0; i <= last; i++) sum += burnRate(m.propellant, i === 0 ? patm : L.pressure[i - 1] + patm);
    webFraction = 2 * (sum / burnLines) * L.t[last] / m.grain.outerDiameter;
  }
  return {
    ...pc,
    burnTime: L.t[last],
    thrustTime: s.thrustTime,
    maxPressurePsi: s.maxPressure / 0.006895,
    averageThrust: s.totalImpulse / s.thrustTime,
    exitArea: result.nozzle.expansion * kn.at, // Ae (C8): Ae/At × Ato
    optimalAtPmax: optimum(pmaxAbs),
    cfMax,
    webFraction,
  };
}

/** Nozzle Design: the nozzle's lengths from its half angles (C14 to C16). */
export function nozzleDesign(m, dt, de) {
  const dc = m.chamber.diameter;
  const lconv = (dc - dt) / 2 / Math.tan(m.settings.convergence * Math.PI / 180);
  const ldiv = (de - dt) / 2 / Math.tan(m.settings.divergence * Math.PI / 180);
  return { lconv, ldiv, overall: lconv + ldiv };
}

/**
 * The lines of the Output worksheet's thrust-time table: its 23 points are Performance rows 28, 70,
 * 71, 112, 154, ..., 868 and 910 (lines 0, 42, 43, 84, 126, ..., 840 and 882).
 */
export const OUTPUT_LINES = [0, 42, 43, ...Array.from({ length: 19 }, (_, i) => 84 + 42 * i), 882];

/** The Output worksheet: the motor's summary and its thrust-time table, as SRM draws them up. */
export function output(result) {
  const lines = OUTPUT_LINES;
  const L = result.lines;
  const rows = lines.filter((i) => i < L.t.length).map((i, n) => ({ n: n + 1, t: L.t[i], thrust: L.thrust[i], lbf: L.thrust[i] / 4.4482 }));
  // The time step (C20): the average step between points 3 and 22.
  let sum = 0;
  let count = 0;
  for (let i = 3; i < rows.length - 1; i++) {
    sum += rows[i].t - rows[i - 1].t;
    count++;
  }
  const s = result.summary;
  const averageThrust = s.totalImpulse / s.thrustTime;
  return {
    rows,
    step: count ? sum / count : NaN,
    grainMass: s.grainMass,
    grainMassLb: s.grainMass / 0.4536,
    totalImpulse: s.totalImpulse,
    totalImpulseLbs: s.totalImpulse / 4.448,
    averageThrust,
    averageThrustLb: averageThrust / 4.4482,
    thrustTime: s.thrustTime,
    isp: s.isp,
    motorClass: s.motorClass,
    designation: `${s.motorClass}${Math.round(averageThrust)}`,
  };
}

// ------------------------------------------------------------------ the motor file (.eng)

/**
 * The thrust curve with fewer points (Ramer-Douglas-Peucker): every point that is more than
 * `tolerance` (a share of the peak thrust) off the line through its neighbours stays.
 */
export function simplifyCurve(t, f, tolerance = 0.002) {
  const peak = Math.max(...f);
  const eps = tolerance * peak;
  const keep = new Uint8Array(t.length);
  keep[0] = 1;
  keep[t.length - 1] = 1;
  const stack = [[0, t.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let worst = -1;
    let at = -1;
    for (let i = a + 1; i < b; i++) {
      // How far the thrust is from the straight line between the two points kept on either side.
      const u = (t[i] - t[a]) / ((t[b] - t[a]) || 1);
      const off = Math.abs(f[i] - (f[a] + u * (f[b] - f[a])));
      if (off > worst) {
        worst = off;
        at = i;
      }
    }
    if (at >= 0 && worst > eps) {
      keep[at] = 1;
      stack.push([a, at], [at, b]);
    }
  }
  const out = [];
  for (let i = 0; i < t.length; i++) if (keep[i]) out.push([t[i], f[i]]);
  return out;
}

const trapezoid = (pts) => {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += (pts[i][1] + pts[i - 1][1]) / 2 * (pts[i][0] - pts[i - 1][0]);
  return s;
};

/** A word OpenRocket's .eng reader takes (no spaces), or the fallback. */
const word = (s, fallback) => String(s ?? '').trim().replace(/\s+/g, '-').replace(/[^\x21-\x7e]/g, '') || fallback;

const fixed = (v, digits) => {
  const s = v.toFixed(digits);
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
};

/** What the motor file needs and SRM does not work out, with what to say when it is missing. */
const ENG_DETAILS = {
  diameter: 'Enter the motor’s outside diameter (mm) for the motor file.',
  length: 'Enter the motor’s length (mm) for the motor file.',
  hardwareMass: 'Enter the motor’s empty (hardware) mass for the motor file.',
};

/** The motor file's details not entered yet: some of 'diameter', 'length' and 'hardwareMass'. */
export function engMissing(eng) {
  const missing = [];
  if (!(Number(eng.diameter) > 0)) missing.push('diameter');
  if (!(Number(eng.length) > 0)) missing.push('length');
  if (!(Number(eng.hardwareMass) >= 0) || eng.hardwareMass === '' || eng.hardwareMass == null) missing.push('hardwareMass');
  return missing;
}

/**
 * The motor as a RASP .eng file for OpenRocket: { text, filename, points, impulse }. `eng` is the
 * export settings (name, diameter, length, delays, hardwareMass in kg, manufacturer).
 */
export function engFile(result, eng, { title = '', propellantName = '', grainLabel = '' } = {}) {
  const out = output(result);
  const name = word(eng.name, out.designation);
  const diameter = Number(eng.diameter);
  const length = Number(eng.length);
  const hardware = Number(eng.hardwareMass);
  const [missing] = engMissing(eng);
  if (missing) throw new Error(ENG_DETAILS[missing]);
  const prop = result.summary.grainMass;
  const total = prop + hardware;
  const L = result.lines;
  // The curve without its (0, 0) start, which OpenRocket adds itself; times strictly increasing.
  const pts = simplifyCurve(L.t, L.thrust).filter(([tt]) => tt > 0);
  const written = [];
  for (const [tt, ff] of pts) {
    const ts = fixed(tt, 4);
    const fs = fixed(Math.max(0, ff), 2);
    if (written.length && Number(written[written.length - 1][0]) >= Number(ts)) continue;
    written.push([ts, fs]);
  }
  if (written.length && Number(written[written.length - 1][1]) !== 0) written.push([fixed(Number(written[written.length - 1][0]) + 0.001, 4), '0']);
  const delays = word(eng.delays, 'P');
  const manufacturer = word(eng.manufacturer, 'Custom');
  const lines = [
    `; ${title || name}`.slice(0, 200),
    `; ${[propellantName, grainLabel].filter(Boolean).join(', ')}`.slice(0, 200),
    '; Designed in Rocket in Cloud: JSRM 3.3, the Java version of Richard Nakka\'s SRM_2023.',
    `; Total impulse ${out.totalImpulse.toFixed(1)} N-s, average thrust ${out.averageThrust.toFixed(1)} N, burn ${out.thrustTime.toFixed(3)} s, Isp ${out.isp.toFixed(1)} s.`,
    `${name} ${fixed(diameter, 2)} ${fixed(length, 1)} ${delays} ${fixed(prop, 5)} ${fixed(total, 5)} ${manufacturer}`,
    ...written.map(([a, b]) => `   ${a} ${b}`),
    ';',
  ];
  const points = written.map(([a, b]) => [Number(a), Number(b)]);
  return {
    text: `${lines.join('\n')}\n`,
    filename: `${name.replace(/[^A-Za-z0-9._-]/g, '_')}.eng`,
    points,
    impulse: trapezoid([[0, 0], ...points]),
    designImpulse: out.totalImpulse,
  };
}
