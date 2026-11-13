// Who may do what with designs, motors and saved launch plans (base44/shared/api.js), and the move
// of plain records to sealed ones (base44/shared/migrate.js), against an in-memory stand-in for
// Base44's entities; and that the stored records hold no personal data in the clear.
import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError, designsApi, flightsApi, motorsApi } from '../base44/shared/api.js';
import { migrateToSealed } from '../base44/shared/migrate.js';
import { readDesign, sealer } from '../base44/shared/sealed.js';

/** Base44-like entity tables: equality filters (an array field matches any element, an array value means any of). */
function fakeDb() {
  let clock = Date.parse('2026-01-01T00:00:00Z');
  const now = () => new Date((clock += 1000)).toISOString(); // every write a second later
  const table = () => {
    const rows = new Map();
    const matches = (r, query) => Object.entries(query).every(([k, v]) => {
      const have = Array.isArray(r[k]) ? r[k] : [r[k]];
      const want = Array.isArray(v) ? v : [v];
      return have.some((x) => want.includes(x));
    });
    return {
      rows,
      async filter(query, sort = '-created_date', limit = 5000) {
        const field = sort.replace(/^-/, '');
        const dir = sort.startsWith('-') ? -1 : 1;
        return [...rows.values()].filter((r) => matches(r, query))
          .sort((a, b) => (a[field] < b[field] ? -dir : a[field] > b[field] ? dir : 0)).slice(0, limit).map((r) => ({ ...r }));
      },
      async list(sort, limit) {
        return this.filter({}, sort, limit);
      },
      async get(id) {
        if (!rows.has(id)) throw new Error('not found');
        return { ...rows.get(id) };
      },
      async create(data) {
        const at = now();
        const r = { ...data, id: crypto.randomUUID(), created_date: at, updated_date: at };
        rows.set(r.id, r);
        return { ...r };
      },
      async update(id, data) {
        rows.set(id, { ...rows.get(id), ...data, updated_date: now() });
        return { ...rows.get(id) };
      },
      async delete(id) {
        rows.delete(id);
      },
    };
  };
  const User = table();
  return { Design: table(), Motor: table(), SavedFlight: table(), User };
}

/** People with Base44 accounts (User records, as Base44 keeps them), and what each may call. */
function setup() {
  const db = fakeDb();
  const s = sealer(Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64'));
  const ids = {};
  const as = (email, name, { account = true } = {}) => {
    const me = { id: '', email, name };
    const join = async () => {
      if (!me.id) me.id = (await db.User.create({ email, full_name: name })).id;
      ids[email] = me.id;
    };
    const ready = account ? join() : Promise.resolve();
    const call = (api) => async (body) => (await ready, api({ db, s, me }, body));
    return { designs: call(designsApi), motors: call(motorsApi), flights: call(flightsApi), join, me };
  };
  return {
    db, s, ids,
    mina: as('mina@example.com', 'Mina Park'),
    joon: as('joon@example.com', 'Joon Lee'),
    sora: as('sora@example.com', 'Sora Kim'),
    newcomer: as('new@example.com', 'Nova Park', { account: false }),
  };
}

/** The room's access list for a design: [[email, role]], sorted. */
async function accessOf(db, ids, room) {
  const [r] = await db.Design.filter({ room });
  const byId = Object.fromEntries(Object.entries(ids).map(([e, id]) => [id, e]));
  return (r.access ?? []).map((a) => [byId[a.id] ?? a.id, a.role]).sort();
}

const DRAWING = JSON.stringify({ v: 1, box: [0, -20, 400, 40], s: [{ d: 'M 0 0 L 100 -10 L 380 -10 L 380 10 L 100 10 Z' }, { d: 'M 380 -5 L 400 -5 L 400 5 L 380 5 Z', m: 1 }] });

const refused = (status) => (e) => e instanceof ApiError && e.status === status;

test('the owner creates, renames and lists a design; others cannot see it', async () => {
  const { mina, joon } = setup();
  const d = await mina.designs({ action: 'create', name: ' Two stage ' });
  assert.equal(d.name, 'Two stage');
  assert.equal(d.owner_email, 'mina@example.com');
  assert.equal(d.owner_name, 'Mina Park');
  assert.deepEqual(d.members, []);
  assert.match(d.id, /^[0-9a-f]{24}$/);
  assert.equal((await mina.designs({ action: 'rename', id: d.id, name: 'Two stage HPR' })).name, 'Two stage HPR');
  assert.deepEqual((await mina.designs({ action: 'list' })).map((x) => x.name), ['Two stage HPR']);
  assert.deepEqual(await joon.designs({ action: 'list' }), []);
  for (const action of ['get', 'rename', 'share', 'leave', 'delete']) {
    await assert.rejects(joon.designs({ action, id: d.id, name: 'x', members: [] }), refused(404), action);
  }
});

test('sharing: members see the design with their role, cannot manage it, and can leave', async () => {
  const { mina, joon, sora } = setup();
  const d = await mina.designs({ action: 'create', name: 'Pods' });
  const shared = await mina.designs({ action: 'share', id: d.id, members: [{ email: 'Joon@Example.com', role: 'editor' }, { email: 'sora@example.com', role: 'viewer' }] });
  assert.deepEqual(shared.members, [{ email: 'joon@example.com', role: 'editor' }, { email: 'sora@example.com', role: 'viewer' }]);
  const seen = await joon.designs({ action: 'get', id: d.id });
  assert.equal(seen.name, 'Pods');
  assert.equal(seen.owner_email, 'mina@example.com');
  assert.deepEqual((await sora.designs({ action: 'list' })).map((x) => x.id), [d.id]);
  await assert.rejects(joon.designs({ action: 'rename', id: d.id, name: 'Mine now' }), refused(403));
  await assert.rejects(joon.designs({ action: 'share', id: d.id, members: [] }), refused(403));
  await assert.rejects(joon.designs({ action: 'delete', id: d.id }), refused(403));
  await assert.rejects(mina.designs({ action: 'leave', id: d.id }), refused(400));
  assert.deepEqual(await joon.designs({ action: 'leave', id: d.id }), { ok: true });
  assert.deepEqual(await joon.designs({ action: 'list' }), []);
  await assert.rejects(joon.designs({ action: 'get', id: d.id }), refused(404));
  assert.deepEqual((await mina.designs({ action: 'get', id: d.id })).members, [{ email: 'sora@example.com', role: 'viewer' }]);
});

test('the owner deletes; the design is gone for everyone', async () => {
  const { mina, joon } = setup();
  const d = await mina.designs({ action: 'create', name: 'Rocket' });
  await mina.designs({ action: 'share', id: d.id, members: [{ email: 'joon@example.com', role: 'editor' }] });
  await mina.designs({ action: 'delete', id: d.id });
  assert.deepEqual(await mina.designs({ action: 'list' }), []);
  await assert.rejects(joon.designs({ action: 'get', id: d.id }), refused(404));
});

test('bad input is refused', async () => {
  const { mina } = setup();
  await assert.rejects(mina.designs({ action: 'create', name: '  ' }), refused(400));
  const d = await mina.designs({ action: 'create', name: 'Rocket' });
  await assert.rejects(mina.designs({ action: 'share', id: d.id, members: [{ email: 'not an email', role: 'editor' }] }), refused(400));
  await assert.rejects(mina.designs({ action: 'share', id: d.id, members: [{ email: 'joon@example.com', role: 'owner' }] }), refused(400));
  await assert.rejects(mina.designs({ action: 'share', id: d.id, members: 'everyone' }), refused(400));
  assert.deepEqual((await mina.designs({ action: 'share', id: d.id, members: [{ email: 'MINA@example.com', role: 'editor' }] })).members, [],
    'the owner is never also a member');
  await assert.rejects(mina.designs({ action: 'nuke' }), refused(400));
  await assert.rejects(mina.motors({ action: 'add', filename: 'notes.txt', content: 'x' }), refused(400));
  await assert.rejects(mina.motors({ action: 'add', filename: 'empty.eng', content: '' }), refused(400));
});

test('motors: each person sees and removes only their own', async () => {
  const { mina, joon } = setup();
  const m = await mina.motors({ action: 'add', filename: 'x42.eng', content: 'X42 29 124 0 0.05 0.1 TeamRocket\n0.1 50\n', summary: '[{"designation":"X42"}]' });
  assert.equal(m.filename, 'x42.eng');
  assert.deepEqual((await mina.motors({ action: 'list' })).map((x) => [x.filename, x.summary]), [['x42.eng', '[{"designation":"X42"}]']]);
  assert.deepEqual(await joon.motors({ action: 'list' }), []);
  await assert.rejects(joon.motors({ action: 'delete', id: m.id }), refused(404));
  await mina.motors({ action: 'delete', id: m.id });
  assert.deepEqual(await mina.motors({ action: 'list' }), []);
});

test('stored records hold no names, emails, design names or motor files in the clear', async () => {
  const { db, mina } = setup();
  const d = await mina.designs({ action: 'create', name: 'Secret glider' });
  await mina.designs({ action: 'share', id: d.id, members: [{ email: 'joon@example.com', role: 'editor' }] });
  await mina.motors({ action: 'add', filename: 'hush.eng', content: 'H128 29 194 0 0.1 0.2 Hushed\n0.1 50\n', summary: '[]' });
  const stored = JSON.stringify([...db.Design.rows.values(), ...db.Motor.rows.values()]);
  for (const plain of ['example.com', 'mina', 'Mina Park', 'joon', 'Secret glider', 'hush', 'H128', 'Hushed']) {
    assert.ok(!stored.includes(plain), `found "${plain}" in stored records`);
  }
});

const PLAN = { name: 'Saturday at the club field', design_id: 'room-1', design_name: 'Secret glider', launch_time: '2026-03-07T15:00:00.000Z', summary: 'Lands 420 m NE', data: 'H4sIAAAAAAAA/6tWKkktLlGyUlAqzy/KSVGqBQBf7lXyEgAAAA==' };

test('launch plans: each person lists, opens, saves over, renames and deletes only their own', async () => {
  const { mina, joon } = setup();
  const f = await mina.flights({ action: 'create', ...PLAN });
  assert.equal(f.name, PLAN.name);
  assert.equal(f.design_name, 'Secret glider');
  assert.equal(f.data, PLAN.data);
  assert.deepEqual((await mina.flights({ action: 'list' })).map((x) => x.id), [f.id]);
  assert.deepEqual(await joon.flights({ action: 'list' }), []);
  for (const action of ['get', 'update', 'rename', 'delete']) {
    await assert.rejects(joon.flights({ action, id: f.id, name: 'x', data: 'x' }), refused(404), action);
  }
  const over = await mina.flights({ action: 'update', id: f.id, name: 'ignored', summary: 'Lands 380 m NE', data: 'H4sIAAAAAAAA/6tWSs7PS8vMSQUAQ7dN5AsAAAA=' });
  assert.equal(over.name, PLAN.name, 'saving over keeps the name');
  assert.equal(over.summary, 'Lands 380 m NE');
  assert.equal(over.design_name, 'Secret glider', 'and what was not sent');
  assert.equal((await mina.flights({ action: 'rename', id: f.id, name: ' Club launch ' })).name, 'Club launch');
  assert.equal((await mina.flights({ action: 'get', id: f.id })).data, over.data, 'renaming keeps the study');
  await assert.rejects(mina.flights({ action: 'create', ...PLAN, data: '' }), refused(400));
  await assert.rejects(mina.flights({ action: 'create', ...PLAN, name: ' ' }), refused(400));
  await mina.flights({ action: 'delete', id: f.id });
  assert.deepEqual(await mina.flights({ action: 'list' }), []);
  await assert.rejects(mina.flights({ action: 'get', id: f.id }), refused(404));
});

test('stored launch plans hold no names, emails, places or results in the clear', async () => {
  const { db, mina } = setup();
  await mina.flights({ action: 'create', ...PLAN });
  const stored = JSON.stringify([...db.SavedFlight.rows.values()]);
  for (const plain of ['example.com', 'mina', 'Saturday', 'Secret glider', 'room-1', '2026-03-07', 'Lands', PLAN.data]) {
    assert.ok(!stored.includes(plain), `found "${plain}" in stored records`);
  }
});

/** Plain records as the site kept them before sealing, created by people (with created_by). */
async function plainRecords(db) {
  const design = await db.Design.create({
    name: 'Old two stage', owner_email: 'Mina@example.com', owner_name: 'Mina Park', created_by: 'mina@example.com',
    members: [{ email: 'Joon@example.com', role: 'editor' }, { email: 'sora@example.com', role: 'viewer' }],
    member_emails: ['mina@example.com', 'joon@example.com', 'sora@example.com'], version: 7, edited_at: '2025-12-01T00:00:00.000Z',
    preview: '{"parts":[]}',
  });
  const lone = await db.Design.create({ name: 'Old glider', owner_email: 'joon@example.com', owner_name: 'Joon Lee', members: [], member_emails: ['joon@example.com'], version: 2 });
  const motor = await db.Motor.create({ owner_email: 'mina@example.com', filename: 'old.eng', content: 'X42 29 124 0 0.05 0.1 Old\n0.1 50\n', summary: '[]', created_by: 'mina@example.com' });
  const flight = await db.SavedFlight.create({ owner_email: 'mina@example.com', ...PLAN, created_by: 'mina@example.com' });
  return { design, lone, motor, flight };
}

test('the move to sealed records keeps every id, person, role, motor and plan', async () => {
  const { db, s, ids, mina, joon, sora } = setup();
  await Promise.all([mina, joon, sora].map((p) => p.join()));
  const old = await plainRecords(db);
  const first = await migrateToSealed({ db, s });
  assert.deepEqual(first, {
    designs: { plain: 2, copied: 2, refreshed: 0, removed: 0, access: 0 },
    motors: { plain: 1, copied: 1, removed: 0 },
    flights: { plain: 1, copied: 1, refreshed: 0, removed: 0 },
  });
  // The sealed copies are what the functions see; ids (rooms, links) stay.
  const d = await mina.designs({ action: 'get', id: old.design.id });
  assert.equal(d.name, 'Old two stage');
  assert.equal(d.owner_email, 'mina@example.com');
  assert.deepEqual(d.members, [{ email: 'joon@example.com', role: 'editor' }, { email: 'sora@example.com', role: 'viewer' }]);
  assert.equal(d.preview, '{"parts":[]}');
  assert.equal(d.version, 7);
  assert.deepEqual(await accessOf(db, ids, old.design.id), [['joon@example.com', 'editor'], ['mina@example.com', 'owner'], ['sora@example.com', 'viewer']],
    'the room knows everyone with an account');
  assert.equal((await sora.designs({ action: 'get', id: old.design.id })).name, 'Old two stage');
  assert.deepEqual((await joon.designs({ action: 'list' })).map((x) => x.id).sort(), [old.design.id, old.lone.id].sort());
  assert.deepEqual((await mina.motors({ action: 'list' })).map((m) => m.filename), ['old.eng']);
  assert.equal((await mina.flights({ action: 'get', id: old.flight.id })).name, PLAN.name, 'a plan opens by its old id');
  assert.deepEqual((await mina.flights({ action: 'list' })).map((x) => x.id), [old.flight.id]);
  // Again: nothing copied twice.
  const again = await migrateToSealed({ db, s });
  assert.equal(again.designs.copied + again.designs.refreshed + again.motors.copied + again.flights.copied + again.flights.refreshed, 0);
});

test('the move refreshes a copy from a plain record changed since, never over a newer copy', async () => {
  const { db, s, mina } = setup();
  const old = await plainRecords(db);
  await migrateToSealed({ db, s });
  // The old site renames a design after it was copied: the next run brings that over.
  await db.Design.update(old.design.id, { name: 'Renamed on the old site' });
  assert.equal((await migrateToSealed({ db, s })).designs.refreshed, 1);
  assert.equal((await mina.designs({ action: 'get', id: old.design.id })).name, 'Renamed on the old site');
  // The new site renames it: the plain record, now older, does not overwrite that.
  await mina.designs({ action: 'rename', id: old.design.id, name: 'Renamed on the new site' });
  await mina.flights({ action: 'rename', id: old.flight.id, name: 'New plan name' });
  const run = await migrateToSealed({ db, s });
  assert.equal(run.designs.refreshed + run.flights.refreshed, 0);
  assert.equal((await mina.designs({ action: 'get', id: old.design.id })).name, 'Renamed on the new site');
  assert.equal((await mina.flights({ action: 'get', id: old.flight.id })).name, 'New plan name');
});

test('finishing the move deletes the plain records and leaves nothing personal in the clear', async () => {
  const { db, s, mina, joon } = setup();
  const old = await plainRecords(db);
  await migrateToSealed({ db, s });
  const done = await migrateToSealed({ db, s, finish: true });
  assert.deepEqual([done.designs.removed, done.motors.removed, done.flights.removed], [2, 1, 1]);
  for (const t of ['Design', 'Motor', 'SavedFlight']) {
    for (const r of db[t].rows.values()) {
      assert.ok(r.sealed, `${t}: only sealed records are left`);
      assert.equal(r.created_by, undefined, `${t}: made by the service role, so no creator`);
    }
  }
  const stored = JSON.stringify(['Design', 'Motor', 'SavedFlight'].flatMap((t) => [...db[t].rows.values()]));
  for (const plain of ['example.com', 'mina', 'Mina', 'joon', 'Joon Lee', 'Old two stage', 'Old glider', 'old.eng', 'Saturday', 'parts']) {
    assert.ok(!stored.includes(plain), `found "${plain}" in stored records`);
  }
  // Everything still works for everyone.
  assert.equal((await joon.designs({ action: 'get', id: old.design.id })).name, 'Old two stage');
  assert.equal((await mina.flights({ action: 'get', id: old.flight.id })).summary, PLAN.summary);
  assert.equal((await mina.motors({ action: 'list' })).length, 1);
  assert.deepEqual(await migrateToSealed({ db, s, finish: true }), {
    designs: { plain: 0, copied: 0, refreshed: 0, removed: 0, access: 0 },
    motors: { plain: 0, copied: 0, removed: 0 },
    flights: { plain: 0, copied: 0, refreshed: 0, removed: 0 },
  });
});

test('a design\'s drawing is sealed apart from it and opened with it', async () => {
  const { db, s, mina } = setup();
  const d = await mina.designs({ action: 'create', name: 'Drawn' });
  const [r] = await db.Design.filter({ room: d.id });
  await db.Design.update(r.id, { sealed_preview: await s.seal('{"outline":[1,2,3]}') });
  assert.equal((await mina.designs({ action: 'get', id: d.id })).preview, '{"outline":[1,2,3]}');
  assert.ok(!JSON.stringify([...db.Design.rows.values()]).includes('outline'));
  assert.equal((await readDesign(s, { ...r, sealed_preview: undefined })).preview, null);
});

test('the room\'s access list follows the owner, sharing, leaving, and first visits', async () => {
  const { db, ids, mina, joon, sora, newcomer } = setup();
  const d = await mina.designs({ action: 'create', name: 'Pods' });
  assert.deepEqual(await accessOf(db, ids, d.id), [['mina@example.com', 'owner']]);
  await mina.designs({ action: 'share', id: d.id, members: [
    { email: 'joon@example.com', role: 'editor' }, { email: 'sora@example.com', role: 'viewer' }, { email: 'new@example.com', role: 'editor' }] });
  await joon.designs({ action: 'list' });
  await sora.designs({ action: 'list' });
  assert.deepEqual(await accessOf(db, ids, d.id), [['joon@example.com', 'editor'], ['mina@example.com', 'owner'], ['sora@example.com', 'viewer']],
    'someone without an account is not in it yet');
  // They sign up and open the design: from then on the room lets them in.
  await newcomer.join();
  await newcomer.designs({ action: 'get', id: d.id });
  assert.deepEqual((await accessOf(db, ids, d.id)).find(([e]) => e === 'new@example.com'), ['new@example.com', 'editor']);
  // A changed role reaches the room; leaving and being removed take people out.
  await mina.designs({ action: 'share', id: d.id, members: [{ email: 'joon@example.com', role: 'viewer' }, { email: 'sora@example.com', role: 'viewer' }] });
  assert.deepEqual(await accessOf(db, ids, d.id), [['joon@example.com', 'viewer'], ['mina@example.com', 'owner'], ['sora@example.com', 'viewer']]);
  await sora.designs({ action: 'leave', id: d.id });
  assert.deepEqual(await accessOf(db, ids, d.id), [['joon@example.com', 'viewer'], ['mina@example.com', 'owner']]);
  // Nobody else gets in by asking.
  await assert.rejects(sora.designs({ action: 'get', id: d.id }), refused(404));
  assert.deepEqual(await accessOf(db, ids, d.id), [['joon@example.com', 'viewer'], ['mina@example.com', 'owner']]);
});

test('a design\'s custom motors: everyone it is shared with gets everyone\'s, others none', async () => {
  const { mina, joon, sora } = setup();
  const d = await mina.designs({ action: 'create', name: 'Motors' });
  await mina.designs({ action: 'share', id: d.id, members: [{ email: 'joon@example.com', role: 'viewer' }] });
  const m = await mina.motors({ action: 'add', filename: 'x 42.eng', content: 'X42 29 124 0 0.05 0.1 Team\n0.1 50\n', summary: '[]' });
  await joon.motors({ action: 'add', filename: 'j9.eng', content: 'J9 29 124 0 0.05 0.1 Joon\n0.1 50\n', summary: '[]' });
  await sora.motors({ action: 'add', filename: 'sora.eng', content: 'S1 29 124 0 0.05 0.1 Sora\n0.1 50\n', summary: '[]' });
  const files = await joon.designs({ action: 'motors', id: d.id });
  assert.deepEqual(files.map((f) => f.name.slice(9)).sort(), ['j9.eng', 'x_42.eng']);
  assert.ok(files.find((f) => f.name === `${m.id.slice(0, 8)}-x_42.eng`).content.startsWith('X42 '));
  await assert.rejects(sora.designs({ action: 'motors', id: d.id }), refused(404));
});

test('a design\'s drawing: kept sealed; a viewer may only fill in a missing one; bad ones refused', async () => {
  const { db, mina, joon } = setup();
  const d = await mina.designs({ action: 'create', name: 'Drawn' });
  await mina.designs({ action: 'share', id: d.id, members: [{ email: 'joon@example.com', role: 'viewer' }] });
  assert.deepEqual(await joon.designs({ action: 'preview', id: d.id, preview: DRAWING }), { kept: true }, 'a viewer fills in a missing one');
  assert.equal((await mina.designs({ action: 'get', id: d.id })).preview, JSON.stringify(JSON.parse(DRAWING)));
  assert.deepEqual(await joon.designs({ action: 'preview', id: d.id, preview: JSON.stringify({ v: 1, s: [] }) }), { kept: false }, 'but cannot change it');
  assert.deepEqual(await mina.designs({ action: 'preview', id: d.id, preview: JSON.stringify({ v: 1, s: [] }) }), { kept: true });
  assert.equal((await mina.designs({ action: 'get', id: d.id })).preview, '', 'an empty rocket');
  assert.deepEqual(await mina.designs({ action: 'preview', id: d.id, preview: '<svg onload=alert(1)>' }), { kept: false });
  assert.ok(!JSON.stringify([...db.Design.rows.values()]).includes('380'), 'the drawing is not stored in the clear');
});

test('the move gives sealed designs without one their room\'s access list', async () => {
  const { db, s, ids, mina } = setup();
  const d = await mina.designs({ action: 'create', name: 'Made before access lists' });
  const [r] = await db.Design.filter({ room: d.id });
  await db.Design.update(r.id, { access: undefined });
  assert.equal((await migrateToSealed({ db, s })).designs.access, 1);
  assert.deepEqual(await accessOf(db, ids, d.id), [['mina@example.com', 'owner']]);
  assert.equal((await migrateToSealed({ db, s })).designs.access, 0);
});
