// Plans and payments (base44/shared/billing.js) against in-memory stand-ins for Base44's entities
// (fake-base44.mjs) and for Paddle (fake-paddle.mjs): the free week, the people from before plans,
// each plan bought, renewed, cancelled and refunded, groups and their people, and Paddle's
// webhooks arriving twice, late, out of order, forged or while something fails.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  accessOf, billingApi, BillingError, FREE_BEFORE, forgetAccess, forgetPrices, GROUP_SIZE, lookAccess, OPEN_ACTIONS, paddleApi,
  receiveWebhook, requirePlan, setPlansStart, signBody, TRIAL_MS, verifySignature, when,
} from '../base44/shared/billing.js';
import { sealer } from '../base44/shared/sealed.js';
import { fakeDb } from './fake-base44.mjs';
import { fakePaddle } from './fake-paddle.mjs';
import { EVENTS, setUpPaddle } from '../scripts/paddle-setup.mjs';

const KEY = `pdl_sdbx_apikey_${'a1'.repeat(13)}_${'B2c'.repeat(7)}x_AQO`;
const SECRET = 'pdl_ntfset_01hv8x0000000000000000000000_secret';
const DAY = 24 * 3600_000;
const OPEN = OPEN_ACTIONS.designs;
// Plans began a while ago, so that free weeks can be made to have ended.
const BEGUN = Date.parse('2026-01-01T00:00:00Z');

function setup({ payments = true } = {}) {
  forgetPrices();
  forgetAccess();
  setPlansStart(BEGUN);
  const db = fakeDb(['Design', 'Motor', 'SavedFlight', 'Logbook', 'SealedPart', 'User', 'Account', 'Purchase', 'Group']);
  const s = sealer(Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64'));
  const fp = fakePaddle();
  const prices = fp.setUp();
  const paddle = payments ? paddleApi(KEY, { fetch: fp.fetch }) : null;
  const ctxOf = (me) => ({ db, s, me, paddle, paddleToken: payments ? 'test_0123456789abcdef0123456' : null });

  /** Someone with a Base44 account made at `created` (Base44 writes times without a zone). */
  async function person(email, { created = new Date().toISOString().replace('Z', ''), role = 'user', name = null } = {}) {
    const u = await db.User.create({ email, full_name: name ?? email.split('@')[0], role });
    db.User.rows.get(u.id).created_date = created;
    const me = { id: u.id, email, name: name ?? email.split('@')[0], created, role };
    const billing = (body) => billingApi(ctxOf(me), body);
    return {
      id: u.id,
      me,
      billing,
      status: () => billing({ action: 'status' }),
      /** What a gated function does before an action (designs: list, get, leave, delete, preview are open). */
      gate: (action) => requirePlan(ctxOf(me), action, OPEN),
      /** The same for the Launch Planner's and the Logbook's functions (flights: list and delete are open). */
      gateFull: (action) => requirePlan(ctxOf(me), action, OPEN_ACTIONS.flights, { full: true }),
      /** What the actors ask: no fingerprint, by user id. */
      actor: () => lookAccess(db, { id: u.id, created, role }),
      /** Their free week, moved back so it ended `days` ago. */
      endTrial: async (days = 1) => {
        await billing({ action: 'status' }); // the site has seen them: their week has started
        const [a] = await db.Account.filter({ user_id: u.id });
        await db.Account.update(a.id, { trial_started: new Date(Date.now() - TRIAL_MS - days * DAY).toISOString() });
        forgetAccess();
      },
      /** Buys `plan` at checkout: returns the transaction id and Paddle's webhook events. */
      buy: async (plan, { quantity, upTo } = {}) => {
        const { transactionId } = await billing({ action: 'checkout', plan, quantity });
        return { transactionId, events: fp.pay(transactionId, { upTo }) };
      },
    };
  }

  /** Paddle sending events to the paddleWebhook function, as Paddle signs them. */
  async function deliver(events, { now } = {}) {
    for (const e of events) {
      const body = JSON.stringify(e);
      const r = await receiveWebhook({ secret: SECRET, signature: await signBody(SECRET, body, now), body, ctx: () => ({ db, s, paddle }) });
      assert.equal(r.status, 200, `${e.event_type}: ${JSON.stringify(r.json)}`);
    }
    forgetAccess();
  }
  return { db, s, fp, prices, paddle, person, deliver };
}

const refused = (status, pattern) => (e) => e instanceof BillingError && e.status === status && (!pattern || pattern.test(e.message));
const shuffled = (list) => list.map((x) => [Math.random(), x]).sort((a, b) => a[0] - b[0]).map(([, x]) => x);
const near = (iso, ms, slack = 60_000) => Math.abs(Date.parse(iso) - ms) < slack;

test('Base44 times without a zone are UTC', () => {
  assert.equal(when('2026-11-15T11:30:00.123000'), Date.parse('2026-11-15T11:30:00.123Z'));
  assert.equal(when('2026-11-15T11:30:00Z'), Date.parse('2026-11-15T11:30:00Z'));
  assert.equal(when('2026-11-15T20:30:00+09:00'), Date.parse('2026-11-15T11:30:00Z'));
  assert.ok(Number.isNaN(when(null)));
  assert.ok(Number.isNaN(when('')));
});

test('a new person gets a free week; after it, they can still see, download and delete their work', async () => {
  const { db, person } = setup();
  const nova = await person('nova@example.com');
  const st = await nova.status();
  assert.equal(st.access.kind, 'trial');
  assert.equal(st.access.ok, true);
  assert.ok(near(st.access.trialEnds, Date.now() + TRIAL_MS));
  assert.equal(st.access.until, st.access.trialEnds);
  assert.equal((await db.Account.filter({ user_id: nova.id })).length, 1);
  // Opening the site again does not restart the week.
  await nova.status();
  assert.equal((await db.Account.filter({ user_id: nova.id })).length, 1);
  await nova.gate('create');
  assert.equal((await nova.actor()).ok, true);

  await nova.endTrial();
  const after = await nova.status();
  assert.equal(after.access.kind, 'none');
  assert.equal(after.access.ok, false);
  await assert.rejects(nova.gate('create'), (e) => e.status === 402 && e.code === 'plan_required' && /free week has ended/.test(e.message));
  await assert.rejects(nova.gate('share'), (e) => e.status === 402);
  for (const action of OPEN) await nova.gate(action);
  assert.equal((await nova.actor()).ok, false);
});

test('the free week ends exactly 7 days after sign-up', () => {
  const created = FREE_BEFORE + DAY;
  const user = { id: 'u1', created: new Date(created).toISOString() };
  assert.equal(accessOf({ user, now: created + TRIAL_MS - 1 }).kind, 'trial');
  assert.equal(accessOf({ user, now: created + TRIAL_MS }).kind, 'none');
  // The site first saw them later (their Account): the week still counts from their sign-up.
  const account = { trial_started: new Date(created + 2 * DAY).toISOString() };
  assert.equal(accessOf({ user, account, now: created + TRIAL_MS - 1 }).kind, 'trial');
  assert.equal(accessOf({ user, account, now: created + TRIAL_MS }).kind, 'none');
  assert.equal(accessOf({ user, account, now: created + TRIAL_MS - 1 }).trialEnds, created + TRIAL_MS);
});

test('before plans begin, nobody needs one; then free weeks count from sign-up, not from when plans begin', async () => {
  // Signed up 10 days before plans begin: the week is over the moment they begin.
  const created = FREE_BEFORE + DAY;
  const begin = created + 10 * DAY;
  const user = { id: 'u1', created: new Date(created).toISOString() };
  setPlansStart(begin);
  assert.equal(accessOf({ user, now: begin - 1 }).kind, 'open');
  assert.equal(accessOf({ user, now: begin }).kind, 'none');
  // Signed up 3 days before: 4 days left.
  const late = { id: 'u2', created: new Date(begin - 3 * DAY).toISOString() };
  assert.equal(accessOf({ user: late, now: begin }).kind, 'trial');
  assert.equal(accessOf({ user: late, now: begin }).trialEnds, begin - 3 * DAY + TRIAL_MS);
  assert.equal(accessOf({ user: late, now: begin + 4 * DAY }).kind, 'none');
  setPlansStart(BEGUN);

  const { person } = setup();
  setPlansStart(null);
  const nova = await person('nova@example.com', { created: new Date(Date.now() - 3 * DAY).toISOString().replace('Z', '') });
  let st = await nova.status();
  assert.equal(st.access.kind, 'open');
  assert.equal(st.access.ok, true);
  assert.equal(st.access.trialEnds, null);
  await nova.gate('create');
  assert.equal((await nova.actor()).ok, true);
  // Plans begin now: Nova's week (from her sign-up, 3 days ago) has 4 days left...
  setPlansStart(Date.now());
  forgetAccess();
  st = await nova.status();
  assert.equal(st.access.kind, 'trial');
  assert.ok(near(st.access.trialEnds, Date.now() - 3 * DAY + TRIAL_MS));
  await nova.gate('create');
  // ...and once it is over, she needs a plan.
  await nova.endTrial();
  st = await nova.status();
  assert.equal(st.access.kind, 'none');
  await assert.rejects(nova.gate('create'), (e) => e.status === 402 && e.code === 'plan_required');
  assert.equal((await nova.actor()).ok, false);
  // Scheduled for later: still open.
  setPlansStart(Date.now() + DAY);
  forgetAccess();
  st = await nova.status();
  assert.equal(st.access.kind, 'open');
  // A plan bought before plans begin counts as soon as it is bought.
  const { transactionId } = await nova.buy('lifetime');
  assert.equal((await nova.billing({ action: 'sync', transactionId })).access.kind, 'lifetime');
  setPlansStart(BEGUN);
});

test('a plan can be bought during the free week, at once, without waiting for the week to end', async () => {
  const { person, deliver } = setup();
  const rae = await person('rae@example.com');
  assert.equal((await rae.status()).access.kind, 'trial');
  // Monthly: charged now, the plan starts now.
  const { transactionId, events } = await rae.buy('monthly');
  await deliver(events);
  let st = await rae.billing({ action: 'sync', transactionId });
  assert.equal(st.access.kind, 'monthly');
  assert.ok(st.monthly);
  // And the other plans too, for someone else in their free week.
  const sol = await person('sol@example.com');
  const bought = await sol.buy('lifetime');
  await deliver(bought.events);
  st = await sol.billing({ action: 'sync', transactionId: bought.transactionId });
  assert.equal(st.access.kind, 'lifetime');
});

test('people from before plans began, and admins, keep using it free', async () => {
  const { db, person } = setup();
  const early = await person('early@example.com', { created: '2026-03-02T09:15:00.000000' });
  const st = await early.status();
  assert.equal(st.access.kind, 'early');
  assert.equal(st.access.trialEnds, null);
  assert.equal((await db.Account.filter({ user_id: early.id })).length, 0, 'no free week to keep');
  await early.gate('create');
  assert.equal((await early.actor()).kind, 'early');
  // The last moment before plans, and the first moment after.
  assert.equal((await (await person('last@example.com', { created: '2026-11-15T11:29:59.999000' })).status()).access.kind, 'early');
  assert.equal((await (await person('first@example.com', { created: '2026-11-15T11:30:00.000000' })).status()).access.kind, 'trial');
  const admin = await person('admin@example.com', { role: 'admin' });
  assert.equal((await admin.status()).access.kind, 'admin');
  await admin.gate('create');
  // An account whose age is unknown is let in rather than locked out.
  assert.equal(accessOf({ user: { id: 'x', created: null }, now: Date.now() }).kind, 'early');
  // Someone from before plans cannot buy what they already have for good, but can buy a group.
  await assert.rejects(early.billing({ action: 'checkout', plan: 'monthly' }), refused(409, /for good/));
  await assert.rejects(early.billing({ action: 'checkout', plan: 'lifetime' }), refused(409, /for good/));
  assert.match((await early.billing({ action: 'checkout', plan: 'group' })).transactionId, /^txn_/);
});

test('monthly: paid, renewed, cancelled at the end of the month, resumed, ended', async () => {
  const { db, fp, prices, person, deliver } = setup();
  const mina = await person('Mina@Example.com'.toLowerCase());
  await mina.endTrial();
  assert.equal((await mina.status()).sale.sandbox, true);
  const { transactionId } = await mina.billing({ action: 'checkout', plan: 'monthly' });
  const txn = fp.transactions.get(transactionId);
  assert.equal(txn.items[0].price.id, prices.monthly.id);
  assert.deepEqual(txn.custom_data, { user_id: mina.id, plan: 'monthly' });
  assert.equal(fp.customers.get(txn.customer_id).email, 'mina@example.com');

  // Checkout open, nothing paid yet: nothing to record.
  assert.equal((await mina.billing({ action: 'sync', transactionId })).pending, true);
  // Paid, but Paddle is still making the subscription.
  const paid = fp.pay(transactionId, { upTo: 'paid' });
  const mid = await mina.billing({ action: 'sync', transactionId });
  assert.equal(mid.pending, true);
  assert.equal(mid.access.kind, 'none');
  const rest = fp.pay(transactionId);
  const done = await mina.billing({ action: 'sync', transactionId });
  assert.equal(done.pending, false);
  assert.equal(done.access.kind, 'monthly');
  const sub = [...fp.subscriptions.values()][0];
  assert.equal(done.access.until, sub.current_billing_period.ends_at);
  assert.equal(done.monthly.status, 'active');
  assert.equal(done.monthly.cancelAt, null);
  // Paddle's events, each twice, in any order, after the sync: still one record, still active.
  await deliver(shuffled([...paid, ...rest, ...paid, ...rest]));
  const records = await db.Purchase.filter({ user_id: mina.id });
  assert.equal(records.length, 1);
  assert.equal(records[0].paddle_id, sub.id);
  assert.equal(records[0].status, 'active');
  await mina.gate('create');
  assert.equal((await mina.actor()).kind, 'monthly');
  await assert.rejects(mina.billing({ action: 'checkout', plan: 'monthly' }), refused(409, /already have the monthly/));

  // A month later it renews.
  await deliver(fp.renew(sub.id));
  assert.equal((await mina.status()).access.until, fp.subscriptions.get(sub.id).current_billing_period.ends_at);

  // Cancelled: it runs to the end of the month paid for.
  const cancelled = await mina.billing({ action: 'cancel' });
  assert.equal(cancelled.access.kind, 'monthly');
  assert.equal(cancelled.monthly.cancelAt, fp.subscriptions.get(sub.id).current_billing_period.ends_at);
  const cancelEvents = fp.takeEvents();
  // Changed their mind.
  const resumed = await mina.billing({ action: 'resume' });
  assert.equal(resumed.monthly.cancelAt, null);
  const resumeEvents = fp.takeEvents();
  // The cancellation's event arriving after the resume's is old news.
  await deliver([...resumeEvents, ...cancelEvents]);
  assert.equal((await mina.status()).monthly.cancelAt, null);

  await mina.billing({ action: 'cancel' });
  await deliver(fp.takeEvents());
  const ended = fp.renew(sub.id);
  await deliver(ended);
  const st = await mina.status();
  assert.equal(st.access.kind, 'none');
  assert.equal(st.monthly, null);
  await assert.rejects(mina.gate('create'), (e) => e.status === 402);
  // An older "active" arriving now changes nothing.
  const stale = structuredClone(cancelEvents[0]);
  stale.data.status = 'active';
  stale.data.updated_at = new Date(Date.parse(fp.subscriptions.get(sub.id).updated_at) - 60_000).toISOString();
  await deliver([stale]);
  assert.equal((await mina.status()).access.kind, 'none');
  // And they can subscribe again.
  assert.match((await mina.billing({ action: 'checkout', plan: 'monthly' })).transactionId, /^txn_/);
});

test('monthly: a failed renewal keeps the plan while Paddle retries; giving up ends it', async () => {
  const { fp, person, deliver } = setup();
  const joon = await person('joon@example.com');
  await joon.endTrial();
  const { events } = await joon.buy('monthly');
  await deliver(events);
  const sub = [...fp.subscriptions.values()][0];
  await deliver(fp.failRenewal(sub.id));
  const st = await joon.status();
  assert.equal(st.access.kind, 'monthly');
  assert.equal(st.monthly.status, 'past_due');
  await deliver(fp.failRenewal(sub.id, { giveUp: true }));
  assert.equal((await joon.status()).access.kind, 'none');
});

test('monthly: a monthly payment refunded in full cancels the plan at once; a partial refund does not', async () => {
  const { fp, person, deliver } = setup();
  const joon = await person('joon@example.com');
  await joon.endTrial();
  await deliver((await joon.buy('monthly')).events);
  const sub = [...fp.subscriptions.values()][0];
  const payment = [...fp.transactions.values()].find((t) => t.subscription_id === sub.id);
  await deliver(fp.refund(payment.id, { type: 'partial' }));
  assert.equal((await joon.status()).access.kind, 'monthly');
  const refund = fp.refund(payment.id);
  await deliver(refund);
  assert.equal(fp.subscriptions.get(sub.id).status, 'canceled');
  await deliver(fp.takeEvents());
  assert.equal((await joon.status()).access.kind, 'none');
  // The same event again: nothing more to do, and no failure (Paddle would send it again and again).
  await deliver(refund);
});

test('monthly: a missed webhook is caught up when the person opens the site', async () => {
  const { db, fp, person, deliver } = setup();
  const sora = await person('sora@example.com');
  await sora.endTrial();
  const { events } = await sora.buy('monthly');
  await deliver(events);
  const sub = [...fp.subscriptions.values()][0];
  // Paddle cancelled it, and its webhook never came; the record still says active, a month ago.
  fp.failRenewal(sub.id, { giveUp: true });
  const [p] = await db.Purchase.filter({ user_id: sora.id });
  await db.Purchase.update(p.id, { ends_at: new Date(Date.now() - 2 * DAY).toISOString() });
  forgetAccess();
  assert.equal((await sora.actor()).kind, 'monthly', 'the actors go by the record');
  const st = await sora.status();
  assert.equal(st.access.kind, 'none');
  assert.equal((await db.Purchase.get(p.id)).status, 'canceled');
});

test('lifetime: bought once; a running monthly plan stops at its end; refunds and chargebacks take it away', async () => {
  const { db, fp, person, deliver } = setup();
  const mina = await person('mina@example.com');
  await mina.endTrial();
  await deliver((await mina.buy('monthly')).events);
  const sub = [...fp.subscriptions.values()][0];
  const { transactionId, events } = await mina.buy('lifetime');
  await deliver(events);
  await deliver(fp.takeEvents());
  let st = await mina.status();
  assert.equal(st.access.kind, 'lifetime');
  assert.equal(st.lifetime, true);
  assert.equal(fp.subscriptions.get(sub.id).scheduled_change?.action, 'cancel', 'the monthly plan is cancelled');
  assert.equal(st.monthly.cancelAt, fp.subscriptions.get(sub.id).current_billing_period.ends_at);
  await assert.rejects(mina.billing({ action: 'checkout', plan: 'lifetime' }), refused(409));
  await assert.rejects(mina.billing({ action: 'checkout', plan: 'monthly' }), refused(409));
  // A partial refund leaves the plan; a refund waiting for approval too.
  await deliver(fp.refund(transactionId, { type: 'partial' }));
  assert.equal((await mina.status()).access.kind, 'lifetime');
  const full = fp.refund(transactionId);
  await deliver([full[0]]);
  assert.equal((await mina.status()).access.kind, 'lifetime');
  await deliver([full[1]]);
  st = await mina.status();
  assert.equal(st.lifetime, false);
  assert.equal(st.access.kind, 'monthly', 'left with the monthly plan until it ends');
  // A late duplicate of the purchase does not give it back.
  await deliver(events);
  assert.equal((await mina.status()).lifetime, false);
  assert.equal((await db.Purchase.filter({ paddle_id: transactionId })).length, 1);

  // A chargeback takes it away; reversed, it comes back.
  const joon = await person('joon@example.com');
  await joon.endTrial();
  const bought = await joon.buy('lifetime');
  await deliver(bought.events);
  await deliver(fp.chargeback(bought.transactionId));
  assert.equal((await joon.status()).access.kind, 'none');
  await deliver(fp.chargeback(bought.transactionId, { reverse: true }));
  assert.equal((await joon.status()).access.kind, 'lifetime');

  // Refunded before its purchase was heard of: never given.
  const sora = await person('sora@example.com');
  await sora.endTrial();
  const quick = await sora.buy('lifetime');
  await deliver(fp.refund(quick.transactionId));
  await deliver(quick.events);
  assert.equal((await sora.status()).access.kind, 'none');
});

test('openrocket: OpenRocket only once the free week is over, not the Launch Planner or the Logbook', async () => {
  const { fp, person, deliver } = setup();
  const upgrade = (e) => e instanceof BillingError && e.status === 402 && e.code === 'plan_upgrade';
  const mina = await person('mina@example.com');
  // Bought during the free week: everything until the week ends.
  await deliver((await mina.buy('openrocket')).events);
  let st = await mina.status();
  assert.equal(st.access.kind, 'trial');
  assert.equal(st.access.full, true);
  assert.equal(st.openrocket, true);
  await mina.gateFull('create');
  await mina.endTrial();
  st = await mina.status();
  assert.equal(st.access.kind, 'openrocket');
  assert.deepEqual([st.access.ok, st.access.full], [true, false]);
  await mina.gate('create'); // designs (OpenRocket)
  await assert.rejects(mina.gateFull('create'), upgrade);
  await assert.rejects(mina.gateFull('create'), upgrade, 'refused again, not let through by the cache');
  await mina.gateFull('list'); // their launch plans and logbooks stay theirs to see and delete
  const seen = await mina.actor();
  assert.deepEqual([seen.ok, seen.full], [true, false], 'the design room lets them in; the Forecasts actor does not');
  await assert.rejects(mina.billing({ action: 'checkout', plan: 'openrocket' }), refused(409));
  // A plan with everything: at once, the cache does not keep them out.
  await deliver((await mina.buy('lifetime')).events);
  st = await mina.status();
  assert.equal(st.access.kind, 'lifetime');
  assert.equal(st.access.full, true);
  await mina.gateFull('create');
  await assert.rejects(mina.billing({ action: 'checkout', plan: 'openrocket' }), refused(409, /already includes OpenRocket/));

  // Not for someone whose plan already includes it.
  const sora = await person('sora@example.com');
  await sora.endTrial();
  await deliver((await sora.buy('monthly')).events);
  await assert.rejects(sora.billing({ action: 'checkout', plan: 'openrocket' }), refused(409, /already includes OpenRocket/));

  // Refunded: gone.
  const joon = await person('joon@example.com');
  await joon.endTrial();
  const bought = await joon.buy('openrocket');
  await deliver(bought.events);
  assert.equal((await joon.status()).access.kind, 'openrocket');
  await deliver(fp.refund(bought.transactionId));
  st = await joon.status();
  assert.deepEqual([st.access.kind, st.openrocket], ['none', false]);
});

test('group: the buyer names 9 people, with or without accounts; more places; changes; refunds', async () => {
  const { db, s, fp, person, deliver } = setup();
  const teacher = await person('teacher@school.org', { name: 'Ms Park' });
  await teacher.endTrial();
  const lapsed = await person('lapsed@gmail.com');
  await lapsed.status();
  await lapsed.endTrial();
  await assert.rejects(teacher.billing({ action: 'checkout', plan: 'seat', quantity: 1 }), refused(409, /group plan first/));
  await assert.rejects(teacher.billing({ action: 'members', members: [] }), refused(403));
  const group = await teacher.buy('group');
  await deliver(group.events);
  let st = await teacher.status();
  assert.equal(st.access.kind, 'group');
  assert.deepEqual(st.group, { seats: GROUP_SIZE, members: [] });
  await assert.rejects(teacher.billing({ action: 'checkout', plan: 'group' }), refused(409, /Add places/));

  // Nine people: one with an account already, the rest not yet; the buyer's own address and a
  // repeat are dropped.
  const nine = ['Lapsed@Gmail.com', ...Array.from({ length: 8 }, (_, i) => `student${i + 1}@gmail.com`)];
  st = await teacher.billing({ action: 'members', members: [...nine, 'TEACHER@school.org', ' student1@gmail.com '] });
  assert.equal(st.group.members.length, 9);
  assert.ok(st.group.members.every((m) => m.admitted));
  assert.equal(st.group.members[0].email, 'lapsed@gmail.com');
  await assert.rejects(teacher.billing({ action: 'members', members: [...nine, 'tenth@gmail.com'] }), refused(400, /room for 9 people/));
  await assert.rejects(teacher.billing({ action: 'members', members: ['not an address'] }), refused(400, /not an email/));
  forgetAccess();
  assert.equal((await lapsed.actor()).kind, 'group', 'the room knows them by user id');
  await lapsed.gate('create');
  const ls = await lapsed.status();
  assert.deepEqual(ls.memberOf, [{ owner_name: 'Ms Park', owner_email: 'teacher@school.org' }]);
  // A student signs up later, after their own week ends: let in when the site first sees them.
  const student = await person('student3@gmail.com');
  await student.status();
  await student.endTrial();
  assert.equal((await student.status()).access.kind, 'group');
  assert.equal((await student.actor()).kind, 'group');
  // Someone else cannot change the group.
  await assert.rejects(student.billing({ action: 'members', members: [] }), refused(403));

  // Two more places.
  await assert.rejects(teacher.billing({ action: 'checkout', plan: 'seat', quantity: 0 }), refused(400));
  await assert.rejects(teacher.billing({ action: 'checkout', plan: 'seat', quantity: 101 }), refused(400));
  await assert.rejects(teacher.billing({ action: 'checkout', plan: 'seat', quantity: 1.5 }), refused(400));
  const seats = await teacher.buy('seat', { quantity: 2 });
  await deliver(seats.events);
  assert.equal((await teacher.status()).group.seats, 12);
  st = await teacher.billing({ action: 'members', members: [...nine, 'extra1@gmail.com', 'extra2@gmail.com'] });
  assert.equal(st.group.members.length, 11);
  await assert.rejects(teacher.billing({ action: 'members', members: [...nine, 'extra1@gmail.com', 'extra2@gmail.com', 'extra3@gmail.com'] }), refused(400, /room for 11/));
  const extra2 = await person('extra2@gmail.com');
  await extra2.status();
  await extra2.endTrial();
  assert.equal((await extra2.status()).access.kind, 'group');

  // Taken off the list: out.
  st = await teacher.billing({ action: 'members', members: nine.slice(1).concat(['extra1@gmail.com', 'extra2@gmail.com']) });
  forgetAccess();
  assert.equal((await lapsed.actor()).kind, 'none');
  assert.equal((await lapsed.status()).access.kind, 'none');
  await assert.rejects(lapsed.gate('create'), (e) => e.status === 402);
  st = await teacher.billing({ action: 'members', members: nine.concat(['extra1@gmail.com', 'extra2@gmail.com']) });

  // The extra places refunded: the last two on the list have no place, but stay on the list.
  await deliver(fp.refund(seats.transactionId));
  st = await teacher.status();
  assert.equal(st.group.seats, 10);
  assert.deepEqual(st.group.members.map((m) => m.admitted), [...Array(9).fill(true), false, false]);
  assert.equal((await extra2.actor()).kind, 'none');
  assert.equal((await extra2.status()).access.kind, 'none');
  // The buyer can take people off (the list shrinking), not put anyone new on.
  st = await teacher.billing({ action: 'members', members: nine.concat(['extra2@gmail.com']) });
  assert.equal(st.group.members.length, 10);
  await assert.rejects(teacher.billing({ action: 'members', members: nine.slice(1).concat(['extra2@gmail.com', 'new@gmail.com']) }), refused(400));

  // The group plan refunded: nobody is in by it, the buyer included.
  await deliver(fp.refund(group.transactionId));
  assert.equal((await teacher.status()).access.kind, 'none');
  assert.equal((await student.status()).access.kind, 'none');
  assert.equal((await student.actor()).kind, 'none');

  // The group's record holds nobody's address in the clear.
  const [g] = await db.Group.filter({ owner_id: teacher.id });
  const raw = JSON.stringify(g);
  assert.ok(!/@/.test(raw), raw);
  assert.equal((await s.open(g.sealed)).owner_email, 'teacher@school.org');
  for (const r of [...db.Purchase.rows.values(), ...db.Account.rows.values()]) assert.ok(!/@/.test(JSON.stringify(r)));
});

test('checkout: plans, quantities, Paddle customers, and Paddle failing', async () => {
  const { fp, person } = setup();
  const nova = await person('nova@example.com');
  await assert.rejects(nova.billing({ action: 'checkout', plan: 'gold' }), refused(400, /Choose a plan/));
  await assert.rejects(nova.billing({ action: 'checkout' }), refused(400));
  // The same Paddle customer for every purchase; one Paddle already had with their address is used.
  fp.customers.set('ctm_existing0000000000000000000', { id: 'ctm_existing0000000000000000000', email: 'old@example.com' });
  const old = await person('old@example.com');
  const a = await old.billing({ action: 'checkout', plan: 'lifetime' });
  const b = await old.billing({ action: 'checkout', plan: 'monthly' });
  assert.equal(fp.transactions.get(a.transactionId).customer_id, 'ctm_existing0000000000000000000');
  assert.equal(fp.transactions.get(b.transactionId).customer_id, 'ctm_existing0000000000000000000');
  assert.equal(a.token, 'test_0123456789abcdef0123456');
  assert.equal(a.sandbox, true);
  // Paddle down: tried three times, then a message saying what to do.
  fp.down = true;
  const before = fp.calls.length;
  await assert.rejects(nova.billing({ action: 'checkout', plan: 'lifetime' }), refused(502, /try again/));
  assert.ok(fp.calls.length === before, 'a 503 is answered before reaching the fake');
  fp.down = false;
  // A plan missing in Paddle.
  [...fp.prices.values()].find((p) => p.custom_data.plan === 'lifetime').status = 'archived';
  const fresh = setup();
  const p2 = await fresh.person('p2@example.com');
  [...fresh.fp.prices.values()].find((p) => p.custom_data.plan === 'lifetime').status = 'archived';
  await assert.rejects(p2.billing({ action: 'checkout', plan: 'lifetime' }), refused(503, /not on sale/));
});

test('payments not set up: the site works, with no checkout', async () => {
  const { person } = setup({ payments: false });
  const nova = await person('nova@example.com');
  const st = await nova.status();
  assert.equal(st.sale, null);
  assert.equal(st.access.kind, 'trial');
  await assert.rejects(nova.billing({ action: 'checkout', plan: 'monthly' }), refused(503, /not set up/));
  await assert.rejects(nova.billing({ action: 'portal' }), refused(503));
});

test('sync, portal and cancel only for what is theirs', async () => {
  const { fp, person, deliver } = setup();
  const mina = await person('mina@example.com');
  const joon = await person('joon@example.com');
  await assert.rejects(mina.billing({ action: 'portal' }), refused(404));
  await assert.rejects(mina.billing({ action: 'cancel' }), refused(404, /no monthly plan/));
  const { transactionId, events } = await mina.buy('monthly');
  await deliver(events);
  await assert.rejects(joon.billing({ action: 'sync', transactionId }), refused(404));
  await assert.rejects(joon.billing({ action: 'sync', transactionId: 'txn_../../customers' }), refused(400));
  assert.equal((await joon.status()).access.kind, 'trial');
  const { url } = await mina.billing({ action: 'portal' });
  assert.match(url, /^https:\/\/sandbox-customer-portal\.paddle\.com\//);
  assert.deepEqual(fp.calls.at(-1).body, { subscription_ids: [[...fp.subscriptions.keys()][0]] });
  await assert.rejects(mina.billing({ action: 'nonsense' }), refused(400));
});

test('webhook: only Paddle\'s signature, recent; replays and unknown events change nothing', async () => {
  const { db, s, paddle, fp, person } = setup();
  const mina = await person('mina@example.com');
  await mina.status();
  await mina.endTrial();
  const { events } = await mina.buy('lifetime');
  const body = JSON.stringify(events.at(-1));
  const ctx = () => ({ db, s, paddle });
  const send = async (signature, { secret = SECRET, text = body } = {}) => (await receiveWebhook({ secret, signature, body: text, ctx })).status;
  assert.equal(await send(null), 401);
  assert.equal(await send('garbage'), 401);
  assert.equal(await send(await signBody('another secret', body)), 401);
  assert.equal(await send(await signBody(SECRET, body), { text: body.replace('lifetime', 'lifetimf') }), 401);
  assert.equal(await send(await signBody(SECRET, body, Date.now() - 10 * 60_000)), 401, 'too old');
  assert.equal(await send(await signBody(SECRET, body, Date.now() + 10 * 60_000)), 401, 'from the future');
  assert.equal(await send(await signBody(SECRET, body), { secret: '' }), 503);
  assert.equal(await send(await signBody(SECRET, 'not json'), { text: 'not json' }), 400);
  assert.equal((await mina.status()).access.kind, 'none');
  // While Paddle rotates secrets, more than one signature; one is enough.
  const good = await signBody(SECRET, body);
  const [, h1] = good.split(';');
  assert.equal(await send(`${good.split(';')[0]};h1=${'0'.repeat(64)};${h1}`), 200);
  assert.equal(await send(good), 200);
  forgetAccess();
  assert.equal((await mina.status()).access.kind, 'lifetime');
  assert.equal(await verifySignature(SECRET, good, body), true);
  // Events we do not use are taken and ignored.
  const other = JSON.stringify({ event_type: 'customer.created', data: { id: 'ctm_x' } });
  assert.equal(await send(await signBody(SECRET, other), { text: other }), 200);
  // A failure while applying it: 500, so that Paddle sends it again.
  const filter = db.Purchase.filter;
  db.Purchase.filter = async () => { throw new Error('Base44 is busy'); };
  assert.equal(await send(await signBody(SECRET, body)), 500);
  db.Purchase.filter = filter;
  assert.equal(fp.calls.filter((c) => c.method === 'POST').length > 0, true);
});

test('webhook: a purchase made outside the site is matched to its buyer by their Paddle customer or address', async () => {
  const { db, fp, prices, person, deliver } = setup();
  const mina = await person('mina@example.com');
  await mina.status();
  await mina.endTrial();
  // Bought through a Paddle link with Mina's address, no custom data.
  const ctm = { id: 'ctm_link00000000000000000000000', email: 'mina@example.com' };
  fp.customers.set(ctm.id, ctm);
  const t = { id: 'txn_link00000000000000000000000', status: 'draft', customer_id: ctm.id, custom_data: null, items: [{ price: prices.lifetime, quantity: 1 }], subscription_id: null };
  fp.transactions.set(t.id, t);
  await deliver(fp.pay(t.id));
  assert.equal((await mina.status()).access.kind, 'lifetime');
  // And by the customer id once known (Account.customer).
  const joon = await person('joon@example.com');
  await joon.status();
  await joon.endTrial();
  await joon.billing({ action: 'checkout', plan: 'monthly' });
  const [acct] = await db.Account.filter({ user_id: joon.id });
  const t2 = { id: 'txn_link10000000000000000000000', status: 'draft', customer_id: acct.customer, custom_data: null, items: [{ price: prices.lifetime, quantity: 1 }], subscription_id: null };
  fp.transactions.set(t2.id, t2);
  await deliver(fp.pay(t2.id));
  assert.equal((await joon.status()).access.kind, 'lifetime');
  // Nobody we know: ignored, no record.
  const stranger = { id: 'ctm_stranger000000000000000000', email: 'stranger@example.com' };
  fp.customers.set(stranger.id, stranger);
  const t3 = { id: 'txn_link20000000000000000000000', status: 'draft', customer_id: stranger.id, custom_data: null, items: [{ price: prices.lifetime, quantity: 1 }], subscription_id: null };
  fp.transactions.set(t3.id, t3);
  const n = db.Purchase.rows.size;
  await deliver(fp.pay(t3.id));
  assert.equal(db.Purchase.rows.size, n);
});

test('scripts/paddle-setup.mjs makes the product, prices, payment link, webhook and token once', async () => {
  forgetPrices();
  const fp = fakePaddle();
  const lines = [];
  const run = () => setUpPaddle({ apiKey: KEY, site: 'https://rocketincloud.com/', fetch: fp.fetch, log: (l) => lines.push(l) });
  const first = await run();
  assert.equal(first.sandbox, true);
  assert.deepEqual(Object.fromEntries(Object.entries(first.prices).map(([k, p]) => [k, [p.unit_price.amount, p.unit_price.currency_code, p.billing_cycle?.interval ?? null, p.quantity.maximum, p.tax_mode]])), {
    monthly: ['100', 'USD', 'month', 1, 'external'],
    lifetime: ['500', 'USD', null, 1, 'external'],
    group: ['1000', 'USD', null, 1, 'external'],
    seat: ['300', 'USD', null, 100, 'external'],
    openrocket: ['100', 'USD', null, 1, 'external'],
  });
  assert.equal(fp.settings.default_url, 'https://rocketincloud.com/account.html');
  const [hook] = fp.notifications.values();
  assert.equal(hook.destination, 'https://rocketincloud.com/functions/paddleWebhook');
  assert.deepEqual(hook.subscribed_events, EVENTS);
  assert.match(first.secret, /^pdl_ntfset_/);
  assert.match(first.clientToken, /^test_/);
  const again = await run();
  assert.equal(again.product.id, first.product.id);
  assert.deepEqual(Object.values(again.prices).map((p) => p.id), Object.values(first.prices).map((p) => p.id));
  assert.equal(again.secret, null, 'the webhook is not made twice');
  assert.equal(fp.notifications.size, 1);
  assert.ok(lines.some((l) => /already there/.test(l)));
  // A price changed in billing.js is changed in Paddle, keeping its id.
  fp.prices.get(first.prices.lifetime.id).unit_price = { amount: '400', currency_code: 'USD' };
  const changed = await run();
  assert.equal(changed.prices.lifetime.id, first.prices.lifetime.id);
  assert.equal(fp.prices.get(first.prices.lifetime.id).unit_price.amount, '500');
  assert.ok(lines.some((l) => /Price lifetime: .*changed from 400 USD cents to US\$5/.test(l)));
  // Live keys go to Paddle's live API.
  await assert.rejects(setUpPaddle({ apiKey: 'nonsense', site: 'https://x.test', fetch: fp.fetch, log: () => {} }), /PADDLE_API_KEY/);
});
