// The dashboard: sign in, list your designs and the ones shared with you, create (blank, from an
// OpenRocket example, upload), share, download, edit history, saved copies, custom motors.
import './style.css';
import { base44, currentUser, db, signIn, signOut } from './base44.js';
import {
  $, h, icon, avatar, timeAgo, toast, modal, confirmDialog, promptDialog, shareDialog, editHistoryDialog, ROCKET_SVG,
} from './common.js';
import { withRoom, RoomClient } from './room-client.js';
import { exportOrk, fileName, importOrk, saveFile } from './lib/ork.js';
import { RemoteZip } from './lib/zip.js';
import { fromJson, toJson } from '../../server/src/model.js';
import { readMotorFile } from '../../server/src/motors.js';

for (const el of document.querySelectorAll('[data-icon]')) el.replaceWith(icon(el.dataset.icon));

const JAR = '/or/OpenRocket-web.jar';
let me = null;
let designs = [];

const ERRORS = {
  not_allowed: 'This Google account is not allowed to use this site.',
};

async function main() {
  me = await currentUser();
  if (!me) return showLanding();
  const out = h('button', { class: 'ghost', title: 'Sign out' }, icon('logout'), 'Sign out');
  out.onclick = signOut;
  $('#me').replaceChildren(avatar(me), h('span', { class: 'name' }, me.name), out);
  $('#me').hidden = false;
  $('#dashboard').hidden = false;
  setupNewMenu();
  $('#motors-btn').onclick = motorsDialog;
  $('#search').oninput = render;
  await load();
  setInterval(() => load().catch(() => {}), 30_000);
}

function showLanding() {
  $('#landing').hidden = false;
  $('#hero-art').innerHTML = `<svg viewBox="0 0 420 260" fill="none" font-family="system-ui" font-size="11">
    <rect x="1" y="1" width="418" height="258" rx="8" fill="var(--surface-2)" stroke="var(--border)"/>
    <rect x="1" y="1" width="418" height="22" rx="8" fill="var(--surface)"/>
    <circle cx="14" cy="12" r="4" fill="#ff5f57"/><circle cx="27" cy="12" r="4" fill="#febc2e"/><circle cx="40" cy="12" r="4" fill="#28c840"/>
    <rect x="12" y="34" width="120" height="214" rx="4" fill="var(--surface)" stroke="var(--border)"/>
    <g fill="var(--muted)"><text x="22" y="52">Rocket</text><text x="32" y="68">Sustainer</text><text x="42" y="84">Nose cone</text><text x="42" y="100">Body tube</text><text x="52" y="116">Fin set</text><text x="52" y="132">Parachute</text></g>
    <rect x="38" y="90" width="88" height="14" rx="3" fill="#1c7ed6" fill-opacity=".18" stroke="#1c7ed6"/>
    <rect x="48" y="106" width="78" height="14" rx="3" fill="#e8590c" fill-opacity=".18" stroke="#e8590c"/>
    <g transform="translate(150 70)" stroke="var(--text)" stroke-width="1.6">
      <path d="M0 40 C 30 20, 55 22, 70 24 L 230 24 L 230 56 L 70 56 C 55 58, 30 60, 0 40 Z" fill="var(--surface)"/>
      <path d="M70 24 V56 M160 24 V56"/>
      <path d="M190 24 L 222 2 L 238 2 L 230 24 M190 56 L 222 78 L 238 78 L 230 56" fill="var(--accent)" fill-opacity=".25"/>
    </g>
    <g font-weight="700" fill="#fff"><rect x="282" y="168" width="124" height="22" rx="11" fill="#1c7ed6"/><text x="294" y="183">Mina · Body tube</text>
    <rect x="238" y="200" width="168" height="22" rx="11" fill="#e8590c"/><text x="250" y="215">Joon edited Fin set</text></g>
  </svg>`;
  const err = new URLSearchParams(location.search).get('error');
  if (err) {
    $('#signin-error').textContent = ERRORS[err] ?? 'Sign-in failed. Please try again.';
    $('#signin-error').hidden = false;
  }
  $('#google-signin').onclick = signIn;
}

// ------------------------------------------------------------------ list

const roleOf = (d) => (d.owner_email === me.email ? 'owner' : (d.members ?? []).find((m) => m.email === me.email)?.role ?? 'viewer');
const editedAt = (d) => Date.parse(d.edited_at ?? d.updated_date ?? d.created_date) || Date.now();

async function load() {
  designs = (await db.Design.list('-updated_date', 500)).sort((a, b) => editedAt(b) - editedAt(a));
  render();
}

function render() {
  const q = $('#search').value.trim().toLowerCase();
  const shown = designs.filter((d) => !q || d.name.toLowerCase().includes(q) || (d.owner_name ?? '').toLowerCase().includes(q));
  $('#empty').hidden = designs.length > 0;
  $('#projects').replaceChildren(...shown.map(card));
}

function card(d) {
  const role = roleOf(d);
  const open = () => { location.href = `/design.html?id=${d.id}`; };
  const more = h('button', { class: 'ghost icon', title: 'More', 'aria-label': `More actions for ${d.name}` }, icon('more'));
  const menu = h('div', { class: 'menu', hidden: true });
  const item = (ic, label, fn, cls) => {
    const b = h('button', { class: cls }, icon(ic), label);
    b.onclick = (e) => {
      e.stopPropagation();
      menu.hidden = true;
      fn();
    };
    return b;
  };
  menu.append(
    item('history', 'Edit history', () => historyFor(d, role)),
    item('download', 'Saved copies', () => savedCopies(d)),
    ...(role === 'owner' ? [item('edit', 'Rename', () => rename(d))] : []),
    h('hr'),
    role === 'owner'
      ? item('trash', 'Delete', () => remove(d), 'danger')
      : item('logout', 'Leave design', () => leave(d), 'danger'),
  );
  more.onclick = (e) => {
    e.stopPropagation();
    document.querySelectorAll('.menu').forEach((m) => m !== menu && (m.hidden = true));
    menu.hidden = !menu.hidden;
    if (!menu.hidden) {
      // Open upwards when there is no room below the card.
      menu.classList.remove('up');
      if (menu.getBoundingClientRect().bottom > window.innerHeight - 8) menu.classList.add('up');
    }
  };
  const shareBtn = h('button', { class: 'ghost', title: 'Share' }, icon('share'), 'Share');
  shareBtn.onclick = () => shareDialog(d.id, me, () => load());
  const dl = h('button', { class: 'ghost', title: 'Download .ork' }, icon('download'));
  dl.onclick = () => download(d);
  const thumb = h('div', { class: 'thumb', html: ROCKET_SVG });
  thumb.onclick = open;
  const people = 1 + (d.members?.length ?? 0);
  return h('article', { class: 'card' },
    thumb,
    h('div', { class: 'body', onclick: open },
      h('h3', { title: d.name }, d.name),
      h('div', { class: 'meta' },
        h('span', {}, `Edited ${timeAgo(editedAt(d))}`),
        role !== 'owner' ? h('span', {}, `· ${d.owner_name ?? d.owner_email}`) : null,
        people > 1 ? h('span', { class: 'badge' }, `${people} people`) : null,
        role === 'viewer' ? h('span', { class: 'badge' }, 'View only') : null)),
    h('div', { class: 'foot' },
      h('span', { class: 'spacer' }),
      role === 'owner' ? shareBtn : null,
      dl,
      h('span', { class: 'menu-wrap' }, more, menu)));
}

document.addEventListener('click', () => document.querySelectorAll('.menu').forEach((m) => (m.hidden = true)));

// ------------------------------------------------------------------ create

function setupNewMenu() {
  const menu = $('#new-menu');
  $('#new-btn').onclick = (e) => {
    e.stopPropagation();
    menu.hidden = !menu.hidden;
  };
  menu.onclick = (e) => e.stopPropagation();
  for (const b of menu.querySelectorAll('[data-new]')) {
    b.onclick = () => {
      menu.hidden = true;
      ({ blank: newBlank, example: newFromExample, upload: () => $('#file').click() })[b.dataset.new]();
    };
  }
  $('#file').onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) uploadDesign(file);
  };
  // Drag and drop an .ork anywhere on the dashboard.
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    const file = e.dataTransfer?.files?.[0];
    if (file) uploadDesign(file);
  });
}

/** Creates the Design record, hands the content to its room, and opens it. */
async function createDesign(name, model) {
  toast('Creating the design…');
  const d = await db.Design.create({
    name,
    owner_email: me.email,
    owner_name: me.name,
    members: [],
    member_emails: [me.email],
    version: 0,
    edited_at: new Date().toISOString(),
  });
  try {
    await withRoom(d.id, (room) => room.request('init', { model: toJson(model) }, 120_000));
  } catch (e) {
    await db.Design.delete(d.id).catch(() => {});
    throw e;
  }
  location.href = `/design.html?id=${d.id}`;
}

async function uploadDesign(file) {
  try {
    const model = await importOrk(new Uint8Array(await file.arrayBuffer()));
    await createDesign(file.name.replace(/\.(ork|xml|rkt)$/i, '') || 'Rocket', model);
  } catch (e) {
    toast(e.message);
  }
}

async function newBlank() {
  const name = await promptDialog('New rocket design', 'Name', 'My rocket', 'Create');
  if (!name) return;
  try {
    const bytes = new Uint8Array(await (await fetch('/templates/new-rocket.ork')).arrayBuffer());
    await createDesign(name, await importOrk(bytes));
  } catch (e) {
    toast(e.message);
  }
}

async function newFromExample() {
  // OpenRocket's own example designs, read straight out of its jar.
  const jar = new RemoteZip(JAR);
  const list = h('div', { class: 'list' }, h('div', { class: 'item sub' }, 'Loading…'));
  const cancel = h('button', {}, 'Cancel');
  const { close } = modal('Start from an OpenRocket example', list, [cancel]);
  cancel.onclick = close;
  try {
    const examples = (await jar.list())
      .map((e) => e.name)
      .filter((n) => n.startsWith('datafiles/examples/') && n.endsWith('.ork'))
      .sort((a, b) => a.localeCompare(b));
    list.replaceChildren(...examples.map((path) => {
      const name = path.slice('datafiles/examples/'.length, -4);
      const b = h('div', { class: 'item', role: 'button', tabindex: 0, style: 'cursor:pointer' }, icon('rocket'), h('div', { class: 'grow' }, name));
      b.onclick = async () => {
        close();
        try {
          await createDesign(name, await importOrk(await jar.read(path)));
        } catch (e) {
          toast(e.message);
        }
      };
      b.onkeydown = (e) => e.key === 'Enter' && b.click();
      return b;
    }));
  } catch (e) {
    list.replaceChildren(h('div', { class: 'item sub' }, e.message));
  }
}

// ------------------------------------------------------------------ actions

async function download(d) {
  toast('Preparing the download…');
  try {
    const { model } = await withRoom(d.id, (room) => room.request('export'));
    saveFile(await exportOrk(fromJson(model)), fileName(d.name));
  } catch (e) {
    toast(e.message);
  }
}

function historyFor(d, role) {
  const room = new RoomClient(d.id).connect();
  const dialog = editHistoryDialog(room, { canRevert: role !== 'viewer' });
  dialog.addEventListener('close', () => room.close());
}

async function savedCopies(d) {
  const list = h('div', { class: 'list' }, h('div', { class: 'item sub' }, 'Loading…'));
  const close = h('button', {}, 'Close');
  const dlg = modal(`Saved copies — ${d.name}`, [
    h('p', { class: 'hint', style: 'margin:0' }, 'A copy is kept every 10 minutes while people are editing. Download one and upload it as a new design to restore it.'),
    list,
  ], [close]);
  close.onclick = dlg.close;
  try {
    const versions = await withRoom(d.id, (room) => room.request('snapshots'));
    list.replaceChildren(...(versions.length ? versions.map((v) => {
      const b = h('button', { class: 'ghost', title: 'Download this version' }, icon('download'), 'Download');
      b.onclick = async () => {
        try {
          const { model } = await withRoom(d.id, (room) => room.request('snapshot', { version: v.version }));
          saveFile(await exportOrk(fromJson(model)), fileName(`${d.name} (edit ${v.version})`));
        } catch (e) {
          toast(e.message);
        }
      };
      return h('div', { class: 'item' }, icon('history'),
        h('div', { class: 'grow' }, h('div', {}, new Date(v.createdAt).toLocaleString()), h('div', { class: 'sub' }, `Edit #${v.version}`)), b);
    }) : [h('div', { class: 'item sub' }, 'No saved versions yet.')]));
  } catch (e) {
    list.replaceChildren(h('div', { class: 'item sub' }, e.message));
  }
}

async function rename(d) {
  const name = await promptDialog('Rename design', 'Name', d.name);
  if (!name) return;
  await db.Design.update(d.id, { name });
  load();
}

async function remove(d) {
  if (!(await confirmDialog('Delete design?', `“${d.name}” will be deleted for everyone it is shared with. This cannot be undone.`, 'Delete', true))) return;
  try {
    await withRoom(d.id, (room) => room.request('destroy'));
  } catch {
    // Its content may already be gone; the record goes regardless.
  }
  await db.Design.delete(d.id);
  toast('Design deleted');
  load();
}

async function leave(d) {
  if (!(await confirmDialog('Leave design?', `You will lose access to “${d.name}” until someone shares it with you again.`, 'Leave', true))) return;
  try {
    await base44.functions.invoke('leaveDesign', { designId: d.id });
    load();
  } catch (e) {
    toast(e.response?.data?.error ?? e.message);
  }
}

// ------------------------------------------------------------------ custom motors

async function motorsDialog() {
  const list = h('div', { class: 'list' });
  const error = h('div', { class: 'error' });
  const input = h('input', { type: 'file', accept: '.eng,.rse', multiple: true, hidden: true });
  const add = h('button', { class: 'primary' }, icon('upload'), 'Add .eng / .rse files');
  const done = h('button', {}, 'Done');
  const render = async () => {
    const files = await db.Motor.list('-created_date', 200);
    list.replaceChildren(...(files.length ? files.map((f) => {
      const motors = JSON.parse(f.summary || '[]');
      const dl = h('button', { class: 'ghost icon', title: `Download ${f.filename}`, 'aria-label': `Download ${f.filename}` }, icon('download'));
      dl.onclick = () => saveFile(new TextEncoder().encode(f.content), f.filename);
      const rm = h('button', { class: 'ghost icon', title: 'Remove', 'aria-label': `Remove ${f.filename}` }, icon('trash'));
      rm.onclick = async () => {
        await db.Motor.delete(f.id);
        render();
      };
      const m = motors[0] ?? {};
      const details = [m.manufacturer, m.diameterMm ? `${m.diameterMm} mm` : '', m.impulseNs ? `${m.impulseNs.toFixed(1)} N·s (${m.impulseClass})` : '']
        .filter(Boolean).join(' · ');
      return h('div', { class: 'item' }, icon('flame'),
        h('div', { class: 'grow' }, h('div', {}, motors.map((x) => x.designation).join(', ') || f.filename), h('div', { class: 'sub' }, `${details} — ${f.filename}`)), dl, rm);
    }) : [h('div', { class: 'item sub' }, 'No custom motors yet.')]));
  };
  const upload = async (fileList) => {
    error.textContent = '';
    for (const file of fileList) {
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const text = new TextDecoder().decode(bytes);
        const { motors } = readMotorFile(file.name, Object.assign(bytes, { toString: () => text }));
        await db.Motor.create({ owner_email: me.email, filename: file.name, content: text, summary: JSON.stringify(motors) });
      } catch (err) {
        error.textContent = `${file.name}: ${err.message}`;
      }
    }
    render();
  };
  input.onchange = () => {
    upload([...input.files]);
    input.value = '';
  };
  add.onclick = () => input.click();
  const { dialog, close } = modal('Custom motors', [
    h('p', { class: 'hint', style: 'margin:0' },
      'Motor files you add here show up in OpenRocket\'s motor selector (Select a rocket motor), together with the built-in motors. ',
      'Everyone a design is shared with gets the motors of all its members, so your team always sees the same motors. ',
      'If a design is already open, reload its page to load new motors.'),
    error, list, input,
  ], [add, done]);
  done.onclick = close;
  dialog.addEventListener('dragover', (e) => e.preventDefault());
  dialog.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    upload([...(e.dataTransfer?.files ?? [])]);
  });
  render().catch((e) => (error.textContent = e.message));
}

main().catch((e) => toast(e.message));
