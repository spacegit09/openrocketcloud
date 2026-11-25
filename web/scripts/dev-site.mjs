#!/usr/bin/env node
// Runs the whole site on this computer, to try changes before publishing them. Vite serves the
// pages; the backend functions are answered here by their real code (base44/shared), over
// in-memory records, as the browser tests do; designs open in a local stand-in for the
// live-sharing room (test/hub.mjs), with the custom motors of their people in OpenRocket's motor
// list, as on the site. Nothing reaches Base44 or Paddle, and everything made here is gone when
// this stops. Plans count as they will once Paddle takes payments (CHECKOUT_OPEN), for three
// people, each with a free week that has ended:
//   dev-full        Dev Full, with the Individual plan (everything)
//   dev-openrocket  Dev OpenRocket, with the OpenRocket plan (OpenRocket only)
//   dev-ended       Dev Ended, without a plan
// Open any page with ?access_token=<one of those> to be that person (the page remembers it until
// another). Dev Full has one design ready, OpenRocket's "A simple model rocket".
//
//   node web/scripts/dev-site.mjs
//
// Not here: Google sign-in, payments, the Launch Planner's forecasts (gfsWinds) and photo uploads.
// After changing Java (worker/bridge), run scripts/build-web-jars.sh and reload the page.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'vite';
import WebSocket from 'ws';
import { toJson } from '../../server/src/model.js';
import { designsApi, flightsApi, motorDesignsApi, motorsApi } from '../base44/shared/api.js';
import { billingApi, forgetAccess, OPEN_ACTIONS, requirePlan, setCheckoutOpen, setPlansStart, TRIAL_MS } from '../base44/shared/billing.js';
import { logbooksApi } from '../base44/shared/logbooks.js';
import { sealer } from '../base44/shared/sealed.js';
import { importOrk } from '../src/lib/ork.js';
import { readZip } from '../src/lib/zip.js';
import { fakeDb } from '../test/fake-base44.mjs';
import { startHub } from '../test/hub.mjs';

const web = join(import.meta.dirname, '..');
const PORT = Number(process.env.DEV_PORT ?? 5192);
const HUB_PORT = Number(process.env.DEV_HUB_PORT ?? 8796);

const APIS = { designs: designsApi, motors: motorsApi, flights: flightsApi, logbooks: logbooksApi, motorDesigns: motorDesignsApi, billing: billingApi };
// The functions that need a plan with everything, as their entry.ts says (endpoint's `full`).
const FULL = new Set(readdirSync(join(web, 'base44', 'functions')).filter((name) => {
  try {
    return /\bfull:\s*true\b/.test(readFileSync(join(web, 'base44', 'functions', name, 'entry.ts'), 'utf8'));
  } catch {
    return false;
  }
}));

const db = fakeDb(['Design', 'Motor', 'SavedFlight', 'MotorDesign', 'Logbook', 'SealedPart', 'User', 'Account', 'Purchase', 'Group']);
const s = sealer(Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64'));
setPlansStart(Date.parse('2026-11-01T00:00:00Z'));
setCheckoutOpen(true);
// The rooms: each design made here, for the hub (id -> { name, owner, members }).
const rooms = new Map();

/** A backend function, as functions/*\/entry.ts runs it (shared/endpoint.ts). */
async function call(name, user, body) {
  const me = { id: user.id, email: user.email, name: user.full_name, created: user.created_date, role: user.role };
  const ctx = { db, s, me, paddle: null, paddleToken: null, files: { sign: async () => null } };
  try {
    if (OPEN_ACTIONS[name]) await requirePlan(ctx, String(body?.action ?? ''), OPEN_ACTIONS[name], { full: FULL.has(name) });
    const json = await APIS[name](ctx, body);
    if (name === 'designs' && body?.action === 'create' && json?.id) rooms.set(json.id, { name: json.name, owner: user.email, members: {} });
    return { status: 200, json };
  } catch (e) {
    if (e.status) return { status: e.status, json: { error: e.message, ...(e.code ? { code: e.code } : {}) } };
    console.error(name, e);
    return { status: 500, json: { error: 'Something went wrong.' } };
  }
}

// The three people, signed up 8 days ago (after FREE_BEFORE), so their free week is over.
const PEOPLE = {
  'dev-full': { email: 'full@dev.local', name: 'Dev Full', plan: 'lifetime' },
  'dev-openrocket': { email: 'openrocket@dev.local', name: 'Dev OpenRocket', plan: 'openrocket' },
  'dev-ended': { email: 'ended@dev.local', name: 'Dev Ended', plan: null },
};
const users = new Map(); // token -> Base44 user record
const created = new Date(Date.now() - 8 * 24 * 3600_000).toISOString().replace('Z', '');
for (const [token, p] of Object.entries(PEOPLE)) {
  const u = await db.User.create({ email: p.email, full_name: p.name, role: 'user' });
  db.User.rows.get(u.id).created_date = created;
  const user = { ...u, created_date: created };
  users.set(token, user);
  await call('billing', user, { action: 'status' }); // their Account, with their free week
  const [a] = await db.Account.filter({ user_id: u.id });
  await db.Account.update(a.id, { trial_started: new Date(Date.now() - TRIAL_MS - 24 * 3600_000).toISOString() });
  if (p.plan) await db.Purchase.create({ paddle_id: `txn_01dev${p.plan}`.padEnd(30, '0'), kind: p.plan, user_id: u.id, status: 'completed', seats: 0 });
}
forgetAccess();
const byEmail = (email) => [...users.values()].find((u) => u.email === email);

startHub({
  port: HUB_PORT,
  designs: rooms,
  // As the DesignRoom actor asks the designs function: the custom motors of the design's people.
  motors: async (designId, email) => {
    const u = byEmail(email);
    const r = u ? await call('designs', u, { action: 'motors', id: designId }) : null;
    return r?.status === 200 ? r.json : [];
  },
});

const json = (res, status, body) => {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
};
const readBody = (req) => new Promise((resolve) => {
  let text = '';
  req.on('data', (c) => (text += c));
  req.on('end', () => {
    try {
      resolve(JSON.parse(text || '{}'));
    } catch {
      resolve({});
    }
  });
});

const backend = {
  name: 'dev-site-backend',
  enforce: 'pre',
  configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      const url = new URL(req.url, `http://localhost:${PORT}`);
      // A design opened from the site's own links: into the local room, as its owner.
      if (url.pathname === '/design.html' && url.searchParams.get('id') && !url.searchParams.get('hub')) {
        const room = rooms.get(url.searchParams.get('id'));
        const owner = byEmail(room?.owner ?? PEOPLE['dev-full'].email);
        url.searchParams.set('hub', `ws://localhost:${HUB_PORT}`);
        url.searchParams.set('user', owner.email);
        url.searchParams.set('name', owner.full_name);
        res.statusCode = 302;
        res.setHeader('Location', url.pathname + url.search);
        return res.end();
      }
      if (!url.pathname.startsWith('/api/')) return next();
      const user = users.get(String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, ''));
      if (/\/entities\/User\/me$/.test(url.pathname)) return user ? json(res, 200, user) : json(res, 401, { message: 'Not signed in.' });
      const fn = url.pathname.match(/\/functions\/(\w+)$/)?.[1];
      if (fn && APIS[fn]) {
        if (!user) return json(res, 401, { error: 'Not signed in.' });
        const r = await call(fn, user, await readBody(req));
        return json(res, r.status, r.json);
      }
      return json(res, 200, {});
    });
  },
};

const vite = await createServer({ root: web, server: { port: PORT, strictPort: true }, logLevel: 'warn', plugins: [backend] });
await vite.listen();

// Dev Full's example design, with its content in the room as when it is first opened on the site.
const jar = join(web, 'public', 'or', 'OpenRocket-web.jar');
const entries = await readZip(new Uint8Array(readFileSync(jar))).catch((e) => {
  throw new Error(`Cannot read ${jar} (${e.message}): run scripts/build-web-jars.sh first.`);
});
const example = entries.find((e) => e.name === 'datafiles/examples/A simple model rocket.ork');
const full = users.get('dev-full');
const design = (await call('designs', full, { action: 'create', name: 'A simple model rocket' })).json;
const ws = new WebSocket(`ws://localhost:${HUB_PORT}/?design=${design.id}&user=${full.email}&conn=dev-setup`);
await new Promise((ok, fail) => (ws.on('open', ok), ws.on('error', fail)));
ws.send(JSON.stringify({ type: 'init', rid: 'dev', model: toJson(await importOrk(example.data)) }));

console.log('The site, with three people (open a page with ?access_token=… to be one of them):');
for (const [token, p] of Object.entries(PEOPLE)) console.log(`  ${p.name.padEnd(15)} http://localhost:${PORT}/?access_token=${token}`);
console.log(`READY http://localhost:${PORT}/motor.html?access_token=dev-full`);
