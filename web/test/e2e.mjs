// End-to-end check of the browser version on this computer: two headless Chrome windows run the
// real OpenRocket (CheerpJ) on the design page, connected through the local stand-in for the
// DesignRoom actor (hub.mjs). Screenshots go to test/out/.
//   node test/e2e.mjs
import { mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import puppeteer from 'puppeteer-core';
import { createServer } from 'vite';
import WebSocket from 'ws';
import { startHub } from './hub.mjs';
import { importOrk } from '../src/lib/ork.js';
import { toJson } from '../../server/src/model.js';

const HUB = 8788;
const WEB = 5180;
const out = join(import.meta.dirname, 'out');
mkdirSync(out, { recursive: true });
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

const designs = new Map([['e2e', { name: 'E2E rocket', owner: 'a@test.local', members: { 'b@test.local': 'editor' } }]]);
const hub = startHub({ port: HUB, designs });
const vite = await createServer({ root: join(import.meta.dirname, '..'), server: { port: WEB, strictPort: true }, logLevel: 'warn' });
await vite.listen();

// A watcher connected like a page: sets the design up and records the ops it sees.
const seen = [];
const watcher = new WebSocket(`ws://localhost:${HUB}/?design=e2e&user=a@test.local&conn=watcher`);
const frags = new Map();
const replies = new Map();
watcher.on('message', (d) => {
  let m = JSON.parse(d.toString());
  if (m.type === 'frag') {
    const parts = frags.get(m.fid) ?? [];
    parts[m.i] = m.s;
    frags.set(m.fid, parts);
    if (parts.filter((x) => x !== undefined).length < m.n) return;
    m = JSON.parse(parts.join(''));
  }
  if (m.type === 'reply') replies.get(m.rid)?.(m);
  if (m.type === 'ops') seen.push(m);
});
await new Promise((r) => watcher.on('open', r));
const request = (type, data) => new Promise((resolve) => {
  const rid = crypto.randomUUID();
  replies.set(rid, resolve);
  watcher.send(JSON.stringify({ type, rid, ...data }));
});
const blank = await importOrk(new Uint8Array(readFileSync(join(import.meta.dirname, '..', '..', 'server', 'templates', 'new-rocket.ork'))));
const init = await request('init', { model: toJson(blank) });
log('design set up:', init.ok ? 'ok' : init.error);
const stageId = [...blank.objs].find(([, o]) => o.t === 'stage')[0];

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  userDataDir: mkdtempSync(join(tmpdir(), 'orc-e2e-')),
});
async function openAs(user) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  page.on('console', (m) => {
    const t = m.text();
    if (/Exception|ERROR|FAILED|liveshare|Live share/i.test(t) && !/syncWorld|flush user prefs/.test(t)) log(`${user} console:`, t.slice(0, 300));
  });
  page.on('pageerror', (e) => log(`${user} page error:`, e.message));
  await page.goto(`http://localhost:${WEB}/design.html?id=e2e&hub=ws://localhost:${HUB}&user=${user}`);
  return page;
}
const waitLive = async (page, user) => {
  const t0 = Date.now();
  await page.waitForFunction(() => ['Live', 'Viewing'].includes(document.querySelector('#status')?.textContent), { timeout: 120_000 });
  log(`${user}: OpenRocket ready after ${((Date.now() - t0) / 1000).toFixed(0)} s`);
};

let failed = false;
const check = (ok, what) => {
  log(ok ? 'PASS' : 'FAIL', what);
  if (!ok) failed = true;
};

try {
  const a = await openAs('a@test.local');
  const b = await openAs('b@test.local');
  await Promise.all([waitLive(a, 'A'), waitLive(b, 'B')]);
  await new Promise((r) => setTimeout(r, 3000));
  await a.screenshot({ path: join(out, '1-a-open.png') });

  // 1) An edit arriving from the room shows up in both OpenRockets.
  watcher.send(JSON.stringify({ type: 'ops', seq: 1, ops: [{ op: 'set', id: stageId, v: { name: '<name>Booster</name>' } }] }));
  await new Promise((r) => setTimeout(r, 4000));
  await a.screenshot({ path: join(out, '2-a-after-rename.png') });
  await b.screenshot({ path: join(out, '2-b-after-rename.png') });

  // 2) Adding a nose cone in A's OpenRocket reaches the room (and from there B).
  const before = seen.length;
  await a.mouse.click(83, 149); // select the stage ("Booster") in OpenRocket's component tree
  await new Promise((r) => setTimeout(r, 1500));
  await a.mouse.click(520, 292); // "Nose Cone" in the "Add new component" panel
  const t0 = Date.now();
  let put = null;
  while (!put && Date.now() - t0 < 30_000) {
    put = seen.slice(before).flatMap((m) => m.ops).find((op) => op.op === 'put' && op.t === 'nosecone');
    if (!put) await new Promise((r) => setTimeout(r, 250));
  }
  check(Boolean(put), `nose cone added in A reached the room (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  await new Promise((r) => setTimeout(r, 4000));
  await a.screenshot({ path: join(out, '3-a-after-nosecone.png') });
  await b.screenshot({ path: join(out, '3-b-after-nosecone.png') });

  // The room's copy now has the nose cone and the new stage name.
  const exp = await request('export', {});
  const objs = Object.values(exp.data.model.objs);
  check(objs.some((o) => o.t === 'nosecone'), 'room copy has the nose cone');
  check(objs.some((o) => o.t === 'stage' && o.v.name === '<name>Booster</name>'), 'room copy has the renamed stage');
} catch (e) {
  failed = true;
  log('ERROR', e.stack ?? e);
} finally {
  await browser.close();
  watcher.close();
  await vite.close();
  await hub.close();
  log(failed ? 'E2E FAILED' : 'E2E PASSED', `screenshots in ${out}`);
  process.exit(failed ? 1 : 0);
}
