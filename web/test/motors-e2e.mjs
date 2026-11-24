// End-to-end check of custom motors when OpenRocket starts, in the browser version: headless Chrome
// runs the real OpenRocket (CheerpJ) on the design page, through the local stand-in for the
// DesignRoom actor (hub.mjs), with custom motor files given as the room gives a design's.
// Screenshots go to test/out/.
//   node test/motors-e2e.mjs [case...]   (cases: missing uploaded changed unreadable corpus shared)
//
// A design whose motor OpenRocket cannot find (a custom motor file removed, or unreadable) or whose
// motor file changed makes OpenRocket ask about it ("Warnings while opening file") before it opens
// the design. The page showed its loading screen over that question until OpenRocket was ready,
// which it never was: the design never opened. The page now shows OpenRocket while it asks.
// A session without a motor of the design must also leave that motor, and the simulations that
// use it, as they are in the shared design.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';
import { createServer } from 'vite';
import WebSocket from 'ws';
import { startHub } from './hub.mjs';
import { importOrk } from '../src/lib/ork.js';
import { readZip } from '../src/lib/zip.js';
import { toJson } from '../../server/src/model.js';
import { engFile } from '../src/motor/srm.js';

const HUB = 8790;
const WEB = 5186;
const out = join(import.meta.dirname, 'out');
mkdirSync(out, { recursive: true });
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const corpus = join(import.meta.dirname, '..', '..', 'worker', 'bridge', 'test', 'motors');
const motorFile = (name) => ({ name, content: readFileSync(join(corpus, name), 'utf8') });

// The design: OpenRocket's "A simple model rocket", its first motor replaced with a custom one,
// KN38-I310 by RocketClub (worker/bridge/test/motors/valid.eng), named as OpenRocket names it.
const jar = new Uint8Array(readFileSync(join(import.meta.dirname, '..', 'public', 'or', 'OpenRocket-web.jar')));
const example = (await readZip(jar)).find((e) => e.name === 'datafiles/examples/A simple model rocket.ork').data;
async function design({ custom = true, digest = null, motor = ['RocketClub', 'KN38-I310', '0.038', '0.33', '6.0'] } = {}) {
  const m = await importOrk(example);
  if (!custom) return { model: m };
  const [mountId, mount] = [...m.objs].find(([, o]) => o.v.get('motormount')?.includes('<motor '));
  const xml = mount.v.get('motormount');
  const configId = /<motor configid="([^"]+)">/.exec(xml)[1];
  mount.v.set('motormount', xml.replace(/<motor configid="[^"]+">.*?<\/motor>/, `<motor configid="${configId}">`
    + `<manufacturer>${motor[0]}</manufacturer>${digest ? `<digest>${digest}</digest>` : ''}<designation>${motor[1]}</designation>`
    + `<diameter>${motor[2]}</diameter><length>${motor[3]}</length><delay>${motor[4]}</delay></motor>`));
  const sims = [...m.objs].filter(([, o]) => o.t === 'simulation').map(([id]) => id);
  return { model: m, mountId, configId, sims };
}

// The KN38 file as people write them: byte order mark, Windows line ends, an indented comment,
// comments after the values, a line of spaces. OpenRocket's reader trips on these unless tidied.
const messy = {
  name: 'kn38-messy.eng',
  content: `﻿  ; KN38 by RocketClub\r\n${readFileSync(join(corpus, 'valid.eng'), 'utf8').split('\n').slice(1)
    .map((l, i) => (i === 0 ? `${l} ; header` : i === 3 ? `${l}   ; peak` : l)).join('\r\n')}\r\n   \r\n`,
};
const everyFile = readdirSync(corpus).filter((f) => /\.(eng|rse)$/.test(f)).map(motorFile);
// A motor from the motor designer (motor.html): SRM_2023's example as the page writes its .eng file.
const designed = engFile(JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'jsrm-srm2023-example.json'), 'utf8')),
  { name: '', diameter: 83, length: 560, delays: 'P', hardwareMass: 1.9, manufacturer: 'Custom' });

const cases = {
  // The motor's file is not in the design: OpenRocket asks, then opens the design without it.
  missing: { design: await design(), motors: [], asks: true, keepsMotor: true },
  // Its file is, written as above: no question.
  uploaded: { design: await design(), motors: [messy], asks: false },
  // Its file changed since the design was saved: OpenRocket asks ("differing thrust curve").
  changed: { design: await design({ digest: '0123456789abcdef0123456789abcdef' }), motors: [motorFile('valid.eng')], asks: true },
  // Its file is one OpenRocket cannot read (stored before uploads were checked): OpenRocket asks.
  unreadable: { design: await design(), motors: [motorFile('manufacturer-with-space.eng')], asks: true, keepsMotor: true },
  // A motor from the motor designer, used in the design: OpenRocket finds it in its file, no question.
  designed: { design: await design({ motor: ['Custom', 'L1729', '0.083', '0.56', 'none'] }), motors: [{ name: designed.filename, content: designed.text }], asks: false },
  // Every file of the corpus at once, half of them unreadable, with a design using none: starts.
  corpus: { design: await design({ custom: false }), motors: everyFile, asks: false },
  // Two people: a has the motor's file, b does not. b's session must not change the motor or the
  // simulations using it in the shared design, nor keep flipping their status with a's.
  shared: { design: await design(), motors: (email) => (email === 'a@test.local' ? [motorFile('valid.eng')] : []), two: true },
};
const only = process.argv.slice(2);
const run = Object.keys(cases).filter((k) => !only.length || only.includes(k));

const designs = new Map(Object.keys(cases).map((id) => [id, { name: `Motors ${id}`, owner: 'a@test.local', members: { 'b@test.local': 'editor' } }]));
const hub = startHub({
  port: HUB,
  designs,
  motors: (id, email) => {
    const m = cases[id]?.motors ?? [];
    return typeof m === 'function' ? m(email) : m;
  },
});
const vite = await createServer({ root: join(import.meta.dirname, '..'), server: { port: WEB, strictPort: true }, logLevel: 'warn' });
await vite.listen();

// A watcher connected like a page, per design: sets it up and records the ops it sees.
async function watch(id, model) {
  const seen = [];
  const ws = new WebSocket(`ws://localhost:${HUB}/?design=${id}&user=a@test.local&conn=watcher-${id}`);
  const frags = new Map();
  const replies = new Map();
  ws.on('message', (d) => {
    let m = JSON.parse(d.toString());
    if (m.type === 'frag') {
      const parts = frags.get(m.fid) ?? [];
      parts[m.i] = m.s;
      frags.set(m.fid, parts);
      if (parts.filter((x) => x !== undefined).length < m.n) return;
      m = JSON.parse(parts.join(''));
    }
    if (m.type === 'reply') replies.get(m.rid)?.(m);
    if (m.type === 'ops') seen.push({ at: Date.now(), ops: m.ops });
  });
  await new Promise((r) => ws.on('open', r));
  const rid = crypto.randomUUID();
  const reply = new Promise((r) => replies.set(rid, r));
  ws.send(JSON.stringify({ type: 'init', rid, model: toJson(model) }));
  const r = await reply;
  if (!r.ok) throw new Error(`design ${id} not set up: ${r.error}`);
  return { seen, close: () => ws.close() };
}

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  userDataDir: mkdtempSync(join(tmpdir(), 'orc-motors-')),
});
const status = (page) => page.evaluate(() => ({ text: document.querySelector('#status')?.textContent, covered: !document.querySelector('#overlay')?.hidden }));
// Waits until the page is ready (Live) or OpenRocket asks something (Waiting for you).
async function settle(page, timeout = 150_000) {
  await page.waitForFunction(() => ['Live', 'Viewing', 'Waiting for you'].includes(document.querySelector('#status')?.textContent), { timeout, polling: 100 });
  return status(page);
}
async function open(id, user) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  page.on('pageerror', (e) => log(`  page error (${id}, ${user}):`, e.message));
  await page.goto(`http://localhost:${WEB}/design.html?id=${id}&hub=ws://localhost:${HUB}&user=${user}`);
  return page;
}
// OpenRocket asks: the page must show it, and answering it (Enter: OK) must open the design.
async function answer(page, name) {
  const s = await status(page);
  if (s.text !== 'Waiting for you' || s.covered) throw new Error(`OpenRocket's question is not shown (${JSON.stringify(s)})`);
  await sleep(1500);
  await page.screenshot({ path: join(out, `motors-${name}-question.png`) });
  await page.keyboard.press('Enter');
  const after = await settle(page, 60_000);
  if (after.text === 'Waiting for you') {
    await sleep(1000);
    await page.screenshot({ path: join(out, `motors-${name}-question2.png`) });
    await page.keyboard.press('Enter');
  }
  await page.waitForFunction(() => ['Live', 'Viewing'].includes(document.querySelector('#status')?.textContent), { timeout: 60_000, polling: 100 });
}

// Ops a session sent that remove the custom motor or touch its simulations' status.
function damage(c, seen, since = 0) {
  const bad = [];
  for (const { at, ops } of seen) {
    if (at < since) continue;
    for (const op of ops) {
      if (op.op === 'set' && op.id === c.design.mountId && 'motormount' in (op.v ?? {}) && !String(op.v.motormount).includes('KN38-I310')) {
        bad.push('motor removed from the shared design');
      }
      if (op.op === 'set' && c.design.sims?.includes(op.id) && '@' in (op.v ?? {})) bad.push(`simulation status set to ${op.v['@']}`);
      if (op.op === 'del' && op.id === c.design.mountId) bad.push('motor mount deleted');
    }
  }
  return bad;
}
const brief = (seen) => seen.flatMap(({ ops }) => ops.map((op) => `${op.op} ${String(op.id).slice(0, 8)}${op.v ? `[${Object.keys(op.v)}]` : ''}`));

let failures = 0;
const results = [];
try {
  for (const name of run) {
    const c = cases[name];
    const w = await watch(name, c.design.model);
    const t0 = Date.now();
    try {
      log(`${name}: opening`);
      const page = await open(name, 'a@test.local');
      const first = await settle(page);
      const asked = first.text === 'Waiting for you';
      if (asked && (c.two || !c.asks)) {
        await sleep(1500);
        await page.screenshot({ path: join(out, `motors-${name}-unexpected.png`) });
      }
      if (c.two) {
        if (asked) throw new Error('a, who has the motor file, was asked');
      } else if (asked !== c.asks) {
        throw new Error(asked ? 'OpenRocket asked something' : 'OpenRocket did not ask');
      }
      if (asked) await answer(page, name);
      log(`${name}: ${asked ? 'asked, answered, ' : ''}live after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
      await sleep(2000);
      await page.screenshot({ path: join(out, `motors-${name}-live.png`) });
      let problems = [];
      if (c.two) {
        const pageB = await open(name, 'b@test.local');
        const b = await settle(pageB);
        if (b.text !== 'Waiting for you') throw new Error('b, without the motor file, was not asked');
        await answer(pageB, `${name}-b`);
        const bLive = Date.now();
        log(`${name}: b asked, answered, live; watching both for 25 s`);
        await sleep(25_000);
        await pageB.screenshot({ path: join(out, `motors-${name}-b-live.png`) });
        problems = damage(c, w.seen, bLive - 30_000);
        await pageB.close();
      } else if (c.keepsMotor) {
        await sleep(15_000); // the session's periodic snapshots (every 5 s)
        problems = damage(c, w.seen);
      }
      log(`${name}: ops seen: ${brief(w.seen).join(', ') || 'none'}`);
      if (problems.length) throw new Error([...new Set(problems)].join('; '));
      await page.close();
      results.push(`PASS ${name}`);
    } catch (e) {
      failures++;
      results.push(`FAIL ${name}: ${e.message}`);
      log(`${name}: FAIL ${e.message}`);
    } finally {
      w.close();
    }
  }
} finally {
  await browser.close();
  await vite.close();
  await hub.close();
}
console.log(`\n${results.join('\n')}\nMOTORS-E2E ${failures ? 'FAIL' : 'PASS'} (${run.length} cases)`);
process.exit(failures ? 1 : 0);
