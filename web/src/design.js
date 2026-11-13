// The design page: OpenRocket running in this browser (CheerpJ), live-shared through the design's
// room, with who's here, recent changes, sharing, edit history and .ork download.
import './style.css';
import { currentUser, db, signIn } from './base44.js';
import { $, h, icon, avatar, timeAgo, toast, shareDialog, editHistoryDialog } from './common.js';
import { RoomClient, testHub } from './room-client.js';
import { closeOpenRocket, editsSaved, onJavaDownload, previewSaved, prepareJava, startOpenRocket } from './java.js';
import { exportOrk, fileName, saveFile } from './lib/ork.js';
import { fromJson } from '../../server/src/model.js';

const designId = new URLSearchParams(location.search).get('id') ?? '';
const screen = $('#screen');

$('#back').append(icon('back'));
$('#share-btn').append(icon('share'), 'Share');
$('#download-btn').append(icon('download'));
$('#planner-btn').append(icon('target'));
$('#planner-btn').href = `/planner.html?id=${encodeURIComponent(designId)}`;
$('#history-btn').append(icon('history'));
$('#fullscreen-btn').append(icon('maximize'));
$('#close-btn').append(icon('x'));

let me;
let room;
let role = null;
let name = 'Rocket';
let state = 'connecting'; // connecting -> loading -> ready | ended
let closing = false; // the user closed the design; waiting for OpenRocket's last edits
let members = [];
const feed = [];

// ------------------------------------------------------------------ overlay & status

const STEPS = [
  ['connecting', 'Connecting to the design'],
  ['loading', 'Starting OpenRocket in your browser'],
  ['ready', 'Opening the design'],
];

// The Java runtime's download, under the steps: how far it has got, and, when it is slow, why.
const downloadLine = h('p', { class: 'hint download' }, 'Downloading Java…');
const slowNote = h('p', { class: 'hint download-slow', hidden: true },
  'Java is downloading slowly. It comes from the servers of CheerpJ (what runs Java in your browser), '
  + 'which are far away from some places, so this can take a few minutes. Keep this page open.');
const opened = performance.now();
let downloaded = false;
onJavaDownload(({ done, total }) => {
  downloaded = total > 0 && done >= total;
  const percent = total > 0 ? Math.floor((100 * done) / total) : 0;
  downloadLine.textContent = downloaded ? 'Java downloaded; starting it…' : `Downloading Java: ${percent}%`;
});
// Still downloading after half a minute: say why.
setTimeout(() => {
  if (!downloaded && state !== 'ready' && state !== 'ended') slowNote.hidden = false;
}, Math.max(0, 30_000 - (performance.now() - opened)));

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
  if (closing) {
    showOverlay([h('div', { class: 'spinner' }), h('h2', {}, 'Closing'), h('p', {}, 'Saving your last changes…')]);
    setStatus('Closing', 'wait');
    return;
  }
  if (state === 'ready') {
    $('#overlay').hidden = true;
    setStatus(role === 'viewer' ? 'Viewing' : 'Live', 'live');
    return;
  }
  const at = STEPS.findIndex(([s]) => s === state);
  showOverlay([
    h('div', { class: 'spinner' }),
    h('h2', {}, 'Opening OpenRocket'),
    h('p', {}, 'OpenRocket runs right here in your browser. It usually starts in under a minute, longer when its Java download is slow.'),
    h('div', { class: 'steps' }, STEPS.map(([s, label], i) =>
      h('div', { class: i < at ? 'done' : i === at ? 'now' : '' }, i < at ? '✓ ' : i === at ? '› ' : '  ', label))),
    downloadLine,
    slowNote,
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
  document.title = `${name} · Rocket in Cloud`;
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

/**
 * The Close button (and the back arrow): OpenRocket sends its last edits and closes, and once the
 * room has them the page goes back to the designs (see onExit below).
 */
function closeDesign(e) {
  if (e && (e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)) return; // a new tab: leave it to the link
  e?.preventDefault();
  if (closing) return;
  if (state !== 'ready') {
    location.href = '/';
    return;
  }
  closing = true;
  renderState();
  closeOpenRocket();
  setTimeout(() => (location.href = '/'), 15_000); // in case OpenRocket does not answer
}
$('#close-btn').onclick = closeDesign;
$('#back').onclick = closeDesign;

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
  // Fetch and start the Java runtime while the sign-in, the design and its room are looked up.
  prepareJava(designId).catch(() => {}); // a failure is reported when OpenRocket starts
  const hub = testHub();
  me = hub ? { id: `local:${hub.user}`, email: hub.user, name: hub.name ?? hub.user } : await currentUser();
  if (!me) return signIn();
  // The design is looked up while its room connects and OpenRocket starts.
  const found = hub ? null : db.Design.get(designId).catch(() => null);

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
    if (state === 'connecting') {
      state = 'loading';
      renderState();
    }
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

  // OpenRocket starts now rather than when the room answers: its Java start-up is the longer
  // wait, and its bridge waits for the room by itself.
  startOpenRocket({
    designId,
    screen,
    room,
    onReady: () => {
      if (state === 'ended') return;
      state = 'ready';
      renderState();
    },
    onExit: async (code) => {
      if (state === 'ended') return;
      if (closing || code === 0) {
        // Closed by the user (the Close button or OpenRocket's File menu): once the room has the
        // last edits, and the drawing for the design's card, back to the designs.
        closing = true;
        renderState();
        await editsSaved(8000);
        await previewSaved(5000);
        location.href = '/';
        return;
      }
      ended('OpenRocket closed', 'Your work is saved.');
    },
  }).catch((e) => ended('OpenRocket could not start', e.message));
  if (found) {
    const design = await found;
    if (!design) return ended('Design not found', 'It may have been deleted, or it is not shared with you.');
    setName(design.name);
  }
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
