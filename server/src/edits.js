// Edit history: readable descriptions of edits and the operations that reverse them.
// Everything here looks at the model *before* an op is applied.
import { parse } from './xml.js';
import { childIndex, componentName, copyObj, applyOp, SIMS, DOC, ATTRS, RAW, ATT } from './model.js';

// ------------------------------------------------------------------ labels

const TYPES = {
  rocket: 'Rocket', stage: 'Stage', parallelstage: 'Boosters', podset: 'Pods',
  nosecone: 'Nose cone', bodytube: 'Body tube', transition: 'Transition',
  trapezoidfinset: 'Trapezoidal fin set', ellipticalfinset: 'Elliptical fin set',
  freeformfinset: 'Freeform fin set', tubefinset: 'Tube fins', launchlug: 'Launch lug',
  railbutton: 'Rail button', innertube: 'Inner tube', tubecoupler: 'Tube coupler',
  centeringring: 'Centering ring', bulkhead: 'Bulkhead', engineblock: 'Engine block',
  parachute: 'Parachute', streamer: 'Streamer', shockcord: 'Shock cord',
  masscomponent: 'Mass component', simulation: 'Simulation',
};

const LABELS = {
  name: 'Name', comment: 'Comment', designer: 'Designer', revision: 'Revision',
  length: 'Length', radius: 'Radius', aftradius: 'Aft radius', foreradius: 'Fore radius',
  outerradius: 'Outer radius', innerradius: 'Inner radius', thickness: 'Wall thickness',
  shape: 'Shape', shapeparameter: 'Shape parameter', shapeclipped: 'Clipped',
  aftshoulderlength: 'Aft shoulder length', aftshoulderradius: 'Aft shoulder radius',
  aftshoulderthickness: 'Aft shoulder thickness', foreshoulderlength: 'Fore shoulder length',
  foreshoulderradius: 'Fore shoulder radius', foreshoulderthickness: 'Fore shoulder thickness',
  aftshouldercapped: 'Aft shoulder capped', foreshouldercapped: 'Fore shoulder capped',
  instancecount: 'Count', fincount: 'Fin count', rootchord: 'Root chord', tipchord: 'Tip chord',
  height: 'Height', sweeplength: 'Sweep length', sweepangle: 'Sweep angle', cant: 'Cant angle',
  crosssection: 'Cross section', tabheight: 'Tab height', tablength: 'Tab length',
  tabposition: 'Tab position', filletradius: 'Fillet radius', filletmaterial: 'Fillet material',
  position: 'Position', axialoffset: 'Position', angleoffset: 'Angle', radiusoffset: 'Radial offset',
  material: 'Material', finish: 'Finish', color: 'Color', linestyle: 'Line style',
  componentmass: 'Mass', mass: 'Mass', overridemass: 'Mass override', overridecg: 'CG override',
  overridecd: 'Drag override', cd: 'Drag coefficient', diameter: 'Diameter',
  packedlength: 'Packed length', packedradius: 'Packed radius', linecount: 'Shroud lines',
  linelength: 'Shroud line length', linematerial: 'Shroud line material',
  cordlength: 'Cord length', cordmaterial: 'Cord material',
  stripwidth: 'Strip width', striplength: 'Strip length',
  motormount: 'Motors', finpoints: 'Fin shape', appearance: 'Appearance',
  insideappearance: 'Inside appearance', preset: 'Preset part', conditions: 'Launch conditions',
  referencetype: 'Reference length', customreference: 'Custom reference length',
  separationconfiguration: 'Stage separation', deploymentconfiguration: 'Deployment',
  motorconfiguration: 'Flight configurations', extension: 'Simulation extensions',
};

// Keys that repeat another key in the file (kept for old OpenRocket versions).
const DUPLICATES = new Set(['fincount', 'rotation', 'radialdirection', 'position']);
const LENGTHS = new Set(['length', 'radius', 'aftradius', 'foreradius', 'outerradius', 'innerradius', 'thickness',
  'aftshoulderlength', 'aftshoulderradius', 'aftshoulderthickness', 'foreshoulderlength', 'foreshoulderradius',
  'foreshoulderthickness', 'rootchord', 'tipchord', 'height', 'sweeplength', 'tabheight', 'tablength', 'tabposition',
  'filletradius', 'axialoffset', 'radiusoffset', 'packedlength', 'packedradius', 'diameter', 'linelength',
  'cordlength', 'stripwidth', 'striplength', 'customreference']);
const MASSES = new Set(['componentmass', 'mass', 'overridemass']);
const ANGLES = new Set(['angleoffset', 'cant', 'sweepangle']);
const RESULT_KEYS = new Set([ATTRS, 'flightdata', '#basis']);

const baseKey = (key) => key.replace(/[[#].*$/, '');
const label = (key) => LABELS[baseKey(key)] ?? baseKey(key).replace(/^./, (c) => c.toUpperCase());
const typeName = (t) => TYPES[t] ?? t;

const round = (x) => Number(x.toPrecision(4)).toString();

function formatNumber(tag, text) {
  let auto = false;
  let t = text.trim();
  if (t.startsWith('auto')) {
    auto = true;
    t = t.slice(4).trim();
  }
  const n = Number(t);
  if (t === '' || !Number.isFinite(n)) return auto ? 'automatic' : null;
  let s;
  if (LENGTHS.has(tag)) s = Math.abs(n) < 0.01 && n !== 0 ? `${round(n * 1000)} mm` : `${round(n * 100)} cm`;
  else if (MASSES.has(tag)) s = n < 1 ? `${round(n * 1000)} g` : `${round(n)} kg`;
  else if (ANGLES.has(tag)) s = `${round(n)}°`;
  else s = round(n);
  return auto ? `automatic (${s})` : s;
}

/** Short display form of one stored property value, or null when it has no simple value. */
export function formatValue(key, xml) {
  if (xml == null) return '—';
  let el;
  try {
    el = parse(xml);
  } catch {
    return null;
  }
  if (el.hasElementChildren()) return null;
  const tag = baseKey(key);
  const text = el.text().trim();
  const num = formatNumber(tag, text);
  if (num !== null) return num;
  if (!text) return '—';
  const pretty = /^[a-z]+$/.test(text) && text.length > 2 ? text.replace(/^./, (c) => c.toUpperCase()) : text;
  return pretty.length > 48 ? `${pretty.slice(0, 47)}…` : pretty;
}

function targetName(model, id, op) {
  const obj = model.objs.get(id);
  if (id === DOC) return 'Design';
  if (id === SIMS) return 'Simulations';
  if (obj?.t === RAW) {
    return { 'doc:photostudio': 'Photo studio', 'doc:datatypes': 'Custom expressions', 'doc:docprefs': 'Document settings' }[id] ?? 'Design settings';
  }
  if (obj?.t === ATT || op?.t === ATT) return 'Decal image';
  const name = componentName(model, id) ?? (op?.v?.name ? op.v.name.replace(/<[^>]+>/g, '') : null);
  const t = obj?.t ?? op?.t;
  return name ? `${typeName(t)} “${name}”` : typeName(t);
}

const isSim = (model, id, op) => (model.objs.get(id)?.p ?? op?.p) === SIMS;

/** True for edits that only carry simulation status/results (OpenRocket's automatic re-runs). */
export function isMinorOp(model, op) {
  if (op.op !== 'set') return false;
  const keys = Object.keys(op.v ?? {});
  if (op.id === DOC || op.id === SIMS) return keys.every((k) => k === ATTRS);
  return isSim(model, op.id, op) && keys.every((k) => RESULT_KEYS.has(k) || k.startsWith('#'));
}

/** Readable changes made by one (accepted) op, described against the model before it. */
export function describeOp(model, op) {
  const target = targetName(model, op.id, op);
  const out = [];
  switch (op.op) {
    case 'put':
      out.push({ id: op.id, kind: model.objs.has(op.id) ? 'replace' : 'add', target });
      break;
    case 'del':
      out.push({ id: op.id, kind: 'remove', target });
      break;
    case 'move':
      out.push({ id: op.id, kind: model.objs.get(op.id)?.p === op.p ? 'reorder' : 'move', target });
      break;
    case 'set': {
      const obj = model.objs.get(op.id);
      for (const [key, val] of Object.entries(op.v ?? {})) {
        if (key === 'id' || key.startsWith('#') || DUPLICATES.has(baseKey(key))) continue;
        if (key === ATTRS || (key === 'flightdata' && isSim(model, op.id, op))) continue;
        const before = obj?.v.get(key) ?? null;
        const from = formatValue(key, before);
        const to = formatValue(key, val);
        out.push({
          id: op.id,
          kind: 'set',
          target,
          prop: label(key),
          key,
          ...(from !== null && to !== null ? { from, to } : {}),
        });
      }
      break;
    }
    default:
      break;
  }
  return out;
}

// ------------------------------------------------------------------ inverses

const objToPut = (id, o, stripResults) => {
  const v = Object.fromEntries(o.v);
  if (stripResults && o.p === SIMS) {
    delete v.flightdata; // results are recomputed by OpenRocket; not worth storing
    delete v['#basis'];
  }
  return { op: 'put', id, t: o.t, p: o.p, o: o.o, k: [...o.k].filter((k) => k in v), v };
};

/**
 * Ops that undo `op` (in order), computed before `op` is applied. Each carries an `expect`
 * describing the state right after `op`, so a later undo can skip parts changed since.
 */
export function inverseOf(model, op) {
  const obj = model.objs.get(op.id);
  switch (op.op) {
    case 'set': {
      const v = {};
      const expect = {};
      for (const key of Object.keys(op.v ?? {})) {
        if (key === 'flightdata' || key === '#basis') continue;
        v[key] = obj?.v.get(key) ?? null;
        expect[key] = op.v[key] ?? null;
      }
      if (!Object.keys(v).length) return [];
      return [{ op: 'set', id: op.id, v, ...(op.k ? { k: [...(obj?.k ?? [])] } : {}), expect: { values: expect } }];
    }
    case 'put':
      return obj
        ? [{ ...objToPut(op.id, obj, true), expect: { exists: true } }]
        : [{ op: 'del', id: op.id, expect: { exists: true } }];
    case 'move':
      return obj ? [{ op: 'move', id: op.id, p: obj.p, o: obj.o, expect: { p: op.p, o: op.o } }] : [];
    case 'del': {
      if (!obj) return [];
      const idx = childIndex(model);
      const puts = [];
      const walk = (id) => {
        puts.push({ ...objToPut(id, model.objs.get(id), true), expect: { exists: false } });
        for (const kid of idx.get(id) ?? []) walk(kid);
      };
      walk(op.id);
      return puts;
    }
    default:
      return [];
  }
}

/**
 * Turns stored inverse ops into ops to apply now. In "restore" mode everything is reverted;
 * in "undo" mode parts that were changed again later are skipped (and counted). Works on a
 * copy of the model so each check sees the effect of the ops before it.
 */
export function planRevert(model, inverseOps, mode) {
  const work = { objs: new Map([...model.objs].map(([id, o]) => [id, copyObj(o)])) };
  const ops = [];
  let skipped = 0;
  const keep = (op) => {
    ops.push(op);
    applyOp(work, op);
  };
  for (const inv of inverseOps) {
    const { expect, ...op } = inv;
    if (mode === 'restore' || !expect) {
      keep(op);
      continue;
    }
    const cur = work.objs.get(op.id);
    if (op.op === 'set') {
      if (!cur) {
        skipped++;
        continue;
      }
      const v = {};
      for (const [key, val] of Object.entries(op.v)) {
        if ((cur.v.get(key) ?? null) === (expect.values?.[key] ?? null)) v[key] = val;
        else skipped++;
      }
      if (Object.keys(v).length) keep({ ...op, v });
    } else if (op.op === 'move') {
      if (cur && cur.p === expect.p && cur.o === expect.o) keep(op);
      else skipped++;
    } else if (op.op === 'del') {
      if (cur) keep(op);
      else skipped++;
    } else if (op.op === 'put') {
      if (expect.exists === false && cur) skipped++;
      else keep(op);
    }
  }
  return { ops, skipped };
}

// ------------------------------------------------------------------ grouping for display

const GROUP_GAP_MS = 2 * 60 * 1000;

/** Groups raw history rows (newest first): consecutive edits by one person within 2 minutes. */
export function groupEdits(rows, limit) {
  const groups = [];
  let cur = null;
  for (const row of rows) {
    if (row.minor) continue;
    const note = row.note ? JSON.parse(row.note) : null;
    const changes = JSON.parse(row.changes);
    const joinable = cur && !note && !cur.note && cur.userId === row.user_id && cur.oldestAt - row.at < GROUP_GAP_MS;
    if (!joinable) {
      if (groups.length >= limit) break;
      cur = { userId: row.user_id, userName: row.user_name, at: row.at, oldestAt: row.at, from: row.version, to: row.version, note, changes: [] };
      groups.push(cur);
    }
    cur.from = row.version;
    cur.oldestAt = row.at;
    // Rows come newest first: an older change to the same property only updates "from";
    // other older changes go in front, so the list reads in the order things happened.
    const older = [];
    for (const c of changes) {
      const same = cur.changes.find((x) => x.kind === 'set' && c.kind === 'set' && x.id === c.id && x.key === c.key);
      if (same) {
        if ('from' in c) same.from = c.from;
      } else {
        older.push(c);
      }
    }
    cur.changes = [...older, ...cur.changes];
  }
  for (const g of groups) {
    g.changes = g.changes.filter((c) => !(c.kind === 'set' && 'from' in c && c.from === c.to));
  }
  return groups;
}
