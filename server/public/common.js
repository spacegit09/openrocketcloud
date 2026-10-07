// Shared helpers for the dashboard and the session page.

export async function api(path, { method = 'GET', body, headers = {}, raw = false } = {}) {
  const opts = { method, headers: { 'x-orcloud': '1', ...headers } };
  if (body instanceof Blob || body instanceof ArrayBuffer) {
    opts.body = body;
  } else if (body !== undefined) {
    opts.body = JSON.stringify(body);
    opts.headers['content-type'] = 'application/json';
  }
  const res = await fetch(`/api${path}`, opts);
  if (raw) return res;
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  if (!res.ok) {
    const err = new Error(data?.error ?? `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export const $ = (sel, root = document) => root.querySelector(sel);

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const ICONS = {
  rocket: '<path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
  share: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.59 13.51 6.83 3.98M15.41 6.51l-6.82 3.98"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
  more: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
  history: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  trash: '<path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  back: '<path d="m15 18-6-6 6-6"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  power: '<path d="M18.36 6.64a9 9 0 1 1-12.73 0M12 2v10"/>',
  book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V2H6.5A2.5 2.5 0 0 0 4 4.5v15z"/><path d="M20 17v5H6.5a2.5 2.5 0 0 1 0-5"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  flame: '<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.07-2.14-.22-4.05 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.15.43-2.29 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>',
  folder: '<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/>',
  refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  maximize: '<path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/>',
};

export function icon(name) {
  const span = document.createElement('span');
  span.style.display = 'contents';
  span.innerHTML = `<svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] ?? ''}</svg>`;
  return span.firstElementChild;
}

export function initials(name) {
  return (name ?? '?').split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((s) => s[0].toUpperCase()).join('') || '?';
}

export function avatar(person, title) {
  const el = h('span', { class: 'avatar', title: title ?? person.name ?? person.email });
  el.style.setProperty('--c', person.color ?? '#868e96');
  if (person.picture) {
    const img = h('img', { src: person.picture, alt: '', referrerpolicy: 'no-referrer' });
    img.onerror = () => img.replaceWith(initials(person.name ?? person.email));
    el.append(img);
  } else {
    el.textContent = initials(person.name ?? person.email);
  }
  return el;
}

export function timeAgo(ms) {
  const s = Math.max(1, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const hr = Math.round(m / 60);
  if (hr < 24) return `${hr} h ago`;
  const d = Math.round(hr / 24);
  if (d < 30) return `${d} d ago`;
  return new Date(ms).toLocaleDateString();
}

let toastTimer;
export function toast(text) {
  document.querySelector('.toast')?.remove();
  const el = h('div', { class: 'toast', role: 'status' }, text);
  document.body.append(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), 3500);
}

/** Minimal modal dialog; returns { dialog, close }. */
export function modal(title, content, actions = []) {
  const dlg = h('dialog', {},
    h('header', {}, title),
    h('div', { class: 'content' }, content),
    actions.length ? h('footer', {}, actions) : null);
  document.body.append(dlg);
  dlg.addEventListener('close', () => dlg.remove());
  dlg.showModal();
  return { dialog: dlg, close: () => dlg.close() };
}

export function confirmDialog(title, text, okLabel = 'OK', danger = false) {
  return new Promise((resolve) => {
    const ok = h('button', { class: danger ? 'primary danger-fill' : 'primary' }, okLabel);
    const cancel = h('button', {}, 'Cancel');
    const { dialog, close } = modal(title, h('p', { style: 'margin:0' }, text), [cancel, ok]);
    let result = false;
    ok.onclick = () => { result = true; close(); };
    cancel.onclick = close;
    dialog.addEventListener('close', () => resolve(result));
  });
}

export function promptDialog(title, label, value = '', okLabel = 'Save') {
  return new Promise((resolve) => {
    const input = h('input', { value, 'aria-label': label });
    const ok = h('button', { class: 'primary', type: 'submit' }, okLabel);
    const cancel = h('button', { type: 'button' }, 'Cancel');
    const form = h('form', { method: 'dialog', style: 'display:contents' }, h('label', { class: 'hint' }, label), input);
    const { dialog, close } = modal(title, form, [cancel, ok]);
    let result = null;
    const submit = () => { result = input.value.trim(); close(); };
    form.onsubmit = (e) => { e.preventDefault(); submit(); };
    ok.onclick = submit;
    cancel.onclick = close;
    dialog.addEventListener('close', () => resolve(result || null));
    input.select();
  });
}

export function download(url) {
  const a = h('a', { href: url, download: '' });
  document.body.append(a);
  a.click();
  a.remove();
}

/** Share dialog (used on both pages). */
export async function shareDialog(projectId, onChange) {
  const list = h('div', { class: 'list' });
  const email = h('input', { type: 'email', placeholder: 'friend@gmail.com', 'aria-label': 'Email address' });
  const role = h('select', { 'aria-label': 'Access' }, h('option', { value: 'editor' }, 'Can edit'), h('option', { value: 'viewer' }, 'Can view'));
  const add = h('button', { class: 'primary', type: 'submit' }, 'Invite');
  const error = h('div', { class: 'error' });
  const form = h('form', { class: 'row' }, email, role, add);
  const done = h('button', {}, 'Done');
  const { close } = modal('Share this design', [
    h('p', { class: 'hint', style: 'margin:0' }, 'People you add can open the design with their Google account and work on it with you in real time.'),
    form, error, list,
  ], [done]);
  done.onclick = close;

  let me = null;
  const render = async () => {
    const [p, user] = await Promise.all([api(`/projects/${projectId}`), me ?? api('/me')]);
    me = user;
    const owner = p.role === 'owner';
    form.hidden = !owner;
    list.replaceChildren(...p.members.map((m) => {
      const isMe = m.email === me.email;
      let control;
      if (m.role === 'owner') {
        control = h('span', { class: 'badge' }, 'Owner');
      } else if (owner) {
        const sel = h('select', { 'aria-label': `Access for ${m.email}` },
          h('option', { value: 'editor', selected: m.role === 'editor' }, 'Can edit'),
          h('option', { value: 'viewer', selected: m.role === 'viewer' }, 'Can view'));
        sel.onchange = async () => {
          await api(`/projects/${projectId}/members`, { method: 'POST', body: { email: m.email, role: sel.value } });
          toast('Access updated');
        };
        const rm = h('button', { class: 'ghost icon', title: 'Remove', 'aria-label': `Remove ${m.email}` }, icon('x'));
        rm.onclick = async () => {
          await api(`/projects/${projectId}/members/${encodeURIComponent(m.email)}`, { method: 'DELETE' });
          render();
          onChange?.();
        };
        control = h('span', { class: 'row' }, sel, rm);
      } else {
        control = h('span', { class: 'badge' }, m.role === 'editor' ? 'Can edit' : 'Can view');
      }
      return h('div', { class: 'item' },
        avatar({ name: m.name ?? m.email, email: m.email, picture: m.picture, color: m.color }),
        h('div', { class: 'grow' }, h('div', {}, m.name ?? m.email, isMe ? ' (you)' : ''), h('div', { class: 'sub' }, m.name ? m.email : 'Has not signed in yet')),
        control);
    }));
  };
  form.onsubmit = async (e) => {
    e.preventDefault();
    error.textContent = '';
    try {
      await api(`/projects/${projectId}/members`, { method: 'POST', body: { email: email.value, role: role.value } });
      email.value = '';
      render();
      onChange?.();
    } catch (err) {
      error.textContent = err.message;
    }
  };
  await render();
}

export const ROCKET_SVG = `<svg viewBox="0 0 300 80" fill="none" stroke="currentColor" stroke-width="3" stroke-linejoin="round">
  <path d="M30 40 C 60 18, 90 22, 110 26 L 250 26 L 250 54 L 110 54 C 90 58, 60 62, 30 40 Z" fill="currentColor" fill-opacity=".12"/>
  <path d="M110 26 V54 M200 26 V54"/>
  <path d="M215 26 L 245 6 L 262 6 L 250 26 M215 54 L 245 74 L 262 74 L 250 54" fill="currentColor" fill-opacity=".25"/>
  <path d="M250 32 L 262 32 L 262 48 L 250 48"/>
</svg>`;

// ------------------------------------------------------------------ edit history

function describeChange(c) {
  switch (c.kind) {
    case 'add': return `Added ${c.target}`;
    case 'remove': return `Removed ${c.target}`;
    case 'move': return `Moved ${c.target}`;
    case 'reorder': return `Reordered ${c.target}`;
    case 'replace': return `Replaced ${c.target}`;
    default: return 'from' in c ? `${c.target} · ${c.prop}: ${c.from} → ${c.to}` : `${c.target} · ${c.prop} changed`;
  }
}

const when = (at) => new Date(at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/** Who changed what, with "undo these changes" and "restore to before this". */
export function editHistoryDialog(projectId) {
  const list = h('div', { class: 'history' }, h('p', { class: 'sub' }, 'Loading…'));
  const more = h('button', { hidden: true }, 'Show older edits');
  const close = h('button', { class: 'primary' }, 'Done');
  const { dialog } = modal('Edit history', [
    h('p', { class: 'hint', style: 'margin:0' }, 'Every change to this design, newest first. Undo reverts one person\'s changes (anything changed again since is kept). Restore puts the whole design back the way it was before that change.'),
    list, more,
  ], [close]);
  dialog.classList.add('wide');
  close.onclick = () => dialog.close();
  let before = null;

  const revert = async (g, mode) => {
    const who = g.userName;
    const ok = mode === 'undo'
      ? await confirmDialog('Undo these changes?', `${who}'s changes from ${when(g.at)} will be reverted for everyone. Anything changed again since then is kept.`, 'Undo changes')
      : await confirmDialog('Restore this version?', `The design goes back to how it was before ${who}'s change at ${when(g.at)}. Everything changed after that, by anyone, is undone for everyone. You can undo the restore afterwards.`, 'Restore');
    if (!ok) return;
    try {
      const r = await api(`/projects/${projectId}/edits/revert`, { method: 'POST', body: { mode, from: g.from, to: g.to, userId: g.userId } });
      if (!r.applied && r.skipped) toast('Nothing was reverted: all of it was changed again later.');
      else if (r.skipped) toast(`Reverted. ${r.skipped} change${r.skipped > 1 ? 's were' : ' was'} kept because someone changed ${r.skipped > 1 ? 'them' : 'it'} later.`);
      else toast(mode === 'undo' ? 'Changes undone.' : 'Earlier version restored.');
      before = null;
      list.replaceChildren(h('p', { class: 'sub' }, 'Loading…'));
      load();
    } catch (e) {
      toast(e.message);
    }
  };

  const entry = (g, canRevert) => {
    let title;
    if (g.note?.kind === 'undo') title = `undid ${g.note.name}'s changes from ${when(g.note.at)}`;
    else if (g.note?.kind === 'restore') title = `restored the version from before ${g.note.name}'s change at ${when(g.note.at)}`;
    else title = '';
    const lines = g.changes.map(describeChange);
    const shown = h('ul', {}, lines.slice(0, 6).map((l) => h('li', {}, l)));
    const extra = lines.length > 6 ? h('button', { class: 'ghost link' }, `and ${lines.length - 6} more`) : null;
    if (extra) {
      extra.onclick = () => {
        shown.replaceChildren(...lines.map((l) => h('li', {}, l)));
        extra.remove();
      };
    }
    const actions = canRevert ? h('div', { class: 'row' },
      h('button', { onclick: () => revert(g, 'undo') }, icon('back'), 'Undo these changes'),
      h('button', { class: 'ghost', onclick: () => revert(g, 'restore') }, icon('history'), 'Restore to before this')) : null;
    return h('div', { class: 'edit' },
      avatar({ name: g.userName, color: g.color }),
      h('div', { class: 'grow' },
        h('div', {}, h('b', {}, g.userName), title ? ` ${title}` : '', h('span', { class: 'sub' }, ` · ${when(g.at)} (${timeAgo(g.at)})`)),
        lines.length ? shown : h('div', { class: 'sub' }, 'No visible changes'),
        extra, actions));
  };

  async function load() {
    const data = await api(`/projects/${projectId}/edits${before ? `?before=${before}` : ''}`);
    if (!before) list.replaceChildren();
    if (!data.groups.length && !list.children.length) list.append(h('p', { class: 'sub' }, 'No edits recorded yet. Changes appear here as soon as someone edits the design.'));
    list.append(...data.groups.map((g) => entry(g, data.canRevert)));
    before = data.nextBefore;
    more.hidden = !before;
  }
  more.onclick = load;
  load().catch((e) => toast(e.message));
}
