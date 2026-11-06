// OpenRocket's 3D view in the browser. OpenRocket draws it with OpenGL through native libraries a
// browser cannot load; here its Java side (orcloud.web.View3d, via the replacement RocketFigure3d)
// sends the meshes, looks, selection and marks through these natives, and the page draws them with
// WebGL in a canvas laid over the view's panel (view3d-renderer.js, loaded the first time a 3D view
// opens). Clicks on parts go back to Java as events.

const views = new Map();
const textures = new Map(); // id -> Promise<ImageBitmap | null>
const events = [];
let waiting = null;
let carets = null;
let renderer = null;

function loadRenderer() {
  renderer ??= import('./view3d-renderer.js');
  return renderer;
}

/** A copy of the first `n` items of a Java array (CheerpJ passes primitive arrays as typed arrays). */
function copy(array, n, Type) {
  if (ArrayBuffer.isView(array)) {
    return new Type(array.buffer.slice(array.byteOffset, array.byteOffset + n * Type.BYTES_PER_ELEMENT));
  }
  return Type.from(Array.prototype.slice.call(array, 0, n));
}

/** Sends an event to Java (View3d's event thread). */
function emit(event) {
  if (waiting) {
    const w = waiting;
    waiting = null;
    w(event);
  } else {
    events.push(event);
  }
}

/** Calls fn(view) once the renderer is loaded, in call order for each view; natives return at once. */
function withView(id, fn) {
  let v = views.get(id);
  if (!v) {
    v = { ready: loadRenderer().then((m) => m.createView(id, { emit, textures, carets: () => carets })) };
    views.set(id, v);
  }
  v.ready = v.ready.then((view) => {
    try {
      fn(view);
    } catch (e) {
      console.error('3D view:', e);
    }
    return view;
  });
}

function decodeImage(bytes) {
  return createImageBitmap(new Blob([bytes]), { imageOrientation: 'flipY', premultiplyAlpha: 'none' }).catch(() => null);
}

export const view3dNatives = {
  async Java_orcloud_web_View3d_jsScene(lib, id, json, faceSizes, faceCount, vertices, floatCount) {
    const scene = JSON.parse(json);
    const sizes = copy(faceSizes, faceCount, Int32Array);
    const verts = copy(vertices, floatCount, Float32Array);
    withView(id, (v) => v.setScene(scene, sizes, verts));
  },
  async Java_orcloud_web_View3d_jsTexture(lib, id, data, length) {
    textures.set(id, decodeImage(copy(data, length, Uint8Array)));
  },
  async Java_orcloud_web_View3d_jsPlace(lib, id, wx, wy, ww, wh, x, y, w, h) {
    withView(id, (v) => v.place({ wx, wy, ww, wh, x, y, w, h }));
  },
  async Java_orcloud_web_View3d_jsState(lib, id, json) {
    const state = JSON.parse(json);
    withView(id, (v) => v.setState(state));
  },
  async Java_orcloud_web_View3d_jsOverlay(lib, id, w, h, argb) {
    const px = copy(argb, w * h, Int32Array);
    withView(id, (v) => v.setOverlay(w, h, px));
  },
  async Java_orcloud_web_View3d_jsCarets(lib, size, cg, cp) {
    carets = { size, cg: copy(cg, size * size, Int32Array), cp: copy(cp, size * size, Int32Array) };
  },
  async Java_orcloud_web_View3d_jsNext() {
    return events.length ? events.shift() : new Promise((resolve) => (waiting = resolve));
  },
};
