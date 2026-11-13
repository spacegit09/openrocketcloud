// Who may do what with flight logbooks (base44/shared/logbooks.js), against an in-memory
// stand-in for Base44's entities; and that stored logbooks hold nothing in the clear.
import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError } from '../base44/shared/api.js';
import { logbooksApi } from '../base44/shared/logbooks.js';
import { sealer } from '../base44/shared/sealed.js';

function fakeDb() {
  let clock = Date.parse('2026-01-01T00:00:00Z');
  const now = () => new Date((clock += 1000)).toISOString();
  const rows = new Map();
  const matches = (r, q) => Object.entries(q).every(([k, v]) => (Array.isArray(r[k]) ? r[k] : [r[k]]).some((x) => (Array.isArray(v) ? v : [v]).includes(x)));
  return {
    Logbook: {
      rows,
      async filter(q, sort = '-created_date', limit = 500) {
        const f = sort.replace(/^-/, '');
        const d = sort.startsWith('-') ? -1 : 1;
        return [...rows.values()].filter((r) => matches(r, q)).sort((a, b) => (a[f] < b[f] ? -d : a[f] > b[f] ? d : 0)).slice(0, limit).map((r) => ({ ...r }));
      },
      async get(id) {
        if (!rows.has(id)) throw new Error('not found');
        return { ...rows.get(id) };
      },
      async create(data) {
        const at = now();
        const r = { ...data, id: crypto.randomUUID().replace(/-/g, '').slice(0, 24), created_date: at, updated_date: at };
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
    },
  };
}

function setup() {
  const db = fakeDb();
  const s = sealer(Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64'));
  const signed = [];
  const files = { sign: async (uri) => (signed.push(uri), `https://files.example/${encodeURIComponent(uri)}?sig=1`) };
  const as = (email, name) => (body) => logbooksApi({ db, s, me: { id: `id-${email}`, email, name }, files }, body);
  return { db, signed, mina: as('mina@example.com', 'Mina Park'), joon: as('joon@example.com', 'Joon Lee'), sora: as('sora@example.com', 'Sora Kim') };
}

const refused = (status) => (e) => e instanceof ApiError && e.status === status;
const DATA = { name: 'Altimeter', source: 'entered', time: 's', columns: [{ q: 'altitude', unit: 'm' }, { q: 'velocity', unit: 'm/s' }], rows: [[0, 0, 0], [1, 60, 80], [2, 110, 30], [3, 105, -10]] };
const PHOTO = { kind: 'photo', file_uri: 'private/u1/7f3a.jpg', name: 'liftoff.jpg', type: 'image/jpeg', size: 812345, w: 4000, h: 3000, preview: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==' };

test('the owner makes a logbook, fills it in, and lists it; others see nothing', async () => {
  const { mina, joon } = setup();
  const b = await mina({ action: 'create', title: ' Club launch ', details: { date: '2026-03-07', location: 'Seoul' } });
  assert.equal(b.title, 'Club launch');
  assert.equal(b.role, 'owner');
  assert.deepEqual(b.details, { date: '2026-03-07', location: 'Seoul' });
  const u = await mina({ action: 'update', id: b.id, details: { time: '10:30', weather: 'Calm', bogus: 'x' }, description: 'First flight', notes: 'Recovered fine' });
  assert.deepEqual(u.details, { date: '2026-03-07', location: 'Seoul', time: '10:30', weather: 'Calm' });
  assert.equal(u.description, 'First flight');
  assert.equal(u.version, 1);
  const [card] = await mina({ action: 'list' });
  assert.deepEqual([card.id, card.title, card.datasets, card.photos], [b.id, 'Club launch', 0, 0]);
  assert.deepEqual(await joon({ action: 'list' }), []);
  for (const action of ['get', 'update', 'addDataset', 'mediaUrls', 'people', 'share', 'delete']) {
    await assert.rejects(joon({ action, id: b.id, title: 'x' }), refused(404), action);
  }
  await assert.rejects(mina({ action: 'create', title: '  ' }), refused(400));
});

test('data sets: added checked, renamed, shifted, hidden, removed; the card\'s curve follows', async () => {
  const { mina } = setup();
  const b = await mina({ action: 'create', title: 'Data' });
  const withData = await mina({ action: 'addDataset', id: b.id, dataset: DATA });
  const ds = withData.datasets[0];
  assert.deepEqual([ds.name, ds.count, ds.rows.length], ['Altimeter', 4, 4]);
  assert.equal((await mina({ action: 'list' }))[0].spark.length, 4);
  const changed = await mina({ action: 'updateDataset', id: b.id, datasetId: ds.id, name: 'Main altimeter', offset: -0.5, hidden: true });
  assert.deepEqual([changed.datasets[0].name, changed.datasets[0].offset, changed.datasets[0].hidden], ['Main altimeter', -0.5, true]);
  for (const bad of [
    { ...DATA, rows: [[0, 0, 0]] },
    { ...DATA, rows: [[0, 0, 0], [1, 2]] },
    { ...DATA, rows: [[0, 0, 0], [1, 2, 'x']] },
    { ...DATA, columns: [] },
    { ...DATA, columns: [{ q: 'colour', unit: '' }] },
  ]) {
    await assert.rejects(mina({ action: 'addDataset', id: b.id, dataset: bad }), refused(400));
  }
  const gone = await mina({ action: 'removeDataset', id: b.id, datasetId: ds.id });
  assert.deepEqual(gone.datasets, []);
  assert.equal((await mina({ action: 'list' }))[0].spark, null);
});

test('photos and videos: recorded with previews, captions, links for everyone shared with', async () => {
  const { mina, joon, signed } = setup();
  const b = await mina({ action: 'create', title: 'Media' });
  const added = await mina({ action: 'addMedia', id: b.id, item: PHOTO });
  const m = added.media[0];
  assert.equal(added.added, m.id);
  assert.deepEqual([m.kind, m.name, m.preview], ['photo', 'liftoff.jpg', PHOTO.preview]);
  await mina({ action: 'addMedia', id: b.id, item: { kind: 'video', file_uri: 'private/u1/v.mp4', name: 'flight.mp4', preview: '<script>' } });
  const [card] = await mina({ action: 'list' });
  assert.deepEqual([card.photos, card.videos, card.cover], [1, 1, PHOTO.preview]);
  assert.equal((await mina({ action: 'get', id: b.id })).media[1].preview, null, 'only image previews are kept');
  await mina({ action: 'updateMedia', id: b.id, mediaId: m.id, caption: 'Liftoff!' });
  await mina({ action: 'share', id: b.id, members: [{ email: 'joon@example.com', role: 'viewer' }] });
  const urls = await joon({ action: 'mediaUrls', id: b.id });
  assert.equal(Object.keys(urls).length, 2);
  assert.match(urls[m.id], /^https:\/\/files\.example\/private%2Fu1%2F7f3a\.jpg/);
  assert.deepEqual(signed.slice(-2), ['private/u1/7f3a.jpg', 'private/u1/v.mp4'], 'signed as the service role, whoever uploaded');
  await assert.rejects(mina({ action: 'addMedia', id: b.id, item: { kind: 'photo' } }), refused(400));
  const removed = await mina({ action: 'removeMedia', id: b.id, mediaId: m.id });
  assert.equal(removed.media.length, 1);
  assert.equal((await mina({ action: 'list' }))[0].cover, null);
});

test('sharing: editors change the contents, viewers only read, only the owner shares and deletes', async () => {
  const { mina, joon, sora } = setup();
  const b = await mina({ action: 'create', title: 'Shared' });
  await mina({ action: 'share', id: b.id, members: [{ email: 'Joon@Example.com', role: 'editor' }, { email: 'sora@example.com', role: 'viewer' }] });
  assert.deepEqual((await mina({ action: 'people', id: b.id })).members, [{ email: 'joon@example.com', role: 'editor' }, { email: 'sora@example.com', role: 'viewer' }]);
  assert.equal((await joon({ action: 'list' }))[0].role, 'editor');
  assert.equal((await joon({ action: 'update', id: b.id, notes: 'Joon was here' })).notes, 'Joon was here');
  await joon({ action: 'addDataset', id: b.id, dataset: DATA });
  assert.equal((await sora({ action: 'get', id: b.id })).datasets.length, 1, 'viewers see everything');
  for (const action of ['update', 'addDataset', 'removeDataset', 'addMedia', 'updateMedia', 'removeMedia', 'updateDataset']) {
    await assert.rejects(sora({ action, id: b.id, notes: 'x', dataset: DATA, item: PHOTO }), refused(403), action);
  }
  await assert.rejects(joon({ action: 'share', id: b.id, members: [] }), refused(403));
  await assert.rejects(joon({ action: 'delete', id: b.id }), refused(403));
  assert.deepEqual(await sora({ action: 'leave', id: b.id }), { ok: true });
  assert.deepEqual(await sora({ action: 'list' }), []);
  await assert.rejects(mina({ action: 'leave', id: b.id }), refused(400));
  await mina({ action: 'delete', id: b.id });
  assert.deepEqual(await joon({ action: 'list' }), []);
});

test('stored logbooks hold no names, emails, notes, data or files in the clear', async () => {
  const { db, mina } = setup();
  const b = await mina({ action: 'create', title: 'Secret test flight', details: { location: 'Hidden Valley' } });
  await mina({ action: 'update', id: b.id, notes: 'Motor CATO at 2 s' });
  await mina({ action: 'addDataset', id: b.id, dataset: { ...DATA, name: 'Telemetry' } });
  await mina({ action: 'addMedia', id: b.id, item: PHOTO });
  await mina({ action: 'share', id: b.id, members: [{ email: 'joon@example.com', role: 'editor' }] });
  const stored = JSON.stringify([...db.Logbook.rows.values()]);
  for (const plain of ['example.com', 'mina', 'Mina Park', 'joon', 'Secret test', 'Hidden Valley', 'CATO', 'Telemetry', 'altitude', 'liftoff', '7f3a', '/9j/']) {
    assert.ok(!stored.includes(plain), `found "${plain}" in stored records`);
  }
});
