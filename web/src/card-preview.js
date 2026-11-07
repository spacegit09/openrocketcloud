// The drawing on a design's card: OpenRocket's side view of the rocket, as its design window draws
// it (see server/src/preview.js), in the card's colour unless a part has its own in OpenRocket.
import { cleanPreview } from './lib/preview.js';

const NS = 'http://www.w3.org/2000/svg';
const DASHES = { dashed: '5 3', dotted: '1.5 2.5', dashdot: '6 2.5 1.5 2.5' };

// Colours chosen in OpenRocket that would vanish on a dark card are drawn in the card's colour.
function tooDark(hex) {
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255) < 70;
}

/** An <svg> of the preview stored on a design record, or null if there is none or it is not valid. */
export function previewSvg(text) {
  const p = cleanPreview(text);
  if (!p?.s.length) return null;
  const [x, y, w, h] = p.box;
  const pad = Math.max(w, h) * 0.01;
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `${x - pad} ${y - pad} ${w + 2 * pad} ${h + 2 * pad}`);
  svg.setAttribute('class', 'preview');
  svg.setAttribute('aria-hidden', 'true');
  for (const s of p.s) {
    const path = document.createElementNS(NS, 'path');
    const color = s.c && !tooDark(s.c) ? s.c : 'currentColor';
    path.setAttribute('d', s.d);
    path.setAttribute('stroke', color);
    path.setAttribute('fill', s.m ? color : 'none');
    if (s.m) path.setAttribute('fill-opacity', '0.2');
    if (s.k) path.setAttribute('stroke-dasharray', DASHES[s.k]);
    path.setAttribute('vector-effect', 'non-scaling-stroke');
    svg.append(path);
  }
  return svg;
}
