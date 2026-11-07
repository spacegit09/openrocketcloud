// A design's preview: OpenRocket's own side view of the rocket (orcloud.web.Preview in
// worker/bridge/web), as drawn in its design window, for the design's card on the dashboard.
// OpenRocket in the page sends it to the design's room, which keeps it on the design's record.
//
// The preview is JSON text, in millimetres with y downwards: { v: 1, box: [x, y, width, height],
// s: [shape...] }, or { v: 1, s: [] } when there is nothing to draw. A shape is { d: SVG path data
// (M, L, Q, C and Z with absolute coordinates), k: 'dashed' | 'dotted' | 'dashdot' (the line
// style; solid when left out), c: '#rrggbb' (a colour chosen in OpenRocket; the page's own when
// left out), m: 1 (a motor, drawn filled) }.
//
// cleanPreview checks one strictly and returns it rebuilt from what passes, so nothing else in
// the text is ever stored or drawn.

export const MAX_PREVIEW = 200_000; // characters
const MAX_SHAPES = 3000;
const MAX_PATH = 60_000;
const PATH = /^[MLQCZ0-9 .-]*$/;
const COLOR = /^#[0-9a-f]{6}$/i;
const STYLES = new Set(['dashed', 'dotted', 'dashdot']);

/** The preview in `text`, checked and rebuilt ({ v, box, s }; s is empty for an empty rocket), or null. */
export function cleanPreview(text) {
  if (typeof text !== 'string' || text.length > MAX_PREVIEW) return null;
  let p;
  try {
    p = JSON.parse(text);
  } catch {
    return null;
  }
  if (!p || p.v !== 1 || !Array.isArray(p.s)) return null;
  if (!p.s.length) return { v: 1, box: null, s: [] };
  if (!Array.isArray(p.box) || p.box.length !== 4) return null;
  const box = p.box.map(Number);
  if (!box.every(Number.isFinite) || box[2] <= 0 || box[3] <= 0) return null;
  const s = [];
  for (const shape of p.s.slice(0, MAX_SHAPES)) {
    if (!shape || typeof shape.d !== 'string' || !shape.d || shape.d.length > MAX_PATH || !PATH.test(shape.d)) continue;
    const out = { d: shape.d };
    if (STYLES.has(shape.k)) out.k = shape.k;
    if (typeof shape.c === 'string' && COLOR.test(shape.c)) out.c = shape.c.toLowerCase();
    if (shape.m === 1) out.m = 1;
    s.push(out);
  }
  return s.length ? { v: 1, box, s } : null;
}
