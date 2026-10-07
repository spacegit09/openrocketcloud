// .ork files in and out. OpenRocket writes a zip (rocket.ork + decal images); older versions
// wrote gzip or plain XML. All three are accepted, the way OpenRocket's own loader does.
import { gunzipSync } from 'node:zlib';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import AdmZip from 'adm-zip';
import { fromXml, toXml, attachments, toJson } from './model.js';
import { parse } from './xml.js';
import { config } from './config.js';
import { createZip } from './zip.js';

const MAX_EXPANDED = 300 * 1024 * 1024;

export class ImportError extends Error {}

export function importOrk(buf) {
  let xml;
  const atts = new Map();
  if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b) {
    let zip;
    try {
      zip = new AdmZip(buf);
    } catch {
      throw new ImportError('The file is not a valid .ork archive.');
    }
    const entries = zip.getEntries().filter((e) => !e.isDirectory);
    let total = 0;
    for (const e of entries) total += e.header.size;
    if (total > MAX_EXPANDED) throw new ImportError('The design archive is too large.');
    const main = entries.find((e) => /\.(ork|rkt)$/i.test(e.entryName));
    if (!main) throw new ImportError('No rocket design found inside the archive.');
    xml = main.getData().toString('utf8');
    for (const e of entries) if (e !== main) atts.set(e.entryName, e.getData());
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

// ------------------------------------------------------------------ templates

export function blankModel() {
  const xml = readFileSync(join(config.templatesDir, 'new-rocket.ork'));
  return importOrk(xml);
}

const examplesDir = () => join(config.templatesDir, 'examples');

export function listExamples() {
  if (!existsSync(examplesDir())) return [];
  return readdirSync(examplesDir()).filter((f) => f.endsWith('.ork')).sort().map((f) => f.replace(/\.ork$/, ''));
}

export function exampleModel(name) {
  if (!listExamples().includes(name)) throw new ImportError('Unknown example.');
  return importOrk(readFileSync(join(examplesDir(), `${name}.ork`)));
}

export const modelJson = (m) => JSON.stringify(toJson(m));
