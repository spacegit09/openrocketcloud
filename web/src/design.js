// The design page: OpenRocket running in this browser (CheerpJ), live-shared through the design's
// room, with who's here, recent changes, sharing, edit history and .ork download.
import './style.css';
import { currentUser, db, signIn } from './base44.js';
import { $, h, icon, avatar, timeAgo, toast, shareDialog, editHistoryDialog } from './common.js';
import { RoomClient, testHub } from './room-client.js';
import { startOpenRocket } from './java.js';
import { exportOrk, fileName, saveFile } from './lib/ork.js';
import { fromJson } from '../../server/src/model.js';

const designId = new URLSearchParams(location.search).get('id') ?? '';
const screen = $('#screen');

$('#back').append(icon('back'));
$('#logo').append(icon('rocket'));
$('#share-btn').append(icon('share'), 'Share');
$('#download-btn').append(icon('download'));
$('#history-btn').append(icon('history'));
$('#fullscreen-btn').append(icon('maximize'));

let me;
let room;
let role = null;
let name = 'Rocket';
let state = 'connecting'; // connecting -> loading -> ready | ended
let members = [];
const feed = [];

// ------------------------------------------------------------------ overlay & status

const STEPS = [
  ['connecting', 'Connecting to the design'],
  ['loading', 'Starting OpenRocket in your browser'],
  ['ready', 'Opening the design'],
];

function showOverlay(content) {
  $('#overlay-box').replaceChildren(...content);
  $('#overlay').hidden = false;
}

function setStatus(text, kind) {
  $('#status').textContent = text;
  $('#status').className = `pill ${kind}`;
}

function renderState() {
  if (state === 'ended') return;
  if (state === 'ready') {
    $('#overlay').hidden = true;
    setStatus(role === 'viewer' ? 'Viewing' : 'Live', 'live');
    return;
  }
  const at = STEPS.findIndex(([s]) => s === state);
  showOverlay([
    h('div', { class: 'spinner' }),
    h('h2', {}, 'Opening OpenRocket'),
    h('p', {}, 'OpenRocket runs right here in your browser. The first time takes about 20–30 seconds; later visits are quicker.'),
    h('div', { class: 'steps' }, STEPS.map(([s, label], i) =>
      h('div', { class: i < at ? 'done' : i === at ? 'now' : '' }, i < at ? '✓ ' : i === at ? '› ' : '  ', label))),
  ]);
  setStatus('Starting', 'wait');
}

function ended(title, detail) {
  state = 'ended';
  setStatus('Closed', 'off');
  const reload = h('button', { class: 'primary' }, icon('refresh'), 'Open again');
  reload.onclick = () => location.reload();
  const back = h('a', { class: 'btn', href: '/' }, 'All designs');
  showOverlay([
    h('h2', {}, title),
    h('p', {}, detail ?? 'Your work is saved.'),
    h('div', { class: 'row', style: 'justify-content:center' }, back, reload),
  ]);
}

// ------------------------------------------------------------------ presence & activity

function describeMember(m) {
  const what = m.selection?.length ? `selected ${m.selection.map((s) => s.name).join(', ')}` : 'online';
  return `${m.name}${m.email === me?.email ? ' (you)' : ''} — ${what}`;
}

function renderPeople() {
  $('#people').replaceChildren(...members.slice(0, 5).map((m) => avatar(m, describeMember(m))));
  $('#people').title = members.length <= 1 ? 'Only you are here' : `${members.length} people here`;
  $('#people').hidden = !members.length;
  if (!$('#popover').hidden) renderPopover();
}

function renderPopover() {
  const people = h('div', { class: 'list' }, members.map((m) =>
    h('div', { class: 'item' }, avatar(m),
      h('div', { class: 'grow' },
        h('div', {}, m.name, m.email === me.email ? ' (you)' : '', m.role === 'viewer' ? ' · view only' : ''),
        h('div', { class: 'sub' }, m.selection?.length ? `Selected: ${m.selection.map((s) => s.name).join(', ')}` : 'Online')))));
  const recent = h('div', { class: 'list feed' }, feed.length
    ? feed.slice(0, 12).map((a) => h('div', { class: 'item' },
      h('span', { class: 'avatar', style: `--c:${a.user.color};width:20px;height:20px;font-size:9px` }, a.user.name[0]),
      h('div', { class: 'grow' }, h('b', {}, a.user.name), ' ', a.text, h('div', { class: 'sub' }, timeAgo(a.at)))))
    : h('div', { class: 'item sub' }, 'No changes yet in this session.'));
  $('#popover').replaceChildren(h('h4', {}, 'Here now'), people, h('h4', {}, 'Recent changes'), recent);
}

$('#people').onclick = (e) => {
  e.stopPropagation();
  $('#popover').hidden = !$('#popover').hidden;
  if (!$('#popover').hidden) renderPopover();
};
$('#popover').onclick = (e) => e.stopPropagation();
document.addEventListener('click', () => ($('#popover').hidden = true));

let activityTimer;
function showActivity(a) {
  feed.unshift(a);
  feed.length = Math.min(feed.length, 50);
  if (a.user.id === room?.hi?.you?.id) return;
  const el = $('#activity');
  el.replaceChildren(h('b', { style: `color:${a.user.color}` }, a.user.name), ' ', a.text);
  el.style.opacity = 1;
  clearTimeout(activityTimer);
  activityTimer = setTimeout(() => (el.style.opacity = 0), 8000);
}

// ------------------------------------------------------------------ toolbar

function setName(n) {
  name = n || 'Rocket';
  $('#title').textContent = name;
  document.title = `${name} · OPuhRohCum`;
}

$('#download-btn').onclick = async () => {
  try {
    const { model } = await room.request('export');
    saveFile(await exportOrk(fromJson(model)), fileName(name));
  } catch (e) {
    toast(e.message);
  }
};
$('#history-btn').onclick = () => editHistoryDialog(room, { canRevert: role !== 'viewer' });
$('#share-btn').onclick = () => shareDialog(designId, me);
$('#fullscreen-btn').onclick = () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen());

// ------------------------------------------------------------------ start

/** A connection id kept for this tab, so a reload or reconnect continues where it left off. */
function connectionId() {
  const key = `orc-conn-${designId}`;
  let id = sessionStorage.getItem(key);
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem(key, id);
  }
  return id;
}

async function main() {
  renderState();
  if (!designId) return ended('Design not found', 'The link is incomplete.');
  const hub = testHub();
  me = hub ? { id: `local:${hub.user}`, email: hub.user, name: hub.name ?? hub.user } : await currentUser();
  if (!me) return signIn();
  if (!hub) {
    const design = await db.Design.get(designId).catch(() => null);
    if (!design) return ended('Design not found', 'It may have been deleted, or it is not shared with you.');
    setName(design.name);
  }

  room = new RoomClient(designId, { connectionId: connectionId() }).connect();
  let started = false;
  room.on('open', (hi) => {
    role = hi.role;
    if (hi.name) setName(hi.name);
    $('#role-badge').hidden = role !== 'viewer';
    $('#share-btn').hidden = role !== 'owner';
    if (state === 'ready') setStatus(role === 'viewer' ? 'Viewing' : 'Live', 'live');
    if (started) return;
    started = true;
    if (hi.empty) return ended('This design is empty', 'It was not set up completely. Create it again from the dashboard.');
    state = 'loading';
    renderState();
    startOpenRocket({
      designId,
      screen,
      room,
      onReady: () => {
        state = 'ready';
        renderState();
      },
      onExit: () => {
        if (state !== 'ended') ended('OpenRocket closed', 'Your work is saved.');
      },
    }).catch((e) => ended('OpenRocket could not start', e.message));
  });
  room.on('closed', () => {
    if (state === 'ready') setStatus('Reconnecting', 'wait');
  });
  room.on('presence', (m) => {
    members = m.members;
    renderPeople();
  });
  room.on('activity', showActivity);
  room.on('notice', (m) => toast(m.message));
  room.on('kick', (m) => ended('The design was closed', m.message));
  setTimeout(() => {
    if (state === 'connecting') {
      showOverlay([
        h('h2', {}, 'Cannot reach the design'),
        h('p', {}, 'It may not be shared with you, or your connection is down.'),
        h('div', { class: 'row', style: 'justify-content:center' }, h('a', { class: 'btn', href: '/' }, 'All designs'),
          h('button', { class: 'primary', onclick: () => location.reload() }, 'Try again')),
      ]);
    }
  }, 30_000);
}

main().catch((e) => ended('Something went wrong', e.message));
