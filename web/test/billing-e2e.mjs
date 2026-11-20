// End-to-end check of plans and payments in the browser: headless Chrome opens the real pages
// (home, dashboard, plan page, design, planner, logbook) through Vite, with Base44's sign-in and
// backend functions answered here by the real handlers (base44/shared: billing.js, api.js,
// logbooks.js) over in-memory stand-ins for Base44's records and for Paddle (fake-paddle.mjs), and
// Paddle.js replaced by a stand-in whose "Pay" button pays as Paddle's checkout would (the webhook
// events arrive a moment after the page has heard it is paid, as they do). Screenshots go to
// test/out/.
//   node test/billing-e2e.mjs
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';
import { createServer } from 'vite';
import { designsApi, flightsApi, motorsApi } from '../base44/shared/api.js';
import {
  billingApi, forgetAccess, OPEN_ACTIONS, paddleApi, receiveWebhook, requirePlan, setPlansStart, signBody, TRIAL_MS,
} from '../base44/shared/billing.js';
import { logbooksApi } from '../base44/shared/logbooks.js';
import { sealer } from '../base44/shared/sealed.js';
import { fakeDb } from './fake-base44.mjs';
import { fakePaddle } from './fake-paddle.mjs';

const WEB = 5191;
const out = join(import.meta.dirname, 'out');
mkdirSync(out, { recursive: true });
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const KEY = `pdl_sdbx_apikey_${'a1'.repeat(13)}_${'B2c'.repeat(7)}x_AQO`;
const SECRET = 'pdl_ntfset_e2e';

// ------------------------------------------------------------------ Base44 and Paddle, here

setPlansStart(Date.parse('2026-01-01T00:00:00Z')); // plans began a while ago (free weeks can be made to have ended)
const db = fakeDb(['Design', 'Motor', 'SavedFlight', 'Logbook', 'SealedPart', 'User', 'Account', 'Purchase', 'Group']);
const s = sealer(Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64'));
const fp = fakePaddle();
fp.setUp();
const paddle = paddleApi(KEY, { fetch: fp.fetch });
let payments = true;
const APIS = { designs: designsApi, motors: motorsApi, flights: flightsApi, logbooks: logbooksApi, billing: billingApi };
const users = new Map(); // email -> Base44 user record

async function person(email, { created = new Date().toISOString().replace('Z', ''), name, role = 'user' } = {}) {
  const u = await db.User.create({ email, full_name: name ?? email.split('@')[0], role });
  db.User.rows.get(u.id).created_date = created;
  const user = { ...u, created_date: created };
  users.set(email, user);
  return user;
}

/** A backend function, as functions/*\/entry.ts runs it (shared/endpoint.ts). */
async function call(name, user, body) {
  const me = { id: user.id, email: user.email, name: user.full_name, created: user.created_date, role: user.role };
  const ctx = { db, s, me, paddle: payments ? paddle : null, paddleToken: payments ? 'test_e2e000000000000000000000' : null, files: { sign: async () => null } };
  try {
    // As the functions do (base44/functions/*/entry.ts): the planner's and the logbook's need a plan with everything.
    if (OPEN_ACTIONS[name]) await requirePlan(ctx, String(body?.action ?? ''), OPEN_ACTIONS[name], { full: name === 'flights' || name === 'logbooks' });
    return { status: 200, json: await APIS[name](ctx, body) };
  } catch (e) {
    if (e.status) return { status: e.status, json: { error: e.message, ...(e.code ? { code: e.code } : {}) } };
    console.error(name, e);
    return { status: 500, json: { error: 'Something went wrong. Please try again.' } };
  }
}

/** Paddle sends its webhook events. */
async function deliver(events) {
  for (const e of events) {
    const body = JSON.stringify(e);
    const r = await receiveWebhook({ secret: SECRET, signature: await signBody(SECRET, body), body, ctx: () => ({ db, s, paddle }) });
    if (r.status !== 200) throw new Error(`webhook ${e.event_type}: ${r.status}`);
  }
  forgetAccess();
}

// Paddle.js: a checkout with Pay and Close, which says what Paddle.js says to the page.
const PADDLE_JS = `
window.Paddle = {
  Environment: { set(e) { window.__paddleEnv = e; } },
  Initialize(o) { this._cb = o.eventCallback; window.__paddleToken = o.token; },
  Checkout: {
    open({ transactionId }) {
      const o = document.createElement('div');
      o.id = 'fake-paddle';
      o.style = 'position:fixed;inset:0;background:rgba(0,0,0,.55);display:grid;place-items:center;z-index:99999;font:16px system-ui';
      o.innerHTML = '<div style="background:#fff;color:#111;padding:28px;border-radius:10px;min-width:320px"><p id="fake-text">Checkout (stand-in) for ' + transactionId + '</p><button id="fake-pay">Pay</button> <button id="fake-close">Close</button></div>';
      document.body.append(o);
      o.querySelector('#fake-pay').onclick = async () => {
        await fetch('/__paddle/pay?txn=' + transactionId);
        o.querySelector('#fake-text').textContent = 'Payment successful';
        window.Paddle._cb({ name: 'checkout.completed', data: { transaction_id: transactionId } });
      };
      o.querySelector('#fake-close').onclick = () => { o.remove(); window.Paddle._cb({ name: 'checkout.closed', data: {} }); };
    },
    close() { document.getElementById('fake-paddle')?.remove(); },
  },
};`;

// ------------------------------------------------------------------ the browser

const vite = await createServer({ root: join(import.meta.dirname, '..'), server: { port: WEB, strictPort: true }, logLevel: 'warn' });
await vite.listen();
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  userDataDir: mkdtempSync(join(tmpdir(), 'orc-billing-')),
});
const pageErrors = [];

/** A page signed in as `email` (or nobody). */
async function open(path, email = null, { width = 1280, height = 900 } = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width, height });
  page.on('pageerror', (e) => pageErrors.push(`${path}: ${e.message}`));
  page.on('dialog', (d) => d.accept());
  await page.setRequestInterception(true);
  page.on('request', async (req) => {
    const url = new URL(req.url());
    try {
      if (url.href.startsWith('https://cdn.paddle.com/paddle/v2/paddle.js')) {
        return req.respond({ status: 200, contentType: 'application/javascript', body: PADDLE_JS });
      }
      // OpenRocket's Java runtime and its jars are not needed here.
      if (/leaningtech\.com$/.test(url.host) || url.pathname.startsWith('/or/')) return req.respond({ status: 404, body: '' });
      if (url.host === `localhost:${WEB}` && url.pathname === '/__paddle/pay') {
        const events = fp.pay(url.searchParams.get('txn'));
        setTimeout(() => deliver(events).catch((e) => console.error(e)), 400); // the webhook, a moment later
        return req.respond({ status: 200, contentType: 'application/json', body: '{}' });
      }
      if (url.host === `localhost:${WEB}` && url.pathname.startsWith('/api/')) {
        const user = email ? users.get(email) : null;
        if (/\/entities\/User\/me$/.test(url.pathname)) {
          return user
            ? req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(user) })
            : req.respond({ status: 401, contentType: 'application/json', body: '{"message":"not signed in"}' });
        }
        const fn = url.pathname.match(/\/functions\/(\w+)$/)?.[1];
        if (fn && APIS[fn]) {
          if (!user) return req.respond({ status: 401, contentType: 'application/json', body: '{"error":"Please sign in."}' });
          const r = await call(fn, user, JSON.parse(req.postData() || '{}'));
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
  if (email) await page.evaluateOnNewDocument(() => localStorage.setItem('base44_access_token', 'e2e-token'));
  await page.goto(`http://localhost:${WEB}${path}`, { waitUntil: 'domcontentloaded' });
  return page;
}

const text = (page, sel) => page.$eval(sel, (el) => el.innerText).catch(() => '');
const visible = (page, sel) => page.$eval(sel, (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length)).catch(() => false);
async function waitText(page, sel, pattern, timeout = 15_000) {
  await page.waitForFunction((sel, src) => [...document.querySelectorAll(sel)].some((el) => new RegExp(src).test(el.innerText)), { timeout, polling: 100 }, sel, pattern.source);
}
async function clickText(page, sel, pattern) {
  const ok = await page.evaluate((sel, src) => {
    const el = [...document.querySelectorAll(sel)].find((x) => new RegExp(src).test(x.innerText) && !x.disabled);
    el?.click();
    return Boolean(el);
  }, sel, pattern.source);
  if (!ok) throw new Error(`nothing to click: ${sel} ${pattern}`);
}
const shot = (page, name, full = false) => page.screenshot({ path: join(out, `billing-${name}.png`), fullPage: full });
async function endTrial(email) {
  const u = users.get(email);
  const [a] = await db.Account.filter({ user_id: u.id });
  await db.Account.update(a.id, { trial_started: new Date(Date.now() - TRIAL_MS - 24 * 3600_000).toISOString() });
  forgetAccess();
}
async function pay(page) {
  await page.waitForSelector('#fake-pay', { timeout: 15_000 });
  await page.click('#fake-pay');
}

const results = [];
async function check(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push(`PASS ${name}`);
    log(`PASS ${name} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  } catch (e) {
    results.push(`FAIL ${name}: ${e.message.split('\n')[0]}`);
    log(`FAIL ${name}: ${e.stack}`);
    // What each open page showed.
    const pages = (await browser.pages()).filter((p) => p.url().startsWith('http'));
    for (const [i, p] of pages.entries()) await p.screenshot({ path: join(out, `billing-fail-${i}.png`), fullPage: true }).catch(() => {});
    for (const p of pages) await p.close().catch(() => {});
  }
}

const DRAWING = JSON.stringify({ v: 1, box: [0, -20, 400, 40], s: [{ d: 'M 0 0 L 100 -10 L 380 -10 L 380 10 L 100 10 Z' }, { d: 'M 380 -5 L 400 -5 L 400 5 L 380 5 Z', m: 1 }] });

try {
  await check('signed out: the home page explains the plans', async () => {
    const page = await open('/');
    await page.waitForSelector('#pricing', { visible: true });
    const t = await text(page, '#pricing');
    for (const p of [/Monthly/i, /US\$1/, /a month/, /Individual/i, /US\$5/, /Group/i, /US\$10/, /you and 9 others/, /US\$3 for each extra person/, /free week/i, /Paddle/]) assert.match(t, p);
    assert.ok(await page.$('.t-links a[href="#pricing"]'));
    // Each plan can be bought at once, skipping the free week: sign-in, then that plan's checkout.
    assert.match(t, /skip the free week/);
    const buyNow = await page.$$eval('#pricing .t-buy', (els) => els.map((e) => [e.textContent.trim(), e.dataset.signinTo]));
    assert.deepEqual(buyNow, ['openrocket', 'monthly', 'lifetime', 'group'].map((p) => ['Buy now', `/account.html?buy=${p}`]));
    assert.doesNotMatch(t, /Until payments begin/);
    await page.evaluate(() => document.querySelector('#pricing').scrollIntoView());
    await sleep(900);
    await shot(page, 'home-pricing');
    await page.setViewport({ width: 390, height: 844 });
    await sleep(400);
    await page.evaluate(() => document.querySelector('#pricing').scrollIntoView());
    await sleep(700);
    await shot(page, 'home-pricing-phone');
    await page.close();
  });

  await check('a new person: free week on the dashboard and the plan page', async () => {
    await person('nova@example.com', { name: 'Nova Park' });
    const page = await open('/', 'nova@example.com');
    await waitText(page, '#plan-banner', /Free week: 7 days left/);
    assert.ok(await page.$('#me a[href="/account.html"]'), 'Plan link in the top bar');
    assert.equal(await page.$eval('#plan-banner a', (a) => [a.textContent, a.getAttribute('href')].join(' ')), 'Buy a plan now /account.html#plans');
    await shot(page, 'dashboard-trial');
    await page.goto(`http://localhost:${WEB}/account.html`, { waitUntil: 'domcontentloaded' });
    await waitText(page, '#now', /Free week: 7 days left/);
    await waitText(page, '#now', /Or buy a plan now: it starts at once/);
    assert.ok(await page.$('#now button.primary'), 'Buy a plan now on the free week card');
    const cards = await page.$$eval('.plan-card', (els) => els.map((e) => e.dataset.plan));
    assert.deepEqual(cards, ['openrocket', 'monthly', 'lifetime', 'group']);
    await shot(page, 'account-trial', true);
    await page.close();
  });

  await check('monthly: bought in the checkout, cancelled, kept', async () => {
    const page = await open('/account.html', 'nova@example.com');
    await waitText(page, '.plan-card[data-plan=monthly] button', /Buy for US\$1/);
    // Opened and closed without paying: nothing changes.
    await clickText(page, '.plan-card[data-plan=monthly] button', /Buy/);
    await page.waitForSelector('#fake-close');
    assert.equal(await page.evaluate(() => window.__paddleEnv), 'sandbox');
    await page.click('#fake-close');
    await waitText(page, '.plan-card[data-plan=monthly] button', /Buy for US\$1/);
    await clickText(page, '.plan-card[data-plan=monthly] button', /Buy/);
    await pay(page);
    await waitText(page, '#now', /Renews on/);
    await waitText(page, '.plan-card[data-plan=monthly]', /Your plan/);
    await page.evaluate(() => window.Paddle.Checkout.close());
    await shot(page, 'account-monthly', true);
    // The webhook's events arrive after the page recorded the purchase: still one plan.
    await sleep(1200);
    const nova = users.get('nova@example.com');
    assert.equal((await db.Purchase.filter({ user_id: nova.id })).length, 1);
    await clickText(page, '#now button', /Cancel plan/);
    await page.waitForSelector('dialog[open] footer button.primary');
    await shot(page, 'account-cancel-confirm');
    await page.click('dialog[open] footer button.primary');
    await waitText(page, '#now', /Cancelled: it ends on/);
    await shot(page, 'account-cancelled', true);
    await clickText(page, '#now button', /Keep my plan/);
    await waitText(page, '#now', /Renews on/);
    await page.close();
  });

  await check('buy now, skipping the free week: the homepage link opens that plan\'s checkout', async () => {
    await person('rae@example.com', { name: 'Rae Lin' });
    // Closed without paying: still in the free week, and the link is not opened again on reload.
    let page = await open('/account.html?buy=lifetime', 'rae@example.com');
    await page.waitForSelector('#fake-close', { timeout: 15_000 });
    assert.match(await page.$eval('#fake-text', (e) => e.textContent), /Checkout/);
    assert.equal(new URL(page.url()).search, '');
    await page.click('#fake-close');
    await waitText(page, '#now', /Free week: 7 days left/);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitText(page, '#now', /Free week/);
    await sleep(800);
    assert.equal(await page.$('#fake-close'), null, 'no checkout after a reload');
    await page.close();
    // Paid: the plan starts at once, in the middle of the free week.
    page = await open('/account.html?buy=lifetime', 'rae@example.com');
    await pay(page);
    await waitText(page, '#now', /Individual plan/);
    await page.evaluate(() => window.Paddle.Checkout.close());
    await shot(page, 'account-buy-now', true);
    // A plan they already have, and someone free for good: told so, no checkout.
    await page.goto(`http://localhost:${WEB}/account.html?buy=lifetime`, { waitUntil: 'domcontentloaded' });
    await waitText(page, '.toast', /already yours for good/);
    assert.equal(await page.$('#fake-close'), null);
    await page.close();
  });

  await check('OpenRocket plan: designs work; the planner and the logbook say they are not included', async () => {
    const ora = await person('ora@gmail.com', { name: 'Ora Orbit' });
    await call('billing', ora, { action: 'status' });
    await endTrial('ora@gmail.com');
    await db.Purchase.create({ paddle_id: 'txn_01openrocketplan0000000000', kind: 'openrocket', user_id: ora.id, status: 'completed', seats: 0 });
    forgetAccess();
    assert.equal((await call('designs', ora, { action: 'create', name: 'Orbit I' })).status, 200);
    const refusedFlight = await call('flights', ora, { action: 'create', name: 'x' });
    assert.equal(refusedFlight.status, 402);
    assert.equal(refusedFlight.json.code, 'plan_upgrade');
    assert.equal((await call('flights', ora, { action: 'list' })).status, 200, 'their launch plans stay theirs to see');
    const account = await open('/account.html', 'ora@gmail.com');
    await waitText(account, '#now', /OpenRocket plan/);
    await waitText(account, '.plan-card[data-plan=openrocket]', /Your plan/);
    await shot(account, 'account-openrocket', true);
    await account.close();
    for (const path of ['/planner.html', '/logbook.html']) {
      const page = await open(path, 'ora@gmail.com');
      await page.waitForSelector('dialog.plan-wall-dialog[open]');
      await waitText(page, 'dialog.plan-wall-dialog', /Not part of your plan/);
      if (path === '/planner.html') await shot(page, 'planner-openrocket-only');
      await page.close();
    }
  });

  await check('free week over: the dashboard says so, keeps downloads, and the plans notice stops the rest', async () => {
    const lapsed = await person('lapsed@gmail.com', { name: 'Lee Lapsed' });
    await call('billing', lapsed, { action: 'status' });
    const d = (await call('designs', lapsed, { action: 'create', name: 'Falcon II' })).json;
    await call('designs', lapsed, { action: 'preview', id: d.id, preview: DRAWING });
    await endTrial('lapsed@gmail.com');
    const page = await open('/', 'lapsed@gmail.com');
    await waitText(page, '#plan-banner', /free week has ended/);
    await page.waitForSelector('.card.locked');
    await shot(page, 'dashboard-ended');
    await page.click('#new-btn');
    await page.waitForSelector('dialog.plan-wall-dialog[open]');
    await shot(page, 'dashboard-plan-notice');
    await clickText(page, 'dialog.plan-wall-dialog button', /Not now/);
    await page.waitForFunction(() => !document.querySelector('dialog.plan-wall-dialog[open]'));
    await page.click('.card .body');
    await page.waitForSelector('dialog.plan-wall-dialog[open]');
    await clickText(page, 'dialog.plan-wall-dialog button', /Not now/);
    // The planner and logbook links, Share and Motors.
    for (const sel of ['.page-head a[href="/planner.html"]', '.page-head a[href="/logbook.html"]', '#motors-btn']) {
      await page.click(sel);
      await page.waitForSelector('dialog.plan-wall-dialog[open]');
      assert.match(page.url(), /localhost:\d+\/$/);
      await clickText(page, 'dialog.plan-wall-dialog button', /Not now/);
    }
    // Still there: download and saved copies.
    assert.ok(await page.$('.card button[title="Download .ork"]'));
    // A function refusing (a rename slipped through): the notice again.
    const r = await call('designs', lapsed, { action: 'rename', id: d.id, name: 'x' });
    assert.equal(r.status, 402);
    assert.equal(r.json.code, 'plan_required');
    await page.close();
    for (const path of [`/design.html?id=${d.id}`, '/planner.html', '/logbook.html']) {
      const p = await open(path, 'lapsed@gmail.com');
      await p.waitForSelector('dialog.plan-wall-dialog[open]', { timeout: 20_000 });
      assert.match(await text(p, 'dialog.plan-wall-dialog'), /free week has ended/);
      assert.ok(await p.$('dialog.plan-wall-dialog a[href="/account.html"]'));
      // Not closable here.
      await p.keyboard.press('Escape');
      await sleep(300);
      assert.ok(await p.$('dialog.plan-wall-dialog[open]'), `${path}: the notice stays`);
      await shot(p, `notice-${path.slice(1).split('.')[0]}`);
      await p.close();
    }
  });

  await check('group: bought, nine people added, the tenth refused, more places, someone removed', async () => {
    const teacher = await person('teacher@school.org', { name: 'Ms Park' });
    await call('billing', teacher, { action: 'status' });
    await endTrial('teacher@school.org');
    const page = await open('/account.html', 'teacher@school.org');
    await waitText(page, '#now', /free week has ended/);
    await clickText(page, '.plan-card[data-plan=group] button', /Buy for US\$10/);
    await pay(page);
    await waitText(page, '#group', /1 of 10/);
    await page.evaluate(() => window.Paddle.Checkout.close());
    // One typed, Enter to add (the lapsed person from before).
    await page.type('#group textarea', 'Lapsed@gmail.com');
    await page.keyboard.press('Enter');
    await waitText(page, '#group', /2 of 10/);
    // Eight more pasted at once, one per line or with commas, spaces and semicolons.
    await page.$eval('#group textarea', (el) => { el.value = 's1@gmail.com\ns2@gmail.com, s3@gmail.com;s4@gmail.com s5@gmail.com\r\ns6@gmail.com\n\ns7@gmail.com,s8@gmail.com'; });
    await page.click('#group form button');
    await waitText(page, '#group', /10 of 10/);
    assert.equal((await page.$$('#group .group-list .item')).length, 9);
    await waitText(page, '#group', /Your group is full/);
    await shot(page, 'account-group-full', true);
    // The lapsed person is in now.
    forgetAccess();
    const lapsed = users.get('lapsed@gmail.com');
    assert.equal((await call('designs', lapsed, { action: 'rename', id: (await call('designs', lapsed, { action: 'list' })).json[0].id, name: 'Falcon III' })).status, 200);
    // Two more places.
    await page.$eval('#group .qty', (el) => { el.value = '2'; el.dispatchEvent(new Event('input')); });
    await waitText(page, '#group button', /Buy 2 more places for US\$6/);
    await clickText(page, '#group button', /Buy 2 more places/);
    await pay(page);
    await waitText(page, '#group', /10 of 12/);
    await page.evaluate(() => window.Paddle.Checkout.close());
    await page.type('#group textarea', 'extra1@gmail.com, extra2@gmail.com, extra3@gmail.com');
    // (The thank-you toast is over the button now: clicks go through it.)
    await page.click('#group form button');
    await waitText(page, '#group .error', /room for 11 people besides you/);
    await shot(page, 'account-group-refused', true);
    await page.$eval('#group textarea', (el) => { el.value = ''; });
    await page.type('#group textarea', 'extra1@gmail.com');
    await page.click('#group form button');
    await waitText(page, '#group', /11 of 12/);
    await page.click('#group button[aria-label="Remove s1@gmail.com"]');
    await waitText(page, '#group', /10 of 12/);
    assert.ok(!(await text(page, '#group')).includes('s1@gmail.com'));
    await shot(page, 'account-group', true);
    await page.close();
  });

  await check('a group member sees whose group they are in, and no notice', async () => {
    const page = await open('/', 'lapsed@gmail.com');
    await page.waitForSelector('.card');
    await sleep(800);
    assert.equal(await visible(page, '#plan-banner'), false);
    assert.equal((await page.$$('.card.locked')).length, 0);
    await page.goto(`http://localhost:${WEB}/account.html`, { waitUntil: 'domcontentloaded' });
    await waitText(page, '#now', /In Ms Park’s group/);
    await shot(page, 'account-member', true);
    await page.close();
  });

  await check('someone from before plans: free for good, offered only the group plan', async () => {
    await person('early@example.com', { created: '2026-02-01T10:00:00.000000', name: 'Early Bird' });
    const page = await open('/account.html', 'early@example.com');
    await waitText(page, '#now', /Free for good/);
    assert.deepEqual(await page.$$eval('.plan-card', (els) => els.map((e) => e.dataset.plan)), ['group']);
    await shot(page, 'account-early', true);
    await page.goto(`http://localhost:${WEB}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#dashboard:not([hidden])');
    await sleep(800);
    assert.equal(await visible(page, '#plan-banner'), false);
    await page.close();
  });

  await check('payments not set up yet: plans shown, buying waits', async () => {
    payments = false;
    await person('waiting@example.com');
    const page = await open('/account.html', 'waiting@example.com');
    await waitText(page, '#plans', /Payments open soon/);
    assert.ok(await page.$eval('.plan-card[data-plan=monthly] button', (b) => b.disabled));
    await page.close();
    payments = true;
  });

  await check('before plans begin: free for everyone, nothing in the way', async () => {
    setPlansStart(null);
    forgetAccess();
    await person('before@example.com');
    const page = await open('/account.html', 'before@example.com');
    await waitText(page, '#now', /Free for now/);
    await page.goto(`http://localhost:${WEB}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#dashboard:not([hidden])');
    await sleep(800);
    assert.equal(await visible(page, '#plan-banner'), false);
    await page.goto(`http://localhost:${WEB}/logbook.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#books:not([hidden])', { timeout: 15_000 });
    assert.equal(await page.$('dialog.plan-wall-dialog[open]'), null);
    await page.close();
    setPlansStart(Date.parse('2026-01-01T00:00:00Z'));
    forgetAccess();
  });

  await check('the plan page on a phone', async () => {
    const page = await open('/account.html', 'teacher@school.org', { width: 390, height: 844 });
    await waitText(page, '#group', /10 of 12/);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 0, `the page is ${overflow}px wider than the phone`);
    await shot(page, 'account-phone', true);
    await page.close();
  });

  if (pageErrors.length) results.push(`FAIL page errors: ${pageErrors.join(' | ')}`);
} finally {
  await browser.close();
  await vite.close();
}
const failed = results.filter((r) => r.startsWith('FAIL'));
console.log(`\n${results.join('\n')}\nBILLING-E2E ${failed.length ? 'FAIL' : 'PASS'} (${results.length} checks)`);
process.exit(failed.length ? 1 : 0);
