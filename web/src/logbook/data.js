// Flight logbook data (logbook.js): quantities and units, the fixed column format people enter
// their data in and its instructions, a strict parser for it, data sets from OpenRocket's stored
// simulation results and from Launch Planner plans, and the series the graphs draw.
// Plain JavaScript without the page, so the tests run it in Node.
import { parse } from '../../../server/src/xml.js';

/** What a column can hold, with its units (factor to SI) and the units the graphs show it in. */
export const QUANTITIES = {
  altitude: { label: 'Altitude', units: { m: 1, ft: 0.3048, km: 1000 }, metric: 'm', imperial: 'ft' },
  velocity: { label: 'Velocity', units: { 'm/s': 1, 'ft/s': 0.3048, 'km/h': 1 / 3.6, mph: 0.44704 }, metric: 'm/s', imperial: 'ft/s' },
  acceleration: { label: 'Acceleration', units: { 'm/s²': 1, 'ft/s²': 0.3048, g: 9.80665 }, metric: 'm/s²', imperial: 'ft/s²' },
};
export const TIME_UNITS = { s: 1, ms: 0.001 };
export const MAX_ROWS = 50_000;
export const MAX_COLUMNS = 12;

/** A column's name as people read it: "Altitude (m)", "Pressure (hPa)". */
export function columnLabel(c) {
  const name = c.q === 'custom' ? c.name || 'Custom' : c.name || QUANTITIES[c.q]?.label || c.q;
  return c.unit ? `${name} (${c.unit})` : name;
}

/** The columns a data set's text must have, in order: time first. */
export function formatColumns(ds) {
  return [{ label: `Time (${ds.time ?? 's'})` }, ...ds.columns.map((c) => ({ label: columnLabel(c) }))];
}

/** The instructions for entering a data set: one line per column, and a few example rows. */
export function formatInstructions(ds) {
  const cols = formatColumns(ds);
  const sample = [[0, 0, 0, 0], [0.5, 12.4, 48.1, 96.3], [1, 41.8, 66.2, -9.7]];
  const scale = ds.time === 'ms' ? 1000 : 1;
  const example = sample.map((r) => cols.map((_, i) => (i === 0 ? r[0] * scale : r[Math.min(i, 3)] ?? 0)).join(','));
  return {
    columns: cols.map((c, i) => `Column ${i + 1}: ${c.label}`),
    header: cols.map((c) => c.label).join(','),
    example,
  };
}

/** A CSV template with the header row and the example rows. */
export function templateCsv(ds) {
  const f = formatInstructions(ds);
  return [f.header, ...f.example].join('\n') + '\n';
}

const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/**
 * Reads data in the fixed format: one row per line, the values separated by commas, time first
 * and then the chosen columns in order, with a decimal point. Blank lines and lines starting
 * with # are skipped, and so is a first line of column names. Returns { rows, errors (at most
 * ten, with line numbers), header }; rows only when there are no errors.
 */
export function parseRows(text, ds) {
  const want = ds.columns.length + 1;
  const names = formatColumns(ds).map((c) => c.label).join(', ');
  const errors = [];
  const rows = [];
  let header = null;
  let seenData = false;
  const lines = String(text ?? '').split(/\r\n|\r|\n/);
  for (let i = 0; i < lines.length && errors.length < 10; i++) {
    const line = lines[i].replace(/^﻿/, '').trim();
    if (!line || line.startsWith('#')) continue;
    const n = i + 1;
    if (!line.includes(',') && want > 1) {
      errors.push(/[;\t]/.test(line) || /\d\s+\d/.test(line)
        ? `Line ${n}: separate the values with commas (,).`
        : `Line ${n}: expected ${want} values separated by commas (${names}).`);
      continue;
    }
    const fields = line.split(',').map((f) => f.trim());
    const numeric = fields.every((f) => NUMBER.test(f));
    if (!seenData && !header && !numeric && fields.some((f) => /[A-Za-z가-힣]/.test(f))) {
      // Column names: allowed once, at the top, if there are as many as the data needs.
      if (fields.length !== want) {
        errors.push(`Line ${n} looks like column names, but it has ${fields.length} of them and the data needs ${want}: ${names}.`);
      } else {
        header = fields;
      }
      continue;
    }
    seenData = true;
    if (fields.length !== want) {
      errors.push(`Line ${n}: ${fields.length} value${fields.length === 1 ? '' : 's'}, but each row needs ${want} (${names}).`);
      continue;
    }
    const bad = fields.findIndex((f) => !NUMBER.test(f));
    if (bad >= 0) {
      errors.push(fields[bad] === ''
        ? `Line ${n}: value ${bad + 1} (${formatColumns(ds)[bad].label}) is empty.`
        : `Line ${n}: "${fields[bad].slice(0, 20)}" in column ${bad + 1} (${formatColumns(ds)[bad].label}) is not a number. Use a decimal point, not a comma.`);
      continue;
    }
    const row = fields.map(Number);
    if (rows.length && row[0] < rows[rows.length - 1][0]) {
      errors.push(`Line ${n}: the time ${fields[0]} is earlier than the row before. Rows must be in time order.`);
      continue;
    }
    rows.push(row);
    if (rows.length > MAX_ROWS) {
      errors.push(`More than ${MAX_ROWS.toLocaleString('en')} rows: thin the data out first (every second or tenth row).`);
      break;
    }
  }
  if (!errors.length && rows.length < 2) errors.push('Enter at least two rows of data.');
  return { rows: errors.length ? [] : rows, errors, header };
}

/** A data set's summary per column: the largest value and when, and the time span. */
export function summarize(ds) {
  const tf = TIME_UNITS[ds.time ?? 's'] ?? 1;
  const rows = ds.rows ?? [];
  const span = rows.length ? [rows[0][0] * tf, rows[rows.length - 1][0] * tf] : [0, 0];
  const columns = ds.columns.map((c, j) => {
    let max = -Infinity;
    let at = null;
    let min = Infinity;
    for (const r of rows) {
      const v = r[j + 1];
      if (!Number.isFinite(v)) continue;
      if (v > max) [max, at] = [v, r[0] * tf];
      if (v < min) min = v;
    }
    return { label: columnLabel(c), unit: c.unit, max: Number.isFinite(max) ? max : null, at, min: Number.isFinite(min) ? min : null };
  });
  return { rows: rows.length, span, columns };
}

// ------------------------------------------------------------------ OpenRocket's simulations

/** OpenRocket's names for its flight data (in SI), as logbook columns. */
const OR_TYPES = {
  Altitude: ['altitude', 'm'],
  'Altitude above sea level': ['altitude', 'm'],
  'Vertical velocity': ['velocity', 'm/s'],
  'Total velocity': ['velocity', 'm/s'],
  'Lateral velocity': ['velocity', 'm/s'],
  'Vertical acceleration': ['acceleration', 'm/s²'],
  'Total acceleration': ['acceleration', 'm/s²'],
  'Lateral acceleration': ['acceleration', 'm/s²'],
  'Lateral distance': ['custom', 'm'],
  'Position East of launch': ['custom', 'm'],
  'Position North of launch': ['custom', 'm'],
  Thrust: ['custom', 'N'],
  'Drag force': ['custom', 'N'],
  Mass: ['custom', 'kg'],
  'Motor mass': ['custom', 'kg'],
  'Mach number': ['custom', ''],
  'Stability margin calibers': ['custom', 'cal'],
  'Drag coefficient': ['custom', ''],
  'Thrust-to-weight ratio': ['custom', ''],
  'Air temperature': ['custom', 'K'],
  'Air pressure': ['custom', 'Pa'],
  'Angle of attack': ['custom', 'rad'],
};
export const OR_DEFAULTS = ['Altitude', 'Vertical velocity', 'Vertical acceleration'];

/** A logbook column for one of OpenRocket's flight data types. */
export function orColumn(type) {
  const [q, unit] = OR_TYPES[type] ?? ['custom', ''];
  return { q, unit, name: type };
}

/**
 * The simulations in a design's .ork XML (server/src/model.js toXml) with their stored flight
 * data: [{ name, summary: { maxaltitude, ... }, branches: [{ name, types, rows }] }]. A simulation
 * that was not run (or saved without its data) has no branches.
 */
export function simulationsFromXml(xml) {
  const root = parse(xml);
  const sims = root.first('simulations');
  if (!sims) return [];
  const out = [];
  for (const s of sims.elements()) {
    if (s.tag !== 'simulation') continue;
    const fd = s.first('flightdata');
    const summary = {};
    for (const [k, v] of fd?.attrs ?? []) summary[k] = Number(v);
    const branches = [];
    for (const b of fd?.elements() ?? []) {
      if (b.tag !== 'databranch') continue;
      const types = String(b.attrs.get('types') ?? '').split(',');
      const rows = [];
      for (const p of b.elements()) {
        if (p.tag !== 'datapoint') continue;
        rows.push(p.text().split(',').map((x) => (x === 'NaN' ? NaN : Number(x))));
      }
      if (rows.length) branches.push({ name: b.attrs.get('name') ?? 'Flight', types, rows });
    }
    out.push({ name: s.first('name')?.text() ?? `Simulation ${out.length + 1}`, summary, branches });
  }
  return out;
}

/** A logbook data set from one branch of an OpenRocket simulation, with the chosen types. */
export function datasetFromSimulation({ design, simulation, branch, types }) {
  const t = branch.types.indexOf('Time');
  if (t < 0) throw new Error('This simulation has no time column.');
  const idx = types.map((ty) => branch.types.indexOf(ty)).filter((i) => i >= 0);
  if (!idx.length) throw new Error('Choose at least one kind of data.');
  const rows = [];
  for (const r of branch.rows) {
    const row = [r[t], ...idx.map((i) => r[i])];
    if (row.every(Number.isFinite)) rows.push(row);
  }
  return {
    name: `${simulation.name} (OpenRocket)`,
    source: 'openrocket',
    from: { design: design.name, designId: design.id, simulation: simulation.name, branch: branch.name },
    time: 's',
    offset: 0,
    columns: idx.map((i) => orColumn(branch.types[i])),
    rows: thin(rows, 5000),
  };
}

// ------------------------------------------------------------------ Launch Planner plans

/**
 * A logbook data set from a Launch Planner plan (unpacked, see flight/study.js): its nominal
 * flight's altitude and drift from the pad; and what the plan says about the launch.
 */
export function datasetFromPlan(plan, study) {
  const rows = (study.nominal?.path ?? [])
    .filter((p) => p.every(Number.isFinite))
    .map(([t, e, n, u]) => [t, u, Math.round(Math.hypot(e, n) * 10) / 10]);
  if (rows.length < 2) throw new Error('This launch plan has no flight path.');
  const when = study.when ? new Date(study.when) : null;
  const pad = (x) => String(x).padStart(2, '0');
  return {
    dataset: {
      name: `${plan.name} (Launch Planner)`,
      source: 'planner',
      from: { plan: plan.name, planId: plan.id, design: study.design?.name ?? plan.design_name ?? null },
      time: 's',
      offset: 0,
      columns: [{ q: 'altitude', unit: 'm', name: 'Altitude (predicted)' }, { q: 'custom', unit: 'm', name: 'Drift from the pad' }],
      rows: thin(rows, 5000),
    },
    details: {
      date: when ? `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}` : '',
      time: when ? `${pad(when.getHours())}:${pad(when.getMinutes())}` : '',
      location: study.site ? `${study.site.lat.toFixed(5)}, ${study.site.lon.toFixed(5)}` : '',
      rocket: study.design?.name ?? plan.design_name ?? '',
    },
    note: plan.summary ? `Launch Planner (${plan.name}): ${plan.summary}` : '',
  };
}

// ------------------------------------------------------------------ graphs

const PALETTE = ['#2563eb', '#dc2626', '#16a34a', '#d97706', '#7c3aed', '#0891b2', '#db2777', '#4b5563'];

/** Every `n`th row so that at most `max` remain, keeping each stretch's highest and lowest point. */
export function thin(rows, max) {
  if (rows.length <= max) return rows;
  const out = [];
  const per = Math.ceil(rows.length / (max / 2));
  for (let i = 0; i < rows.length; i += per) {
    const chunk = rows.slice(i, i + per);
    let lo = chunk[0];
    let hi = chunk[0];
    for (const r of chunk) {
      if (r[1] < lo[1]) lo = r;
      if (r[1] > hi[1]) hi = r;
    }
    out.push(...(lo[0] <= hi[0] ? [lo, hi] : [hi, lo]).filter((r, k, a) => k === 0 || r !== a[0]));
  }
  return out;
}

/**
 * The graphs for a logbook's data sets: one per quantity (custom columns: per name and unit),
 * each with every data set's columns of it, converted to the unit system chosen, on a time axis
 * in seconds (each data set's time offset added). [{ key, title, unit, series: [{ label, color,
 * dataset, points: [[t, v]] }] }]
 */
export function graphGroups(datasets, system = 'metric') {
  const groups = new Map();
  let color = 0;
  for (const ds of datasets) {
    if (ds.hidden) continue;
    const tf = TIME_UNITS[ds.time ?? 's'] ?? 1;
    const off = Number(ds.offset) || 0;
    ds.columns.forEach((c, j) => {
      const q = QUANTITIES[c.q];
      let key;
      let title;
      let unit;
      let factor = 1;
      if (q && q.units[c.unit] !== undefined) {
        key = c.q;
        title = q.label;
        unit = q[system] ?? q.metric;
        factor = q.units[c.unit] / q.units[unit];
      } else {
        const name = c.name || 'Custom';
        key = `custom:${name.toLowerCase()}|${c.unit ?? ''}`;
        title = name;
        unit = c.unit ?? '';
      }
      if (!groups.has(key)) groups.set(key, { key, title, unit, series: [] });
      const points = [];
      for (const r of ds.rows) {
        const v = r[j + 1];
        if (Number.isFinite(v) && Number.isFinite(r[0])) points.push([r[0] * tf + off, v * factor]);
      }
      groups.get(key).series.push({
        label: q && c.name && c.name !== q.label ? `${ds.name} · ${c.name}` : ds.name,
        color: PALETTE[color++ % PALETTE.length],
        dataset: ds.id,
        points,
      });
    });
  }
  const order = ['altitude', 'velocity', 'acceleration'];
  return [...groups.values()].sort((a, b) => (order.indexOf(a.key) + 1 || 99) - (order.indexOf(b.key) + 1 || 99));
}

/** Round, readable axis ticks covering [lo, hi]: about `n` of them. */
export function ticks(lo, hi, n = 5) {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return { lo: 0, hi: 1, step: 0.2, values: [0, 0.2, 0.4, 0.6, 0.8, 1] };
  if (hi - lo < 1e-9) [lo, hi] = [lo - 1, hi + 1];
  const raw = (hi - lo) / n;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const a = Math.floor(lo / step) * step;
  const b = Math.ceil(hi / step) * step;
  const values = [];
  for (let v = a; v <= b + step / 1e6; v += step) values.push(Math.round(v / step) * step);
  return { lo: a, hi: b, step, values };
}

/** A number for an axis or readout: no more digits than the step needs. */
export function formatNumber(v, step = null) {
  if (!Number.isFinite(v)) return '–';
  const digits = step ? Math.max(0, Math.min(4, -Math.floor(Math.log10(step) + 1e-9))) : Math.abs(v) >= 100 ? 0 : Math.abs(v) >= 10 ? 1 : 2;
  return v.toLocaleString('en', { maximumFractionDigits: digits, minimumFractionDigits: step ? digits : 0 });
}

/** A small altitude-like curve for a logbook's card: up to 48 points of its first column. */
export function sparkline(datasets) {
  const ds = datasets.find((d) => d.columns.some((c) => c.q === 'altitude')) ?? datasets[0];
  if (!ds || !ds.rows?.length) return null;
  const j = Math.max(0, ds.columns.findIndex((c) => c.q === 'altitude')) + 1;
  const pts = ds.rows.filter((r) => Number.isFinite(r[j]) && Number.isFinite(r[0]));
  if (pts.length < 2) return null;
  const n = Math.min(48, pts.length);
  const out = [];
  for (let i = 0; i < n; i++) {
    const r = pts[Math.round((i * (pts.length - 1)) / (n - 1))];
    out.push([Math.round(r[0] * 1000) / 1000, Math.round(r[j] * 100) / 100]);
  }
  return out;
}
