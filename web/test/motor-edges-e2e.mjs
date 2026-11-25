// Edge cases of the motor designer (motor.html) in headless Chrome, through the page as people use
// it, with the backend functions answered here by their real code (as test/motor-e2e.mjs does):
//   - what a cell can be given: formulas, decimal commas, thousands, bad text, nothing, zero,
//     negatives, fractions where whole numbers belong, and more than METEOR allows;
//   - each grain shape's limits, and every error JSRM gives for them, in the site's words (never
//     JSRM's own text), with the grain still drawn while it cannot be worked out;
//   - the throat, the nozzle, the settings, a motor too small or too big for any class;
//   - each worksheet, the title, saving and opening again, the motor file, and "Use in OpenRocket"
//     twice and in a hurry (one custom motor, the old one replaced);
//   - the list of motors (search, duplicate, rename, delete), leaving with changes, a phone's
//     screen and dark mode.
// Screenshots go to test/out/ (motor-edge-*.png).
//   node test/motor-edges-e2e.mjs
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';
import { createServer } from 'vite';
import { designsApi, motorDesignsApi, motorsApi } from '../base44/shared/api.js';
import { billingApi, OPEN_ACTIONS, requirePlan } from '../base44/shared/billing.js';
import { readMotor, readMotorDesign, sealer } from '../base44/shared/sealed.js';
import { readMotorFile } from '../../server/src/motors.js';
import { fakeDb } from './fake-base44.mjs';

const WEB = 5196;
const out = join(import.meta.dirname, 'out');
mkdirSync(out, { recursive: true });
const downloads = mkdtempSync(join(tmpdir(), 'orc-eng-'));
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

const db = fakeDb(['Design', 'Motor', 'SavedFlight', 'MotorDesign', 'Logbook', 'SealedPart', 'User', 'Account', 'Purchase', 'Group']);
const s = sealer(Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64'));
const APIS = { designs: designsApi, motors: motorsApi, motorDesigns: motorDesignsApi, billing: billingApi };
const u = await db.User.create({ email: 'edge@example.com', full_name: 'Eddie Edge', role: 'user' });
db.User.rows.get(u.id).created_date = '2026-03-02T09:15:00.000000'; // from before plans: free
const user = { ...u, created_date: '2026-03-02T09:15:00.000000' };

async function call(name, body) {
  const me = { id: user.id, email: user.email, name: user.full_name, created: user.created_date, role: user.role };
  const ctx = { db, s, me, paddle: null, paddleToken: null, files: { sign: async () => null } };
  try {
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
  userDataDir: mkdtempSync(join(tmpdir(), 'orc-motor-edges-')),
});
const problems = [];
let failed = false;

async function open(path, viewport = { width: 1360, height: 980 }) {
  const page = await browser.newPage();
  await page.setViewport(viewport);
  page.on('pageerror', (e) => problems.push(`${path}: ${e.message}`));
  page.on('dialog', (d) => d.accept()); // leaving a page with changes, between checks
  page.on('console', (m) => {
    if (m.type() === 'error' && !/favicon|404/.test(m.text())) problems.push(`${path} console: ${m.text().slice(0, 200)}`);
  });
  const cdp = await page.createCDPSession();
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
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

async function check(name, fn) {
  try {
    await fn();
    log('ok  ', name);
  } catch (e) {
    failed = true;
    log('FAIL', name, '-', e.message);
  }
}

// ------------------------------------------------------------------ the workbook, as people use it

const finished = (page) => page.$eval('#status', (el) => Number(el.dataset.calculations ?? 0));
/** After `act` (on the page), the next calculation's outcome. */
async function next(page, act) {
  const before = await finished(page);
  await act();
  await page.waitForFunction((n) => {
    const el = document.querySelector('#status');
    return Number(el.dataset.calculations ?? 0) > n && el.dataset.kind !== 'busy';
  }, { timeout: 240_000, polling: 200 }, before);
  return page.evaluate(() => ({
    kind: document.querySelector('#status').dataset.kind,
    status: document.querySelector('#status').textContent,
    error: document.querySelector('#wb-error:not([hidden])')?.textContent ?? '',
    drawn: !!document.querySelector('.wb-grain svg'),
  }));
}
/** Cells given values at once (inputs by `input`, drop-downs by `change`), then the calculation. */
const edit = (page, changes) => next(page, () => page.evaluate((changes) => {
  for (const [label, v] of changes) {
    const el = document.querySelector(`[aria-label="${label}"]`);
    if (!el) throw new Error(`no cell ${label}`);
    el.value = v;
    el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  }
}, changes));
const values = (page, labels) => page.evaluate((labels) => labels.map((l) => document.querySelector(`[aria-label="${l}"]`)?.value), labels);
const tab = (page, label) => page.evaluate((label) => [...document.querySelectorAll('#tabs button')].find((b) => b.textContent === label).click(), label);
const shape = (page, type) => edit(page, [['grain.type', type]]);
/** A new motor (SRM_2023's example), worked out: each check starts from it. */
async function fresh(page) {
  await page.goto(`http://localhost:${WEB}/motor.html?new`, { waitUntil: 'domcontentloaded' });
  const r = await next(page, async () => {});
  assert.equal(r.kind, 'ok', r.error);
  return r;
}
const RAW = /should be|Exception|java\.|Combution|NaN|undefined|no burning area/;

/** A change that cannot work: its error, in the site's words, with the grain still drawn; then undone. */
async function refused(page, changes, want) {
  const labels = changes.map(([l]) => l);
  const before = await values(page, labels);
  const r = await edit(page, changes);
  assert.equal(r.kind, 'error', `${JSON.stringify(changes)}: ${r.status}`);
  assert.match(r.error, want, JSON.stringify(changes));
  assert.doesNotMatch(r.error, RAW, `JSRM's own words: ${r.error}`);
  const back = await edit(page, labels.map((l, i) => [l, before[i]]));
  assert.equal(back.kind, 'ok', `undoing ${JSON.stringify(changes)}: ${back.error}`);
  return r;
}

/** A change that works out. */
async function accepted(page, changes) {
  const r = await edit(page, changes);
  assert.equal(r.kind, 'ok', `${JSON.stringify(changes)}: ${r.error}`);
  return r;
}

const clickText = (page, sel, re) => page.evaluate((sel, src) => {
  const b = [...document.querySelectorAll(sel)].find((x) => new RegExp(src).test(x.textContent));
  if (!b) throw new Error(`nothing matches ${src} in ${sel}`);
  b.click();
}, sel, re.source);
const dialogOpen = (page, re) => page.waitForFunction((src) => [...document.querySelectorAll('dialog[open] header')].some((x) => new RegExp(src).test(x.textContent)), { timeout: 20_000 }, re.source);

try {
  const page = await open('/motor.html?new');
  const first = await next(page, async () => {});
  await check('a new motor is worked out (SRM_2023\'s example)', async () => {
    assert.equal(first.kind, 'ok', first.error);
    assert.match(first.status, /^L1729 ·/);
  });

  await check('cells: formulas as in Excel, decimal commas and thousands, and nothing guessed', async () => {
    await fresh(page);
    let r = await accepted(page, [['chamber.length', '=25.4*18.5']]); // 469.9 mm
    assert.match(r.status, /^L\d+ ·/);
    await accepted(page, [['chamber.length', '470']]);
    await accepted(page, [['settings.densityRatio', '0,95']]); // a decimal comma
    await accepted(page, [['chamber.length', '1,470.0']]); // thousands
    await accepted(page, [['chamber.length', '470']]);
    for (const bad of ['abc', '1,200', '=1/0', '=25,4*2', '']) {
      r = await refused(page, [['chamber.length', bad]], /Enter the chamber length/);
    }
    // A bad cell is shaded, as SRM's would be.
    await page.evaluate(() => {
      const el = document.querySelector('[aria-label="chamber.length"]');
      el.value = 'abc';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    assert.equal(await page.$eval('[aria-label="chamber.length"]', (el) => el.classList.contains('bad')), true);
    await accepted(page, [['chamber.length', '470']]);
    // A formula shows its result once the cell is left.
    await page.$eval('[aria-label="chamber.diameter"]', (el) => { el.focus(); el.select(); });
    await next(page, async () => {
      await page.keyboard.type('=25.4*3');
      await page.keyboard.press('Tab');
    });
    assert.equal(await page.$eval('[aria-label="chamber.diameter"]', (el) => el.value), '76.2'); // as Excel shows it
    await accepted(page, [['chamber.diameter', '75']]);
  });

  await check('the hollow cylinder (BATES): its limits, in the site\'s words', async () => {
    await fresh(page);
    await refused(page, [['chamber.diameter', '0']], /Enter the chamber diameter/);
    await refused(page, [['chamber.diameter', '-75']], /Enter the chamber diameter/);
    await refused(page, [['grain.segments', '2.5']], /whole number from 1 to 100/);
    await refused(page, [['grain.segments', '101']], /whole number from 1 to 100/);
    await refused(page, [['grain.segments', '0']], /Enter the number of segments/);
    await refused(page, [['grain.coreDiameter', '-20']], /Enter the core diameter/);
    await refused(page, [['grain.coreDiameter', '70']], /core must be narrower than the grain/);
    await refused(page, [['grain.outerDiameter', '80']], /grain is wider than the chamber/);
    await refused(page, [['grain.segmentLength', '200']], /grain is longer than the chamber/);
    await refused(page, [['grain.outer', 'inhibited'], ['grain.core', 'inhibited']], /Leave the core or the outer surface exposed/);
    await refused(page, [['settings.densityRatio', '1.2']], /density ratio is between 0 and 1/);
    await refused(page, [['settings.nozzleErosion', '-1']], /erosion is 0 or more/);
  });

  await check('the throat as given, and pressures beyond the burn rate data', async () => {
    await fresh(page);
    let r = await accepted(page, [['throat.mode', 'diameter']]); // the throat SRM's example works out, kept
    await refused(page, [['throat.diameter', '']], /Enter the throat diameter/);
    await refused(page, [['throat.diameter', '25']], /throat is wider than the grain’s core/);
    // Beyond the burn rate data (KNDX's ends at 11.2 MPa), JSRM goes on as SRM does: worked out, with a warning.
    r = await edit(page, [['throat.diameter', '4']]);
    assert.equal(r.kind, 'warn', r.status);
    assert.match(r.status, /pressure beyond the burn rate data/);
    assert.match(r.error, /^Warning: The peak chamber pressure \(2\d\d\.\d MPa\) is beyond KNDX’s measured burn rate data \(up to 11\.2 MPa\)/);
    r = await accepted(page, [['throat.diameter', '16.79']]);
    assert.equal(r.error, '', 'no warning within the data');
    await refused(page, [['throat.diameter', '0']], /Enter the throat diameter/);
    await edit(page, [['throat.mode', 'target']]);
    // Every target: worked out, or, for low ones (a low Kn: a wide throat), said why not and what to change.
    const refusedTargets = [];
    for (const target of await page.$$eval('[aria-label="throat.target"] option', (o) => o.map((x) => x.value))) {
      r = await edit(page, [['throat.target', target]]);
      if (r.kind === 'error') {
        assert.match(r.error, /throat that gives this target pressure \([\d.]+ mm\) is wider than the grain’s core \(20\.00 mm\)\. Choose a higher target pressure/, target);
        refusedTargets.push(Number(target.split(' ')[0]) * (target.endsWith('psi') ? 0.006895 : 1));
      } else assert.equal(r.kind, 'ok', `target ${target}: ${r.error}`);
    }
    assert.ok(refusedTargets.length && Math.max(...refusedTargets) <= 2.6, `refused: ${refusedTargets.join(', ')} MPa`);
    log(`     targets refused for SRM's example (throat wider than its core): ${refusedTargets.map((p) => p.toFixed(2)).join(', ')} MPa`);
    await accepted(page, [['throat.target', (await page.$$eval('[aria-label="throat.target"] option', (o) => o.map((x) => x.value)))[0]]]);
  });

  await check('every propellant, and a target pressure whose throat is wider than the core', async () => {
    await fresh(page);
    for (const p of await page.$$eval('[aria-label="propellant"] option', (o) => o.map((x) => x.value))) {
      const r = await edit(page, [['propellant', p]]);
      // KNPSB burns fast: at SRM's example's target its throat (22.7 mm) is wider than the 20 mm
      // core, which JSRM (and METEOR) refuse; the page says what to change.
      if (p === 'KNPSB') assert.match(r.error, /throat that gives this target pressure \(22\.\d\d mm\) is wider than the grain’s core \(20\.00 mm\)\. Choose a higher target pressure, or make the core wider\./);
      else assert.equal(r.kind, 'ok', `${p}: ${r.error}`);
    }
    await accepted(page, [['grain.coreDiameter', '24']]); // KNPSB, with a wider core
    await accepted(page, [['propellant', 'KNDX'], ['grain.coreDiameter', '20']]);
  });

  await check('the nozzle and the settings, on their worksheets', async () => {
    await fresh(page);
    await tab(page, 'Performance');
    await refused(page, [['settings.nozzleEfficiency', '1.5']], /nozzle efficiency is between 0 and 1/);
    await refused(page, [['settings.expansionRatio', '0.5']], /expansion ratio .* at least 1/);
    const before = await finished(page);
    await page.click('.wb-check input');
    await page.waitForFunction((n) => Number(document.querySelector('#status').dataset.calculations) > n && document.querySelector('#status').dataset.kind === 'ok', { timeout: 60_000 }, before);
    await page.click('.wb-check input'); // back to the ratio given
    await page.waitForFunction((n) => Number(document.querySelector('#status').dataset.calculations) > n + 1 && document.querySelector('#status').dataset.kind === 'ok', { timeout: 60_000 }, before);
    await tab(page, 'Pressure');
    await refused(page, [['settings.combustionEfficiency', '0']], /combustion efficiency is between 0 and 1/);
    await refused(page, [['settings.ambientPressure', '0']], /Enter the ambient pressure/);
    await refused(page, [['settings.erosiveCoefficient', '-1']], /erosive burning values are 0 or more/);
    await tab(page, 'Nozzle Design');
    await refused(page, [['settings.divergence', '95']], /half-angles are between 0 and 90/);
    await refused(page, [['settings.convergence', '0']], /half-angles are between 0 and 90/);
    await tab(page, 'Data and Kn');
  });

  await check('a motor too small, and one too big, for any class', async () => {
    await fresh(page);
    const labels = ['chamber.diameter', 'chamber.length', 'grain.outerDiameter', 'grain.coreDiameter', 'grain.segmentLength', 'grain.segments'];
    const before = await values(page, labels);
    for (const sizes of [['8', '12', '7', '2', '10', '1'], ['1000', '10000', '950', '300', '2400', '4']]) {
      const r = await edit(page, labels.map((l, i) => [l, sizes[i]]));
      assert.doesNotMatch(`${r.status} ${r.error}`, RAW);
      if (r.kind === 'error') assert.match(r.error, /classes from A to V|burn rate data|never settled/);
      log(`     ${sizes.join(' × ')} mm: ${r.kind === 'ok' ? r.status : r.error}`);
    }
    await accepted(page, labels.map((l, i) => [l, before[i]]));
  });

  const shapes = {
    rodTube: [[[['grain.rodDiameter', '45']], /rod must be narrower than the tube’s inside/], [[['grain.tubeInnerDiameter', '70']], /tube’s outside must be wider/]],
    cSlot: [[[['grain.slotDepth', '80']], /slot must be less deep/], [[['grain.slotWidth', '70']], /slot must be narrower/],
      [[['grain.slotOffset', '40']], /slot’s offset must be less than the grain’s radius/]],
    finocyl: [[[['grain.finCount', '11']], /whole number from 1 to 10/], [[['grain.innerDiameter', '70']], /core must be narrower/]],
    // (JSRM, as METEOR, works out a core that breaks through the grain's outside; not one off it.)
    moonBurner: [[[['grain.coreOffset', '45']], /keep the core inside the grain/]],
    star: [[[['grain.pointCount', '10']], /whole number from 1 to 9/], [[['grain.pointDiameter', '70']], /star’s points must stay inside the grain/],
      [[['grain.innerDiameter', '45']], /inner diameter must be less than its star/]],
    endBurner: [[[['grain.holeDiameter', '70']], /ignition hole must be narrower/], [[['grain.holeDepth', '250']], /ignition hole must be shorter/]],
  };
  for (const [type, cases] of Object.entries(shapes)) {
    await check(`${type}: worked out, drawn, and its limits in the site's words`, async () => {
      await fresh(page);
      const r = await shape(page, type);
      assert.equal(r.kind, 'ok', `${type}: ${r.error}`);
      assert.ok(r.drawn, 'the grain is drawn');
      for (const [changes, want] of cases) {
        const bad = await refused(page, changes, want);
        assert.ok(bad.drawn || /whole number/.test(bad.error), `${type}: the grain is still drawn when ${JSON.stringify(changes)} does not work out`);
      }
    });
  }
  await check('C-slot without a core, and an end burner without an ignition hole', async () => {
    await fresh(page);
    await shape(page, 'cSlot');
    await accepted(page, [['grain.coreDiameter', '0']]);
    await shape(page, 'endBurner');
    await accepted(page, [['grain.holeDiameter', '0'], ['grain.holeDepth', '0']]);
    await shape(page, 'hollow');
  });

  await check('every worksheet draws, worked out or not', async () => {
    await fresh(page);
    const r = await accepted(page, [['grain.outerDiameter', '69']]);
    assert.match(r.status, /^[A-Z]\d+ ·/);
    for (const [label, file] of [['Pressure', 'pressure'], ['Performance', 'performance'], ['Nozzle Design', 'nozzle'], ['Output', 'output'], ['Propellant data', 'propellants'], ['Data and Kn', 'data']]) {
      await tab(page, label);
      const drawn = await page.$$eval('#sheet .mt-chart, #sheet .wb-table, #sheet .wb-drawing, #sheet .wb-summary', (els) => els.length);
      assert.ok(drawn > 0, `${label}: nothing drawn`);
      if (file === 'data') await page.screenshot({ path: join(out, 'motor-edge-data.png') });
    }
    // Not worked out: the error on every worksheet, and nothing else missing.
    await edit(page, [['grain.segments', '0']]);
    for (const label of ['Pressure', 'Performance', 'Nozzle Design', 'Output', 'Data and Kn']) {
      await tab(page, label);
      assert.match(await page.$eval('#wb-error', (el) => (el.hidden ? '' : el.textContent)), /Enter the number of segments/, label);
    }
    await accepted(page, [['grain.segments', '4']]);
  });

  await check('the title, as now, in the motor file and the Output summary', async () => {
    await fresh(page);
    await page.evaluate(() => {
      const el = document.querySelector('[aria-label="Title"]');
      el.value = 'Club motor 한글 ✓';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await tab(page, 'Output');
    assert.match(await page.$eval('.wb-summary-title', (el) => el.textContent), /Club motor 한글 ✓/);
  });

  await check('the motor file: downloaded, read as OpenRocket does, a decimal comma for the mass', async () => {
    await page.evaluate(() => {
      for (const [label, v] of [['eng.diameter', '83'], ['eng.length', '560'], ['eng.hardwareMass', '1,9'], ['eng.delays', '4 6 8'], ['eng.manufacturer', 'Edge Rocketry']]) {
        const el = document.querySelector(`[aria-label="${label}"]`);
        el.value = v;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
    await page.click('#download-eng');
    const deadline = Date.now() + 15_000;
    let file = null;
    while (!file && Date.now() < deadline) {
      file = readdirSync(downloads).find((f) => f.endsWith('.eng'));
      if (!file) await new Promise((r) => setTimeout(r, 200));
    }
    assert.ok(file, 'a .eng file was downloaded');
    const text = readFileSync(join(downloads, file), 'utf8');
    const { motors } = readMotorFile(file, Object.assign(new TextEncoder().encode(text), { toString: () => text }));
    assert.equal(motors[0].diameterMm, 83);
    assert.equal(motors[0].manufacturer, 'Edge-Rocketry'); // one word, as the format needs
    const [, , , delays, prop, total] = text.split('\n').find((l) => l && !l.startsWith(';')).split(' ');
    assert.equal(delays, '4-6-8');
    assert.ok(Math.abs(Number(total) - Number(prop) - 1.9) < 1e-4, `masses ${prop} ${total}`); // 1,9 kg empty
    assert.match(text, /^;.*Club motor 한글 ✓/m);
  });

  await check('"Use in OpenRocket" twice, and twice at once: one custom motor, the newest', async () => {
    await page.$eval('#motor-name', (el) => { el.value = 'Edge L'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.click('#use-openrocket');
    await dialogOpen(page, /Added to OpenRocket/);
    await clickText(page, 'dialog[open] button', /^Done$/);
    assert.equal(db.Motor.rows.size, 1);
    const firstId = [...db.Motor.rows.keys()][0];
    // Changed, and added again twice in a hurry, from the sheet's button and the bar's.
    await tab(page, 'Data and Kn');
    await edit(page, [['grain.segments', '3']]);
    await tab(page, 'Output');
    await page.evaluate(() => {
      document.querySelector('#use-openrocket').click();
      document.querySelector('.wb-eng .wb-actions button:last-child').click();
      document.querySelector('#use-openrocket').click();
    });
    await dialogOpen(page, /Added to OpenRocket/);
    await clickText(page, 'dialog[open] button', /^Done$/);
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(db.Motor.rows.size, 1, 'one custom motor');
    const [motorId] = [...db.Motor.rows.keys()];
    assert.notEqual(motorId, firstId, 'the newer one');
    assert.equal(db.MotorDesign.rows.size, 1, 'one saved motor');
    const d = await readMotorDesign(s, [...db.MotorDesign.rows.values()][0]);
    assert.equal(d.motor_id, motorId);
    const m = await readMotor(s, db.Motor.rows.get(motorId));
    assert.match(m.content, /^L\d+ 83 560 4-6-8 /m);
  });

  await check('saved, and opened again as it was', async () => {
    await tab(page, 'Data and Kn');
    await shape(page, 'star');
    await accepted(page, [['grain.pointCount', '5'], ['propellant', 'KNSB fine']]);
    const status = await page.$eval('#status', (el) => el.textContent);
    await page.click('#save');
    await page.waitForFunction(() => !document.querySelector('#save').classList.contains('unsaved'), { timeout: 20_000 });
    const again = await open(new URL(page.url()).pathname + new URL(page.url()).search);
    const r = await next(again, async () => {});
    assert.equal(r.status, status);
    assert.deepEqual(await values(again, ['grain.type', 'grain.pointCount', 'propellant', 'eng.diameter']), ['star', '5', 'KNSB fine', null]);
    await tab(again, 'Output');
    assert.deepEqual(await values(again, ['eng.diameter', 'eng.length', 'eng.hardwareMass']), ['83', '560', '1.9']);
    await again.close();
  });

  await check('leaving with changes asks first', async () => {
    await edit(page, [['grain.pointCount', '6']]);
    await page.click('#all-motors');
    await dialogOpen(page, /Leave without saving/);
    await clickText(page, 'dialog[open] button', /^Cancel$/);
    assert.match(page.url(), /motor\.html\?id=/);
  });

  await check('your motors: search, duplicate, rename and delete', async () => {
    const home = await open('/motor.html');
    await home.waitForSelector('#motor-grid .card', { timeout: 20_000 });
    const cards = () => home.$$eval('#motor-grid .card h3', (els) => els.map((x) => x.textContent));
    assert.deepEqual(await cards(), ['Edge L']);
    await home.type('#motor-search', 'zzz');
    assert.deepEqual(await cards(), []);
    await home.$eval('#motor-search', (el) => { el.value = 'knsb'; el.dispatchEvent(new Event('input')); }); // by its summary
    assert.deepEqual(await cards(), ['Edge L']);
    await home.$eval('#motor-search', (el) => { el.value = ''; el.dispatchEvent(new Event('input')); });
    const menu = async (name, item) => {
      await home.evaluate((name) => [...document.querySelectorAll('#motor-grid .card')].find((c) => c.querySelector('h3').textContent === name).querySelector('.menu-wrap button').click(), name);
      await clickText(home, '#motor-grid .menu:not([hidden]) button', new RegExp(`^${item}$`));
    };
    await menu('Edge L', 'Duplicate');
    await dialogOpen(home, /Duplicate motor/);
    await clickText(home, 'dialog[open] button', /^Duplicate$/);
    await home.waitForFunction(() => document.querySelectorAll('#motor-grid .card').length === 2, { timeout: 20_000 });
    await menu('Edge L (copy)', 'Rename');
    await dialogOpen(home, /Rename motor/);
    await home.$eval('dialog[open] input', (el) => { el.value = 'Edge L, second'; });
    await clickText(home, 'dialog[open] button', /^Rename$/);
    await home.waitForFunction(() => [...document.querySelectorAll('#motor-grid .card h3')].some((h) => h.textContent === 'Edge L, second'), { timeout: 20_000 });
    await menu('Edge L, second', 'Delete');
    await dialogOpen(home, /Delete motor/);
    await clickText(home, 'dialog[open] button', /^Delete$/);
    await home.waitForFunction(() => document.querySelectorAll('#motor-grid .card').length === 1, { timeout: 20_000 });
    assert.equal(db.Motor.rows.size, 1, 'the custom motor stays (the copy had none)');
    await home.close();
  });

  await check('on a phone: nothing wider than the screen', async () => {
    for (const path of ['/motor.html', '/motor.html?new']) {
      const phone = await open(path, { width: 390, height: 844, isMobile: true, hasTouch: true });
      if (path.endsWith('new')) await next(phone, async () => {});
      else await phone.waitForSelector('#motor-grid .card', { timeout: 20_000 });
      const wide = await phone.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      await phone.screenshot({ path: join(out, `motor-edge-phone-${path.endsWith('new') ? 'sheet' : 'home'}.png`) });
      assert.ok(wide <= 1, `${path}: ${wide}px wider than the screen`);
      await phone.close();
    }
  });

  await check('dark mode', async () => {
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
    await tab(page, 'Data and Kn');
    await page.evaluate(() => document.querySelector('#sheet').scrollTo(0, 0));
    await page.screenshot({ path: join(out, 'motor-edge-dark.png') });
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
  });

  await check('no errors in the pages', async () => {
    assert.deepEqual(problems, []);
  });
} finally {
  await browser.close();
  await vite.close();
}
process.exit(failed ? 1 : 0);
