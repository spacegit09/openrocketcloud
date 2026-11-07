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
  const sized = await cache.match(keyOf(jar, 'size'));
  if (!sized) {
    // The first request for this version: from the network, as usual; it tells the file's size.
    const res = await fetch(url.href, { headers: { Range: `bytes=${start}-${end}` } });
    const size = total(res);
    if (res.status === 206 && size > 0) {
      await forgetOthers(cache, jar);
      await cache.put(keyOf(jar, 'size'), new Response(String(size))).catch(() => {});
    }
    return res;
  }
  const size = Number(await sized.text());
  if (!(size > 0) || start > end || start >= size) throw new Error('bad range');
  end = Math.min(end, size - 1);
  const first = Math.floor(start / BLOCK);
  const last = Math.floor(end / BLOCK);
  const blocks = [];
  for (let i = first; i <= last; i++) {
    const hit = await cache.match(keyOf(jar, i));
    blocks.push(hit ? new Uint8Array(await hit.arrayBuffer()) : null);
  }
  // The missing blocks, a run of neighbours at a time.
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i]) continue;
    let j = i;
    while (j + 1 < blocks.length && !blocks[j + 1]) j++;
    const from = (first + i) * BLOCK;
    const to = Math.min((first + j + 1) * BLOCK, size) - 1;
    const res = await fetch(url.href, { headers: { Range: `bytes=${from}-${to}` } });
    if (res.status !== 206 || total(res) !== size || !(res.headers.get('content-range') ?? '').startsWith(`bytes ${from}-`)) {
      throw new Error('unexpected answer'); // not the file this version was: the network answers instead
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length !== to - from + 1) throw new Error('short answer');
    for (let k = i; k <= j; k++) {
      const block = bytes.slice((k - i) * BLOCK, Math.min((k - i + 1) * BLOCK, bytes.length));
      blocks[k] = block;
      await cache.put(keyOf(jar, first + k), new Response(block)).catch(() => {}); // full storage: just not kept
    }
    i = j;
  }
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

/** Drops the kept blocks of other versions of the same jar. */
async function forgetOthers(cache, jar) {
  const mine = `${KEY_ROOT}${encodeURIComponent(jar.version)}/`;
  const family = `${KEY_ROOT}${encodeURIComponent(`/or/${jar.family}`)}`;
  for (const req of await cache.keys()) {
    const path = new URL(req.url).pathname;
    if (path.startsWith(family) && !path.startsWith(mine)) await cache.delete(req);
  }
}
