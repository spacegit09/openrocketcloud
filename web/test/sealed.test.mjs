// Sealing of personal data (base44/shared/sealed.js).
import assert from 'node:assert/strict';
import test from 'node:test';
import { sealer } from '../base44/shared/sealed.js';

const key = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64');

test('sealed values open again, and do not contain the plain text', async () => {
  const s = sealer(key());
  const value = { name: 'Two stage high power rocket', owner_email: 'mina@example.com', members: [{ email: 'joon@example.com', role: 'editor' }] };
  const sealed = await s.seal(value);
  assert.deepEqual(await s.open(sealed), value);
  for (const plain of ['Two stage', 'mina', 'example.com', 'joon']) assert.ok(!sealed.includes(plain));
  assert.notEqual(await s.seal(value), sealed, 'each seal uses a fresh nonce');
});

test('large values (motor files) round trip', async () => {
  const s = sealer(key());
  const content = 'X42 29 124 0 0.05 0.1 TeamRocket\n'.repeat(15_000);
  assert.equal((await s.open(await s.seal({ content }))).content, content);
});

test('lookup keys are stable, ignore case, and differ per key and per address', async () => {
  const k = key();
  const a = sealer(k);
  const b = sealer(k);
  assert.equal(await a.lookupKey('Mina@Example.com '), await b.lookupKey('mina@example.com'));
  assert.notEqual(await a.lookupKey('mina@example.com'), await a.lookupKey('joon@example.com'));
  assert.notEqual(await a.lookupKey('mina@example.com'), await sealer(key()).lookupKey('mina@example.com'));
  assert.ok(!(await a.lookupKey('mina@example.com')).includes('mina'));
});

test('altered data or another key is refused', async () => {
  const s = sealer(key());
  const sealed = await s.seal({ name: 'Rocket' });
  const bytes = Buffer.from(sealed.slice(3), 'base64');
  bytes[bytes.length - 1] ^= 1;
  await assert.rejects(s.open(`v1.${bytes.toString('base64')}`));
  await assert.rejects(sealer(key()).open(sealed));
  await assert.rejects(s.open('plain text'));
});

test('a missing or malformed key is refused', () => {
  assert.throws(() => sealer(undefined), /DATA_KEY/);
  assert.throws(() => sealer('short'), /DATA_KEY/);
});
