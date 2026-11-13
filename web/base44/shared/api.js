// What the site may do with designs, motors and saved launch plans, checked here for the signed-in
// person. Design, Motor and SavedFlight records hold only sealed data (sealed.js) and are closed to
// direct access, so the backend functions (functions/designs, functions/motors, functions/flights)
// are the only way in; they are thin wrappers around these handlers, which test/api.test.mjs runs
// against an in-memory stand-in for Base44.
//   ctx = { db: service-role entities, s: sealer(DATA_KEY), me: { id, email (lower case), name } }
import { withParts } from './parts.js';
import { cleanPreview } from './preview.js';
import { designFields, flightFields, motorFields, readDesign, readFlight, readMotor, roleIn } from './sealed.js';

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const fail = (status, message) => {
  throw new ApiError(status, message);
};

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const ROLES = new Set(['editor', 'viewer']);
const MAX_PEOPLE = 200;
const MAX_MOTOR_CHARS = 2_000_000;
const MAX_FLIGHT_CHARS = 8_000_000;
const NOT_FOUND = 'Design not found. It may have been deleted, or it is not shared with you.';

/** A new design's id: 24 random hex digits, like the record ids designs had before (rooms, links). */
export function newRoom() {
  return [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function cleanName(name) {
  const n = String(name ?? '').trim();
  if (!n) fail(400, 'Enter a name.');
  return n.slice(0, 200);
}

export function cleanMembers(list, ownerEmail) {
  if (!Array.isArray(list) || list.length > MAX_PEOPLE) fail(400, 'Invalid list of people.');
  const out = new Map();
  for (const m of list) {
    const email = String(m?.email ?? '').trim().toLowerCase();
    if (!EMAIL.test(email)) fail(400, 'Enter an email address.');
    if (!ROLES.has(m?.role)) fail(400, 'Invalid access level.');
    if (email !== ownerEmail) out.set(email, { email, role: m.role });
  }
  return [...out.values()];
}

/**
 * Who may open a design's room, as the room checks it: [{ id, role }] by Base44 user id. The room
 * cannot read sealed records (Base44 gives actors no app secrets), so this is the one thing about
 * a design it can see: who has which role, by opaque ids. People are shared with by email; one
 * without an account yet is added the first time they look (designsApi's own()).
 */
export async function accessFor(db, d) {
  const out = [];
  for (const [email, role] of [[d.owner_email, 'owner'], ...d.members.map((m) => [m.email, m.role])]) {
    const [u] = await db.User.filter({ email: String(email).toLowerCase() }).catch(() => []);
    if (u?.id && !out.some((a) => a.id === u.id)) out.push({ id: u.id, role });
  }
  return out;
}

/**
 * Designs: list, get, create, rename, share, leave, delete; motors (the custom motor files of
 * everyone a design is shared with, for OpenRocket) and preview (keep OpenRocket's drawing of it).
 * Returns designs as readDesign() shapes them.
 */
export async function designsApi({ db: raw, s, me }, body) {
  const db = withParts(raw); // long sealed values in parts (Base44 refuses big records)
  // The design's room knows people by user id: make sure it knows this one, with this role.
  const own = async (r, role) => {
    const access = r.access ?? [];
    if (!me.id || access.some((a) => a.id === me.id && a.role === role)) return;
    await db.Design.update(r.id, { access: [...access.filter((a) => a.id !== me.id), { id: me.id, role }] });
  };
  const find = async (id) => {
    const room = String(id ?? '');
    const [r] = room ? await db.Design.filter({ room }) : [];
    const d = r ? await readDesign(s, r) : null;
    const role = d ? roleIn(d, me.email) : null;
    if (!role) fail(404, NOT_FOUND);
    await own(r, role);
    return { r, d, role };
  };
  const ownerOnly = (role) => {
    if (role !== 'owner') fail(403, 'Only the owner can do that.');
  };
  const save = async (r, d, { people = false } = {}) => {
    await db.Design.update(r.id, { ...(await designFields(s, d)), ...(people ? { access: await accessFor(db, d) } : {}) });
    return d;
  };

  switch (body?.action) {
    case 'list': {
      const key = await s.lookupKey(me.email);
      const out = [];
      for (const r of await db.Design.filter({ people: key }, '-edited_at', 500)) {
        if (!r.people?.includes(key)) continue;
        const d = await readDesign(s, r);
        const role = roleIn(d, me.email);
        if (!role) continue;
        await own(r, role);
        out.push(d);
      }
      return out;
    }
    case 'get':
      return (await find(body.id)).d;
    case 'create': {
      const d = { name: cleanName(body.name), owner_email: me.email, owner_name: me.name, members: [] };
      const r = await db.Design.create({
        room: newRoom(),
        version: 0,
        edited_at: new Date().toISOString(),
        access: me.id ? [{ id: me.id, role: 'owner' }] : [],
        ...(await designFields(s, d)),
      });
      return readDesign(s, r);
    }
    case 'rename': {
      const { r, d, role } = await find(body.id);
      ownerOnly(role);
      return save(r, { ...d, name: cleanName(body.name) });
    }
    case 'share': {
      const { r, d, role } = await find(body.id);
      ownerOnly(role);
      return save(r, { ...d, members: cleanMembers(body.members, d.owner_email) }, { people: true });
    }
    case 'leave': {
      const { r, d, role } = await find(body.id);
      if (role === 'owner') fail(400, 'You own this design. Delete it instead.');
      await save(r, { ...d, members: d.members.filter((m) => m.email.toLowerCase() !== me.email) }, { people: true });
      return { ok: true };
    }
    case 'delete': {
      const { r, role } = await find(body.id);
      ownerOnly(role);
      await db.Design.delete(r.id);
      return { ok: true };
    }
    case 'motors': {
      const { r } = await find(body.id);
      const lists = await Promise.all((r.people ?? []).map((owner) => db.Motor.filter({ owner })));
      const out = [];
      for (const m of lists.flat()) {
        if (!r.people.includes(m.owner)) continue;
        const f = await readMotor(s, m);
        out.push({ name: motorFileName(f), content: f.content });
      }
      return out;
    }
    case 'preview': {
      // As the room kept it: checked, empty for an empty rocket; someone who can only view the
      // design may fill in a missing drawing, not change one.
      const { r, role } = await find(body.id);
      const clean = cleanPreview(body.preview);
      if (!clean) return { kept: false };
      if (role === 'viewer' && r.sealed_preview) return { kept: false };
      await db.Design.update(r.id, { sealed_preview: await s.seal(clean.s.length ? JSON.stringify(clean) : '') });
      return { kept: true };
    }
    default:
      return fail(400, 'Unknown action.');
  }
}

/** A custom motor file's name in OpenRocket's file system: unique per record. */
export const motorFileName = (m) => `${String(m.id).slice(0, 8)}-${String(m.filename).replace(/[^A-Za-z0-9._-]/g, '_')}`;

/** The signed-in person's custom motor files: list, add, delete. */
export async function motorsApi({ db: raw, s, me }, body) {
  const db = withParts(raw);
  const key = await s.lookupKey(me.email);
  switch (body?.action) {
    case 'list': {
      const rows = (await db.Motor.filter({ owner: key }, '-created_date', 200)).filter((r) => r.owner === key);
      return Promise.all(rows.map((r) => readMotor(s, r)));
    }
    case 'add': {
      const filename = String(body.filename ?? '').trim().slice(0, 200);
      const content = String(body.content ?? '');
      if (!/\.(eng|rse)$/i.test(filename)) fail(400, 'Only .eng and .rse motor files can be added.');
      if (!content || content.length > MAX_MOTOR_CHARS) fail(400, 'The motor file is empty or too large.');
      const summary = typeof body.summary === 'string' ? body.summary.slice(0, 200_000) : '[]';
      const r = await db.Motor.create(await motorFields(s, me.email, { filename, content, summary }));
      return readMotor(s, r);
    }
    case 'delete': {
      const r = body.id ? await db.Motor.get(String(body.id)).catch(() => null) : null;
      if (!r || r.owner !== key) fail(404, 'Motor not found.');
      await db.Motor.delete(r.id);
      return { ok: true };
    }
    default:
      return fail(400, 'Unknown action.');
  }
}

/** The signed-in person's saved launch plans: list, get, create, update, rename, delete. */
export async function flightsApi({ db: raw, s, me }, body) {
  const db = withParts(raw);
  const key = await s.lookupKey(me.email);
  // A plan moved from before records were sealed is still found by its old id.
  const find = async (id) => {
    const ref = String(id ?? '');
    let r = null;
    if (ref) [r] = (await db.SavedFlight.filter({ ref })).filter((x) => x.owner === key);
    if (!r && ref) r = await db.SavedFlight.get(ref).catch(() => null);
    if (!r || r.owner !== key) fail(404, 'That saved flight no longer exists.');
    return { r, f: await readFlight(s, r) };
  };
  const plan = (b, keep = {}) => {
    const f = { ...keep };
    if ('name' in b || !('name' in keep)) f.name = cleanName(b.name);
    for (const k of ['design_id', 'design_name', 'launch_time', 'summary']) {
      if (k in b) f[k] = b[k] == null ? null : String(b[k]).slice(0, k === 'summary' ? 500 : 200);
    }
    if ('data' in b) {
      const data = String(b.data ?? '');
      if (!data || data.length > MAX_FLIGHT_CHARS) fail(400, 'The launch plan is empty or too large.');
      f.data = data;
    }
    if (!f.data) fail(400, 'The launch plan is empty or too large.');
    return f;
  };
  switch (body?.action) {
    case 'list': {
      const rows = (await db.SavedFlight.filter({ owner: key }, '-updated_date', 200)).filter((r) => r.owner === key);
      return Promise.all(rows.map((r) => readFlight(s, r)));
    }
    case 'get':
      return (await find(body.id)).f;
    case 'create': {
      const r = await db.SavedFlight.create(await flightFields(s, me.email, plan(body)));
      return readFlight(s, r);
    }
    case 'update': {
      const { r, f } = await find(body.id);
      const { name, ...rest } = body;
      const updated = await db.SavedFlight.update(r.id, await flightFields(s, me.email, plan(rest, f)));
      return readFlight(s, { ...r, ...updated });
    }
    case 'rename': {
      const { r, f } = await find(body.id);
      const updated = await db.SavedFlight.update(r.id, await flightFields(s, me.email, { ...f, name: cleanName(body.name) }));
      return readFlight(s, { ...r, ...updated });
    }
    case 'delete': {
      const { r } = await find(body.id);
      await db.SavedFlight.delete(r.id);
      return { ok: true };
    }
    default:
      return fail(400, 'Unknown action.');
  }
}
