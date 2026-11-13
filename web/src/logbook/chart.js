// A logbook graph: every series of one quantity (data.js graphGroups) on a time axis, as SVG,
// with a legend and, on screen, a readout of each series at the time under the pointer. The same
// drawing goes into the printed (PDF) logbook.
import { formatNumber, thin, ticks } from './data.js';

const NS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs = {}) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
};

/** The point of `points` (sorted by time) nearest to time `t`. */
function nearest(points, t) {
  let lo = 0;
  let hi = points.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid][0] < t) lo = mid;
    else hi = mid;
  }
  return Math.abs(points[lo][0] - t) <= Math.abs(points[hi][0] - t) ? points[lo] : points[hi];
}

/**
 * The graph of `group` ({ title, unit, series: [{ label, color, points }] }) as an element:
 * { width, height } in SVG units (it scales to its box), interactive for the hover readout.
 */
export function lineChart(group, { width = 760, height = 270, interactive = true } = {}) {
  const series = group.series.filter((s) => s.points.length);
  const box = document.createElement('figure');
  box.className = 'lb-chart';
  const yLabel = group.unit ? `${group.title} (${group.unit})` : group.title;
  const all = series.flatMap((s) => s.points);
  const xs = all.map((p) => p[0]);
  const ys = all.map((p) => p[1]);
  const X = ticks(Math.min(...xs), Math.max(...xs), 8);
  const Y = ticks(Math.min(...ys), Math.max(...ys), 5);
  const m = { l: 62, r: 14, t: 12, b: 38 };
  const w = width - m.l - m.r;
  const h = height - m.t - m.b;
  const sx = (t) => m.l + ((t - X.lo) / (X.hi - X.lo)) * w;
  const sy = (v) => m.t + h - ((v - Y.lo) / (Y.hi - Y.lo)) * h;

  const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': `${yLabel} over time` });
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
  svg.append(grid);
  if (Y.lo < 0 && Y.hi > 0) svg.append(svgEl('line', { x1: m.l, x2: m.l + w, y1: sy(0), y2: sy(0), class: 'zero' }));
  const xTitle = svgEl('text', { x: m.l + w / 2, y: height - 4, 'text-anchor': 'middle', class: 'axis-title' });
  xTitle.textContent = 'Time (s)';
  const yTitle = svgEl('text', { x: 0, y: 0, transform: `translate(14 ${m.t + h / 2}) rotate(-90)`, 'text-anchor': 'middle', class: 'axis-title' });
  yTitle.textContent = yLabel;
  svg.append(xTitle, yTitle);

  const lines = svgEl('g', { class: 'lines' });
  for (const s of series) {
    const pts = thin(s.points, 2400);
    const d = pts.map((p, i) => `${i ? 'L' : 'M'}${sx(p[0]).toFixed(1)} ${sy(p[1]).toFixed(1)}`).join('');
    lines.append(svgEl('path', { d, stroke: s.color, fill: 'none', 'stroke-width': 1.8, 'stroke-linejoin': 'round' }));
  }
  svg.append(lines);

  const legend = document.createElement('figcaption');
  for (const s of series) {
    const item = document.createElement('span');
    const swatch = document.createElement('i');
    swatch.style.background = s.color;
    item.append(swatch, s.label);
    legend.append(item);
  }

  const frame = document.createElement('div');
  frame.className = 'lb-chart-frame';
  frame.append(svg);
  box.append(frame, legend);
  if (!interactive || !series.length) return box;

  // The readout: each series' value at the time under the pointer.
  const cursor = svgEl('line', { y1: m.t, y2: m.t + h, class: 'cursor', visibility: 'hidden' });
  const dots = series.map((s) => svgEl('circle', { r: 3.5, fill: s.color, visibility: 'hidden' }));
  svg.append(cursor, ...dots);
  const readout = document.createElement('div');
  readout.className = 'lb-readout';
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
    const t = X.lo + ((x - m.l) / w) * (X.hi - X.lo);
    cursor.setAttribute('x1', x);
    cursor.setAttribute('x2', x);
    cursor.setAttribute('visibility', 'visible');
    const rows = [`<b>t = ${formatNumber(t, X.step / 10)} s</b>`];
    series.forEach((s, i) => {
      const p = nearest(s.points, t);
      dots[i].setAttribute('cx', sx(p[0]));
      dots[i].setAttribute('cy', sy(p[1]));
      dots[i].setAttribute('visibility', 'visible');
      const label = s.label.replace(/[&<]/g, (c) => (c === '&' ? '&amp;' : '&lt;'));
      rows.push(`<span><i style="background:${s.color}"></i>${label}: ${formatNumber(p[1])}${group.unit ? ` ${group.unit}` : ''}</span>`);
    });
    readout.innerHTML = rows.join('');
    readout.hidden = false;
    const left = (x / width) * r.width;
    readout.style.left = `${left > r.width / 2 ? left - readout.offsetWidth - 12 : left + 12}px`;
  });
  return box;
}

/** A small curve for a logbook's card (data.js sparkline points). */
export function sparkSvg(points) {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const sx = (x) => 8 + ((x - x0) / (x1 - x0 || 1)) * 284;
  const sy = (y) => 72 - ((y - y0) / (y1 - y0 || 1)) * 64;
  const svg = svgEl('svg', { viewBox: '0 0 300 80', class: 'lb-spark', 'aria-hidden': 'true' });
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${sx(p[0]).toFixed(1)} ${sy(p[1]).toFixed(1)}`).join('');
  svg.append(svgEl('path', { d: `${d}L${sx(x1)} 76L${sx(x0)} 76Z`, class: 'fill' }), svgEl('path', { d, class: 'line' }));
  return svg;
}
