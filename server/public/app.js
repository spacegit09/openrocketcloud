import {
  api, $, h, icon, avatar, timeAgo, toast, modal, confirmDialog, promptDialog, download, shareDialog, editHistoryDialog, ROCKET_SVG,
} from './common.js';

for (const el of document.querySelectorAll('[data-icon]')) el.replaceWith(icon(el.dataset.icon));
$('#logo').append(icon('rocket'));

const ERRORS = {
  not_allowed: 'This Google account is not allowed to use this site. Ask the administrator to add it.',
  email_not_verified: 'Please verify your Google account email first.',
  signin_expired: 'The sign-in took too long. Please try again.',
  signin_failed: 'Google sign-in failed. Please try again.',
  access_denied: 'Sign-in was cancelled.',
};

let projects = [];

async function main() {
  let me;
  try {
    me = await api('/me');
  } catch {
    return showLanding();
  }
  const name = h('span', { class: 'name' }, me.name);
  const out = h('button', { class: 'ghost', title: 'Sign out' }, icon('logout'), 'Sign out');
  out.onclick = async () => {
    const res = await fetch('/auth/logout', { method: 'POST' }).then((r) => r.json()).catch(() => ({}));
    location.href = res.next ?? '/';
  };
  $('#me').replaceChildren(avatar(me), name, out);
  $('#me').hidden = false;
  $('#dashboard').hidden = false;
  setupNewMenu();
  $('#motors-btn').onclick = motorsDialog;
  $('#search').oninput = render;
  await load();
  setInterval(load, 15000);
}

async function showLanding() {
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
    $('#signin-error').textContent = ERRORS[err] ?? 'Sign-in failed.';
    $('#signin-error').hidden = false;
  }
  const cfg = await fetch('/auth/config').then((r) => r.json()).catch(() => ({}));
  // The Base44 front door is the way in; it signs people back in here without a click.
  if (cfg.frontDoor && !err) return location.replace('/auth/login');
  if (!cfg.google && !cfg.frontDoor) $('#google-signin').title = 'Google sign-in is not configured on this server';
  if (cfg.devLogin) {
    $('#dev-login').hidden = false;
    $('#dev-login').onsubmit = (e) => {
      e.preventDefault();
      location.href = `/auth/dev?email=${encodeURIComponent(e.target.email.value)}`;
    };
  }
}

async function load() {
  projects = await api('/projects');
  render();
}

function render() {
  const q = $('#search').value.trim().toLowerCase();
  const shown = projects.filter((p) => !q || p.name.toLowerCase().includes(q) || p.owner.name.toLowerCase().includes(q));
  $('#empty').hidden = projects.length > 0;
  $('#projects').replaceChildren(...shown.map(card));
}

function card(p) {
  const open = () => { location.href = `/p/${p.id}`; };
  const more = h('button', { class: 'ghost icon', title: 'More', 'aria-label': `More actions for ${p.name}` }, icon('more'));
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
    item('history', 'Edit history', () => editHistoryDialog(p.id)),
    item('download', 'Saved copies', () => historyDialog(p)),
    ...(p.role !== 'viewer' ? [item('edit', 'Rename', () => rename(p))] : []),
    h('hr'),
    p.role === 'owner'
      ? item('trash', 'Delete', () => remove(p), 'danger')
      : item('logout', 'Leave design', () => leave(p), 'danger'),
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
  shareBtn.onclick = () => shareDialog(p.id, load);
  const dl = h('button', { class: 'ghost', title: 'Download .ork' }, icon('download'));
  dl.onclick = () => download(`/api/projects/${p.id}/download`);
  const thumb = h('div', { class: 'thumb', html: ROCKET_SVG });
  thumb.onclick = open;
  return h('article', { class: 'card' },
    thumb,
    h('div', { class: 'body', onclick: open },
      h('h3', { title: p.name }, p.name),
      h('div', { class: 'meta' },
        h('span', {}, `Edited ${timeAgo(p.updatedAt)}`),
        p.role !== 'owner' ? h('span', {}, `· ${p.owner.name}`) : null,
        p.members > 1 ? h('span', { class: 'badge' }, `${p.members} people`) : null,
        p.role === 'viewer' ? h('span', { class: 'badge' }, 'View only') : null,
        p.online.length ? h('span', { class: 'badge live' }, `${p.online.length} live`) : null)),
    h('div', { class: 'foot' },
      h('span', { class: 'avatars' }, p.online.map((u) => avatar(u))),
      h('span', { class: 'spacer' }),
      p.role === 'owner' ? shareBtn : null,
      dl,
      h('span', { class: 'menu-wrap' }, more, menu)));
}

document.addEventListener('click', () => document.querySelectorAll('.menu').forEach((m) => (m.hidden = true)));

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
    if (!file) return;
    toast(`Uploading ${file.name}…`);
    try {
      const { id } = await api('/projects/import', { method: 'POST', body: file, headers: { 'x-filename': encodeURIComponent(file.name) } });
      location.href = `/p/${id}`;
    } catch (err) {
      toast(err.message);
    }
  };
  // Drag and drop an .ork anywhere on the dashboard.
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    const file = e.dataTransfer?.files?.[0];
    if (file) {
      const dt = new DataTransfer();
      dt.items.add(file);
      $('#file').files = dt.files;
      $('#file').dispatchEvent(new Event('change'));
    }
  });
}

async function newBlank() {
  const name = await promptDialog('New rocket design', 'Name', 'My rocket', 'Create');
  if (!name) return;
  const { id } = await api('/projects', { method: 'POST', body: { name } });
  location.href = `/p/${id}`;
}

async function newFromExample() {
  const { examples } = await api('/templates');
  const list = h('div', { class: 'list' }, examples.map((name) => {
    const b = h('div', { class: 'item', role: 'button', tabindex: 0, style: 'cursor:pointer' },
      icon('rocket'), h('div', { class: 'grow' }, name));
    b.onclick = async () => {
      close();
      const { id } = await api('/projects', { method: 'POST', body: { example: name } });
      location.href = `/p/${id}`;
    };
    b.onkeydown = (e) => e.key === 'Enter' && b.click();
    return b;
  }));
  const cancel = h('button', {}, 'Cancel');
  const { close } = modal('Start from an OpenRocket example', examples.length ? list : h('p', {}, 'No examples are installed on this server.'), [cancel]);
  cancel.onclick = close;
}

async function rename(p) {
  const name = await promptDialog('Rename design', 'Name', p.name);
  if (!name) return;
  await api(`/projects/${p.id}`, { method: 'PATCH', body: { name } });
  load();
}

async function remove(p) {
  if (!(await confirmDialog('Delete design?', `“${p.name}” will be deleted for everyone it is shared with. This cannot be undone.`, 'Delete', true))) return;
  await api(`/projects/${p.id}`, { method: 'DELETE' });
  toast('Design deleted');
  load();
}

async function leave(p) {
  if (!(await confirmDialog('Leave design?', `You will lose access to “${p.name}” until someone shares it with you again.`, 'Leave', true))) return;
  const me = await api('/me');
  await api(`/projects/${p.id}/members/${encodeURIComponent(me.email)}`, { method: 'DELETE' });
  load();
}

async function motorsDialog() {
  const list = h('div', { class: 'list' });
  const error = h('div', { class: 'error' });
  const input = h('input', { type: 'file', accept: '.eng,.rse', multiple: true, hidden: true });
  const add = h('button', { class: 'primary' }, icon('upload'), 'Add .eng / .rse files');
  const done = h('button', {}, 'Done');
  const render = async () => {
    const files = await api('/motors');
    list.replaceChildren(...(files.length ? files.map((f) => {
      const dl = h('button', { class: 'ghost icon', title: `Download ${f.filename}`, 'aria-label': `Download ${f.filename}` }, icon('download'));
      dl.onclick = () => download(`/api/motors/${f.id}/download`);
      const rm = h('button', { class: 'ghost icon', title: 'Remove', 'aria-label': `Remove ${f.filename}` }, icon('trash'));
      rm.onclick = async () => {
        await api(`/motors/${f.id}`, { method: 'DELETE' });
        render();
      };
      const names = f.motors.map((m) => m.designation).join(', ');
      const m = f.motors[0];
      const details = [m.manufacturer, m.diameterMm ? `${m.diameterMm} mm` : '', m.impulseNs ? `${m.impulseNs.toFixed(1)} N·s (${m.impulseClass})` : '']
        .filter(Boolean).join(' · ');
      return h('div', { class: 'item' }, icon('flame'),
        h('div', { class: 'grow' }, h('div', {}, names), h('div', { class: 'sub' }, `${details} — ${f.filename}`)), dl, rm);
    }) : [h('div', { class: 'item sub' }, 'No custom motors yet.')]));
  };
  const upload = async (fileList) => {
    error.textContent = '';
    for (const file of fileList) {
      try {
        await api('/motors', { method: 'POST', body: file, headers: { 'x-filename': encodeURIComponent(file.name) } });
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
      'If OpenRocket is already open, close it with the power button and reopen the design to load new motors.'),
    error, list, input,
  ], [add, done]);
  done.onclick = close;
  dialog.addEventListener('dragover', (e) => e.preventDefault());
  dialog.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    upload([...(e.dataTransfer?.files ?? [])]);
  });
  render();
}

async function historyDialog(p) {
  const versions = await api(`/projects/${p.id}/history`);
  const list = h('div', { class: 'list' }, versions.map((v) => {
    const b = h('button', { class: 'ghost', title: 'Download this version' }, icon('download'), 'Download');
    b.onclick = () => download(`/api/projects/${p.id}/history/${v.version}/download`);
    return h('div', { class: 'item' }, icon('history'),
      h('div', { class: 'grow' }, h('div', {}, new Date(v.createdAt).toLocaleString()), h('div', { class: 'sub' }, `Edit #${v.version}`)), b);
  }));
  const close = h('button', {}, 'Close');
  const dlg = modal(`Saved copies — ${p.name}`, [
    h('p', { class: 'hint', style: 'margin:0' }, 'A copy is kept every 10 minutes while people are editing. Download one and upload it as a new design to restore it.'),
    versions.length ? list : h('p', {}, 'No saved versions yet.'),
  ], [close]);
  close.onclick = dlg.close;
}

main();
