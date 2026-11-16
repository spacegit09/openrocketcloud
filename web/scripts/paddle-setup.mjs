// Sets up Paddle (paddle.com) for the plans (base44/shared/billing.js): the product and its four
// prices, the default payment link (the plan page, which opens Paddle's checkout), the webhook to
// the paddleWebhook function, and a client-side token for Paddle.js. Run it once for Paddle's
// sandbox and once for the live account; running it again finds what it made before.
//
//   PADDLE_API_KEY=pdl_sdbx_apikey_… node scripts/paddle-setup.mjs --site https://rocketincloud.com
//
// Options:
//   --site URL       the site's address (default payment link: URL/account.html)
//   --webhook URL    where Paddle sends events (default: URL/functions/paddleWebhook); `none` to
//                    make no webhook (a sandbox tried from your own computer, say)
//   --tax external   prices plus the buyer's VAT or sales tax (default); `internal`: tax included
//   --out FILE       write the app secrets to FILE (KEY=value lines) instead of printing them
//
// The API key needs these permissions (or "all"): products, prices, customers, transactions,
// subscriptions and customer portal sessions (read and write), adjustments (read), notification
// settings and client-side tokens (write). The webhook's secret is shown only when the webhook is
// made; to see it again, open the notification destination in Paddle (Developer tools >
// Notifications).
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PRICES, paddleApi } from '../base44/shared/billing.js';

const APP = 'rocket-in-cloud';
export const EVENTS = [
  'transaction.paid', 'transaction.completed',
  'subscription.created', 'subscription.updated', 'subscription.activated', 'subscription.canceled',
  'subscription.past_due', 'subscription.paused', 'subscription.resumed', 'subscription.trialing',
  'adjustment.created', 'adjustment.updated',
];
const PLANS = {
  monthly: { name: 'Monthly', description: 'Rocket in Cloud, monthly', recurring: true, max: 1 },
  lifetime: { name: 'Individual', description: 'Rocket in Cloud for one person, for good', max: 1 },
  group: { name: 'Group of 10', description: 'Rocket in Cloud for you and 9 people you choose, for good', max: 1 },
  seat: { name: 'Extra person', description: 'One more person in your Rocket in Cloud group, for good', max: 100 },
};

/** Sets up Paddle; returns what it found or made. `log` gets a line per step. */
export async function setUpPaddle({ apiKey, site, webhook = null, taxMode = 'external', fetch: fetchFn = globalThis.fetch, log = console.log }) {
  if (!/^pdl_(sdbx|live)_apikey_/.test(String(apiKey ?? ''))) throw new Error('Set PADDLE_API_KEY to a Paddle API key (pdl_sdbx_apikey_… or pdl_live_apikey_…).');
  const origin = new URL(site).origin;
  const hook = webhook === 'none' ? 'none' : webhook ?? `${origin}/functions/paddleWebhook`;
  const paddle = paddleApi(apiKey, { fetch: fetchFn });
  log(`Paddle ${paddle.sandbox ? 'sandbox' : 'live'} account`);

  let product = ((await paddle.get('/products?status=active&per_page=200')) ?? []).find((p) => p.custom_data?.app === APP);
  if (product) log(`Product: ${product.id} (already there)`);
  else {
    product = await paddle.post('/products', {
      name: 'Rocket in Cloud',
      tax_category: 'standard',
      description: 'OpenRocket in your browser, with live teamwork, a launch planner and a flight logbook.',
      custom_data: { app: APP },
    });
    log(`Product: ${product.id} (made)`);
  }

  const prices = {};
  const existing = ((await paddle.get(`/prices?product_id=${product.id}&status=active&per_page=200`)) ?? []);
  for (const [plan, p] of Object.entries(PLANS)) {
    const cents = String(Math.round(PRICES[plan] * 100));
    const found = existing.find((x) => x.custom_data?.plan === plan);
    if (found) {
      if (found.unit_price?.amount === cents && found.unit_price?.currency_code === 'USD') {
        log(`Price ${plan}: ${found.id} (already there)`);
        prices[plan] = found;
      } else {
        // The price changed in billing.js: new checkouts charge the new one. A subscription keeps
        // the price it began with unless it is changed in Paddle.
        prices[plan] = await paddle.patch(`/prices/${found.id}`, { unit_price: { amount: cents, currency_code: 'USD' } });
        log(`Price ${plan}: ${found.id} (changed from ${found.unit_price?.amount} ${found.unit_price?.currency_code} cents to US$${PRICES[plan]})`);
      }
      continue;
    }
    prices[plan] = await paddle.post('/prices', {
      product_id: product.id,
      name: p.name,
      description: p.description,
      unit_price: { amount: cents, currency_code: 'USD' },
      billing_cycle: p.recurring ? { interval: 'month', frequency: 1 } : null,
      tax_mode: taxMode,
      quantity: { minimum: 1, maximum: p.max },
      custom_data: { plan },
    });
    log(`Price ${plan}: ${prices[plan].id} (made, US$${PRICES[plan]}${p.recurring ? ' a month' : ''})`);
  }

  const checkoutUrl = `${origin}/account.html`;
  let checkoutSet = true;
  try {
    await paddle.patch('/settings/checkout-url', { default_url: checkoutUrl });
    log(`Default payment link: ${checkoutUrl}`);
  } catch (e) {
    checkoutSet = false;
    log(`Default payment link NOT set (${e.code ?? e.message}). Set it to ${checkoutUrl} in Paddle: Checkout > Checkout settings.${paddle.sandbox ? '' : ' A live account needs the domain approved first.'}`);
  }

  let secret = null;
  const destinations = hook === 'none' ? [] : (await paddle.get('/notification-settings')) ?? [];
  const known = destinations.find((n) => n.destination === hook && n.active !== false);
  if (hook === 'none') {
    log('Webhook: none made (--webhook none)');
  } else if (known) {
    log(`Webhook: ${known.id} → ${hook} (already there; its secret key is in Paddle: Developer tools > Notifications)`);
  } else {
    const made = await paddle.post('/notification-settings', {
      description: 'Rocket in Cloud plans',
      type: 'url',
      destination: hook,
      subscribed_events: EVENTS,
      api_version: 1,
      include_sensitive_fields: false,
      traffic_source: 'all',
    });
    secret = made.endpoint_secret_key ?? null;
    log(`Webhook: ${made.id} → ${hook} (made)`);
  }

  let clientToken = null;
  try {
    clientToken = (await paddle.post('/client-tokens', { name: 'Rocket in Cloud site', description: 'Paddle.js on the plan page' })).token ?? null;
    log('Client-side token: made');
  } catch (e) {
    log(`Client-side token NOT made (${e.code ?? e.message}). Make one in Paddle: Developer tools > Authentication.`);
  }
  return { sandbox: paddle.sandbox, product, prices, checkoutUrl, checkoutSet, webhook: hook, secret, clientToken };
}

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const site = arg('site');
  if (!site) {
    console.error('Usage: PADDLE_API_KEY=… node scripts/paddle-setup.mjs --site https://your.site [--webhook URL] [--tax external|internal] [--out FILE]');
    process.exit(2);
  }
  try {
    const r = await setUpPaddle({ apiKey: process.env.PADDLE_API_KEY, site, webhook: arg('webhook'), taxMode: arg('tax', 'external') });
    const secrets = [
      ['PADDLE_API_KEY', process.env.PADDLE_API_KEY],
      ['PADDLE_CLIENT_TOKEN', r.clientToken],
      ['PADDLE_WEBHOOK_SECRET', r.secret],
    ];
    const out = arg('out');
    if (out) {
      writeFileSync(out, `${secrets.filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join('\n')}\n`, { mode: 0o600 });
      console.log(`\nApp secrets written to ${out}.`);
    } else {
      console.log('\nSet these app secrets (in web/):');
      for (const [k, v] of secrets) {
        if (k === 'PADDLE_API_KEY') console.log('  base44 secrets set PADDLE_API_KEY=<the API key you used>');
        else console.log(v ? `  base44 secrets set ${k}=${v}` : `  base44 secrets set ${k}=<copy it from Paddle>`);
      }
    }
  } catch (e) {
    console.error(`Paddle setup failed: ${e.message}${e.code ? ` (${e.code})` : ''}`);
    process.exit(1);
  }
}
