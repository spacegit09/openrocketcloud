// Who may do what with flight logbooks (base44/shared/logbooks.js), against an in-memory
// stand-in for Base44's entities; and that stored logbooks hold nothing in the clear.
import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError } from '../base44/shared/api.js';
import { logbooksApi } from '../base44/shared/logbooks.js';
import { sealer } from '../base44/shared/sealed.js';
import { fakeDb, MAX_RECORD } from './fake-base44.mjs';

function setup() {
  const db = fakeDb();
  const s = sealer(Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64'));
  const signed = [];
  const files = { sign: async (uri) => (signed.push(uri), `https://files.example/${encodeURIComponent(uri)}?sig=1`) };
  const as = (email, name) => (body) => logbooksApi({ db, s, me: { id: `id-${email}`, email, name }, files }, body);
  return { db, s, signed, mina: as('mina@example.com', 'Mina Park'), joon: as('joon@example.com', 'Joon Lee'), sora: as('sora@example.com', 'Sora Kim') };
}

const refused = (status) => (e) => e instanceof ApiError && e.status === status;
const DATA = { name: 'Altimeter', source: 'entered', time: 's', columns: [{ q: 'altitude', unit: 'm' }, { q: 'velocity', unit: 'm/s' }], rows: [[0, 0, 0], [1, 60, 80], [2, 110, 30], [3, 105, -10]] };
const PHOTO = { kind: 'photo', file_uri: 'private/u1/7f3a.jpg', name: 'liftoff.jpg', type: 'image/jpeg', size: 812345, w: 4000, h: 3000, preview: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==', thumb: 'data:image/jpeg;base64,/9j/thumbAAA=' };

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
  assert.deepEqual([card.photos, card.videos, card.cover], [1, 1, PHOTO.thumb], 'the card shows the photo\'s thumbnail');
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
  const stored = JSON.stringify([...db.Logbook.rows.values(), ...db.SealedPart.rows.values()]);
  for (const plain of ['example.com', 'mina', 'Mina Park', 'joon', 'Secret test', 'Hidden Valley', 'CATO', 'Telemetry', 'altitude', 'liftoff', '7f3a', '/9j/']) {
    assert.ok(!stored.includes(plain), `found "${plain}" in stored records`);
  }
});

test('a big altimeter file (5,560 rows, as an Altimeter Two logs) saves, reads back, and cleans up', async () => {
  const { db, mina } = setup();
  const b = await mina({ action: 'create', title: 'Big data' });
  const rows = Array.from({ length: 5560 }, (_, i) => [Math.round((0.005055 + i * 0.006454) * 1e6) / 1e6, Math.round(300 * Math.sin(i / 3500) * 100) / 100]);
  const added = await mina({ action: 'addDataset', id: b.id, dataset: { name: 'Altimeter', time: 's', columns: [{ q: 'altitude', unit: 'ft' }], rows } });
  assert.equal(added.datasets[0].count, 5560);
  assert.deepEqual((await mina({ action: 'get', id: b.id })).datasets[0].rows, rows);
  for (const r of [...db.Logbook.rows.values(), ...db.SealedPart.rows.values()]) assert.ok(JSON.stringify(r).length < MAX_RECORD);
  // A second one, photos with big previews, and a long note: the record itself stays small.
  await mina({ action: 'addDataset', id: b.id, dataset: { name: 'Again', time: 's', columns: [{ q: 'altitude', unit: 'ft' }], rows } });
  const bytes = new Uint8Array(150_000);
  for (let i = 0; i < bytes.length; i += 65_536) crypto.getRandomValues(bytes.subarray(i, i + 65_536));
  const big = `data:image/jpeg;base64,${Buffer.from(bytes).toString('base64')}`;
  for (let i = 0; i < 3; i++) await mina({ action: 'addMedia', id: b.id, item: { ...PHOTO, preview: big } });
  await mina({ action: 'update', id: b.id, notes: 'x'.repeat(19_000), description: 'y'.repeat(19_000) });
  const got = await mina({ action: 'get', id: b.id });
  assert.equal(got.datasets.length, 2);
  assert.ok(got.media.every((m) => m.preview === big));
  assert.equal(got.notes.length, 19_000);
  assert.equal((await mina({ action: 'list' }))[0].cover, PHOTO.thumb, 'the card shows the small thumbnail');
  await mina({ action: 'removeDataset', id: b.id, datasetId: got.datasets[0].id });
  await mina({ action: 'removeMedia', id: b.id, mediaId: got.media[0].id });
  await mina({ action: 'delete', id: b.id });
  assert.equal(db.SealedPart.rows.size, 0, 'nothing left behind');
});

test('a logbook saved before data sets were kept on their own still opens', async () => {
  const { db, s, mina } = setup();
  const b = await mina({ action: 'create', title: 'Old layout' });
  const r = db.Logbook.rows.get(b.id);
  const meta = await s.open(r.sealed);
  meta.datasets = [{ id: 'old1', name: 'Old', source: 'entered', time: 's', offset: 0, columns: [{ q: 'altitude', unit: 'm', name: '' }], count: 2 }];
  meta.media = [{ id: 'm1', kind: 'photo', file_uri: 'private/x.jpg', name: 'old.jpg', caption: '' }];
  db.Logbook.rows.set(b.id, { ...r, sealed: await s.seal(meta), sealed_data: await s.seal({ rows: { old1: [[0, 0], [1, 9]] }, previews: { m1: PHOTO.preview } }) });
  const got = await mina({ action: 'get', id: b.id });
  assert.deepEqual(got.datasets[0].rows, [[0, 0], [1, 9]]);
  assert.equal(got.media[0].preview, PHOTO.preview);
  const added = await mina({ action: 'addDataset', id: b.id, dataset: DATA });
  assert.deepEqual(added.datasets.map((d) => d.rows.length), [2, 4], 'old and new together');
});
