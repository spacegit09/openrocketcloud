// Runs the official OpenRocket in this page with CheerpJ (Java in the browser) and connects its
// live-share bridge (orcloud.bridge.BrowserLink in worker/bridge/web) to the design's room.
const CHEERPJ = 'https://cjrtnc.leaningtech.com/4.3/loader.js';

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
 * Starts OpenRocket for `designId` in the `screen` element. `room` is the design's RoomClient;
 * OpenRocket's bridge talks to it through the BrowserLink natives below.
 */
export async function startOpenRocket({ designId, screen, room, onReady, onExit }) {
  await loadScript(CHEERPJ);

  // Events for the bridge, which waits for them in BrowserLink.jsReceive: "o" connected,
  // "c" + reason disconnected, "m" + JSON a message from the room.
  const events = [];
  let waiting = null;
  const toJava = (event) => {
    if (waiting) {
      const w = waiting;
      waiting = null;
      w(event);
    } else {
      events.push(event);
    }
  };
  for (const type of ['welcome', 'ops', 'ack', 'kick', 'error']) {
    room.on(type, (msg, text) => toJava(`m${text ?? JSON.stringify(msg)}`));
  }
  room.on('open', () => toJava('o'));
  room.on('closed', (m) => toJava(`c${m.reason ?? ''}`));
  if (room.open) toJava('o');

  // Runtime files to fetch up front (recorded with cjGetRuntimeResources): Java threads then never
  // wait on the network halfway through loading a class, which CheerpJ handles badly.
  const preload = await fetch('/or/preload.json').then((r) => (r.ok ? r.json() : undefined), () => undefined);
  // CheerpJ's Java 17 lacks the natives behind reflection's type annotations (used by Guice only
  // for nullability hints); "none" is what Java reports for a class without them.
  const noTypeAnnotations = async () => null;
  await window.cheerpjInit({
    version: 17,
    preloadResources: preload,
    clipboardMode: 'system',
    javaProperties: [
      // No OpenGL in the browser: OpenRocket's own switch for computers without 3D.
      'openrocket.3d.disable=true',
      // JOGL (still loaded for the 2D figure) only knows real CPU types, not CheerpJ's.
      'os.arch=amd64',
      `orcloud.design=${designId}`,
    ],
    natives: {
      Java_java_lang_reflect_Field_getTypeAnnotationBytes0: noTypeAnnotations,
      Java_java_lang_reflect_Executable_getTypeAnnotationBytes0: noTypeAnnotations,
      Java_java_lang_Class_getRawTypeAnnotations: noTypeAnnotations,
      async Java_orcloud_bridge_BrowserLink_jsSend(lib, json) {
        room.send(json);
      },
      async Java_orcloud_bridge_BrowserLink_jsReceive() {
        return events.length ? events.shift() : new Promise((resolve) => (waiting = resolve));
      },
      async Java_orcloud_bridge_BrowserLink_jsReconnect() {
        room.reconnect();
      },
      async Java_orcloud_bridge_BrowserLink_jsClose() {},
      async Java_orcloud_bridge_BrowserLink_jsReady() {
        onReady?.();
      },
    },
  });
  window.cheerpjCreateDisplay(-1, -1, screen);
  const code = await window.cheerpjRunMain('orcloud.bridge.WebMain', '/app/or/orcloud-web.jar:/app/or/OpenRocket-web.jar');
  onExit?.(code);
}
