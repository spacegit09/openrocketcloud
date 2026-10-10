// One room per design. Orders and merges everyone's edits, stores the design, keeps the edit
// history and saved copies, and speaks the live-share protocol of the Node hub
// (server/src/collab.js), so the OpenRocket bridge works unchanged.
//
// The room is plain JavaScript: entry.ts runs it inside the DesignRoom Base44 actor, and
// web/test/hub.mjs runs it locally for tests. The host passes in `env`:
//   storage            { get(key), put(key, value), delete(key), deleteAll() }
//   connections()      -> the open connections
//   user(conn)         -> { id, email, name } of the signed-in person, or null
//   access(user)       -> { role: 'owner' | 'editor' | 'viewer', name } for this design, or null
//   motors()           -> [{ name, content }] custom motors of everyone the design is shared with
//   touch(info)        records { version } on the design's listing (best effort)
// Connections are objects with an `id` and `send(message)`.
import { applyOp, childIndex, componentName, fromJson, modelSize, toJson, validateOp, SIMS, DOC } from './lib/model.js';
import { describeOp, groupEdits, inverseOf, isMinorOp, planRevert } from './lib/edits.js';

const BUCKETS = 64;
const CHUNK = 96_000; // characters per stored value
const FRAG = 400_000; // characters per WebSocket message
const SNAPSHOT_EVERY_MS = 10 * 60_000;
const SNAPSHOTS_KEPT = 50;
const EDITS_KEPT = 3000;
const HISTORY_ROWS = 300;
const MAX_MODEL_BYTES = 50 * 1024 * 1024;
const MAX_OBJECTS = 200_000;
const ROLE_TTL_MS = 10_000;

const PALETTE = ['#e8590c', '#1c7ed6', '#2f9e44', '#ae3ec9', '#f08c00', '#0c8599', '#d6336c', '#5f3dc4', '#66a80f', '#c92a2a'];

function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

export const colorFor = (userId) => PALETTE[hash(String(userId)) % PALETTE.length];

const objJson = (o) => ({ t: o.t, p: o.p, o: o.o, k: o.k, v: Object.fromEntries(o.v) });
const pick = (obj, keys) => Object.fromEntries(Object.entries(obj ?? {}).filter(([k]) => keys.has(k)));
const chunks = (s, n) => {
  const out = [];
  for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n));
  return out.length ? out : [''];
};

async function gzipBase64(text) {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function gunzipBase64(b64) {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

class RevertError extends Error {}

export class Room {
  constructor(env) {
    this.env = env;
    this.st = env.storage;
    this.meta = null; // { version, created, buckets: { b: parts }, lastSnapshotAt, editsFrom, snaps: [{ version, at, parts }] }
    this.model = null;
    this.clients = new Map(); // conn.id -> { user, role, roleAt, selection, frags }
    this.queue = Promise.resolve();
  }

  // Events are handled one at a time, in arrival order: handlers wait on storage and entity
  // lookups, and two edits must never interleave.
  serial(fn) {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  handleConnect(conn) {
    return this.serial(() => this.connect(conn));
  }

  handleMessage(conn, msg) {
    return this.serial(() => this.message(conn, msg));
  }

  handleClose(conn) {
    return this.serial(() => this.close(conn));
  }

  // ---------------------------------------------------------------- storage

  async start() {
    this.meta = (await this.st.get('meta')) ?? null;
    this.model = null;
    if (!this.meta) return;
    const objs = {};
    for (const [b, parts] of Object.entries(this.meta.buckets)) {
      let s = '';
      for (let p = 0; p < parts; p++) s += (await this.st.get(`b:${b}:${p}`)) ?? '';
      for (const [id, o] of JSON.parse(s || '[]')) {
        Object.defineProperty(objs, id, { value: o, enumerable: true, writable: true, configurable: true });
      }
    }
    this.model = fromJson({ objs });
  }

  async saveMeta() {
    await this.st.put('meta', this.meta);
  }

  /** Rewrites the stored buckets holding these object ids (present or deleted). */
  async writeBuckets(ids) {
    const touched = new Set([...ids].map((id) => hash(id) % BUCKETS));
    const members = new Map([...touched].map((b) => [b, []]));
    for (const [id, o] of this.model.objs) {
      const b = hash(id) % BUCKETS;
      if (members.has(b)) members.get(b).push([id, objJson(o)]);
    }
    for (const [b, entries] of members) {
      const old = this.meta.buckets[b] ?? 0;
      const parts = entries.length ? chunks(JSON.stringify(entries), CHUNK) : [];
      for (let p = 0; p < parts.length; p++) await this.st.put(`b:${b}:${p}`, parts[p]);
      for (let p = parts.length; p < old; p++) await this.st.delete(`b:${b}:${p}`);
      if (parts.length) this.meta.buckets[b] = parts.length;
      else delete this.meta.buckets[b];
    }
  }

  async snapshot(force = false) {
    if (!force && Date.now() - (this.meta.lastSnapshotAt ?? 0) < SNAPSHOT_EVERY_MS) return;
    const parts = chunks(await gzipBase64(JSON.stringify(toJson(this.model))), CHUNK);
    const version = this.meta.version;
    for (let p = 0; p < parts.length; p++) await this.st.put(`s:${version}:${p}`, parts[p]);
    this.meta.snaps = (this.meta.snaps ?? []).filter((s) => s.version !== version);
    this.meta.snaps.push({ version, at: Date.now(), parts: parts.length });
    while (this.meta.snaps.length > SNAPSHOTS_KEPT) {
      const old = this.meta.snaps.shift();
      for (let p = 0; p < old.parts; p++) await this.st.delete(`s:${old.version}:${p}`);
    }
    this.meta.lastSnapshotAt = Date.now();
  }

  async readSnapshot(version) {
    const snap = (this.meta.snaps ?? []).find((s) => s.version === version);
    if (!snap) return null;
    let b64 = '';
    for (let p = 0; p < snap.parts; p++) b64 += (await this.st.get(`s:${version}:${p}`)) ?? '';
    return JSON.parse(await gunzipBase64(b64));
  }

  async editRow(version) {
    const e = await this.st.get(`e:${version}`);
    return e ? { version, user_id: e.u, user_name: e.n, at: e.at, minor: e.minor, changes: e.changes, note: e.note, ip: e.ip } : null;
  }

  async editInverse(row) {
    let s = '';
    for (let p = 0; p < row.ip; p++) s += (await this.st.get(`ei:${row.version}:${p}`)) ?? '';
    return s ? JSON.parse(s) : [];
  }

  async trimEdits() {
    const keepFrom = this.meta.version - EDITS_KEPT;
    const from = this.meta.editsFrom ?? 1;
    if (keepFrom <= from) return;
    for (let v = from; v < keepFrom; v++) {
      const row = await this.editRow(v);
      if (!row) continue;
      for (let p = 0; p < row.ip; p++) await this.st.delete(`ei:${v}:${p}`);
      await this.st.delete(`e:${v}`);
    }
    this.meta.editsFrom = keepFrom;
  }

  // ---------------------------------------------------------------- connections

  /** The person behind a connection and their role, checked again every few seconds. */
  async client(conn, { fresh = false } = {}) {
    let c = this.clients.get(conn.id);
    if (!c) {
      const user = await this.env.user(conn);
      if (!user) return null;
      c = { user, role: null, roleAt: 0, name: null, selection: [], frags: new Map() };
      this.clients.set(conn.id, c);
    }
    if (fresh || Date.now() - c.roleAt > ROLE_TTL_MS) {
      const access = await this.env.access(c.user);
      c.role = access?.role ?? null;
      c.name = access?.name ?? null;
      c.roleAt = Date.now();
    }
    return c.role ? c : null;
  }

  /** Returns a reason to refuse the connection, or null. */
  async connect(conn) {
    const c = await this.client(conn, { fresh: true });
    if (!c) {
      this.clients.delete(conn.id);
      return 'You do not have access to this design.';
    }
    conn.send({
      type: 'hi',
      role: c.role,
      name: c.name,
      version: this.meta?.version ?? 0,
      empty: !this.model,
      you: { id: c.user.id, name: c.user.name, email: c.user.email, color: colorFor(c.user.id) },
    });
    this.broadcastPresence();
    return null;
  }

  close(conn) {
    this.clients.delete(conn.id);
    this.broadcastPresence();
  }

  connections() {
    return this.env.connections();
  }

  send(conn, msg) {
    const text = JSON.stringify(msg);
    if (text.length <= FRAG) return conn.send(msg);
    const fid = globalThis.crypto.randomUUID();
    const parts = chunks(text, FRAG);
    parts.forEach((s, i) => conn.send({ type: 'frag', fid, i, n: parts.length, s }));
  }

  broadcast(msg) {
    for (const conn of this.connections()) this.send(conn, msg);
  }

  presence() {
    const byUser = new Map();
    for (const conn of this.connections()) {
      const c = this.clients.get(conn.id);
      if (!c?.role) continue;
      const entry = byUser.get(c.user.id) ?? { id: c.user.id, name: c.user.name, email: c.user.email, color: colorFor(c.user.id), role: c.role, selection: [] };
      for (const id of c.selection) entry.selection.push({ id, name: (this.model && componentName(this.model, id)) ?? 'component' });
      byUser.set(c.user.id, entry);
    }
    return [...byUser.values()];
  }

  broadcastPresence() {
    this.broadcast({ type: 'presence', members: this.presence() });
  }

  // ---------------------------------------------------------------- messages

  async message(conn, msg) {
    if (!msg || typeof msg !== 'object') return;
    const c = await this.client(conn);
    if (!c) {
      this.send(conn, { type: 'kick', message: 'You no longer have access to this design.' });
      return;
    }
    if (msg.type === 'frag') {
      // A large message in pieces; handle it once all pieces have arrived.
      if (typeof msg.fid !== 'string' || !Number.isInteger(msg.i) || !Number.isInteger(msg.n) || msg.n > 2000) return;
      const parts = c.frags.get(msg.fid) ?? [];
      parts[msg.i] = String(msg.s ?? '');
      c.frags.set(msg.fid, parts);
      if (parts.filter((x) => x !== undefined).length < msg.n) return;
      c.frags.delete(msg.fid);
      let whole;
      try {
        whole = JSON.parse(parts.join(''));
      } catch {
        return;
      }
      return this.message(conn, whole);
    }
    if (msg.rid !== undefined) return this.request(conn, c, msg);
    switch (msg.type) {
      case 'hello':
        return this.welcome(conn, c);
      case 'ops':
        return this.ops(conn, c, msg);
      case 'presence':
        c.selection = Array.isArray(msg.selection) ? msg.selection.filter((x) => typeof x === 'string').slice(0, 50) : [];
        return this.broadcastPresence();
      default:
        return undefined;
    }
  }

  async welcome(conn, c) {
    if (!this.model) return this.send(conn, { type: 'error', message: 'This design has no content yet.' });
    const seqs = (await this.st.get('seqs')) ?? {};
    this.send(conn, {
      type: 'welcome',
      clientId: conn.id,
      version: this.meta.version,
      lastSeq: seqs[conn.id]?.[0] ?? 0,
      name: c.name ?? 'Rocket',
      role: c.role,
      model: toJson(this.model),
      // Custom motors of everyone the design is shared with; OpenRocket loads them at start.
      motors: await this.env.motors(),
    });
  }

  async ops(conn, c, msg) {
    const seq = Number(msg.seq) || 0;
    const seqs = (await this.st.get('seqs')) ?? {};
    seqs[conn.id] = [seq, Date.now()];
    const entries = Object.entries(seqs).sort((a, b) => b[1][1] - a[1][1]).slice(0, 200);
    await this.st.put('seqs', Object.fromEntries(entries));
    if (c.role === 'viewer' || !Array.isArray(msg.ops) || !this.model) {
      if (c.role === 'viewer' && msg.ops?.length) {
        this.send(conn, { type: 'notice', message: 'You have view-only access; your changes are not shared.' });
      }
      return this.send(conn, { type: 'ack', seq });
    }
    if (!(await this.applyBatch(c.user, msg.ops, { clientId: conn.id, seq })).length) this.send(conn, { type: 'ack', seq });
  }

  /** Short human summary of a batch, e.g. "edited Nose cone, Body tube". */
  describe(ops) {
    const verbs = { put: 'added', del: 'removed', move: 'moved', set: 'edited' };
    const parts = [];
    const seen = new Set();
    for (const op of ops) {
      const obj = this.model.objs.get(op.id);
      if (!obj && op.op !== 'put') continue;
      const isSim = (obj?.p ?? op.p) === SIMS;
      const type = obj?.t ?? op.t;
      if (op.id === SIMS || op.id === DOC || type === '#att') continue;
      // Status/results updates come from OpenRocket re-running simulations by itself.
      if (isSim && op.op === 'set' && Object.keys(op.v ?? {}).every((k) => k === '@' || k === 'flightdata' || k.startsWith('#'))) continue;
      let name = componentName(this.model, op.id);
      if (op.op === 'put' && !name && op.v?.name) name = op.v.name.replace(/<[^>]+>/g, '');
      if (!name) continue;
      const label = `${verbs[op.op]} ${isSim ? `simulation “${name}”` : name}`;
      if (!seen.has(label)) {
        seen.add(label);
        parts.push(label);
      }
    }
    if (!parts.length) return null;
    return parts.length > 3 ? `${parts.slice(0, 3).join(', ')} and ${parts.length - 3} more` : parts.join(', ');
  }

  /** Applies a batch by `user`, records it in the history and shares it. Returns accepted ops. */
  async applyBatch(user, ops, { clientId = null, seq = 0, note = null } = {}) {
    const accepted = [];
    const inverses = [];
    const changes = [];
    const touched = new Set();
    let minor = true;
    const removedText = this.describe(ops.filter((op) => op?.op === 'del'));
    for (const op of ops) {
      try {
        validateOp(op);
      } catch {
        continue;
      }
      const inverse = inverseOf(this.model, op);
      const described = describeOp(this.model, op);
      const opMinor = isMinorOp(this.model, op);
      const removed = [];
      if (op.op === 'del' && this.model.objs.has(op.id)) {
        const idx = childIndex(this.model);
        const stack = [op.id];
        while (stack.length) {
          const x = stack.pop();
          removed.push(x);
          stack.push(...(idx.get(x) ?? []));
        }
      }
      const applied = applyOp(this.model, op);
      if (!applied) continue;
      accepted.push(applied);
      if (op.op === 'del') removed.forEach((x) => touched.add(x));
      else touched.add(op.id);
      if (!opMinor) minor = false;
      if (applied.op === 'set') {
        // No-op keys were dropped from the applied op; drop them from history too.
        const keys = new Set(Object.keys(applied.v));
        inverses.push(inverse
          .map((inv) => ({ ...inv, v: pick(inv.v, keys), expect: { values: pick(inv.expect?.values, keys) } }))
          .filter((inv) => Object.keys(inv.v).length || inv.k));
        changes.push(...described.filter((ch) => keys.has(ch.key)));
      } else {
        inverses.push(inverse);
        changes.push(...described);
      }
    }
    if (!accepted.length) return accepted;
    const size = modelSize(this.model);
    if (size.bytes > MAX_MODEL_BYTES || size.objects > MAX_OBJECTS) {
      await this.start(); // drop the oversized edit
      return [];
    }
    this.meta.version++;
    const version = this.meta.version;
    const inverse = chunks(JSON.stringify(inverses.reverse().flat()), CHUNK);
    await this.writeBuckets(touched);
    await this.st.put(`e:${version}`, { u: user.id, n: user.name, at: Date.now(), minor: minor && !note, changes: JSON.stringify(changes), note: note ? JSON.stringify(note) : null, ip: inverse.length });
    for (let p = 0; p < inverse.length; p++) await this.st.put(`ei:${version}:${p}`, inverse[p]);
    if (version % 200 === 0) await this.trimEdits();
    await this.snapshot();
    await this.saveMeta();
    this.broadcast({ type: 'ops', version, from: clientId, seq, ops: accepted });
    const text = [this.describe(accepted.filter((op) => op.op !== 'del')), removedText].filter(Boolean).join(', ');
    if (text || note) {
      this.broadcast({
        type: 'activity',
        user: { id: user.id, name: user.name, color: colorFor(user.id) },
        text: note ? (note.kind === 'restore' ? 'restored an earlier version' : 'reverted an edit') : text,
        at: Date.now(),
      });
    }
    if (Date.now() - (this.lastTouchAt ?? 0) > 60_000) {
      this.lastTouchAt = Date.now();
      Promise.resolve(this.env.touch({ version })).catch(() => {});
    }
    return accepted;
  }

  // ---------------------------------------------------------------- page requests

  async request(conn, c, msg) {
    const reply = (data) => this.send(conn, { type: 'reply', rid: msg.rid, ok: true, data });
    const fail = (message) => this.send(conn, { type: 'reply', rid: msg.rid, ok: false, error: message });
    try {
      switch (msg.type) {
        case 'init':
          return reply(await this.init(c, msg));
        case 'export':
          if (!this.model) return fail('This design has no content yet.');
          return reply({ model: toJson(this.model), version: this.meta.version });
        case 'history':
          return reply(await this.history(Number(msg.before) || Number.MAX_SAFE_INTEGER));
        case 'revert':
          if (c.role === 'viewer') return fail('You have view-only access.');
          return reply(await this.revert(c.user, msg));
        case 'snapshots':
          return reply((this.meta?.snaps ?? []).slice().reverse().map((s) => ({ version: s.version, createdAt: s.at })));
        case 'snapshot': {
          const model = this.meta ? await this.readSnapshot(Number(msg.version)) : null;
          return model ? reply({ model, version: Number(msg.version) }) : fail('That saved copy no longer exists.');
        }
        case 'destroy':
          if (c.role !== 'owner') return fail('Only the owner can delete this design.');
          this.broadcast({ type: 'kick', message: 'This design was deleted.' });
          await this.st.deleteAll();
          this.meta = null;
          this.model = null;
          return reply({ ok: true });
        default:
          return fail('Unknown request.');
      }
    } catch (e) {
      if (e instanceof RevertError) return fail(e.message);
      console.error('request failed', msg.type, e);
      return fail('Something went wrong.');
    }
  }

  /** Stores the design's first content (blank, example or upload), sent by its owner. */
  async init(c, msg) {
    if (this.model) throw new RevertError('This design already has content.');
    if (c.role !== 'owner') throw new RevertError('Only the owner can set up this design.');
    const model = fromJson(msg.model);
    if (!model.objs.has(DOC) || ![...model.objs.values()].some((o) => o.t === 'rocket')) throw new RevertError('That is not an OpenRocket design.');
    const size = modelSize(model);
    if (size.bytes > MAX_MODEL_BYTES || size.objects > MAX_OBJECTS) throw new RevertError('That design is too large.');
    this.model = model;
    this.meta = { version: 0, created: Date.now(), buckets: {}, lastSnapshotAt: 0, editsFrom: 1, snaps: [] };
    await this.writeBuckets(model.objs.keys());
    await this.snapshot(true);
    await this.saveMeta();
    return { version: 0 };
  }

  async history(before) {
    const rows = [];
    const from = this.meta?.editsFrom ?? 1;
    for (let v = Math.min(before - 1, this.meta?.version ?? 0); v >= from && rows.length < HISTORY_ROWS; v--) {
      const row = await this.editRow(v);
      if (row) rows.push(row);
    }
    const groups = groupEdits(rows, 40);
    const last = groups.at(-1);
    const more = last && (rows.some((r) => r.version < last.from && !r.minor) || (rows.length === HISTORY_ROWS));
    return { groups: groups.map((g) => ({ ...g, color: colorFor(g.userId) })), nextBefore: more ? last.from : null };
  }

  async revert(user, { mode, from, to, userId }) {
    if (!['undo', 'restore'].includes(mode) || !Number.isInteger(from)) throw new RevertError('Bad request.');
    const first = await this.editRow(from);
    if (!first) throw new RevertError('That edit is no longer in the history.');
    const rows = [];
    for (let v = this.meta.version; v >= from; v--) {
      const row = await this.editRow(v);
      if (row) rows.push(row);
    }
    let chosen;
    if (mode === 'restore') {
      if (!rows.length || rows[0].version !== this.meta.version || rows.length !== this.meta.version - from + 1) {
        throw new RevertError('The history does not reach back that far. Use a saved copy instead.');
      }
      chosen = rows;
    } else {
      const last = Number(to) || from;
      chosen = rows.filter((e) => e.version <= last && e.user_id === String(userId ?? '') && !e.minor);
    }
    if (!chosen.length) throw new RevertError('Nothing to revert.');
    const inverse = [];
    for (const e of chosen) inverse.push(...(await this.editInverse(e)));
    const { ops, skipped } = planRevert(this.model, inverse, mode);
    const note = { kind: mode, name: first.user_name, at: first.at };
    const applied = ops.length ? (await this.applyBatch(user, ops, { note })).length : 0;
    return { applied, skipped };
  }
}
