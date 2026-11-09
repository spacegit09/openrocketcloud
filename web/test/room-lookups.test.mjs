// The design room's lookups of people, their access and their motors (base44/actors/DesignRoom/
// room.js): on Base44 each takes a fraction of a second, so they must not hold up edits or each
// other. The load test found 50 editors' access checks keeping a room busy all the time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Room } from '../base44/actors/DesignRoom/room.js';
import { importOrk } from '../src/lib/ork.js';
import { toJson } from '../../server/src/model.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const model = toJson(await importOrk(new Uint8Array(readFileSync(join(import.meta.dirname, '..', '..', 'server', 'templates', 'new-rocket.ork')))));
const stage = Object.entries(model.objs).find(([, o]) => o.t === 'stage')[0];

/** A room with in-memory storage whose lookups take `ms`; `roles` (email -> role) can change. */
async function setUp({ ms = 100, roleTtlMs = 10_000 } = {}) {
  const store = new Map();
  const conns = new Set();
  const roles = new Map([['owner@test.local', 'owner']]);
  const counts = { user: 0, access: 0, motors: 0, failing: false };
  const room = new Room({
    storage: {
      get: async (k) => structuredClone(store.get(k)),
      put: async (k, v) => void store.set(k, structuredClone(v)),
      delete: async (k) => store.delete(k),
      deleteAll: async () => store.clear(),
    },
    connections: () => [...conns],
    user: async (conn) => (counts.user++, await sleep(ms), conn.user),
    access: async (user) => {
      counts.access++;
      await sleep(ms);
      if (counts.failing) throw new Error('lookup failed');
      const role = roles.get(user.email);
      return role ? { role, name: 'Test rocket' } : null;
    },
    motors: async () => (counts.motors++, await sleep(ms), []),
    touch: async () => {},
    preview: async () => true,
    roleTtlMs,
  });
  await room.start();
  const connect = async (email) => {
    const inbox = [];
    const conn = { id: crypto.randomUUID(), user: { id: email, email, name: email }, send: (m) => inbox.push(m) };
    conns.add(conn);
    const refused = await room.handleConnect(conn);
    if (refused) conns.delete(conn);
    const c = {
      conn,
      inbox,
      refused,
      send: (m) => room.handleMessage(conn, m),
      next: async (match, wait = 3000) => {
        const end = Date.now() + wait;
        while (Date.now() < end) {
          const k = inbox.findIndex(match);
          if (k >= 0) return inbox.splice(k, 1)[0];
          await sleep(5);
        }
        throw new Error(`timed out (${email})`);
      },
    };
    return c;
  };
  const owner = await connect('owner@test.local');
  await owner.send({ type: 'init', rid: 'r', model });
  return { room, roles, counts, connect, owner };
}

let seq = 0;
const edit = (c, name) => {
  const s = ++seq;
  c.send({ type: 'ops', seq: s, ops: [{ op: 'set', id: stage, v: { name: `<name>${name}</name>` } }] });
  return s;
};

test('many joining at once are looked up together, not one after another', async () => {
  const { roles, connect } = await setUp({ ms: 100 });
  for (let i = 0; i < 20; i++) roles.set(`e${i}@test.local`, 'editor');
  const t0 = Date.now();
  const joined = await Promise.all(Array.from({ length: 20 }, (_, i) => connect(`e${i}@test.local`)));
  assert.ok(joined.every((c) => !c.refused && c.inbox.some((m) => m.type === 'hi')));
  assert.ok(Date.now() - t0 < 1000, `20 joins took ${Date.now() - t0} ms (one after another: over 4000)`);
});

test('the motors for welcomes are looked up while waiting their turn', async () => {
  const { roles, connect } = await setUp({ ms: 100 });
  for (let i = 0; i < 10; i++) roles.set(`e${i}@test.local`, 'editor');
  const people = await Promise.all(Array.from({ length: 10 }, (_, i) => connect(`e${i}@test.local`)));
  const t0 = Date.now();
  people.forEach((c) => c.send({ type: 'hello' }));
  await Promise.all(people.map((c) => c.next((m) => m.type === 'welcome')));
  assert.ok(Date.now() - t0 < 600, `10 welcomes took ${Date.now() - t0} ms (one after another: over 1000)`);
});

test('edits do not wait for access to be looked up again', async () => {
  const { owner, connect, roles, counts } = await setUp({ ms: 300, roleTtlMs: 50 });
  roles.set('e@test.local', 'editor');
  const e = await connect('e@test.local');
  await sleep(80); // everyone's access is due to be looked up again
  const before = counts.access;
  const t0 = Date.now();
  const s = edit(e, 'Booster');
  await owner.next((m) => m.type === 'ops' && m.seq === s);
  assert.ok(Date.now() - t0 < 150, `the edit took ${Date.now() - t0} ms`);
  await sleep(700);
  assert.ok(counts.access > before, 'access was looked up again (in the background)');
});

test('access taken away still takes effect: the next message after the check is refused', async () => {
  const { connect, roles } = await setUp({ ms: 20, roleTtlMs: 50 });
  roles.set('e@test.local', 'editor');
  const e = await connect('e@test.local');
  roles.delete('e@test.local');
  await sleep(80);
  edit(e, 'Late'); // starts the check
  await sleep(100);
  edit(e, 'Later');
  assert.match((await e.next((m) => m.type === 'kick')).message, /no longer have access/);
});

test('a check that fails keeps everyone\'s access (and edits go on)', async () => {
  const { owner, connect, roles, counts } = await setUp({ ms: 20, roleTtlMs: 50 });
  roles.set('e@test.local', 'editor');
  const e = await connect('e@test.local');
  counts.failing = true;
  await sleep(80);
  edit(e, 'One');
  await sleep(100);
  const s = edit(e, 'Two');
  await owner.next((m) => m.type === 'ops' && m.seq === s);
  assert.ok(!e.inbox.some((m) => m.type === 'kick'));
});

test('someone not shared with is still turned away', async () => {
  const { connect } = await setUp({ ms: 10 });
  const x = await connect('stranger@test.local');
  assert.match(x.refused, /do not have access/);
});
