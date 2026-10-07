// Live-share hub. Each OpenRocket session's bridge connects here (internal port only).
// The server orders all edits to a project, applies them to the authoritative model,
// persists it, and rebroadcasts the accepted ops to every session of that project.
import { WebSocketServer } from 'ws';
import { createHash, randomBytes } from 'node:crypto';
import { projects, history, motors, edits } from './db.js';
import { sessionFileName } from './motors.js';
import { describeOp, inverseOf, isMinorOp, planRevert } from './edits.js';
import { fromJson, toJson, applyOp, validateOp, componentName, modelSize, SIMS, DOC } from './model.js';
import { publish } from './events.js';

const MAX_MODEL_BYTES = 400 * 1024 * 1024;
const MAX_OBJECTS = 200000;
const SAVE_DELAY_MS = 1500;
const UNLOAD_DELAY_MS = 60_000;

const rooms = new Map(); // projectId -> Room
let sessionLookup = () => null; // token -> session (set by sessions.js)

export function setSessionLookup(fn) {
  sessionLookup = fn;
}

const PALETTE = ['#e8590c', '#1c7ed6', '#2f9e44', '#ae3ec9', '#f08c00', '#0c8599', '#d6336c', '#5f3dc4', '#66a80f', '#c92a2a'];
export const colorFor = (userId) => PALETTE[createHash('sha1').update(userId).digest()[0] % PALETTE.length];

class Room {
  constructor(projectId) {
    const row = projects.model(projectId);
    if (!row) throw new Error('project not found');
    this.id = projectId;
    this.model = fromJson(JSON.parse(row.model));
    this.version = row.version;
    this.clients = new Map(); // clientId -> client
    this.lastSeq = new Map(); // session id -> last op batch seq applied
    this.saveTimer = null;
    this.unloadTimer = null;
    this.dirty = false;
  }

  persistSoon() {
    this.dirty = true;
    this.saveTimer ??= setTimeout(() => this.persist(), SAVE_DELAY_MS);
  }

  persist() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    if (!this.dirty) return;
    this.dirty = false;
    const json = JSON.stringify(toJson(this.model));
    projects.saveModel(this.id, json, this.version);
    history.maybeSnapshot(this.id, this.version, json);
  }

  broadcast(msg) {
    const text = JSON.stringify(msg);
    for (const c of this.clients.values()) if (c.ws.readyState === 1) c.ws.send(text);
  }

  presence() {
    const byUser = new Map();
    for (const c of this.clients.values()) {
      const entry = byUser.get(c.user.id) ?? {
        id: c.user.id,
        name: c.user.name,
        email: c.user.email,
        picture: c.user.picture,
        color: colorFor(c.user.id),
        role: c.role,
        selection: [],
      };
      for (const id of c.selection) {
        entry.selection.push({ id, name: componentName(this.model, id) ?? 'component' });
      }
      byUser.set(c.user.id, entry);
    }
    return [...byUser.values()];
  }

  publishPresence() {
    publish(this.id, { type: 'presence', members: this.presence() });
  }

  scheduleUnload() {
    clearTimeout(this.unloadTimer);
    this.unloadTimer = setTimeout(() => {
      if (this.clients.size) return;
      this.persist();
      rooms.delete(this.id);
    }, UNLOAD_DELAY_MS);
  }
}

export function room(projectId) {
  let r = rooms.get(projectId);
  if (!r) {
    r = new Room(projectId);
    rooms.set(projectId, r);
    r.scheduleUnload();
  }
  return r;
}

/** Current model of a project (live if someone has it open). */
export function currentModel(projectId) {
  const r = rooms.get(projectId);
  if (r) return { model: r.model, version: r.version };
  const row = projects.model(projectId);
  return row ? { model: fromJson(JSON.parse(row.model)), version: row.version } : null;
}

export function presenceOf(projectId) {
  return rooms.get(projectId)?.presence() ?? [];
}

export function forgetProject(projectId) {
  const r = rooms.get(projectId);
  if (!r) return;
  clearTimeout(r.saveTimer);
  clearTimeout(r.unloadTimer);
  for (const c of r.clients.values()) c.ws.close(4000, 'project closed');
  rooms.delete(projectId);
}

export function persistAll() {
  for (const r of rooms.values()) r.persist();
}

/** Short human summary of a batch of ops, e.g. "edited Nose cone, Body tube". */
function describe(model, ops) {
  const verbs = { put: 'added', del: 'removed', move: 'moved', set: 'edited' };
  const parts = [];
  const seen = new Set();
  for (const op of ops) {
    const obj = model.objs.get(op.id);
    if (!obj && op.op !== 'put') continue;
    const isSim = (obj?.p ?? op.p) === SIMS;
    const type = obj?.t ?? op.t;
    if (op.id === SIMS || op.id === DOC || type === '#att') continue;
    // Status/results updates come from OpenRocket re-running simulations by itself.
    if (isSim && op.op === 'set' && Object.keys(op.v ?? {}).every((k) => k === '@' || k === 'flightdata' || k.startsWith('#'))) continue;
    let name = componentName(model, op.id);
    if (op.op === 'put' && !name && op.v?.name) name = op.v.name.replace(/<[^>]+>/g, '');
    if (!name) continue;
    const verb = verbs[op.op];
    const label = `${verb} ${isSim ? `simulation “${name}”` : name}`;
    if (!seen.has(label)) {
      seen.add(label);
      parts.push(label);
    }
  }
  if (!parts.length) return null;
  return parts.length > 3 ? `${parts.slice(0, 3).join(', ')} and ${parts.length - 3} more` : parts.join(', ');
}

export function attachCollab(server) {
  const wss = new WebSocketServer({ server, path: '/collab', maxPayload: 256 * 1024 * 1024 });
  wss.on('connection', (ws) => {
    let client = null;
    let r = null;
    ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString('utf8'));
      } catch {
        return ws.close(1003, 'bad message');
      }
      if (!client) {
        const session = msg.type === 'hello' ? sessionLookup(msg.token) : null;
        if (!session) return ws.close(4001, 'unknown session');
        try {
          r = room(session.projectId);
        } catch {
          return ws.close(4004, 'project not found');
        }
        clearTimeout(r.unloadTimer);
        client = {
          id: randomBytes(6).toString('hex'),
          ws,
          session,
          user: session.user,
          get role() {
            return session.role; // follows sharing changes made while connected
          },
          selection: [],
        };
        r.clients.set(client.id, client);
        session.clientConnected?.();
        const project = projects.get(r.id);
        ws.send(JSON.stringify({
          type: 'welcome',
          clientId: client.id,
          version: r.version,
          lastSeq: r.lastSeq.get(session.id) ?? 0,
          name: project?.name ?? 'Rocket',
          role: client.role,
          model: toJson(r.model),
          // Custom motors of everyone the design is shared with; OpenRocket loads them at start.
          motors: motors.forProject(r.id).map((m) => ({ name: sessionFileName(m), content: m.content })),
        }));
        r.publishPresence();
        return;
      }
      switch (msg.type) {
        case 'ops':
          handleOps(r, client, msg);
          break;
        case 'presence':
          client.selection = Array.isArray(msg.selection) ? msg.selection.filter((x) => typeof x === 'string').slice(0, 50) : [];
          r.publishPresence();
          break;
        case 'attached':
          client.session.attached?.();
          break;
        default:
          break;
      }
    });
    ws.on('close', () => {
      if (!client) return;
      r.clients.delete(client.id);
      r.publishPresence();
      if (!r.clients.size) r.scheduleUnload();
    });
    ws.on('error', () => {});
  });
  return wss;
}

function handleOps(r, client, msg) {
  const seq = Number(msg.seq) || 0;
  const ack = () => client.ws.send(JSON.stringify({ type: 'ack', seq }));
  if (client.role === 'viewer' || !Array.isArray(msg.ops)) {
    if (client.role === 'viewer' && msg.ops?.length) {
      publish(r.id, { type: 'notice', message: 'You have view-only access; changes are not shared.' }, client.user.id);
    }
    r.lastSeq.set(client.session.id, seq);
    return ack();
  }
  r.lastSeq.set(client.session.id, seq);
  if (!applyBatch(r, client.user, msg.ops, { clientId: client.id, seq }).length) ack();
}

const pick = (obj, keys) => Object.fromEntries(Object.entries(obj ?? {}).filter(([k]) => keys.has(k)));

/**
 * Applies a batch of ops by `user`, records it in the edit history (with what it changed and
 * how to reverse it) and shares it with every open session. Returns the accepted ops.
 */
function applyBatch(r, user, ops, { clientId = null, seq = 0, note = null } = {}) {
  const accepted = [];
  const inverses = [];
  const changes = [];
  let minor = true;
  const removed = describe(r.model, ops.filter((op) => op?.op === 'del'));
  for (const op of ops) {
    try {
      validateOp(op);
    } catch (e) {
      console.warn(`[${r.id}] rejected op from ${user.email}: ${e.message}`);
      continue;
    }
    const inverse = inverseOf(r.model, op);
    const described = describeOp(r.model, op);
    const opMinor = isMinorOp(r.model, op);
    const applied = applyOp(r.model, op);
    if (!applied) continue;
    accepted.push(applied);
    if (!opMinor) minor = false;
    if (applied.op === 'set') {
      // No-op keys were dropped from the applied op; drop them from history too.
      const keys = new Set(Object.keys(applied.v));
      inverses.push(inverse
        .map((inv) => ({ ...inv, v: pick(inv.v, keys), expect: { values: pick(inv.expect?.values, keys) } }))
        .filter((inv) => Object.keys(inv.v).length || inv.k));
      changes.push(...described.filter((c) => keys.has(c.key)));
    } else {
      inverses.push(inverse);
      changes.push(...described);
    }
  }
  if (!accepted.length) return accepted;
  const size = modelSize(r.model);
  if (size.bytes > MAX_MODEL_BYTES || size.objects > MAX_OBJECTS) {
    console.error(`[${r.id}] model too large after edit (${size.objects} objects, ${size.bytes} bytes); reloading from disk`);
    forgetProject(r.id);
    return accepted;
  }
  r.version++;
  edits.add(r.id, { version: r.version, user, at: Date.now(), minor: minor && !note, changes, inverse: inverses.reverse().flat(), note });
  if (process.env.DEBUG_OPS === 'true') {
    const brief = accepted.map((op) => `${op.op} ${op.id.slice(0, 8)}${op.v ? `{${Object.keys(op.v).join(',')}}` : ''}`);
    console.log(`[${r.id.slice(0, 8)}] v${r.version} ${user.email} seq ${seq}: ${brief.join(' ')}`);
  }
  r.broadcast({ type: 'ops', version: r.version, from: clientId, seq, ops: accepted });
  r.persistSoon();
  const text = [describe(r.model, accepted.filter((op) => op.op !== 'del')), removed].filter(Boolean).join(', ');
  if (text || note) {
    publish(r.id, {
      type: 'activity',
      user: { id: user.id, name: user.name, color: colorFor(user.id) },
      text: note ? (note.kind === 'restore' ? 'restored an earlier version' : 'reverted an edit') : text,
      at: Date.now(),
    });
  }
  return accepted;
}

export class RevertError extends Error {}

/**
 * Reverts history. mode "undo": one person's edits in versions [from, to], skipping anything
 * changed again since. mode "restore": everything from version `from` on, by anyone.
 */
export function revertEdits(projectId, user, { mode, from, to, userId }) {
  const r = room(projectId);
  const first = edits.at(projectId, from);
  if (!first) throw new RevertError('That edit is no longer in the history.');
  const rows = edits.from(projectId, from);
  let chosen;
  if (mode === 'restore') {
    if (!rows.length || rows[0].version !== r.version || rows.length !== r.version - from + 1) {
      throw new RevertError('The history does not reach back that far. Use a saved copy instead.');
    }
    chosen = rows;
  } else {
    chosen = rows.filter((e) => e.version <= to && e.user_id === userId && !e.minor);
  }
  if (!chosen.length) throw new RevertError('Nothing to revert.');
  const { ops, skipped } = planRevert(r.model, chosen.flatMap((e) => JSON.parse(e.inverse)), mode);
  const note = mode === 'restore'
    ? { kind: 'restore', name: first.user_name, at: first.at }
    : { kind: 'undo', name: first.user_name, at: first.at };
  const applied = ops.length ? applyBatch(r, user, ops, { note }).length : 0;
  return { applied, skipped };
}
