// The motor casing, as Richard Nakka's CASING.XLS (version 1.03, "Motor Casing Design") works it out:
// the design pressure (the highest chamber pressure the casing takes without stretching for good,
// with a design factor on its yield strength) and the burst pressure, and how much the casing grows
// under pressure. His sheets: Analysis (the formulas below, thin-wall, from Roark and Blake),
// Material Properties (the table below) and Elevated Temperatures (the strength left when hot).
//
// The formulas hold in any consistent units: the page uses millimetres and MPa. Nakka's own
// conversions are kept (1 ksi = 6.895 MPa, 1 Msi = 6900 MPa), so the table's MPa are his.

export const MPA_PER_KSI = 6.895;
export const MPA_PER_MSI = 6900;
export const PSI_PER_MPA = 1000 / MPA_PER_KSI;

/** The burst factor B against β = Fty/Ftu: Nakka's fit (Analysis T24:T33) of his chart (P25:Q35). */
const BURST_FIT = [9.5833, -33.528, 44.929, -28.479, 8.6475];
/** The chart's points (β, B), which the fit follows; outside β 0.5 to 1 the fit is extrapolated. */
export const BURST_CHART = [[0.5, 2.048], [0.6, 1.735], [0.7, 1.527], [0.8, 1.379], [0.9, 1.254], [1, 1.153]];

/** Nakka's burst factor for β = Fty/Ftu (Analysis D20), its polynomial evaluated as the cell does. */
export function burstFactor(beta) {
  const [a, b, c, d, e] = BURST_FIT;
  return a * beta ** 4 + b * beta ** 3 + c * beta ** 2 + d * beta + e;
}

// Material Properties, at room temperature (80 °F): Fty and Ftu in ksi, E in Msi, ν; null where
// Nakka gives none. `heat` names his elevated-temperature curves for the material (see HEAT).
const M = (id, kind, spec, use, fty, ftu, e, nu, heat = null, note = '') => ({ id, kind, spec, use, fty, ftu, e, nu, heat, note });
export const CASING_MATERIALS = [
  M('c1010-hr', 'Steel, low carbon', 'C1010 hot rolled tubing', 'General purpose', 24, 43, 29, 0.32, 'lowCarbon'),
  M('c1010-cd', 'Steel, low carbon', 'C1010 cold drawn seamless tubing', 'General purpose', 60, 72, 29, 0.32, 'lowCarbon'),
  M('c1015-hr', 'Steel, low carbon', 'C1015 hot rolled tubing', 'General purpose', 33, 55, 29, 0.32, 'lowCarbon'),
  M('c1015-n', 'Steel, low carbon', 'C1015 normalized tubing', 'General purpose', 35, 50, 29, 0.32, 'lowCarbon'),
  M('c1015-cd', 'Steel, low carbon', 'C1015 cold drawn seamless tubing', 'General purpose', 65, 80, 29, 0.32, 'lowCarbon'),
  M('c1025-hr', 'Steel, low carbon', 'C1025 hot rolled tubing', 'General purpose', 45, 67, 29, 0.32, 'lowCarbon'),
  M('c1025-n', 'Steel, low carbon', 'C1025 normalized tubing', 'General purpose', 48, 65, 29, 0.32, 'lowCarbon'),
  M('c1025-cd', 'Steel, low carbon', 'C1025 cold drawn seamless tubing', 'General purpose', 70, 85, 29, 0.32, 'lowCarbon'),
  M('ss30304', 'Stainless steel', 'SAE 30304 tubing', 'Hydraulic', 75, 105, 27, 0.27, 'stainless'),
  M('ss301', 'Stainless steel', 'SAE 301, 1/4 hard, tubing', 'General purpose', 75, 125, 27, 0.27, 'stainless'),
  M('4130-n', 'Steel, alloy', 'AISI 4130 normalized (MIL-T-6736) tubing', 'Aerospace', 75, 95, 29, 0.32, 'alloySteel'),
  M('4130-cd', 'Steel, alloy', 'AISI 4130 cold drawn (MIL-T-6736) tubing', 'Aerospace', 90, 100, 29, 0.32, 'alloySteel'),
  M('6061-t4', 'Aluminum alloy', '6061-T4 drawn tubing', 'Aerospace', 16, 30, 9.9, 0.33, 'al6061'),
  M('6061-t6', 'Aluminum alloy', '6061-T6 drawn tubing', 'Aerospace', 35, 42, 9.9, 0.33, 'al6061'),
  M('6061-t6511', 'Aluminum alloy', '6061-T6511 extruded tubing', 'Aerospace', 35, 38, 9.9, 0.33, 'al6061'),
  M('2024-t3', 'Aluminum alloy', '2024-T3 drawn tubing', 'Aerospace', 45, 66, 10.5, 0.33, 'al2024'),
  M('2024-t42', 'Aluminum alloy', '2024-T42 drawn tubing', 'Aerospace', 38, 62, 10.5, 0.33, 'al2024'),
  M('7075-t6', 'Aluminum alloy', '7075-T6 (WW-T-700) drawn tubing', 'Aerospace', 66, 77, 10.4, 0.33),
  M('7075-t73', 'Aluminum alloy', '7075-T73 (WW-T-700) drawn tubing', 'Aerospace', 56, 66, 10.4, 0.33),
  M('pvc40', 'Polyvinyl chloride (PVC)', 'Rigid pipe, schedule 40', 'Water pipe', 6, 7.45, 0.42, 0.41),
  M('abs', 'Acrylonitrile butadiene styrene (ABS)', 'Rigid pipe', 'Drain pipe', 5.1, 5.9, 0.29, null),
  M('paperboard', 'Paperboard', 'Spiral wound tube', '', null, 2, null, null),
  M('emt1', 'EMT (electrical conduit)', 'Similar to C1015 annealed', 'Electrical conduit', 43, 57, 29, 0.32, 'lowCarbon',
    'From Brinell hardness tests of one brand of EMT.'),
  M('emt2', 'EMT (electrical conduit)', 'Similar to C1015 annealed', 'Electrical conduit', 45, 60, 29, 0.32, 'lowCarbon',
    'From Brinell hardness tests of another brand of EMT.'),
];
export const casingMaterial = (id) => CASING_MATERIALS.find((m) => m.id === id) ?? null;

/** A material's properties in the page's units (MPa), as Nakka's table gives them in MPa. */
export function materialProperties(id) {
  const m = casingMaterial(id);
  if (!m) return null;
  const mpa = (ksi) => (ksi == null ? null : MPA_PER_KSI * ksi);
  return { fty: mpa(m.fty), ftu: mpa(m.ftu), e: m.e == null ? null : MPA_PER_MSI * m.e, nu: m.nu };
}

/**
 * Elevated Temperatures: the strength left (% of the room-temperature value) after half an hour at
 * a temperature (°F), Nakka's Fig. 1 (Fty) and Fig. 2 (Ftu) from MIL-HDBK-5G, and for low-carbon
 * steel his SAE 1020 points. He advises using them for a casing that gets hot (an unbonded grain).
 */
export const HEAT = {
  alloySteel: { name: 'AISI low-alloy steel', fty: [[80, 100], [200, 95], [400, 87], [600, 79], [800, 68.5]], ftu: [[80, 100], [200, 98], [400, 95], [600, 89], [800, 77]] },
  stainless: { name: 'AISI 301 ½ hard stainless steel', fty: [[80, 100], [200, 92.5], [400, 86], [600, 84], [800, 80]], ftu: [[80, 100], [200, 89.5], [400, 79.5], [600, 72.5], [800, 67.5]] },
  al2024: { name: '2024-T3 aluminum', fty: [[80, 100], [200, 94.2], [300, 87], [400, 77], [500, 50]], ftu: [[80, 100], [200, 92], [300, 84], [400, 75], [500, 50]] },
  al6061: { name: '6061-T6 aluminum', fty: [[80, 100], [200, 92.2], [300, 83.3], [400, 69.5], [500, 44]], ftu: [[80, 100], [200, 91], [300, 80], [400, 64], [500, 42]] },
  lowCarbon: {
    name: 'SAE 1020 low-carbon steel',
    fty: [[85, 100], [900, 23500 / 42000 * 100], [1000, 20100 / 42000 * 100], [1300, 7375 / 42000 * 100], [1400, 3750 / 42000 * 100]],
    ftu: [[85, 100], [900, 45500 / 62400 * 100], [1000, 36500 / 62400 * 100], [1200, 20000 / 62400 * 100], [1300, 13500 / 62400 * 100], [1400, 9025 / 62400 * 100]],
  },
};
export const fahrenheit = (c) => c * 1.8 + 32;
export const celsius = (f) => (f - 32) / 1.8;

/** The share of a strength left at `tempC` (1 at room temperature), from a curve; null beyond its end. */
function left(points, tempC) {
  const f = fahrenheit(tempC);
  if (f <= points[0][0]) return 1;
  for (let i = 1; i < points.length; i++) {
    const [f0, p0] = points[i - 1];
    const [f1, p1] = points[i];
    if (f <= f1) return (p0 + (p1 - p0) * (f - f0) / (f1 - f0)) / 100;
  }
  return null;
}

/**
 * The strength left at `tempC` for Nakka's curve `heat`: { fty, ftu } as shares (1 = all), or an
 * error string. Room temperature (80 °F, 26.7 °C, and below) leaves all of it, with or without a curve.
 */
export function heatFactors(heat, tempC) {
  if (!Number.isFinite(tempC)) return { error: 'Enter the casing temperature.' };
  const curve = HEAT[heat];
  const room = celsius((curve?.fty ?? [[80]])[0][0]);
  if (tempC <= room) return { fty: 1, ftu: 1 };
  if (!curve) return { error: `Nakka’s sheet has no strength data above room temperature (${room.toFixed(1)} °C) for this material.` };
  const fty = left(curve.fty, tempC);
  const ftu = left(curve.ftu, tempC);
  if (fty == null || ftu == null) {
    const top = Math.min(curve.fty.at(-1)[0], curve.ftu.at(-1)[0]);
    return { error: `Nakka’s data for ${curve.name} goes up to ${Math.round(celsius(top))} °C (${top} °F).` };
  }
  return { fty, ftu };
}

/**
 * Analysis: the casing's design and burst pressures from its outside diameter `do`, wall `t`, design
 * factor `sd` and material (`fty`, `ftu` and, for the growth under pressure, `e` and `nu`), in any
 * consistent units (mm and MPa: pressures in MPa, growth in mm). Throws for values that cannot be;
 * `notes` are the cautions that go with values that can.
 *   β = Fty/Ftu;  B = burst factor(β)
 *   PD = 2 t Fty / (Do SD)          design pressure (the most the casing takes without yielding, / SD)
 *   PU = 2 t Fty B / Do             burst pressure
 *   SU = PU / PD                    burst safety factor
 *   ΔD = 2 PD (Do/2)² (1 − ν/2) / (E t);  ΔC = π ΔD   growth at PD (elastic, gone when the pressure is)
 */
export function casingDesign({ do: od, t, sd, fty, ftu, e = null, nu = null }) {
  const pos = (v, what) => {
    if (!(Number.isFinite(v) && v > 0)) throw new Error(`Enter ${what} (more than 0).`);
  };
  pos(od, 'the casing’s outside diameter');
  pos(t, 'the casing’s wall thickness');
  if (!(t < od / 2)) throw new Error('The wall is as thick as the casing’s radius or thicker: the casing has no inside. Make the wall thinner, or the casing wider.');
  pos(sd, 'the design factor');
  pos(fty, 'the material’s yield strength, Fty');
  pos(ftu, 'the material’s ultimate strength, Ftu');
  if (fty > ftu) throw new Error('The yield strength (Fty) is more than the ultimate strength (Ftu): a material yields before it breaks. Check the two values.');
  const notes = [];
  const beta = fty / ftu;
  const b = burstFactor(beta);
  if (beta < BURST_CHART[0][0]) notes.push(`Fty/Ftu is ${beta.toFixed(3)}, below Nakka’s burst factor chart (0.5 to 1): the burst factor is his fit carried beyond it.`);
  const pd = 2 * t * fty / (od * sd);
  const pu = 2 * t * fty * b / od;
  if (sd < 1) notes.push('The design factor is below 1: the casing would yield below its design pressure. Nakka uses 1.5 to 2.0.');
  else if (sd < 1.5) notes.push('The design factor is below the 1.5 to 2.0 Nakka recommends.');
  if (od / t < 10) notes.push('The wall is thicker than a tenth of the diameter: Nakka’s thin-wall formulas are only approximate for it.');
  let growth = null;
  if (Number.isFinite(e) && e > 0 && Number.isFinite(nu) && nu >= 0 && nu < 0.5) {
    const dd = 2 * pd * (od / 2) ** 2 / e / t * (1 - nu / 2);
    growth = { diameter: dd, circumference: Math.PI * dd };
  } else {
    notes.push(!(Number.isFinite(e) && e > 0)
      ? 'Enter the modulus of elasticity (E) to see how much the casing grows under pressure.'
      : 'Enter Poisson’s ratio (from 0 to under 0.5) to see how much the casing grows under pressure.');
  }
  return { inside: od - 2 * t, beta, burstFactor: b, designPressure: pd, burstPressure: pu, burstSafety: pu / pd, growth, notes };
}

/** A casing for a motor that has none yet: Nakka's example tube (6061-T6511, 0.065 in wall) around its chamber. */
export function suggestedCasing(chamberDiameter) {
  const wall = 0.065 * 25.4;
  const p = materialProperties('6061-t6511');
  return {
    set: false, material: '6061-t6511', outerDiameter: Number(((Number.isFinite(chamberDiameter) && chamberDiameter > 0 ? chamberDiameter : 75) + 2 * wall).toFixed(3)),
    wall, designFactor: 1.5, temperature: 20, ...p,
  };
}

/**
 * The casing as the page holds it ({ material, outerDiameter, wall, designFactor, temperature, fty,
 * ftu, e, nu }, mm, MPa and °C), worked out: its strength at the temperature, then the Analysis.
 * Throws as casingDesign does, and for a temperature beyond Nakka's data. A material of one's own
 * ("Other material": no `material` in the table) keeps its strength as entered, hot or not.
 */
export function casingResult(c) {
  const material = casingMaterial(c.material);
  // A material of one's own: its strength as entered, at whatever temperature it was measured.
  const heat = material ? heatFactors(material.heat, c.temperature) : { fty: 1, ftu: 1, asEntered: true };
  if (heat.error) throw new Error(material && !material.heat ? `${heat.error} Enter its strength at your temperature with “Other material”, or work at room temperature.` : heat.error);
  if (c.fty == null && material && material.fty == null) throw new Error(`Nakka’s table has no yield strength for ${material.kind.toLowerCase()}: enter one for your tube, or choose another material.`);
  if (c.fty > c.ftu) casingDesign({ do: c.outerDiameter, t: c.wall, sd: c.designFactor, fty: c.fty, ftu: c.ftu }); // says so
  let fty = Number.isFinite(c.fty) ? c.fty * heat.fty : c.fty;
  const ftu = Number.isFinite(c.ftu) ? c.ftu * heat.ftu : c.ftu;
  // Nakka's curves can take more off the ultimate strength than off the yield strength: for a tube
  // whose two are close (6061-T6511 at 400 °F), the yield strength would pass the ultimate. It is
  // taken as equal (a material cannot yield after it breaks): lower, so the design pressure is too.
  const capped = fty > ftu;
  if (capped) fty = ftu;
  const r = casingDesign({ do: c.outerDiameter, t: c.wall, sd: c.designFactor, fty, ftu, e: c.e, nu: c.nu });
  if (capped) r.notes.unshift('At this temperature Nakka’s curves leave the yield strength above the ultimate strength for this tube: the yield strength is taken as equal to it.');
  return { ...r, heat, fty, ftu };
}

/**
 * The highest of SRM's target pressures (`targets`: [label, MPa]) at or under `pressure` (MPa), or
 * null if even the lowest is above it.
 */
export function targetUnder(pressure, targets) {
  let best = null;
  for (const [label, p] of targets) if (p <= pressure && (!best || p > best[1])) best = [label, p];
  return best;
}
