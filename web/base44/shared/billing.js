// Plans and payments: who may use Rocket in Cloud, and the purchases behind it.
//
// Everyone gets a free week from the first time they open the site signed in. People who joined
// before plans began (FREE_BEFORE) and the app's admins keep using it free. After the week,
// someone needs one of these plans (prices in US dollars, set in Paddle by scripts/paddle-setup.mjs):
//   monthly    US$1 a month, a Paddle subscription they can cancel at any time
//   lifetime   US$5 once, for one person, for good
//   openrocket US$1 once, for one person, for good: OpenRocket only (the design page, its sharing
//              and live co-editing), not the Launch Planner or the Logbook
//   group      US$10 once, for the buyer and 9 people they name by their Google address
//   seat       US$3 once each: one more person in the buyer's group
// Paddle (paddle.com) sells the plans as merchant of record: its checkout takes the payment and
// the buyer's VAT or sales tax, in their currency, and tells the paddleWebhook function about
// payments, renewals, cancellations and refunds. The records, all closed to browsers:
//   Account   per person: when their free week started, and their Paddle customer id
//   Purchase  per Paddle subscription (monthly) or transaction (the one-time plans)
//   Group     per group buyer: its places, its members (addresses sealed), and the members it lets
//             in, by keyed fingerprint (for the functions) and by Base44 user id (for the
//             actors, which cannot make fingerprints: Base44 gives them no app secrets)
//
// Plain JavaScript: the functions import it from here, the DesignRoom and Forecasts actors get a
// copy (scripts/prebuild.mjs), and test/billing.test.mjs runs it in Node.

/** People whose account is older than this use Rocket in Cloud free, for good. */
export const FREE_BEFORE = Date.parse('2026-11-15T11:30:00Z');
/**
 * When plans begin (an ISO time), or null: until then nobody needs a plan, and nobody's free week
 * runs out (it counts from this time at the earliest). Set it once Paddle's live account takes
 * payments (README: Plans and payments), and deploy.
 */
export const PLANS_START = null;
let plansStart = PLANS_START ? Date.parse(PLANS_START) : null;

/** For tests: plans begin at `ms` (null: not yet). */
export function setPlansStart(ms) {
  plansStart = ms;
}
export const TRIAL_MS = 7 * 24 * 3600_000;
/** People in a group plan, the buyer included; more places are bought one at a time. */
export const GROUP_SIZE = 10;
export const MAX_PLACES = 1000;
export const MAX_EXTRA_AT_ONCE = 100;
/** Prices as the site shows them (Paddle charges what scripts/paddle-setup.mjs set there). */
export const PRICES = { monthly: 1, lifetime: 5, group: 10, seat: 3, openrocket: 1 };
export const PLAN_REQUIRED = 'plan_required';
/**
 * What each function still does for someone without a plan: see their work, download their
 * designs (their listing, then the room), leave what was shared with them, and delete their work.
 */
export const OPEN_ACTIONS = {
  designs: ['list', 'get', 'leave', 'delete', 'preview'],
  motors: ['list', 'delete'],
  flights: ['list', 'delete'],
  logbooks: ['list', 'leave', 'delete'],
};
export const PLAN_MESSAGE = 'Your free week has ended. Choose a plan to keep using Rocket in Cloud.';
/** For someone whose plan is OpenRocket only, asking for the Launch Planner or the Logbook. */
export const PLAN_UPGRADE = 'plan_upgrade';
export const UPGRADE_MESSAGE = 'Your OpenRocket plan covers designing in OpenRocket. The Launch Planner and the Logbook come with the Monthly, Individual and Group plans.';

const PLANS = new Set(['monthly', 'lifetime', 'group', 'seat', 'openrocket']);
const ONE_TIME = new Set(['lifetime', 'group', 'seat', 'openrocket']);
/** Subscription states that keep a monthly plan going (past_due: Paddle is retrying the payment). */
const LIVE = new Set(['active', 'trialing', 'past_due']);
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
/** How far a webhook's signing time may be from now. */
const SIGNATURE_TOLERANCE_S = 300;

export class BillingError extends Error {
  constructor(status, message, code = null) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const fail = (status, message, code) => {
  throw new BillingError(status, message, code);
};

/** A time as milliseconds: Base44 writes UTC times without a zone ("2026-11-15T11:30:00.123000"). */
export function when(v) {
  if (v == null || v === '') return NaN;
  if (typeof v === 'number') return v;
  const s = String(v);
  return Date.parse(/(?:[zZ]|[+-]\d\d:?\d\d)$/.test(s) ? s : `${s}Z`);
}

/** Whether time `a` is before time `b`, to the nanosecond Paddle gives ("…T13:30:06.540543605Z"). */
export function isBefore(a, b) {
  const d = when(a) - when(b);
  if (d) return d < 0;
  const frac = (t) => (String(t).match(/\.(\d+)/)?.[1] ?? '').padEnd(9, '0').slice(0, 9);
  return frac(a) < frac(b);
}

const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
const oldest = (list) => list.slice().sort((a, b) => (when(a.created_date) - when(b.created_date)) || String(a.id).localeCompare(String(b.id)))[0] ?? null;

// ------------------------------------------------------------------ who may use it

/**
 * 'admin' or 'early' for someone who uses the site free, for good; else null. `user` is
 * { id, created (their Base44 account's created_date), role }. An account of unknown age counts as
 * early: better to let someone in free than to lock out one of the people from before plans.
 */
export function freeKind(user) {
  if (user?.role === 'admin') return 'admin';
  const t = when(user?.created);
  return Number.isNaN(t) || t < FREE_BEFORE ? 'early' : null;
}

/**
 * What someone may do, from their records: { ok, full, kind, until, trialEnds, groupId, openrocket },
 * kind being 'admin' | 'early' | 'lifetime' | 'group' | 'monthly' | 'open' (plans have not begun) |
 * 'trial' | 'openrocket' (OpenRocket only, after their free week) | 'none' (the best they have).
 * `ok`: they may use the site; `full`: the Launch Planner and the Logbook too.
 * `groups` are the Group records they are in, as owner or as a member let in.
 */
export function accessOf({ user, account = null, purchases = [], groups = [], now = Date.now() }) {
  const free = freeKind(user);
  let start = when(account?.trial_started);
  if (Number.isNaN(start)) start = when(user?.created);
  if (Number.isNaN(start)) start = now;
  // Nobody's free week counts from before plans began.
  if (plansStart != null) start = Math.max(start, plansStart);
  const begun = plansStart != null && now >= plansStart;
  const trialEnds = plansStart == null ? null : start + TRIAL_MS;
  const lifetime = purchases.some((p) => p.kind === 'lifetime' && p.status === 'completed');
  const group = groups.find((g) => (Number(g.seats) || 0) > 0
    && (g.owner_id === user.id || (g.access ?? []).includes(user.id))) ?? null;
  const monthly = purchases.filter((p) => p.kind === 'monthly' && LIVE.has(p.status))
    .sort((a, b) => (when(b.ends_at) || 0) - (when(a.ends_at) || 0))[0] ?? null;
  const openrocket = purchases.some((p) => p.kind === 'openrocket' && p.status === 'completed');
  // The OpenRocket plan counts once their free week (everything) is over.
  const kind = free ?? (lifetime ? 'lifetime' : group ? 'group' : monthly ? 'monthly' : !begun ? 'open' : now < trialEnds ? 'trial' : openrocket ? 'openrocket' : 'none');
  return {
    ok: kind !== 'none',
    full: kind !== 'none' && kind !== 'openrocket',
    openrocket,
    kind,
    until: kind === 'monthly' ? (when(monthly.ends_at) || null) : kind === 'trial' ? trialEnds : null,
    trialEnds: free ? null : trialEnds,
    groupId: kind === 'group' ? group.id : null,
  };
}

/**
 * Someone's records and what they may do: { access, account, purchases, groups }. With `key` (the
 * fingerprint of their address, which only the functions can make), groups that name them but do
 * not know their user id yet (named before they had an account) learn it here, so that the actors
 * know them too.
 */
export async function loadAccess(db, user, { key = null, now = Date.now() } = {}) {
  const [accounts, purchases, owned, joined, named] = await Promise.all([
    db.Account.filter({ user_id: user.id }),
    db.Purchase.filter({ user_id: user.id }),
    db.Group.filter({ owner_id: user.id }),
    db.Group.filter({ access: user.id }),
    key ? db.Group.filter({ people: key }) : [],
  ]);
  const groups = new Map();
  for (const g of owned) if (g.owner_id === user.id) groups.set(g.id, g);
  for (const g of joined) if ((g.access ?? []).includes(user.id)) groups.set(g.id, g);
  for (const g of named) {
    if (!(g.people ?? []).includes(key) || groups.has(g.id)) continue;
    const access = [...(g.access ?? []), user.id];
    await db.Group.update(g.id, { access });
    groups.set(g.id, { ...g, access });
  }
  const mine = purchases.filter((p) => p.user_id === user.id);
  const account = oldest(accounts.filter((a) => a.user_id === user.id));
  return { access: accessOf({ user, account, purchases: mine, groups: [...groups.values()], now }), account, purchases: mine, groups: [...groups.values()] };
}

/** What someone may do (see accessOf); quick for those who use it free. */
export async function lookAccess(db, user, opts = {}) {
  if (freeKind(user)) return accessOf({ user, now: opts.now });
  return (await loadAccess(db, user, opts)).access;
}

/** Their Account record, made (starting their free week) the first time they are seen. */
export async function ensureAccount(db, user, now = Date.now()) {
  const found = (await db.Account.filter({ user_id: user.id })).filter((a) => a.user_id === user.id);
  if (found.length) return oldest(found);
  await db.Account.create({ user_id: user.id, trial_started: iso(now) });
  // Two first visits at once (two tabs) make two; the older one is kept.
  const all = (await db.Account.filter({ user_id: user.id })).filter((a) => a.user_id === user.id);
  const keep = oldest(all);
  for (const a of all) if (a.id !== keep.id) await db.Account.delete(a.id).catch(() => {});
  return keep;
}

// ------------------------------------------------------------------ Paddle's API

export class PaddleError extends Error {
  constructor(status, code, detail) {
    super(detail || code || `Paddle answered ${status}`);
    this.status = status;
    this.code = code ?? null;
  }
}

/**
 * Paddle's API with `apiKey`: get(path), post(path, body), patch(path, body) resolve with the
 * response's data. Sandbox keys (pdl_sdbx_…) use Paddle's sandbox. Busy or failing answers are
 * tried again twice.
 */
export function paddleApi(apiKey, { sandbox = /^pdl_sdbx_/.test(String(apiKey ?? '')), fetch: fetchFn = globalThis.fetch } = {}) {
  const base = sandbox ? 'https://sandbox-api.paddle.com' : 'https://api.paddle.com';
  const call = async (method, path, body) => {
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await fetchFn(base + path, {
          method,
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Paddle-Version': '1' },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (e) {
        if (attempt < 2) {
          await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
          continue;
        }
        throw new PaddleError(0, 'unreachable', e instanceof Error ? e.message : String(e));
      }
      if ((res.status === 429 || res.status >= 500) && attempt < 2) {
        await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
        continue;
      }
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new PaddleError(res.status, j?.error?.code, j?.error?.detail);
      return j?.data;
    }
  };
  return {
    sandbox,
    base,
    get: (path) => call('GET', path),
    post: (path, body = {}) => call('POST', path, body),
    patch: (path, body = {}) => call('PATCH', path, body),
  };
}

const priceCache = new Map(); // Paddle's address -> { at, prices }

/** The plans' prices in Paddle, by plan (each price's custom_data.plan), kept for 5 minutes. */
export async function pricesOf(paddle) {
  const kept = priceCache.get(paddle.base);
  if (kept && Date.now() - kept.at < 300_000) return kept.prices;
  const prices = {};
  for (const p of (await paddle.get('/prices?status=active&per_page=200')) ?? []) {
    const plan = p.custom_data?.plan;
    if (PLANS.has(plan) && (!prices[plan] || String(p.created_at) > String(prices[plan].created_at))) prices[plan] = p;
  }
  priceCache.set(paddle.base, { at: Date.now(), prices });
  return prices;
}

export function forgetPrices() {
  priceCache.clear();
}

/** Their Paddle customer id: theirs already, the one with their address, or a new one. */
async function customerFor(db, paddle, me, account) {
  if (account.customer) return account.customer;
  // Archived customers count too: Paddle keeps addresses unique among them as well.
  const find = async () => ((await paddle.get(`/customers?email=${encodeURIComponent(me.email)}&status=active,archived`)) ?? [])
    .find((c) => String(c.email).toLowerCase() === me.email)?.id ?? null;
  let id = await find();
  if (!id) {
    try {
      id = (await paddle.post('/customers', { email: me.email })).id;
    } catch (e) {
      if (e?.code !== 'customer_already_exists') throw e;
      id = (await find()) ?? String(e.message).match(/ctm_[a-z\d]{26}/)?.[0] ?? null;
    }
  }
  if (!id) throw new PaddleError(500, 'no_customer', 'No Paddle customer.');
  await db.Account.update(account.id, { customer: id });
  return id;
}

// ------------------------------------------------------------------ webhooks

const hex = (bytes) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');

/**
 * Whether `header` (Paddle-Signature: "ts=…;h1=…", more than one h1 while Paddle rotates secrets)
 * signs `body` (the request's raw text) with `secret`, at a time within 5 minutes of `now`.
 */
export async function verifySignature(secret, header, body, now = Date.now()) {
  if (!secret || typeof header !== 'string' || typeof body !== 'string') return false;
  let ts = null;
  const sigs = [];
  for (const part of header.split(';')) {
    const [k, ...v] = part.split('=');
    if (k?.trim() === 'ts') ts = v.join('=').trim();
    if (k?.trim() === 'h1') sigs.push(v.join('=').trim().toLowerCase());
  }
  if (!/^\d{1,12}$/.test(ts ?? '') || !sigs.length) return false;
  if (Math.abs(now / 1000 - Number(ts)) > SIGNATURE_TOLERANCE_S) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mine = hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${ts}:${body}`)));
  // Compared in full whatever the first difference, so the time taken says nothing of the signature.
  return sigs.some((s) => {
    if (s.length !== mine.length) return false;
    let d = 0;
    for (let i = 0; i < s.length; i++) d |= s.charCodeAt(i) ^ mine.charCodeAt(i);
    return d === 0;
  });
}

/** Signs `body` as Paddle does (for tests and for trying the webhook by hand). */
export async function signBody(secret, body, now = Date.now()) {
  const ts = Math.floor(now / 1000);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return `ts=${ts};h1=${hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${ts}:${body}`)))}`;
}

/**
 * The paddleWebhook function's answer to a request: { status, json }. `body` is the request's raw
 * text, `signature` its Paddle-Signature header, `ctx()` makes { db, s, paddle } for applying it.
 * Unsigned or wrongly signed requests are refused; a failure answers 500, so Paddle sends the
 * event again later (applying one twice changes nothing).
 */
export async function receiveWebhook({ secret, signature, body, ctx, now = Date.now() }) {
  if (!secret) return { status: 503, json: { error: 'Not set up.' } };
  if (!(await verifySignature(secret, signature, body, now))) return { status: 401, json: { error: 'Bad signature.' } };
  let event;
  try {
    event = JSON.parse(body);
  } catch {
    return { status: 400, json: { error: 'Not JSON.' } };
  }
  const type = String(event?.event_type ?? '');
  try {
    const done = await handleEvent(await ctx(), event);
    console.log('paddle', type, done);
    return { status: 200, json: { ok: true } };
  } catch (e) {
    // Only the kind of error: a message could quote a record.
    console.error('paddle event failed', type, e instanceof Error ? e.name : 'error', e?.code ?? '');
    return { status: 500, json: { error: 'Failed.' } };
  }
}

/**
 * Applies a Paddle webhook event (or an entity read back from Paddle). ctx = { db, s, paddle }
 * (paddle may be null). Every event may come more than once and in any order: each is applied as
 * the latest news about its subscription or transaction, and older news is ignored. Resolves with
 * a word for the log.
 */
export async function handleEvent(ctx, event) {
  const type = String(event?.event_type ?? '');
  const data = event?.data;
  if (!data) return 'empty';
  if (type.startsWith('subscription.')) return applySubscription(ctx, data);
  if (type === 'transaction.completed' || type === 'transaction.paid') return applyTransaction(ctx, data);
  if (type === 'adjustment.created' || type === 'adjustment.updated') return applyAdjustment(ctx, data);
  return 'ignored';
}

/** The Base44 user id a subscription or transaction is for. */
async function buyerOf({ db, paddle }, entity) {
  const id = entity?.custom_data?.user_id;
  if (typeof id === 'string' && id) return id;
  // Bought some other way (a Paddle link, say): by the Paddle customer.
  const customer = entity?.customer_id;
  if (!customer) return null;
  const [a] = (await db.Account.filter({ customer })).filter((x) => x.customer === customer);
  if (a?.user_id) return a.user_id;
  const c = paddle ? await paddle.get(`/customers/${customer}`).catch(() => null) : null;
  if (!c?.email) return null;
  const [u] = await db.User.filter({ email: String(c.email).toLowerCase() }).catch(() => []);
  return u?.id ?? null;
}

/**
 * Keeps `fields` on the Purchase record for a Paddle subscription or transaction id, unless the
 * record has newer news (`at`, the entity's updated_at). A refund stands until Paddle reverses it
 * (`restore`).
 */
async function upsertPurchase(db, paddleId, fields, at = null, { restore = false } = {}) {
  const found = (await db.Purchase.filter({ paddle_id: paddleId })).filter((p) => p.paddle_id === paddleId);
  let keep = oldest(found);
  if (!keep) {
    await db.Purchase.create({ paddle_id: paddleId, ...fields, event_at: at });
    // Two deliveries at once make two records: the older one is kept, with this news.
    const all = (await db.Purchase.filter({ paddle_id: paddleId })).filter((p) => p.paddle_id === paddleId);
    keep = oldest(all);
    for (const p of all) if (p.id !== keep.id) await db.Purchase.delete(p.id).catch(() => {});
    if (keep.status === fields.status || keep.status === 'refunded') return keep;
  } else {
    for (const p of found) if (p.id !== keep.id) await db.Purchase.delete(p.id).catch(() => {});
    if (at && keep.event_at && isBefore(at, keep.event_at)) return keep;
  }
  const next = { ...fields, event_at: at ?? keep.event_at ?? null };
  if (keep.status === 'refunded' && fields.status === 'completed' && !restore) next.status = 'refunded';
  return db.Purchase.update(keep.id, next);
}

async function applySubscription(ctx, sub) {
  if (!sub?.id) return 'empty';
  const user = await buyerOf(ctx, sub);
  if (!user) return 'unknown buyer';
  await upsertPurchase(ctx.db, sub.id, {
    kind: 'monthly',
    user_id: user,
    customer: sub.customer_id ?? null,
    status: String(sub.status ?? ''),
    ends_at: sub.current_billing_period?.ends_at ?? sub.canceled_at ?? null,
    cancel_at: sub.scheduled_change?.action === 'cancel' ? sub.scheduled_change.effective_at : null,
  }, sub.updated_at ?? null);
  return 'ok';
}

const planOfItem = (it) => (PLANS.has(it?.price?.custom_data?.plan) ? it.price.custom_data.plan : null);

/** A paid transaction: a one-time plan bought, or a monthly payment. 'pending' if its subscription is still being made. */
async function applyTransaction(ctx, txn) {
  const { db, paddle } = ctx;
  if (!['paid', 'completed'].includes(txn?.status)) return 'not paid';
  const user = await buyerOf(ctx, txn);
  if (!user) return 'unknown buyer';
  if (txn.subscription_id) {
    // A monthly payment: the subscription's own events carry its state; make sure it is known.
    const [known] = (await db.Purchase.filter({ paddle_id: txn.subscription_id })).filter((p) => p.paddle_id === txn.subscription_id);
    if (known) return 'ok';
    const sub = paddle ? await paddle.get(`/subscriptions/${txn.subscription_id}`).catch(() => null) : null;
    if (sub) return applySubscription(ctx, { ...sub, custom_data: { user_id: user, ...(sub.custom_data ?? {}) } });
    await upsertPurchase(db, txn.subscription_id, {
      kind: 'monthly', user_id: user, customer: txn.customer_id ?? null, status: 'active', ends_at: txn.billing_period?.ends_at ?? null, cancel_at: null,
    });
    return 'ok';
  }
  const item = (txn.items ?? []).find((it) => planOfItem(it));
  const plan = item ? planOfItem(item) : PLANS.has(txn.custom_data?.plan) ? txn.custom_data.plan : null;
  // Paid for the monthly plan, but Paddle has not made the subscription yet (it does in moments).
  if (plan === 'monthly') return 'pending';
  if (!ONE_TIME.has(plan)) return 'not ours';
  const quantity = Math.max(1, Math.floor(Number(item?.quantity) || 1));
  await upsertPurchase(db, txn.id, {
    kind: plan,
    user_id: user,
    customer: txn.customer_id ?? null,
    status: 'completed',
    seats: plan === 'group' ? GROUP_SIZE * quantity : plan === 'seat' ? quantity : 0,
  });
  if (plan === 'group' || plan === 'seat') await groupChanged(ctx, user);
  if (plan === 'lifetime') await endMonthly(ctx, user);
  return 'ok';
}

/** Bought a plan for good while paying monthly: the monthly plan stops at the end of the month paid for. */
async function endMonthly(ctx, user) {
  if (!ctx.paddle) return;
  const running = (await ctx.db.Purchase.filter({ user_id: user }))
    .filter((p) => p.user_id === user && p.kind === 'monthly' && LIVE.has(p.status) && !p.cancel_at);
  for (const p of running) {
    try {
      const sub = await ctx.paddle.post(`/subscriptions/${p.paddle_id}/cancel`, { effective_from: 'next_billing_period' });
      await applySubscription(ctx, { ...sub, custom_data: { user_id: user, ...(sub?.custom_data ?? {}) } });
    } catch (e) {
      console.error('could not end a monthly plan', e?.code ?? e?.name ?? 'error');
    }
  }
}

/**
 * A refund or chargeback: a one-time plan refunded in full, or charged back, is taken away (and
 * given back if the chargeback is reversed). A monthly payment refunded in full cancels the monthly
 * plan at once (the Refund Policy, refunds.html); its own events then say it has ended.
 */
async function applyAdjustment(ctx, adj) {
  const txn = adj?.transaction_id;
  if (!txn) return 'ignored';
  const full = adj.type === 'full' || (adj.type == null && (adj.items ?? []).length > 0 && adj.items.every((i) => i.type === 'full'));
  if (adj.subscription_id) {
    if (adj.action !== 'refund' || adj.status !== 'approved' || !full || !ctx.paddle) return 'ignored';
    let sub;
    try {
      sub = await ctx.paddle.post(`/subscriptions/${adj.subscription_id}/cancel`, { effective_from: 'immediately' });
    } catch (e) {
      // Already cancelled (a repeat of this event, say): nothing to do. Anything else: Paddle sends it again.
      if (e instanceof PaddleError && e.status >= 400 && e.status < 500) return 'already ended';
      throw e;
    }
    if (sub) await applySubscription(ctx, sub);
    return 'ok';
  }
  let refunded;
  if (adj.action === 'refund' && adj.status === 'approved' && full) refunded = true;
  else if (adj.action === 'chargeback') refunded = true;
  else if (adj.action === 'chargeback_reverse') refunded = false;
  if (refunded === undefined) return 'ignored';
  const [p] = (await ctx.db.Purchase.filter({ paddle_id: txn })).filter((x) => x.paddle_id === txn);
  if (!p) {
    // Refunded before we heard of the purchase: remembered, so the purchase is not given later.
    if (refunded) await upsertPurchase(ctx.db, txn, { status: 'refunded' });
    return 'ok';
  }
  await upsertPurchase(ctx.db, txn, { status: refunded ? 'refunded' : 'completed' }, null, { restore: !refunded });
  if (p.kind === 'group' || p.kind === 'seat') await groupChanged(ctx, p.user_id);
  return 'ok';
}

// ------------------------------------------------------------------ groups

/** A group's places from its buyer's purchases: 10 per group plan, and one per extra place (with a group plan). */
function placesOf(purchases) {
  const sum = (kind) => purchases.filter((p) => p.kind === kind && p.status === 'completed').reduce((n, p) => n + (Number(p.seats) || 0), 0);
  const group = sum('group');
  return group > 0 ? Math.min(MAX_PLACES, group + sum('seat')) : 0;
}

/** After a group purchase or refund: the buyer's group with its places worked out again (made if new). */
export async function groupChanged(ctx, owner) {
  const { db, s } = ctx;
  const purchases = (await db.Purchase.filter({ user_id: owner })).filter((p) => p.user_id === owner);
  const seats = placesOf(purchases);
  const found = (await db.Group.filter({ owner_id: owner })).filter((g) => g.owner_id === owner);
  const g = oldest(found);
  if (!g) {
    if (!seats) return null;
    const u = await db.User.get(owner).catch(() => null);
    await db.Group.create({
      owner_id: owner,
      seats,
      people: [],
      access: [],
      sealed: await s.seal({ owner_email: String(u?.email ?? '').toLowerCase(), owner_name: u?.full_name ?? '', members: [] }),
    });
    const all = (await db.Group.filter({ owner_id: owner })).filter((x) => x.owner_id === owner);
    const keep = oldest(all);
    for (const x of all) if (x.id !== keep.id && x.seats === keep.seats) await db.Group.delete(x.id).catch(() => {});
    return keep;
  }
  return saveGroup(ctx, g, { seats });
}

/**
 * Keeps a group's places and members (all of them, in order); the first places − 1 are let in
 * (the buyer has the other place): their fingerprints, and the user ids of those with accounts.
 */
async function saveGroup({ db, s }, g, { seats = Number(g.seats) || 0, members = null } = {}) {
  const inside = await s.open(g.sealed);
  const list = members ?? inside.members ?? [];
  const admitted = list.slice(0, Math.max(0, seats - 1));
  const people = await Promise.all(admitted.map((e) => s.lookupKey(e)));
  const access = [];
  for (const email of admitted) {
    const [u] = await db.User.filter({ email }).catch(() => []);
    if (u?.id && !access.includes(u.id)) access.push(u.id);
  }
  return db.Group.update(g.id, { seats, people, access, sealed: await s.seal({ ...inside, members: list }) });
}

/** The list of addresses someone typed: lower case, checked, without repeats or their own. */
export function cleanMembers(list, ownerEmail) {
  if (!Array.isArray(list) || list.length > MAX_PLACES) fail(400, 'Invalid list of people.');
  const out = [];
  for (const m of list) {
    const email = String(m ?? '').trim().toLowerCase();
    if (!EMAIL.test(email) || email.length > 254) fail(400, `“${String(m ?? '').trim().slice(0, 80)}” is not an email address.`);
    if (email !== ownerEmail && !out.includes(email)) out.push(email);
  }
  return out;
}

// ------------------------------------------------------------------ the billing function

/**
 * The signed-in person's plan: status, checkout, sync, members, cancel, resume, portal.
 * ctx = { db (service role), s (sealer), me: { id, email, name, created, role }, paddle (or null
 * while payments are not set up), paddleToken (Paddle.js's client-side token) }.
 */
export async function billingApi(ctx, body) {
  const { db, me } = ctx;
  const user = { id: me.id, created: me.created, role: me.role };
  const paddle = () => (ctx.paddle && ctx.paddleToken ? ctx.paddle : fail(503, 'Payments are not set up yet. Please try again later.'));
  const owned = async () => oldest((await db.Group.filter({ owner_id: me.id })).filter((g) => g.owner_id === me.id));
  // Paddle's own messages are for developers: the person sees what to do.
  const viaPaddle = async (fn) => {
    try {
      return await fn();
    } catch (e) {
      if (!(e instanceof PaddleError)) throw e;
      console.error('Paddle refused', e.status, e.code ?? '');
      fail(502, 'The payment service did not answer as expected. Please try again in a minute.');
    }
  };

  switch (body?.action) {
    case 'status':
      return statusOf(ctx, user);
    case 'checkout': {
      const plan = String(body.plan ?? '');
      if (!PLANS.has(plan)) fail(400, 'Choose a plan.');
      const quantity = plan === 'seat' ? Number(body.quantity) : 1;
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_EXTRA_AT_ONCE) fail(400, `Choose how many people to add: 1 to ${MAX_EXTRA_AT_ONCE}.`);
      const { access, purchases } = await loadAccess(db, user, { key: await ctx.s.lookupKey(me.email) });
      const forGood = ['admin', 'early', 'lifetime'].includes(access.kind);
      const monthly = purchases.some((p) => p.kind === 'monthly' && LIVE.has(p.status));
      const group = await owned();
      if (plan === 'monthly' && forGood) fail(409, 'You already have Rocket in Cloud for good.');
      if (plan === 'monthly' && monthly) fail(409, 'You already have the monthly plan.');
      if (plan === 'lifetime' && forGood) fail(409, 'You already have Rocket in Cloud for good.');
      if (plan === 'openrocket' && (forGood || monthly || access.kind === 'group')) fail(409, 'Your plan already includes OpenRocket.');
      if (plan === 'openrocket' && access.openrocket) fail(409, 'You already have the OpenRocket plan.');
      if (plan === 'group' && (Number(group?.seats) || 0) > 0) fail(409, 'You already have a group. Add places to it instead.');
      if (plan === 'seat' && !((Number(group?.seats) || 0) > 0)) fail(409, 'Buy the group plan first.');
      if (plan === 'seat' && group.seats + quantity > MAX_PLACES) fail(400, `A group can have up to ${MAX_PLACES} people.`);
      const p = paddle();
      return viaPaddle(async () => {
        const price = (await pricesOf(p))[plan] ?? fail(503, 'This plan is not on sale right now. Please try again later.');
        const customer = await customerFor(db, p, me, await ensureAccount(db, user));
        const txn = await p.post('/transactions', {
          items: [{ price_id: price.id, quantity }],
          customer_id: customer,
          custom_data: { user_id: me.id, plan },
        });
        return { transactionId: txn.id, token: ctx.paddleToken ?? null, sandbox: p.sandbox };
      });
    }
    case 'sync': {
      // Right after paying: the purchase as Paddle has it (its webhook may not have come yet).
      const id = String(body.transactionId ?? '');
      if (!/^txn_[a-z\d]{26}$/.test(id)) fail(400, 'Unknown purchase.');
      const p = paddle();
      const txn = await viaPaddle(() => p.get(`/transactions/${id}`));
      if (txn?.custom_data?.user_id !== me.id) fail(404, 'Unknown purchase.');
      const done = await applyTransaction(ctx, txn);
      return { ...(await statusOf(ctx, user)), pending: done === 'pending' || txn.status === 'ready' || txn.status === 'draft' || txn.status === 'billed' };
    }
    case 'members': {
      const g = await owned();
      if (!g || !((Number(g.seats) || 0) > 0)) fail(403, 'Only the buyer of a group plan can change its people.');
      const members = cleanMembers(body.members, me.email);
      // A group with more people than places (after a refund) can still lose people, one at a time.
      const before = (await ctx.s.open(g.sealed)).members ?? [];
      if (members.length > g.seats - 1 && members.some((e) => !before.includes(e))) {
        fail(400, `Your group has room for ${g.seats - 1} people besides you. Remove someone, or add places to the group.`);
      }
      await saveGroup(ctx, g, { members });
      return statusOf(ctx, user, { refresh: false });
    }
    case 'cancel':
    case 'resume': {
      const p = paddle();
      const sub = (await db.Purchase.filter({ user_id: me.id }))
        .filter((x) => x.user_id === me.id && x.kind === 'monthly' && LIVE.has(x.status))
        .sort((a, b) => (when(b.ends_at) || 0) - (when(a.ends_at) || 0))[0];
      if (!sub) fail(404, 'You have no monthly plan.');
      const next = await viaPaddle(() => (body.action === 'cancel'
        ? p.post(`/subscriptions/${sub.paddle_id}/cancel`, { effective_from: 'next_billing_period' })
        : p.patch(`/subscriptions/${sub.paddle_id}`, { scheduled_change: null })));
      await applySubscription(ctx, { ...next, custom_data: { user_id: me.id, ...(next?.custom_data ?? {}) } });
      return statusOf(ctx, user, { refresh: false });
    }
    case 'portal': {
      // Paddle's customer portal, signed in: payment details, receipts and invoices.
      const p = paddle();
      const [account] = (await db.Account.filter({ user_id: me.id })).filter((a) => a.user_id === me.id && a.customer);
      if (!account) fail(404, 'You have not bought anything yet.');
      const subs = (await db.Purchase.filter({ user_id: me.id }))
        .filter((x) => x.user_id === me.id && x.kind === 'monthly' && LIVE.has(x.status)).map((x) => x.paddle_id);
      const session = await viaPaddle(() => p.post(`/customers/${account.customer}/portal-sessions`, subs.length ? { subscription_ids: subs } : {}));
      return { url: session?.urls?.general?.overview ?? null };
    }
    default:
      fail(400, 'Unknown request.');
  }
}

/** What the plan page shows. */
async function statusOf(ctx, user, { refresh = true } = {}) {
  const { db, s, me } = ctx;
  const free = freeKind(user);
  if (!free) await ensureAccount(db, user);
  const key = await s.lookupKey(me.email);
  let loaded = await loadAccess(db, user, { key });
  // A monthly plan past the month paid for, still running here: a webhook was missed. Ask Paddle.
  if (refresh && ctx.paddle) {
    const stale = loaded.purchases.filter((p) => p.kind === 'monthly' && LIVE.has(p.status) && when(p.ends_at) < Date.now() - 3600_000);
    for (const p of stale) {
      const sub = await ctx.paddle.get(`/subscriptions/${p.paddle_id}`).catch(() => null);
      if (sub) await applySubscription(ctx, { ...sub, custom_data: { user_id: me.id, ...(sub.custom_data ?? {}) } });
    }
    if (stale.length) loaded = await loadAccess(db, user, { key });
  }
  const { access, purchases, groups } = loaded;
  const monthly = purchases.filter((p) => p.kind === 'monthly' && LIVE.has(p.status))
    .sort((a, b) => (when(b.ends_at) || 0) - (when(a.ends_at) || 0))[0] ?? null;
  const mine = oldest((await db.Group.filter({ owner_id: me.id })).filter((g) => g.owner_id === me.id));
  let group = null;
  if (mine) {
    const inside = await s.open(mine.sealed);
    const seats = Number(mine.seats) || 0;
    group = { seats, members: (inside.members ?? []).map((email, i) => ({ email, admitted: i < seats - 1 })) };
  }
  const memberOf = [];
  for (const g of groups) {
    if (g.owner_id === me.id || !((Number(g.seats) || 0) > 0)) continue;
    const inside = await s.open(g.sealed).catch(() => null);
    memberOf.push({ owner_name: inside?.owner_name || inside?.owner_email || 'Someone', owner_email: inside?.owner_email ?? '' });
  }
  return {
    access: { ...access, until: iso(access.until), trialEnds: iso(access.trialEnds) },
    monthly: monthly ? { status: monthly.status, endsAt: monthly.ends_at ? iso(when(monthly.ends_at)) : null, cancelAt: monthly.cancel_at ? iso(when(monthly.cancel_at)) : null } : null,
    lifetime: purchases.some((p) => p.kind === 'lifetime' && p.status === 'completed'),
    openrocket: access.openrocket,
    group,
    memberOf,
    bought: purchases.some((p) => p.status === 'completed' || LIVE.has(p.status)),
    // Paddle.js's client-side token is public (it can only open checkouts).
    sale: ctx.paddle && ctx.paddleToken ? { sandbox: ctx.paddle.sandbox, token: ctx.paddleToken } : null,
    prices: PRICES,
    groupSize: GROUP_SIZE,
  };
}

// ------------------------------------------------------------------ the other functions

const accessCache = new Map(); // user id -> { at, full }

/**
 * For the other functions: throws a 402 (code plan_required) when the signed-in person has no
 * plan, unless `action` is one of `open` (what someone may still do without one: see and
 * download their work, leave and delete). With `full` (the Launch Planner and the Logbook), a plan
 * for OpenRocket only is not enough either: a 402 with code plan_upgrade. Someone found to have
 * what is asked is not looked up again for a minute; anyone else is looked up every time, so a
 * purchase counts at once. If their plan cannot be looked up, they are let in.
 */
export async function requirePlan(ctx, action, open = [], { full = false } = {}) {
  if (open.includes(action)) return;
  const { db, s, me } = ctx;
  const user = { id: me.id, created: me.created, role: me.role };
  if (freeKind(user)) return;
  const kept = accessCache.get(me.id);
  if (kept && Date.now() - kept.at < 60_000 && (!full || kept.full)) return;
  let access;
  try {
    access = await lookAccess(db, user, { key: await s.lookupKey(me.email) });
  } catch (e) {
    console.error('plan lookup failed', e?.name ?? 'error');
    return;
  }
  if (access.ok) {
    accessCache.set(me.id, { at: Date.now(), full: access.full });
    if (accessCache.size > 5000) accessCache.delete(accessCache.keys().next().value);
    if (!full || access.full) return;
    fail(402, UPGRADE_MESSAGE, PLAN_UPGRADE);
  }
  fail(402, PLAN_MESSAGE, PLAN_REQUIRED);
}

export function forgetAccess() {
  accessCache.clear();
}
