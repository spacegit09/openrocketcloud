// Takes the Motor Designer's screenshots for its tour page (features/motor-designer.html) and the
// home page (web/public/tour/md-*.webp). It uses the real page through Vite and its calculator
// (JSRM in CheerpJ). The backend functions are answered here by the real handlers over in-memory
// records, with made-up motors.
//   node test/motor-tour-shots.mjs
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';
import { createServer } from 'vite';
import { motorDesignsApi, motorsApi } from '../base44/shared/api.js';
import { billingApi } from '../base44/shared/billing.js';
import { sealer } from '../base44/shared/sealed.js';
import { fakeDb } from './fake-base44.mjs';

const WEB = 5196;
const tour = join(import.meta.dirname, '..', 'public', 'tour');
const db = fakeDb(['Design', 'Motor', 'SavedFlight', 'MotorDesign', 'Logbook', 'SealedPart', 'User', 'Account', 'Purchase', 'Group']);
const s = sealer(Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64'));
const APIS = { motors: motorsApi, motorDesigns: motorDesignsApi, billing: billingApi };
const u = await db.User.create({ email: 'mina@example.com', full_name: 'Mina Park', role: 'user' });
const user = { ...u, created_date: '2026-03-02T09:15:00.000000' }; // from before plans: free
db.User.rows.get(u.id).created_date = user.created_date;
const me = { id: user.id, email: user.email, name: user.full_name, created: user.created_date, role: user.role };

const vite = await createServer({ root: join(import.meta.dirname, '..'), server: { port: WEB, strictPort: true }, logLevel: 'warn' });
await vite.listen();
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  userDataDir: mkdtempSync(join(tmpdir(), 'orc-motor-shots-')),
  protocolTimeout: 900_000, // the page is busy while JSRM works out a shaped grain
});
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)} s]`, ...a);

async function open(path, { width = 1200, height = 750 } = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: 1.5 });
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
  await page.setRequestInterception(true);
  page.on('request', async (req) => {
    const url = new URL(req.url());
    if (url.host !== `localhost:${WEB}` || !url.pathname.startsWith('/api/')) return req.continue();
    const json = (status, body) => req.respond({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (/\/entities\/User\/me$/.test(url.pathname)) return json(200, user);
    const fn = url.pathname.match(/\/functions\/(\w+)$/)?.[1];
    if (!fn || !APIS[fn]) return json(200, {});
    try {
      return json(200, await APIS[fn]({ db, s, me, paddle: null, paddleToken: null, files: { sign: async () => null } }, JSON.parse(req.postData() || '{}')));
    } catch (e) {
      return json(e.status ?? 500, { error: e.message });
    }
  });
  await page.evaluateOnNewDocument(() => localStorage.setItem('base44_access_token', 'shots-token'));
  await page.goto(`http://localhost:${WEB}${path}`, { waitUntil: 'domcontentloaded' });
  return page;
}

const calculations = (page) => page.$eval('#status', (el) => Number(el.dataset.calculations ?? 0)).catch(() => 0);
async function settled(page, before) {
  await page.waitForFunction((n) => Number(document.querySelector('#status')?.dataset.calculations ?? 0) > n
    && document.querySelector('#status').dataset.kind !== 'busy', { timeout: 300_000, polling: 250 }, before);
}
/** Sets inputs by their labels (data paths), one calculation for all of them. */
async function set(page, changes) {
  const n = await calculations(page);
  await page.evaluate((changes) => {
    for (const [label, v] of changes) {
      const el = document.querySelector(`[aria-label="${label}"]`);
      el.value = v;
      el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
    }
  }, changes);
  await settled(page, n);
}
const sheet = (page, label) => page.evaluate((label) => [...document.querySelectorAll('#tabs button')].find((b) => b.textContent.trim().startsWith(label)).click(), label);
const shot = async (page, name, opts = {}) => {
  await new Promise((r) => setTimeout(r, 400));
  await page.screenshot({ path: join(tour, `${name}.webp`), type: 'webp', quality: 88, ...opts });
  log('saved', name);
};
async function save(page, name) {
  await page.evaluate((name) => {
    const el = document.querySelector('#motor-name');
    el.value = name;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, name);
  await page.click('#save');
  await page.waitForFunction(() => /[?&]id=/.test(location.search), { timeout: 30_000 });
}

try {
  // 1. Richard Nakka's example motor, as a team would title it: the data sheet and the charts.
  let page = await open('/motor.html?new');
  await settled(page, 0);
  // The titles change no numbers: they go in with the propellant, which does.
  await set(page, [['Title', 'Falcon II booster motor'], ['Second title line', '4 BATES grains, KNSB fine'], ['propellant', 'KNSB fine']]);
  await shot(page, 'md-data');
  await sheet(page, 'Performance');
  await shot(page, 'md-performance');
  await sheet(page, 'Pressure');
  await shot(page, 'md-pressure');
  await sheet(page, 'Output');
  // The motor file's details change no numbers either.
  await page.evaluate(() => {
    for (const [label, v] of [['eng.name', 'FalconII-K'], ['eng.manufacturer', 'Falcon team'], ['eng.delays', '6-10-P']]) {
      const el = document.querySelector(`[aria-label="${label}"]`);
      el.value = v;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
  await shot(page, 'md-output');
  await save(page, 'Falcon II booster');
  await page.close();

  // 2. Each grain shape, drawn as JSRM burns it, and saved as a motor of its own.
  const shapes = [
    ['star', 'Star', 'Sora’s star grain', [['propellant', 'KNSB coarse']]],
    ['finocyl', 'Finocyl', 'Finocyl test motor', [['propellant', 'KNDX']]],
    ['cSlot', 'C-slot', 'C-slot sustainer', [['propellant', 'KNSU']]],
    ['moonBurner', 'Moon burner', 'Moon burner long burn', [['propellant', 'KNER coarse']]],
  ];
  const grains = [];
  for (const [type, label, name, extra] of shapes) {
    page = await open('/motor.html?new');
    await settled(page, 0);
    await set(page, [['grain.type', type], ...extra]);
    log(type, await page.$eval('#status', (el) => el.textContent.trim()));
    // The drawing is square (its viewBox): just that square, end on.
    await page.$eval('.wb-grain svg', (el) => el.scrollIntoView({ block: 'center' }));
    await new Promise((r) => setTimeout(r, 300));
    const box = await (await page.$('.wb-grain svg')).boundingBox();
    const side = Math.min(box.width, box.height);
    grains.push([label, `data:image/png;base64,${await page.screenshot({ encoding: 'base64', clip: { x: box.x, y: box.y, width: side, height: side } })}`]);
    await save(page, name);
    await page.close();
  }

  // The grain shapes side by side, as on the page.
  page = await browser.newPage();
  await page.setViewport({ width: 960, height: 860, deviceScaleFactor: 1.5 });
  await page.setContent(`<!doctype html><body style="margin:0;background:#fff;font:600 20px system-ui,sans-serif;color:#1f2937">
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:30px 24px;padding:40px 34px 0;box-sizing:border-box;height:860px;justify-items:center">
    ${grains.map(([label, src]) => `<figure style="margin:0;display:flex;flex-direction:column;align-items:center;gap:14px"><img src="${src}" style="width:330px;height:330px"><figcaption>${label}</figcaption></figure>`).join('')}
    </div></body>`);
  await shot(page, 'md-grains');
  await page.close();

  // 3. Your motors, saved over the last few days.
  [...db.MotorDesign.rows.values()].forEach((r, i, all) => {
    r.updated_date = r.created_date = new Date(Date.now() - (all.length - i) * 19 * 3600e3).toISOString();
  });
  page = await open('/motor.html');
  await page.waitForSelector('#motor-grid .card');
  await shot(page, 'md-gallery');
  await page.close();
} finally {
  await browser.close();
  await vite.close();
}
