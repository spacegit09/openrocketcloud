// .ork files in and out, in the browser (same rules as server/src/orkfile.js). OpenRocket writes a
// zip (rocket.ork first, then decal images); older versions wrote gzip or plain XML.
import { fromXml, toXml, attachments } from '../../../server/src/model.js';
import { parse } from '../../../server/src/xml.js';
import { createZip, gunzip, readZip } from './zip.js';

const MAX_EXPANDED = 300 * 1024 * 1024;
const dec = new TextDecoder();

export class ImportError extends Error {}

/** Bytes of an .ork (or older .ork/.xml) file -> design model. */
export async function importOrk(bytes) {
  let xml;
  const atts = new Map();
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b) {
    let entries;
    try {
      entries = await readZip(bytes, { maxTotal: MAX_EXPANDED });
    } catch (e) {
      throw new ImportError(`The file is not a valid .ork archive (${e.message}).`);
    }
    const main = entries.find((e) => /\.(ork|rkt)$/i.test(e.name));
    if (!main) throw new ImportError('No rocket design found inside the archive.');
    xml = dec.decode(main.data);
    for (const e of entries) if (e !== main) atts.set(e.name, e.data);
  } else if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    xml = dec.decode(await gunzip(bytes));
  } else {
    xml = dec.decode(bytes);
  }
  let root;
  try {
    root = parse(xml);
  } catch (e) {
    throw new ImportError(`This is not an OpenRocket design (${e.message}).`);
  }
  if (root.tag === 'RockSimDocument') {
    throw new ImportError('RockSim files are not supported here. Open it in OpenRocket, save it as .ork, then upload that.');
  }
  if (root.tag !== 'openrocket') throw new ImportError('This is not an OpenRocket design.');
  try {
    return fromXml(root, atts);
  } catch (e) {
    throw new ImportError(e.message);
  }
}

/** Design model -> .ork file bytes (a zip when the design has decal images, as OpenRocket does). */
export async function exportOrk(model) {
  const xml = new TextEncoder().encode(toXml(model));
  const atts = attachments(model);
  if (!atts.size) return xml;
  return createZip([['rocket.ork', xml], ...atts]);
}

export function saveFile(bytes, filename) {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export const fileName = (name) => `${(name || 'Rocket').replace(/[\\/:*?"<>|]+/g, '_').trim() || 'Rocket'}.ork`;
