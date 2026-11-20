// A real purchase in Paddle's sandbox: headless Chrome opens the plan page through Vite, with
// Base44's sign-in and backend functions answered here by the real handlers (base44/shared) over an
// in-memory stand-in for Base44's records, as in billing-e2e.mjs; but Paddle is the real one, in
// its sandbox: its API (your sandbox API key), Paddle.js and its checkout, paid with Paddle's test
// card. Afterwards Paddle's own record of the events (GET /events) goes through the webhook code.
// Set up the sandbox first (scripts/paddle-setup.mjs --webhook none), then:
//   PADDLE_API_KEY=pdl_sdbx_… PADDLE_CLIENT_TOKEN=test_… node test/paddle-sandbox-e2e.mjs [explore]
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';
import { createServer } from 'vite';
import { designsApi } from '../base44/shared/api.js';
import { billingApi, forgetAccess, handleEvent, OPEN_ACTIONS, paddleApi, requirePlan, setCheckoutOpen, setPlansStart, TRIAL_MS } from '../base44/shared/billing.js';
import { sealer } from '../base44/shared/sealed.js';
import { fakeDb } from './fake-base44.mjs';

const KEY = process.env.PADDLE_API_KEY;
const TOKEN = process.env.PADDLE_CLIENT_TOKEN;
if (!/^pdl_sdbx_/.test(KEY ?? '') || !/^test_/.test(TOKEN ?? '')) {
  console.error('Set PADDLE_API_KEY (a sandbox key) and PADDLE_CLIENT_TOKEN (test_…).');
  process.exit(2);
}
const WEB = 5193;
const out = join(import.meta.dirname, 'out');
mkdirSync(out, { recursive: true });
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const explore = process.argv.includes('explore');

setPlansStart(Date.parse('2026-01-01T00:00:00Z'));
setCheckoutOpen(true); // the sandbox takes payments
const db = fakeDb(['Design', 'Motor', 'SavedFlight', 'Logbook', 'SealedPart', 'User', 'Account', 'Purchase', 'Group']);
const s = sealer(Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64'));
const paddle = paddleApi(KEY);
const APIS = { designs: designsApi, billing: billingApi };
const users = new Map();
const run = Date.now().toString(36);

export async function person(name) {
  const email = `rocket-test-${name}-${run}@example.com`;
  const created = new Date().toISOString().replace('Z', '');
  const u = await db.User.create({ email, full_name: `Test ${name}`, role: 'user' });
  db.User.rows.get(u.id).created_date = created;
  const user = { ...u, created_date: created };
  users.set(email, user);
  await call('billing', user, { action: 'status' });
  const [a] = await db.Account.filter({ user_id: u.id });
  await db.Account.update(a.id, { trial_started: new Date(Date.now() - TRIAL_MS - 86400_000).toISOString() });
  forgetAccess();
  return user;
}

export async function call(name, user, body) {
  const me = { id: user.id, email: user.email, name: user.full_name, created: user.created_date, role: user.role };
  const ctx = { db, s, me, paddle, paddleToken: TOKEN, files: { sign: async () => null } };
  try {
    if (OPEN_ACTIONS[name]) await requirePlan(ctx, String(body?.action ?? ''), OPEN_ACTIONS[name]);
    return { status: 200, json: await APIS[name](ctx, body) };
  } catch (e) {
    if (e.status) return { status: e.status, json: { error: e.message, ...(e.code ? { code: e.code } : {}) } };
    console.error(name, e);
    return { status: 500, json: { error: 'Something went wrong. Please try again.' } };
  }
}

const vite = await createServer({ root: join(import.meta.dirname, '..'), server: { port: WEB, strictPort: true }, logLevel: 'warn' });
await vite.listen();
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  userDataDir: mkdtempSync(join(tmpdir(), 'orc-sandbox-')),
  args: ['--lang=en-US'],
});

export async function open(path, user) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  page.on('pageerror', (e) => log('page error:', e.message));
  page.on('console', (m) => { if (m.type() === 'error') log('console:', m.text().slice(0, 200)); });
  await page.setRequestInterception(true);
  page.on('request', async (req) => {
    const url = new URL(req.url());
    if (url.host !== `localhost:${WEB}` || !url.pathname.startsWith('/api/')) return req.continue();
    if (/\/entities\/User\/me$/.test(url.pathname)) return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(user) });
    const fn = url.pathname.match(/\/functions\/(\w+)$/)?.[1];
    if (fn && APIS[fn]) {
      const r = await call(fn, user, JSON.parse(req.postData() || '{}'));
      return req.respond({ status: r.status, contentType: 'application/json', body: JSON.stringify(r.json) });
    }
    return req.respond({ status: 200, contentType: 'application/json', body: '{}' });
  });
  await page.evaluateOnNewDocument(() => localStorage.setItem('base44_access_token', 'sandbox-token'));
  await page.goto(`http://localhost:${WEB}${path}`, { waitUntil: 'domcontentloaded' });
  return page;
}

/** Paddle's checkout frame, once it is there. */
export async function checkoutFrame(page, timeout = 30_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const f = page.frames().find((fr) => /paddle\.com/.test(fr.url()) && /checkout/.test(fr.url()));
    if (f) return f;
    await sleep(300);
  }
  throw new Error('no Paddle checkout frame');
}

/** What a frame shows: its inputs and buttons. */
export async function describe(frame) {
  return frame.evaluate(() => ({
    url: location.href.slice(0, 120),
    text: document.body.innerText.slice(0, 1500),
    inputs: [...document.querySelectorAll('input, select')].map((i) => ({ tag: i.tagName, type: i.type, name: i.name, id: i.id, testid: i.dataset.testid, ph: i.placeholder, label: i.getAttribute('aria-label'), value: i.type === 'password' ? '' : i.value })),
    buttons: [...document.querySelectorAll('button')].map((b) => ({ text: b.innerText.trim().slice(0, 40), testid: b.dataset.testid, disabled: b.disabled })),
    frames: [...document.querySelectorAll('iframe')].map((f) => f.src.slice(0, 100)),
  }));
}

export async function done() {
  await browser.close();
  await vite.close();
}

if (explore) {
  try {
    const u = await person('explore');
    const page = await open('/account.html', u);
    await page.waitForSelector('.plan-card[data-plan=lifetime] button:not([disabled])', { timeout: 20_000 });
    await page.click('.plan-card[data-plan=lifetime] button');
    const f = await checkoutFrame(page);
    await sleep(6000);
    await page.screenshot({ path: join(out, 'sandbox-explore-1.png') });
    log(JSON.stringify(await describe(f), null, 1));
    for (const fr of page.frames()) log('frame', fr.url().slice(0, 140));
  } finally {
    await done();
  }
}

// ------------------------------------------------------------------ the purchases

/** Pays in Paddle's checkout with a test card (4242…: accepted; 4000 0000 0000 0002: declined). */
async function payByCard(page, { card = '4242 4242 4242 4242' } = {}) {
  const f = await checkoutFrame(page);
  const go = '[data-testid=combinedAuthenticationLocationFormSubmitButton]';
  const number = '[data-testid=cardNumberInput]';
  // First Paddle's "Your details" step (email and country, filled in): its Continue button, which
  // Paddle has named in more than one way; or straight to the card form.
  const step = () => document.querySelector('[data-testid=cardNumberInput]')
    ?? document.querySelector('[data-testid=combinedAuthenticationLocationFormSubmitButton]')
    ?? [...document.querySelectorAll('button')].find((b) => /^\s*continue\s*$/i.test(b.innerText) && b.offsetParent);
  await f.waitForFunction(step, { timeout: 40_000, polling: 250 });
  if (!(await f.$(number))) await f.evaluate((src) => new Function(`return (${src})()`)().click(), step.toString());
  await f.waitForSelector(number, { visible: true, timeout: 40_000 });
  await f.type(number, card, { delay: 15 });
  await f.type('[data-testid=cardholderNameInput]', 'Test Buyer', { delay: 10 });
  await f.type('[data-testid=expiryDateField]', '12 / 30', { delay: 15 });
  await f.type('[data-testid=cardVerificationValueInput]', '123', { delay: 15 });
  await f.click('[data-testid=cardPaymentFormSubmitButton]');
  return f;
}
const waitText = (page, sel, re, timeout = 60_000) => page.waitForFunction((sel, src) => [...document.querySelectorAll(sel)].some((el) => new RegExp(src).test(el.innerText)), { timeout, polling: 250 }, sel, re.source);
const closeCheckout = (page) => page.evaluate(() => window.Paddle?.Checkout.close());

const results = [];
const ids = { transactions: [], subscriptions: [] };
async function check(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push(`PASS ${name}`);
    log(`PASS ${name} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  } catch (e) {
    results.push(`FAIL ${name}: ${e.message.split('\n')[0]}`);
    log(`FAIL ${name}: ${e.stack}`);
    for (const [i, p] of (await browser.pages()).entries()) await p.screenshot({ path: join(out, `sandbox-fail-${i}.png`) }).catch(() => {});
  }
}
const purchases = async (user) => db.Purchase.filter({ user_id: user.id });

if (!explore && !process.argv.includes('noexplore')) {
  const people = {};
  try {
    await check('a declined card: Paddle says so, nothing is recorded', async () => {
      const u = people.declined = await person('declined');
      const page = await open('/account.html', u);
      await page.waitForSelector('.plan-card[data-plan=lifetime] button:not([disabled])', { timeout: 20_000 });
      await page.click('.plan-card[data-plan=lifetime] button');
      const f = await payByCard(page, { card: '4000 0000 0000 0002' });
      // Paddle's own message, once it has heard from the (test) bank.
      await f.waitForFunction(() => /declined by your bank/i.test(document.body.innerText), { timeout: 60_000, polling: 250 });
      await sleep(500);
      await page.screenshot({ path: join(out, 'sandbox-declined.png') });
      await f.click('[data-testid=wideOverlayCloseIcon]');
      await waitText(page, '.plan-card[data-plan=lifetime] button', /Buy for US\$5/);
      assert.equal((await purchases(u)).length, 0);
      await page.close();
    });

    await check('individual plan: paid by card in Paddle\'s checkout', async () => {
      const u = people.lifetime = await person('lifetime');
      const page = await open('/account.html', u);
      await waitText(page, '#now', /free week has ended/);
      await page.click('.plan-card[data-plan=lifetime] button');
      await payByCard(page);
      await waitText(page, '#now', /Individual plan/);
      await page.screenshot({ path: join(out, 'sandbox-lifetime-paid.png') });
      await closeCheckout(page);
      const [p] = await purchases(u);
      assert.equal(p.kind, 'lifetime');
      assert.equal(p.status, 'completed');
      ids.transactions.push(p.paddle_id);
      // Recorded once paid; Paddle calls it completed a moment later.
      let txn;
      for (let i = 0; i < 30; i++) {
        txn = await paddle.get(`/transactions/${p.paddle_id}`);
        if (txn.status === 'completed') break;
        await sleep(2000);
      }
      assert.equal(txn.status, 'completed');
      log(`  Paddle charged ${txn.details.totals.grand_total} ${txn.currency_code} (tax ${txn.details.totals.tax}), country ${txn.address?.country_code ?? '?'}`);
      await page.close();
    });

    await check('monthly plan: subscribed, cancelled and kept, in Paddle', async () => {
      const u = people.monthly = await person('monthly');
      const page = await open('/account.html', u);
      await page.waitForSelector('.plan-card[data-plan=monthly] button:not([disabled])', { timeout: 20_000 });
      await page.click('.plan-card[data-plan=monthly] button');
      await payByCard(page);
      await waitText(page, '#now', /Renews on/);
      await closeCheckout(page);
      const [p] = await purchases(u);
      assert.equal(p.kind, 'monthly');
      assert.match(p.paddle_id, /^sub_/);
      ids.subscriptions.push(p.paddle_id);
      page.on('dialog', (d) => d.accept());
      await page.evaluate(() => [...document.querySelectorAll('#now button')].find((b) => /Cancel plan/.test(b.innerText)).click());
      await page.waitForSelector('dialog[open] footer button.primary');
      await page.click('dialog[open] footer button.primary');
      await waitText(page, '#now', /Cancelled: it ends on/);
      assert.equal((await paddle.get(`/subscriptions/${p.paddle_id}`)).scheduled_change?.action, 'cancel');
      await page.screenshot({ path: join(out, 'sandbox-monthly-cancelled.png') });
      await page.evaluate(() => [...document.querySelectorAll('#now button')].find((b) => /Keep my plan/.test(b.innerText)).click());
      await waitText(page, '#now', /Renews on/);
      assert.equal((await paddle.get(`/subscriptions/${p.paddle_id}`)).scheduled_change, null);
      const portal = await call('billing', u, { action: 'portal' });
      assert.match(portal.json.url, /^https:\/\/sandbox-customer-portal\.paddle\.com\//);
      await page.close();
    });

    await check('group plan and two more places, paid in Paddle', async () => {
      const u = people.group = await person('group');
      const page = await open('/account.html', u);
      await page.waitForSelector('.plan-card[data-plan=group] button:not([disabled])', { timeout: 20_000 });
      await page.click('.plan-card[data-plan=group] button');
      await payByCard(page);
      await waitText(page, '#group', /1 of 10/);
      await closeCheckout(page);
      await page.$eval('#group .qty', (el) => { el.value = '2'; el.dispatchEvent(new Event('input')); });
      await page.evaluate(() => [...document.querySelectorAll('#group button')].find((b) => /Buy 2 more places/.test(b.innerText)).click());
      await payByCard(page);
      await waitText(page, '#group', /1 of 12/);
      await page.screenshot({ path: join(out, 'sandbox-group-paid.png') });
      await closeCheckout(page);
      for (const p of await purchases(u)) ids.transactions.push(p.paddle_id);
      await page.close();
    });

    await check('Paddle\'s own records of these purchases, through the webhook code, give the same plans', async () => {
      // Paddle's events for them, oldest first, applied to fresh records (no syncs), each twice.
      const mine = new Set([...ids.transactions, ...ids.subscriptions]);
      const fetchOurs = async () => {
        const events = [];
        let after = null;
        for (let page = 0; page < 10; page++) {
          const batch = await paddle.get(`/events?per_page=200${after ? `&after=${after}` : ''}`);
          if (!batch?.length) break;
          events.push(...batch);
          after = batch.at(-1).event_id;
          if (batch.length < 200) break;
        }
        return events.filter((e) => mine.has(e.data?.id) || mine.has(e.data?.subscription_id) || mine.has(e.data?.transaction_id))
          .filter((e) => /^(transaction\.(paid|completed)|subscription\.|adjustment\.)/.test(e.event_type))
          .sort((a, b) => String(a.occurred_at).localeCompare(String(b.occurred_at)));
      };
      // Paddle lists events a little after they happen: until every purchase has its completion.
      let ours = [];
      for (let i = 0; i < 30; i++) {
        ours = await fetchOurs();
        const completed = new Set(ours.filter((e) => e.event_type === 'transaction.completed').map((e) => e.data.id));
        if (ids.transactions.every((t) => completed.has(t)) && ours.some((e) => e.event_type === 'subscription.created')) break;
        await sleep(3000);
      }
      log(`  ${ours.length} events: ${[...new Set(ours.map((e) => e.event_type))].join(', ')}`);
      assert.ok(ours.length >= 6);
      const fresh = fakeDb(['User', 'Account', 'Purchase', 'Group']);
      for (const [id, r] of db.User.rows) fresh.User.rows.set(id, { ...r });
      for (const [id, r] of db.Account.rows) fresh.Account.rows.set(id, { ...r });
      for (const e of [...ours, ...ours]) await handleEvent({ db: fresh, s, paddle }, e);
      const kinds = async (database) => {
        const outk = {};
        for (const [name, u] of Object.entries(people)) {
          const { lookAccess } = await import('../base44/shared/billing.js');
          outk[name] = (await lookAccess(database, { id: u.id, created: u.created_date, role: 'user' }, { key: await s.lookupKey(u.email) })).kind;
        }
        return outk;
      };
      const viaSync = await kinds(db);
      const viaEvents = await kinds(fresh);
      log('  plans from syncs:', JSON.stringify(viaSync));
      log('  plans from events:', JSON.stringify(viaEvents));
      assert.deepEqual(viaEvents, viaSync);
      assert.deepEqual(viaSync, { declined: 'none', lifetime: 'lifetime', monthly: 'monthly', group: 'group' });
      const [g] = await fresh.Group.filter({ owner_id: people.group.id });
      assert.equal(g.seats, 12);
    });
  } finally {
    await done();
  }
  console.log(`\n${results.join('\n')}\nPADDLE-SANDBOX ${results.some((r) => r.startsWith('FAIL')) ? 'FAIL' : 'PASS'} (${results.length} checks)`);
  process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
}
