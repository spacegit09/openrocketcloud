// Records which parts of the Java runtime (CheerpJ's, from its CDN) the motor designer reads, for
// web/public/or/motor-preload.json: CheerpJ then fetches them all at once as it starts, instead of
// one after another as Java asks for them (a round trip each, which is most of a first visit's wait
// far from the CDN). The motor designer is used as people use it: SRM's example (a hollow
// cylinder), a design JSRM refuses, and every other grain shape.
//   node test/motor-preload.mjs        (after scripts/build-web-jars.sh; again when either changes)
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';
import { createServer } from 'vite';

const web = join(import.meta.dirname, '..');
const PORT = 5195;
const vite = await createServer({ root: web, server: { port: PORT, strictPort: true }, logLevel: 'error' });
await vite.listen();
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  userDataDir: mkdtempSync(join(tmpdir(), 'orc-motor-preload-')),
});
const user = { id: 'u1', email: 'p@example.com', full_name: 'P', role: 'user', created_date: '2026-03-02T09:15:00.000000' };
try {
  const page = await browser.newPage();
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const url = new URL(req.url());
    if (url.host !== `localhost:${PORT}` || !url.pathname.startsWith('/api/')) return req.continue();
    const body = /User\/me$/.test(url.pathname) ? user
      : /functions\/billing$/.test(url.pathname) ? { access: { ok: true, full: true, kind: 'early' } } : {};
    return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.evaluateOnNewDocument(() => localStorage.setItem('base44_access_token', 'preload-token'));
  await page.goto(`http://localhost:${PORT}/motor.html?new`, { waitUntil: 'domcontentloaded' });
  const finished = () => page.$eval('#status', (el) => Number(el.dataset.calculations ?? 0));
  const after = async (changes) => {
    const n = await finished();
    await page.evaluate((changes) => {
      for (const [label, v] of changes) {
        const el = document.querySelector(`[aria-label="${label}"]`);
        el.value = v;
        el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
      }
    }, changes);
    await page.waitForFunction((n) => Number(document.querySelector('#status').dataset.calculations ?? 0) > n
      && document.querySelector('#status').dataset.kind !== 'busy', { timeout: 240_000, polling: 250 }, n);
    console.log(`  ${JSON.stringify(changes)}: ${await page.$eval('#status', (el) => el.textContent)}`);
  };
  await page.waitForFunction(() => Number(document.querySelector('#status')?.dataset.calculations ?? 0) > 0, { timeout: 240_000, polling: 250 });
  await after([['throat.mode', 'diameter']]);
  await after([['throat.diameter', '25']]); // JSRM refuses it: its exceptions
  await after([['throat.mode', 'target']]);
  for (const type of ['cSlot', 'finocyl', 'moonBurner', 'star', 'endBurner', 'rodTube']) await after([['grain.type', type]]);
  const resources = await page.evaluate(() => window.cjGetRuntimeResources());
  writeFileSync(join(web, 'public', 'or', 'motor-preload.json'), resources);
  const parsed = JSON.parse(resources);
  console.log(`motor-preload.json: ${Object.keys(parsed).length} files, ${Object.values(parsed).reduce((n, r) => n + r.length / 2, 0)} ranges`);
} finally {
  await browser.close();
  await vite.close();
}
