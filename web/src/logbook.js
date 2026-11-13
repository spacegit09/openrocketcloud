// The flight logbook (logbook.html): your logbooks as cards, and a logbook with its flight details
// and notes, flight data (entered in a fixed format, or from OpenRocket's simulations and Launch
// Planner plans) drawn as graphs, photos and videos, sharing, and a printable report (PDF).
// Logbooks are sealed records reached through the logbooks function (base44/shared/logbooks.js);
// photos and videos are Base44 private files, uploaded from here under random names.
import './style.css';
import './logbook/logbook.css';
import { api, base44, currentUser } from './base44.js';
import {
  $, h, icon, avatar, timeAgo, toast, modal, confirmDialog, promptDialog, shareDialog, SHARE_LOGBOOK,
} from './common.js';
import {
  QUANTITIES, TIME_UNITS, OR_DEFAULTS, columnLabel, datasetFromPlan, datasetFromSimulation, formatInstructions,
  formatNumber, graphGroups, parseRows, simulationsFromXml, summarize, templateCsv,
} from './logbook/data.js';
import { lineChart, sparkSvg } from './logbook/chart.js';

for (const el of document.querySelectorAll('[data-icon]')) el.replaceWith(icon(el.dataset.icon));

const params = new URLSearchParams(location.search);
let me = null;
let book = null; // the logbook open, as the logbooks function gives it
const urls = new Map(); // media id -> { url, at }: signed links, an hour each
const UNITS_KEY = 'orc-logbook-units';
let units = (() => {
  try {
    return localStorage.getItem(UNITS_KEY) === 'imperial' ? 'imperial' : 'metric';
  } catch {
    return 'metric';
  }
})();

const call = (action, body = {}) => api('logbooks', { action, ...body });
const canEdit = () => book && book.role !== 'viewer';
const SOURCES = { entered: 'Entered', openrocket: 'OpenRocket', planner: 'Launch Planner' };
const OUTCOMES = ['', 'Success', 'Partial success', 'Failure', 'Scrubbed'];
const DETAIL_FIELDS = [
  ['date', 'Date', 'date'], ['time', 'Time', 'time'], ['location', 'Location', 'text', 'Launch site, or latitude, longitude'],
  ['rocket', 'Rocket', 'text', 'Name or design'], ['motor', 'Motor', 'text', 'e.g. F42-8T'], ['weather', 'Weather', 'text', 'Wind, temperature, clouds'],
  ['outcome', 'Outcome', 'select'],
];

function debounce(fn, ms) {
  let t = null;
  const run = (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
  run.flush = () => {
    clearTimeout(t);
    fn();
  };
  return run;
}

/** Puts `kids` in `el`, leaving out the missing ones (replaceChildren would write "null"). */
function fill(el, ...kids) {
  el.replaceChildren(...kids.flat().filter((k) => k != null && k !== false));
}

function saveFile(text, name, type = 'text/csv') {
  const a = h('a', { href: URL.createObjectURL(new Blob([text], { type })), download: name });
  document.body.append(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 1000);
}

function formatBytes(n) {
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} kB`;
}

function formatDate(d) {
  if (!d?.date) return '';
  const day = new Date(`${d.date}T${d.time || '12:00'}`);
  if (Number.isNaN(day.getTime())) return d.date;
  return day.toLocaleDateString([], { dateStyle: 'medium' }) + (d.time ? ` ${d.time}` : '');
}

// ------------------------------------------------------------------ home: your logbooks

let books = [];

async function showBooks() {
  $('#books').hidden = false;
  $('#book-search').oninput = renderBooks;
  $('#new-book').onclick = newBook;
  $('#new-book-2').onclick = newBook;
  document.addEventListener('click', () => document.querySelectorAll('.menu').forEach((m) => (m.hidden = true)));
  try {
    books = await call('list');
  } catch (e) {
    toast(e.message);
    books = [];
  }
  renderBooks();
}

function renderBooks() {
  const q = $('#book-search').value.trim().toLowerCase();
  const text = (b) => [b.title, b.details?.location, b.details?.rocket, b.details?.motor, b.owner_name].join(' ').toLowerCase();
  const shown = books.filter((b) => !q || text(b).includes(q));
  $('#books-empty').hidden = books.length > 0;
  $('#book-grid').replaceChildren(...shown.map(bookCard));
}

async function newBook() {
  const today = new Date();
  const pad = (x) => String(x).padStart(2, '0');
  const date = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
  const title = await promptDialog('New logbook', 'Title', `Flight ${today.toLocaleDateString([], { dateStyle: 'medium' })}`, 'Create');
  if (!title) return;
  try {
    const b = await call('create', { title, details: { date } });
    location.href = `/logbook.html?id=${encodeURIComponent(b.id)}`;
  } catch (e) {
    toast(e.message);
  }
}

function bookCard(b) {
  const open = () => { location.href = `/logbook.html?id=${encodeURIComponent(b.id)}`; };
  const thumb = h('div', { class: 'thumb lb-thumb' });
  if (b.cover) thumb.append(h('img', { src: b.cover, alt: '' }));
  else if (b.spark?.length > 1) thumb.append(sparkSvg(b.spark));
  else thumb.append(icon('book'));
  thumb.onclick = open;
  const more = h('button', { class: 'ghost icon', title: 'More', 'aria-label': `More actions for ${b.title}` }, icon('more'));
  const menu = h('div', { class: 'menu', hidden: true });
  const item = (ic, label, fn, cls) => {
    const btn = h('button', { class: cls }, icon(ic), label);
    btn.onclick = (e) => {
      e.stopPropagation();
      menu.hidden = true;
      fn();
    };
    return btn;
  };
  menu.append(item('book', 'Open', open));
  if (b.role === 'owner') {
    menu.append(item('share', 'Share', () => shareDialog(b.id, me, () => showBooksAgain(), SHARE_LOGBOOK)), h('hr'),
      item('trash', 'Delete', () => deleteBook(b), 'danger'));
  } else {
    menu.append(h('hr'), item('logout', 'Leave', () => leaveBook(b), 'danger'));
  }
  more.onclick = (e) => {
    e.stopPropagation();
    document.querySelectorAll('.menu').forEach((m) => m !== menu && (m.hidden = true));
    menu.hidden = !menu.hidden;
    if (!menu.hidden) {
      menu.classList.remove('up');
      if (menu.getBoundingClientRect().bottom > window.innerHeight - 8) menu.classList.add('up');
    }
  };
  const d = b.details ?? {};
  const counts = [
    b.datasets ? `${b.datasets} data set${b.datasets === 1 ? '' : 's'}` : null,
    b.photos ? `${b.photos} photo${b.photos === 1 ? '' : 's'}` : null,
    b.videos ? `${b.videos} video${b.videos === 1 ? '' : 's'}` : null,
  ].filter(Boolean).join(' · ');
  const people = (b.members ?? []).length;
  return h('article', { class: 'card', 'data-id': b.id },
    thumb,
    h('div', { class: 'body', onclick: open },
      h('h3', { title: b.title }, b.title),
      h('div', { class: 'meta' }, [formatDate(d), d.location].filter(Boolean).join(' · ') || 'No date or place yet'),
      d.rocket || d.motor ? h('div', { class: 'meta' }, [d.rocket, d.motor].filter(Boolean).join(' · ')) : null,
      h('div', { class: 'meta' },
        counts ? h('span', {}, counts) : null,
        b.role !== 'owner' ? h('span', {}, `· ${b.owner_name ?? b.owner_email}`) : null,
        people ? h('span', { class: 'badge' }, `${people + 1} people`) : null,
        b.role === 'viewer' ? h('span', { class: 'badge' }, 'View only') : null)),
    h('div', { class: 'foot' },
      h('span', { class: 'hint' }, `Edited ${timeAgo(Date.parse(b.edited_at ?? b.updated_date) || Date.now())}`),
      h('span', { class: 'spacer' }),
      h('span', { class: 'menu-wrap' }, more, menu)));
}

async function showBooksAgain() {
  books = await call('list').catch(() => books);
  renderBooks();
}

async function deleteBook(b) {
  if (!(await confirmDialog('Delete logbook?', `“${b.title}” will be deleted for everyone it is shared with, with its data. This cannot be undone.`, 'Delete', true))) return;
  try {
    await call('delete', { id: b.id });
    await showBooksAgain();
  } catch (e) {
    toast(e.message);
  }
}

async function leaveBook(b) {
  if (!(await confirmDialog('Leave logbook?', `You will lose access to “${b.title}” until someone shares it with you again.`, 'Leave', true))) return;
  try {
    await call('leave', { id: b.id });
    await showBooksAgain();
  } catch (e) {
    toast(e.message);
  }
}

// ------------------------------------------------------------------ a logbook

const saveState = h('span', { class: 'hint lb-save' });
const pending = {}; // fields waiting to be saved
const flushSave = debounce(async () => {
  const body = { ...pending };
  for (const k of Object.keys(pending)) delete pending[k];
  if (!Object.keys(body).length) return;
  saveState.textContent = 'Saving…';
  try {
    const b = await call('update', { id: book.id, ...body });
    book = { ...book, version: b.version, edited_at: b.edited_at };
    saveState.textContent = 'Saved';
  } catch (e) {
    saveState.textContent = `Not saved: ${e.message}`;
    Object.assign(pending, body, pending);
  }
}, 700);
window.addEventListener('beforeunload', (e) => {
  if (Object.keys(pending).length) {
    flushSave.flush();
    e.preventDefault();
  }
});

/** A field change, saved a moment later with any others. */
function change(field, value) {
  if (field.startsWith('details.')) {
    book.details = { ...book.details, [field.slice(8)]: value };
    pending.details = { ...(pending.details ?? {}), [field.slice(8)]: value };
  } else {
    book[field] = value;
    pending[field] = value;
  }
  saveState.textContent = 'Editing…';
  flushSave();
}

let lastWidth = 0;
window.addEventListener('resize', debounce(() => {
  const w = $('#lb-data')?.clientWidth ?? 0;
  if (book && Math.abs(w - lastWidth) > 40) {
    lastWidth = w;
    renderData();
  }
}, 200));

async function showBook(id) {
  const main = $('#book');
  main.hidden = false;
  main.replaceChildren(h('p', { class: 'hint' }, 'Opening the logbook…'));
  try {
    book = await call('get', { id });
  } catch (e) {
    main.replaceChildren(h('div', { class: 'empty' }, h('h3', {}, 'Logbook not found'), h('p', {}, e.message),
      h('a', { class: 'btn', href: '/logbook.html' }, 'All logbooks')));
    return;
  }
  document.title = `${book.title} — Logbook`;
  renderBook();
  refreshUrls().then(renderMedia).catch(() => {});
}

/** The whole logbook page (on opening it). */
function renderBook() {
  const main = $('#book');
  const edit = canEdit();
  const title = edit
    ? h('input', { class: 'lb-title', value: book.title, 'aria-label': 'Title', maxlength: 200 })
    : h('h2', { class: 'lb-title' }, book.title);
  if (edit) {
    title.oninput = () => {
      if (title.value.trim()) change('title', title.value.trim());
    };
  }
  const share = h('button', {}, icon('share'), 'Share');
  share.onclick = () => shareDialog(book.id, me, (p) => Object.assign(book, p), SHARE_LOGBOOK);
  const people = h('button', { class: 'ghost' }, icon('users'), 'People');
  people.onclick = () => shareDialog(book.id, me, null, SHARE_LOGBOOK);
  const pdf = h('button', {}, icon('download'), 'Export PDF');
  pdf.onclick = exportPdf;
  main.replaceChildren(
    h('div', { class: 'lb-head' },
      h('a', { class: 'btn ghost', href: '/logbook.html', title: 'All logbooks' }, icon('back'), 'Logbooks'),
      title,
      book.role === 'viewer' ? h('span', { class: 'badge' }, 'View only') : null,
      h('span', { class: 'spacer' }),
      saveState,
      book.role === 'owner' ? share : people,
      pdf),
    h('div', { class: 'lb-top' }, detailsCard(), textCard()),
    h('section', { class: 'lb-card', id: 'lb-data' }),
    h('section', { class: 'lb-card', id: 'lb-media' }));
  renderData();
  renderMedia();
}

function detailsCard() {
  const edit = canEdit();
  const d = book.details ?? {};
  const fields = DETAIL_FIELDS.map(([k, label, type, placeholder]) => {
    let input;
    if (type === 'select') {
      input = h('select', { disabled: !edit }, ...OUTCOMES.map((o) => h('option', { value: o, selected: (d[k] ?? '') === o }, o || '—')));
      input.onchange = () => change(`details.${k}`, input.value);
    } else {
      input = h('input', { type, value: d[k] ?? '', placeholder: placeholder ?? '', readonly: !edit, maxlength: 200 });
      input.oninput = () => change(`details.${k}`, input.value);
    }
    return h('label', { class: `lb-field lb-${k}` }, h('span', {}, label), input);
  });
  return h('section', { class: 'lb-card lb-details' }, h('h3', {}, 'Flight details'), h('div', { class: 'lb-fields' }, fields));
}

function textCard() {
  const edit = canEdit();
  const area = (field, label, placeholder) => {
    const t = h('textarea', { rows: 5, placeholder, readonly: !edit, maxlength: 20000 });
    t.value = book[field] ?? '';
    t.oninput = () => change(field, t.value);
    return h('label', { class: 'lb-field' }, h('span', {}, label), t);
  };
  return h('section', { class: 'lb-card lb-text' },
    area('description', 'Description', 'What you flew and how the flight went'),
    area('notes', 'Additional notes', 'Preparation, recovery, lessons, anything else'));
}

// ------------------------------------------------------------------ flight data and graphs

function renderData() {
  const sec = $('#lb-data');
  if (!sec) return;
  const edit = canEdit();
  const unitSel = h('select', { 'aria-label': 'Units in the graphs' },
    h('option', { value: 'metric', selected: units === 'metric' }, 'Metric (m, m/s)'),
    h('option', { value: 'imperial', selected: units === 'imperial' }, 'Imperial (ft, ft/s)'));
  unitSel.onchange = () => {
    units = unitSel.value;
    try {
      localStorage.setItem(UNITS_KEY, units);
    } catch {
      // private window
    }
    renderData();
  };
  const add = h('button', { class: 'primary' }, icon('plus'), 'Add flight data');
  add.onclick = addDataDialog;
  const fromOr = h('button', {}, icon('rocket'), 'From OpenRocket');
  fromOr.onclick = openRocketDialog;
  const fromPlan = h('button', {}, icon('target'), 'From Launch Planner');
  fromPlan.onclick = planDialog;
  const groups = graphGroups(book.datasets, units);
  // Graphs drawn at the width they get, so their lettering stays readable.
  const inner = Math.max(300, sec.clientWidth - 34);
  const two = inner >= 900;
  const chartWidth = Math.round(two ? (inner - 14) / 2 - 22 : inner - 22);
  fill(sec,
    h('div', { class: 'lb-sec-head' },
      h('h3', {}, 'Flight data'),
      h('span', { class: 'spacer' }),
      book.datasets.length ? unitSel : null,
      edit ? fromOr : null,
      edit ? fromPlan : null,
      edit ? add : null),
    book.datasets.length
      ? h('div', { class: 'lb-datasets' }, book.datasets.map(datasetRow))
      : h('p', { class: 'hint' }, edit
        ? 'Add what your altimeter or flight computer recorded, as CSV or text, and compare it with OpenRocket\'s simulation and the Launch Planner\'s prediction.'
        : 'No flight data yet.'),
    groups.length ? h('div', { class: `lb-charts${two ? ' two' : ''}` }, groups.map((g) => lineChart(g, { width: chartWidth, height: Math.round(Math.min(300, Math.max(230, chartWidth * 0.42))) }))) : null,
    book.datasets.length ? statsTable() : null);
}

function datasetRow(ds) {
  const edit = canEdit();
  const s = summarize(ds);
  const from = ds.from ?? {};
  const link = from.designId ? h('a', { href: `/design.html?id=${encodeURIComponent(from.designId)}` }, from.design)
    : from.planId ? h('a', { href: `/planner.html?flight=${encodeURIComponent(from.planId)}` }, from.plan) : null;
  const offset = h('input', { type: 'number', step: '0.01', value: ds.offset ?? 0, readonly: !edit, 'aria-label': 'Time shift (s)', title: 'Shift this data set in time (seconds), to line it up with the others' });
  offset.onchange = () => datasetChange(ds, { offset: Number(offset.value) || 0 });
  const show = h('button', { class: 'ghost icon', title: ds.hidden ? 'Show in the graphs' : 'Hide from the graphs', 'aria-pressed': String(!ds.hidden) }, icon(ds.hidden ? 'eye-off' : 'eye'));
  show.onclick = () => datasetChange(ds, { hidden: !ds.hidden });
  const rename = h('button', { class: 'ghost icon', title: 'Rename' }, icon('edit'));
  rename.onclick = async () => {
    const name = await promptDialog('Rename data set', 'Name', ds.name, 'Rename');
    if (name) datasetChange(ds, { name });
  };
  const csv = h('button', { class: 'ghost icon', title: 'Download as CSV' }, icon('download'));
  csv.onclick = () => saveFile([[`Time (${ds.time})`, ...ds.columns.map(columnLabel)].join(','), ...ds.rows.map((r) => r.join(','))].join('\n') + '\n', `${ds.name}.csv`);
  const remove = h('button', { class: 'ghost icon danger', title: 'Remove' }, icon('trash'));
  remove.onclick = async () => {
    if (!(await confirmDialog('Remove data set?', `“${ds.name}” will be removed from this logbook.`, 'Remove', true))) return;
    await mutate('removeDataset', { datasetId: ds.id });
  };
  return h('div', { class: `lb-dataset${ds.hidden ? ' off' : ''}` },
    h('div', { class: 'grow' },
      h('div', { class: 'name' }, ds.name, ' ', h('span', { class: 'badge' }, SOURCES[ds.source] ?? 'Entered')),
      h('div', { class: 'sub' },
        [ds.columns.map(columnLabel).join(', '), `${s.rows.toLocaleString()} rows`, `${formatNumber(s.span[0])}–${formatNumber(s.span[1])} s`].join(' · '),
        link ? h('span', {}, ' · from ', link) : null)),
    h('label', { class: 'lb-offset' }, h('span', {}, 'Shift (s)'), offset),
    show, csv, edit ? rename : null, edit ? remove : null);
}

async function datasetChange(ds, change) {
  if (!canEdit()) {
    // Viewers can still hide data sets from their own view.
    Object.assign(ds, change);
    renderData();
    return;
  }
  await mutate('updateDataset', { datasetId: ds.id, ...change });
}

/** Saves a change to the logbook's data or media and draws them again. */
async function mutate(action, body) {
  saveState.textContent = 'Saving…';
  try {
    const b = await call(action, { id: book.id, ...body });
    book = { ...book, ...b, title: book.title, details: book.details, description: book.description, notes: book.notes };
    saveState.textContent = 'Saved';
    renderData();
    renderMedia();
    return b;
  } catch (e) {
    saveState.textContent = '';
    toast(e.message);
    throw e;
  }
}

function statsTable() {
  const rows = [];
  for (const ds of book.datasets) {
    const s = summarize(ds);
    for (const c of s.columns) {
      rows.push(h('tr', {},
        h('td', {}, ds.name), h('td', {}, c.label),
        h('td', { class: 'num' }, c.max === null ? '–' : `${formatNumber(c.max)}${c.unit ? ` ${c.unit}` : ''}`),
        h('td', { class: 'num' }, c.at === null ? '–' : `${formatNumber(c.at + (Number(ds.offset) || 0))} s`),
        h('td', { class: 'num' }, c.min === null ? '–' : `${formatNumber(c.min)}${c.unit ? ` ${c.unit}` : ''}`)));
    }
  }
  return h('details', { class: 'lb-stats', open: book.datasets.length <= 3 },
    h('summary', {}, 'Highest and lowest values'),
    h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Data set'), h('th', {}, 'Column'), h('th', { class: 'num' }, 'Highest'), h('th', { class: 'num' }, 'At'), h('th', { class: 'num' }, 'Lowest'))),
      h('tbody', {}, rows)));
}

// ---------- entering data

const UNIT_CHOICES = Object.fromEntries(Object.entries(QUANTITIES).map(([q, d]) => [q, Object.keys(d.units)]));

function addDataDialog() {
  const spec = { name: 'Altimeter', time: 's', picks: { altitude: 'm', velocity: null, acceleration: null }, custom: [] };
  const name = h('input', { value: spec.name, maxlength: 120, 'aria-label': 'Name of the data set' });
  const timeUnit = h('select', {}, Object.keys(TIME_UNITS).map((u) => h('option', { value: u }, u === 's' ? 'seconds (s)' : 'milliseconds (ms)')));
  const columnsBox = h('div', { class: 'lb-cols' });
  const customBox = h('div', { class: 'lb-custom' });
  const addCustom = h('button', { type: 'button', class: 'ghost' }, icon('plus'), 'Add a custom column');
  const instructions = h('div', { class: 'lb-format' });
  const text = h('textarea', { rows: 9, spellcheck: false, class: 'mono', 'aria-label': 'Flight data' });
  const file = h('input', { type: 'file', accept: '.csv,.txt,text/csv,text/plain' });
  const result = h('div', { class: 'lb-result' });
  const ok = h('button', { class: 'primary', disabled: true }, 'Add to logbook');
  const cancel = h('button', {}, 'Cancel');

  const dataset = () => ({
    name: name.value.trim() || 'Flight data',
    source: 'entered',
    time: timeUnit.value,
    offset: 0,
    columns: [
      ...Object.entries(spec.picks).filter(([, u]) => u).map(([q, unit]) => ({ q, unit, name: QUANTITIES[q].label })),
      ...spec.custom.filter((c) => c.name.trim()).map((c) => ({ q: 'custom', unit: c.unit.trim(), name: c.name.trim() })),
    ],
  });
  let parsed = null;
  const check = () => {
    const ds = dataset();
    parsed = null;
    ok.disabled = true;
    if (!ds.columns.length) {
      instructions.replaceChildren(h('p', { class: 'error' }, 'Choose at least one kind of data besides time.'));
      result.replaceChildren();
      return;
    }
    const f = formatInstructions(ds);
    const tmpl = h('button', { type: 'button', class: 'ghost link' }, icon('download'), 'Download a template (.csv)');
    tmpl.onclick = () => saveFile(templateCsv(ds), `${ds.name} template.csv`);
    instructions.replaceChildren(
      h('ol', { class: 'lb-order' }, f.columns.map((c) => h('li', {}, c.replace(/^Column \d+: /, '')))),
      h('p', { class: 'hint' }, 'One row per line, the values separated by commas, in the order above. Use a decimal point (1.5, not 1,5). A first line of column names is fine; blank lines and lines starting with # are skipped.'),
      h('div', { class: 'lb-example' }, h('span', { class: 'hint' }, 'Example'), h('pre', {}, [f.header, ...f.example].join('\n'))),
      tmpl);
    text.placeholder = [f.header, ...f.example].join('\n');
    if (!text.value.trim()) {
      result.replaceChildren();
      return;
    }
    const { rows, errors } = parseRows(text.value, ds);
    if (errors.length) {
      result.replaceChildren(h('div', { class: 'error' }, h('b', {}, 'Please fix:'), h('ul', {}, errors.map((e) => h('li', {}, e)))));
      result.scrollIntoView({ block: 'nearest' });
      return;
    }
    parsed = { ...ds, rows };
    const s = summarize(parsed);
    const head = [`Time (${ds.time})`, ...ds.columns.map(columnLabel)];
    const shown = rows.length > 6 ? [...rows.slice(0, 5), null, rows[rows.length - 1]] : rows;
    result.replaceChildren(
      h('p', { class: 'ok' }, icon('check'), ` ${rows.length.toLocaleString()} rows, ${formatNumber(s.span[0])} to ${formatNumber(s.span[1])} s. `,
        s.columns.map((c) => `${c.label} highest ${formatNumber(c.max)} at ${formatNumber(c.at)} s`).join('; ')),
      h('table', { class: 'lb-preview' }, h('thead', {}, h('tr', {}, head.map((x) => h('th', {}, x)))),
        h('tbody', {}, shown.map((r) => (r ? h('tr', {}, r.map((v) => h('td', {}, String(v)))) : h('tr', {}, h('td', { colspan: head.length }, '…')))))));
    ok.disabled = false;
    result.scrollIntoView({ block: 'nearest' });
  };
  const recheck = debounce(check, 250);

  const renderColumns = () => {
    columnsBox.replaceChildren(...Object.keys(spec.picks).map((q) => {
      const box = h('input', { type: 'checkbox', checked: Boolean(spec.picks[q]) });
      const unit = h('select', { disabled: !spec.picks[q], 'aria-label': `${QUANTITIES[q].label} unit` },
        UNIT_CHOICES[q].map((u) => h('option', { value: u, selected: u === (spec.picks[q] ?? UNIT_CHOICES[q][0]) }, u)));
      box.onchange = () => {
        spec.picks[q] = box.checked ? unit.value : null;
        unit.disabled = !box.checked;
        check();
      };
      unit.onchange = () => {
        spec.picks[q] = unit.value;
        check();
      };
      return h('div', { class: 'lb-col' }, h('label', { class: 'check' }, box, QUANTITIES[q].label), unit);
    }));
    customBox.replaceChildren(...spec.custom.map((c, i) => {
      const n = h('input', { value: c.name, placeholder: 'Name, e.g. Pressure', maxlength: 60 });
      const u = h('input', { value: c.unit, placeholder: 'Unit, e.g. hPa', maxlength: 20, class: 'unit' });
      const rm = h('button', { type: 'button', class: 'ghost icon', title: 'Remove' }, icon('x'));
      n.oninput = () => { c.name = n.value; recheck(); };
      u.oninput = () => { c.unit = u.value; recheck(); };
      rm.onclick = () => {
        spec.custom.splice(i, 1);
        renderColumns();
        check();
      };
      return h('div', { class: 'lb-col' }, n, u, rm);
    }));
  };
  addCustom.onclick = () => {
    if (dataset().columns.length + spec.custom.length >= 12) return toast('Up to 12 columns besides time.');
    spec.custom.push({ name: '', unit: '' });
    renderColumns();
    customBox.lastElementChild?.querySelector('input')?.focus();
  };
  renderColumns();
  name.oninput = recheck;
  timeUnit.onchange = check;
  text.oninput = recheck;
  file.onchange = async () => {
    const f = file.files?.[0];
    if (!f) return;
    if (f.size > 20e6) return toast('That file is larger than 20 MB.');
    text.value = await f.text();
    if (name.value === 'Altimeter') name.value = f.name.replace(/\.[^.]+$/, '');
    check();
  };

  const { dialog, close } = modal('Add flight data', [
    h('label', { class: 'lb-field' }, h('span', {}, 'Name'), name),
    h('div', { class: 'lb-step' }, h('h4', {}, '1. What does your data have?'),
      h('div', { class: 'lb-col' }, h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: true, disabled: true }), 'Time (always the first column)'), timeUnit),
      columnsBox, customBox, addCustom),
    h('div', { class: 'lb-step' }, h('h4', {}, '2. Put the columns in this order'), instructions),
    h('div', { class: 'lb-step' }, h('h4', {}, '3. Paste the data, or open a CSV file'),
      h('div', { class: 'row' }, file), text, result),
  ], [cancel, ok]);
  dialog.classList.add('wide', 'lb-dialog');
  cancel.onclick = close;
  ok.onclick = async () => {
    if (!parsed) return;
    ok.disabled = true;
    try {
      await mutate('addDataset', { dataset: parsed });
      close();
      toast(`Added “${parsed.name}”`);
    } catch {
      ok.disabled = false;
    }
  };
  check();
}

// ---------- from OpenRocket

async function openRocketDialog() {
  const designSel = h('select', {}, h('option', { value: '' }, 'Loading your designs…'));
  const simSel = h('select', { disabled: true }, h('option', {}, 'Choose a design'));
  const branchSel = h('select', { hidden: true });
  const types = h('div', { class: 'lb-types' });
  const status = h('p', { class: 'hint' }, 'OpenRocket keeps a simulation\'s results when it has been run and the design saved. A simulation without them: open the design, run it, and come back.');
  const ok = h('button', { class: 'primary', disabled: true }, 'Add to logbook');
  const cancel = h('button', {}, 'Cancel');
  const { dialog, close } = modal('Flight data from OpenRocket', [
    h('label', { class: 'lb-field' }, h('span', {}, 'Design'), designSel),
    h('label', { class: 'lb-field' }, h('span', {}, 'Simulation'), simSel),
    branchSel, types, status,
  ], [cancel, ok]);
  dialog.classList.add('wide', 'lb-dialog');
  cancel.onclick = close;
  let designs = [];
  let sims = [];
  try {
    designs = (await api('designs', { action: 'list' })).sort((a, b) => a.name.localeCompare(b.name));
  } catch (e) {
    status.textContent = e.message;
  }
  designSel.replaceChildren(h('option', { value: '' }, designs.length ? 'Choose a design' : 'No designs yet'),
    ...designs.map((d) => h('option', { value: d.id }, d.name)));

  const renderTypes = () => {
    const sim = sims[Number(simSel.value)];
    const branch = sim?.branches[Number(branchSel.value) || 0];
    if (!branch) {
      types.replaceChildren();
      ok.disabled = true;
      return;
    }
    const names = branch.types.filter((t) => t !== 'Time');
    const first = [...OR_DEFAULTS, 'Total velocity', 'Total acceleration', 'Thrust', 'Mach number', 'Lateral distance'].filter((t) => names.includes(t));
    const rest = names.filter((t) => !first.includes(t));
    const box = (t) => h('label', { class: 'check' }, h('input', { type: 'checkbox', value: t, checked: OR_DEFAULTS.includes(t) }), t);
    fill(types, h('span', { class: 'hint' }, `${branch.rows.length.toLocaleString()} points. Choose what to bring in:`),
      h('div', { class: 'lb-type-grid' }, first.map(box)),
      rest.length ? h('details', {}, h('summary', {}, `${rest.length} more`), h('div', { class: 'lb-type-grid' }, rest.map(box))) : null);
    ok.disabled = false;
  };
  designSel.onchange = async () => {
    sims = [];
    simSel.disabled = true;
    branchSel.hidden = true;
    types.replaceChildren();
    ok.disabled = true;
    if (!designSel.value) return;
    simSel.replaceChildren(h('option', {}, 'Reading the design…'));
    try {
      const [{ fetchDesign }, { fromJson, toXml }] = await Promise.all([import('./flight/openrocket.js'), import('../../server/src/model.js')]);
      const design = await fetchDesign(designSel.value);
      sims = simulationsFromXml(toXml(fromJson(design.model)));
    } catch (e) {
      simSel.replaceChildren(h('option', {}, 'Could not read the design'));
      status.textContent = e.message;
      return;
    }
    simSel.replaceChildren(...(sims.length
      ? sims.map((s, i) => h('option', { value: i, disabled: !s.branches.length },
        `${s.name}${s.branches.length ? ` — apogee ${formatNumber(s.summary.maxaltitude)} m` : ' (no results stored)'}`))
      : [h('option', {}, 'This design has no simulations')]));
    const firstWithData = sims.findIndex((s) => s.branches.length);
    if (firstWithData >= 0) simSel.value = firstWithData;
    simSel.disabled = !sims.length;
    simSel.onchange();
  };
  simSel.onchange = () => {
    const sim = sims[Number(simSel.value)];
    branchSel.hidden = !sim || sim.branches.length < 2;
    branchSel.replaceChildren(...(sim?.branches ?? []).map((b, i) => h('option', { value: i }, `Stage: ${b.name}`)));
    renderTypes();
  };
  branchSel.onchange = renderTypes;
  ok.onclick = async () => {
    const sim = sims[Number(simSel.value)];
    const branch = sim?.branches[Number(branchSel.value) || 0];
    const chosen = [...types.querySelectorAll('input:checked')].map((i) => i.value);
    const design = designs.find((d) => d.id === designSel.value);
    try {
      const ds = datasetFromSimulation({ design, simulation: sim, branch, types: chosen });
      ds.name = `${design.name}: ${sim.name}`;
      ok.disabled = true;
      await mutate('addDataset', { dataset: ds });
      close();
      toast(`Added “${ds.name}”`);
    } catch (e) {
      status.textContent = e.message;
      ok.disabled = false;
    }
  };
}

// ---------- from the Launch Planner

async function planDialog() {
  const planSel = h('select', {}, h('option', { value: '' }, 'Loading your launch plans…'));
  const info = h('div', { class: 'lb-result' });
  const fillDetails = h('input', { type: 'checkbox', checked: true });
  const note = h('input', { type: 'checkbox', checked: true });
  const ok = h('button', { class: 'primary', disabled: true }, 'Add to logbook');
  const cancel = h('button', {}, 'Cancel');
  const { dialog, close } = modal('Flight data from the Launch Planner', [
    h('label', { class: 'lb-field' }, h('span', {}, 'Launch plan'), planSel),
    info,
    h('label', { class: 'check' }, fillDetails, 'Fill in the empty flight details (date, time, location, rocket)'),
    h('label', { class: 'check' }, note, 'Add the plan\'s prediction to the notes'),
    h('p', { class: 'hint' }, 'Brings in the plan\'s nominal flight: its predicted altitude and drift from the pad over time.'),
  ], [cancel, ok]);
  dialog.classList.add('wide', 'lb-dialog');
  cancel.onclick = close;
  const { listFlights, openFlight } = await import('./flight/saved.js');
  let plans = [];
  try {
    plans = await listFlights();
  } catch (e) {
    info.textContent = e.message;
  }
  planSel.replaceChildren(h('option', { value: '' }, plans.length ? 'Choose a launch plan' : 'No launch plans yet'),
    ...plans.map((p) => h('option', { value: p.id }, `${p.name}${p.design_name ? ` — ${p.design_name}` : ''}`)));
  let picked = null;
  planSel.onchange = async () => {
    picked = null;
    ok.disabled = true;
    info.replaceChildren();
    const plan = plans.find((p) => p.id === planSel.value);
    if (!plan) return;
    try {
      const { study } = await openFlight(plan);
      picked = { plan, ...datasetFromPlan(plan, study) };
      const s = summarize(picked.dataset);
      fill(info, h('p', { class: 'ok' }, icon('check'),
        ` ${s.rows.toLocaleString()} points over ${formatNumber(s.span[1])} s; predicted apogee ${formatNumber(s.columns[0].max)} m.`),
      plan.summary ? h('p', { class: 'hint' }, plan.summary) : null);
      ok.disabled = false;
    } catch (e) {
      info.replaceChildren(h('p', { class: 'error' }, e.message));
    }
  };
  ok.onclick = async () => {
    if (!picked) return;
    ok.disabled = true;
    try {
      await mutate('addDataset', { dataset: picked.dataset });
      const update = {};
      if (fillDetails.checked) {
        const details = {};
        for (const [k, v] of Object.entries(picked.details)) if (v && !book.details?.[k]) details[k] = v;
        if (Object.keys(details).length) update.details = details;
      }
      if (note.checked && picked.note && !(book.notes ?? '').includes(picked.note)) update.notes = [book.notes, picked.note].filter(Boolean).join('\n\n');
      if (Object.keys(update).length) {
        const b = await call('update', { id: book.id, ...update });
        book = { ...book, details: b.details, notes: b.notes, version: b.version };
        renderBook();
      }
      close();
      toast(`Added “${picked.dataset.name}”`);
    } catch {
      ok.disabled = false;
    }
  };
}

// ------------------------------------------------------------------ photos and videos

// Base44's limits and accepted formats for uploads.
const PHOTO_TYPES = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const VIDEO_TYPES = { mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', m4v: 'video/x-m4v', avi: 'video/x-msvideo', mkv: 'video/x-matroska', ogv: 'video/ogg', '3gp': 'video/3gpp' };
const MAX_PHOTO = 50e6;
const MAX_VIDEO = 100e6;

async function refreshUrls(force = false) {
  const stale = book.media.filter((m) => force || !urls.has(m.id) || Date.now() - urls.get(m.id).at > 50 * 60e3);
  if (!stale.length) return;
  const got = await call('mediaUrls', { id: book.id, mediaIds: stale.map((m) => m.id) });
  for (const [id, url] of Object.entries(got)) if (url) urls.set(id, { url, at: Date.now() });
}

async function urlOf(m) {
  await refreshUrls();
  return urls.get(m.id)?.url ?? null;
}

function renderMedia() {
  const sec = $('#lb-media');
  if (!sec) return;
  const edit = canEdit();
  const input = h('input', { type: 'file', multiple: true, hidden: true, accept: [...Object.keys(PHOTO_TYPES), ...Object.keys(VIDEO_TYPES)].map((e) => `.${e}`).join(',') });
  input.onchange = () => {
    const files = [...input.files];
    input.value = '';
    upload(files);
  };
  const add = h('button', { class: 'primary' }, icon('upload'), 'Add photos or videos');
  add.onclick = () => input.click();
  sec.replaceChildren(
    h('div', { class: 'lb-sec-head' }, h('h3', {}, 'Photos and videos'), h('span', { class: 'spacer' }), edit ? add : null, input),
    book.media.length || uploads.size
      ? h('div', { class: 'lb-gallery' }, book.media.map(mediaTile), [...uploads.values()])
      : h('p', { class: 'hint' }, edit ? 'Photos (JPEG, PNG, WebP, up to 50 MB) and videos (MP4, MOV, WebM and more, up to 100 MB) of the flight.' : 'No photos or videos yet.'));
}

function mediaTile(m) {
  const edit = canEdit();
  const img = m.preview ? h('img', { src: m.preview, alt: m.caption || m.name, loading: 'lazy' }) : h('div', { class: 'lb-noprev' }, icon(m.kind === 'video' ? 'power' : 'folder'));
  const open = h('button', { class: 'lb-open', title: m.kind === 'video' ? 'Play' : 'View' }, img, m.kind === 'video' ? h('span', { class: 'lb-play' }, '▶') : null);
  open.onclick = () => viewMedia(m);
  const caption = edit ? h('input', { value: m.caption ?? '', placeholder: 'Caption', maxlength: 500, 'aria-label': `Caption for ${m.name}` }) : h('div', { class: 'lb-caption' }, m.caption || '');
  if (edit) {
    const save = debounce(() => mutateQuiet('updateMedia', { mediaId: m.id, caption: caption.value }), 800);
    caption.oninput = save;
  }
  const remove = h('button', { class: 'ghost icon danger', title: 'Remove' }, icon('trash'));
  remove.onclick = async () => {
    if (!(await confirmDialog(`Remove ${m.kind}?`, `“${m.name}” will be removed from this logbook.`, 'Remove', true))) return;
    await mutate('removeMedia', { mediaId: m.id });
  };
  return h('figure', { class: 'lb-tile' }, open,
    h('figcaption', {}, caption,
      h('div', { class: 'row hint' }, h('span', { class: 'grow', title: m.name }, `${m.kind === 'video' ? 'Video' : 'Photo'} · ${formatBytes(m.size)}${m.duration ? ` · ${Math.round(m.duration)} s` : ''}`), edit ? remove : null)));
}

/** A change saved without drawing the page again (a caption as it is typed). */
async function mutateQuiet(action, body) {
  saveState.textContent = 'Saving…';
  try {
    const b = await call(action, { id: book.id, ...body });
    book.media = b.media;
    book.version = b.version;
    saveState.textContent = 'Saved';
  } catch (e) {
    saveState.textContent = `Not saved: ${e.message}`;
  }
}

async function viewMedia(m) {
  const body = h('div', { class: 'lb-viewer' }, m.preview ? h('img', { src: m.preview, alt: '' }) : h('p', { class: 'hint' }, 'Loading…'));
  const close = h('button', {}, 'Close');
  const original = h('a', { class: 'btn', target: '_blank', rel: 'noopener', hidden: true }, icon('download'), 'Original');
  const { dialog, close: done } = modal(m.caption || m.name, body, [original, close]);
  dialog.classList.add('wide', 'lb-dialog');
  close.onclick = done;
  try {
    const url = await urlOf(m);
    if (!url) throw new Error('The file could not be found.');
    original.href = url;
    original.hidden = false;
    body.replaceChildren(m.kind === 'video'
      ? h('video', { src: url, controls: true, autoplay: true, playsinline: true, poster: m.preview ?? '' })
      : h('img', { src: url, alt: m.caption || m.name }));
  } catch (e) {
    body.append(h('p', { class: 'error' }, e.message));
  }
}

const uploads = new Map(); // tiles of files being uploaded

/** A small JPEG of a photo or of a video's first second, for the gallery, cards and the PDF. */
async function makePreview(file, kind) {
  const canvas = document.createElement('canvas');
  let w;
  let h2;
  let duration = null;
  let source;
  if (kind === 'photo') {
    source = await createImageBitmap(file);
    [w, h2] = [source.width, source.height];
  } else {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.src = URL.createObjectURL(file);
    await new Promise((resolve, reject) => {
      video.onloadeddata = resolve;
      video.onerror = () => reject(new Error('This video cannot be read here.'));
      setTimeout(() => reject(new Error('timed out')), 15000);
    });
    duration = video.duration;
    video.currentTime = Math.min(1, (video.duration || 0) / 2);
    await new Promise((resolve) => {
      video.onseeked = resolve;
      setTimeout(resolve, 3000);
    });
    [w, h2] = [video.videoWidth, video.videoHeight];
    source = video;
  }
  const out = { w, h: h2, duration, preview: null, thumb: null };
  // A JPEG of the picture at most `max` pixels across, if one fits in `chars`.
  const jpeg = (sizes, quality, chars) => {
    for (const max of sizes) {
      const scale = Math.min(1, max / Math.max(w, h2));
      canvas.width = Math.max(1, Math.round(w * scale));
      canvas.height = Math.max(1, Math.round(h2 * scale));
      canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
      const url = canvas.toDataURL('image/jpeg', quality);
      if (url.length <= chars) return url;
    }
    return null;
  };
  out.preview = jpeg([960, 720, 480], 0.78, 280_000); // the gallery and the PDF
  out.thumb = jpeg([320, 240, 160], 0.7, 15_000); // the logbook's card
  if (kind === 'video') URL.revokeObjectURL(source.src);
  return out;
}

async function upload(files) {
  for (const file of files) {
    const ext = (file.name.split('.').pop() ?? '').toLowerCase();
    const kind = PHOTO_TYPES[ext] ? 'photo' : VIDEO_TYPES[ext] ? 'video' : null;
    if (!kind) {
      toast(ext === 'heic' || ext === 'heif'
        ? `${file.name}: HEIC photos are not accepted; save them as JPEG first.`
        : `${file.name}: only JPEG, PNG and WebP photos and MP4, MOV, WebM, M4V, AVI, MKV, OGV and 3GP videos.`);
      continue;
    }
    if (file.size > (kind === 'photo' ? MAX_PHOTO : MAX_VIDEO)) {
      toast(`${file.name} is larger than ${kind === 'photo' ? '50' : '100'} MB.`);
      continue;
    }
    const key = crypto.randomUUID();
    const status = h('div', { class: 'hint' }, 'Preparing…');
    uploads.set(key, h('figure', { class: 'lb-tile uploading' }, h('div', { class: 'lb-noprev' }, icon('upload')), h('figcaption', {}, h('div', {}, file.name), status)));
    renderMedia();
    try {
      const look = await makePreview(file, kind).catch(() => ({ preview: null }));
      status.textContent = `Uploading ${formatBytes(file.size)}…`;
      // A random name: the stored file's path says nothing about it.
      const hidden = new File([file], `${crypto.randomUUID().replace(/-/g, '')}.${ext}`, { type: file.type || (kind === 'photo' ? PHOTO_TYPES[ext] : VIDEO_TYPES[ext]) });
      const { file_uri } = await base44.integrations.Core.UploadPrivateFile({ file: hidden });
      status.textContent = 'Saving…';
      uploads.delete(key);
      await mutate('addMedia', { item: { kind, file_uri, name: file.name, type: hidden.type, size: file.size, ...look } });
    } catch (e) {
      uploads.delete(key);
      renderMedia();
      toast(`${file.name}: ${e.message}`);
    }
  }
}

// ------------------------------------------------------------------ the printed logbook (PDF)

async function exportPdf() {
  flushSave.flush();
  const report = $('#report');
  const d = book.details ?? {};
  const shown = (k) => (k === 'date' ? formatDate({ date: d.date }) : d[k]);
  const rows = DETAIL_FIELDS.filter(([k]) => d[k]).map(([k, label]) => h('tr', {}, h('th', {}, label), h('td', {}, shown(k))));
  const groups = graphGroups(book.datasets, units);
  const photos = book.media.filter((m) => m.kind === 'photo');
  const videos = book.media.filter((m) => m.kind === 'video');
  try {
    await refreshUrls();
  } catch {
    // previews instead
  }
  const photoEls = photos.map((m) => h('figure', { class: 'r-photo' },
    h('img', { src: urls.get(m.id)?.url ?? m.preview ?? '', alt: m.caption || m.name }),
    h('figcaption', {}, m.caption || m.name)));
  fill(report,
    h('header', {}, h('h1', {}, book.title),
      h('p', {}, [`${book.owner_name ?? book.owner_email}`, (book.members ?? []).length ? `shared with ${book.members.length}` : null,
        `printed ${new Date().toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}`].filter(Boolean).join(' · '))),
    rows.length ? h('section', {}, h('h2', {}, 'Flight details'), h('table', { class: 'r-details' }, rows)) : null,
    book.description ? h('section', {}, h('h2', {}, 'Description'), h('p', { class: 'r-text' }, book.description)) : null,
    book.notes ? h('section', {}, h('h2', {}, 'Additional notes'), h('p', { class: 'r-text' }, book.notes)) : null,
    book.datasets.length ? h('section', {}, h('h2', {}, 'Flight data'),
      h('table', { class: 'r-data' }, h('thead', {}, h('tr', {}, h('th', {}, 'Data set'), h('th', {}, 'Source'), h('th', {}, 'Columns'), h('th', {}, 'Rows'), h('th', {}, 'Time'))),
        h('tbody', {}, book.datasets.map((ds) => {
          const s = summarize(ds);
          return h('tr', {}, h('td', {}, ds.name), h('td', {}, SOURCES[ds.source] ?? ''), h('td', {}, ds.columns.map(columnLabel).join(', ')),
            h('td', {}, s.rows.toLocaleString()), h('td', {}, `${formatNumber(s.span[0])}–${formatNumber(s.span[1])} s${ds.offset ? ` (shifted ${ds.offset} s)` : ''}`));
        }))),
      groups.map((g) => h('div', { class: 'r-chart' }, lineChart(g, { interactive: false, width: 720, height: 250 }))),
      statsTable()) : null,
    photos.length ? h('section', {}, h('h2', {}, 'Photos'), h('div', { class: 'r-photos' }, photoEls)) : null,
    videos.length ? h('section', {}, h('h2', {}, 'Videos'), h('div', { class: 'r-videos' }, videos.map((m) => h('figure', {},
      m.preview ? h('img', { src: m.preview, alt: '' }) : null,
      h('figcaption', {}, h('b', {}, m.caption || m.name), h('br'), `${m.name} · ${formatBytes(m.size)}${m.duration ? ` · ${Math.round(m.duration)} s` : ''} — play it in the logbook online`))))) : null);
  report.querySelector('details')?.setAttribute('open', '');
  // Every photo loaded before printing (a few seconds at most).
  await Promise.all([...report.querySelectorAll('img')].map((img) => Promise.race([
    img.decode().catch(() => {
      const m = photos.find((p) => urls.get(p.id)?.url === img.src);
      if (m?.preview) img.src = m.preview;
    }),
    new Promise((r) => setTimeout(r, 8000)),
  ])));
  const title = document.title;
  document.title = book.title; // the PDF's file name
  document.body.classList.add('printing');
  toast('Choose “Save as PDF” as the printer to save the logbook as a PDF.');
  await new Promise((r) => setTimeout(r, 300));
  window.print();
  setTimeout(() => {
    document.title = title;
    document.body.classList.remove('printing');
  }, 500);
}

// ------------------------------------------------------------------ start

async function main() {
  me = await currentUser();
  if (!me) {
    $('#signed-out').hidden = false;
    return;
  }
  $('#me').replaceChildren(avatar(me), h('span', { class: 'name' }, me.name));
  $('#me').hidden = false;
  if (params.get('id')) await showBook(params.get('id'));
  else await showBooks();
}

main();
