// End-to-end check of the motor designer (motor.html) in headless Chrome: the real page through
// Vite, its calculator (JSRM in CheerpJ, orcloud.bridge.MotorMain) as visitors run it, and the
// backend functions answered here by the real handlers (base44/shared) over in-memory stand-ins
// for Base44's records. It checks that:
//   - SRM_2023's example motor shows SRM_2023's numbers;
//   - the browser's JSRM answers exactly as JSRM does in Java on this computer, for every grain
//     shape and propellant (test/fixtures/jsrm-native.json, made with orcloud.bridge.MotorCheck);
//   - a change to anything but the grain reuses the grain JSRM has already worked out (MotorLab's
//     kept grains): far quicker, with the numbers JSRM gives from a new grain;
//   - "Use in OpenRocket" before the motor file's details are in marks the Output tab with a red dot;
//   - a motor is saved, listed with your motors, and added to OpenRocket as a custom motor file
//     that OpenRocket reads (server/src/motors.js).
// Screenshots go to test/out/.
//   node test/motor-e2e.mjs
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';
import { createServer } from 'vite';
import { designsApi, motorDesignsApi, motorsApi } from '../base44/shared/api.js';
import { billingApi, OPEN_ACTIONS, requirePlan } from '../base44/shared/billing.js';
import { sealer } from '../base44/shared/sealed.js';
import { readMotorFile } from '../../server/src/motors.js';
import { fakeDb } from './fake-base44.mjs';

const WEB = 5193;
const out = join(import.meta.dirname, 'out');
mkdirSync(out, { recursive: true });
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
const native = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'jsrm-native.json'), 'utf8'));

const db = fakeDb(['Design', 'Motor', 'SavedFlight', 'MotorDesign', 'Logbook', 'SealedPart', 'User', 'Account', 'Purchase', 'Group']);
const s = sealer(Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64'));
const APIS = { designs: designsApi, motors: motorsApi, motorDesigns: motorDesignsApi, billing: billingApi };
const u = await db.User.create({ email: 'mina@example.com', full_name: 'Mina Park', role: 'user' });
db.User.rows.get(u.id).created_date = '2026-03-02T09:15:00.000000'; // from before plans: free
const user = { ...u, created_date: '2026-03-02T09:15:00.000000' };

async function call(name, body) {
  const me = { id: user.id, email: user.email, name: user.full_name, created: user.created_date, role: user.role };
  const ctx = { db, s, me, paddle: null, paddleToken: null, files: { sign: async () => null } };
  try {
    // As the functions do (base44/functions/*/entry.ts): the motor designer's needs a plan with everything.
    if (OPEN_ACTIONS[name]) await requirePlan(ctx, String(body?.action ?? ''), OPEN_ACTIONS[name], { full: name === 'motorDesigns' });
    return { status: 200, json: await APIS[name](ctx, body) };
  } catch (e) {
    if (e.status) return { status: e.status, json: { error: e.message } };
    console.error(name, e);
    return { status: 500, json: { error: 'Something went wrong.' } };
  }
}

const vite = await createServer({ root: join(import.meta.dirname, '..'), server: { port: WEB, strictPort: true }, logLevel: 'warn' });
await vite.listen();
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  userDataDir: mkdtempSync(join(tmpdir(), 'orc-motor-')),
});
const problems = [];
let failed = false;

async function open(path) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1360, height: 980 });
  page.on('pageerror', (e) => problems.push(`${path}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/favicon|404/.test(m.text())) problems.push(`${path} console: ${m.text().slice(0, 200)}`);
  });
  await page.setRequestInterception(true);
  page.on('request', async (req) => {
    const url = new URL(req.url());
    try {
      if (url.host === `localhost:${WEB}` && url.pathname.startsWith('/api/')) {
        if (/\/entities\/User\/me$/.test(url.pathname)) return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(user) });
        const fn = url.pathname.match(/\/functions\/(\w+)$/)?.[1];
        if (fn && APIS[fn]) {
          const r = await call(fn, JSON.parse(req.postData() || '{}'));
          return req.respond({ status: r.status, contentType: 'application/json', body: JSON.stringify(r.json) });
        }
        return req.respond({ status: 200, contentType: 'application/json', body: '{}' });
      }
      return req.continue();
    } catch (e) {
      console.error('interception failed', e);
      return req.abort();
    }
  });
  await page.evaluateOnNewDocument(() => localStorage.setItem('base44_access_token', 'e2e-token'));
  await page.goto(`http://localhost:${WEB}${path}`, { waitUntil: 'domcontentloaded' });
  return page;
}

const statusText = (page) => page.$eval('#status', (el) => el.textContent).catch(() => '');
async function waitStatus(page, re, timeout = 180_000) {
  const t0 = Date.now();
  for (;;) {
    const st = await statusText(page);
    if (re.test(st)) return st;
    if (Date.now() - t0 > timeout) throw new Error(`status still "${st}"`);
    await new Promise((r) => setTimeout(r, 250));
  }
}
const cellTitles = (page) => page.$$eval('.wb-row', (rows) => rows.map((r) => [r.querySelector('.wb-sym')?.textContent.trim(), r.querySelector('.wb-out')?.title ?? r.querySelector('.wb-out')?.textContent ?? '']));

async function check(name, fn) {
  try {
    await fn();
    log('ok  ', name);
  } catch (e) {
    failed = true;
    log('FAIL', name, '-', e.message);
  }
}

try {
  const page = await open('/motor.html?new');
  const t0 = Date.now();
  await check('SRM_2023\'s example motor is worked out in the browser', async () => {
    const st = await waitStatus(page, /^L1729 ·/);
    log(`     first calculation, with the Java runtime starting: ${((Date.now() - t0) / 1000).toFixed(1)} s — ${st}`);
  });
  await page.screenshot({ path: join(out, 'motor-data.png'), fullPage: false });

  await check('Data and Kn shows SRM_2023\'s numbers', async () => {
    const cells = Object.fromEntries(await cellTitles(page));
    assert.equal(Number(cells.Dto), 16.7924944805876);
    assert.equal(Number(cells.Ato), 221.4727558899525);
    assert.equal(Number(cells.Vc), 2076396.394482004);
    assert.equal(Number(cells.Abo), 56303.623537636275);
    assert.equal(Number(cells['m grain']), 2.8124459515941598);
    const box = await page.$eval('.wb-results', (el) => el.innerText.replace(/\s+/g, ' '));
    assert.match(box, /Kn max 307 Kn min 254 Kn avg 290/);
  });

  await check('the browser\'s JSRM answers exactly as JSRM in Java, for every grain shape', async () => {
    const took = {};
    for (const c of native) {
      const t = Date.now();
      const r = await page.evaluate(async (motor) => {
        const { simulate } = await import('/src/motor/calc.js');
        return simulate(motor);
      }, c.motor);
      const ms = Date.now() - t;
      // Hollow cylinders and rods and tubes are plain arithmetic: the same to the last bit. The other
      // shapes are drawn with sines and cosines (java.awt.geom), which the browser's runtime takes
      // from JavaScript's Math, rounded a bit apart in the last binary digit (1 part in 10^15).
      const exact = ['hollow', 'rodTube'].includes(c.motor.grain.type);
      let worst = 0;
      const same = (a, b, what) => {
        if (exact || typeof b !== 'number') return assert.deepEqual(a, b, `${c.name}: ${what}`);
        const rel = Math.abs(a - b) / Math.max(Math.abs(b), 1e-6);
        worst = Math.max(worst, rel);
        assert.ok(rel < 1e-11, `${c.name}: ${what} ${a} vs ${b}`);
      };
      for (const [k, v] of Object.entries(c.summary)) same(r.summary[k], v, `summary ${k}`);
      for (const [k, v] of Object.entries(c.nozzle)) same(r.nozzle[k], v, `nozzle ${k}`);
      assert.equal(r.lines.t.length, c.count, `${c.name}: lines`);
      // (For those shapes, JSRM's Kn column, worked out apart from the pressure, is unsteady:
      // a thin sliver between two nearly equal shapes, which a last-digit difference can change by a
      // few percent at a few lines, in Java as in the browser. The pressure and thrust do not use it.)
      for (const key of exact ? ['t', 'thrust', 'kn', 'pressure', 'massFlow', 'grainMass'] : ['t', 'thrust', 'pressure', 'grainMass']) {
        c.sample.index.forEach((i, n) => same(r.lines[key][i], c.sample[key][n], `${key}[${i}]`));
      }
      log(`     ${c.name}: ${exact ? 'same to the last digit' : `same to ${worst ? Math.floor(-Math.log10(worst)) : 16}+ digits`} (${(ms / 1000).toFixed(1)} s)`);
      took[c.name] = ms;
      // A case with reusesGrainOf changes only the nozzle of the case before it: JSRM's work on the
      // grain is kept, and the answer (from a new grain, in Java) is the same.
      if (c.reusesGrainOf) assert.ok(ms < took[c.reusesGrainOf] / 3, `${c.name} took ${ms} ms: the grain was not reused`);
    }
  });

  await check('the worksheets draw, for SRM\'s grain and METEOR\'s', async () => {
    for (const [tab, file] of [['Pressure', 'pressure'], ['Performance', 'performance'], ['Nozzle Design', 'nozzle'], ['Output', 'output'], ['Propellant data', 'propellants']]) {
      await page.evaluate((label) => [...document.querySelectorAll('#tabs button')].find((b) => b.textContent === label).click(), tab);
      await new Promise((r) => setTimeout(r, 300));
      const drawn = await page.$$eval('#sheet .mt-chart, #sheet .wb-table, #sheet .wb-drawing, #sheet .wb-summary', (els) => els.length);
      assert.ok(drawn > 0, `${tab}: nothing drawn`);
      await page.screenshot({ path: join(out, `motor-${file}.png`), fullPage: true });
    }
    // A finocyl grain, from the grain shape list (the Kn table then comes from JSRM's areas).
    await page.evaluate(() => [...document.querySelectorAll('#tabs button')].find((b) => b.textContent === 'Data and Kn').click());
    await page.select('select[aria-label="grain.type"]', 'finocyl');
    await waitStatus(page, /Calculating/, 10_000);
    const st = await waitStatus(page, /^[A-Z]\d+ ·/, 240_000);
    log(`     finocyl: ${st}`);
    await page.screenshot({ path: join(out, 'motor-finocyl.png'), fullPage: true });
    // Another propellant for the same grain: the calculator reuses the grain, without the long wait
    // (a new finocyl grain takes about 10 s here, as in the check before).
    // (The statuses are recorded in the page: a quick calculation keeps the page busy until it is done,
    // so polling from here can miss "Calculating…".)
    for (const propellant of ['KNSB fine', 'KNDX']) {
      await page.evaluate(() => {
        const el = document.querySelector('#status');
        window.statuses = [];
        window.statusWatch?.disconnect();
        window.statusWatch = new MutationObserver(() => window.statuses.push(el.textContent));
        window.statusWatch.observe(el, { childList: true, characterData: true, subtree: true });
      });
      const t = Date.now();
      await page.select('select[aria-label="propellant"]', propellant);
      await page.waitForFunction(() => {
        const i = window.statuses.findIndex((x) => /Calculating/.test(x));
        return i >= 0 && window.statuses.slice(i + 1).some((x) => /^[A-Z]\d+ ·/.test(x));
      }, { timeout: 60_000, polling: 100 });
      const ms = Date.now() - t;
      const seen = await page.evaluate(() => window.statuses);
      log(`     finocyl with ${propellant}: ${seen.at(-1)} (${(ms / 1000).toFixed(1)} s)`);
      assert.ok(!seen.some((x) => /seconds or more/.test(x)), `a grain already worked out is said to be slow: ${seen.join(' | ')}`);
      assert.ok(ms < 5_000, `another propellant took ${ms} ms: the grain was not reused`);
    }
    await page.select('select[aria-label="grain.type"]', 'hollow');
    await page.evaluate(() => {
      const set = (label, v) => {
        const el = document.querySelector(`input[aria-label="${label}"]`);
        el.value = v;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      };
      set('grain.outerDiameter', '69');
      set('grain.coreDiameter', '20');
      set('grain.segmentLength', '=25.4*4.5275590551'); // 115 mm, typed in inches as in SRM
      set('grain.segments', '4');
    });
    await page.select('select[aria-label="grain.outer"]', 'inhibited');
    // Back to SRM's example: the hollow cylinder's own Kn table, and its numbers.
    await page.waitForFunction(() => [...document.querySelectorAll('.wb-table th')].some((th) => th.textContent === 'tweb')
      && /^L1729 ·/.test(document.querySelector('#status').textContent), { timeout: 60_000 });
  });

  await check('"Use in OpenRocket" before the motor file\'s details: a red dot on the Output tab, and the empty cells marked', async () => {
    const tab = (label) => page.evaluate((label) => [...document.querySelectorAll('#tabs button')].find((b) => b.textContent === label).click(), label);
    const marks = () => page.evaluate(() => ({
      dot: document.querySelector('#tabs button[data-sheet="output"]').classList.contains('needs'),
      sheet: document.querySelector('#tabs button.active')?.dataset.sheet,
      missing: ['diameter', 'length', 'hardwareMass'].filter((k) => document.querySelector(`input[aria-label="eng.${k}"]`)?.classList.contains('missing')),
      focused: document.activeElement?.getAttribute('aria-label'),
      boxInView: (() => {
        const r = document.querySelector('.wb-eng')?.getBoundingClientRect();
        return !!r && r.top >= 0 && r.top < innerHeight;
      })(),
    }));
    await tab('Data and Kn');
    await page.click('#use-openrocket');
    await page.waitForFunction(() => document.querySelector('#tabs button[data-sheet="output"]').classList.contains('needs'), { timeout: 10_000 });
    assert.deepEqual(await marks(), { dot: true, sheet: 'output', missing: ['diameter', 'length', 'hardwareMass'], focused: 'eng.diameter', boxInView: true });
    await page.screenshot({ path: join(out, 'motor-eng-needed.png') });
    assert.equal(db.Motor.rows.size, 0, 'nothing was added to OpenRocket');
    // Away and back: the dot stays, and the Output tab opens at the motor file.
    await tab('Pressure');
    assert.equal((await marks()).dot, true);
    await tab('Output');
    assert.deepEqual(await marks(), { dot: true, sheet: 'output', missing: ['diameter', 'length', 'hardwareMass'], focused: 'eng.diameter', boxInView: true });
    const type = (label, v) => page.evaluate((label, v) => {
      const el = document.querySelector(`input[aria-label="${label}"]`);
      el.value = v;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }, label, v);
    await type('eng.diameter', '83');
    assert.deepEqual((await marks()).missing, ['length', 'hardwareMass']);
    assert.equal((await marks()).dot, true);
    await type('eng.length', '560');
    await type('eng.hardwareMass', '1.9');
    assert.deepEqual(await page.evaluate(() => document.querySelector('#tabs button[data-sheet="output"]').classList.contains('needs')), false, 'the dot goes once they are all in');
    assert.deepEqual((await marks()).missing, []);
  });

  await check('a motor is saved, and added to OpenRocket as a file OpenRocket reads', async () => {
    await page.evaluate(() => [...document.querySelectorAll('#tabs button')].find((b) => b.textContent === 'Output').click());
    await page.evaluate(() => {
      const set = (label, v) => {
        const el = document.querySelector(`input[aria-label="${label}"]`);
        el.value = v;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      };
      set('eng.diameter', '83');
      set('eng.length', '560');
      set('eng.hardwareMass', '1.9');
    });
    await new Promise((r) => setTimeout(r, 1200));
    await page.$eval('#motor-name', (el) => { el.value = 'Club L motor'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.click('#use-openrocket');
    await page.waitForFunction(() => [...document.querySelectorAll('dialog header')].some((x) => x.textContent === 'Added to OpenRocket'), { timeout: 20_000 });
    await page.screenshot({ path: join(out, 'motor-added.png') });
    const [motor] = [...db.Motor.rows.values()];
    const m = await (await import('../base44/shared/sealed.js')).readMotor(s, motor);
    const { motors } = readMotorFile(m.filename, Object.assign(new TextEncoder().encode(m.content), { toString: () => m.content }));
    assert.equal(motors[0].designation, 'L1729');
    assert.equal(motors[0].diameterMm, 83);
    assert.ok(Math.abs(motors[0].impulseNs - 3501.53) < 10, `impulse ${motors[0].impulseNs}`);
    const [saved] = [...db.MotorDesign.rows.values()];
    const d = await (await import('../base44/shared/sealed.js')).readMotorDesign(s, saved);
    assert.equal(d.name, 'Club L motor');
    assert.equal(d.motor_id, motor.id);
    assert.match(d.summary, /^L1729 · KNDX · Hollow cylinder \(BATES\) × 4$/);
    assert.match(new URL(page.url()).search, /^\?id=/);
  });

  await check('the motor is listed with your motors', async () => {
    const home = await open('/motor.html');
    await home.waitForSelector('#motor-grid .card', { timeout: 20_000 });
    const card = await home.$eval('#motor-grid .card', (el) => el.innerText.replace(/\s+/g, ' '));
    assert.match(card, /L1729 .*Club L motor .*L1729 · KNDX .*In OpenRocket/);
    await home.screenshot({ path: join(out, 'motor-home.png') });
    await home.close();
  });

  await check('no errors in the pages', async () => {
    assert.deepEqual(problems, []);
  });
} finally {
  await browser.close();
  await vite.close();
}
process.exit(failed ? 1 : 0);
