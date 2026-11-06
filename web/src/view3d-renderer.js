// The WebGL renderer of OpenRocket's 3D view (see view3d.js): one per view, in a canvas laid over the
// view's Swing panel inside its CheerpJ window, so OpenRocket's dialogs and menus still open above it.
// It follows OpenRocket's own renderer (info.openrocket.swing.gui.figure3d): the same camera, light,
// fixed-function style shading and decal placement, rotation by dragging (right-drag moves the
// light), picking by clicking (shift reaches past selected parts), CG and CP marks, and the rocket
// information drawn by OpenRocket on top. The mouse wheel also zooms.
import {
  BufferAttribute,
  BufferGeometry,
  ClampToEdgeWrapping,
  Color,
  ColorManagement,
  DoubleSide,
  FrontSide,
  Group,
  LinearMipmapLinearFilter,
  LinearSRGBColorSpace,
  Matrix3,
  Mesh,
  MeshBasicMaterial,
  MirroredRepeatWrapping,
  OrthographicCamera,
  PerspectiveCamera,
  PlaneGeometry,
  Raycaster,
  RepeatWrapping,
  Scene,
  ShaderMaterial,
  ShapeUtils,
  Texture,
  Vector2,
  Vector3,
  Vector4,
  WebGLRenderer,
  WebGLRenderTarget,
} from 'three';

// OpenGL did no colour management; neither do these shaders.
ColorManagement.enabled = false;

const FOV_Y = 15; // degrees, as in OpenRocket
const STRIDE = 8; // floats per face vertex: position, normal, u, v (orcloud.view3d.RocketMesh)
const OUTSIDE = 0;
const INSIDE = 1;
const OUTLINE_PX = 3;

const vertexShader = /* glsl */ `
  uniform mat3 uvMatrix;
  varying vec3 vNormal;
  varying vec2 vUv;
  void main() {
    vNormal = normalize(normalMatrix * normal);
    vUv = (uvMatrix * vec3(uv, 1.0)).xy;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;

// OpenGL's fixed-function lighting as OpenRocket sets it up: one directional light fixed to the
// viewer, ambient + diffuse + Blinn-Phong specular, the decal blended over the paint by its alpha.
const fragmentShader = /* glsl */ `
  uniform vec4 color;
  uniform vec3 spec;
  uniform float shininess;
  uniform vec3 light;
  uniform vec3 lightDir;
  uniform sampler2D map;
  uniform int texMode;
  varying vec3 vNormal;
  varying vec2 vUv;
  void main() {
    vec3 n = normalize(vNormal);
    if (!gl_FrontFacing) n = -n;
    float ndl = max(dot(n, lightDir), 0.0);
    vec3 h = normalize(lightDir + vec3(0.0, 0.0, 1.0));
    float s = ndl > 0.0 ? pow(max(dot(n, h), 1e-6), shininess) : 0.0;
    vec3 base = color.rgb;
    if (texMode > 0) {
      vec4 t = texture2D(map, vUv);
      float inside = texMode == 2 ? step(0.0, vUv.x) * step(vUv.x, 1.0) * step(0.0, vUv.y) * step(vUv.y, 1.0) : 1.0;
      base = mix(base, t.rgb, t.a * inside);
    }
    gl_FragColor = vec4(min(base * (light.x + light.y * ndl) + spec * light.z * s, vec3(1.0)), color.a);
  }`;

const quadVertex = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

// The selection outline: the selected parts' silhouettes (drawn through everything, like
// OpenRocket's red selection lines) grown by a few pixels, one direction per pass.
const dilateFragment = /* glsl */ `
  uniform sampler2D mask;
  uniform vec2 step;
  varying vec2 vUv;
  void main() {
    float m = 0.0;
    for (int i = -8; i <= 8; i++) m = max(m, texture2D(mask, vUv + step * float(i)).r);
    gl_FragColor = vec4(m, m, m, 1.0);
  }`;

const outlineFragment = /* glsl */ `
  uniform sampler2D mask;
  uniform sampler2D grown;
  uniform vec2 step;
  varying vec2 vUv;
  void main() {
    float m = 0.0;
    for (int i = -8; i <= 8; i++) m = max(m, texture2D(grown, vUv + step * float(i)).r);
    if (m < 0.5 || texture2D(mask, vUv).r > 0.5) discard;
    gl_FragColor = vec4(1.0, 0.0, 0.0, 1.0);
  }`;

const WRAP = { repeat: RepeatWrapping, mirror: MirroredRepeatWrapping, clamp: ClampToEdgeWrapping, sticker: ClampToEdgeWrapping };

export function createView(id, context) {
  return new View(id, context);
}

/** The CheerpJ window element (div.cjWindow) showing the Java window with these screen bounds. */
function findWindow(wx, wy, ww, wh) {
  const wins = [...document.querySelectorAll('.cjWindow')].filter((d) => d.style.display !== 'none');
  const px = (v) => Math.round(parseFloat(v));
  return (
    wins.find((d) => px(d.style.left) === wx && px(d.style.top) === wy && px(d.style.width) === ww && px(d.style.height) === wh) ??
    wins.find((d) => px(d.style.width) === ww && px(d.style.height) === wh) ??
    null
  );
}

/** A canvas holding Java ARGB pixels. */
function argbCanvas(w, h, px) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const img = new ImageData(w, h);
  const d = img.data;
  for (let i = 0, j = 0; i < px.length; i++, j += 4) {
    const p = px[i];
    d[j] = (p >> 16) & 255;
    d[j + 1] = (p >> 8) & 255;
    d[j + 2] = p & 255;
    d[j + 3] = p >>> 24;
  }
  c.getContext('2d').putImageData(img, 0, 0);
  return c;
}

/**
 * Triangles of the faces [f0, f0 + count) whose vertices start at v0: positions, normals and
 * texture coordinates, wound to face where the exporter's normals point.
 */
function buildGeometry(sizes, verts, f0, count, v0) {
  let tris = 0;
  for (let f = f0; f < f0 + count; f++) tris += sizes[f] - 2;
  const pos = new Float32Array(tris * 9);
  const nor = new Float32Array(tris * 9);
  const uv = new Float32Array(tris * 6);
  let t = 0;
  let v = v0;
  const put = (i, nx, ny, nz, flat) => {
    const o = i * STRIDE;
    pos.set([verts[o], verts[o + 1], verts[o + 2]], t * 3);
    if (flat) nor.set([nx, ny, nz], t * 3);
    else nor.set([verts[o + 3], verts[o + 4], verts[o + 5]], t * 3);
    uv.set([verts[o + 6], verts[o + 7]], t * 2);
    t++;
  };
  for (let f = f0; f < f0 + count; f++) {
    const k = sizes[f];
    // The face's normal from its winding (Newell), and the exporter's normals if it gave them.
    let nx = 0, ny = 0, nz = 0, gx = 0, gy = 0, gz = 0;
    for (let i = 0; i < k; i++) {
      const a = (v + i) * STRIDE;
      const b = (v + ((i + 1) % k)) * STRIDE;
      nx += (verts[a + 1] - verts[b + 1]) * (verts[a + 2] + verts[b + 2]);
      ny += (verts[a + 2] - verts[b + 2]) * (verts[a] + verts[b]);
      nz += (verts[a] - verts[b]) * (verts[a + 1] + verts[b + 1]);
      gx += verts[a + 3];
      gy += verts[a + 4];
      gz += verts[a + 5];
    }
    const flat = Number.isNaN(gx);
    const flip = !flat && nx * gx + ny * gy + nz * gz < 0;
    const len = Math.hypot(nx, ny, nz) || 1;
    const fx = (flip ? -nx : nx) / len, fy = (flip ? -ny : ny) / len, fz = (flip ? -nz : nz) / len;
    let idx;
    if (k === 3) idx = [0, 1, 2];
    else if (k === 4) idx = [0, 1, 2, 0, 2, 3];
    else {
      // Fin outlines can be concave: ear clipping in the face's plane.
      const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
      const [p, q] = ax >= ay && ax >= az ? [1, 2] : ay >= az ? [2, 0] : [0, 1];
      const contour = [];
      for (let i = 0; i < k; i++) contour.push(new Vector2(verts[(v + i) * STRIDE + p], verts[(v + i) * STRIDE + q]));
      idx = ShapeUtils.triangulateShape(contour, []).flat();
    }
    for (let i = 0; i + 2 < idx.length; i += 3) {
      let a = idx[i], b = idx[i + 1], c = idx[i + 2];
      // Each triangle turns the same way as the face (ear clipping may not keep it).
      const o = (j) => (v + j) * STRIDE;
      const ux = verts[o(b)] - verts[o(a)], uy = verts[o(b) + 1] - verts[o(a) + 1], uz = verts[o(b) + 2] - verts[o(a) + 2];
      const wx = verts[o(c)] - verts[o(a)], wy = verts[o(c) + 1] - verts[o(a) + 1], wz = verts[o(c) + 2] - verts[o(a) + 2];
      const tn = (uy * wz - uz * wy) * fx + (uz * wx - ux * wz) * fy + (ux * wy - uy * wx) * fz;
      if (tn < 0) [b, c] = [c, b];
      put(v + a, fx, fy, fz, flat);
      put(v + b, fx, fy, fz, flat);
      put(v + c, fx, fy, fz, flat);
    }
    v += k;
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos.subarray(0, t * 3), 3));
  g.setAttribute('normal', new BufferAttribute(nor.subarray(0, t * 3), 3));
  g.setAttribute('uv', new BufferAttribute(uv.subarray(0, t * 2), 2));
  g.computeBoundingSphere();
  return g;
}

class View {
  constructor(id, { emit, textures, carets }) {
    this.id = id;
    this.emit = emit;
    this.textures = textures;
    this.caretPixels = carets;
    this.root = document.createElement('div');
    Object.assign(this.root.style, { position: 'absolute', overflow: 'hidden', display: 'none', zIndex: '1', touchAction: 'none' });
    this.root.className = 'or3d';
    this.canvas = document.createElement('canvas');
    this.overlay = document.createElement('canvas');
    for (const c of [this.canvas, this.overlay]) {
      Object.assign(c.style, { position: 'absolute', left: '0', top: '0', width: '100%', height: '100%', display: 'block' });
    }
    this.overlay.style.pointerEvents = 'none';
    this.root.append(this.canvas, this.overlay);

    this.yaw = 0;
    this.roll = 0;
    this.zoom = 1;
    this.light = [1, 4, 1];
    this.w = 0;
    this.h = 0;
    this.generation = 0;
    this.bounds = null;
    this.meshes = [];
    this.materials = [];
    this.selection = new Set();
    this.cg = null;
    this.cp = null;
    this.showCarets = true;
    this.extras = null;
    this.texCache = new Map();

    try {
      this.renderer = new WebGLRenderer({ canvas: this.canvas, antialias: true });
    } catch {
      this.renderer = null;
      const msg = document.createElement('div');
      msg.textContent = 'The 3D view needs WebGL, which this browser has turned off.';
      Object.assign(msg.style, { position: 'absolute', inset: '0', display: 'grid', placeItems: 'center', font: '13px system-ui', color: '#555', background: '#fff' });
      this.root.append(msg);
      return;
    }
    this.renderer.outputColorSpace = LinearSRGBColorSpace;
    this.scene = new Scene();
    this.model = new Group();
    this.model.rotation.order = 'YXZ'; // yaw, then roll, as OpenRocket rotates
    this.inner = new Group();
    this.model.add(this.inner);
    this.scene.add(this.model);
    this.camera = new PerspectiveCamera(FOV_Y, 1, 0.01, 100);
    this.raycaster = new Raycaster();

    // Selection outline passes.
    this.maskScene = new Scene();
    this.maskModel = new Group();
    this.maskModel.rotation.order = 'YXZ';
    this.maskInner = new Group();
    this.maskModel.add(this.maskInner);
    this.maskScene.add(this.maskModel);
    this.maskMaterial = new MeshBasicMaterial({ color: 0xffffff, depthTest: false, depthWrite: false, side: DoubleSide });
    this.mask = new WebGLRenderTarget(1, 1);
    this.grown = new WebGLRenderTarget(1, 1);
    this.quadCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.dilate = new ShaderMaterial({ uniforms: { mask: { value: null }, step: { value: new Vector2() } }, vertexShader: quadVertex, fragmentShader: dilateFragment, depthTest: false, depthWrite: false });
    this.outline = new ShaderMaterial({ uniforms: { mask: { value: null }, grown: { value: null }, step: { value: new Vector2() } }, vertexShader: quadVertex, fragmentShader: outlineFragment, depthTest: false, depthWrite: false });
    this.quad = new Mesh(new PlaneGeometry(2, 2), this.dilate);
    this.quadScene = new Scene();
    this.quadScene.add(this.quad);

    this.listen();
  }

  // ---------------------------------------------------------------- from Java

  place({ wx, wy, ww, wh, x, y, w, h }) {
    clearTimeout(this.retry);
    if (w <= 0 || h <= 0) {
      this.root.style.display = 'none';
      this.visible = false;
      return;
    }
    const win = findWindow(wx, wy, ww, wh);
    if (!win) {
      // CheerpJ may not have shown the window yet.
      this.retry = setTimeout(() => this.place({ wx, wy, ww, wh, x, y, w, h }), 200);
      return;
    }
    if (this.root.parentElement !== win) win.append(this.root);
    Object.assign(this.root.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px`, display: 'block' });
    this.visible = true;
    this.resize(w, h);
    this.request();
  }

  setScene(scene, sizes, verts) {
    if (!this.renderer) return;
    for (const m of this.meshes) {
      m.geometry.dispose();
      this.inner.remove(m);
    }
    for (const m of this.maskInner.children.slice()) this.maskInner.remove(m);
    for (const m of this.materials) m.dispose();
    this.generation = scene.generation;
    this.bounds = scene.bounds;
    const { light, materials, parts } = scene.look;
    this.materials = materials.map((m) => this.material(m, light));
    // A see-through part is picked by its inside, so clicks reach what is inside it (as in OpenRocket).
    const seeThrough = new Set(parts.filter(([c, s, m]) => s === OUTSIDE && materials[m].transparent).map(([c]) => c));
    this.meshes = [];
    for (const [component, surface, mi, f0, fc, v0] of parts) {
      const mesh = new Mesh(buildGeometry(sizes, verts, f0, fc, v0), this.materials[mi]);
      mesh.userData = { component, pickable: component >= 0 && (!seeThrough.has(component) || surface === INSIDE) };
      mesh.renderOrder = materials[mi].transparent ? 1 : 0;
      this.meshes.push(mesh);
      this.inner.add(mesh);
      const shadow = new Mesh(mesh.geometry, this.maskMaterial);
      shadow.userData = { component };
      this.maskInner.add(shadow);
    }
    this.request();
  }

  setState(state) {
    this.selection = new Set(state.selection);
    this.cg = state.cg;
    this.cp = state.cp;
    this.showCarets = state.carets;
    this.background = state.background;
    const [red, green, blue] = state.background;
    this.renderer?.setClearColor(new Color(red / 255, green / 255, blue / 255));
    this.request();
  }

  setOverlay(w, h, px) {
    this.extras = argbCanvas(w, h, px);
    this.request();
  }

  // ---------------------------------------------------------------- drawing

  material(m, light) {
    const uniforms = {
      color: { value: new Vector4(...m.color) },
      spec: { value: new Vector3(...m.spec) },
      shininess: { value: m.shininess },
      light: { value: new Vector3(...light) },
      lightDir: { value: new Vector3(1, 4, 1).normalize() },
      map: { value: null },
      texMode: { value: 0 },
      uvMatrix: { value: new Matrix3() },
    };
    const mat = new ShaderMaterial({ uniforms, vertexShader, fragmentShader, transparent: !!m.transparent, side: FrontSide });
    if (m.texture) {
      const [a, b, c, d, e, f] = m.uv;
      uniforms.uvMatrix.value.set(a, b, c, d, e, f, 0, 0, 1);
      this.texture(m.texture, m.edge).then((tex) => {
        if (!tex) return;
        uniforms.map.value = tex;
        uniforms.texMode.value = m.edge === 'sticker' ? 2 : 1;
        this.request();
      });
    }
    return mat;
  }

  /** The decal image `id` as a texture with this edge mode, shared by the view's materials. */
  texture(id, edge) {
    const key = `${id}:${edge}`;
    if (!this.texCache.has(key)) {
      this.texCache.set(
        key,
        (this.textures.get(id) ?? Promise.resolve(null)).then((img) => {
          if (!img) return null;
          const t = new Texture(img);
          t.flipY = false; // flipped when decoded
          t.wrapS = t.wrapT = WRAP[edge] ?? ClampToEdgeWrapping;
          t.minFilter = LinearMipmapLinearFilter;
          t.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
          t.needsUpdate = true;
          return t;
        }),
      );
    }
    return this.texCache.get(key);
  }

  resize(w, h) {
    if (!this.renderer || (w === this.w && h === this.h)) return;
    this.w = w;
    this.h = h;
    const dpr = window.devicePixelRatio || 1;
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    this.mask.setSize(Math.round(w * dpr), Math.round(h * dpr));
    this.grown.setSize(Math.round(w * dpr), Math.round(h * dpr));
    this.overlay.width = w;
    this.overlay.height = h;
  }

  request() {
    if (this.frame || !this.visible || !this.renderer) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.render();
    });
  }

  /** OpenRocket's framing: the whole configuration plus 20%, at a 15° field of view. */
  frameCamera() {
    const [min, max] = this.bounds;
    const spanX = max[0] - min[0];
    const aspect = this.w / this.h;
    const tanY = Math.tan(((FOV_Y / 2) * Math.PI) / 180);
    const maxR = Math.max(Math.hypot(min[1], min[2]), Math.hypot(max[1], max[2]));
    const dX = (spanX * 1.2) / 2 / (tanY * aspect);
    const dY = (2 * maxR * 1.2) / 2 / tanY;
    const dist = Math.max(dX, dY, 1e-3) * this.zoom;
    this.camera.aspect = aspect;
    this.camera.near = dist / 100;
    this.camera.far = dist * 10;
    this.camera.position.set(0, 0, dist);
    this.camera.updateProjectionMatrix();
    for (const [model, inner] of [[this.model, this.inner], [this.maskModel, this.maskInner]]) {
      model.rotation.set(this.roll, this.yaw, 0);
      inner.position.x = -(min[0] + spanX / 2);
      model.updateMatrixWorld(true);
    }
  }

  render() {
    if (!this.bounds || !this.w || !this.h) return;
    this.frameCamera();
    const dir = new Vector3(...this.light).normalize();
    for (const m of this.materials) m.uniforms.lightDir.value.copy(dir);
    const r = this.renderer;
    r.setRenderTarget(null);
    r.render(this.scene, this.camera);
    if (this.selection.size) this.renderOutline();
    this.drawOverlay();
  }

  renderOutline() {
    const r = this.renderer;
    for (const m of this.maskInner.children) m.visible = this.selection.has(m.userData.component);
    const alpha = r.getClearAlpha();
    const bg = r.getClearColor((this.savedClear ??= new Color()));
    r.setClearColor(0x000000, 1);
    r.setRenderTarget(this.mask);
    r.clear();
    r.render(this.maskScene, this.camera);
    const dpr = r.getPixelRatio();
    const px = Math.min(8, Math.round(OUTLINE_PX * dpr));
    const sx = 1 / this.mask.width, sy = 1 / this.mask.height;
    const scale = px / 8;
    this.quad.material = this.dilate;
    this.dilate.uniforms.mask.value = this.mask.texture;
    this.dilate.uniforms.step.value.set(sx * scale, 0);
    r.setRenderTarget(this.grown);
    r.render(this.quadScene, this.quadCamera);
    this.quad.material = this.outline;
    this.outline.uniforms.mask.value = this.mask.texture;
    this.outline.uniforms.grown.value = this.grown.texture;
    this.outline.uniforms.step.value.set(0, sy * scale);
    r.setRenderTarget(null);
    r.setClearColor(bg, alpha);
    const auto = r.autoClear;
    r.autoClear = false;
    r.render(this.quadScene, this.quadCamera);
    r.autoClear = auto;
  }

  /** Where a point in OpenRocket coordinates lands on the canvas, with its depth. */
  project(c) {
    const v = this.inner.localToWorld(new Vector3(c[0], c[1], -c[2])).project(this.camera);
    return { x: ((v.x + 1) / 2) * this.w, y: ((1 - v.y) / 2) * this.h, z: v.z };
  }

  drawOverlay() {
    const g = this.overlay.getContext('2d');
    g.clearRect(0, 0, this.w, this.h);
    if (this.extras) g.drawImage(this.extras, 0, 0);
    const px = this.caretPixels();
    if (!this.showCarets || !px) return;
    this.caretImages ??= { cg: argbCanvas(px.size, px.size, px.cg), cp: argbCanvas(px.size, px.size, px.cp), size: px.size };
    const { cg, cp, size } = this.caretImages;
    const marks = [];
    if (this.cg) marks.push([cg, this.project(this.cg)]);
    if (this.cp) marks.push([cp, this.project(this.cp)]);
    // The nearer mark on top.
    marks.sort((a, b) => b[1].z - a[1].z);
    for (const [img, p] of marks) g.drawImage(img, Math.round(p.x - size / 2), Math.round(p.y - size / 2));
  }

  // ---------------------------------------------------------------- mouse

  listen() {
    const c = this.canvas;
    let drag = null;
    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      drag = { x: e.offsetX, y: e.offsetY, x0: e.offsetX, y0: e.offsetY, button: e.button, moved: false };
    });
    c.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = drag.x - e.offsetX;
      let dy = drag.y - e.offsetY;
      drag.x = e.offsetX;
      drag.y = e.offsetY;
      if (!drag.moved && Math.hypot(e.offsetX - drag.x0, e.offsetY - drag.y0) < 3) return;
      drag.moved = true;
      if (drag.button === 0) {
        // RocketFigure3d: sideways turns (yaw), up and down rolls.
        if (Math.abs(dx) > Math.abs(dy)) {
          this.yaw = reduce(this.yaw - dx / 100);
        } else {
          if (this.yaw > Math.PI / 2 && this.yaw < (3 * Math.PI) / 2) dy = -dy;
          this.roll = reduce(this.roll - dy / 100);
        }
      } else {
        this.light[0] -= 0.1 * dx;
        this.light[1] += 0.1 * dy;
      }
      this.request();
    });
    const end = (e) => {
      if (!drag) return;
      const d = drag;
      drag = null;
      if (!d.moved && e.type === 'pointerup') this.click(d.x0, d.y0, d.button, e);
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.zoom = Math.min(20, Math.max(0.05, this.zoom * Math.exp(e.deltaY * 0.0015)));
        this.request();
      },
      { passive: false },
    );
  }

  click(x, y, button, e) {
    let part = -1;
    if (this.bounds) {
      this.frameCamera();
      this.raycaster.setFromCamera(new Vector2((x / this.w) * 2 - 1, -(y / this.h) * 2 + 1), this.camera);
      // Shift-click reaches past the parts already selected (OpenRocket's pick ignores them).
      const candidates = this.meshes.filter((m) => m.userData.pickable && !(e.shiftKey && this.selection.has(m.userData.component)));
      const hit = this.raycaster.intersectObjects(candidates, false)[0];
      if (hit) part = hit.object.userData.component;
    }
    const keys = (e.shiftKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.altKey ? 4 : 0) | (e.metaKey ? 8 : 0);
    this.emit(`click ${this.id} ${this.generation} ${part} ${Math.round(x)} ${Math.round(y)} ${button + 1} ${keys}`);
  }
}

function reduce(a) {
  const t = 2 * Math.PI;
  return ((a % t) + t) % t;
}
