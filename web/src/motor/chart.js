// The motor designer's graphs, drawn as SVG the way the logbook draws its own (logbook/chart.js):
// SRM's charts (Kn against web regression, chamber pressure and thrust against time), with a
// readout of the values under the pointer.
import { formatNumber, ticks } from '../logbook/data.js';

const NS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs = {}) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
};

/** The point of `points` (sorted by x) nearest to x. */
function nearest(points, x) {
  let lo = 0;
  let hi = points.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid][0] < x) lo = mid;
    else hi = mid;
  }
  return Math.abs(points[lo][0] - x) <= Math.abs(points[hi][0] - x) ? points[lo] : points[hi];
}

/**
 * A graph: { title, x: { title, unit }, y: { title, unit }, series: [{ label, color, points, markers }] },
 * points [[x, y], ...] sorted by x.
 */
export function xyChart(spec, { width = 640, height = 300, yFrom0 = true } = {}) {
  const series = spec.series.filter((s) => s.points.length);
  const box = document.createElement('figure');
  box.className = 'mt-chart';
  const all = series.flatMap((s) => s.points);
  const xs = all.map((p) => p[0]);
  const ys = all.map((p) => p[1]);
  const X = ticks(Math.min(...xs), Math.max(...xs), 7);
  const Y = ticks(yFrom0 ? Math.min(0, ...ys) : Math.min(...ys), Math.max(...ys), 6);
  const m = { l: 64, r: 16, t: spec.title ? 30 : 12, b: 42 };
  const w = width - m.l - m.r;
  const h = height - m.t - m.b;
  const sx = (v) => m.l + ((v - X.lo) / (X.hi - X.lo)) * w;
  const sy = (v) => m.t + h - ((v - Y.lo) / (Y.hi - Y.lo)) * h;
  const label = (a) => (a.unit ? `${a.title} (${a.unit})` : a.title);

  const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': `${spec.title ?? label(spec.y)}` });
  if (spec.title) {
    const t = svgEl('text', { x: m.l + w / 2, y: 18, 'text-anchor': 'middle', class: 'chart-title' });
    t.textContent = spec.title;
    svg.append(t);
  }
  const grid = svgEl('g', { class: 'grid' });
  for (const v of Y.values) {
    grid.append(svgEl('line', { x1: m.l, x2: m.l + w, y1: sy(v), y2: sy(v) }));
    const t = svgEl('text', { x: m.l - 6, y: sy(v) + 4, 'text-anchor': 'end' });
    t.textContent = formatNumber(v, Y.step);
    grid.append(t);
  }
  for (const v of X.values) {
    grid.append(svgEl('line', { x1: sx(v), x2: sx(v), y1: m.t, y2: m.t + h, class: 'v' }));
    const t = svgEl('text', { x: sx(v), y: m.t + h + 16, 'text-anchor': 'middle' });
    t.textContent = formatNumber(v, X.step);
    grid.append(t);
  }
  grid.append(svgEl('rect', { x: m.l, y: m.t, width: w, height: h, class: 'frame' }));
  svg.append(grid);
  const xTitle = svgEl('text', { x: m.l + w / 2, y: height - 6, 'text-anchor': 'middle', class: 'axis-title' });
  xTitle.textContent = label(spec.x);
  const yTitle = svgEl('text', { x: 0, y: 0, transform: `translate(15 ${m.t + h / 2}) rotate(-90)`, 'text-anchor': 'middle', class: 'axis-title' });
  yTitle.textContent = label(spec.y);
  svg.append(xTitle, yTitle);

  for (const s of series) {
    const d = s.points.map((p, i) => `${i ? 'L' : 'M'}${sx(p[0]).toFixed(1)} ${sy(p[1]).toFixed(1)}`).join('');
    svg.append(svgEl('path', { d, stroke: s.color, fill: 'none', 'stroke-width': 1.8, 'stroke-linejoin': 'round' }));
    if (s.markers) {
      for (const p of s.points) svg.append(svgEl('rect', { x: sx(p[0]) - 2.5, y: sy(p[1]) - 2.5, width: 5, height: 5, fill: s.color }));
    }
  }

  const frame = document.createElement('div');
  frame.className = 'mt-chart-frame';
  frame.append(svg);
  box.append(frame);
  if (series.length > 1) {
    const legend = document.createElement('figcaption');
    for (const s of series) {
      const item = document.createElement('span');
      const swatch = document.createElement('i');
      swatch.style.background = s.color;
      item.append(swatch, s.label);
      legend.append(item);
    }
    box.append(legend);
  }
  if (!series.length) return box;

  const cursor = svgEl('line', { y1: m.t, y2: m.t + h, class: 'cursor', visibility: 'hidden' });
  const dots = series.map((s) => svgEl('circle', { r: 3.5, fill: s.color, visibility: 'hidden' }));
  svg.append(cursor, ...dots);
  const readout = document.createElement('div');
  readout.className = 'mt-readout';
  readout.hidden = true;
  frame.append(readout);
  const hide = () => {
    readout.hidden = true;
    cursor.setAttribute('visibility', 'hidden');
    dots.forEach((d) => d.setAttribute('visibility', 'hidden'));
  };
  svg.addEventListener('pointerleave', hide);
  svg.addEventListener('pointermove', (e) => {
    const r = svg.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * width;
    if (x < m.l || x > m.l + w) return hide();
    const at = X.lo + ((x - m.l) / w) * (X.hi - X.lo);
    cursor.setAttribute('x1', x);
    cursor.setAttribute('x2', x);
    cursor.setAttribute('visibility', 'visible');
    const rows = [];
    series.forEach((s, i) => {
      const p = nearest(s.points, at);
      dots[i].setAttribute('cx', sx(p[0]));
      dots[i].setAttribute('cy', sy(p[1]));
      dots[i].setAttribute('visibility', 'visible');
      if (i === 0) rows.push(`<b>${spec.x.title} ${formatNumber(p[0], X.step / 100)}${spec.x.unit ? ` ${spec.x.unit}` : ''}</b>`);
      rows.push(`<span><i style="background:${s.color}"></i>${s.label}: ${formatNumber(p[1], Y.step / 100)}${spec.y.unit ? ` ${spec.y.unit}` : ''}</span>`);
    });
    readout.innerHTML = rows.join('');
    readout.hidden = false;
    const left = (x / width) * r.width;
    readout.style.left = `${left > r.width / 2 ? left - readout.offsetWidth - 12 : left + 12}px`;
  });
  return box;
}

/** A small thrust curve for a motor's card. */
export function curveSvg(points) {
  const svg = svgEl('svg', { viewBox: '0 0 300 120', preserveAspectRatio: 'none', class: 'mt-spark', 'aria-hidden': 'true' });
  if (!points?.length) return svg;
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const [x0, x1, y1] = [Math.min(...xs), Math.max(...xs), Math.max(...ys)];
  const sx = (x) => 14 + ((x - x0) / (x1 - x0 || 1)) * 272;
  const sy = (y) => 104 - (y / (y1 || 1)) * 84;
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${sx(p[0]).toFixed(1)} ${sy(p[1]).toFixed(1)}`).join('');
  svg.append(svgEl('path', { d: `${d}L${sx(x1)} 104L${sx(x0)} 104Z`, class: 'fill' }), svgEl('path', { d, class: 'line' }),
    svgEl('line', { x1: 14, x2: 286, y1: 104, y2: 104, class: 'base' }));
  return svg;
}
