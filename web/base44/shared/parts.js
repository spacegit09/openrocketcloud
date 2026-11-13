// Base44 refuses a record over about 20,000 characters (measured on 2026-11-14: a sealed field of
// about 19,000 characters saved, 21,600 did not). Sealed values longer than PART are kept in
// SealedPart records of PART characters each, and the field holds "parts:<key>" instead.
// withParts(db) does this for every field whose name starts with "sealed": the rules (api.js,
// logbooks.js) read and write whole values, and the parts are written, read in one query, and
// removed with the value they belong to. store/loadAll/drop do the same for values kept elsewhere
// (a logbook's data sets and pictures).
//   SealedPart record: { key, i (0, 1, ...), n (how many), text }
export const PART = 12_000;
const PREFIX = 'parts:';

export const isParts = (v) => typeof v === 'string' && v.startsWith(PREFIX);
const newKey = () => [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, '0')).join('');

/** The value to keep for `text`: itself if it is short (unless `always`), or a reference to its parts. */
export async function store(db, text, { always = false } = {}) {
  if (typeof text !== 'string' || (!always && text.length <= PART)) return text;
  const key = newKey();
  const n = Math.max(1, Math.ceil(text.length / PART));
  const parts = Array.from({ length: n }, (_, i) => ({ key, i, n, text: text.slice(i * PART, (i + 1) * PART) }));
  for (let i = 0; i < parts.length; i += 8) {
    const batch = parts.slice(i, i + 8);
    try {
      await db.SealedPart.bulkCreate(batch);
    } catch {
      for (const p of batch) await db.SealedPart.create(p);
    }
  }
  return PREFIX + key;
}

/** The texts for kept values (themselves, or references to parts), the parts read in one go. */
export async function loadAll(db, values) {
  const keys = [...new Set(values.filter(isParts).map((v) => v.slice(PREFIX.length)))];
  const byKey = new Map();
  for (let i = 0; i < keys.length; i += 100) {
    for (const p of await db.SealedPart.filter({ key: keys.slice(i, i + 100) }, 'i', 10_000)) {
      if (!byKey.has(p.key)) byKey.set(p.key, []);
      byKey.get(p.key).push(p);
    }
  }
  return values.map((v) => {
    if (!isParts(v)) return v;
    const parts = (byKey.get(v.slice(PREFIX.length)) ?? []).sort((a, b) => a.i - b.i);
    if (!parts.length || parts.length !== parts[0].n) throw new Error('Stored data is incomplete.');
    return parts.map((p) => p.text).join('');
  });
}

/** Removes a kept value's parts, if it has any. */
export async function drop(db, value) {
  if (isParts(value)) await db.SealedPart.deleteMany({ key: value.slice(PREFIX.length) }).catch(() => {});
}

const sealedKeys = (o) => Object.keys(o ?? {}).filter((k) => k.startsWith('sealed'));

/** `db` with long sealed fields kept in parts, out of sight of the rules using it. */
export function withParts(db) {
  const tables = new Map();
  const wrap = (name) => {
    const t = db[name];
    if (!t || name === 'SealedPart') return t;
    const read = async (rows) => {
      const plain = rows.filter(Boolean);
      const slots = plain.flatMap((r) => sealedKeys(r).map((k) => [r, k]));
      const texts = await loadAll(db, slots.map(([r, k]) => r[k]));
      const out = new Map(plain.map((r) => [r, { ...r }]));
      slots.forEach(([r, k], i) => (out.get(r)[k] = texts[i]));
      return rows.map((r) => (r ? out.get(r) : r));
    };
    const keep = async (data) => {
      const out = { ...data };
      for (const k of sealedKeys(data)) out[k] = await store(db, data[k]);
      return out;
    };
    return {
      async filter(query, sort, limit) {
        return read(await t.filter(query, sort, limit));
      },
      async list(sort, limit) {
        return read(await t.list(sort, limit));
      },
      async get(id) {
        return (await read([await t.get(id)]))[0];
      },
      async create(data) {
        const r = await t.create(await keep(data));
        return { ...r, ...data };
      },
      async update(id, data) {
        const keys = sealedKeys(data);
        const before = keys.length ? await t.get(id).catch(() => null) : null;
        const kept = await keep(data);
        const r = await t.update(id, kept);
        for (const k of keys) if (before && before[k] !== kept[k]) await drop(db, before[k]);
        return { ...r, ...data };
      },
      async delete(id) {
        const before = await t.get(id).catch(() => null);
        await t.delete(id);
        for (const k of sealedKeys(before)) await drop(db, before[k]);
      },
    };
  };
  return new Proxy({}, {
    get(_, name) {
      if (typeof name !== 'string') return undefined;
      if (!tables.has(name)) tables.set(name, wrap(name));
      return tables.get(name);
    },
  });
}
