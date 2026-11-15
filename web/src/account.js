// The plan page: what the signed-in person has (free week, a plan, a place in someone's group),
// the plans to buy (Paddle's checkout over the page), their monthly plan (cancel, keep, payment
// details), and for a group's buyer, its people and more places. Rules in base44/shared/billing.js.
import './style.css';
import { api, currentUser, signOut } from './base44.js';
import { $, avatar, confirmDialog, h, icon, toast } from './common.js';
import { buy, dateText, daysLeft, loadPaddle, planStatus, PLANS, SEAT_PRICE, setPlanStatus } from './plan.js';

for (const el of document.querySelectorAll('[data-icon]')) el.replaceWith(icon(el.dataset.icon));

let me = null;
let st = null;

async function main() {
  me = await currentUser();
  $('#loading').hidden = true;
  if (!me) {
    $('#signed-out').hidden = false;
    return;
  }
  const out = h('button', { class: 'ghost', title: 'Sign out' }, icon('logout'), 'Sign out');
  out.onclick = signOut;
  $('#me').replaceChildren(avatar(me), h('span', { class: 'name' }, me.name), out);
  $('#me').hidden = false;
  $('#account').hidden = false;
  try {
    st = await planStatus(true);
  } catch (e) {
    $('#now').replaceChildren(h('p', { class: 'error' }, `Your plan could not be loaded: ${e.message}`));
    return;
  }
  render();
  // Paddle's emails link here (?_ptxn=…) to pay or to update a card: Paddle.js opens that checkout.
  if (new URLSearchParams(location.search).has('_ptxn') && st.sale) loadPaddle(st.sale).catch((e) => toast(e.message));
}

const forGood = () => ['admin', 'early', 'lifetime'].includes(st.access.kind);
const ownsGroup = () => (st.group?.seats ?? 0) > 0;

function render() {
  renderNow();
  renderGroup();
  renderPlans();
  $('#fine').replaceChildren(
    'Prices are in US dollars. Payments are handled by Paddle, which sells the plans on our behalf (merchant of record): its checkout shows the price in your currency where it can, and adds VAT or sales tax where your country requires it. Paddle emails your receipt. You can ask for a refund within 14 days of a payment: see the ',
    h('a', { href: '/refunds.html' }, 'Refund Policy'), '. Questions: ', h('a', { href: 'mailto:flykim73@gmail.com' }, 'flykim73@gmail.com'), '.');
}

/** Runs `fn` (a call that returns the new status) with `button` busy; shows what went wrong. */
async function busy(button, fn) {
  const label = button.textContent;
  button.disabled = true;
  try {
    const next = await fn();
    if (next) {
      st = next;
      setPlanStatus(st);
      render();
    }
    return next;
  } catch (e) {
    toast(e.message);
    return null;
  } finally {
    if (button.isConnected) {
      button.disabled = false;
      button.textContent = label;
    }
  }
}

function checkout(button, plan, quantity = 1) {
  return busy(button, async () => {
    button.textContent = 'Checkout open…';
    const next = await buy(plan, { quantity, onPaid: () => toast('Paid. Setting up your plan…') });
    if (next) toast('Thank you! Your plan is ready.');
    return next;
  });
}

// ------------------------------------------------------------------ what they have

function renderNow() {
  const a = st.access;
  const card = (title, text, ...actions) => h('div', { class: `acct-card acct-${a.kind}` },
    h('h3', {}, title), ...[text].flat().map((t) => (typeof t === 'string' ? h('p', {}, t) : t)),
    actions.length ? h('div', { class: 'row acct-actions' }, actions) : null);
  const owner = st.memberOf[0];
  let main;
  switch (a.kind) {
    case 'early':
      main = card('Free for good', 'You joined Rocket in Cloud before plans began, so it stays free for you. Thank you for being one of the first!');
      break;
    case 'admin':
      main = card('Free', 'You run this site.');
      break;
    case 'lifetime':
      main = card('Individual plan', 'Rocket in Cloud is yours for good. Thank you!');
      break;
    case 'group':
      main = ownsGroup()
        ? card('Group plan', `You and up to ${st.group.seats - 1} people you choose have Rocket in Cloud for good.`)
        : card(`In ${owner?.owner_name ?? 'someone'}’s group`, `${owner?.owner_name ?? 'Someone'}${owner?.owner_email ? ` (${owner.owner_email})` : ''} gave you a place in their group plan. If they take you off the list, you will need a plan of your own.`);
      break;
    case 'monthly':
      main = monthlyCard(`acct-card acct-${a.kind}`);
      break;
    case 'open':
      main = card('Free for now', 'Plans have not begun yet, so Rocket in Cloud is free for everyone. When they begin, you get a free week, and then you choose a plan below.');
      break;
    case 'trial': {
      const n = daysLeft(a.trialEnds);
      main = card(`Free week: ${n} ${n === 1 ? 'day' : 'days'} left`, `Your free week ends on ${dateText(a.trialEnds)}. To keep using Rocket in Cloud after that, choose a plan below. No card needed until then.`);
      break;
    }
    default:
      main = card('Your free week has ended', 'Choose a plan below to keep designing, planning launches and keeping logbooks. Your work is kept: you can still download your designs from your dashboard.');
  }
  const parts = [main];
  // A monthly plan still running beside a plan for good (until the end of the month paid for).
  if (st.monthly && a.kind !== 'monthly') parts.push(monthlyCard());
  if (st.bought && st.sale) {
    const portal = h('button', { class: 'ghost link' }, 'Payment details and receipts');
    portal.onclick = () => busy(portal, async () => {
      // Opened at once (a window opened after waiting would be blocked), then sent to Paddle.
      const win = window.open('', '_blank');
      try {
        const { url } = await api('billing', { action: 'portal' });
        if (!url) throw new Error('Paddle did not answer. Please try again.');
        if (win) win.location.href = url;
        else location.href = url;
      } catch (e) {
        win?.close();
        throw e;
      }
      return null;
    });
    parts.push(h('p', { class: 'acct-portal' }, portal, h('span', { class: 'hint' }, ' at Paddle: change your card, download invoices.')));
  }
  $('#now').replaceChildren(...parts);
}

function monthlyCard(cls = 'acct-card acct-sub') {
  const m = st.monthly;
  const box = (text, ...actions) => h('div', { class: cls }, h('h3', {}, 'Monthly plan'), h('p', {}, text),
    actions.length ? h('div', { class: 'row acct-actions' }, actions) : null);
  if (m.cancelAt) {
    const keep = h('button', { class: 'primary' }, 'Keep my plan');
    keep.onclick = () => busy(keep, () => api('billing', { action: 'resume' }));
    const why = forGood() || st.access.kind === 'group' ? ' You don’t need it any more.' : '';
    return box(`Cancelled: it ends on ${dateText(m.cancelAt)}, and you are not charged again.${why}`, ...(why ? [] : [keep]));
  }
  if (m.status === 'past_due') {
    return box('Your last monthly payment did not go through. Paddle will try again; to keep your plan, update your card under “Payment details and receipts” below.');
  }
  const cancel = h('button', {}, 'Cancel plan');
  cancel.onclick = async () => {
    const end = m.endsAt ? dateText(m.endsAt) : 'the end of the month you paid for';
    if (!(await confirmDialog('Cancel your monthly plan?', `It keeps working until ${end}, and you are not charged again. You can change your mind until then.`, 'Cancel plan', true))) return;
    busy(cancel, () => api('billing', { action: 'cancel' }));
  };
  return box(`Everything in Rocket in Cloud, for US$1 a month. ${m.endsAt ? `Renews on ${dateText(m.endsAt)}.` : 'Renews every month.'}`, cancel);
}

// ------------------------------------------------------------------ plans to buy

function renderPlans() {
  const sale = Boolean(st.sale);
  const card = (plan, { state = null, note = null, label = null } = {}) => {
    const p = PLANS[plan];
    const button = state
      ? h('div', { class: 'plan-state' }, icon('check'), state)
      : h('button', { class: 'primary', disabled: !sale }, label ?? `Buy for ${p.price}`);
    if (!state) button.onclick = () => checkout(button, plan);
    return h('article', { class: `plan-card${state ? ' current' : ''}`, 'data-plan': plan },
      h('h3', {}, p.name),
      h('div', { class: 'price' }, h('b', {}, p.price), h('span', {}, ` ${p.per}`)),
      h('ul', {}, p.points.map((t) => h('li', {}, icon('check'), h('span', {}, t)))),
      note ? h('p', { class: 'hint' }, note) : null,
      button);
  };
  const cards = [];
  if (!forGood()) {
    cards.push(card('monthly', st.monthly ? { state: st.monthly.cancelAt ? `Yours until ${dateText(st.monthly.cancelAt)}` : 'Your plan' } : {}));
    cards.push(card('lifetime', st.monthly && !st.monthly.cancelAt ? { note: 'Your monthly plan then stops at the end of the month you paid for.', label: 'Switch for US$4' } : {}));
  }
  cards.push(card('group', ownsGroup() ? { state: 'You have this' } : {}));
  const title = forGood() ? 'For your team' : ['open', 'trial', 'none'].includes(st.access.kind) ? 'Choose a plan' : 'Other plans';
  $('#plans').replaceChildren(...[
    h('h3', { class: 'acct-title' }, title),
    sale ? null : h('p', { class: 'notice' }, 'Payments open soon. Until then, your free week keeps going.'),
    h('div', { class: 'plan-cards' }, cards),
  ].filter(Boolean));
}

// ------------------------------------------------------------------ the group

function renderGroup() {
  const section = $('#group');
  section.hidden = !st.group;
  if (!st.group) return;
  const { seats, members } = st.group;
  const admitted = members.filter((m) => m.admitted).length;
  const error = h('p', { class: 'error', role: 'alert' });
  const save = (list, button) => busy(button, async () => {
    error.textContent = '';
    try {
      return await api('billing', { action: 'members', members: list });
    } catch (e) {
      error.textContent = e.message;
      return null;
    }
  });

  const rows = members.map((m) => {
    const remove = h('button', { class: 'ghost icon', title: `Take ${m.email} off the list`, 'aria-label': `Remove ${m.email}` }, icon('x'));
    remove.onclick = () => save(members.map((x) => x.email).filter((e) => e !== m.email), remove);
    return h('div', { class: 'item' }, avatar({ name: m.email, email: m.email }),
      h('div', { class: 'grow' }, h('div', {}, m.email), m.admitted ? null : h('div', { class: 'sub warn' }, 'No place: take someone off, or add places')),
      remove);
  });

  // A box of several lines, so that a pasted list keeps its line breaks; Enter adds.
  const input = h('textarea', { rows: 1, inputmode: 'email', autocomplete: 'off', spellcheck: 'false', placeholder: 'name@gmail.com', 'aria-label': 'Google account email addresses' });
  const add = h('button', { class: 'primary', type: 'submit' }, icon('plus'), 'Add');
  const form = h('form', { class: 'row group-add' }, input, add);
  input.onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      form.requestSubmit();
    }
  };
  form.onsubmit = async (e) => {
    e.preventDefault();
    // Several at once: separated by commas, spaces or new lines.
    const typed = input.value.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);
    if (!typed.length) return;
    const next = await save([...members.map((m) => m.email), ...typed], add);
    if (next) input.value = '';
  };
  const full = members.length >= seats - 1;

  const qty = h('input', { type: 'number', min: 1, max: 100, value: 1, 'aria-label': 'How many places to add', class: 'qty' });
  const more = h('button', { disabled: !st.sale }, '');
  const price = () => {
    const n = Math.max(1, Math.min(100, Math.floor(Number(qty.value)) || 1));
    more.textContent = `Buy ${n} more ${n === 1 ? 'place' : 'places'} for US$${n * SEAT_PRICE}`;
    return n;
  };
  qty.oninput = price;
  price();
  more.onclick = () => checkout(more, 'seat', price());

  section.replaceChildren(
    h('h3', { class: 'acct-title' }, 'Your group'),
    h('div', { class: 'acct-card' },
      h('p', { class: 'group-count' }, h('b', {}, `${1 + admitted} of ${seats}`), ` places used: you and ${admitted} ${admitted === 1 ? 'person' : 'people'}.`),
      h('p', { class: 'hint' }, 'Add the address each person signs in with (their Google account, such as name@gmail.com or a school Google account). They can use Rocket in Cloud as soon as they sign in. Take someone off the list and they lose it; their work stays theirs.'),
      members.length ? h('div', { class: 'list group-list' }, rows) : h('p', { class: 'hint' }, 'Nobody added yet.'),
      full ? h('p', { class: 'hint' }, 'Your group is full. Take someone off, or add places below.') : form,
      error,
      h('div', { class: 'row group-more' }, h('span', { class: 'grow' }, `More than ${seats} people? Add places, US$${SEAT_PRICE} each, once.`), qty, more)));
}

main();
