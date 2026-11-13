// The launch planner's OpenRocket: the official OpenRocket core in this page through CheerpJ,
// without its windows (orcloud.bridge.FlightMain and FlightLab in worker/bridge/web), run as a
// program the way the design page runs OpenRocket. It reads a design and computes the flight
// tables the engine (engine.js) flies with. The dashboard uses it to draw designs' previews.
import { prepareJava } from '../java.js';
import { api } from '../base44.js';
import { testHub, withRoom } from '../room-client.js';
import { exportOrk } from '../lib/ork.js';
import { fromJson } from '../../../server/src/model.js';
import { labRequest } from './lab-natives.js';
import { CLASSPATH } from '../lib/jars.js';
let running = null;
let files = 0;

/**
 * The design's content, from its room, and the custom motors of everyone it is shared with, from
 * the designs function (they are sealed, so the room cannot read them; the local test hub sends
 * its own).
 */
export async function fetchDesign(designId) {
  const motors = testHub() ? Promise.resolve(null) : api('designs', { action: 'motors', id: designId }).catch(() => null);
  const design = await withRoom(designId, (room) => new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('The design did not answer. Try again.')), 60_000);
    room.on('welcome', (m) => {
      clearTimeout(t);
      resolve({ model: m.model, motors: m.motors ?? [], name: m.name });
    });
    room.on('error', (m) => {
      clearTimeout(t);
      reject(new Error(m.message));
    });
    room.send({ type: 'hello' });
  }));
  const kept = await motors;
  return kept?.length ? { ...design, motors: kept } : design;
}

/** Starts OpenRocket once; it then serves requests until the page closes. */
async function startOpenRocket(designId) {
  running ??= (async () => {
    await prepareJava(`planner-${designId}`);
    // CheerpJ needs a display even when Java shows nothing: OpenRocket's core still uses Java's
    // graphics classes (colours, fonts), and without one the runtime fails at random.
    const display = document.createElement('div');
    display.style.cssText = 'position:fixed;left:-10px;top:-10px;width:1px;height:1px;overflow:hidden';
    document.body.append(display);
    window.cheerpjCreateDisplay(1, 1, display);
    window.cheerpjRunMain('orcloud.bridge.FlightMain', CLASSPATH); // runs until the page closes
  })();
  return running;
}

async function ask(msg) {
  const reply = JSON.parse(await labRequest(msg));
  if (reply?.error) throw new Error(reply.error);
  return reply;
}

/** Writes the design (.ork) and the custom motor files for OpenRocket: { path, motors }. */
async function writeDesign(model, motors) {
  const path = `/str/planner-${++files}.ork`;
  window.cheerpOSAddStringFile(path, await exportOrk(fromJson(model)));
  const names = new Set();
  for (const m of motors) {
    const name = String(m.name).replace(/[^A-Za-z0-9._-]/g, '_');
    if (!/\.(eng|rse)$/i.test(name) || typeof m.content !== 'string') continue;
    // CheerpJ's /str/ files cannot be in folders.
    window.cheerpOSAddStringFile(`/str/planner-motor-${name}`, new TextEncoder().encode(m.content));
    names.add(name);
  }
  return { path, motors: [...names].join('|') };
}

/**
 * OpenRocket's drawing of a design for its card (server/src/preview.js), as JSON text. Custom
 * motors are read once, with the first design drawn in the page.
 */
export async function drawInOpenRocket({ model, motors }) {
  await startOpenRocket('dashboard');
  const text = await labRequest({ op: 'preview', ...(await writeDesign(model, motors)) });
  const reply = JSON.parse(text);
  if (reply?.error) throw new Error(reply.error);
  return text;
}

/**
 * Opens a design in OpenRocket: { simulations: [{ name, configuration }], tables(index) } where
 * tables() resolves to the flight tables of that simulation. Custom motors are read once, with
 * the first design opened in the page.
 */
export async function openInOpenRocket(designId, { model, motors }) {
  await startOpenRocket(designId);
  const { path, motors: names } = await writeDesign(model, motors);
  let simulations;
  try {
    simulations = await ask({ op: 'simulations', path, motors: names });
  } catch (e) {
    throw new Error(`OpenRocket could not read the design: ${e.message}`);
  }
  return {
    simulations,
    async tables(index) {
      try {
        return await ask({ op: 'tables', path, index });
      } catch (e) {
        throw new Error(`OpenRocket could not prepare the flight: ${e.message}`);
      }
    },
  };
}
