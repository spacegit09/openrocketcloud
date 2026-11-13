// A saved launch plan's picture for its card on the planner's home: the plan seen from above,
// north up: the pad, the nominal flight's track over the ground (to its landing, ringed) and where
// its flights landed, with a scale bar. In the theme's colours (currentColor is the card's accent).

const SVG = 'http://www.w3.org/2000/svg';
const W = 300;
const H = 92;
const PAD = 10;
/** At most this many landings drawn (a study has up to 2000; the picture is small). */
const MAX_DOTS = 400;

function el(tag, attrs, ...children) {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  e.append(...children);
  return e;
}

/** A length near `m` metres that reads well on a scale bar (1, 2 or 5 times a power of ten). */
function roundLength(m) {
  const p = 10 ** Math.floor(Math.log10(m));
  return [5, 2, 1].map((k) => k * p).find((v) => v <= m) ?? p;
}

/** The picture of `study` (as unpackStudy gives it), or null without landings to show. */
export function planPreview(study) {
  const landings = (study.results ?? []).filter((r) => r && Number.isFinite(r.landingEast) && Number.isFinite(r.landingNorth));
  const track = (study.nominal?.path ?? []).map(([, e, n]) => [e, n]).filter(([e, n]) => Number.isFinite(e) && Number.isFinite(n));
  if (!landings.length && track.length < 2) return null;

  // What the picture spans: the pad, the track, and the landings but a few strays (the farthest 2 %
  // fall outside it rather than shrink the rest to a dot).
  const points = landings.map((r) => [r.landingEast, r.landingNorth]);
  const far = points.map(([e, n]) => Math.hypot(e, n)).sort((a, b) => a - b);
  const reach = far.length ? far[Math.min(far.length - 1, Math.floor(far.length * 0.98))] : Infinity;
  const kept = points.filter(([e, n]) => Math.hypot(e, n) <= reach + 1e-9);
  const all = [[0, 0], ...track, ...kept];
  let minE = Math.min(...all.map((p) => p[0]));
  let maxE = Math.max(...all.map((p) => p[0]));
  let minN = Math.min(...all.map((p) => p[1]));
  let maxN = Math.max(...all.map((p) => p[1]));
  // At least 50 m across, so a near-vertical flight is not blown up to fill the card.
  const span = Math.max(maxE - minE, (maxN - minN) * ((W - 2 * PAD) / (H - 2 * PAD)), 50);
  const scale = (W - 2 * PAD) / span; // pixels per metre, the same both ways
  const cx = (minE + maxE) / 2;
  const cy = (minN + maxN) / 2;
  const x = (e) => W / 2 + (e - cx) * scale;
  const y = (n) => H / 2 - (n - cy) * scale;

  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'plan-preview', role: 'img', 'aria-label': 'Where its flights landed' });
  const step = Math.max(1, Math.ceil(points.length / MAX_DOTS));
  const dots = el('g', { fill: 'currentColor', 'fill-opacity': '0.35' });
  for (let i = 0; i < points.length; i += step) {
    dots.append(el('circle', { cx: x(points[i][0]).toFixed(1), cy: y(points[i][1]).toFixed(1), r: '1.6' }));
  }
  svg.append(dots);
  if (track.length >= 2) {
    svg.append(el('polyline', {
      points: track.map(([e, n]) => `${x(e).toFixed(1)},${y(n).toFixed(1)}`).join(' '),
      fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linejoin': 'round', 'stroke-linecap': 'round',
    }));
    const [le, ln] = track[track.length - 1];
    svg.append(el('circle', { cx: x(le).toFixed(1), cy: y(ln).toFixed(1), r: '3.2', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.4' }));
  }
  // The pad: a filled dot in a ring, labelled.
  svg.append(el('circle', { cx: x(0).toFixed(1), cy: y(0).toFixed(1), r: '4', fill: 'var(--surface)', stroke: 'var(--text)', 'stroke-width': '1.4' }),
    el('circle', { cx: x(0).toFixed(1), cy: y(0).toFixed(1), r: '1.6', fill: 'var(--text)' }),
    el('text', { x: (x(0) + 7).toFixed(1), y: (y(0) + 3).toFixed(1), 'font-size': '9', fill: 'var(--muted)', 'font-family': 'system-ui, sans-serif' }, 'pad'));
  // Scale bar, bottom right.
  const metres = roundLength(span / 4);
  const len = metres * scale;
  const label = metres >= 1000 ? `${metres / 1000} km` : `${metres} m`;
  svg.append(el('g', { stroke: 'var(--muted)', 'stroke-width': '1.2', fill: 'none' },
    el('path', { d: `M${W - 8 - len} ${H - 8} v-3 M${W - 8 - len} ${H - 8} H${W - 8} v-3` })),
  el('text', { x: W - 8 - len / 2, y: H - 12, 'text-anchor': 'middle', 'font-size': '9', fill: 'var(--muted)', 'font-family': 'system-ui, sans-serif' }, label),
  el('text', { x: 8, y: 14, 'font-size': '9', fill: 'var(--muted)', 'font-family': 'system-ui, sans-serif' }, 'N ↑'));
  return svg;
}
