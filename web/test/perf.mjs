// Measures the browser version on this computer: the design page's start-up timeline, what it
// downloads, and how long an edit takes to reach the room. Same setup as e2e.mjs (local room
// stand-in, the real OpenRocket in headless Chrome).
//   node test/perf.mjs [--slow]   --slow: emulate a typical connection (40 ms, 30 Mbit/s)
// Optional environment variables:
//   PERF_PROFILE_DIR=<dir>   reuse a browser profile, to measure with a warm cache (the Java runtime
//                            comes from CheerpJ's CDN, whose speed varies a lot between runs)
//   PERF_CONSOLE=1           print the page's console with times
//   PERF_PROFILE=<file>      save a CPU profile of the start-up (.cpuprofile, for Chrome DevTools)
//   PERF_RANGES=<file>       save the list of requests for the jars
//   PERF_NET=<ms>,<Mbit/s>   emulate this connection instead (e.g. 150,10 for a slow, far one)
//   PERF_CPU=<n>             emulate a CPU n times slower (e.g. 4 for an older laptop or Chromebook)
//   PERF_EXAMPLE=<name>      open one of OpenRocket's example designs instead of a new rocket
//   PERF_JAR=<file>          serve this file as OpenRocket-web.jar (scripts/startup-order.py's probes)
//   PERF_NOPREFETCH=1        the page does not ask the service worker to prefetch the jar
//   PERF_RESOURCES=<file>    save CheerpJ's list of the runtime files used (public/or/preload.json)
//   PERF_QS=<&a=b...>        extra query string for the design page
// PERF_RANGES and the download summary include requests from workers, the service worker and
// CheerpJ's own frame on its CDN (where it reads the Java runtime).
import { createReadStream, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';
import { createServer } from 'vite';
import WebSocket from 'ws';
import { startHub } from './hub.mjs';
import { importOrk } from '../src/lib/ork.js';
import { toJson } from '../../server/src/model.js';

const HUB = 8789;
const WEB = 5184;
const slow = process.argv.includes('--slow');
const designs = new Map([['perf', { name: 'Perf rocket', owner: 'a@test.local', members: {} }]]);
const hub = startHub({ port: HUB, designs });
// Serves the jars like the live site does: Vite answers "bytes=0-0" (CheerpJ's first request)
// with the whole 42 MB file, which would swamp the timings on an emulated connection.
const jarRanges = {
  name: 'jar-ranges',
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const path = new URL(req.url, 'http://x').pathname;
      if (!/^\/or\/[\w.-]+\.jar$/.test(path)) return next();
      // PERF_JAR=<file>: serve this file as OpenRocket-web.jar instead (to try another layout of it).
      const file = process.env.PERF_JAR && path === '/or/OpenRocket-web.jar' ? process.env.PERF_JAR : join(import.meta.dirname, '..', 'public', path);
      const size = statSync(file).size;
      const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
      const start = m ? Number(m[1]) : 0;
      const end = m && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Length', end - start + 1);
      if (m) {
        res.statusCode = 206;
        res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
      }
      if (req.method === 'HEAD') return res.end();
      createReadStream(file, { start, end }).pipe(res);
    });
  },
};
const vite = await createServer({ root: join(import.meta.dirname, '..'), server: { port: WEB, strictPort: true }, logLevel: 'warn', plugins: [jarRanges] });
await vite.listen();

const seen = [];
const watcher = new WebSocket(`ws://localhost:${HUB}/?design=perf&user=a@test.local&conn=watcher`);
const replies = new Map();
watcher.on('message', (d) => {
  const m = JSON.parse(d.toString());
  if (m.type === 'reply') replies.get(m.rid)?.(m);
  if (m.type === 'ops') seen.push({ at: Date.now(), m });
});
await new Promise((r) => watcher.on('open', r));
const request = (type, data) => new Promise((resolve) => {
  const rid = crypto.randomUUID();
  replies.set(rid, resolve);
  watcher.send(JSON.stringify({ type, rid, ...data }));
});
// PERF_EXAMPLE=<name>: open one of OpenRocket's example designs instead of a new rocket.
let designBytes = new Uint8Array(readFileSync(join(import.meta.dirname, '..', '..', 'server', 'templates', 'new-rocket.ork')));
if (process.env.PERF_EXAMPLE) {
  const { readZip } = await import('../src/lib/zip.js');
  const jar = new Uint8Array(readFileSync(join(import.meta.dirname, '..', 'public', 'or', 'OpenRocket-web.jar')));
  designBytes = (await readZip(jar)).find((e) => e.name === `datafiles/examples/${process.env.PERF_EXAMPLE}.ork`).data;
}
const blank = await importOrk(designBytes);
await request('init', { model: toJson(blank) });

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  userDataDir: process.env.PERF_PROFILE_DIR ?? mkdtempSync(join(tmpdir(), 'orc-perf-')), // reuse one to measure with a warm cache
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  const cdp = await page.createCDPSession();
  await cdp.send('Network.enable');
  const [netMs, netMbit] = (process.env.PERF_NET ?? (slow ? '40,30' : '')).split(',').map(Number);
  if (netMbit) await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: netMs, downloadThroughput: netMbit * 1e6 / 8, uploadThroughput: netMbit * 1e6 / 8 });
  if (process.env.PERF_CPU) await cdp.send('Emulation.setCPUThrottlingRate', { rate: Number(process.env.PERF_CPU) });
  const reqs = new Map();
  const watch = (session, where) => {
    session.on('Network.requestWillBeSent', (e) => reqs.set(`${where}:${e.requestId}`, { where, url: e.request.url, start: e.timestamp, range: e.request.headers.Range ?? e.request.headers.range }));
    session.on('Network.responseReceived', (e) => {
      const r = reqs.get(`${where}:${e.requestId}`);
      if (r) r.cached = e.response.fromDiskCache || e.response.fromServiceWorker || e.response.fromPrefetchCache;
    });
    session.on('Network.loadingFinished', (e) => {
      const r = reqs.get(`${where}:${e.requestId}`);
      if (r) Object.assign(r, { bytes: e.encodedDataLength, end: e.timestamp });
    });
  };
  watch(cdp, 'page');
  // Requests from workers (CheerpJ reads its Java runtime from one) and the service worker.
  browser.on('targetcreated', async (t) => {
    // Workers, and CheerpJ's own frame on its CDN, which reads the Java runtime's files.
    if (t.type() === 'browser' || (t.type() === 'page' && !t.url().includes('leaningtech'))) return;
    try {
      const s = await t.createCDPSession();
      watch(s, t.url().includes('leaningtech') ? 'cheerpj-frame' : t.type());
      await s.send('Network.enable');
      const [ms, mbit] = (process.env.PERF_NET ?? (slow ? '40,30' : '')).split(',').map(Number);
      if (mbit) await s.send('Network.emulateNetworkConditions', { offline: false, latency: ms, downloadThroughput: mbit * 1e6 / 8, uploadThroughput: mbit * 1e6 / 8 });
    } catch {
      // gone already
    }
  });

  // PERF_NOPREFETCH=1: the design page does not ask the service worker to prefetch the jar (as before it did).
  if (process.env.PERF_NOPREFETCH) await page.evaluateOnNewDocument(() => { ServiceWorker.prototype.postMessage = () => {}; });
  // Timeline marks: when the page's own steps happen (performance.now(), ms since navigation).
  await page.evaluateOnNewDocument(() => {
    window.__marks = [];
    const mark = (name) => window.__marks.push([name, Math.round(performance.now())]);
    window.__mark = mark;
    for (const name of ['cheerpjInit', 'cheerpjRunMain', 'cheerpjCreateDisplay']) {
      let fn;
      Object.defineProperty(window, name, {
        configurable: true,
        get: () => fn && (async (...a) => {
          mark(`${name} start`);
          const out = await fn(...a);
          mark(`${name} done`);
          return out;
        }),
        set: (v) => {
          fn = v;
          mark(`${name} defined (loader.js ran)`);
        },
      });
    }
  });
  let navAt = Date.now();
  page.on('console', (m) => {
    const t = m.text();
    if (process.env.PERF_CONSOLE) console.log(`  console ${String(Date.now() - navAt).padStart(6)} ms  ${t.slice(0, 400).replace(/\s+/g, ' ')}`);
    const k = /\[liveshare\] (Opening|Joined|Attached)/.exec(t)?.[1];
    if (k) page.evaluate((k) => window.__mark(`java: ${k}`), k).catch(() => {});
  });

  if (process.env.PERF_PROFILE) {
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 1000 });
    await cdp.send('Profiler.start');
  }
  const t0 = Date.now();
  navAt = t0;
  await page.goto(`http://localhost:${WEB}/design.html?id=perf&hub=ws://localhost:${HUB}&user=a@test.local${process.env.PERF_QS ?? ''}`);
  await page.waitForFunction(() => ['Live', 'Viewing'].includes(document.querySelector('#status')?.textContent), { timeout: 180_000, polling: 50 });
  const ready = await page.evaluate(() => Math.round(performance.now()));
  if (process.env.PERF_PROFILE) writeFileSync(process.env.PERF_PROFILE, JSON.stringify((await cdp.send('Profiler.stop')).profile));
  // PERF_RESOURCES=<file>: save CheerpJ's list of the runtime files used (for public/or/preload.json).
  if (process.env.PERF_RESOURCES) writeFileSync(process.env.PERF_RESOURCES, await page.evaluate(() => window.cjGetRuntimeResources()));
  const conditions = [netMbit ? `emulated ${netMs} ms / ${netMbit} Mbit/s` : 'local network', process.env.PERF_CPU ? `CPU ${process.env.PERF_CPU}x slower` : 'full-speed CPU'];
  console.log(`\nREADY after ${(ready / 1000).toFixed(1)} s (${conditions.join(', ')})`);
  for (const [name, at] of await page.evaluate(() => window.__marks)) console.log(`  ${String(at).padStart(6)} ms  ${name}`);

  const groups = new Map();
  for (const r of reqs.values()) {
    const u = new URL(r.url);
    const key = `${u.origin.includes('localhost') ? (u.pathname.startsWith('/or/') ? `site ${u.pathname}` : 'site (pages, scripts)') : u.host} [${r.where}]`;
    const g = groups.get(key) ?? { n: 0, bytes: 0, ranges: 0, cached: 0 };
    g.n++;
    if (r.cached) g.cached++;
    const ranged = /^bytes=(\d+)-(\d+)$/.exec(r.range ?? '');
    g.bytes += r.bytes || (ranged ? Number(ranged[2]) - Number(ranged[1]) + 1 : 0);
    if (r.range) g.ranges++;
    groups.set(key, g);
  }
  if (process.env.PERF_RANGES) writeFileSync(process.env.PERF_RANGES, JSON.stringify([...reqs.values()], null, 1));
  console.log('\nDOWNLOADS');
  for (const [k, g] of [...groups].sort((a, b) => b[1].bytes - a[1].bytes)) {
    console.log(`  ${k.padEnd(40)} ${String(g.n).padStart(4)} requests ${g.ranges ? `(${g.ranges} ranges) ` : ''}${(g.bytes / 1e6).toFixed(2)} MB${g.cached ? `, ${g.cached} from a cache` : ''}`);
  }

  // Edit: add a nose cone (as e2e.mjs) and time it until the room has it. After a pause: in the
  // first seconds OpenRocket is still loading its component presets, which adding a part waits for.
  await sleep(20_000);
  await page.mouse.click(83, 109); // the stage in OpenRocket's component tree
  await sleep(1500);
  const tClick = Date.now();
  await page.mouse.click(476, 258); // "Nose Cone"
  let put = null;
  while (!put && Date.now() - tClick < 30_000) {
    put = seen.find((s) => s.m.ops.some((op) => op.op === 'put' && op.t === 'nosecone'));
    if (!put) await sleep(20);
  }
  console.log(`\nEDIT: a new nose cone reached the room after ${put ? `${put.at - tClick} ms` : 'more than 30 s'}`);
  console.log(`\n(total run ${((Date.now() - t0) / 1000).toFixed(0)} s)`);
} finally {
  await browser.close();
  watcher.close();
  await vite.close();
  await hub.close();
}
process.exit(0);
