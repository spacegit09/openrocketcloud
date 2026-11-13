#!/usr/bin/env node
// Runs the design page on this computer, to try changes before publishing them: Vite serves the
// site, and a local stand-in for the live-sharing room (test/hub.mjs) holds one design, opened as
// its owner without signing in.
//
//   node web/scripts/dev-design.mjs [example name | path/to/design.ork] [motor.eng|.rse ...]
//
// With no design, OpenRocket's "A simple model rocket" example; custom motor files load as they
// would from the motors you upload on the site. Then open the address it prints. Changes to the
// page's JavaScript and CSS show at once; after changing Java (worker/bridge), run
// scripts/build-web-jars.sh and reload the page. Edits made in the page last until this stops.
import { readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { createServer } from 'vite';
import WebSocket from 'ws';
import { startHub } from '../test/hub.mjs';
import { importOrk } from '../src/lib/ork.js';
import { readZip } from '../src/lib/zip.js';
import { toJson } from '../../server/src/model.js';

const web = join(import.meta.dirname, '..');
const HUB_PORT = Number(process.env.DEV_HUB_PORT ?? 8795);
const PORT = Number(process.env.DEV_PORT ?? 5190);
const USER = 'dev@test.local';

const [design = 'A simple model rocket', ...motorFiles] = process.argv.slice(2);
let bytes, name;
if (/\.(ork|rkt)$/i.test(design)) {
  bytes = new Uint8Array(readFileSync(resolve(design)));
  name = basename(design).replace(/\.(ork|rkt)$/i, '');
} else {
  const jar = join(web, 'public', 'or', 'OpenRocket-web.jar');
  const entries = await readZip(new Uint8Array(readFileSync(jar))).catch((e) => {
    throw new Error(`Cannot read ${jar} (${e.message}): run scripts/build-web-jars.sh first.`);
  });
  const entry = entries.find((e) => e.name === `datafiles/examples/${design}.ork`);
  if (!entry) {
    const names = entries.filter((e) => e.name.startsWith('datafiles/examples/')).map((e) => e.name.slice(19, -4));
    throw new Error(`No example "${design}". Examples: ${names.join(', ')}`);
  }
  bytes = entry.data;
  name = design;
}
const motors = motorFiles.map((f) => ({ name: basename(f), content: readFileSync(resolve(f), 'utf8') }));

startHub({ port: HUB_PORT, designs: new Map([['dev', { name, owner: USER, members: {} }]]), motors });
const vite = await createServer({ root: web, server: { port: PORT, strictPort: true }, logLevel: 'warn' });
await vite.listen();

// The design's content, as when it is first opened on the site.
const ws = new WebSocket(`ws://localhost:${HUB_PORT}/?design=dev&user=${USER}&conn=dev-setup`);
await new Promise((ok, fail) => (ws.on('open', ok), ws.on('error', fail)));
ws.send(JSON.stringify({ type: 'init', rid: 'dev', model: toJson(await importOrk(bytes)) }));

console.log(`${name}${motors.length ? ` with ${motors.map((m) => m.name).join(', ')}` : ''}:`);
console.log(`READY http://localhost:${PORT}/design.html?id=dev&hub=ws://localhost:${HUB_PORT}&user=${USER}`);
