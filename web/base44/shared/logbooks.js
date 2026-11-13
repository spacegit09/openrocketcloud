// Flight logbooks: who may do what, checked here for the signed-in person (the logbooks function
// wraps this; test/logbook-api.test.mjs runs it against an in-memory stand-in for Base44).
//
// Logbook record: { id, people, sealed, version, edited_at }, sealed (sealed.js):
//   people   lookup keys of the owner and members
//   sealed   { title, owner_email, owner_name, members, details, description, notes,
//              datasets: [descriptor, data], media: [item, look, thumb], spark, cover }
// Each data set's rows and each picture's preview are sealed and kept on their own (parts.js:
// `data`, `look`), so that a logbook's record stays small (Base44 refuses big ones) and a change
// rewrites only what changed. Listing opens only `sealed`. Logbooks saved before kept rows and
// previews together in `sealed_data` ({ rows: {id: rows}, previews: {id: data URL} }); they are
// read from there. The owner shares and deletes; editors change the rest; viewers read.
// Photos and videos are Base44 private files: the page uploads them and records them here; their
// signed links come from here (files.sign), for everyone the logbook is shared with.
//   ctx = { db, s: sealer(DATA_KEY), me: { id, email, name }, files: { sign(uri) -> url } }
import { cleanMembers, fail, newRoom } from './api.js';
import { drop, loadAll, store, withParts } from './parts.js';
import { roleIn } from './sealed.js';

const NOT_FOUND = 'Logbook not found. It may have been deleted, or it is not shared with you.';
const DETAILS = ['date', 'time', 'location', 'rocket', 'motor', 'weather', 'outcome'];
const QUANTITIES = new Set(['altitude', 'velocity', 'acceleration', 'custom']);
const SOURCES = new Set(['entered', 'openrocket', 'planner']);
const MAX_TEXT = 20_000;
const MAX_DATASETS = 20;
const MAX_COLUMNS = 12;
const MAX_ROWS = 50_000;
const MAX_DATA_CHARS = 3_000_000; // a data set, sealed (compressed)
const MAX_MEDIA = 50;
const MAX_PREVIEW_CHARS = 300_000;
const MAX_THUMB_CHARS = 16_000;

const str = (v, max) => String(v ?? '').slice(0, max);
const newId = () => newRoom().slice(0, 12);

function cleanTitle(title) {
  const t = String(title ?? '').trim();
  if (!t) fail(400, 'Enter a title.');
  return t.slice(0, 200);
}

function cleanDetails(d, keep = {}) {
  const out = { ...keep };
  for (const k of DETAILS) if (d && k in d) out[k] = str(d[k], 200).trim();
  return out;
}

/** A data set as sent by the page, checked: { descriptor, rows }. */
function cleanDataset(d) {
  if (!d || typeof d !== 'object') fail(400, 'No data set.');
  const columns = Array.isArray(d.columns) ? d.columns : [];
  if (!columns.length || columns.length > MAX_COLUMNS) fail(400, `A data set needs 1 to ${MAX_COLUMNS} columns besides time.`);
  const cols = columns.map((c) => {
    if (!QUANTITIES.has(c?.q)) fail(400, 'Unknown kind of column.');
    return { q: c.q, unit: str(c.unit, 20), name: str(c.name, 60).trim() };
  });
  const rows = Array.isArray(d.rows) ? d.rows : [];
  if (rows.length < 2 || rows.length > MAX_ROWS) fail(400, `A data set needs 2 to ${MAX_ROWS.toLocaleString('en')} rows.`);
  for (const r of rows) {
    if (!Array.isArray(r) || r.length !== cols.length + 1 || !r.every((x) => typeof x === 'number' && Number.isFinite(x))) {
      fail(400, 'Every row needs a number for time and for each column.');
    }
  }
  return {
    descriptor: {
      id: newId(),
      name: str(d.name, 120).trim() || 'Flight data',
      source: SOURCES.has(d.source) ? d.source : 'entered',
      time: d.time === 'ms' ? 'ms' : 's',
      offset: Number.isFinite(Number(d.offset)) ? Number(d.offset) : 0,
      columns: cols,
      count: rows.length,
      from: d.from && typeof d.from === 'object' ? Object.fromEntries(Object.entries(d.from).map(([k, v]) => [str(k, 30), str(v, 200)])) : null,
    },
    rows,
  };
}

function cleanMedia(m) {
  if (!m || typeof m !== 'object') fail(400, 'No file.');
  const uri = str(m.file_uri, 500);
  if (!uri) fail(400, 'The file was not uploaded.');
  const image = (v, max) => (typeof v === 'string' && /^data:image\/(jpeg|png|webp);base64,/.test(v) && v.length <= max ? v : null);
  const preview = image(m.preview, MAX_PREVIEW_CHARS);
  return {
    item: {
      id: newId(),
      kind: m.kind === 'video' ? 'video' : 'photo',
      file_uri: uri,
      name: str(m.name, 200),
      type: str(m.type, 100),
      size: Number(m.size) || 0,
      w: Number(m.w) || null,
      h: Number(m.h) || null,
      duration: Number(m.duration) || null,
      caption: str(m.caption, 500),
      thumb: image(m.thumb, MAX_THUMB_CHARS),
    },
    preview,
  };
}

/** A small curve of the first altitude column (or the first column) for the logbook's card. */
async function sparkline(datasets, rowsOf) {
  const ds = datasets.find((d) => d.columns.some((c) => c.q === 'altitude')) ?? datasets[0];
  const data = ds ? await rowsOf(ds) : null;
  if (!data || data.length < 2) return null;
  const j = Math.max(0, ds.columns.findIndex((c) => c.q === 'altitude')) + 1;
  const n = Math.min(48, data.length);
  const out = [];
  for (let i = 0; i < n; i++) {
    const r = data[Math.round((i * (data.length - 1)) / (n - 1))];
    out.push([r[0], r[j]]);
  }
  return out;
}

/** The logbook the page sees: everything, the data sets with their rows, the media with previews. */
function full(r, meta, data, role) {
  return {
    id: r.id,
    role,
    title: meta.title,
    owner_email: meta.owner_email,
    owner_name: meta.owner_name,
    members: meta.members ?? [],
    details: meta.details ?? {},
    description: meta.description ?? '',
    notes: meta.notes ?? '',
    datasets: (meta.datasets ?? []).map(({ data: _kept, ...d }) => ({ ...d, rows: data.rows?.[d.id] ?? [] })),
    media: (meta.media ?? []).map(({ look: _kept, file_uri: _uri, ...m }) => ({ ...m, preview: data.previews?.[m.id] ?? null })),
    version: r.version ?? 0,
    edited_at: r.edited_at ?? r.updated_date,
    created_date: r.created_date,
    updated_date: r.updated_date,
  };
}

/** A logbook's card: no data, no media files. */
function card(r, meta, role) {
  const media = meta.media ?? [];
  return {
    id: r.id,
    role,
    title: meta.title,
    owner_email: meta.owner_email,
    owner_name: meta.owner_name,
    members: meta.members ?? [],
    details: meta.details ?? {},
    datasets: (meta.datasets ?? []).length,
    photos: media.filter((m) => m.kind === 'photo').length,
    videos: media.filter((m) => m.kind === 'video').length,
    spark: meta.spark ?? null,
    cover: meta.cover ?? null,
    edited_at: r.edited_at ?? r.updated_date,
    updated_date: r.updated_date,
  };
}

export async function logbooksApi({ db: raw, s, me, files }, body) {
  const db = withParts(raw);
  // Sealed rows and previews, each kept on its own (parts.js).
  const keep = async (value) => store(raw, await s.seal(value), { always: true });
  const find = async (id) => {
    const rid = String(id ?? '');
    const r = rid ? await db.Logbook.get(rid).catch(() => null) : null;
    if (!r?.sealed) fail(404, NOT_FOUND);
    const meta = await s.open(r.sealed);
    const role = roleIn({ owner_email: meta.owner_email, members: meta.members ?? [] }, me.email);
    if (!role) fail(404, NOT_FOUND);
    return { r, meta, role };
  };
  // Every data set's rows and picture's preview, read together (and from `sealed_data` for a
  // logbook saved before they were kept on their own).
  const contents = async (r, meta) => {
    const old = r.sealed_data ? await s.open(r.sealed_data) : { rows: {}, previews: {} };
    const sets = (meta.datasets ?? []).filter((d) => d.data);
    const looks = (meta.media ?? []).filter((m) => m.look);
    const texts = await loadAll(raw, [...sets.map((d) => d.data), ...looks.map((m) => m.look)]);
    const data = { rows: { ...(old.rows ?? {}) }, previews: { ...(old.previews ?? {}) } };
    for (const [i, d] of sets.entries()) data.rows[d.id] = await s.open(texts[i]);
    for (const [i, m] of looks.entries()) data.previews[m.id] = await s.open(texts[sets.length + i]);
    return data;
  };
  const rowsOf = async (r, d) => (d.data ? s.open((await loadAll(raw, [d.data]))[0]) : (r.sealed_data ? (await s.open(r.sealed_data)).rows?.[d.id] : null));
  const editor = (role) => {
    if (role === 'viewer') fail(403, 'You can view this logbook but not change it.');
  };
  const owner = (role) => {
    if (role !== 'owner') fail(403, 'Only the owner can do that.');
  };
  // Saves the logbook's record (people and the sealed logbook), one version later.
  const save = async (r, meta) => {
    const people = [meta.owner_email, ...(meta.members ?? []).map((m) => m.email)];
    const fields = {
      people: await Promise.all(people.map((e) => s.lookupKey(e))),
      sealed: await s.seal(meta),
      version: (r.version ?? 0) + 1,
      edited_at: new Date().toISOString(),
    };
    const updated = await db.Logbook.update(r.id, fields);
    return { ...r, ...fields, ...(updated ?? {}) };
  };
  // The logbook as the page sees it, after a change.
  const after = async (r, meta, role) => {
    const saved = await save(r, meta);
    return full(saved, meta, await contents(saved, meta), role);
  };
  // The card's cover: the first photo's thumbnail (or any picture's).
  const cover = (meta) => {
    const m = (meta.media ?? []).find((x) => x.kind === 'photo' && x.thumb) ?? (meta.media ?? []).find((x) => x.thumb);
    meta.cover = m ? m.thumb : null;
  };

  switch (body?.action) {
    case 'list': {
      const key = await s.lookupKey(me.email);
      const out = [];
      for (const r of await db.Logbook.filter({ people: key }, '-edited_at', 500)) {
        if (!r.people?.includes(key) || !r.sealed) continue;
        const meta = await s.open(r.sealed);
        const role = roleIn({ owner_email: meta.owner_email, members: meta.members ?? [] }, me.email);
        if (role) out.push(card(r, meta, role));
      }
      return out;
    }
    case 'get': {
      const { r, meta, role } = await find(body.id);
      return full(r, meta, await contents(r, meta), role);
    }
    case 'create': {
      const meta = {
        title: cleanTitle(body.title),
        owner_email: me.email,
        owner_name: me.name,
        members: [],
        details: cleanDetails(body.details),
        description: '',
        notes: '',
        datasets: [],
        media: [],
        spark: null,
        cover: null,
      };
      const people = [await s.lookupKey(me.email)];
      const r = await db.Logbook.create({ people, sealed: await s.seal(meta), version: 0, edited_at: new Date().toISOString() });
      return full(r, meta, { rows: {}, previews: {} }, 'owner');
    }
    case 'update': {
      const { r, meta, role } = await find(body.id);
      editor(role);
      if ('title' in body) meta.title = cleanTitle(body.title);
      if ('details' in body) meta.details = cleanDetails(body.details, meta.details);
      if ('description' in body) meta.description = str(body.description, MAX_TEXT);
      if ('notes' in body) meta.notes = str(body.notes, MAX_TEXT);
      return after(r, meta, role);
    }
    case 'addDataset': {
      const { r, meta, role } = await find(body.id);
      editor(role);
      if ((meta.datasets ?? []).length >= MAX_DATASETS) fail(400, `A logbook holds up to ${MAX_DATASETS} data sets.`);
      const { descriptor, rows } = cleanDataset(body.dataset);
      const sealed = await s.seal(rows);
      if (sealed.length > MAX_DATA_CHARS) fail(413, 'This data set is too large: thin it out first (every second or tenth row).');
      descriptor.data = await store(raw, sealed, { always: true });
      meta.datasets = [...(meta.datasets ?? []), descriptor];
      meta.spark = await sparkline(meta.datasets, (d) => (d.id === descriptor.id ? rows : rowsOf(r, d)));
      return after(r, meta, role);
    }
    case 'updateDataset': {
      const { r, meta, role } = await find(body.id);
      editor(role);
      const d = (meta.datasets ?? []).find((x) => x.id === body.datasetId);
      if (!d) fail(404, 'That data set is no longer in this logbook.');
      if ('name' in body) d.name = str(body.name, 120).trim() || d.name;
      if ('offset' in body && Number.isFinite(Number(body.offset))) d.offset = Number(body.offset);
      if ('hidden' in body) d.hidden = Boolean(body.hidden);
      return after(r, meta, role);
    }
    case 'removeDataset': {
      const { r, meta, role } = await find(body.id);
      editor(role);
      const gone = (meta.datasets ?? []).find((x) => x.id === body.datasetId);
      meta.datasets = (meta.datasets ?? []).filter((x) => x.id !== body.datasetId);
      meta.spark = await sparkline(meta.datasets, (d) => rowsOf(r, d));
      const out = await after(r, meta, role);
      if (gone?.data) await drop(raw, gone.data);
      return out;
    }
    case 'addMedia': {
      const { r, meta, role } = await find(body.id);
      editor(role);
      if ((meta.media ?? []).length >= MAX_MEDIA) fail(400, `A logbook holds up to ${MAX_MEDIA} photos and videos.`);
      const { item, preview } = cleanMedia(body.item);
      if (preview) item.look = await keep(preview);
      meta.media = [...(meta.media ?? []), item];
      cover(meta);
      return { ...(await after(r, meta, role)), added: item.id };
    }
    case 'updateMedia': {
      const { r, meta, role } = await find(body.id);
      editor(role);
      const m = (meta.media ?? []).find((x) => x.id === body.mediaId);
      if (!m) fail(404, 'That photo or video is no longer in this logbook.');
      m.caption = str(body.caption, 500);
      return after(r, meta, role);
    }
    case 'removeMedia': {
      const { r, meta, role } = await find(body.id);
      editor(role);
      const gone = (meta.media ?? []).find((x) => x.id === body.mediaId);
      meta.media = (meta.media ?? []).filter((x) => x.id !== body.mediaId);
      cover(meta);
      const out = await after(r, meta, role);
      if (gone?.look) await drop(raw, gone.look);
      return out;
    }
    case 'mediaUrls': {
      // Links for an hour to the logbook's photos and videos (Base44 private files).
      const { meta } = await find(body.id);
      const want = Array.isArray(body.mediaIds) ? new Set(body.mediaIds) : null;
      const out = {};
      for (const m of meta.media ?? []) {
        if (want && !want.has(m.id)) continue;
        out[m.id] = await files.sign(m.file_uri).catch(() => null);
      }
      return out;
    }
    case 'people': {
      const { meta } = await find(body.id);
      return { owner_email: meta.owner_email, owner_name: meta.owner_name, members: meta.members ?? [] };
    }
    case 'share': {
      const { r, meta, role } = await find(body.id);
      owner(role);
      meta.members = cleanMembers(body.members, meta.owner_email);
      await save(r, meta);
      return { owner_email: meta.owner_email, owner_name: meta.owner_name, members: meta.members };
    }
    case 'leave': {
      const { r, meta, role } = await find(body.id);
      if (role === 'owner') fail(400, 'You own this logbook. Delete it instead.');
      meta.members = (meta.members ?? []).filter((m) => m.email.toLowerCase() !== me.email);
      await save(r, meta);
      return { ok: true };
    }
    case 'delete': {
      const { r, meta, role } = await find(body.id);
      owner(role);
      await db.Logbook.delete(r.id);
      for (const v of [...(meta.datasets ?? []).map((d) => d.data), ...(meta.media ?? []).map((m) => m.look)]) await drop(raw, v);
      return { ok: true };
    }
    default:
      return fail(400, 'Unknown action.');
  }
}
