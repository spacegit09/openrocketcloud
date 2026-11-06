// OpenRocket's menus in the header row (orcloud.web.MenuRow in worker/bridge/web). The header lies
// over the top of OpenRocket's window; the page leaves a gap after the design's name, and Java draws
// its menu bar as tall as the header with the menus in that gap. The header then takes the menu
// bar's colours, and lets clicks outside its own buttons through to it. Where the header has no
// room, the menus are a row of their own under it.
//
// A placement is "x,height": the gap's left edge in OpenRocket's window and the header's height, or
// x = -1 for a row of their own.

const $ = (s) => document.querySelector(s);
const MIN_TITLE = 120; // the design's name keeps at least this much room (px), or all of a shorter one

let menus = null; // { width, background, foreground, line } from Java
let sent = '';
const queue = [];
let waiting = null;

function placement() {
  const bar = $('.sbar');
  const slot = $('#menu-slot');
  const height = Math.round(bar.getBoundingClientRect().height);
  if (!menus) return `-1,${height}`;
  // Measured with the gap open; nothing is drawn in between.
  slot.hidden = false;
  slot.style.width = `${menus.width + 8}px`;
  const title = $('#title');
  const last = bar.lastElementChild.getBoundingClientRect();
  const fits = title.clientWidth >= Math.min(title.scrollWidth, MIN_TITLE) && last.right <= bar.getBoundingClientRect().right;
  if (!fits) {
    slot.hidden = true;
    return `-1,${height}`;
  }
  return `${Math.round(slot.getBoundingClientRect().left - $('#screen').getBoundingClientRect().left)},${height}`;
}

function update() {
  if (!menus) return;
  const p = placement();
  if (p === sent) return;
  sent = p;
  // Out of the header row: the header covers the window again at once, then Java moves the menus.
  if (p.startsWith('-1')) $('.sbar').classList.remove('merged');
  if (waiting) {
    const w = waiting;
    waiting = null;
    w(p);
  } else {
    queue.push(p);
  }
}

let frame = 0;
function later() {
  cancelAnimationFrame(frame);
  frame = requestAnimationFrame(update);
}

function watch() {
  const ro = new ResizeObserver(later);
  for (const s of ['.sbar', '#title', '#status', '#role-badge', '#people', '#share-btn']) {
    const el = $(s);
    if (el) ro.observe(el);
  }
  window.addEventListener('resize', later);
}

export const menuRowNatives = {
  async Java_orcloud_web_MenuRow_jsMenus(lib, width, background, foreground, line) {
    menus = { width, background, foreground, line };
    const bar = $('.sbar');
    bar.style.setProperty('--or-bg', background);
    bar.style.setProperty('--or-fg', foreground);
    bar.style.setProperty('--or-line', line);
    document.body.classList.add('menu-row'); // OpenRocket's window now starts under the header
    watch();
    sent = placement();
    return sent;
  },
  async Java_orcloud_web_MenuRow_jsNextPlace() {
    return queue.length ? queue.shift() : new Promise((resolve) => (waiting = resolve));
  },
  async Java_orcloud_web_MenuRow_jsPlaced(lib, p) {
    // Into the header row once Java has made room, so the header never covers OpenRocket's content.
    if (p === sent) $('.sbar').classList.toggle('merged', !p.startsWith('-1'));
  },
};
