// The flight logbook's data (src/logbook/data.js): the fixed format and its parser, imports from
// OpenRocket's stored simulations and Launch Planner plans, and the graphs' series.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  datasetFromPlan, datasetFromSimulation, formatInstructions, graphGroups, OR_DEFAULTS, parseRows, simulationsFromXml,
  sparkline, summarize, templateCsv, thin, ticks,
} from '../src/logbook/data.js';
import { importOrk } from '../src/lib/ork.js';
import { readZip } from '../src/lib/zip.js';
import { toXml } from '../../server/src/model.js';

const ALT_VEL = { time: 's', columns: [{ q: 'altitude', unit: 'm' }, { q: 'velocity', unit: 'm/s' }] };

test('the instructions name every column in order, and the template parses', () => {
  const ds = { time: 's', columns: [{ q: 'altitude', unit: 'ft' }, { q: 'custom', unit: 'hPa', name: 'Pressure' }] };
  const f = formatInstructions(ds);
  assert.deepEqual(f.columns, ['Column 1: Time (s)', 'Column 2: Altitude (ft)', 'Column 3: Pressure (hPa)']);
  assert.equal(f.header, 'Time (s),Altitude (ft),Pressure (hPa)');
  const parsed = parseRows(templateCsv(ds), ds);
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.rows.length, 3);
  assert.deepEqual(parsed.header, ['Time (s)', 'Altitude (ft)', 'Pressure (hPa)']);
});

test('good data: commas, spaces, a header, blank and # lines, exponents', () => {
  const text = '# my altimeter\ntime,alt,vel\n\n0, 0, 0\n0.1,1.5e1,  20\n0.2 ,30,-1.5\n';
  const { rows, errors, header } = parseRows(text, ALT_VEL);
  assert.deepEqual(errors, []);
  assert.deepEqual(header, ['time', 'alt', 'vel']);
  assert.deepEqual(rows, [[0, 0, 0], [0.1, 15, 20], [0.2, 30, -1.5]]);
});

test('mistakes are reported by line, with what was expected', () => {
  const cases = [
    ['0,0\n1,2,3\n', /Line 1: 2 values, but each row needs 3 \(Time \(s\), Altitude \(m\), Velocity \(m\/s\)\)/],
    ['0,0,0\n1,2,3,4\n', /Line 2: 4 values/],
    ['0;0;0\n1;2;3\n', /Line 1: separate the values with commas/],
    ['0\t0\t0\n', /separate the values with commas/],
    ['0,0,0\n1,2,abc\n', /Line 2: "abc" in column 3 \(Velocity \(m\/s\)\) is not a number/],
    ['0,0,0\n1,,3\n', /Line 2: value 2 \(Altitude \(m\)\) is empty/],
    ['0,0,0\n2,1,1\n1,2,2\n', /Line 3: the time 1 is earlier than the row before/],
    ['time,alt\n0,0,0\n', /Line 1 looks like column names, but it has 2 of them and the data needs 3/],
    ['0,0,0\n', /at least two rows/],
    ['', /at least two rows/],
  ];
  for (const [text, want] of cases) {
    const r = parseRows(text, ALT_VEL);
    assert.equal(r.rows.length, 0, text);
    assert.match(r.errors.join('\n'), want, text);
  }
  // Decimal commas are caught as too many values.
  assert.match(parseRows('0,0,0\n0,5,12,3,4\n', ALT_VEL).errors[0], /Line 2: 5 values/);
});

test('at most ten mistakes are listed', () => {
  const text = Array.from({ length: 30 }, (_, i) => `${i},x,1`).join('\n');
  assert.equal(parseRows(text, ALT_VEL).errors.length, 10);
});

test('summaries: the largest value of each column and when, in seconds', () => {
  const ds = { ...ALT_VEL, time: 'ms', rows: [[0, 0, 0], [500, 40, 60], [1000, 90, 10], [1500, 80, -20]] };
  const s = summarize(ds);
  assert.equal(s.rows, 4);
  assert.deepEqual(s.span, [0, 1.5]);
  assert.deepEqual([s.columns[0].max, s.columns[0].at], [90, 1]);
  assert.deepEqual([s.columns[1].max, s.columns[1].at, s.columns[1].min], [60, 0.5, -20]);
});

test('graphs: one per quantity, units converted, time offsets and ms applied', () => {
  const a = { id: 'a', name: 'Altimeter', time: 'ms', offset: -1, columns: [{ q: 'altitude', unit: 'ft' }, { q: 'custom', unit: 'hPa', name: 'Pressure' }], rows: [[1000, 0, 1013], [2000, 328.084, 990]] };
  const b = { id: 'b', name: 'Sim', time: 's', offset: 0, columns: [{ q: 'altitude', unit: 'm', name: 'Altitude' }, { q: 'velocity', unit: 'm/s', name: 'Vertical velocity' }], rows: [[0, 0, 0], [1, 100, 50]] };
  const metric = graphGroups([a, b], 'metric');
  assert.deepEqual(metric.map((g) => [g.title, g.unit, g.series.length]), [['Altitude', 'm', 2], ['Velocity', 'm/s', 1], ['Pressure', 'hPa', 1]]);
  const alt = metric[0].series[0].points;
  assert.deepEqual(alt[0], [0, 0]);
  assert.equal(alt[1][0], 1);
  assert.ok(Math.abs(alt[1][1] - 100) < 1e-3, 'feet to metres');
  assert.equal(metric[1].series[0].label, 'Sim · Vertical velocity');
  const imperial = graphGroups([b], 'imperial');
  assert.equal(imperial[0].unit, 'ft');
  assert.ok(Math.abs(imperial[0].series[0].points[1][1] - 328.084) < 0.001);
  assert.equal(graphGroups([{ ...b, hidden: true }]).length, 0, 'hidden data sets are left out');
});

test('axis ticks are round numbers covering the range', () => {
  assert.deepEqual(ticks(0, 97).values, [0, 20, 40, 60, 80, 100]);
  assert.deepEqual(ticks(-3.2, 14.9).values, [-5, 0, 5, 10, 15]);
  const t = ticks(0.001, 0.0047);
  assert.ok(t.values[0] <= 0.001 && t.values.at(-1) >= 0.0047);
});

test('thinning keeps peaks and order', () => {
  const rows = Array.from({ length: 20000 }, (_, i) => [i / 100, i === 12345 ? 999 : Math.sin(i / 300)]);
  const out = thin(rows, 2000);
  assert.ok(out.length <= 2002, `${out.length} rows`);
  assert.ok(out.some((r) => r[1] === 999), 'the spike survives');
  for (let i = 1; i < out.length; i++) assert.ok(out[i][0] >= out[i - 1][0]);
});

test('OpenRocket: a design\'s stored simulations become data sets', async () => {
  const jar = new Uint8Array(readFileSync(join(import.meta.dirname, '..', 'public', 'or', 'OpenRocket-web.jar')));
  const entry = (await readZip(jar)).find((e) => e.name === 'datafiles/examples/A simple model rocket.ork');
  const sims = simulationsFromXml(toXml(await importOrk(entry.data)));
  assert.ok(sims.length >= 2);
  const sim = sims.find((s) => s.branches.length);
  assert.ok(sim.summary.maxaltitude > 10);
  const branch = sim.branches[0];
  for (const t of OR_DEFAULTS) assert.ok(branch.types.includes(t), t);
  const ds = datasetFromSimulation({ design: { id: 'd1', name: 'A simple model rocket' }, simulation: sim, branch, types: [...OR_DEFAULTS, 'Thrust'] });
  assert.equal(ds.source, 'openrocket');
  assert.deepEqual(ds.columns.map((c) => [c.q, c.unit]), [['altitude', 'm'], ['velocity', 'm/s'], ['acceleration', 'm/s²'], ['custom', 'N']]);
  const s = summarize(ds);
  assert.ok(Math.abs(s.columns[0].max - sim.summary.maxaltitude) < 0.5, `apogee ${s.columns[0].max} vs ${sim.summary.maxaltitude}`);
  assert.ok(Math.abs(s.columns[0].at - sim.summary.timetoapogee) < 0.2);
  assert.ok(ds.rows.every((r) => r.length === 5 && r.every(Number.isFinite)));
  assert.equal(sparkline([{ ...ds, id: 'x' }]).length, 48);
});

test('Launch Planner: a plan\'s nominal flight, and where and when it flies', () => {
  const study = {
    design: { id: 'd1', name: 'Alpha' }, when: '2026-03-07T06:30:00.000Z', site: { lat: 37.123456, lon: 127.654321 },
    nominal: { path: [[0, 0, 0, 0], [1, 3, 4, 50], [2, 6, 8, 80], [3, null, 0, 0]] },
  };
  const { dataset, details, note } = datasetFromPlan({ id: 'p1', name: 'Club day', summary: 'Lands 420 m NE' }, study);
  assert.deepEqual(dataset.rows, [[0, 0, 0], [1, 50, 5], [2, 80, 10]]);
  assert.deepEqual(dataset.columns.map((c) => c.q), ['altitude', 'custom']);
  assert.equal(details.location, '37.12346, 127.65432');
  assert.match(details.date, /^2026-03-0[67]$/);
  assert.equal(details.rocket, 'Alpha');
  assert.match(note, /Lands 420 m NE/);
  assert.throws(() => datasetFromPlan({ name: 'x' }, { nominal: { path: [] } }), /no flight path/);
});
