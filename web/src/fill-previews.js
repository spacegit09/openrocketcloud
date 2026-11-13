// Drawings for the designs that have none yet (not opened since previews began, or last opened
// with an older version of the site): OpenRocket runs hidden in the dashboard and draws them one
// by one (src/flight/openrocket.js), and each design keeps its drawing (through the designs
// function). A design that could not be drawn is left until it changes.
import { api } from './base44.js';
import { testHub, withRoom } from './room-client.js';

const KEY = 'orc-preview-failed'; // design id -> its updated_date when drawing it failed
let running = false;

function failures() {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') ?? {};
  } catch {
    return {};
  }
}

function remember(d) {
  try {
    const f = failures();
    f[d.id] = d.updated_date ?? '';
    localStorage.setItem(KEY, JSON.stringify(f));
  } catch {
    // private window: tried again next time
  }
}

/** Draws the previews `designs` lack, in the background; drawn(design, json) as each is kept. */
export async function fillPreviews(designs, drawn) {
  if (running) return;
  const failed = failures();
  const missing = designs.filter((d) => d.preview == null && failed[d.id] !== (d.updated_date ?? ''));
  if (!missing.length) return;
  running = true;
  try {
    const { fetchDesign, drawInOpenRocket } = await import('./flight/openrocket.js');
    // Every design's content and custom motors first: OpenRocket reads the motors once, as it starts.
    const fetched = [];
    for (const d of missing) {
      try {
        fetched.push([d, await fetchDesign(d.id)]);
      } catch {
        remember(d); // no content yet, or no longer shared
      }
    }
    const motors = fetched.flatMap(([, f]) => f.motors);
    for (const [d, f] of fetched) {
      try {
        const json = await drawInOpenRocket({ model: f.model, motors });
        const { kept } = testHub()
          ? await withRoom(d.id, (room) => room.request('preview', { preview: json }, 30_000))
          : await api('designs', { action: 'preview', id: d.id, preview: json });
        if (kept) drawn(d, json);
        else remember(d);
      } catch (e) {
        console.warn(`Could not draw ${d.name}:`, e.message);
        remember(d);
      }
    }
  } finally {
    running = false;
  }
}
