// Zip archives in the browser (the same format as server/src/zip.js, using the browser's own
// compression streams). Entry order is kept: OpenRocket reads the first entry as the design.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function pipe(bytes, stream) {
  const out = new Blob([bytes]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

export const deflateRaw = (bytes) => pipe(bytes, new CompressionStream('deflate-raw'));
export const inflateRaw = (bytes) => pipe(bytes, new DecompressionStream('deflate-raw'));
export const gunzip = (bytes) => pipe(bytes, new DecompressionStream('gzip'));

function dosDateTime(d) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/** entries: Array<[name, Uint8Array]> in the order they should appear. */
export async function createZip(entries) {
  const { time, date } = dosDateTime(new Date());
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const nameBytes = enc.encode(name);
    const deflated = await deflateRaw(data);
    const stored = deflated.length >= data.length;
    const body = stored ? data : deflated;
    const method = stored ? 0 : 8;
    const crc = crc32(data);

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(8, method, true);
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, body.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, nameBytes.length, true);
    parts.push(new Uint8Array(local.buffer), nameBytes, body);

    const cen = new DataView(new ArrayBuffer(46));
    cen.setUint32(0, 0x02014b50, true);
    cen.setUint16(4, 20, true);
    cen.setUint16(6, 20, true);
    cen.setUint16(8, 0x0800, true);
    cen.setUint16(10, method, true);
    cen.setUint16(12, time, true);
    cen.setUint16(14, date, true);
    cen.setUint32(16, crc, true);
    cen.setUint32(20, body.length, true);
    cen.setUint32(24, data.length, true);
    cen.setUint16(28, nameBytes.length, true);
    cen.setUint32(42, offset, true);
    central.push(new Uint8Array(cen.buffer), nameBytes);
    offset += 30 + nameBytes.length + body.length;
  }
  const centralSize = central.reduce((n, b) => n + b.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  return new Uint8Array(await new Blob([...parts, ...central, new Uint8Array(end.buffer)]).arrayBuffer());
}

/** Parses a zip's central directory: [{ name, method, compSize, size, local }]. */
export function zipDirectory(bytes, { base = 0 } = {}) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (v.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error('not a zip archive');
  return {
    count: v.getUint16(end + 10, true),
    size: v.getUint32(end + 12, true),
    offset: v.getUint32(end + 16, true) - base,
  };
}

export function centralEntries(bytes, count) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dec = new TextDecoder();
  const out = [];
  let p = 0;
  for (let n = 0; n < count; n++) {
    if (v.getUint32(p, true) !== 0x02014b50) throw new Error('corrupt zip directory');
    const nameLen = v.getUint16(p + 28, true);
    out.push({
      name: dec.decode(bytes.subarray(p + 46, p + 46 + nameLen)),
      method: v.getUint16(p + 10, true),
      compSize: v.getUint32(p + 20, true),
      size: v.getUint32(p + 24, true),
      local: v.getUint32(p + 42, true),
    });
    p += 46 + nameLen + v.getUint16(p + 30, true) + v.getUint16(p + 32, true);
  }
  return out;
}

/** Decompresses one entry, given the bytes starting at its local header. */
export async function entryData(e, bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (v.getUint32(0, true) !== 0x04034b50) throw new Error('corrupt zip entry');
  const start = 30 + v.getUint16(26, true) + v.getUint16(28, true);
  const raw = bytes.subarray(start, start + e.compSize);
  if (e.method === 0) return raw.slice();
  if (e.method === 8) return inflateRaw(raw);
  throw new Error(`unsupported zip compression (${e.method})`);
}

/** Reads a whole zip in memory: [{ name, data }] in archive order. */
export async function readZip(bytes, { maxTotal = 300 * 1024 * 1024 } = {}) {
  const dir = zipDirectory(bytes);
  const entries = centralEntries(bytes.subarray(dir.offset, dir.offset + dir.size), dir.count);
  const out = [];
  let total = 0;
  for (const e of entries) {
    if (e.name.endsWith('/')) continue;
    total += e.size;
    if (total > maxTotal) throw new Error('zip archive too large');
    out.push({ name: e.name, data: await entryData(e, bytes.subarray(e.local)) });
  }
  return out;
}

/**
 * A zip file on the web server, read with HTTP range requests (only the directory and the
 * entries asked for are downloaded). Used to take OpenRocket's example designs out of its jar.
 */
export class RemoteZip {
  constructor(url) {
    this.url = url;
    this.entries = null;
  }

  async range(start, end) {
    const res = await fetch(this.url, { headers: { range: `bytes=${start}-${end - 1}` } });
    if (res.status !== 206 && !res.ok) throw new Error(`Could not read ${this.url} (${res.status})`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    return res.status === 206 ? bytes : bytes.subarray(start, end);
  }

  async list() {
    if (this.entries) return this.entries;
    const head = await fetch(this.url, { method: 'HEAD' });
    const total = Number(head.headers.get('content-length'));
    const tailStart = Math.max(0, total - 65557);
    const tail = await this.range(tailStart, total);
    const dir = zipDirectory(tail, { base: 0 });
    const central = await this.range(dir.offset, dir.offset + dir.size);
    this.entries = centralEntries(central, dir.count);
    return this.entries;
  }

  async read(name) {
    const e = (await this.list()).find((x) => x.name === name);
    if (!e) throw new Error(`${name} not found`);
    const bytes = await this.range(e.local, e.local + 30 + 1024 + e.compSize);
    return entryData(e, bytes);
  }
}
