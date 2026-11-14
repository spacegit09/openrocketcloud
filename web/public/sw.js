// Keeps OpenRocket's jar files in this browser, so opening a design reads them from here instead
// of the network. The site's hosting lets browsers keep files for an hour only and marks every file
// as new with each release, so without this a returning browser fetched OpenRocket's ~20 MB again
// (about 120 requests) whenever it had been away an hour or the site had been released.
//
// Only the versioned jars the pages load are kept (web/src/lib/jars.js): OpenRocket-web.jar?v=HASH
// and orcloud-web-HASH.jar, named after their contents, so a kept copy always belongs to exactly
// that file; a new version is fetched afresh and older ones are dropped. They are kept in 128 KB
// blocks, the pieces OpenRocket's runtime (CheerpJ) reads them in, and each request for a range is
// answered from the blocks, fetching only the missing ones. Every other request goes to the network
// as usual, and so does anything unexpected here.

const CACHE = 'or-jars-1';
const BLOCK = 131072;
const KEY_ROOT = '/__or-jar-cache/';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

/** The versioned jar a request is for ("/or/...?v=..."), or null. */
function versioned(url) {
  if (url.origin !== self.location.origin) return null;
  if (url.pathname === '/or/OpenRocket-web.jar' && /^[0-9a-f]{8,64}$/.test(url.searchParams.get('v') ?? '')) {
    return { family: 'OpenRocket-web', version: `${url.pathname}?v=${url.searchParams.get('v')}` };
  }
  const m = /^\/or\/(orcloud-web)-[0-9a-f]{8,64}\.jar$/.exec(url.pathname);
  return m && !url.search ? { family: m[1], version: url.pathname } : null;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const jar = versioned(url);
  const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.get('range') ?? '');
  if (!jar || !range) return;
  event.respondWith(serve(url, jar, Number(range[1]), Number(range[2])).catch(() => fetch(req)));
});

const keyOf = (jar, part) => `${self.location.origin}${KEY_ROOT}${encodeURIComponent(jar.version)}/${part}`;

const total = (res) => Number(/\/(\d+)$/.exec(res.headers.get('content-range') ?? '')?.[1] ?? NaN);

async function serve(url, jar, start, end) {
  const cache = await caches.open(CACHE);
  let size = await knownSize(cache, jar);
  if (!size) {
    // The first request for this version: from the network, as usual; it tells the file's size.
    const res = await fetch(url.href, { headers: { Range: `bytes=${start}-${end}` } });
    await learnSize(cache, jar, res);
    return res;
  }
  if (start > end || start >= size) throw new Error('bad range');
  end = Math.min(end, size - 1);
  const first = Math.floor(start / BLOCK);
  const blocks = await blocksOf(cache, url, jar, size, first, Math.floor(end / BLOCK));
  const out = new Uint8Array(end - start + 1);
  for (let k = 0; k < blocks.length; k++) {
    const at = (first + k) * BLOCK;
    const from = Math.max(start, at) - at;
    const to = Math.min(end + 1, at + blocks[k].length) - at;
    out.set(blocks[k].subarray(from, to), at + from - start);
  }
  return new Response(out, {
    status: 206,
    headers: {
      'Content-Type': 'application/java-archive',
      'Content-Length': String(out.length),
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Accept-Ranges': 'bytes',
    },
  });
}

async function knownSize(cache, jar) {
  const sized = await cache.match(keyOf(jar, 'size'));
  const size = sized ? Number(await sized.text()) : NaN;
  return size > 0 ? size : null;
}

/** Keeps the size a range answer gives for this version (and drops older versions' blocks). */
async function learnSize(cache, jar, res) {
  const size = total(res);
  if (res.status === 206 && size > 0 && !(await knownSize(cache, jar))) {
    await forgetOthers(cache, jar);
    await cache.put(keyOf(jar, 'size'), new Response(String(size))).catch(() => {});
  }
  return size;
}

// Blocks being downloaded now, by cache key: a second request for one waits for that download
// instead of starting another (the page's prefetch and OpenRocket ask for the same blocks).
const pending = new Map();

/**
 * Blocks first..last of the jar: kept ones, ones on their way, and the rest downloaded now, a run of
 * neighbours per request.
 */
async function blocksOf(cache, url, jar, size, first, last) {
  const out = [];
  for (let i = first; i <= last; i++) {
    const key = keyOf(jar, i);
    if (pending.has(key)) {
      out.push(pending.get(key));
      continue;
    }
    const hit = await cache.match(key);
    out.push(hit ? hit.arrayBuffer().then((b) => new Uint8Array(b)) : null);
  }
  // Blocks another request started downloading while these were looked up are waited for too.
  for (let k = 0; k < out.length; k++) if (!out[k] && pending.has(keyOf(jar, first + k))) out[k] = pending.get(keyOf(jar, first + k));
  for (let k = 0; k < out.length; k++) {
    if (out[k]) continue;
    let j = k;
    while (j + 1 < out.length && !out[j + 1]) j++;
    const run = download(cache, url, jar, size, first + k, first + j);
    for (let m = k; m <= j; m++) {
      const key = keyOf(jar, first + m);
      const block = run.then((bs) => bs[m - k]);
      pending.set(key, block);
      block.catch(() => {}).finally(() => pending.get(key) === block && pending.delete(key));
      out[m] = block;
    }
    k = j;
  }
  return Promise.all(out);
}

/** Downloads blocks a..b in one request, keeps them, and returns them. */
async function download(cache, url, jar, size, a, b) {
  const from = a * BLOCK;
  const to = Math.min((b + 1) * BLOCK, size) - 1;
  const res = await fetch(url.href, { headers: { Range: `bytes=${from}-${to}` } });
  if (res.status !== 206 || total(res) !== size || !(res.headers.get('content-range') ?? '').startsWith(`bytes ${from}-`)) {
    throw new Error('unexpected answer'); // not the file this version was: the network answers instead
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length !== to - from + 1) throw new Error('short answer');
  const blocks = [];
  for (let i = a; i <= b; i++) {
    const block = bytes.slice((i - a) * BLOCK, Math.min((i - a + 1) * BLOCK, bytes.length));
    blocks.push(block);
    await cache.put(keyOf(jar, i), new Response(block)).catch(() => {}); // full storage: just not kept
  }
  return blocks;
}

// The design page asks for the parts of OpenRocket's jar it starts with (src/lib/jars.js) as it
// opens: downloaded here 1 MB at a time, four at once, and kept, so OpenRocket finds them waiting
// instead of fetching 128 KB blocks one after another as it starts.
const PREFETCH_BLOCKS = 8;
const PREFETCH_PARALLEL = 4;

self.addEventListener('message', (event) => {
  const m = event.data;
  if (m?.type !== 'prefetch' || !Array.isArray(m.ranges)) return;
  event.waitUntil(prefetch(new URL(m.url, self.location.origin), m.ranges).catch(() => {}));
});

async function prefetch(url, ranges) {
  const jar = versioned(url);
  if (!jar) return;
  const cache = await caches.open(CACHE);
  const size = (await knownSize(cache, jar)) ?? (await learnSize(cache, jar, await fetch(url.href, { headers: { Range: 'bytes=0-0' } })));
  if (!(size > 0)) return;
  const chunks = [];
  for (const [start, end] of ranges) {
    const last = Math.floor(Math.min(end, size - 1) / BLOCK);
    for (let i = Math.floor(start / BLOCK); i <= last; i += PREFETCH_BLOCKS) chunks.push([i, Math.min(i + PREFETCH_BLOCKS - 1, last)]);
  }
  let next = 0;
  const worker = async () => {
    while (next < chunks.length) {
      const [a, b] = chunks[next++];
      await blocksOf(cache, url, jar, size, a, b).catch(() => {});
    }
  };
  await Promise.all(Array.from({ length: PREFETCH_PARALLEL }, worker));
}

/** Drops the kept blocks of other versions of the same jar. */
async function forgetOthers(cache, jar) {
  const mine = `${KEY_ROOT}${encodeURIComponent(jar.version)}/`;
  const family = `${KEY_ROOT}${encodeURIComponent(`/or/${jar.family}`)}`;
  for (const req of await cache.keys()) {
    const path = new URL(req.url).pathname;
    if (path.startsWith(family) && !path.startsWith(mine)) await cache.delete(req);
  }
}
