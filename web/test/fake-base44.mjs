// An in-memory stand-in for Base44's entities, for the tests of the rules (base44/shared): equality
// filters (an array field matches any element, an array value means any of), sorting, bulkCreate,
// deleteMany, created_date/updated_date a second apart, and Base44's size limit: like Base44, it
// refuses a record with more than MAX_RECORD characters (measured on 2026-11-14 at about 20,000).
export const MAX_RECORD = 20_000;

export function fakeDb(names = ['Design', 'Motor', 'SavedFlight', 'Logbook', 'SealedPart', 'User']) {
  let clock = Date.parse('2026-01-01T00:00:00Z');
  const now = () => new Date((clock += 1000)).toISOString();
  const size = (r) => Object.values(r).reduce((n, v) => n + (typeof v === 'string' ? v.length : JSON.stringify(v ?? '').length), 0);
  const tooBig = (r) => {
    if (size(r) > MAX_RECORD) {
      const e = new Error('Record too large');
      e.status = 400;
      e.name = 'Base44Error';
      throw e;
    }
  };
  const table = () => {
    const rows = new Map();
    const matches = (r, query) => Object.entries(query).every(([k, v]) => {
      const have = Array.isArray(r[k]) ? r[k] : [r[k]];
      const want = Array.isArray(v) ? v : [v];
      return have.some((x) => want.includes(x));
    });
    const t = {
      rows,
      async filter(query, sort = '-created_date', limit = 5000) {
        const field = sort.replace(/^-/, '');
        const dir = sort.startsWith('-') ? -1 : 1;
        return [...rows.values()].filter((r) => matches(r, query))
          .sort((a, b) => (a[field] < b[field] ? -dir : a[field] > b[field] ? dir : 0)).slice(0, limit).map((r) => ({ ...r }));
      },
      async list(sort, limit) {
        return t.filter({}, sort, limit);
      },
      async get(id) {
        if (!rows.has(id)) throw new Error('not found');
        return { ...rows.get(id) };
      },
      async create(data) {
        const at = now();
        const r = { ...data, id: crypto.randomUUID().replace(/-/g, '').slice(0, 24), created_date: at, updated_date: at };
        tooBig(r);
        rows.set(r.id, r);
        return { ...r };
      },
      async bulkCreate(list) {
        const out = [];
        for (const d of list) out.push(await t.create(d));
        return out;
      },
      async update(id, data) {
        const r = { ...rows.get(id), ...data, updated_date: now() };
        tooBig(r);
        rows.set(id, r);
        return { ...r };
      },
      async delete(id) {
        rows.delete(id);
      },
      async deleteMany(query) {
        let n = 0;
        for (const [id, r] of [...rows]) {
          if (matches(r, query)) {
            rows.delete(id);
            n++;
          }
        }
        return { deleted: n };
      },
    };
    return t;
  };
  return Object.fromEntries(names.map((n) => [n, table()]));
}
