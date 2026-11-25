// The motor designer's worksheets (src/motor/srm.js) against Richard Nakka's SRM_2023.xls: its
// example motor (an L-class KNDX motor, the spreadsheet as it comes), cell by cell. The values
// expected are the spreadsheet's own, as Excel saved them in the file. Where a cell follows from the
// calculation's lines, the lines are JSRM's (test/fixtures/jsrm-srm2023-example.json: what
// orcloud.bridge.MotorLab answers for this motor), which agree with SRM's to about a millionth.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  GRAIN_FIELDS, cellNumber, engFile, engMissing, exampleMotor, grainDefaults, grainHoles, hollowData, knForPressure, knTable, nozzleDesign, output, performance, pressureConstants, targetPressure,
} from '../src/motor/srm.js';
import { readMotorFile } from '../../server/src/motors.js';

const jsrm = JSON.parse(readFileSync(new URL('./fixtures/jsrm-srm2023-example.json', import.meta.url), 'utf8'));

/** Equal to the spreadsheet's value within `rel` (relative). */
function near(actual, expected, rel = 1e-12, what = '') {
  const tol = Math.abs(expected) * rel || rel;
  assert.ok(Math.abs(actual - expected) <= tol, `${what}: ${actual} vs SRM ${expected} (±${tol})`);
}

test('Data and Kn: the grain and the chamber, as SRM_2023 works them out', () => {
  const m = exampleMotor();
  const d = hollowData(m);
  assert.equal(d.vc, 2076396.394482004); // C12
  assert.equal(d.lgo, 460); // C23
  assert.equal(d.vg, 1575555.839665085); // C24
  assert.equal(d.vl, 0.7587933806146572); // C25
  assert.equal(d.density, 1.78505); // C28
  assert.equal(d.mgrain, 2.8124459515941598); // C29
  assert.equal(d.abeo, 27400.971124610176); // C30
  assert.equal(d.abco, 28902.652413026095); // C31
  assert.equal(d.abso, 0); // C32
  assert.equal(d.abo, 56303.623537636275); // C33
  assert.equal(d.xinc, 0.49); // C42 (Solve 1)
});

test('Data and Kn: the target pressure gives SRM_2023\'s throat', () => {
  const m = exampleMotor();
  assert.equal(targetPressure('900 psi'), 6.2055);
  assert.equal(knForPressure('KNDX', 6.2055), 307.3978683172302); // C35 Kn max
  const d = hollowData(m);
  const k = knTable(m, d.rows, d.abmax, d.web);
  assert.equal(d.abmax, 68080.25305091369); // K96
  assert.equal(k.at, 221.4727558899525); // C36 Ato
  assert.equal(k.dto, 16.7924944805876); // C37 Dto
  assert.equal(k.dtf, 16.7924944805876); // C40 Dtf (no erosion)
  assert.equal(k.knMax, 307.3978683172302); // J35
  assert.equal(k.knMin, 254.22370038874197); // J36
  near(k.knAvg, 289.68593487696023, 1e-15, 'J37 Kn avg');
});

test('Data and Kn: the Kn table, row by row', () => {
  const m = exampleMotor();
  const d = hollowData(m);
  const { rows } = knTable(m, d.rows, d.abmax, d.web);
  assert.equal(rows.length, 51);
  // Rows 46, 51, 71 and 95 of the worksheet: x, d, L, tweb, Abe, Abc, Ab, Kn.
  const sheet = {
    1: [0.49, 20.98, 456.08, 24.009999999999998, 27148.63588939972, 30060.512774884905, 57209.14866428463, 258.3123528417701],
    6: [2.9400000000000004, 25.880000000000003, 436.48, 21.56, 25705.928578276984, 35487.752314038036, 61193.680892315024, 276.30342452920723],
    26: [12.740000000000004, 45.480000000000004, 358.08, 11.759999999999998, 16917.913749278414, 51162.339301635264, 68080.25305091369, 307.3978683172302],
    50: [24.49999999999998, 68.99999999999996, 264.00000000000017, 2.1316282072803006e-14, 3.4287142482824054e-11, 57227.25177779167, 57227.25177779171, 258.3940925276937],
  };
  for (const [i, [x, dd, L, tweb, abe, abc, ab, kn]] of Object.entries(sheet)) {
    const r = rows[i];
    assert.deepEqual([r.x, r.d, r.L, r.tweb, r.abe, r.abc, r.ab], [x, dd, L, tweb, abe, abc, ab], `row ${i}`);
    near(r.kn, kn, 1e-15, `row ${i} Kn`);
  }
});

test('Pressure: the constants', () => {
  const c = pressureConstants(exampleMotor());
  assert.equal(c.R, 195.99245638849598); // C11
  assert.equal(c.To, 1624.5); // C15
  // C17: Excel's power function and JavaScript's round this one a bit apart (the last of 17 digits).
  near(c.cstar, 888.9650104674788, 2e-16, 'C17 c*');
});

test('JSRM\'s lines give SRM_2023\'s results (to about a millionth: the nozzle exit Mach number is solved, not given)', () => {
  const s = jsrm.summary;
  near(s.maxPressure, 6.303726906736819, 1e-14, 'Pmax');
  near(s.maxThrust, 1968.115597095487, 1e-6, 'Fmax');
  near(s.totalImpulse, 3501.5342970019656, 1e-6, 'It');
  near(s.isp, 126.96450111789696, 1e-6, 'Isp');
  near(s.thrustTime, 2.0252513904182514, 1e-4, 't thrust');
  assert.equal(s.grainMass, 2.8124459515941598);
  assert.equal(s.motorClass, 'L');
  assert.equal(jsrm.nozzle.exitDiameter, 47.49634688104465); // Performance C11
});

test('Performance: the cells that follow from the lines', () => {
  const m = exampleMotor();
  const d = hollowData(m);
  const k = knTable(m, d.rows, d.abmax, d.web);
  const p = performance(m, jsrm, k);
  near(p.burnTime, 1.9422241569225847, 1e-12, 't burn');
  near(p.exitArea, 1771.78204711962, 1e-14, 'Ae');
  near(p.optimalAtPmax, 9.701250424869713, 1e-12, 'Ae/At opt at Pmax');
  near(p.cfMax, 1.3874894092551016, 1e-6, 'CF max');
  near(p.webFraction, 0.7160821073564986, 1e-6, 'web fraction');
  near(p.averageThrust, 1728.9381029773467, 1e-4, 'F avg');
  near(p.maxPressurePsi, 914.2461068508802, 1e-14, 'Pmax psi');
});

test('Nozzle Design: the lengths', () => {
  const n = nozzleDesign(exampleMotor(), 16.7924944805876, 47.49634688104465);
  near(n.lconv, 41.56446649248973, 1e-14, 'Lc');
  near(n.ldiv, 72.22513424008629, 1e-14, 'Ld');
  near(n.overall, 113.78960073257602, 1e-14, 'Lo');
});

test('Output: the summary and the 23-point thrust-time table', () => {
  const o = output(jsrm);
  assert.equal(o.rows.length, 23);
  assert.equal(o.designation, 'L1729');
  // SRM_2023's table (Output C24:D46), against JSRM's lines.
  const sheet = [[0, 0], [0.1321673972188799, 1401.9066201734465], [0.13479998096386012, 1405.8775988048385], [0.23909601841983627, 1561.4628031491618],
    [0.33958711800376656, 1712.7859814408434], [0.43481499743339447, 1848.2422733135593], [0.5285573215551294, 1883.941320269309]];
  sheet.forEach(([t, f], i) => {
    near(o.rows[i].t, t, 1e-5, `point ${i + 1} time`);
    near(o.rows[i].thrust, f, 1e-5, `point ${i + 1} thrust`);
  });
  near(o.step, 0.0956854419608444, 1e-4, 'time step');
  assert.equal(o.rows[22].thrust, 0);
});

test('The motor file: OpenRocket reads it, with the designed impulse', () => {
  const eng = engFile(jsrm, { name: '', diameter: 83, length: 560, delays: 'P', hardwareMass: 1.9, manufacturer: 'Rocket Team' },
    { title: 'Example Rocket Motor (L-Class)', propellantName: 'KNDX', grainLabel: 'Hollow cylinder (BATES)' });
  assert.equal(eng.filename, 'L1729.eng');
  const { motors } = readMotorFile(eng.filename, Object.assign(new TextEncoder().encode(eng.text), { toString: () => eng.text }));
  assert.equal(motors.length, 1);
  const [mm] = motors;
  assert.equal(mm.designation, 'L1729');
  assert.equal(mm.manufacturer, 'Rocket-Team');
  assert.equal(mm.diameterMm, 83);
  assert.equal(mm.impulseClass, 'L');
  near(mm.impulseNs, 3501.5342970019656, 0.003, 'impulse in the file');
  assert.ok(eng.points.length > 20 && eng.points.length < 200, `${eng.points.length} points`);
  assert.match(eng.text, /^L1729 83 560 P 2\.81245 4\.71245 Rocket-Team$/m);
  assert.throws(() => engFile(jsrm, { diameter: 83, length: 560, delays: 'P', hardwareMass: null }), /hardware/);
});

// The area of a grain's cross-section as the page draws it (grainHoles), counted on a fine grid.
function drawnArea(g, n = 1500) {
  const R = g.outerDiameter / 2;
  const holes = grainHoles(g);
  const inPolygon = (x, y, pts) => {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, yi] = pts[i];
      const [xj, yj] = pts[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
  let count = 0;
  for (let i = 0; i < n; i++) {
    const y = ((i + 0.5) / n) * 2 * R - R;
    for (let k = 0; k < n; k++) {
      const x = ((k + 0.5) / n) * 2 * R - R;
      if (x * x + y * y > R * R) continue;
      if (holes.some((h) => (h.circle ? (x - h.circle[0]) ** 2 + (y - h.circle[1]) ** 2 <= h.circle[2] ** 2 : inPolygon(x, y, h.polygon)))) continue;
      count++;
    }
  }
  return count * ((2 * R) / n) ** 2;
}

test('the grain drawings are JSRM\'s shapes: what they show has the cross-section JSRM works out', () => {
  // JSRM's cross-section at the start, in Java (orcloud.bridge.MotorLab areas: endSurface[0]). Read
  // otherwise (the C-slot's core at the grain's centre, its slot from the offset outward, as the page
  // once drew it), the first C-slot would show 0.7% more propellant.
  const cases = [
    [{ type: 'cSlot', outerDiameter: 69, coreDiameter: 20, slotWidth: 7, slotDepth: 34, slotOffset: 20 }, 3302.034927618202],
    [{ type: 'cSlot', outerDiameter: 69, coreDiameter: 0, slotWidth: 7, slotDepth: 34, slotOffset: 20 }, 3547.710497522063],
    [grainDefaults('cSlot'), 3102.2974985236774],
    [{ type: 'finocyl', outerDiameter: 69, innerDiameter: 20, finWidth: 5, finDiameter: 40, finCount: 5 }, 3173.408803724927],
    [{ type: 'moonBurner', outerDiameter: 69, coreDiameter: 20, coreOffset: 14 }, 3426.006274450336],
    [{ type: 'star', outerDiameter: 69, innerDiameter: 20, pointDiameter: 40, pointCount: 6 }, 3140.233652671712],
  ];
  for (const [g, jsrm] of cases) {
    const area = drawnArea(g);
    assert.ok(Math.abs(area / jsrm - 1) < 0.002, `${g.type} ${JSON.stringify(g)}: drawn ${area.toFixed(1)} mm², JSRM ${jsrm.toFixed(1)} mm²`);
  }
  // The C-slot default is METEOR's own example (a 30 mm grain: core 10, slot 5 wide and 15 deep, offset 7), scaled.
  assert.deepEqual(grainDefaults('cSlot'), { type: 'cSlot', outerDiameter: 69, coreDiameter: 23, slotWidth: 11.5, slotDepth: 34.5, slotOffset: 16, segmentLength: 115, segments: 4, ends: 'exposed' });
});

test('engMissing: the motor file\'s details SRM does not work out, as engFile asks for them', () => {
  assert.deepEqual(engMissing({}), ['diameter', 'length', 'hardwareMass']);
  assert.deepEqual(engMissing({ diameter: 83, length: 560, hardwareMass: '' }), ['hardwareMass']);
  assert.deepEqual(engMissing({ diameter: 83, length: 0, hardwareMass: 0 }), ['length'], 'an empty mass of 0 is allowed');
  assert.deepEqual(engMissing({ diameter: 83, length: 560, hardwareMass: 1.9 }), []);
  assert.throws(() => engFile(jsrm, { diameter: 83, length: null, delays: 'P', hardwareMass: 1.9 }), /length/);
});

test('cellNumber: numbers and Excel formulas as typed, and never a guess', () => {
  const cases = [
    ['69', 69], [' 69.5 ', 69.5], ['-5', -5], ['1e3', 1000],
    // A decimal comma, and thousands, as typed around the world; 1,200 could be either.
    ['1,5', 1.5], ['0,85', 0.85], ['12,345.6', 12345.6], ['1,234,567', 1234567], ['1,200', NaN], ['1,2,3', NaN],
    // Formulas, as Excel works them out (SRM's hint: =25.4*number for inches).
    ['=25.4*2.75', 69.85], ['=(1+2)^2', 9], ['=2^3^2', 64], ['=-2^2', 4], ['=2*3^2', 18], ['=2^-1', 0.5], ['=1e3/2', 500],
    ['=1/0', Infinity], ['=25,4*2', NaN], ['=(1+2', NaN], ['=1+', NaN], ['abc', NaN], ['', NaN], ['1.2.3', NaN],
  ];
  for (const [text, want] of cases) assert.ok(Object.is(cellNumber(text), want) || Math.abs(cellNumber(text) - want) < 1e-12, `${text} -> ${cellNumber(text)}`);
});

test('grain counts: METEOR\'s limits for fins (10) and star points (9)', () => {
  const most = (type, key) => GRAIN_FIELDS[type].find(([k]) => k === key)[4];
  assert.equal(most('finocyl', 'finCount'), 10);
  assert.equal(most('star', 'pointCount'), 9);
});
