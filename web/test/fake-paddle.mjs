// An in-memory stand-in for Paddle Billing (paddle.com), for the tests of plans and payments
// (base44/shared/billing.js): its API, as a fetch function for paddleApi(), and what happens on
// Paddle's side (a checkout paid, a renewal, a failed payment, a cancellation taking effect, a
// refund, a chargeback), each giving the webhook events Paddle would send, shaped as Paddle's are.
//   const paddle = fakePaddle();
//   paddleApi('pdl_sdbx_apikey_…', { fetch: paddle.fetch })
//   const events = paddle.pay('txn_…')   // [{ event_id, event_type, occurred_at, data }]
const MONTH = 30 * 24 * 3600_000;

export function fakePaddle({ now = () => Date.now() } = {}) {
  const rid = (prefix) => `${prefix}_${Array.from(crypto.getRandomValues(new Uint8Array(26)), (b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('')}`;
  // Paddle's times, to the nanosecond: two changes in the same millisecond still come in order.
  let tick = 0;
  const at = () => new Date(now()).toISOString().replace('Z', `${String(++tick % 1e6).padStart(6, '0')}Z`);
  const products = new Map();
  const prices = new Map();
  const customers = new Map();
  const transactions = new Map();
  const subscriptions = new Map();
  const adjustments = new Map();
  const notifications = new Map();
  const settings = { default_url: null };
  const calls = [];
  const copy = (x) => structuredClone(x);

  const event = (type, data) => ({ event_id: rid('evt'), event_type: type, occurred_at: at(), notification_id: rid('ntf'), data: copy(data) });
  const error = (status, code, detail) => ({ status, body: { error: { type: 'request_error', code, detail }, meta: { request_id: crypto.randomUUID() } } });

  function addPrice({ plan, amount, recurring = false, product = null }) {
    const p = {
      id: rid('pri'),
      product_id: product ?? rid('pro'),
      description: plan,
      name: plan,
      type: 'standard',
      billing_cycle: recurring ? { interval: 'month', frequency: 1 } : null,
      trial_period: null,
      tax_mode: 'external',
      unit_price: { amount: String(Math.round(amount * 100)), currency_code: 'USD' },
      unit_price_overrides: [],
      quantity: { minimum: 1, maximum: plan === 'seat' ? 100 : 1 },
      status: 'active',
      custom_data: { plan },
      created_at: at(),
      updated_at: at(),
    };
    prices.set(p.id, p);
    return p;
  }

  function handle(method, path, query, body) {
    calls.push({ method, path, query, body });
    let m;
    if (method === 'GET' && path === '/prices') {
      return { data: [...prices.values()].filter((p) => (!query.get('status') || p.status === query.get('status')) && (!query.get('product_id') || p.product_id === query.get('product_id'))) };
    }
    if (method === 'POST' && path === '/products') {
      const p = { id: rid('pro'), status: 'active', created_at: at(), updated_at: at(), ...body };
      products.set(p.id, p);
      return { status: 201, data: p };
    }
    if (method === 'GET' && path === '/products') return { data: [...products.values()] };
    if (method === 'POST' && path === '/prices') {
      const p = { id: rid('pri'), status: 'active', created_at: at(), updated_at: at(), unit_price_overrides: [], ...body };
      prices.set(p.id, p);
      return { status: 201, data: p };
    }
    if (method === 'GET' && path === '/customers') {
      const emails = (query.get('email') ?? '').split(',').filter(Boolean);
      return { data: [...customers.values()].filter((c) => !emails.length || emails.includes(c.email)) };
    }
    if (method === 'POST' && path === '/customers') {
      const email = String(body.email ?? '').toLowerCase();
      const same = [...customers.values()].find((c) => c.email === email);
      if (same) return error(409, 'customer_already_exists', `customer email conflicts with customer of id ${same.id}`);
      const c = { id: rid('ctm'), email, name: body.name ?? null, status: 'active', created_at: at() };
      customers.set(c.id, c);
      return { status: 201, data: c };
    }
    if (method === 'GET' && (m = path.match(/^\/customers\/(ctm_\w+)$/))) {
      return customers.has(m[1]) ? { data: customers.get(m[1]) } : error(404, 'entity_not_found', 'not found');
    }
    if (method === 'POST' && (m = path.match(/^\/customers\/(ctm_\w+)\/portal-sessions$/))) {
      if (!customers.has(m[1])) return error(404, 'entity_not_found', 'not found');
      const token = rid('pga');
      return {
        status: 201,
        data: {
          id: rid('cpls'),
          customer_id: m[1],
          urls: {
            general: { overview: `https://sandbox-customer-portal.paddle.com/cpl_test?action=overview&token=${token}` },
            subscriptions: (body.subscription_ids ?? []).map((id) => ({ id, cancel_subscription: `https://sandbox-customer-portal.paddle.com/cpl_test?action=cancel_subscription&subscription_id=${id}&token=${token}` })),
          },
        },
      };
    }
    if (method === 'POST' && path === '/transactions') {
      if (!settings.default_url && settings.requireDefaultUrl) return error(400, 'transaction_default_checkout_url_not_set', 'no default payment link');
      const items = [];
      for (const it of body.items ?? []) {
        const price = prices.get(it.price_id);
        if (!price || price.status !== 'active') return error(400, 'transaction_price_not_found', `price ${it.price_id} not found`);
        const q = it.quantity ?? 1;
        if (q < price.quantity.minimum || q > price.quantity.maximum) return error(400, 'transaction_item_quantity_out_of_range', 'quantity out of range');
        items.push({ price: copy(price), quantity: q });
      }
      if (body.customer_id && !customers.has(body.customer_id)) return error(404, 'entity_not_found', 'customer not found');
      const t = {
        id: rid('txn'),
        status: 'draft',
        customer_id: body.customer_id ?? null,
        address_id: null,
        custom_data: body.custom_data ?? null,
        origin: 'api',
        collection_mode: 'automatic',
        subscription_id: null,
        billing_period: null,
        currency_code: 'USD',
        items,
        created_at: at(),
        updated_at: at(),
        billed_at: null,
        checkout: { url: `${settings.default_url ?? 'https://example.com/'}?_ptxn=` },
      };
      t.checkout.url += t.id;
      transactions.set(t.id, t);
      return { status: 201, data: t };
    }
    if (method === 'GET' && (m = path.match(/^\/transactions\/(txn_\w+)$/))) {
      return transactions.has(m[1]) ? { data: transactions.get(m[1]) } : error(404, 'entity_not_found', 'not found');
    }
    if (method === 'GET' && (m = path.match(/^\/subscriptions\/(sub_\w+)$/))) {
      return subscriptions.has(m[1]) ? { data: subscriptions.get(m[1]) } : error(404, 'entity_not_found', 'not found');
    }
    if (method === 'POST' && (m = path.match(/^\/subscriptions\/(sub_\w+)\/cancel$/))) {
      const sub = subscriptions.get(m[1]);
      if (!sub) return error(404, 'entity_not_found', 'not found');
      if (sub.status === 'canceled') return error(400, 'subscription_locked_canceled', 'already canceled');
      if (body.effective_from === 'immediately') endNow(sub);
      else sub.scheduled_change = { action: 'cancel', effective_at: sub.current_billing_period.ends_at, resume_at: null };
      sub.updated_at = at();
      pending.push(event('subscription.updated', sub));
      if (sub.status === 'canceled') pending.push(event('subscription.canceled', sub));
      return { data: sub };
    }
    if (method === 'PATCH' && (m = path.match(/^\/subscriptions\/(sub_\w+)$/))) {
      const sub = subscriptions.get(m[1]);
      if (!sub) return error(404, 'entity_not_found', 'not found');
      if (sub.status === 'canceled') return error(400, 'subscription_locked_canceled', 'canceled');
      if ('scheduled_change' in body) sub.scheduled_change = body.scheduled_change;
      sub.updated_at = at();
      pending.push(event('subscription.updated', sub));
      return { data: sub };
    }
    if (method === 'PATCH' && path === '/settings/checkout-url') {
      settings.default_url = body.default_url;
      return { data: { default_url: settings.default_url } };
    }
    if (method === 'GET' && path === '/notification-settings') return { data: [...notifications.values()].map(({ endpoint_secret_key, ...n }) => n) };
    if (method === 'POST' && path === '/notification-settings') {
      const n = { id: rid('ntfset'), active: true, endpoint_secret_key: `pdl_ntfset_${rid('x').slice(2)}`, ...body };
      notifications.set(n.id, n);
      return { status: 201, data: n };
    }
    if (method === 'POST' && path === '/client-tokens') {
      return { status: 201, data: { id: rid('ctkn'), token: `test_${rid('x').slice(2, 29)}`, name: body.name, status: 'active' } };
    }
    return error(404, 'not_found', `${method} ${path}`);
  }

  // Events made by API calls (a cancel, say), for the test to deliver when it likes.
  const pending = [];

  function endNow(sub) {
    sub.status = 'canceled';
    sub.canceled_at = at();
    sub.current_billing_period = null;
    sub.next_billed_at = null;
    sub.scheduled_change = null;
    sub.updated_at = at();
  }

  async function fetchFn(url, init = {}) {
    const u = new URL(url);
    if (!/^(sandbox-)?api\.paddle\.com$/.test(u.host)) throw new Error(`fake Paddle: unexpected host ${u.host}`);
    if (!/^Bearer pdl_(sdbx|live)_apikey_/.test(init.headers?.Authorization ?? '')) {
      return new Response(JSON.stringify(error(403, 'forbidden', 'bad key').body), { status: 403 });
    }
    if (paddle.down) return new Response('{}', { status: 503 });
    const body = init.body ? JSON.parse(init.body) : {};
    const out = handle(init.method ?? 'GET', u.pathname, u.searchParams, body);
    const status = out.status ?? 200;
    return new Response(JSON.stringify(out.body ?? { data: out.data, meta: { request_id: crypto.randomUUID() } }), { status, headers: { 'content-type': 'application/json' } });
  }

  const paddle = {
    fetch: fetchFn,
    calls,
    prices,
    customers,
    transactions,
    subscriptions,
    notifications,
    settings,
    down: false,
    addPrice,
    /** The plans' prices, as scripts/paddle-setup.mjs makes them. */
    setUp() {
      return {
        monthly: addPrice({ plan: 'monthly', amount: 1, recurring: true }),
        lifetime: addPrice({ plan: 'lifetime', amount: 4 }),
        group: addPrice({ plan: 'group', amount: 10 }),
        seat: addPrice({ plan: 'seat', amount: 3 }),
      };
    },
    /** Events from API calls since last asked. */
    takeEvents() {
      return pending.splice(0);
    },
    /**
     * The buyer pays at checkout. `upTo` 'paid' stops where Paddle has taken the money but has not
     * finished (no subscription yet). Returns the webhook events, in Paddle's order.
     */
    pay(txnId, { upTo = 'completed' } = {}) {
      const t = transactions.get(txnId);
      if (!t) throw new Error(`no transaction ${txnId}`);
      const out = [];
      if (t.status === 'draft' || t.status === 'ready') {
        t.status = 'paid';
        t.billed_at = at();
        t.updated_at = at();
        t.address_id = rid('add');
        out.push(event('transaction.paid', t));
      }
      if (upTo === 'paid') return out;
      const recurring = t.items.find((it) => it.price.billing_cycle);
      if (recurring && !t.subscription_id) {
        const start = now();
        const sub = {
          id: rid('sub'),
          status: 'active',
          customer_id: t.customer_id,
          address_id: t.address_id,
          currency_code: 'USD',
          created_at: at(),
          updated_at: at(),
          started_at: at(),
          first_billed_at: at(),
          next_billed_at: new Date(start + MONTH).toISOString(),
          canceled_at: null,
          collection_mode: 'automatic',
          current_billing_period: { starts_at: new Date(start).toISOString(), ends_at: new Date(start + MONTH).toISOString() },
          billing_cycle: { interval: 'month', frequency: 1 },
          scheduled_change: null,
          items: t.items.map((it) => ({ status: 'active', quantity: it.quantity, price: copy(it.price) })),
          custom_data: t.custom_data ? copy(t.custom_data) : null,
        };
        subscriptions.set(sub.id, sub);
        t.subscription_id = sub.id;
        t.billing_period = copy(sub.current_billing_period);
        out.push(event('subscription.created', sub), event('subscription.activated', sub));
      }
      t.status = 'completed';
      t.updated_at = at();
      out.push(event('transaction.completed', t));
      return out;
    },
    /** A month later: the subscription renews (a new transaction), or ends if it was cancelled. */
    renew(subId) {
      const sub = subscriptions.get(subId);
      if (sub.scheduled_change?.action === 'cancel') {
        endNow(sub);
        return [event('subscription.updated', sub), event('subscription.canceled', sub)];
      }
      const ends = Date.parse(sub.current_billing_period.ends_at);
      sub.current_billing_period = { starts_at: new Date(ends).toISOString(), ends_at: new Date(ends + MONTH).toISOString() };
      sub.next_billed_at = sub.current_billing_period.ends_at;
      sub.updated_at = at();
      const t = {
        id: rid('txn'), status: 'completed', customer_id: sub.customer_id, custom_data: copy(sub.custom_data), origin: 'subscription_recurring',
        subscription_id: sub.id, billing_period: copy(sub.current_billing_period), items: copy(sub.items), created_at: at(), updated_at: at(),
      };
      transactions.set(t.id, t);
      return [event('subscription.updated', sub), event('transaction.completed', t)];
    },
    /** The renewal's payment fails: Paddle retries it for a while (past_due), then cancels. */
    failRenewal(subId, { giveUp = false } = {}) {
      const sub = subscriptions.get(subId);
      if (giveUp) {
        endNow(sub);
        return [event('subscription.canceled', sub)];
      }
      sub.status = 'past_due';
      sub.updated_at = at();
      return [event('subscription.past_due', sub)];
    },
    /** The seller (or Paddle support) refunds a transaction: created pending, approved later. */
    refund(txnId, { type = 'full', approve = true } = {}) {
      const t = transactions.get(txnId);
      const adj = {
        id: rid('adj'), action: 'refund', type, transaction_id: txnId, subscription_id: t.subscription_id ?? null, customer_id: t.customer_id,
        status: 'pending_approval', reason: 'requested', items: t.items.map(() => ({ item_id: rid('txnitm'), type })), created_at: at(), updated_at: at(),
      };
      adjustments.set(adj.id, adj);
      const out = [event('adjustment.created', adj)];
      if (approve) {
        adj.status = 'approved';
        adj.updated_at = at();
        out.push(event('adjustment.updated', adj));
      }
      return out;
    },
    chargeback(txnId, { reverse = false } = {}) {
      const t = transactions.get(txnId);
      const adj = {
        id: rid('adj'), action: reverse ? 'chargeback_reverse' : 'chargeback', type: 'full', transaction_id: txnId, subscription_id: t.subscription_id ?? null,
        customer_id: t.customer_id, status: 'approved', reason: 'dispute', items: [], created_at: at(), updated_at: at(),
      };
      return [event('adjustment.created', adj)];
    },
  };
  return paddle;
}
