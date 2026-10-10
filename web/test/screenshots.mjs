// Takes the dashboard screenshot for the GitHub page (docs/assets/dashboard.jpg) from the real
// page code, with Base44's data answered by sample designs (no account needed).
//   node test/screenshots.mjs
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';
import { createServer } from 'vite';

const PORT = 5181;
const out = join(import.meta.dirname, 'out');
const hours = (h) => new Date(Date.now() - h * 3600e3).toISOString();
const me = { id: 'u1', email: 'mina@example.com', full_name: 'Mina Park' };
const designs = [
  { id: 'd1', name: 'Two stage high power rocket', owner_email: me.email, owner_name: 'Mina Park', members: [{ email: 'joon@example.com', role: 'editor' }, { email: 'sora@example.com', role: 'viewer' }], edited_at: hours(2) },
  { id: 'd2', name: 'A simple model rocket', owner_email: 'joon@example.com', owner_name: 'Joon Lee', members: [{ email: me.email, role: 'editor' }], edited_at: hours(26) },
  { id: 'd3', name: 'Pods--powered with recovery deployment', owner_email: me.email, owner_name: 'Mina Park', members: [], edited_at: hours(75) },
];

const vite = await createServer({ root: join(import.meta.dirname, '..'), server: { port: PORT, strictPort: true }, logLevel: 'warn' });
await vite.listen();
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  userDataDir: mkdtempSync(join(tmpdir(), 'orc-shots-')),
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 800, height: 600, deviceScaleFactor: 2 });
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const url = new URL(req.url());
    if (!url.pathname.startsWith('/api/')) return req.continue();
    const json = (body) => req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname.endsWith('/entities/User/me')) return json(me);
    if (url.pathname.endsWith('/entities/Design')) return json(designs);
    return json({});
  });
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#dashboard:not([hidden]) .card');
  await page.screenshot({ path: join(out, 'dashboard.png') });
  console.log('saved', join(out, 'dashboard.png'));
} finally {
  await browser.close();
  await vite.close();
}
