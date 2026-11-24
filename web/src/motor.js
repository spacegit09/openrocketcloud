// The motor designer: a solid rocket motor worked out with Richard Nakka's SRM method, laid out as
// his SRM_2023 spreadsheet lays it out (its Data and Kn, Pressure, Performance, Nozzle Design,
// Output and Propellant data worksheets). The calculation is JSRM's, the Java version of SRM that
// METEOR runs (src/motor/calc.js); the worksheets' own cells are worked out as SRM does
// (src/motor/srm.js). Motors are saved (motorDesigns function), downloaded as .eng files, and added
// to the person's custom motors, which OpenRocket's motor selector lists in every design.
import './style.css';
import './motor/motor.css';
import { api, currentUser } from './base44.js';
import { $, h, icon, avatar, timeAgo, toast, modal, confirmDialog, promptDialog } from './common.js';
import { requirePlan } from './plan.js';
import { saveFile } from './lib/ork.js';
import { readMotorFile } from '../../server/src/motors.js';
import { grainAreas, simulate, startCalculator } from './motor/calc.js';
import {
  GRAIN_FIELDS, GRAINS, PROPELLANTS, TARGETS, engFile, exampleMotor, grainDefaults, grainLength, grainOuterDiameter, hollowData,
  knTable, nozzleDesign, output, performance, propellant, shapeRows,
} from './motor/srm.js';
import { curveSvg, xyChart } from './motor/chart.js';

for (const el of document.querySelectorAll('[data-icon]')) el.replaceWith(icon(el.dataset.icon));

const params = new URLSearchParams(location.search);
let me = null;
let record = null; // the saved motor (MotorDesign record) on show, or null
let model = null; // the worksheets' inputs (srm.js exampleMotor() has their shape)
let calc = null; // the latest results: { m, data, kn, result, perf, out, noz }
let problem = null; // why the latest calculation failed, or null
let sheet = 'data';
let dirty = false;

const SHEETS = [
  ['data', 'Data and Kn'],
  ['pressure', 'Pressure'],
  ['performance', 'Performance'],
  ['nozzle', 'Nozzle Design'],
  ['output', 'Output'],
  ['propellants', 'Propellant data'],
];

// ------------------------------------------------------------------ numbers in cells

/**
 * A cell's number: as typed, or, as in SRM, a formula after "=" (for instance =25.4*2.75 for 2.75
 * inches in millimetres): numbers, + − × ÷ ^ and brackets.
 */
export function cellNumber(text) {
  const s = String(text ?? '').trim().replace(/,/g, '');
  if (!s) return NaN;
  if (!s.startsWith('=')) return Number(s);
  const tokens = s.slice(1).match(/\d*\.?\d+(?:e[+-]?\d+)?|[-+*/^()]|\S/gi) ?? [];
  let i = 0;
  const peek = () => tokens[i];
  const take = () => tokens[i++];
  const expr = () => {
    let v = term();
    while (peek() === '+' || peek() === '-') v = take() === '+' ? v + term() : v - term();
    return v;
  };
  const term = () => {
    let v = power();
    while (peek() === '*' || peek() === '/') v = take() === '*' ? v * power() : v / power();
    return v;
  };
  const power = () => {
    const base = unary();
    return peek() === '^' ? (take(), base ** power()) : base;
  };
  const unary = () => {
    if (peek() === '-') return take(), -unary();
    if (peek() === '+') return take(), unary();
    if (peek() === '(') {
      take();
      const v = expr();
      return take() === ')' ? v : NaN;
    }
    const t = take();
    return t != null && /^\d*\.?\d+(e[+-]?\d+)?$/i.test(t) ? Number(t) : NaN;
  };
  const v = expr();
  return i === tokens.length ? v : NaN;
}

const fmt = (v, digits) => (Number.isFinite(v) ? v.toLocaleString('en', { minimumFractionDigits: digits, maximumFractionDigits: digits, useGrouping: false }) : '–');

// ------------------------------------------------------------------ the model

const get = (path) => path.split('.').reduce((o, k) => o?.[k], model);
function set(path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  keys.reduce((o, k) => o[k], model)[last] = value;
}

function markDirty() {
  dirty = true;
  $('#save').classList.add('unsaved');
}

/** The checks SRM's cells leave to the person, before the calculation: every value a number in range. */
function check(m) {
  const pos = (v, what) => {
    if (!(Number.isFinite(v) && v > 0)) throw new Error(`Enter ${what} (more than 0).`);
  };
  pos(m.chamber.diameter, 'the chamber diameter');
  pos(m.chamber.length, 'the chamber length');
  for (const [key, , desc, kind] of GRAIN_FIELDS[m.grain.type]) {
    const v = m.grain[key];
    const zeroOk = ['holeDiameter', 'holeDepth', 'slotOffset', 'coreOffset'].includes(key);
    if (!Number.isFinite(v) || v < 0 || (!zeroOk && v === 0)) throw new Error(`Enter the ${desc.toLowerCase()}.`);
    if (kind === 'count' && (v !== Math.round(v) || v > 100)) throw new Error(`The ${desc.toLowerCase()} must be a whole number.`);
  }
  if (m.throat.mode !== 'target') pos(m.throat.diameter, 'the throat diameter');
  const s = m.settings;
  if (!(s.densityRatio > 0 && s.densityRatio <= 1)) throw new Error('The density ratio is between 0 and 1.');
  if (!(s.combustionEfficiency > 0 && s.combustionEfficiency <= 1)) throw new Error('The combustion efficiency is between 0 and 1.');
  if (!(s.nozzleEfficiency > 0 && s.nozzleEfficiency <= 1)) throw new Error('The nozzle efficiency is between 0 and 1.');
  if (!s.optimal && !(s.expansionRatio >= 1)) throw new Error('The nozzle expansion ratio (Ae/At) is at least 1.');
  pos(s.ambientPressure, 'the ambient pressure');
  if (!(s.nozzleErosion >= 0)) throw new Error('The nozzle erosion is 0 or more.');
  if (!(s.erosiveThreshold >= 0) || !(s.erosiveCoefficient >= 0)) throw new Error('The erosive burning values are 0 or more.');
  if (!(s.convergence > 0 && s.convergence < 90) || !(s.divergence > 0 && s.divergence < 90)) throw new Error('The nozzle half-angles are between 0 and 90 degrees.');
}

/** The motor as MotorLab takes it (orcloud.bridge.MotorLab), with the throat worked out. */
function javaMotor(m, throat) {
  const s = m.settings;
  return {
    propellant: m.propellant,
    chamber: { diameter: m.chamber.diameter, length: m.chamber.length },
    throat,
    grain: m.grain,
    settings: {
      densityRatio: s.densityRatio, nozzleErosion: s.nozzleErosion, combustionEfficiency: s.combustionEfficiency,
      ambientPressure: s.ambientPressure, erosiveThreshold: s.erosiveThreshold, erosiveCoefficient: s.erosiveCoefficient,
      nozzleEfficiency: s.nozzleEfficiency, expansionRatio: s.optimal ? null : s.expansionRatio,
    },
  };
}

const areaCache = new Map();
function areasOf(grain) {
  const key = JSON.stringify(grain);
  if (!areaCache.has(key)) {
    const p = grainAreas(grain);
    p.catch(() => areaCache.delete(key));
    areaCache.set(key, p);
  }
  return areaCache.get(key);
}

/** Data and Kn's figures for a grain of any shape, from JSRM's areas (hollowData does the hollow cylinder). */
function shapeData(m, areas) {
  const p = propellant(m.propellant);
  const vc = Math.PI / 4 * m.chamber.diameter ** 2 * m.chamber.length;
  const vg = areas.volume[0];
  const density = m.settings.densityRatio * p.density;
  return {
    vc, lgo: grainLength(m.grain), vg, vl: vg / vc, idealDensity: p.density, density,
    mgrain: density * vg / 1000 / 1000, abo: areas.burningArea[0], endArea: areas.endSurface[0],
  };
}

// ------------------------------------------------------------------ the calculation

let generation = 0;
let started = false;
let timer = null;

function recalcSoon() {
  clearTimeout(timer);
  timer = setTimeout(recalc, 350);
}

// One calculation at a time: a star or finocyl grain takes seconds, and changes made meanwhile are
// worked out together once it is done, not one after another.
let calculating = false;
let again = false;
// The calculator keeps the last four grains it has worked out (MotorLab), so only a new grain is
// slow; a change to the nozzle, propellant, chamber or settings is not. These are their JSON.
let keptGrains = [];

async function recalc() {
  if (calculating) {
    again = true;
    return;
  }
  calculating = true;
  try {
    await calculate();
  } finally {
    calculating = false;
    if (again) {
      again = false;
      recalc();
    }
  }
}

async function calculate() {
  const mine = ++generation;
  const m = structuredClone(model);
  const grainKey = JSON.stringify(m.grain);
  const slow = ['finocyl', 'star'].includes(m.grain.type) && !keptGrains.includes(grainKey) ? ' (a new grain of this shape can take 10 seconds or more)' : '';
  status(started ? `Calculating…${slow}` : 'Starting the calculator (the first time takes a few seconds)…', 'busy');
  try {
    check(m);
    let data;
    let rows;
    let abmax;
    let web;
    if (m.grain.type === 'hollow') {
      data = hollowData(m);
      if (!Number.isFinite(data.xinc)) throw new Error('Leave the core or the outer surface exposed: with both inhibited, the grain can only burn from its ends, which SRM does not model.');
      rows = data.rows;
      abmax = data.abmax;
      web = data.web;
    } else {
      const areas = await areasOf(m.grain);
      data = shapeData(m, areas);
      rows = shapeRows(areas);
      abmax = Math.max(...areas.burningArea);
      web = 1;
    }
    const kn = knTable(m, rows, abmax, web);
    if (!(kn.dto > 0)) throw new Error('The grain has no burning area.');
    const result = await simulate(javaMotor(m, kn.dto));
    keptGrains = [grainKey, ...keptGrains.filter((k) => k !== grainKey)].slice(0, 4);
    started = true;
    if (mine !== generation) return;
    calc = {
      m, data, kn, result,
      perf: performance(m, result, kn),
      out: output(result),
      noz: nozzleDesign(m, kn.dto, result.nozzle.exitDiameter),
    };
    problem = null;
    status(`${calc.out.designation} · ${fmt(calc.out.totalImpulse, 1)} N·s · Isp ${fmt(calc.out.isp, 1)} s`, 'ok');
  } catch (e) {
    started = true;
    if (mine !== generation) return;
    calc = null;
    problem = e.message;
    status('Not calculated: see the worksheet.', 'error');
  }
  fill();
}

function status(text, kind) {
  const el = $('#status');
  el.textContent = text;
  el.dataset.kind = kind;
}

// ------------------------------------------------------------------ cells

/** An input cell (blue, as SRM's), bound to `path` in the model. */
function numCell(path, { digits = null, onChange = null, recalc: again = true } = {}) {
  const v = get(path);
  const input = h('input', { class: 'wb-in', type: 'text', inputmode: 'decimal', value: v == null || Number.isNaN(v) ? '' : digits == null ? String(v) : fmt(v, digits), 'aria-label': path });
  input.addEventListener('input', () => {
    const n = cellNumber(input.value);
    input.classList.toggle('bad', input.value.trim() !== '' && !Number.isFinite(n));
    set(path, input.value.trim() === '' ? null : n);
    markDirty();
    onChange?.();
    if (again) recalcSoon();
    else fill();
  });
  // A formula shows its result once left, as in a spreadsheet.
  input.addEventListener('change', () => {
    if (input.value.trim().startsWith('=') && Number.isFinite(get(path))) input.value = String(get(path));
  });
  return input;
}

/** A drop-down cell (SRM's are shaded, with "select" beside them). */
function selectCell(path, options, { onChange = null } = {}) {
  const sel = h('select', { class: 'wb-sel', 'aria-label': path }, ...options.map(([value, label]) => h('option', { value, selected: get(path) === value }, label)));
  sel.onchange = () => {
    set(path, sel.value);
    markDirty();
    onChange?.();
    recalcSoon();
  };
  return sel;
}

/** A worked-out cell, filled after each calculation from `value(calc)`. */
function out(value, digits, { cls = '', unitFor = null } = {}) {
  const el = h('span', { class: `wb-out ${cls}` });
  outputs.push(() => {
    let v = null;
    try {
      v = calc ? value(calc) : null;
    } catch {
      v = null;
    }
    if (typeof v === 'string') {
      el.textContent = v;
      el.removeAttribute('title');
    } else {
      el.textContent = fmt(v, digits);
      if (Number.isFinite(v)) el.title = String(v); // the full number, as the spreadsheet keeps it
      else el.removeAttribute('title');
    }
    if (unitFor) el.dataset.unit = unitFor(v);
  });
  return el;
}

let outputs = [];
let regions = [];

/** A part of the sheet drawn again after each calculation (charts, tables). */
function region(draw, cls = '') {
  const el = h('div', { class: `wb-region ${cls}` });
  regions.push(() => {
    try {
      el.replaceChildren(...[].concat(calc ? draw(calc) ?? [] : []));
    } catch {
      el.replaceChildren();
    }
  });
  return el;
}

/** A row of a worksheet: symbol, cell, unit, description. */
const row = (sym, cell, unit = '', desc = '', cls = '') => h('div', { class: `wb-row ${cls}` },
  h('span', { class: 'wb-sym', html: sym }), h('span', { class: 'wb-cell' }, cell), h('span', { class: 'wb-unit', html: unit }), h('span', { class: 'wb-desc' }, desc));
const section = (text) => h('div', { class: 'wb-section' }, text);
const hint = (text) => h('span', { class: 'wb-hint' }, text);
const box = (title, ...rows) => h('div', { class: 'wb-box' }, title ? h('div', { class: 'wb-box-title' }, title) : null, ...rows);
const boxRow = (label, cell, unit = '') => h('div', { class: 'wb-box-row' }, h('span', { html: label }), cell, h('span', { html: unit }));

function fill() {
  for (const f of outputs) f();
  for (const f of regions) f();
  const err = $('#wb-error');
  if (err) {
    err.hidden = !problem;
    err.textContent = problem ? `Error: ${problem}` : '';
  }
}

// ------------------------------------------------------------------ the worksheets

function renderSheet() {
  outputs = [];
  regions = [];
  const draw = {
    data: dataSheet, pressure: pressureSheet, performance: performanceSheet, nozzle: nozzleSheet, output: outputSheet, propellants: propellantSheet,
  }[sheet];
  $('#sheet').replaceChildren(h('div', { class: 'wb-paper' }, h('div', { class: 'wb-error', id: 'wb-error', hidden: true }), ...draw(),
    h('p', { class: 'wb-credit' }, 'Calculation: JSRM 3.3, the Java version of Richard Nakka’s SRM_2023 that METEOR runs. Predictions, not guarantees: test a motor statically before flying it.')));
  for (const b of $('#tabs').querySelectorAll('button')) b.classList.toggle('active', b.dataset.sheet === sheet);
  fill();
}

function renderTabs() {
  $('#tabs').replaceChildren(...SHEETS.map(([key, label]) => {
    const b = h('button', { type: 'button', 'data-sheet': key }, label);
    b.onclick = () => {
      sheet = key;
      renderSheet();
      $('#sheet').scrollTop = 0;
    };
    return b;
  }));
}

const SURFACES = [['inhibited', 'Inhibited'], ['exposed', 'Exposed']];

function dataSheet() {
  const g = model.grain;
  const hollow = g.type === 'hollow';
  const title = h('input', { class: 'wb-title-in', type: 'text', value: model.title ?? '', maxlength: 200, 'aria-label': 'Title' });
  const subtitle = h('input', { class: 'wb-title-in', type: 'text', value: model.subtitle ?? '', maxlength: 200, 'aria-label': 'Second title line' });
  title.oninput = () => {
    model.title = title.value;
    markDirty();
  };
  subtitle.oninput = () => {
    model.subtitle = subtitle.value;
    markDirty();
  };
  const grainRows = GRAIN_FIELDS[g.type].map(([key, sym, desc, kind]) => row(sym, numCell(`grain.${key}`, { digits: kind === 'count' ? 0 : null }), kind === 'count' ? '' : 'mm', desc));
  const surfaces = hollow
    ? [row('Outer surface:', [selectCell('grain.outer', SURFACES), hint('select')]), row('Core surface:', [selectCell('grain.core', SURFACES), hint('select')]),
      row('Ends surface:', [selectCell('grain.ends', SURFACES), hint('select')])]
    : g.type === 'endBurner' ? [] : [row('Ends surface:', [selectCell('grain.ends', SURFACES), hint('select')])];
  const throat = model.throat.mode === 'target'
    ? [row('<b class="wb-label">Target MEOP:</b>', [selectCell('throat.target', TARGETS.map(([l]) => [l, l])), hint('select')], '', 'Maximum chamber pressure (target)'),
      row('<b class="wb-label">Kn max:</b>', out((c) => c.kn.knTarget, 0), '', 'Ratio of burning area / throat area (max)'),
      row('A<sub>to</sub>', out((c) => c.kn.at, 0), 'mm²', 'Throat cross-section area (initial)'),
      row('<b>D<sub>to</sub></b>', out((c) => c.kn.dto, 3, { cls: 'strong' }), 'mm', h('b', {}, 'Throat diameter (initial)'))]
    : [row('<b>D<sub>to</sub></b>', numCell('throat.diameter'), 'mm', h('b', {}, 'Throat diameter (initial)')),
      row('A<sub>to</sub>', out((c) => c.kn.at, 0), 'mm²', 'Throat cross-section area (initial)')];
  const throatMode = selectCell('throat.mode', [['target', 'From the target pressure (SRM)'], ['diameter', 'Throat diameter as given']], { onChange: renderSheet });
  const grainType = selectCell('grain.type', Object.entries(GRAINS).map(([k, v]) => [k, v.label]), {
    onChange: () => {
      model.grain = grainDefaults(model.grain.type, model.chamber.diameter);
      renderSheet();
    },
  });
  const left = [
    h('h3', { class: 'wb-heading' }, 'Basic Data and K', h('sub', {}, 'n'), ' Calculation'),
    row('<b class="wb-label">Title:</b>', h('div', { class: 'wb-title' }, title, subtitle)),
    h('div', { class: 'wb-tip' }, h('b', {}, 'Hint! '), 'To enter inches, type =25.4*', h('i', {}, 'number'), ' where ', h('i', {}, 'number'), ' is the dimension in inches.'),
    section('Motor chamber:'),
    row('D<sub>c</sub>', numCell('chamber.diameter'), 'mm', 'Chamber diameter (inside)'),
    row('L<sub>c</sub>', numCell('chamber.length'), 'mm', 'Chamber length (inside)'),
    row('V<sub>c</sub>', out((c) => c.data.vc, 0), 'mm³', 'Chamber volume (empty)'),
    section('Propellant grain:'),
    row('Propellant type', [selectCell('propellant', PROPELLANTS.map((p) => [p.name, p.name])), hint('select')], '', h('a', { href: '#', onclick: (e) => { e.preventDefault(); sheet = 'propellants'; renderSheet(); } }, 'See Propellant data')),
    row('Grain shape', [grainType, hint('select')], '', hollow ? 'SRM’s grain (BATES)' : 'METEOR’s grain (JSRM geometry, not part of SRM)'),
    ...grainRows,
    ...surfaces,
    row('L<sub>go</sub>', out((c) => c.data.lgo, 0), 'mm', 'Grain length (initial)'),
    row('V<sub>g</sub>', out((c) => c.data.vg, 0), 'mm³', 'Grain volume (initial)'),
    row('V<sub>l</sub>', out((c) => c.data.vl, 3), '', 'Volumetric loading fraction'),
    row('ρ′ <small>grain</small>', out((c) => c.data.idealDensity, 3), 'g/cm³', 'Grain ideal density'),
    row('', numCell('settings.densityRatio'), '', 'Density ratio (actual/ideal)'),
    row('ρ <small>grain</small>', out((c) => c.data.density, 3), 'g/cm³', 'Grain actual density'),
    row('m <small>grain</small>', out((c) => c.result.summary.grainMass, 3), 'kg.', 'Grain mass (initial)'),
    ...(hollow ? [
      row('A<sub>beo</sub>', out((c) => c.data.abeo, 0), 'mm²', 'End burning area (initial)'),
      row('A<sub>bco</sub>', out((c) => c.data.abco, 0), 'mm²', 'Core burning area (initial)'),
      row('A<sub>bso</sub>', out((c) => c.data.abso, 0), 'mm²', 'Outer surface burning area (initial)'),
    ] : []),
    row('A<sub>bo</sub>', out((c) => c.data.abo, 0), 'mm²', 'Total burning area (initial)'),
    section('Nozzle:'),
    row('Throat', [throatMode]),
    ...throat,
    row('e', numCell('settings.nozzleErosion'), 'mm', 'Nozzle erosion'),
    row('D<sub>tf</sub>', out((c) => c.kn.dtf, 2), 'mm', 'Throat diameter (final)'),
  ];
  const right = [
    // (Drawn from the results' own grain: a newly chosen shape shows once it is worked out.)
    region((c) => {
      const bates = c.m.grain.type === 'hollow';
      return xyChart({
        title: 'Kn vs web regression',
        x: bates ? { title: 'Web regression, x', unit: 'mm' } : { title: 'Web burnt', unit: '%' },
        y: { title: 'Kn', unit: '' },
        series: [{ label: 'Kn', color: 'var(--srm-series)', points: c.kn.rows.map((r) => [bates ? r.x : r.progress * 100, r.kn]) }],
      }, { yFrom0: false });
    }),
    region((c) => box(null, boxRow('K<sub>n max</sub>', h('b', {}, fmt(c.kn.knMax, 0))), boxRow('K<sub>n min</sub>', h('b', {}, fmt(c.kn.knMin, 0))), boxRow('K<sub>n avg</sub>', h('b', {}, fmt(c.kn.knAvg, 0)))), 'wb-results'),
    region(() => grainSvg(model.grain, model.chamber.diameter), 'wb-grain'),
  ];
  const table = h('details', { class: 'wb-table-wrap', open: true }, h('summary', {}, 'Kn table'),
    region((c) => (c.m.grain.type === 'hollow' ? knTableHollow(c) : knTableShape(c))));
  return [h('div', { class: 'wb-cols' }, h('div', { class: 'wb-left' }, ...left), h('div', { class: 'wb-right' }, ...right)), table];
}

function knTableHollow(c) {
  const head = ['Interval', 'x', 'd', 'D', 'L', 't<sub>web</sub>', 'A<sub>be</sub>', 'A<sub>bc</sub>', 'A<sub>bs</sub>', 'A<sub>b</sub> total', 'A<sub>t</sub>', 'K<sub>n</sub>'];
  const units = ['', 'mm', 'mm', 'mm', 'mm', 'mm', 'mm²', 'mm²', 'mm²', 'mm²', 'mm²', ''];
  return h('table', { class: 'wb-table' },
    h('thead', {}, h('tr', {}, ...head.map((x) => h('th', { html: x }))), h('tr', { class: 'units' }, ...units.map((x) => h('th', { html: x })))),
    h('tbody', {}, ...c.kn.rows.map((r) => h('tr', {}, h('td', {}, String(r.i)),
      ...[[r.x, 2], [r.d, 2], [r.D, 2], [r.L, 1], [r.tweb, 2], [r.abe, 0], [r.abc, 0], [r.abs, 0], [r.ab, 0], [r.at, 1], [r.kn, 1]]
        .map(([v, d]) => h('td', { title: String(v) }, fmt(v, d)))))));
}

function knTableShape(c) {
  return h('table', { class: 'wb-table' },
    h('thead', {}, h('tr', {}, ...['Interval', 'Web burnt', 'A<sub>b</sub>', 'A<sub>t</sub>', 'K<sub>n</sub>'].map((x) => h('th', { html: x }))),
      h('tr', { class: 'units' }, ...['', '%', 'mm²', 'mm²', ''].map((x) => h('th', { html: x })))),
    h('tbody', {}, ...c.kn.rows.map((r) => h('tr', {}, h('td', {}, String(r.i)),
      ...[[r.progress * 100, 0], [r.ab, 0], [r.at, 1], [r.kn, 1]].map(([v, d]) => h('td', { title: String(v) }, fmt(v, d)))))));
}

function pressureSheet() {
  const left = [
    h('h3', { class: 'wb-heading' }, 'Rocket Motor chamber pressure'),
    row('R′', out((c) => c.perf.runiv, 0), 'J/mol-K', 'Universal gas constant'),
    row('M', out((c) => c.perf.M, 2), 'kg/kmol', 'Effective molecular wt. of products'),
    row('R', out((c) => c.perf.R, 1), 'J/kg-K', 'Specific gas constant'),
    row('k', out((c) => c.perf.k, 4), '', 'Ratio of specific heats, mixture'),
    row('η<sub>c</sub>', numCell('settings.combustionEfficiency'), '', 'Combustion efficiency'),
    row('T<sub>o</sub>', out((c) => c.perf.T0, 0), 'K', 'Ideal combustion temperature'),
    row('T<sub>o act</sub>', out((c) => c.perf.To, 0), 'K', 'Actual chamber temperature'),
    row('P<sub>atm</sub>', numCell('settings.ambientPressure'), 'MPa', 'Ambient pressure'),
    row('c*', out((c) => c.perf.cstar, 0), 'm/s', 'Characteristic exhaust velocity'),
    row('G*', numCell('settings.erosiveThreshold'), '', 'Propellant erosive burning area ratio threshold'),
    row('k<sub>v</sub>', numCell('settings.erosiveCoefficient'), '', 'Propellant erosive burning velocity coefficient'),
  ];
  const right = [
    region((c) => xyChart({
      title: 'Chamber pressure vs time', x: { title: 'Time', unit: 's' }, y: { title: 'Chamber pressure', unit: 'MPa' },
      series: [{ label: 'Chamber pressure', color: 'var(--srm-series)', points: c.result.lines.t.map((t, i) => [t, c.result.lines.pressure[i]]) }],
    })),
    region((c) => box(null, boxRow('P<sub>max</sub> =', h('b', {}, fmt(c.result.summary.maxPressure, 2)), 'MPa'),
      boxRow('', h('b', {}, fmt(c.perf.maxPressurePsi, 0)), 'psi'),
      boxRow('t <sub>burn</sub> =', h('b', {}, fmt(c.perf.burnTime, 3)), 's.'),
      boxRow('t <sub>thrust</sub> =', h('b', {}, fmt(c.perf.thrustTime, 3)), 's.')), 'wb-results'),
  ];
  const table = h('details', { class: 'wb-table-wrap' }, h('summary', {}, 'Pressure table (each line of the calculation)'),
    region((c) => {
      const L = c.result.lines;
      const patm = c.m.settings.ambientPressure;
      return h('table', { class: 'wb-table' },
        h('thead', {}, h('tr', {}, ...['Line', 't', 'P<sub>o</sub>', 'P<sub>o</sub>', 'P<sub>o</sub>', 'K<sub>n</sub>', 'ṁ nozzle', 'm grain'].map((x) => h('th', { html: x }))),
          h('tr', { class: 'units' }, ...['', 's', 'MPa (abs)', 'MPa (gage)', 'psig', '', 'kg/s', 'kg'].map((x) => h('th', { html: x })))),
        h('tbody', {}, ...L.t.map((t, i) => h('tr', {}, h('td', {}, String(i)),
          ...[[t, 4], [L.pressure[i] + patm, 3], [L.pressure[i], 3], [L.pressure[i] / 0.006895, 0], [L.kn[i], 1], [L.massFlow[i], 4], [L.grainMass[i], 4]]
            .map(([v, d]) => h('td', { title: String(v) }, fmt(v, d)))))));
    }));
  return [h('div', { class: 'wb-cols' }, h('div', { class: 'wb-left' }, ...left), h('div', { class: 'wb-right' }, ...right)), table];
}

function performanceSheet() {
  const optimal = h('label', { class: 'wb-check' }, h('input', { type: 'checkbox', checked: !!model.settings.optimal }), 'Optimal (METEOR: the best ratio for this motor)');
  optimal.querySelector('input').onchange = (e) => {
    model.settings.optimal = e.target.checked;
    markDirty();
    renderSheet();
    recalcSoon();
  };
  const left = [
    h('h3', { class: 'wb-heading' }, 'Rocket Motor Performance'),
    row('k', out((c) => c.perf.k, 4), '', 'Ratio of specific heats, mixture'),
    row('η <small>noz</small>', numCell('settings.nozzleEfficiency'), '', 'Nozzle efficiency'),
    row('A<sub>e</sub>/A<sub>t</sub>', model.settings.optimal ? out((c) => c.result.nozzle.expansion, 2) : numCell('settings.expansionRatio'), '', 'Nozzle expansion ratio (initial)'),
    row('', optimal),
    row('P<sub>atm</sub>', out((c) => c.m.settings.ambientPressure, 3), 'MPa', 'Ambient pressure'),
    row('A<sub>to</sub>', out((c) => c.kn.at, 1), 'mm²', 'Throat cross-section area (initial)'),
    row('A<sub>e</sub>', out((c) => c.perf.exitArea, 1), 'mm²', 'Nozzle exit cross-section area'),
    row('M<sub>eo</sub>', out((c) => c.result.nozzle.machInitial, 3), '', 'Mach No. at nozzle exit (initial)'),
    row('M<sub>ef</sub>', out((c) => c.result.nozzle.machFinal, 3), '', 'Mach No. at nozzle exit (final)'),
    row('D<sub>e</sub>', out((c) => c.result.nozzle.exitDiameter, 2), 'mm', 'Nozzle exit diameter'),
    row('A<sub>e</sub>/A<sub>t</sub> <small>opt</small>', out((c) => c.perf.optimalAtPmax, 3), '', 'Optimum nozzle expansion ratio at P<sub>o max</sub>'.replace(/<[^>]+>/g, '')),
    row('A<sub>e</sub>/A<sub>t</sub> <small>opt</small>', out((c) => c.result.nozzle.optimalExpansion, 3), '', 'Avg. optimum nozzle expansion ratio'),
    row('w <small>f</small>', out((c) => c.perf.webFraction ?? '–', 3), '', 'Web fraction'),
    row('C<sub>F max</sub>', out((c) => c.perf.cfMax, 3), '', 'Thrust coefficient, maximum'),
    row('<b class="wb-red">F <small>max</small></b>', out((c) => c.result.summary.maxThrust, 0, { cls: 'red strong' }), '<b class="wb-red">N.</b>', 'Maximum thrust'),
    row('<b class="wb-red">I <small>t</small></b>', out((c) => c.result.summary.totalImpulse, 0, { cls: 'red strong' }), '<b class="wb-red">N-sec.</b>', 'Total impulse'),
    row('<b class="wb-red">I<small>sp</small></b>', out((c) => c.result.summary.isp, 1, { cls: 'red strong' }), '<b class="wb-red">sec.</b>', 'Specific impulse, delivered'),
    row('<b class="wb-red">Class:</b>', out((c) => c.result.summary.motorClass, 0, { cls: 'red strong' }), '', 'Motor classification'),
  ];
  const right = [
    region((c) => xyChart({
      title: 'Thrust vs time', x: { title: 'Time', unit: 's' }, y: { title: 'Thrust', unit: 'N' },
      series: [{ label: 'Thrust', color: 'var(--srm-series)', points: c.result.lines.t.map((t, i) => [t, c.result.lines.thrust[i]]) }],
    })),
    region((c) => box(null, boxRow('F <sub>max</sub> =', h('b', {}, fmt(c.result.summary.maxThrust, 0)), 'N.'),
      boxRow('F <sub>avg</sub> =', h('b', {}, fmt(c.perf.averageThrust, 0)), 'N.'),
      boxRow('t <sub>thrust</sub> =', h('b', {}, fmt(c.perf.thrustTime, 3)), 'sec.'),
      boxRow('', h('b', {}, fmt(c.result.summary.maxThrust / 4.4482, 0)), 'lbf max'),
      boxRow('', h('b', {}, fmt(c.perf.averageThrust / 4.4482, 0)), 'lbf avg')), 'wb-results'),
  ];
  const table = h('details', { class: 'wb-table-wrap' }, h('summary', {}, 'Performance table (each line of the calculation)'),
    region((c) => {
      const L = c.result.lines;
      const patm = c.m.settings.ambientPressure;
      let impulse = 0;
      return h('table', { class: 'wb-table' },
        h('thead', {}, h('tr', {}, ...['Line', 't', 'P<sub>o</sub>', 'F', 'F', 'I<sub>t</sub>'].map((x) => h('th', { html: x }))),
          h('tr', { class: 'units' }, ...['', 's', 'MPa (abs)', 'N', 'lbf', 'N-s'].map((x) => h('th', { html: x })))),
        h('tbody', {}, ...L.t.map((t, i) => {
          if (i > 0) impulse += (L.thrust[i] + L.thrust[i - 1]) / 2 * (t - L.t[i - 1]);
          return h('tr', {}, h('td', {}, String(i)),
            ...[[t, 4], [L.pressure[i] + patm, 3], [L.thrust[i], 1], [L.thrust[i] / 4.4482, 1], [impulse, 1]].map(([v, d]) => h('td', { title: String(v) }, fmt(v, d))));
        })));
    }));
  return [h('div', { class: 'wb-cols' }, h('div', { class: 'wb-left' }, ...left), h('div', { class: 'wb-right' }, ...right)), table];
}

function nozzleSheet() {
  const left = [
    h('h3', { class: 'wb-heading' }, 'Nozzle Design'),
    row('β', numCell('settings.convergence'), 'degrees', 'Nozzle convergence half-angle'),
    row('α', numCell('settings.divergence'), 'degrees', 'Nozzle divergence half-angle'),
    h('div', { class: 'wb-gap' }),
    row('D<sub>c</sub>', out((c) => c.m.chamber.diameter, 0), 'mm', 'Chamber inside diameter'),
    row('D<sub>t</sub>', out((c) => c.kn.dto, 2), 'mm', 'Nozzle throat diameter'),
    row('D<sub>e</sub>', out((c) => c.result.nozzle.exitDiameter, 2), 'mm', 'Nozzle exit diameter'),
    row('D<sub>e opt</sub>', out((c) => c.result.nozzle.optimalExitDiameter, 2), 'mm', 'Optimum nozzle exit diameter'),
    h('div', { class: 'wb-gap' }),
    row('<b>L<sub>c</sub></b>', out((c) => c.noz.lconv, 2, { cls: 'strong' }), 'mm', h('b', {}, 'Convergence length')),
    row('<b>L<sub>d</sub></b>', out((c) => c.noz.ldiv, 2, { cls: 'strong' }), 'mm', h('b', {}, 'Divergence length')),
    row('<b>L<sub>o</sub></b>', out((c) => c.noz.overall, 2, { cls: 'strong' }), 'mm', h('b', {}, 'Overall length')),
  ];
  const right = [region((c) => nozzleSvg(c), 'wb-nozzle')];
  return [h('div', { class: 'wb-cols' }, h('div', { class: 'wb-left' }, ...left), h('div', { class: 'wb-right' }, ...right))];
}

function outputSheet() {
  const e = model.eng;
  const engRows = [
    row('Name', h('input', { class: 'wb-in wide', type: 'text', value: e.name ?? '', maxlength: 40, placeholder: calc?.out.designation ?? '', oninput: (ev) => { e.name = ev.target.value; markDirty(); fill(); } }), '', 'Motor name in OpenRocket (no spaces); empty: its class and average thrust'),
    row('D', numCell('eng.diameter', { recalc: false }), 'mm', 'Motor diameter (outside of the casing), as OpenRocket fits it in a motor mount'),
    row('L', numCell('eng.length', { recalc: false }), 'mm', 'Motor length, from the forward closure to the nozzle exit'),
    row('m <small>empty</small>', numCell('eng.hardwareMass', { recalc: false }), 'kg.', 'Motor mass without propellant (casing, nozzle, closures, liner)'),
    row('Delays', h('input', { class: 'wb-in', type: 'text', value: e.delays ?? 'P', maxlength: 30, oninput: (ev) => { e.delays = ev.target.value; markDirty(); fill(); } }), '', 'Ejection delays in seconds (for example 4-6-8), or P for none'),
    row('Maker', h('input', { class: 'wb-in wide', type: 'text', value: e.manufacturer ?? 'Custom', maxlength: 40, oninput: (ev) => { e.manufacturer = ev.target.value; markDirty(); fill(); } }), '', 'Manufacturer, as OpenRocket groups motors (one word)'),
  ];
  const left = [
    h('h3', { class: 'wb-heading' }, 'Motor Output Data'),
    h('p', { class: 'wb-note' }, 'A summary of the motor’s performance, and its thrust curve for flight simulation.'),
    region((c) => h('table', { class: 'wb-summary' },
      h('tr', {}, h('td', { colspan: 3, class: 'wb-summary-title' }, c.m.title || model.title || '', h('br'), c.m.subtitle || '')),
      ...[['Grain mass', c.out.grainMass, 3, 'kg.'], ['', c.out.grainMassLb, 3, 'lb.'], ['Total impulse', c.out.totalImpulse, 1, 'N-sec.'], ['', c.out.totalImpulseLbs, 1, 'lb-sec.'],
        ['Average thrust', c.out.averageThrust, 1, 'N.'], ['', c.out.averageThrustLb, 1, 'lb.'], ['Thrust time', c.out.thrustTime, 3, 'sec.'], ['Specific Impulse', c.out.isp, 1, 'sec.']]
        .map(([l, v, d, u]) => h('tr', {}, h('td', {}, l), h('td', { class: 'num', title: String(v) }, h('b', {}, fmt(v, d))), h('td', {}, u))),
      h('tr', {}, h('td', {}, 'Motor Classification'), h('td', { class: 'num' }, h('b', {}, `${c.out.motorClass} ${fmt(c.out.averageThrust, 0)}`)), h('td', {})))),
    region((c) => h('table', { class: 'wb-summary wb-points' },
      h('tr', {}, h('td', { colspan: 4, class: 'wb-summary-title center' }, h('b', {}, 'Thrust-time data'), ' (approximates the curve)')),
      h('tr', {}, h('td', { colspan: 4 }, 'Time step ', h('b', { title: String(c.out.step) }, fmt(c.out.step, 4)), ' sec.')),
      h('tr', { class: 'units' }, h('th', {}, 'Data pt.'), h('th', { class: 'red' }, 'Time (sec.)'), h('th', { class: 'blue' }, 'Thrust (N.)'), h('th', { class: 'purple' }, 'Thrust (lb.)')),
      ...c.out.rows.map((r) => h('tr', {}, h('td', { class: 'num' }, String(r.n)), h('td', { class: 'num red', title: String(r.t) }, fmt(r.t, 3)),
        h('td', { class: 'num blue', title: String(r.thrust) }, fmt(r.thrust, 0)), h('td', { class: 'num purple' }, fmt(r.lbf, 0)))))),
  ];
  const fileNote = region((c) => {
    try {
      const f = engFile(c.result, model.eng, engNames());
      return h('p', { class: 'wb-note' }, `${f.filename}: ${f.points.length} points, ${fmt(f.impulse, 1)} N·s in the file (the design: ${fmt(f.designImpulse, 1)} N·s).`);
    } catch (err) {
      return h('p', { class: 'wb-note warn' }, err.message);
    }
  });
  const dl = h('button', { type: 'button', class: 'ghost' }, icon('download'), 'Download .eng');
  dl.onclick = downloadEng;
  const use = h('button', { type: 'button' }, icon('flame'), 'Use in OpenRocket');
  use.onclick = useInOpenRocket;
  const right = [
    region((c) => xyChart({ title: 'Thrust vs time', x: { title: 'Time', unit: 'seconds' }, y: { title: 'Thrust', unit: 'Newtons' },
      series: [{ label: 'Thrust', color: 'var(--srm-blue)', markers: true, points: c.out.rows.map((r) => [r.t, r.thrust]) }] }, { height: 250 })),
    region((c) => xyChart({ title: '', x: { title: 'Time', unit: 'seconds' }, y: { title: 'Thrust', unit: 'Pounds' },
      series: [{ label: 'Thrust', color: 'var(--srm-purple)', markers: true, points: c.out.rows.map((r) => [r.t, r.lbf]) }] }, { height: 250 })),
    h('div', { class: 'wb-eng' }, h('h4', {}, 'Motor file for OpenRocket (.eng)'), ...engRows, fileNote, h('div', { class: 'wb-actions' }, dl, use)),
  ];
  return [h('div', { class: 'wb-cols' }, h('div', { class: 'wb-left' }, ...left), h('div', { class: 'wb-right' }, ...right))];
}

function propellantSheet() {
  const p = propellant(model.propellant);
  const props = [['Grain mass density, ideal', 'ρ<sub>p</sub>', 'g/cm³', 'density', 3], ['Ratio of specific heats, mixture', 'k', '–', 'k', 4],
    ['Effective molecular wt.', 'M', 'kg/kmol', 'M', 3], ['Chamber temperature', 'T<sub>o</sub>', 'K', 'T0', 0]];
  return [
    h('h3', { class: 'wb-heading' }, 'Propellant Data'),
    h('p', { class: 'wb-note' }, 'Propellant and combustion products, physical and thermochemical properties (SRM_2023). k is for the gas-particle mixture; M is the system mass divided by the number of gas moles; T', h('sub', {}, 'o'), ' is the adiabatic flame temperature.'),
    h('div', { class: 'wb-scroll' }, h('table', { class: 'wb-table wb-props' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Propellant type'), h('th', {}, 'symb.'), h('th', {}, 'units'), ...PROPELLANTS.map((x) => h('th', { class: x.name === p.name ? 'sel' : '' }, x.name)))),
      h('tbody', {}, ...props.map(([label, sym, unit, key, d]) => h('tr', {}, h('td', {}, label), h('td', { html: sym }), h('td', {}, unit),
        ...PROPELLANTS.map((x) => h('td', { class: `num ${x.name === p.name ? 'sel' : ''}` }, fmt(x[key], d)))))))),
    h('h4', { class: 'wb-subheading' }, `Burn rate: ${p.name}`),
    h('p', { class: 'wb-note' }, `${p.name} = ${p.note}. Burn rate r = a·P`, h('sup', {}, 'n'), ', r in mm/s and P in MPa.'),
    h('table', { class: 'wb-table wb-burn' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Pressure, MPa'), h('th', {}, 'a'), h('th', {}, 'n'))),
      h('tbody', {}, ...p.burn.map(([from, a, n], i) => h('tr', {}, h('td', {}, `${fmt(from, 3)} to ${fmt(p.burn[i + 1]?.[0] ?? p.burnUpTo, 3)}`),
        h('td', { class: 'num' }, fmt(a, 3)), h('td', { class: 'num' }, fmt(n, 4)))))),
    h('p', { class: 'wb-note' }, 'Conditions for these burn rates (SRM_2023, Burnrate worksheet): KNSB fine, KNDX, KNFR and KNSU with the oxidizer finely milled (mostly 60 to 125 µm); KNSB, KNMN and KNER coarse with it granular or lightly milled (mostly 150 to 250 µm); grain temperature 20 °C. Coarse burn rates courtesy Magnus Gudnason; KNPSB’s from static tests.'),
    h('p', { class: 'wb-note' }, 'Calculation: JSRM 3.3 (github.com/jbgust/jsrm), the Java version of Richard Nakka’s SRM_2023 spreadsheet that METEOR runs, with one change of ours that makes shaped grains quicker and leaves every result the same. Hollow-cylinder (BATES) grains are SRM’s own model; the other grain shapes are METEOR’s (JSRM’s geometry), which SRM does not cover. Predictions, not guarantees: test a motor statically before flying it.'),
  ];
}

// ------------------------------------------------------------------ drawings

const NS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs = {}, ...kids) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  e.append(...kids);
  return e;
};

/** The nozzle's profile, as SRM's Nozzle Design worksheet draws it (to scale). */
function nozzleSvg(c) {
  const rc = c.m.chamber.diameter / 2;
  const rt = c.kn.dto / 2;
  const re = c.result.nozzle.exitDiameter / 2;
  const reo = c.result.nozzle.optimalExitDiameter / 2;
  const lc = c.noz.lconv;
  const lo = c.noz.overall;
  const lopt = lc + (reo - rt) / Math.tan(c.m.settings.divergence * Math.PI / 180);
  const W = Math.max(lo, lopt) * 1.08;
  const H = Math.max(rc, re, reo) * 2.3;
  const s = Math.min(560 / W, 300 / H);
  const ox = 30;
  const oy = 170;
  const X = (x) => ox + x * s;
  const Y = (y) => oy - y * s;
  const svg = svgEl('svg', { viewBox: '0 0 620 340', class: 'wb-drawing', role: 'img', 'aria-label': 'Nozzle profile' });
  svg.append(svgEl('line', { x1: X(0), y1: oy, x2: X(W), y2: oy, class: 'axis' }));
  svg.append(svgEl('line', { x1: X(0), y1: Y(rc) - 20, x2: X(0), y2: Y(-rc) + 20, class: 'axis' }));
  for (const sgn of [1, -1]) {
    svg.append(svgEl('polyline', { points: `${X(0)},${Y(sgn * rc)} ${X(lc)},${Y(sgn * rt)} ${X(lo)},${Y(sgn * re)}`, class: 'wall' }));
    svg.append(svgEl('line', { x1: X(lo), y1: Y(sgn * re), x2: X(lopt), y2: Y(sgn * reo), class: 'opt' }));
  }
  svg.append(svgEl('line', { x1: X(lo), y1: Y(re), x2: X(lo), y2: Y(-re), class: 'exit' }));
  svg.append(svgEl('line', { x1: X(lopt), y1: Y(reo), x2: X(lopt), y2: Y(-reo), class: 'opt dashed' }));
  const label = (x, y, text, anchor = 'start') => svgEl('text', { x, y, 'text-anchor': anchor }, text);
  svg.append(label(X(0) + 4, Y(-rc) + 34, 'entrance plane'), label(X(lc), Y(-rt) + 18, 'throat', 'middle'), label(X(lo) - 4, Y(-re) + 18, 'exit', 'end'),
    label(X(lopt) + 4, Y(reo) - 6, 'optimum exit'));
  return svg;
}

/** The grain's end, as seen down the motor: SRM's hollow cylinder, or the shape METEOR models. */
function grainSvg(g, chamberDiameter) {
  const R = 130;
  const scale = R / (chamberDiameter / 2);
  const c = 150;
  const svg = svgEl('svg', { viewBox: '0 0 300 300', class: 'wb-drawing grain', role: 'img', 'aria-label': 'The grain, end on' });
  svg.append(svgEl('circle', { cx: c, cy: c, r: R, class: 'casing' }));
  const od = grainOuterDiameter(g) * scale / 2;
  const holes = [];
  const circle = (cx, cy, r) => `M${cx - r},${cy}a${r},${r} 0 1,0 ${2 * r},0a${r},${r} 0 1,0 ${-2 * r},0`;
  const poly = (pts) => `M${pts.map((p) => p.map((v) => v.toFixed(2)).join(',')).join('L')}Z`;
  switch (g.type) {
    case 'hollow': holes.push(circle(c, c, g.coreDiameter * scale / 2)); break;
    case 'rodTube': {
      holes.push(circle(c, c, g.tubeInnerDiameter * scale / 2));
      svg.append(svgEl('path', { d: `${circle(c, c, od)}${circle(c, c, g.tubeInnerDiameter * scale / 2)}`, class: 'grain', 'fill-rule': 'evenodd' }));
      svg.append(svgEl('circle', { cx: c, cy: c, r: g.rodDiameter * scale / 2, class: 'grain' }));
      return svg;
    }
    case 'moonBurner': holes.push(circle(c, c + g.coreOffset * scale, g.coreDiameter * scale / 2)); break;
    case 'endBurner': if (g.holeDiameter > 0) holes.push(circle(c, c, g.holeDiameter * scale / 2)); break;
    case 'cSlot': {
      holes.push(circle(c, c, g.coreDiameter * scale / 2));
      const w = g.slotWidth * scale / 2;
      const y0 = c + g.slotOffset * scale;
      holes.push(poly([[c - w, y0], [c + w, y0], [c + w, y0 + g.slotDepth * scale], [c - w, y0 + g.slotDepth * scale]]));
      break;
    }
    case 'finocyl': {
      holes.push(circle(c, c, g.innerDiameter * scale / 2));
      const w = g.finWidth * scale / 2;
      const r = g.finDiameter * scale / 2;
      for (let i = 0; i < g.finCount; i++) {
        const a = (2 * Math.PI * i) / g.finCount;
        const rot = ([x, y]) => [c + x * Math.cos(a) - y * Math.sin(a), c + x * Math.sin(a) + y * Math.cos(a)];
        holes.push(poly([[-w, 0], [w, 0], [w, r], [-w, r]].map(rot)));
      }
      break;
    }
    case 'star': {
      const ri = g.innerDiameter * scale / 2;
      const rp = g.pointDiameter * scale / 2;
      const pts = [];
      for (let i = 0; i < 2 * g.pointCount; i++) {
        const a = (Math.PI * i) / g.pointCount - Math.PI / 2;
        const r = i % 2 ? ri : rp;
        pts.push([c + r * Math.cos(a), c + r * Math.sin(a)]);
      }
      holes.push(poly(pts));
      break;
    }
    default:
  }
  // The grain with its holes cut out (the shapes may overlap, as METEOR's do: drawn as one path).
  const mask = svgEl('mask', { id: 'grain-holes' }, svgEl('rect', { x: 0, y: 0, width: 300, height: 300, fill: '#fff' }),
    ...holes.map((d) => svgEl('path', { d, fill: '#000' })));
  svg.append(svgEl('defs', {}, mask), svgEl('circle', { cx: c, cy: c, r: od, class: 'grain', mask: 'url(#grain-holes)' }));
  return svg;
}

// ------------------------------------------------------------------ the motor file

function engNames() {
  return { title: [model.title, model.subtitle].filter(Boolean).join(' '), propellantName: model.propellant, grainLabel: GRAINS[model.grain.type].label };
}

/** The .eng file for the motor on show, or null (and the Output worksheet, saying what is missing). */
function currentEng() {
  if (!calc) {
    toast(problem ? `The motor is not worked out yet: ${problem}` : 'Wait for the calculation to finish.');
    return null;
  }
  try {
    return engFile(calc.result, model.eng, engNames());
  } catch (e) {
    toast(e.message);
    if (sheet !== 'output') {
      sheet = 'output';
      renderSheet();
    }
    return null;
  }
}

function downloadEng() {
  const f = currentEng();
  if (f) saveFile(new TextEncoder().encode(f.text), f.filename);
}

async function useInOpenRocket() {
  const f = currentEng();
  if (!f) return;
  const button = $('#use-openrocket');
  button.disabled = true;
  try {
    const bytes = new TextEncoder().encode(f.text);
    const { motors, text } = readMotorFile(f.filename, Object.assign(bytes, { toString: () => f.text }));
    // The motor replaces the one this design added before, if any.
    if (record?.motor_id) await api('motors', { action: 'delete', id: record.motor_id }).catch(() => {});
    const added = await api('motors', { action: 'add', filename: f.filename, content: text, summary: JSON.stringify(motors) });
    await save({ motorId: added.id, quiet: true });
    addedDialog(motors[0]);
  } catch (e) {
    toast(e.message);
  } finally {
    button.disabled = false;
  }
}

async function addedDialog(m) {
  const list = h('div', { class: 'list' }, h('div', { class: 'item sub' }, 'Loading your designs…'));
  const done = h('button', { type: 'button' }, 'Done');
  const { close } = modal('Added to OpenRocket', [
    h('p', {}, `${m.designation} (${m.manufacturer}) is now one of your custom motors. In a design, open Motors & Configuration, then Select a rocket motor: it is listed with the other motors, under ${m.manufacturer}. A design already open needs its page reloaded to see it.`),
    h('p', { class: 'hint' }, 'Open a design to use it now:'),
    list,
  ], [done]);
  done.onclick = close;
  try {
    const designs = (await api('designs', { action: 'list' })).sort((a, b) => a.name.localeCompare(b.name));
    list.replaceChildren(...(designs.length ? designs.map((d) => h('a', { class: 'item', href: `/design.html?id=${encodeURIComponent(d.id)}` }, icon('rocket'), h('div', { class: 'grow' }, d.name))) : [h('div', { class: 'item sub' }, 'No designs yet.')]));
  } catch {
    list.replaceChildren(h('a', { class: 'item', href: '/' }, icon('rocket'), h('div', { class: 'grow' }, 'Your designs')));
  }
}

// ------------------------------------------------------------------ saving

/** What a motor's card shows, kept with it: { designation, curve, impulse, isp, propellant, grain }. */
function cardOf() {
  if (!calc) return null;
  return {
    designation: calc.out.designation,
    curve: calc.out.rows.map((r) => [r.t, r.thrust]),
    impulse: calc.out.totalImpulse,
    isp: calc.out.isp,
    propellant: model.propellant,
    grain: GRAINS[model.grain.type].label,
  };
}

function summaryOf(card) {
  if (!card) return `${model.propellant} · ${GRAINS[model.grain.type].label}`;
  const segs = model.grain.segments > 1 ? ` × ${model.grain.segments}` : '';
  return `${card.designation} · ${card.propellant} · ${card.grain}${segs}`;
}

async function save({ motorId, quiet = false } = {}) {
  const name = $('#motor-name').value.trim() || model.title?.trim() || (await promptDialog('Save motor', 'Name', calc?.out.designation ?? 'My motor', 'Save'));
  if (!name) return null;
  $('#motor-name').value = name;
  const card = cardOf();
  const body = {
    name,
    summary: summaryOf(card),
    data: JSON.stringify({ v: 1, model, card }),
    ...(motorId !== undefined ? { motor_id: motorId } : {}),
  };
  const button = $('#save');
  button.disabled = true;
  try {
    if (record) {
      record = await api('motorDesigns', { action: 'update', id: record.id, ...body });
      if (record.name !== name) record = await api('motorDesigns', { action: 'rename', id: record.id, name });
    } else {
      record = await api('motorDesigns', { action: 'create', ...body });
      const url = new URL(location.href);
      url.search = `?id=${encodeURIComponent(record.id)}`;
      history.replaceState(null, '', url);
    }
    dirty = false;
    button.classList.remove('unsaved');
    if (!quiet) toast('Saved. It is with your motors.');
    return record;
  } catch (e) {
    toast(e.message);
    throw e;
  } finally {
    button.disabled = false;
  }
}

// ------------------------------------------------------------------ the workbook

function openWorkbook() {
  document.body.classList.add('workbook-page');
  $('#workbook').hidden = false;
  $('#motor-name').value = record?.name ?? '';
  $('#motor-name').oninput = markDirty;
  $('#save').onclick = () => save().catch(() => {});
  $('#download-eng').onclick = downloadEng;
  $('#use-openrocket').onclick = useInOpenRocket;
  for (const link of [$('#all-motors'), $('.topbar .crumb')]) {
    link.onclick = async (e) => {
      if (!dirty) return;
      e.preventDefault();
      if (await confirmDialog('Leave without saving?', 'Your changes to this motor are not saved.', 'Leave', true)) {
        dirty = false;
        location.href = link.href;
      }
    };
  }
  window.addEventListener('beforeunload', (e) => {
    if (dirty) e.preventDefault();
  });
  renderTabs();
  renderSheet();
  startCalculator().catch((e) => status(e.message, 'error'));
  recalc();
}

/** A saved motor's worksheets, with anything a newer version added filled in from SRM's example. */
function modelOf(r) {
  const base = exampleMotor();
  const saved = JSON.parse(r.data).model ?? {};
  return {
    ...base, ...saved,
    chamber: { ...base.chamber, ...saved.chamber },
    throat: { ...base.throat, ...saved.throat },
    settings: { ...base.settings, ...saved.settings },
    eng: { ...base.eng, ...saved.eng },
    grain: saved.grain ?? base.grain,
  };
}

// ------------------------------------------------------------------ home: your motors

let motors = [];

async function showMotors() {
  $('#motors').hidden = false;
  $('#motor-search').oninput = renderMotors;
  document.addEventListener('click', () => document.querySelectorAll('.menu').forEach((m) => (m.hidden = true)));
  try {
    motors = await api('motorDesigns', { action: 'list' });
  } catch (e) {
    toast(e.message);
    motors = [];
  }
  renderMotors();
}

function renderMotors() {
  const q = $('#motor-search').value.trim().toLowerCase();
  const shown = motors.filter((m) => !q || m.name.toLowerCase().includes(q) || (m.summary ?? '').toLowerCase().includes(q));
  $('#motors-empty').hidden = motors.length > 0;
  $('#motor-grid').replaceChildren(...shown.map(motorCard));
}

function motorCard(r) {
  let card = null;
  try {
    card = JSON.parse(r.data).card;
  } catch {
    // shown without its curve
  }
  const open = () => { location.href = `/motor.html?id=${encodeURIComponent(r.id)}`; };
  const thumb = h('div', { class: 'thumb motor-thumb' }, curveSvg(card?.curve), card ? h('span', { class: 'motor-class' }, card.designation) : null);
  thumb.onclick = open;
  const more = h('button', { class: 'ghost icon', title: 'More', 'aria-label': `More actions for ${r.name}` }, icon('more'));
  const menu = h('div', { class: 'menu', hidden: true });
  const item = (ic, label, fn, cls) => {
    const b = h('button', { class: cls }, icon(ic), label);
    b.onclick = (e) => {
      e.stopPropagation();
      menu.hidden = true;
      fn();
    };
    return b;
  };
  menu.append(
    item('flame', 'Open', open),
    item('copy', 'Duplicate', () => duplicateMotor(r)),
    item('edit', 'Rename', () => renameMotor(r)),
    h('hr'),
    item('trash', 'Delete', () => deleteMotor(r), 'danger'),
  );
  more.onclick = (e) => {
    e.stopPropagation();
    document.querySelectorAll('.menu').forEach((m) => m !== menu && (m.hidden = true));
    menu.hidden = !menu.hidden;
    if (!menu.hidden) {
      menu.classList.remove('up');
      if (menu.getBoundingClientRect().bottom > window.innerHeight - 8) menu.classList.add('up');
    }
  };
  return h('article', { class: 'card', 'data-id': r.id },
    thumb,
    h('div', { class: 'body', onclick: open },
      h('h3', { title: r.name }, r.name),
      r.summary ? h('div', { class: 'meta' }, h('span', {}, r.summary)) : null,
      card ? h('div', { class: 'meta' }, h('span', {}, `${fmt(card.impulse, 1)} N·s · Isp ${fmt(card.isp, 1)} s`)) : null,
      r.motor_id ? h('div', { class: 'meta' }, h('span', { class: 'badge' }, 'In OpenRocket')) : null),
    h('div', { class: 'foot' },
      h('span', { class: 'hint' }, `Saved ${timeAgo(Date.parse(r.updated_date ?? r.created_date) || Date.now())}`),
      h('span', { class: 'spacer' }),
      h('span', { class: 'menu-wrap' }, more, menu)));
}

async function duplicateMotor(r) {
  const name = await promptDialog('Duplicate motor', 'Name of the copy', `${r.name} (copy)`, 'Duplicate');
  if (!name) return;
  try {
    const full = await api('motorDesigns', { action: 'get', id: r.id });
    await api('motorDesigns', { action: 'create', name, summary: full.summary, data: full.data });
    await showMotors();
  } catch (e) {
    toast(e.message);
  }
}

async function renameMotor(r) {
  const name = await promptDialog('Rename motor', 'Name', r.name, 'Rename');
  if (!name || name === r.name) return;
  try {
    await api('motorDesigns', { action: 'rename', id: r.id, name });
    await showMotors();
  } catch (e) {
    toast(e.message);
  }
}

async function deleteMotor(r) {
  const extra = r.motor_id ? ' It stays among your custom motors for OpenRocket: remove it there (Your designs, Motors) if you no longer use it.' : '';
  if (!(await confirmDialog('Delete motor?', `“${r.name}” will be deleted. This cannot be undone.${extra}`, 'Delete', true))) return;
  try {
    await api('motorDesigns', { action: 'delete', id: r.id });
    await showMotors();
  } catch (e) {
    toast(e.message);
  }
}

// ------------------------------------------------------------------ start

async function main() {
  me = await currentUser();
  if (!me) {
    $('#signed-out').hidden = false;
    return;
  }
  $('#me').replaceChildren(avatar(me), h('span', { class: 'name' }, me.name));
  $('#me').hidden = false;
  await requirePlan(); // without a plan: the plans notice (src/plan.js); every plan includes it
  if (params.has('id')) {
    try {
      record = await api('motorDesigns', { action: 'get', id: params.get('id') });
      model = modelOf(record);
    } catch (e) {
      toast(e.message);
      return showMotors();
    }
    return openWorkbook();
  }
  if (params.has('new')) {
    model = exampleMotor();
    model.title = 'My rocket motor';
    model.subtitle = 'utilizing KNDX propellant.';
    return openWorkbook();
  }
  return showMotors();
}

main().catch((e) => toast(e.message));
