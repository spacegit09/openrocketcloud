// The design room (base44/actors/DesignRoom/room.js), driven through the local hub the way the
// page and the OpenRocket bridge drive it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import WebSocket from 'ws';
import { startHub } from './hub.mjs';
import { importOrk } from '../src/lib/ork.js';
import { toJson } from '../../server/src/model.js';

const PORT = 8799;
const designs = new Map([
  ['d1', { name: 'Test rocket', owner: 'a@test.local', members: { 'b@test.local': 'editor', 'v@test.local': 'viewer' } }],
]);
let hub;
let model;

before(async () => {
  hub = startHub({ port: PORT, designs, motors: [{ name: 'abcd1234-X1.eng', content: 'X1 18 70 0 0.01 0.02 Test\n0 1\n1 0\n' }] });
  model = await importOrk(new Uint8Array(readFileSync(join(import.meta.dirname, '..', '..', 'server', 'templates', 'new-rocket.ork'))));
});
after(() => hub.close());

/** A client like the page: collects messages, reassembles fragments, answers requests. */
function client(user, { design = 'd1', conn } = {}) {
  const ws = new WebSocket(`ws://localhost:${PORT}/?design=${design}&user=${user}${conn ? `&conn=${conn}` : ''}`);
  const msgs = [];
  const waiters = [];
  const frags = new Map();
  const deliver = (m) => {
    msgs.push(m);
    for (const w of [...waiters]) if (w.match(m)) {
      waiters.splice(waiters.indexOf(w), 1);
      w.resolve(m);
    }
  };
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.type !== 'frag') return deliver(m);
    const parts = frags.get(m.fid) ?? [];
    parts[m.i] = m.s;
    frags.set(m.fid, parts);
    if (parts.filter((x) => x !== undefined).length === m.n) deliver(JSON.parse(parts.join('')));
  });
  const c = {
    ws,
    msgs,
    closed: new Promise((r) => ws.on('close', (code, reason) => r({ code, reason: reason.toString() }))),
    next: (match, ms = 5000) => {
      const found = msgs.find(match);
      if (found) {
        msgs.splice(msgs.indexOf(found), 1);
        return Promise.resolve(found);
      }
      return new Promise((resolve, reject) => {
        const w = { match, resolve: (m) => { msgs.splice(msgs.indexOf(m), 1); resolve(m); } };
        waiters.push(w);
        setTimeout(() => reject(new Error(`timed out waiting (${user})`)), ms);
      });
    },
    send: (m) => {
      const text = JSON.stringify(m);
      if (text.length < 300_000) return ws.send(text);
      const fid = crypto.randomUUID();
      const n = Math.ceil(text.length / 300_000);
      for (let i = 0; i < n; i++) ws.send(JSON.stringify({ type: 'frag', fid, i, n, s: text.slice(i * 300_000, (i + 1) * 300_000) }));
    },
    request: async (type, data = {}) => {
      const rid = crypto.randomUUID();
      c.send({ type, rid, ...data });
      const r = await c.next((m) => m.type === 'reply' && m.rid === rid, 15000);
      if (!r.ok) throw new Error(r.error);
      return r.data;
    },
    close: () => ws.close(),
  };
  return c;
}

// The blank template (like File > New) has just a stage; edit its name.
const stage = () => [...model.objs].find(([, o]) => o.t === 'stage')[0];
const named = (n) => ({ name: `<name>${n}</name>` });

test('owner sets up the design; editors get it in the welcome', async () => {
  const a = client('a@test.local');
  const hi = await a.next((m) => m.type === 'hi');
  assert.equal(hi.role, 'owner');
  assert.equal(hi.empty, true);
  await a.request('init', { model: toJson(model) });
  a.send({ type: 'hello', token: '' });
  const w = await a.next((m) => m.type === 'welcome');
  assert.equal(w.version, 0);
  assert.equal(w.name, 'Test rocket');
  assert.equal(Object.keys(w.model.objs).length, model.objs.size);
  assert.equal(w.motors[0].name, 'abcd1234-X1.eng');
  await assert.rejects(a.request('init', { model: toJson(model) }), /already/);
  a.close();
});

test('edits reach everyone; the sender gets them with its seq; viewers are read-only', async () => {
  const a = client('a@test.local', { conn: 'conn-a' });
  const b = client('b@test.local');
  const v = client('v@test.local');
  for (const c of [a, b, v]) {
    await c.next((m) => m.type === 'hi');
    c.send({ type: 'hello' });
    await c.next((m) => m.type === 'welcome');
  }
  const id = stage();
  a.send({ type: 'ops', seq: 1, ops: [{ op: 'set', id, v: named('Booster') }] });
  const atA = await a.next((m) => m.type === 'ops');
  const atB = await b.next((m) => m.type === 'ops');
  assert.equal(atA.seq, 1);
  assert.equal(atA.from, 'conn-a');
  assert.deepEqual(atB.ops, atA.ops);
  const act = await b.next((m) => m.type === 'activity');
  assert.match(act.text, /edited/);

  v.send({ type: 'ops', seq: 7, ops: [{ op: 'set', id, v: named('Viewer edit') }] });
  assert.equal((await v.next((m) => m.type === 'ack')).seq, 7);
  assert.match((await v.next((m) => m.type === 'notice')).message, /view-only/);
  await assert.rejects(b.next((m) => m.type === 'ops' && m.ops[0].v.name === '<name>Viewer edit</name>', 600));

  // A reconnect with the same id learns the last batch it got through.
  a.close();
  const a2 = client('a@test.local', { conn: 'conn-a' });
  await a2.next((m) => m.type === 'hi');
  a2.send({ type: 'hello' });
  const w = await a2.next((m) => m.type === 'welcome');
  assert.equal(w.lastSeq, 1);
  assert.equal(w.model.objs[id].v.name, '<name>Booster</name>');
  for (const c of [a2, b, v]) c.close();
});

test('presence lists who is here and what they selected', async () => {
  const a = client('a@test.local');
  const b = client('b@test.local');
  await a.next((m) => m.type === 'hi');
  await b.next((m) => m.type === 'hi');
  b.send({ type: 'presence', selection: [stage()] });
  const p = await a.next((m) => m.type === 'presence' && m.members.some((x) => x.selection.length));
  const bob = p.members.find((x) => x.email === 'b@test.local');
  assert.equal(bob.selection[0].name, 'Booster');
  a.close();
  b.close();
});

test('edit history, undo of one person\'s changes and restore', async () => {
  const a = client('a@test.local');
  const b = client('b@test.local');
  await a.next((m) => m.type === 'hi');
  await b.next((m) => m.type === 'hi');
  const id = stage();
  b.send({ type: 'ops', seq: 1, ops: [{ op: 'set', id, v: named('Second stage') }] });
  await b.next((m) => m.type === 'ops');
  const h = await a.request('history');
  const last = h.groups[0];
  assert.equal(last.userName, 'b');
  assert.match(JSON.stringify(last.changes), /Second stage/);
  const r = await a.request('revert', { mode: 'undo', from: last.from, to: last.to, userId: last.userId });
  assert.equal(r.applied, 1);
  const undone = await b.next((m) => m.type === 'ops' && m.ops.some((op) => op.v?.name === '<name>Booster</name>'));
  assert.ok(undone);
  a.send({ type: 'hello' });
  const w = await a.next((m) => m.type === 'welcome');
  assert.equal(w.model.objs[id].v.name, '<name>Booster</name>');
  a.close();
  b.close();
});

test('saved copies, export and large messages in fragments', async () => {
  const a = client('a@test.local');
  await a.next((m) => m.type === 'hi');
  const snaps = await a.request('snapshots');
  assert.ok(snaps.length >= 1);
  const first = await a.request('snapshot', { version: snaps.at(-1).version });
  assert.equal(Object.keys(first.model.objs).length, model.objs.size);
  // A big attachment-like object (1.5 MB) goes up and comes back in fragments.
  const big = 'x'.repeat(1_500_000);
  a.send({ type: 'ops', seq: 50, ops: [{ op: 'put', id: 'att:big.png', t: '#att', p: 'doc', o: 2000, k: ['data'], v: { '@': '', data: big } }] });
  const echoed = await a.next((m) => m.type === 'ops' && m.ops[0].id === 'att:big.png', 10000);
  assert.equal(echoed.ops[0].v.data.length, big.length);
  const ex = await a.request('export');
  assert.equal(ex.model.objs['att:big.png'].v.data.length, big.length);
  a.close();
});

test('people the design is not shared with are turned away', async () => {
  const x = client('x@test.local');
  const closed = await x.closed;
  assert.equal(closed.code, 4003);
});

test('only the owner can delete; then everyone is told', async () => {
  const a = client('a@test.local');
  const b = client('b@test.local');
  await a.next((m) => m.type === 'hi');
  await b.next((m) => m.type === 'hi');
  await assert.rejects(b.request('destroy'), /owner/);
  await a.request('destroy');
  assert.match((await b.next((m) => m.type === 'kick')).message, /deleted/);
  a.close();
  b.close();
});
