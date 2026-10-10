import RFB from '/novnc/core/rfb.js';
import { api, $, h, icon, avatar, timeAgo, toast, modal, confirmDialog, download, shareDialog, editHistoryDialog } from './common.js';

const projectId = location.pathname.split('/')[2];
const screen = $('#screen');
const isMac = /Mac|iPhone|iPad/.test(navigator.platform);

$('#back').append(icon('back'));
$('#logo').append(icon('rocket'));
$('#share-btn').append(icon('share'), 'Share');
$('#download-btn').append(icon('download'));
$('#files-btn').append(icon('folder'));
$('#history-btn').append(icon('history'));
$('#history-btn').onclick = () => editHistoryDialog(projectId);
$('#fullscreen-btn').append(icon('maximize'));
$('#end-btn').append(icon('power'));

let project;
let me;
let session = null;
let rfb = null;
let displayUp = false;
let state = 'starting';
let members = [];
const feed = [];

// ------------------------------------------------------------------ overlay & status

const STEPS = [
  ['starting', 'Starting a cloud computer'],
  ['loading', 'Opening OpenRocket'],
  ['ready', 'Connecting your screen'],
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
  // Show OpenRocket as soon as its screen is up: while it opens the design it may ask
  // something (e.g. "Warnings while opening file") that the user has to answer.
  if (displayUp && (state === 'ready' || state === 'loading')) {
    $('#overlay').hidden = true;
    if (state === 'ready') setStatus(project?.role === 'viewer' ? 'Viewing' : 'Live', 'live');
    else setStatus('Opening…', 'wait');
    return;
  }
  const at = STEPS.findIndex(([s]) => s === state);
  showOverlay([
    h('div', { class: 'spinner' }),
    h('h2', {}, 'Launching OpenRocket'),
    h('p', {}, 'The first launch takes about 20 seconds.'),
    h('div', { class: 'steps' }, STEPS.map(([s, label], i) =>
      h('div', { class: i < at || (state === 'ready' && i === at) ? 'done' : i === at ? 'now' : '' }, i < at ? '✓ ' : i === at ? '› ' : '  ', label))),
  ]);
  setStatus('Starting', 'wait');
}

function ended(detail) {
  state = 'ended';
  rfb?.disconnect();
  rfb = null;
  setStatus('Closed', 'off');
  const reopen = h('button', { class: 'primary' }, icon('rocket'), 'Open OpenRocket again');
  reopen.onclick = start;
  const back = h('a', { class: 'btn', href: '/' }, 'All designs');
  showOverlay([
    h('h2', {}, 'OpenRocket is closed'),
    h('p', {}, detail ?? 'Your work is saved in the cloud.'),
    h('div', { class: 'row', style: 'justify-content:center' }, back, reopen),
  ]);
}

// ------------------------------------------------------------------ session & display

async function start() {
  state = 'starting';
  renderState();
  const rect = screen.getBoundingClientRect();
  try {
    session = await api(`/projects/${projectId}/session`, {
      method: 'POST',
      body: { width: Math.round(rect.width), height: Math.round(rect.height) },
    });
  } catch (e) {
    return ended(e.message);
  }
  if (session.state !== 'starting') state = session.state;
  renderState();
  connect();
}

function connect() {
  if (!session || state === 'ended') return;
  rfb?.disconnect();
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/vnc/${session.id}`;
  rfb = new RFB(screen, url, { credentials: { password: session.vncPassword }, wsProtocols: ['binary'] });
  rfb.resizeSession = true;
  rfb.scaleViewport = false;
  rfb.clipViewport = false;
  rfb.qualityLevel = 7;
  rfb.compressionLevel = 2;
  rfb.focusOnClick = true;
  rfb.background = '#2b2f36';
  rfb.addEventListener('connect', () => {
    displayUp = true;
    renderState();
    rfb.focus();
  });
  rfb.addEventListener('disconnect', () => {
    displayUp = false;
    if (state === 'ended') return;
    setStatus('Reconnecting', 'wait');
    setTimeout(connect, 2000);
  });
  rfb.addEventListener('credentialsrequired', () => rfb.sendCredentials({ password: session.vncPassword }));
  rfb.addEventListener('clipboard', (e) => {
    navigator.clipboard?.writeText(e.detail.text).catch(() => {});
  });
}

// Mac: Cmd+key -> Ctrl+key (OpenRocket runs on Linux). Everywhere: paste pushes the local
// clipboard to the remote one first.
const XK_CONTROL_L = 0xffe3;
const remapped = new Map(); // code -> keysym currently held via remap

async function pushClipboard() {
  try {
    const text = await navigator.clipboard.readText();
    if (text) rfb?.clipboardPasteFrom(text);
  } catch {
    // clipboard permission denied: remote paste uses the remote clipboard
  }
}

screen.addEventListener('keydown', async (e) => {
  if (!rfb) return;
  const key = e.key.length === 1 ? e.key.toLowerCase() : null;
  const pasting = key === 'v' && (e.ctrlKey || (isMac && e.metaKey));
  if (isMac && e.key === 'Meta') {
    e.stopImmediatePropagation();
    e.preventDefault();
    return;
  }
  if (isMac && e.metaKey && key) {
    e.stopImmediatePropagation();
    e.preventDefault();
    if (pasting) await pushClipboard();
    const keysym = key.codePointAt(0);
    remapped.set(e.code, keysym);
    rfb.sendKey(XK_CONTROL_L, 'ControlLeft', true);
    rfb.sendKey(keysym, e.code, true);
    return;
  }
  if (pasting) {
    e.stopImmediatePropagation();
    e.preventDefault();
    await pushClipboard();
    rfb.sendKey(XK_CONTROL_L, 'ControlLeft', true);
    rfb.sendKey('v'.codePointAt(0), 'KeyV', true);
    rfb.sendKey('v'.codePointAt(0), 'KeyV', false);
    rfb.sendKey(XK_CONTROL_L, 'ControlLeft', false);
  }
}, true);

screen.addEventListener('keyup', (e) => {
  if (!rfb) return;
  if (isMac && e.key === 'Meta') {
    e.stopImmediatePropagation();
    for (const [code, keysym] of remapped) rfb.sendKey(keysym, code, false);
    if (remapped.size) rfb.sendKey(XK_CONTROL_L, 'ControlLeft', false);
    remapped.clear();
    return;
  }
  if (remapped.has(e.code)) {
    e.stopImmediatePropagation();
    rfb.sendKey(remapped.get(e.code), e.code, false);
    remapped.delete(e.code);
    if (!remapped.size) rfb.sendKey(XK_CONTROL_L, 'ControlLeft', false);
  }
}, true);

// ------------------------------------------------------------------ presence & activity

function renderPeople() {
  const others = members.filter((m) => m.id !== me.id);
  const shown = members.slice(0, 5);
  $('#people').replaceChildren(...shown.map((m) => avatar(m, describeMember(m))));
  $('#people').title = members.length <= 1 ? 'Only you are here' : `${members.length} people here`;
  $('#people').hidden = !members.length;
  if (!$('#popover').hidden) renderPopover();
  return others;
}

function describeMember(m) {
  const what = m.selection?.length ? `selected ${m.selection.map((s) => s.name).join(', ')}` : 'online';
  return `${m.name}${m.id === me?.id ? ' (you)' : ''} — ${what}`;
}

function renderPopover() {
  const people = h('div', { class: 'list' }, members.map((m) =>
    h('div', { class: 'item' }, avatar(m),
      h('div', { class: 'grow' },
        h('div', {}, m.name, m.id === me.id ? ' (you)' : '', m.role === 'viewer' ? ' · view only' : ''),
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
  if (a.user.id === me.id) return;
  const el = $('#activity');
  el.replaceChildren(h('b', { style: `color:${a.user.color}` }, a.user.name), ' ', a.text);
  el.style.opacity = 1;
  clearTimeout(activityTimer);
  activityTimer = setTimeout(() => (el.style.opacity = 0), 8000);
}

function listen() {
  const es = new EventSource(`/api/projects/${projectId}/events`);
  es.onmessage = (msg) => {
    const ev = JSON.parse(msg.data);
    switch (ev.type) {
      case 'presence':
        members = ev.members;
        renderPeople();
        break;
      case 'activity':
        showActivity(ev);
        break;
      case 'session':
        if (session && ev.id !== session.id) break;
        if (ev.state === 'ended') {
          ended(ev.detail);
        } else if (state !== 'ended') {
          state = ev.state;
          renderState();
        }
        break;
      case 'renamed':
        project.name = ev.name;
        $('#title').textContent = ev.name;
        document.title = `${ev.name} · Rocket in Cloud`;
        break;
      case 'notice':
        toast(ev.message);
        break;
      default:
        break;
    }
  };
  // Some proxies (e.g. Cloudflare quick tunnels) hold the event stream back. The server sends
  // a first event immediately, so if nothing arrives, poll the project instead.
  let streaming = false;
  es.addEventListener('message', () => (streaming = true));
  setTimeout(() => {
    if (!streaming) setInterval(poll, 3000);
  }, 5000);
}

async function poll() {
  let p;
  try {
    p = await api(`/projects/${projectId}`);
  } catch {
    return;
  }
  members = p.online;
  renderPeople();
  if (p.name !== project.name) {
    project.name = p.name;
    $('#title').textContent = p.name;
    document.title = `${p.name} · Rocket in Cloud`;
  }
  if (!session || state === 'ended') return;
  if (!p.session || p.session.id !== session.id) {
    ended('OpenRocket was closed. Your work is saved.');
  } else if (p.session.state !== state) {
    state = p.session.state;
    renderState();
  }
}

// ------------------------------------------------------------------ toolbar

$('#download-btn').onclick = () => download(`/api/projects/${projectId}/download`);

const formatSize = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);

$('#files-btn').onclick = () => {
  const list = h('div', { class: 'list' });
  const refresh = h('button', {}, icon('refresh'), 'Refresh');
  const close = h('button', { class: 'primary' }, 'Done');
  const render = async () => {
    const { files } = await api(`/projects/${projectId}/files`);
    list.replaceChildren(...(files.length ? files.map((f) => {
      const b = h('button', { class: 'ghost', title: `Download ${f.name}` }, icon('download'), 'Download');
      b.onclick = () => download(`/api/projects/${projectId}/files/download?path=${encodeURIComponent(f.name)}`);
      return h('div', { class: 'item' }, icon('folder'),
        h('div', { class: 'grow' }, h('div', {}, f.name), h('div', { class: 'sub' }, `${formatSize(f.size)} · ${timeAgo(f.modified)}`)), b);
    }) : [h('div', { class: 'item sub' }, 'Nothing here yet.')]));
  };
  const dlg = modal('Files from OpenRocket', [
    h('p', { class: 'hint', style: 'margin:0' }, 'Anything you save or export in OpenRocket (CSV data, PDF reports, RockSim or 3D exports, Save As…) lands in its default folder and shows up here. For the shared design itself, use Download .ork.'),
    list,
  ], [refresh, close]);
  refresh.onclick = render;
  close.onclick = dlg.close;
  render().catch((e) => toast(e.message));
};
$('#share-btn').onclick = () => shareDialog(projectId);
$('#fullscreen-btn').onclick = () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen());
$('#end-btn').onclick = async () => {
  if (!(await confirmDialog('Close OpenRocket?', 'Your design is saved continuously, so nothing is lost. You can reopen it any time.', 'Close'))) return;
  await api(`/projects/${projectId}/session`, { method: 'DELETE' });
  ended('You closed OpenRocket. Your work is saved.');
};

async function main() {
  try {
    [project, me] = await Promise.all([api(`/projects/${projectId}`), api('/me')]);
  } catch (e) {
    if (e.status === 401) location.href = `/auth/login?return=${encodeURIComponent(location.pathname)}`;
    else showOverlay([h('h2', {}, 'Design not found'), h('p', {}, 'It may have been deleted, or it is not shared with you.'), h('a', { class: 'btn', href: '/' }, 'All designs')]);
    return;
  }
  $('#title').textContent = project.name;
  document.title = `${project.name} · Rocket in Cloud`;
  $('#role-badge').hidden = project.role !== 'viewer';
  $('#share-btn').hidden = project.role !== 'owner';
  members = project.online;
  renderPeople();
  listen();
  start();
}

main();
