// What the site may do with designs, motors and saved launch plans, checked here for the signed-in
// person. Design, Motor and SavedFlight records hold only sealed data (sealed.js) and are closed to
// direct access, so the backend functions (functions/designs, functions/motors, functions/flights)
// are the only way in; they are thin wrappers around these handlers, which test/api.test.mjs runs
// against an in-memory stand-in for Base44.
//   ctx = { db: service-role entities, s: sealer(DATA_KEY), me: { email (lower case), name } }
import { designFields, flightFields, motorFields, readDesign, readFlight, readMotor, roleIn } from './sealed.js';

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const fail = (status, message) => {
  throw new ApiError(status, message);
};

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const ROLES = new Set(['editor', 'viewer']);
const MAX_PEOPLE = 200;
const MAX_MOTOR_CHARS = 2_000_000;
const MAX_FLIGHT_CHARS = 8_000_000;
const NOT_FOUND = 'Design not found. It may have been deleted, or it is not shared with you.';

/** A new design's id: 24 random hex digits, like the record ids designs had before (rooms, links). */
function newRoom() {
  return [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function cleanName(name) {
  const n = String(name ?? '').trim();
  if (!n) fail(400, 'Enter a name.');
  return n.slice(0, 200);
}

function cleanMembers(list, ownerEmail) {
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

/** Designs: list, get, create, rename, share, leave, delete. Returns designs as readDesign() shapes them. */
export async function designsApi({ db, s, me }, body) {
  const find = async (id) => {
    const room = String(id ?? '');
    const [r] = room ? await db.Design.filter({ room }) : [];
    const d = r ? await readDesign(s, r) : null;
    const role = d ? roleIn(d, me.email) : null;
    if (!role) fail(404, NOT_FOUND);
    return { r, d, role };
  };
  const ownerOnly = (role) => {
    if (role !== 'owner') fail(403, 'Only the owner can do that.');
  };
  const save = async (r, d) => {
    await db.Design.update(r.id, await designFields(s, d));
    return d;
  };

  switch (body?.action) {
    case 'list': {
      const key = await s.lookupKey(me.email);
      const out = [];
      for (const r of await db.Design.filter({ people: key }, '-edited_at', 500)) {
        if (!r.people?.includes(key)) continue;
        const d = await readDesign(s, r);
        if (roleIn(d, me.email)) out.push(d);
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
      return save(r, { ...d, members: cleanMembers(body.members, d.owner_email) });
    }
    case 'leave': {
      const { r, d, role } = await find(body.id);
      if (role === 'owner') fail(400, 'You own this design. Delete it instead.');
      await save(r, { ...d, members: d.members.filter((m) => m.email.toLowerCase() !== me.email) });
      return { ok: true };
    }
    case 'delete': {
      const { r, role } = await find(body.id);
      ownerOnly(role);
      await db.Design.delete(r.id);
      return { ok: true };
    }
    default:
      return fail(400, 'Unknown action.');
  }
}

/** The signed-in person's custom motor files: list, add, delete. */
export async function motorsApi({ db, s, me }, body) {
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
export async function flightsApi({ db, s, me }, body) {
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
