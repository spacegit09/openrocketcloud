// Shared document model: the server-side twin of worker/bridge/src/orcloud/bridge/Model.java.
// apply() must behave exactly like the Java version (clients replay the ops the server
// accepted); the server additionally drops no-op changes and validates untrusted input.
//
// Shape: { objs: Map<id, { t, p, o, k: string[], v: Map<key, string> }> }

import { El, parse, canonical, attrsCanonical } from './xml.js';

export const DOC = 'doc';
export const SIMS = 'sims';
export const ATTRS = '@';
export const RAW = '#raw';
export const ATT = '#att';

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export function emptyModel() {
  return { objs: new Map() };
}

export function copyObj(o) {
  return { t: o.t, p: o.p, o: o.o, k: [...o.k], v: new Map(o.v) };
}

export function fromJson(json) {
  const m = emptyModel();
  for (const [id, j] of Object.entries(json?.objs ?? {})) {
    m.objs.set(id, {
      t: String(j.t),
      p: j.p == null ? null : String(j.p),
      o: Number(j.o) || 0,
      k: (j.k ?? []).map(String),
      v: new Map(Object.entries(j.v ?? {}).map(([k, v]) => [k, String(v)])),
    });
  }
  return m;
}

export function toJson(m) {
  const objs = {};
  for (const [id, o] of m.objs) {
    Object.defineProperty(objs, id, {
      value: { t: o.t, p: o.p, o: o.o, k: o.k, v: Object.fromEntries(o.v) },
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return { objs };
}

export function childIndex(m) {
  const idx = new Map();
  for (const [id, o] of m.objs) {
    if (o.p != null) {
      if (!idx.has(o.p)) idx.set(o.p, []);
      idx.get(o.p).push(id);
    }
  }
  for (const list of idx.values()) {
    list.sort((a, b) => {
      const oa = m.objs.get(a).o;
      const ob = m.objs.get(b).o;
      return oa < ob ? -1 : oa > ob ? 1 : cmp(a, b);
    });
  }
  return idx;
}

// ------------------------------------------------------------------ XML <-> model

const reserved = (id) => id === DOC || id === SIMS || id.startsWith('doc:');

function addObject(m, el, givenId, parent, pos, component) {
  let id = givenId;
  const idEl = component ? el.first('id') : null;
  if (component && idEl) id = idEl.text().trim();
  const regen = !id || m.objs.has(id) || reserved(id);
  if (regen) id = globalThis.crypto.randomUUID();
  const obj = { t: el.tag, p: parent, o: pos, k: [], v: new Map([[ATTRS, attrsCanonical(el.attrs)]]) };
  m.objs.set(id, obj);
  const counts = new Map();
  for (const ch of el.elements()) {
    if (component && ch.tag === 'subcomponents') {
      let j = 0;
      for (const g of ch.elements()) addObject(m, g, null, id, ++j, true);
      continue;
    }
    const cfg = ch.attrs.get('configid');
    const base = cfg != null ? `${ch.tag}[${cfg}]` : ch.tag;
    const n = (counts.get(base) ?? 0) + 1;
    counts.set(base, n);
    const key = n === 1 ? base : `${base}#${n}`;
    obj.k.push(key);
    obj.v.set(key, regen && component && ch === idEl ? `<id>${id}</id>` : canonical(ch));
  }
  if (regen && component && !idEl) {
    obj.k.splice(obj.k.indexOf('name') + 1, 0, 'id');
    obj.v.set('id', `<id>${id}</id>`);
  }
}

// Base64 for attachments, in Node (Buffer) and in browsers and Base44 actors (btoa/atob).
function toBase64(bytes) {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(s) {
  if (typeof Buffer !== 'undefined') return Buffer.from(s, 'base64');
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

/** Builds a model from an OpenRocket XML document; attachments: Map<name, bytes>. */
export function fromXml(xml, attachments = new Map(), simIds = null) {
  const root = typeof xml === 'string' ? parse(xml) : xml;
  if (root.tag !== 'openrocket') throw new Error('Not an OpenRocket design (expected <openrocket>)');
  const m = emptyModel();
  m.objs.set(DOC, { t: root.tag, p: null, o: 0, k: [], v: new Map([[ATTRS, attrsCanonical(root.attrs)]]) });
  const rawCount = new Map();
  let haveRocket = false;
  let haveSims = false;
  let idx = 0;
  for (const c of root.elements()) {
    idx++;
    if (c.tag === 'rocket' && !haveRocket) {
      haveRocket = true;
      addObject(m, c, null, DOC, idx, true);
    } else if (c.tag === 'simulations' && !haveSims) {
      haveSims = true;
      m.objs.set(SIMS, { t: 'simulations', p: DOC, o: idx, k: [], v: new Map([[ATTRS, attrsCanonical(c.attrs)]]) });
      let j = 0;
      for (const s of c.elements()) {
        if (s.tag !== 'simulation') continue;
        addObject(m, s, simIds?.[j] ?? null, SIMS, j + 1, false);
        j++;
      }
    } else {
      const n = (rawCount.get(c.tag) ?? 0) + 1;
      rawCount.set(c.tag, n);
      m.objs.set(`doc:${c.tag}${n > 1 ? `#${n}` : ''}`, { t: RAW, p: DOC, o: idx, k: ['xml'], v: new Map([['xml', canonical(c)]]) });
    }
  }
  if (!haveRocket) throw new Error('The file contains no rocket');
  let pos = 1000;
  for (const [name, data] of [...attachments.entries()].sort((a, b) => cmp(a[0], b[0]))) {
    m.objs.set(`att:${name}`, { t: ATT, p: DOC, o: pos++, k: ['data'], v: new Map([[ATTRS, ''], ['data', toBase64(data)]]) });
  }
  return m;
}

export function toXml(m) {
  const idx = childIndex(m);
  const parts = ["<?xml version='1.0' encoding='utf-8'?>\n"];
  const emit = (id) => {
    const o = m.objs.get(id);
    if (o.t === RAW) {
      parts.push(o.v.get('xml') ?? '');
      return;
    }
    if (o.t === ATT) return;
    parts.push(`<${o.t}${o.v.get(ATTRS) ?? ''}>`);
    for (const key of o.k) {
      const val = o.v.get(key);
      if (val != null && !key.startsWith('#')) parts.push(val); // "#..." keys are sync metadata
    }
    const kids = idx.get(id);
    if (kids?.length) {
      const wrap = !(o.t === 'openrocket' || o.t === 'simulations');
      if (wrap) parts.push('<subcomponents>');
      for (const kid of kids) emit(kid);
      if (wrap) parts.push('</subcomponents>');
    }
    parts.push(`</${o.t}>`);
  };
  if (m.objs.has(DOC)) emit(DOC);
  parts.push('\n');
  return parts.join('');
}

export function attachments(m) {
  const out = new Map();
  for (const [id, o] of [...m.objs.entries()].sort((a, b) => cmp(a[0], b[0]))) {
    if (o.t === ATT && id.startsWith('att:')) out.set(id.slice(4), fromBase64(o.v.get('data') ?? ''));
  }
  return out;
}

/** Display names of rocket components, for activity messages. */
export function componentName(m, id) {
  const o = m.objs.get(id);
  const raw = o?.v.get('name');
  if (!raw) return null;
  try {
    return parse(raw).text();
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ operations

function wouldCycle(m, id, parent) {
  let guard = 0;
  for (let x = parent; x != null && guard++ < 100000; x = m.objs.get(x)?.p ?? null) {
    if (x === id) return true;
  }
  return false;
}

function order(requested, v, current) {
  const out = [];
  const seen = new Set();
  if (Array.isArray(requested)) {
    for (const x of requested) {
      if (typeof x === 'string' && x !== ATTRS && v.has(x) && !seen.has(x)) {
        seen.add(x);
        out.push(x);
      }
    }
  }
  for (const x of current) {
    if (v.has(x) && !seen.has(x)) {
      seen.add(x);
      out.push(x);
    }
  }
  for (const x of [...v.keys()].sort(cmp)) {
    if (x !== ATTRS && !seen.has(x)) {
      seen.add(x);
      out.push(x);
    }
  }
  return out;
}

const sameArray = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Applies one op. Returns the op as it should be broadcast (no-op parts removed), or null if
 * it was rejected or changed nothing.
 */
export function applyOp(m, op) {
  const id = op.id;
  switch (op.op) {
    case 'put': {
      const p = typeof op.p === 'string' ? op.p : null;
      if (p == null ? id !== DOC : !m.objs.has(p) || wouldCycle(m, id, p)) return null;
      const v = new Map();
      for (const [key, val] of Object.entries(op.v ?? {})) if (typeof val === 'string') v.set(key, val);
      const obj = { t: op.t, p, o: Number(op.o) || 0, k: order(op.k, v, []), v };
      const old = m.objs.get(id);
      if (old && old.t === obj.t && old.p === obj.p && old.o === obj.o && sameArray(old.k, obj.k)
        && old.v.size === v.size && [...v].every(([k, x]) => old.v.get(k) === x)) {
        return null;
      }
      m.objs.set(id, obj);
      return op;
    }
    case 'set': {
      const o = m.objs.get(id);
      if (!o || !op.v || typeof op.v !== 'object') return null;
      const changed = {};
      let any = false;
      for (const [key, val] of Object.entries(op.v)) {
        if (typeof val === 'string') {
          if (o.v.get(key) === val) continue;
          o.v.set(key, val);
          if (key !== ATTRS && !o.k.includes(key)) o.k.push(key);
        } else {
          if (!o.v.has(key)) continue;
          o.v.delete(key);
          const at = o.k.indexOf(key);
          if (at >= 0) o.k.splice(at, 1);
        }
        Object.defineProperty(changed, key, { value: typeof val === 'string' ? val : null, enumerable: true, writable: true, configurable: true });
        any = true;
      }
      let reordered = false;
      if (Array.isArray(op.k)) {
        const nk = order(op.k, o.v, o.k);
        reordered = !sameArray(nk, o.k);
        o.k = nk;
      }
      if (!any && !reordered) return null;
      const out = { op: 'set', id, v: changed };
      if (Array.isArray(op.k)) out.k = op.k;
      return out;
    }
    case 'move': {
      const o = m.objs.get(id);
      const p = typeof op.p === 'string' ? op.p : null;
      if (!o || id === DOC || p == null || !m.objs.has(p) || wouldCycle(m, id, p)) return null;
      const pos = Number(op.o) || 0;
      if (o.p === p && o.o === pos) return null;
      o.p = p;
      o.o = pos;
      return op;
    }
    case 'del': {
      if (!m.objs.has(id) || id === DOC) return null;
      const idx = childIndex(m);
      const stack = [id];
      while (stack.length) {
        const x = stack.pop();
        m.objs.delete(x);
        stack.push(...(idx.get(x) ?? []));
      }
      return op;
    }
    default:
      return null;
  }
}

// ------------------------------------------------------------------ validation

const LIMITS = { id: 512, tag: 128, key: 512, keys: 5000 };

/** Throws if an op is malformed. Values are checked for type, not content. */
export function validateOp(op) {
  if (!op || typeof op !== 'object') throw new Error('op must be an object');
  if (!['put', 'set', 'move', 'del'].includes(op.op)) throw new Error(`unknown op ${op.op}`);
  if (typeof op.id !== 'string' || !op.id || op.id.length > LIMITS.id) throw new Error('bad id');
  if (op.op === 'put' || op.op === 'move') {
    if (op.p != null && (typeof op.p !== 'string' || op.p.length > LIMITS.id)) throw new Error('bad parent');
    if (typeof op.o !== 'number' || !Number.isFinite(op.o)) throw new Error('bad position');
  }
  if (op.op === 'put' && (typeof op.t !== 'string' || !op.t || op.t.length > LIMITS.tag)) throw new Error('bad type');
  if (op.op === 'put' || op.op === 'set') {
    if (!op.v || typeof op.v !== 'object' || Array.isArray(op.v)) throw new Error('bad values');
    const keys = Object.keys(op.v);
    if (keys.length > LIMITS.keys) throw new Error('too many values');
    for (const k of keys) {
      if (k.length > LIMITS.key) throw new Error('bad key');
      const val = op.v[k];
      if (!(typeof val === 'string' || (val === null && op.op === 'set'))) throw new Error('bad value');
    }
    if (op.k != null && (!Array.isArray(op.k) || op.k.length > LIMITS.keys || op.k.some((x) => typeof x !== 'string'))) {
      throw new Error('bad key order');
    }
  }
}

export function modelSize(m) {
  let bytes = 0;
  for (const o of m.objs.values()) for (const val of o.v.values()) bytes += val.length;
  return { objects: m.objs.size, bytes };
}

export { El };
