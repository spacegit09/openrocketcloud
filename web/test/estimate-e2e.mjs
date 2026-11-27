// End-to-end check of the flight estimate at the bottom left of OpenRocket's design window
// (apogee, max velocity, max acceleration; RocketPanel in worker/bridge/web): the real OpenRocket
// (CheerpJ) in headless Chrome on the design page, with OpenRocket's example "A simple model
// rocket" in the local room stand-in (hub.mjs). It checks that
//   - an up-to-date simulation of the design is shown as it is (no estimate at opening);
//   - nothing is worked out while an edit window is open, however many numbers change in it;
//   - the estimate starts once the window is closed with OK, and its numbers are right;
//   - meanwhile the next edit window opens as quickly as when OpenRocket is idle, and the page
//     never stalls;
//   - the estimate changes nothing in the design (no edit reaches the room).
// The page runs with ?debug=1, where each estimate's time and numbers go to the console.
// Clicks are at OpenRocket's places in a 1400 × 900 window (as e2e.mjs). Screenshots in test/out/.
//   node test/estimate-e2e.mjs
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';
import { createServer } from 'vite';
import WebSocket from 'ws';
import { startHub } from './hub.mjs';
import { importOrk } from '../src/lib/ork.js';
import { readZip } from '../src/lib/zip.js';
import { toJson } from '../../server/src/model.js';

const HUB = 8792;
const WEB = 5192;
const out = join(import.meta.dirname, 'out');
mkdirSync(out, { recursive: true });
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(3)} s]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const designs = new Map([['estimate', { name: 'Estimate rocket', owner: 'a@test.local', members: {} }]]);
const hub = startHub({ port: HUB, designs });
const vite = await createServer({ root: join(import.meta.dirname, '..'), server: { port: WEB, strictPort: true }, logLevel: 'warn' });
await vite.listen();

// The room's edits, as a page connected to it sees them.
const ops = [];
const watcher = new WebSocket(`ws://localhost:${HUB}/?design=estimate&user=a@test.local&conn=watcher`);
const replies = new Map();
watcher.on('message', (d) => {
  const m = JSON.parse(d.toString());
  if (m.type === 'reply') replies.get(m.rid)?.(m);
  if (m.type === 'ops') ops.push(Date.now());
});
await new Promise((r) => watcher.on('open', r));
const request = (type, data) => new Promise((resolve) => {
  const rid = crypto.randomUUID();
  replies.set(rid, resolve);
  watcher.send(JSON.stringify({ type, rid, ...data }));
});
const jar = new Uint8Array(readFileSync(join(import.meta.dirname, '..', 'public', 'or', 'OpenRocket-web.jar')));
const ork = (await readZip(jar)).find((e) => e.name === 'datafiles/examples/A simple model rocket.ork').data;
await request('init', { model: toJson(await importOrk(ork)) });

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  userDataDir: mkdtempSync(join(tmpdir(), 'orc-estimate-')),
});

let failed = false;
const check = (ok, what) => {
  log(ok ? 'PASS' : 'FAIL', what);
  if (!ok) failed = true;
};

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  const started = [];
  const finished = [];
  page.on('console', (m) => {
    const t = m.text();
    if (t.includes('[flight estimate] started')) started.push(Date.now());
    const done = /\[flight estimate\] (\d+) ms: apogee ([\d.]+) m, max velocity ([\d.]+) m\/s, max acceleration ([\d.]+)/.exec(t);
    if (done) finished.push({ at: Date.now(), ms: Number(done[1]), apogee: Number(done[2]), velocity: Number(done[3]), acceleration: Number(done[4]) });
    if (/Exception|ERROR/.test(t) && !/syncWorld|flush user prefs/.test(t)) log('console:', t.slice(0, 300));
  });
  page.on('pageerror', (e) => log('page error:', e.message));
  // The page's longest stalls: the gaps between ticks of a 10 ms timer.
  await page.evaluateOnNewDocument(() => {
    window.__gaps = [];
    let last = performance.now();
    setInterval(() => {
      const now = performance.now();
      window.__gaps.push([performance.timeOrigin + now, now - last]);
      if (window.__gaps.length > 30000) window.__gaps.shift();
      last = now;
    }, 10);
  });
  const longestStall = (from, to) => page.evaluate((from, to) => Math.round(Math.max(0, ...window.__gaps.filter(([at]) => at >= from && at <= to).map(([, gap]) => gap))), from, to);

  await page.goto(`http://localhost:${WEB}/design.html?id=estimate&hub=ws://localhost:${HUB}&user=a@test.local&debug=1`);
  await page.waitForFunction(() => ['Live', 'Viewing'].includes(document.querySelector('#status')?.textContent), { timeout: 240_000 });
  log('OpenRocket ready');
  await sleep(10_000); // OpenRocket's first seconds: it still loads its part presets

  const click = (x, y) => page.mouse.click(x, y);
  /** Clicks Edit and times until the edit window's title bar is drawn. */
  const openWindow = async () => {
    // (captureBeyondViewport: false, or each screenshot resizes the page, and OpenRocket's window with it)
    const shot = () => page.screenshot({ clip: { x: 345, y: 252, width: 300, height: 18 }, encoding: 'base64', captureBeyondViewport: false });
    const before = await shot();
    const t = Date.now();
    await click(391, 239); // Edit
    while (Date.now() - t < 30_000 && (await shot()) === before) await sleep(50);
    return Date.now() - t;
  };
  const OK = [1010, 627];
  const CANCEL = [932, 627];
  const NOSE_CONE = [115, 126];
  const BODY_TUBE = [113, 143];
  /** Replaces the number in the edit window's field at (x, y). */
  const setField = async (x, y, value) => {
    await click(x, y);
    await page.keyboard.press('End');
    for (let i = 0; i < 6; i++) await page.keyboard.press('Backspace');
    await page.keyboard.type(value, { delay: 60 });
    await page.keyboard.press('Tab');
  };

  // 1) The design's simulation of its configuration (C6-5) is up to date: shown, nothing worked out.
  check(started.length === 0, 'at opening, the design\'s own up-to-date simulation is shown (no estimate)');
  await page.screenshot({ path: join(out, 'estimate-1-open.png') });

  // How long the nose cone's edit window takes to open while OpenRocket is idle (the second time:
  // the first loads its classes).
  let idle = Infinity;
  for (let i = 0; i < 2; i++) {
    await click(...NOSE_CONE);
    await sleep(1200);
    idle = Math.min(idle, await openWindow());
    await sleep(1500);
    await click(...CANCEL);
    await sleep(2000);
  }
  log(`the nose cone's edit window opens in ${idle} ms while OpenRocket is idle`);

  // 2) Two numbers changed in the body tube's edit window: no estimate while it is open.
  await click(...BODY_TUBE);
  await sleep(500);
  await click(...BODY_TUBE);
  await sleep(1200);
  await openWindow();
  await sleep(1500);
  const opsBefore = ops.length;
  await setField(450, 361, '350'); // length (mm), from 300
  await sleep(1500);
  await setField(450, 476, '2'); // wall thickness (mm), from 1
  await sleep(3000);
  check(ops.length > opsBefore, 'the edits in the window reached the room');
  check(started.length === 0, 'no estimate while the edit window is open, after two changes in it');
  await page.screenshot({ path: join(out, 'estimate-2-editing.png') });

  // 3) OK, and at once the next task: the nose cone's edit window.
  const okAt = Date.now();
  await click(...OK);
  await sleep(300);
  await click(...NOSE_CONE);
  await sleep(300);
  const during = await openWindow();
  check(started.length === 1 && started[0] - okAt < 2000, `the estimate started once the window was closed with OK (after ${started[0] ? started[0] - okAt : '-'} ms)`);
  check(during < idle + 700, `meanwhile the next edit window opened in ${during} ms (${idle} ms when idle)`);
  await page.screenshot({ path: join(out, 'estimate-3-next-window.png') });

  const t = Date.now();
  while (!finished.length && Date.now() - t < 60_000) await sleep(200);
  const result = finished[0];
  check(Boolean(result), `the estimate finished${result ? ` in ${result.ms} ms` : ''}`);
  if (result) {
    // OpenRocket's own simulation of this rocket: about 258 m, 75.9 m/s and 149 m/s² (its apogee
    // varies by about a metre between runs: random turbulence).
    check(result.apogee > 250 && result.apogee < 266 && result.velocity > 74 && result.velocity < 78 && result.acceleration > 145 && result.acceleration < 153,
      `its numbers: apogee ${result.apogee} m, max velocity ${result.velocity} m/s, max acceleration ${result.acceleration} m/s²`);
    check(ops.filter((at) => at > okAt).length === 0, 'the estimate changed nothing in the design (no edit reached the room)');
    const stall = await longestStall(okAt, result.at);
    check(stall < 100, `the page never stalled while it worked (longest: ${stall} ms)`);
  }
  await sleep(1000);
  await page.screenshot({ path: join(out, 'estimate-4-done.png') });
  await click(...CANCEL);
  await sleep(1000);
  check(started.length === 1, 'nothing more was worked out (the nose cone\'s window changed nothing)');
} catch (e) {
  failed = true;
  log('ERROR', e.stack ?? e);
} finally {
  await browser.close();
  watcher.close();
  await vite.close();
  await hub.close();
  log(failed ? 'ESTIMATE E2E FAILED' : 'ESTIMATE E2E PASSED', `screenshots in ${out}`);
  process.exit(failed ? 1 : 0);
}
