// The motor designer's casing (src/motor/casing.js) against Richard Nakka's CASING.XLS (version
// 1.03): its Analysis sheet's example, a 6061-T6511 tube of 2.368 in inside diameter and 0.065 in
// wall, with the values Excel saved in the file (from casing_fr.xlsx, the French translation on his
// site, whose formulas and values are the English sheet's; the English file is password protected).
// Then each limit and caution the page gives.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BURST_CHART, CASING_MATERIALS, MPA_PER_KSI, MPA_PER_MSI, PSI_PER_MPA, burstFactor, casingDesign, casingMaterial, casingResult, celsius, heatFactors,
  materialProperties, suggestedCasing, targetUnder,
} from '../src/motor/casing.js';
import { TARGETS } from '../src/motor/srm.js';

/** Equal to the spreadsheet's value within `rel` (relative). */
function near(actual, expected, rel = 1e-12, what = '') {
  const tol = Math.abs(expected) * rel || rel;
  assert.ok(Math.abs(actual - expected) <= tol, `${what}: ${actual} vs ${expected} (±${tol})`);
}

// Analysis D8:D17 (inputs, US units: in, psi) and D19:D31 (results), as Excel saved them.
const EXAMPLE = { do: 2.368 + 2 * 0.065, t: 0.065, sd: 1.5, fty: 35 * 1000, ftu: 38 * 1000, e: 9.9e6, nu: 0.33 };
const SAVED = {
  beta: 0.9210526315789473, B: 1.2311322343003113, PD: 1214.3047771550575, PU: 2242.4546301306714,
  SU: 1.846698351450467, DD: 0.004916097643097642, DC: 0.01544437623988565,
};

test('Analysis: Nakka’s example, cell for cell (in and psi, as the sheet has it)', () => {
  const r = casingDesign(EXAMPLE);
  near(r.beta, SAVED.beta, 1e-15, 'β (D19)');
  near(r.burstFactor, SAVED.B, 1e-14, 'B (D20)');
  near(r.designPressure, SAVED.PD, 1e-14, 'PD (D24)');
  near(r.burstPressure, SAVED.PU, 1e-14, 'PU (D25)');
  near(r.burstSafety, SAVED.SU, 1e-14, 'SU (D26)');
  near(r.growth.diameter, SAVED.DD, 1e-14, 'ΔD (D30)');
  near(r.growth.circumference, SAVED.DC, 1e-14, 'ΔC (D31)');
  assert.equal(r.inside, 2.368 + 2 * 0.065 - 2 * 0.065);
  assert.deepEqual(r.notes, []);
});

test('the same casing in mm and MPa gives the same pressures, in MPa', () => {
  const mm = 25.4;
  const r = casingDesign({ do: EXAMPLE.do * mm, t: EXAMPLE.t * mm, sd: 1.5, fty: 35 * MPA_PER_KSI, ftu: 38 * MPA_PER_KSI, e: 9.9 * MPA_PER_MSI, nu: 0.33 });
  near(r.designPressure * PSI_PER_MPA, SAVED.PD, 1e-12, 'PD');
  near(r.burstPressure * PSI_PER_MPA, SAVED.PU, 1e-12, 'PU');
  near(r.burstSafety, SAVED.SU, 1e-12, 'SU');
  // E converted with Nakka's 6900 MPa per Msi (6894.76 exactly): the growth agrees to a thousandth.
  near(r.growth.diameter / mm, SAVED.DD, 1e-3, 'ΔD');
});

test('the burst factor: Nakka’s fit follows his chart', () => {
  for (const [beta, b] of BURST_CHART) near(burstFactor(beta), b, 0.003, `β ${beta}`);
  // Stronger relative to yield (lower β) bursts later: B falls as β rises, over the chart.
  for (let beta = 0.5; beta < 1; beta += 0.05) assert.ok(burstFactor(beta + 0.05) < burstFactor(beta), `B falls past β ${beta}`);
});

test('Material Properties: Nakka’s table, in his MPa', () => {
  assert.equal(CASING_MATERIALS.length, 24);
  assert.deepEqual(materialProperties('6061-t6511'), { fty: 35 * 6.895, ftu: 38 * 6.895, e: 9.9 * 6900, nu: 0.33 });
  assert.deepEqual(materialProperties('4130-cd'), { fty: 90 * 6.895, ftu: 100 * 6.895, e: 29 * 6900, nu: 0.32 });
  assert.deepEqual(materialProperties('pvc40'), { fty: 6 * 6.895, ftu: 7.45 * 6.895, e: 0.42 * 6900, nu: 0.41 });
  assert.deepEqual(materialProperties('abs'), { fty: 5.1 * 6.895, ftu: 5.9 * 6.895, e: 0.29 * 6900, nu: null });
  assert.deepEqual(materialProperties('paperboard'), { fty: null, ftu: 2 * 6.895, e: null, nu: null });
  assert.equal(materialProperties('unobtainium'), null);
  for (const m of CASING_MATERIALS) {
    assert.ok(m.fty == null || m.fty <= m.ftu, `${m.spec}: Fty ≤ Ftu`);
    assert.equal(casingMaterial(m.id), m);
  }
  assert.equal(new Set(CASING_MATERIALS.map((m) => m.id)).size, CASING_MATERIALS.length, 'ids are unique');
});

test('Elevated Temperatures: the strength left, from Nakka’s curves', () => {
  assert.deepEqual(heatFactors('al6061', 20), { fty: 1, ftu: 1 }); // room temperature and below
  assert.deepEqual(heatFactors('al6061', -40), { fty: 1, ftu: 1 });
  assert.deepEqual(heatFactors('al6061', celsius(80)), { fty: 1, ftu: 1 });
  const at400F = heatFactors('al6061', celsius(400));
  near(at400F.fty, 0.695, 1e-12, '6061-T6 Fty at 400 °F');
  near(at400F.ftu, 0.64, 1e-12, '6061-T6 Ftu at 400 °F');
  const at350F = heatFactors('al6061', celsius(350)); // halfway between 300 and 400 °F
  near(at350F.fty, (0.833 + 0.695) / 2, 1e-12, 'interpolated Fty');
  near(heatFactors('alloySteel', celsius(800)).fty, 0.685, 1e-12, 'steel at its last point');
  near(heatFactors('lowCarbon', celsius(900)).fty, 23500 / 42000, 1e-12, 'SAE 1020 at 900 °F');
  assert.match(heatFactors('al6061', celsius(501)).error, /goes up to 260 °C \(500 °F\)/);
  assert.match(heatFactors('alloySteel', 500).error, /goes up to 427 °C \(800 °F\)/);
  assert.match(heatFactors(null, 100).error, /no strength data above room temperature/);
  assert.deepEqual(heatFactors(null, 25), { fty: 1, ftu: 1 }); // no curve needed at room temperature
  assert.match(heatFactors('al6061', NaN).error, /Enter the casing temperature/);
});

test('the casing as the page holds it: mm, MPa and °C, with the material’s strength at temperature', () => {
  const c = suggestedCasing(60.1472); // Nakka's example: 2.368 in inside
  assert.equal(c.material, '6061-t6511');
  near(c.outerDiameter, 2.498 * 25.4, 1e-4, 'outside diameter');
  near(c.wall, 0.065 * 25.4, 1e-15, 'wall');
  const r = casingResult(c);
  near(r.designPressure * PSI_PER_MPA, SAVED.PD, 1e-4, 'PD');
  // Hot: 6061 at 400 °F keeps 69.5 % of its yield strength, and the design pressure with it.
  const warm = casingResult({ ...c, temperature: celsius(300) });
  near(warm.designPressure / r.designPressure, 0.833, 1e-12, 'PD at 300 °F');
  near(warm.beta, 35 * 0.833 / (38 * 0.80), 1e-12, 'β at 300 °F');
  // At 400 °F the curves take 36 % off Ftu but 30.5 % off Fty: for this tube (Fty 35, Ftu 38 ksi)
  // the yield strength would pass the ultimate. It is taken as equal, and said.
  const hot = casingResult({ ...c, temperature: celsius(400) });
  near(hot.fty, hot.ftu, 1e-15, 'Fty capped at Ftu');
  near(hot.ftu, 38 * MPA_PER_KSI * 0.64, 1e-12, 'Ftu at 400 °F');
  assert.equal(hot.beta, 1);
  assert.match(hot.notes[0], /yield strength is taken as equal/);
  assert.ok(hot.designPressure < 38 * MPA_PER_KSI * 0.64 / (35 * MPA_PER_KSI * 0.695) * r.designPressure * 1.0000001);
  // Values entered the wrong way round at room temperature are still refused, hot or not.
  assert.throws(() => casingResult({ ...c, fty: 300, ftu: 262, temperature: celsius(400) }), /more than the ultimate strength/);
  // A material of one's own keeps its values as entered, at any temperature.
  const own = casingResult({ ...c, material: 'other', temperature: 300 });
  assert.equal(own.heat.asEntered, true);
  near(own.designPressure, r.designPressure, 1e-15, 'own material, hot');
  // A table material without curves cannot be worked out hot.
  assert.throws(() => casingResult({ ...c, material: '7075-t6', ...materialProperties('7075-t6'), temperature: 100 }), /no strength data above room temperature.*Other material/);
  assert.doesNotThrow(() => casingResult({ ...c, material: '7075-t6', ...materialProperties('7075-t6'), temperature: 25 }));
  assert.equal(suggestedCasing(null).outerDiameter, 78.302); // no chamber yet: SRM's 75 mm
});

test('what a casing cannot be: refused, in plain words', () => {
  const ok = { do: 63.45, t: 1.651, sd: 1.5, fty: 241.3, ftu: 262, e: 68310, nu: 0.33 };
  assert.throws(() => casingDesign({ ...ok, do: 0 }), /Enter the casing’s outside diameter/);
  assert.throws(() => casingDesign({ ...ok, do: -5 }), /Enter the casing’s outside diameter/);
  assert.throws(() => casingDesign({ ...ok, do: NaN }), /Enter the casing’s outside diameter/);
  assert.throws(() => casingDesign({ ...ok, t: 0 }), /Enter the casing’s wall thickness/);
  assert.throws(() => casingDesign({ ...ok, t: ok.do / 2 }), /no inside/);
  assert.throws(() => casingDesign({ ...ok, t: 40 }), /no inside/);
  assert.throws(() => casingDesign({ ...ok, sd: 0 }), /Enter the design factor/);
  assert.throws(() => casingDesign({ ...ok, fty: null }), /yield strength, Fty/);
  assert.throws(() => casingDesign({ ...ok, ftu: -1 }), /ultimate strength, Ftu/);
  assert.throws(() => casingDesign({ ...ok, fty: 300 }), /yield strength \(Fty\) is more than the ultimate strength/);
  assert.throws(() => casingResult({ ...suggestedCasing(60), material: 'paperboard', ...materialProperties('paperboard') }), /no yield strength for paperboard/);
  // Fty = Ftu is a material (β = 1, the chart's end).
  assert.doesNotThrow(() => casingDesign({ ...ok, fty: 262 }));
});

test('cautions that go with a casing that can be', () => {
  const ok = { do: 63.45, t: 1.651, sd: 1.5, fty: 241.3, ftu: 262, e: 68310, nu: 0.33 };
  const notes = (x) => casingDesign({ ...ok, ...x }).notes.join(' ');
  assert.equal(notes({}), '');
  assert.match(notes({ sd: 1.2 }), /below the 1.5 to 2.0 Nakka recommends/);
  assert.match(notes({ sd: 0.8 }), /below 1: the casing would yield below its design pressure/);
  assert.equal(notes({ sd: 2.5 }), '');
  assert.match(notes({ t: 8 }), /thicker than a tenth of the diameter/);
  assert.match(notes({ fty: 80 }), /below Nakka’s burst factor chart/);
  assert.match(notes({ e: null }), /Enter the modulus of elasticity/);
  assert.match(notes({ nu: 0.5 }), /Poisson’s ratio/);
  assert.match(notes({ nu: null }), /Poisson’s ratio/);
  assert.equal(casingDesign({ ...ok, nu: null }).growth, null);
  assert.ok(casingDesign({ ...ok, nu: 0 }).growth.diameter > 0);
  // A thicker wall, a stronger tube or a lower design factor all raise the design pressure.
  const pd = (x) => casingDesign({ ...ok, ...x }).designPressure;
  assert.ok(pd({ t: 2 }) > pd({}));
  assert.ok(pd({ fty: 250 }) > pd({}));
  assert.ok(pd({ sd: 1.2 }) > pd({}));
  assert.ok(pd({ do: 80 }) < pd({}));
});

test('the target MEOP the casing allows: the highest of SRM’s targets at or under its design pressure', () => {
  assert.deepEqual(targetUnder(6.5, TARGETS), ['6.5 MPa', 6.5]);
  assert.deepEqual(targetUnder(8.37, TARGETS), ['1200 psi', 8.274]);
  assert.deepEqual(targetUnder(100, TARGETS), ['9 MPa', 9]);
  assert.deepEqual(targetUnder(6.2055, TARGETS), ['900 psi', 6.2055]);
  assert.equal(targetUnder(0.5, TARGETS), null);
});
