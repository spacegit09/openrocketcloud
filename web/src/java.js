// Runs the official OpenRocket in this page with CheerpJ (Java in the browser) and connects its
// live-share bridge (orcloud.bridge.BrowserLink in worker/bridge/web) to the design's room.
import { api } from './base44.js';
import { h, modal } from './common.js';
import { testHub } from './room-client.js';
import { view3dNatives } from './view3d.js';
import { markFileWindow } from './cj-windows.js';
import { latestPlacement, menuRowNatives } from './menu-row.js';
import { labNatives } from './flight/lab-natives.js';
import { CLASSPATH } from './lib/jars.js';

const CHEERPJ = 'https://cjrtnc.leaningtech.com/4.3/loader.js';
const MAX_MODEL_BYTES = 100 * 1024 * 1024;

/** How far the Java runtime's download has got (CheerpJ's preload): { done, total }, or null. */
let download = null;
const downloadListeners = new Set();

/**
 * Calls `listener({ done, total })` as the Java runtime downloads (now, if it has started). Most of
 * the wait before OpenRocket starts is this download, from CheerpJ's servers, which at times comes
 * slowly from some places (from Korea, at times answered in Seattle at tens of kilobytes a second),
 * and the browser does not keep it between visits: a page can show it is getting somewhere.
 */
export function onJavaDownload(listener) {
  downloadListeners.add(listener);
  if (download) listener(download);
  return () => downloadListeners.delete(listener);
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Could not load the Java runtime (CheerpJ). Check your connection and reload.'));
    document.head.append(s);
  });
}

/**
 * Lets the person choose an STL file for OpenRocket's "Import 3D model" (orcloud.web.StlImport)
 * and hands it to Java as a file under /str/. Resolves to the file, or null if none was chosen.
 */
function pickModelFile() {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept: '.stl,model/stl' });
    input.addEventListener('change', () => resolve(input.files[0] ?? null), { once: true });
    input.addEventListener('cancel', () => resolve(null), { once: true });
    try {
      input.showPicker(); // allowed right after the click on the dialog's Choose button
    } catch {
      // Browsers open file choosers only right after a click: ask for one.
      const choose = h('button', { class: 'primary' }, 'Choose file…');
      const cancel = h('button', {}, 'Cancel');
      const { dialog, close } = modal('Import 3D model (STL)', h('p', { style: 'margin:0' }, 'Choose the STL file to import.'), [cancel, choose]);
      let choosing = false;
      choose.onclick = () => {
        choosing = true;
        close();
        input.click();
      };
      cancel.onclick = close;
      dialog.addEventListener('close', () => choosing || resolve(null));
    }
  });
}

let modelFiles = 0;

// The bridge's side of the page: events for BrowserLink.jsReceive ("o" connected, "c" + reason
// disconnected, "m" + JSON a message from the room) and the room and callbacks of startOpenRocket.
const link = { events: [], waiting: null, room: null, onReady: null, designId: null, motors: null };

// Edits OpenRocket sent (their "seq") that the room has not confirmed yet: it confirms each batch
// with an "ack", or by passing it on to everyone, the sender included.
const unconfirmed = new Set();

/** Asks OpenRocket to send its last edits and close (the page's Close button). */
export function closeOpenRocket() {
  toJava('x');
}

// The design keeping OpenRocket's latest drawing of it (its card's preview), through the designs
// function (the room cannot seal it; with the local test hub, the hub keeps it).
let previewSaving = Promise.resolve();

/** Resolves once the design has kept OpenRocket's latest drawing of it, or after `timeoutMs`. */
export function previewSaved(timeoutMs = 5000) {
  return Promise.race([previewSaving, new Promise((r) => setTimeout(r, timeoutMs))]);
}

/** Resolves once the room has confirmed every edit OpenRocket sent, or after `timeoutMs`. */
export function editsSaved(timeoutMs = 5000) {
  const end = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const check = () => (!unconfirmed.size || Date.now() > end ? resolve(!unconfirmed.size) : setTimeout(check, 100));
    check();
  });
}

function toJava(event) {
  if (link.waiting) {
    const w = link.waiting;
    link.waiting = null;
    w(event);
  } else {
    link.events.push(event);
  }
}

let runtime = null;

/**
 * Downloads and starts the Java runtime (CheerpJ) for `designId`. It needs neither the sign-in nor
 * the room, so the design page calls it first and looks those up meanwhile; later calls share it.
 */
export function prepareJava(designId, { preload: preloadUrl = '/or/preload.json' } = {}) {
  runtime ??= (async () => {
    // Runtime files to fetch up front (recorded with cjGetRuntimeResources): Java threads then never
    // wait on the network halfway through loading a class, which CheerpJ handles badly.
    const [preload] = await Promise.all([
      fetch(preloadUrl).then((r) => (r.ok ? r.json() : undefined)).catch(() => undefined),
      loadScript(CHEERPJ),
    ]);
    // CheerpJ's Java 17 lacks the natives behind reflection's type annotations (used by Guice only
    // for nullability hints); "none" is what Java reports for a class without them.
    const noTypeAnnotations = async () => null;
    await window.cheerpjInit({
      version: 17,
      preloadResources: preload,
      preloadProgress: (done, total) => {
        download = { done, total };
        for (const listener of downloadListeners) listener(download);
      },
      clipboardMode: 'system',
      javaProperties: [
        // JOGL (OpenRocket's OpenGL library, for its photo studio) only knows real CPU types, not
        // CheerpJ's. The 3D view draws with WebGL instead (view3d.js).
        'os.arch=amd64',
        `orcloud.design=${designId}`,
        // On a Mac, the Command key adds to a selection, as in OpenRocket there (CommandClick.java).
        `orcloud.mac=${/mac/i.test(navigator.userAgentData?.platform ?? navigator.platform ?? '')}`,
      ],
      natives: {
        Java_java_lang_reflect_Field_getTypeAnnotationBytes0: noTypeAnnotations,
        Java_java_lang_reflect_Executable_getTypeAnnotationBytes0: noTypeAnnotations,
        Java_java_lang_Class_getRawTypeAnnotations: noTypeAnnotations,
        async Java_orcloud_bridge_BrowserLink_jsSend(lib, json) {
          if (json.startsWith('{"type":"ops"')) {
            try {
              unconfirmed.add(JSON.parse(json).seq);
            } catch {
              // not an edit batch after all
            }
          }
          link.room.send(json);
        },
        async Java_orcloud_bridge_BrowserLink_jsReceive() {
          return link.events.length ? link.events.shift() : new Promise((resolve) => (link.waiting = resolve));
        },
        async Java_orcloud_bridge_BrowserLink_jsReconnect() {
          link.room.reconnect();
        },
        async Java_orcloud_bridge_BrowserLink_jsClose() {},
        async Java_orcloud_bridge_BrowserLink_jsReady() {
          link.onReady?.();
          return latestPlacement();
        },
        async Java_orcloud_web_StlImport_jsPickStl() {
          const file = await pickModelFile();
          if (!file) return null;
          if (file.size > MAX_MODEL_BYTES) return `!${file.name} is larger than 100 MB.`;
          const path = `/str/model-${++modelFiles}.stl`;
          window.cheerpOSAddStringFile(path, new Uint8Array(await file.arrayBuffer()));
          return `${path}\n${file.name}`;
        },
        async Java_orcloud_web_Preview_jsPreview(lib, json) {
          // OpenRocket's drawing of the design, for its card on the dashboard.
          if (testHub()) {
            if (link.room) previewSaving = link.room.request('preview', { preview: json }, 20_000).catch(() => {});
          } else if (link.designId) {
            previewSaving = api('designs', { action: 'preview', id: link.designId, preview: json }).catch(() => {});
          }
        },
        async Java_orcloud_web_FileWindows_jsFileWindow(lib, x, y, w, h) {
          markFileWindow(x, y, w, h);
        },
        ...view3dNatives,
        ...menuRowNatives,
        ...labNatives,
      },
    });
  })();
  return runtime;
}

/**
 * Starts OpenRocket for `designId` in the `screen` element. `room` is the design's RoomClient;
 * OpenRocket's bridge talks to it through the BrowserLink natives above.
 */
export async function startOpenRocket({ designId, screen, room, onReady, onExit }) {
  link.room = room;
  link.onReady = onReady;
  link.designId = designId;
  // The custom motor files of everyone the design is shared with, for the room's welcome: the
  // room cannot read them (they are sealed), the designs function can. The local test hub sends
  // its own.
  link.motors = testHub() ? Promise.resolve(null) : api('designs', { action: 'motors', id: designId }).catch(() => null);
  await prepareJava(designId);
  // What the room says reaches OpenRocket in order, a welcome with the motor files in it.
  let order = Promise.resolve();
  const forward = (make) => {
    order = order.then(make).then((line) => line && toJava(line), () => {});
  };
  // Listeners are added after an await: called from inside the room's "open" event, that event
  // would otherwise also reach the "open" listener added here and connect the bridge twice.
  for (const type of ['welcome', 'ops', 'ack', 'kick', 'error']) {
    room.on(type, (msg, text) => forward(async () => {
      if (type === 'welcome' && !msg.motors?.length) {
        const motors = await link.motors;
        if (motors?.length) return `m${JSON.stringify({ ...msg, motors })}`;
      }
      return `m${text ?? JSON.stringify(msg)}`;
    }));
  }
  room.on('ack', (msg) => unconfirmed.delete(msg.seq));
  room.on('ops', (msg) => msg.from === room.connectionId && unconfirmed.delete(msg.seq));
  room.on('open', () => forward(() => 'o'));
  room.on('closed', (m) => forward(() => `c${m.reason ?? ''}`));
  if (room.open) forward(() => 'o');

  window.cheerpjCreateDisplay(-1, -1, screen);
  const code = await window.cheerpjRunMain('orcloud.bridge.WebMain', CLASSPATH);
  onExit?.(code);
}
