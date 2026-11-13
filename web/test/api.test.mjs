// Who may do what with designs, motors and saved launch plans (base44/shared/api.js), against an
// in-memory stand-in for Base44's entities; and that the stored records hold no personal data in
// the clear.
import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError, designsApi, flightsApi, motorsApi } from '../base44/shared/api.js';
import { readDesign, sealer } from '../base44/shared/sealed.js';
import { fakeDb, MAX_RECORD } from './fake-base44.mjs';

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
  const stored = JSON.stringify([...db.Design.rows.values(), ...db.Motor.rows.values(), ...db.SealedPart.rows.values()]);
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
  const stored = JSON.stringify([...db.SavedFlight.rows.values(), ...db.SealedPart.rows.values()]);
  for (const plain of ['example.com', 'mina', 'Saturday', 'Secret glider', 'room-1', '2026-03-07', 'Lands', PLAN.data]) {
    assert.ok(!stored.includes(plain), `found "${plain}" in stored records`);
  }
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

const noise = (n) => Buffer.from(crypto.getRandomValues(new Uint8Array(n))).toString('base64').slice(0, n);

test('the stand-in refuses records over Base44\'s size, as Base44 does', async () => {
  const db = fakeDb();
  await assert.rejects(db.SavedFlight.create({ sealed: noise(MAX_RECORD + 10) }), /too large/);
});

test('big values are kept in parts: a big launch plan, motor file and drawing save, open, and clean up', async () => {
  const { db, mina, joon } = setup();
  const data = noise(60_000); // a plan of many flights (incompressible, the worst case)
  const f = await mina.flights({ action: 'create', ...PLAN, data });
  assert.equal((await mina.flights({ action: 'get', id: f.id })).data, data);
  assert.ok(db.SealedPart.rows.size >= 5, `${db.SealedPart.rows.size} parts`);
  for (const r of [...db.SavedFlight.rows.values(), ...db.SealedPart.rows.values()]) assert.ok(JSON.stringify(r).length < MAX_RECORD);
  // Saving over it replaces its parts; deleting it removes them.
  const data2 = noise(40_000);
  await mina.flights({ action: 'update', id: f.id, data: data2 });
  assert.equal((await mina.flights({ action: 'list' }))[0].data, data2);
  const partsNow = db.SealedPart.rows.size;
  assert.ok(partsNow >= 4 && partsNow < 9, `old parts removed (${partsNow} left)`);
  await mina.flights({ action: 'delete', id: f.id });
  assert.equal(db.SealedPart.rows.size, 0, 'no parts left behind');

  const rse = `<engine-database><engine code="X">${'<eng-data t="0.1" f="10.0" m="0.1"/>'.repeat(4000)}</engine></engine-database>`;
  const m = await mina.motors({ action: 'add', filename: 'big.rse', content: rse, summary: '[]' });
  assert.equal((await mina.motors({ action: 'list' }))[0].content, rse);
  const d = await mina.designs({ action: 'create', name: 'Detailed' });
  await mina.designs({ action: 'share', id: d.id, members: [{ email: 'joon@example.com', role: 'viewer' }] });
  const shared = await joon.designs({ action: 'motors', id: d.id });
  assert.deepEqual(shared.map((f) => [f.name.slice(9), f.content === rse]), [['big.rse', true]], 'a member gets the owner\'s big motor file whole');
  const shapes = Array.from({ length: 1500 }, (_, i) => ({ d: `M ${i} 0 L ${i + 1} ${(i * 7) % 40} L ${i + 2} 3 Z` }));
  const drawing = JSON.stringify({ v: 1, box: [0, -20, 1600, 60], s: shapes });
  assert.ok(drawing.length > MAX_RECORD);
  assert.deepEqual(await mina.designs({ action: 'preview', id: d.id, preview: drawing }), { kept: true });
  assert.equal((await mina.designs({ action: 'get', id: d.id })).preview, drawing);
  await mina.motors({ action: 'delete', id: m.id });
  await mina.designs({ action: 'delete', id: d.id });
  assert.equal(db.SealedPart.rows.size, 0);
});
