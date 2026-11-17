// Plans on the pages (base44/shared/billing.js): the signed-in person's plan, the notice when they
// need one, and buying one in Paddle's checkout (Paddle.js, loaded only when someone buys).
import { api } from './base44.js';
import { h, modal } from './common.js';
import { testHub } from './room-client.js';

const DAY = 24 * 3600_000;
const PADDLE_JS = 'https://cdn.paddle.com/paddle/v2/paddle.js';

/** The plans as the site describes them (Paddle charges what scripts/paddle-setup.mjs set there). */
export const PLANS = {
  monthly: { name: 'Monthly', price: 'US$1', per: 'a month', points: ['Everything in Rocket in Cloud, for one person', 'Cancel at any time'] },
  lifetime: { name: 'Individual', price: 'US$5', per: 'once', points: ['Everything in Rocket in Cloud, for one person', 'Pay once, no subscription'] },
  group: { name: 'Group', price: 'US$10', per: 'once', points: ['You and 9 people you choose, for good', 'Change the people at any time', 'More people: US$3 each, once'] },
  openrocket: { name: 'OpenRocket', price: 'US$1', per: 'once', points: ['OpenRocket in your browser, for one person, for good', 'Without the Launch Planner and the Logbook'] },
};
export const SEAT_PRICE = 3;

let status = null;

/** The billing function's status for the signed-in person (asked once per page; `fresh` asks again). */
export function planStatus(fresh = false) {
  if (fresh || !status) {
    status = api('billing', { action: 'status' });
    status.catch(() => { status = null; });
  }
  return status;
}

export function setPlanStatus(st) {
  status = Promise.resolve(st);
}

export const daysLeft = (iso) => Math.max(0, Math.ceil((Date.parse(iso) - Date.now()) / DAY));
export const dateText = (iso) => new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });

let wallClosable = false;
let wall = null;

/** The dashboard: the plans notice can be closed (designs can still be downloaded there). */
export function allowClosingWall() {
  wallClosable = true;
}

/**
 * Tells them they need a plan, with the way to the plans. `upgrade`: they have the OpenRocket plan,
 * which does not include what they asked for (the Launch Planner or the Logbook).
 */
export function showPlanWall({ upgrade = false } = {}) {
  if (wall?.isConnected) return;
  const plans = h('a', { class: 'btn primary', href: '/account.html' }, 'See plans');
  const actions = wallClosable
    ? [h('button', { type: 'button', onclick: () => wall.close() }, 'Not now'), plans]
    : [h('a', { class: 'btn', href: '/' }, 'Your designs'), plans];
  ({ dialog: wall } = upgrade
    ? modal('Not part of your plan', h('div', { class: 'plan-wall' },
      h('p', {}, 'Your OpenRocket plan covers designing in OpenRocket. The Launch Planner and the Logbook come with the Monthly (US$1 a month), Individual (US$5 once) and Group plans.'),
      h('p', { class: 'hint' }, 'Your designs, launch plans and logbooks are kept.')), actions)
    : modal('Choose a plan to continue', h('div', { class: 'plan-wall' },
      h('p', {}, 'Your free week has ended. To keep designing, planning launches and keeping logbooks, choose a plan: US$1 a month, or pay once.'),
      h('p', { class: 'hint' }, 'Your work is kept, and you can still download your designs from your dashboard.')), actions));
  wall.classList.add('plan-wall-dialog');
  if (!wallClosable) wall.addEventListener('cancel', (e) => e.preventDefault());
}

// A function refused something for want of a plan (src/base44.js).
window.addEventListener('plan-required', (e) => showPlanWall({ upgrade: e.detail?.code === 'plan_upgrade' }));

/**
 * For the design, planner and logbook pages: resolves with their status if they may use the site
 * (with `full`, the Launch Planner and the Logbook, which the OpenRocket plan does not include);
 * otherwise shows the plans notice and never resolves. If their plan cannot be looked up, they are
 * let in (the site's functions check it too).
 */
export async function requirePlan({ full = false } = {}) {
  if (testHub()) return null; // a local test, without Base44
  let st;
  try {
    st = await planStatus();
  } catch {
    return null;
  }
  if (st.access.ok && (!full || st.access.full !== false)) return st;
  showPlanWall({ upgrade: st.access.ok });
  return new Promise(() => {});
}

// ------------------------------------------------------------------ Paddle's checkout

let paddle = null;
const listeners = new Set();

/** Paddle.js, set up with the site's client-side token. Pages Paddle links to (with ?_ptxn=) open its checkout then. */
export function loadPaddle({ token, sandbox }) {
  paddle ??= new Promise((resolve, reject) => {
    if (!token) {
      reject(new Error('Payments are not set up yet. Please try again later.'));
      return;
    }
    const script = h('script', { src: PADDLE_JS });
    script.onload = () => {
      try {
        if (sandbox) window.Paddle.Environment.set('sandbox');
        window.Paddle.Initialize({ token, eventCallback: (e) => { for (const fn of [...listeners]) fn(e); } });
        resolve(window.Paddle);
      } catch (e) {
        reject(e);
      }
    };
    script.onerror = () => {
      script.remove();
      reject(new Error('Paddle’s payment window could not load. Check your connection, or a blocker that stops paddle.com, and try again.'));
    };
    document.head.append(script);
  });
  paddle.catch(() => { paddle = null; });
  return paddle;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Right after paying: asks until the purchase is recorded (a subscription takes Paddle a few seconds). */
async function settle(transactionId) {
  let last = null;
  for (let i = 0; i < 16; i++) {
    try {
      const st = await api('billing', { action: 'sync', transactionId });
      if (!st.pending) {
        setPlanStatus(st);
        return st;
      }
    } catch (e) {
      last = e;
    }
    await sleep(Math.min(800 * (i + 1), 4000));
  }
  throw new Error(`Your payment went through, but it is taking a while to show here. Reload this page in a minute.${last ? ` (${last.message})` : ''}`);
}

/**
 * Buys `plan` ('monthly', 'lifetime', 'group' or 'seat', `quantity` of them) in Paddle's checkout,
 * over the page. Resolves with their new status once the purchase is recorded, or null if they
 * closed the checkout without paying. `onPaid` is called as soon as Paddle says it is paid.
 */
export async function buy(plan, { quantity = 1, onPaid = null } = {}) {
  const { transactionId, token, sandbox } = await api('billing', { action: 'checkout', plan, quantity });
  const Paddle = await loadPaddle({ token, sandbox });
  return new Promise((resolve, reject) => {
    let paid = false;
    const on = (e) => {
      if (e?.name === 'checkout.completed' && !paid) {
        paid = true;
        onPaid?.();
        settle(e.data?.transaction_id || transactionId).then(resolve, reject).finally(() => listeners.delete(on));
      } else if (e?.name === 'checkout.closed' && !paid) {
        listeners.delete(on);
        resolve(null);
      }
    };
    listeners.add(on);
    Paddle.Checkout.open({
      transactionId,
      settings: { displayMode: 'overlay', theme: 'light', allowLogout: false, showAddDiscounts: false },
    });
  });
}
