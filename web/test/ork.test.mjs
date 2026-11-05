// The browser .ork code (src/lib) must read and write designs exactly like the server's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { importOrk, exportOrk } from '../src/lib/ork.js';
import { RemoteZip, centralEntries, readZip, zipDirectory } from '../src/lib/zip.js';
import { importOrk as serverImport } from '../../server/src/orkfile.js';
import { toJson } from '../../server/src/model.js';

const jar = join(import.meta.dirname, '..', 'public', 'or', 'OpenRocket-web.jar');
const jarBytes = new Uint8Array(readFileSync(jar));

test('examples import like the server, and survive export + import', async () => {
  const entries = (await readZip(jarBytes)).filter((e) => e.name.startsWith('datafiles/examples/') && e.name.endsWith('.ork'));
  assert.ok(entries.length >= 15, `found ${entries.length} examples`);
  for (const e of entries) {
    const browser = await importOrk(e.data);
    const server = serverImport(Buffer.from(e.data));
    // Object ids are generated fresh on import; compare everything else.
    const strip = (m) => JSON.stringify(Object.values(toJson(m).objs).map((o) => ({ ...o, v: { ...o.v, id: undefined } })));
    assert.equal(strip(browser).length, strip(server).length, e.name);
    const again = await importOrk(await exportOrk(browser));
    assert.equal(again.objs.size, browser.objs.size, e.name);
  }
});

test('RemoteZip reads single entries with range requests', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    if (opts.method === 'HEAD') return new Response(null, { headers: { 'content-length': String(jarBytes.length) } });
    const [, a, b] = /bytes=(\d+)-(\d+)/.exec(opts.headers.range);
    return new Response(jarBytes.slice(Number(a), Math.min(Number(b) + 1, jarBytes.length)), { status: 206 });
  };
  try {
    const zip = new RemoteZip('/or/OpenRocket-web.jar');
    const names = (await zip.list()).map((e) => e.name).filter((n) => n.startsWith('datafiles/examples/') && n.endsWith('.ork'));
    const model = await importOrk(await zip.read(names[0]));
    assert.ok(model.objs.size > 10);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('RemoteZip with an index reads an example in one request, and copes with a stale index', async () => {
  const dir = zipDirectory(jarBytes);
  const index = centralEntries(jarBytes.subarray(dir.offset, dir.offset + dir.size), dir.count)
    .filter((e) => e.name.startsWith('datafiles/examples/') && e.name.endsWith('.ork'));
  const realFetch = globalThis.fetch;
  let served = index;
  const requests = [];
  globalThis.fetch = async (url, opts = {}) => {
    requests.push(opts.method === 'HEAD' ? 'HEAD' : opts.headers?.range ? 'range' : url);
    if (url === '/or/examples.json') return Response.json(served);
    if (opts.method === 'HEAD') return new Response(null, { headers: { 'content-length': String(jarBytes.length) } });
    const [, a, b] = /bytes=(\d+)-(\d+)/.exec(opts.headers.range);
    return new Response(jarBytes.slice(Number(a), Math.min(Number(b) + 1, jarBytes.length)), { status: 206 });
  };
  try {
    const zip = new RemoteZip('/or/OpenRocket-web.jar', { index: '/or/examples.json' });
    assert.equal((await zip.list()).length, index.length);
    const model = await importOrk(await zip.read(index[0].name));
    assert.ok(model.objs.size > 10);
    assert.deepEqual(requests, ['/or/examples.json', 'range'], 'the index, then the one entry');

    // An index from another build of the jar: the entry is found through the jar's own directory.
    served = index.map((e) => ({ ...e, local: e.local + 7 }));
    requests.length = 0;
    const stale = new RemoteZip('/or/OpenRocket-web.jar', { index: '/or/examples.json' });
    const again = await importOrk(await stale.read(index[0].name));
    assert.equal(again.objs.size, model.objs.size);
    assert.ok(requests.includes('HEAD'), 'fell back to reading the directory');
  } finally {
    globalThis.fetch = realFetch;
  }
});
