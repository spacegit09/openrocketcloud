// Sign-in through the Base44 front door: passes made by the Base44 functions' own signing code
// (frontdoor/base44/shared/sign.ts) are accepted once, and nothing else is.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SECRET = 'test-secret-0123456789';
const dataDir = mkdtempSync(join(tmpdir(), 'orc-frontdoor-'));

// A stand-in for the Base44 site, so registration can be checked too.
const registrations = [];
const fakeFrontDoor = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    registrations.push({ path: req.url, body: JSON.parse(body || '{}') });
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
  });
});
await new Promise((r) => fakeFrontDoor.listen(0, '127.0.0.1', r));
const FRONT = `http://127.0.0.1:${fakeFrontDoor.address().port}`;

Object.assign(process.env, {
  DATA_DIR: dataDir,
  PUBLIC_URL: 'https://engine.example',
  BASE44_APP_URL: `${FRONT}/`,
  BASE44_SECRET: SECRET,
  ALLOWED_EMAILS: 'mina@gmail.com,joon@gmail.com',
});
const { default: express } = await import('express');
const { authRouter, registerWithFrontDoor } = await import('../src/auth.js');
const { pass, mac, b64url } = await import('../../frontdoor/base44/shared/sign.ts');

const app = express();
app.use('/auth', authRouter());
const server = await new Promise((r) => {
  const s = app.listen(0, '127.0.0.1', () => r(s));
});
const BASE = `http://127.0.0.1:${server.address().port}`;

after(() => {
  server.close();
  fakeFrontDoor.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const mina = { id: 'u1', email: 'mina@gmail.com', full_name: 'Mina Park' };
const signIn = (token) => fetch(`${BASE}/auth/base44?pass=${encodeURIComponent(token)}`, { redirect: 'manual' });
const expired = `${FRONT}/?error=signin_expired`;

async function rawPass(payload, secret = SECRET) {
  const body = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  return `${body}.${await mac(secret, 'pass', body)}`;
}

test('a pass from the front door signs in once and goes to its page', async () => {
  const token = await pass(SECRET, mina, '/p/abc');
  const res = await signIn(token);
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/p/abc');
  assert.match(res.headers.get('set-cookie'), /^orc_session=[^;]+;.*HttpOnly/);

  const again = await signIn(token);
  assert.equal(again.headers.get('location'), expired, 'a pass works only once');
  assert.equal(again.headers.get('set-cookie'), null);
});

test('forged, altered and expired passes are refused', async () => {
  const forged = await pass('some-other-secret', mina, '/');
  assert.equal((await signIn(forged)).headers.get('location'), expired);

  const [body, sig] = (await pass(SECRET, mina, '/')).split('.');
  const altered = b64url(new TextEncoder().encode(
    new TextDecoder().decode(Buffer.from(body, 'base64url')).replace('mina@gmail.com', 'joon@gmail.com'),
  ));
  assert.equal((await signIn(`${altered}.${sig}`)).headers.get('location'), expired);

  const old = await rawPass({ sub: 'u1', email: 'mina@gmail.com', name: '', next: '/', exp: Date.now() - 1000, n: 'n-old' });
  assert.equal((await signIn(old)).headers.get('location'), expired);
  const tooLong = await rawPass({ sub: 'u1', email: 'mina@gmail.com', name: '', next: '/', exp: Date.now() + 3600e3, n: 'n-long' });
  assert.equal((await signIn(tooLong)).headers.get('location'), expired);

  assert.equal((await signIn('nonsense')).headers.get('location'), expired);
});

test('the allowed-email list still applies', async () => {
  const res = await signIn(await pass(SECRET, { id: 'u9', email: 'someone@else.com' }, '/'));
  assert.equal(res.headers.get('location'), `${FRONT}/?error=not_allowed`);
  assert.equal(res.headers.get('set-cookie'), null);
});

test('only same-site pages are followed after sign-in', async () => {
  for (const next of ['//evil.example', '/\\evil.example', 'https://evil.example']) {
    const res = await signIn(await pass(SECRET, mina, next));
    assert.equal(res.headers.get('location'), '/', next);
  }
});

test('sign in and sign out go through the front door', async () => {
  const login = await fetch(`${BASE}/auth/login?return=/p/xyz`, { redirect: 'manual' });
  assert.equal(login.headers.get('location'), `${FRONT}/?next=%2Fp%2Fxyz`);
  const out = await (await fetch(`${BASE}/auth/logout`, { method: 'POST' })).json();
  assert.equal(out.next, `${FRONT}/?signout=1`);
  const cfg = await (await fetch(`${BASE}/auth/config`)).json();
  assert.equal(cfg.frontDoor, FRONT);
});

test('the server registers its address with a signature the front door accepts', async () => {
  registerWithFrontDoor();
  for (let i = 0; i < 50 && !registrations.length; i++) await new Promise((r) => setTimeout(r, 20));
  const [reg] = registrations;
  assert.equal(reg.path, '/functions/registerEngine');
  assert.equal(reg.body.url, 'https://engine.example');
  assert.equal(reg.body.sig, await mac(SECRET, 'engine', `${reg.body.url}.${reg.body.ts}`));
});
