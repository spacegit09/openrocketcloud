// .ork files in and out (platform-neutral: used by the Node server and the Cloudflare worker).
// OpenRocket writes a zip (rocket.ork first, then decal images); older versions wrote gzip or
// plain XML. All three are accepted, the way OpenRocket's own loader does.
import { gunzipSync } from 'node:zlib';
import { fromXml, toXml, attachments, toJson } from './model.js';
import { parse } from './xml.js';
import { createZip, readZip } from './zip.js';

const MAX_EXPANDED = 300 * 1024 * 1024;

export class ImportError extends Error {}

export function importOrk(buf) {
  let xml;
  const atts = new Map();
  if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b) {
    let entries;
    try {
      entries = readZip(buf, { maxTotal: MAX_EXPANDED });
    } catch (e) {
      throw new ImportError(`The file is not a valid .ork archive (${e.message}).`);
    }
    const main = entries.find((e) => /\.(ork|rkt)$/i.test(e.name));
    if (!main) throw new ImportError('No rocket design found inside the archive.');
    xml = main.data.toString('utf8');
    for (const e of entries) if (e !== main) atts.set(e.name, e.data);
  } else if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    xml = gunzipSync(buf, { maxOutputLength: MAX_EXPANDED }).toString('utf8');
  } else {
    xml = buf.toString('utf8');
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

export function exportOrk(model) {
  const xml = toXml(model);
  const atts = attachments(model);
  if (!atts.size) return { body: Buffer.from(xml, 'utf8'), zip: false };
  return { body: createZip([['rocket.ork', Buffer.from(xml, 'utf8')], ...atts]), zip: true };
}

export const modelJson = (m) => JSON.stringify(toJson(m));
