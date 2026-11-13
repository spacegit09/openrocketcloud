// Personal data (names, email addresses, design names, motor files) is stored sealed: encrypted
// with the app's DATA_KEY secret (AES-256-GCM), so Base44's dashboard shows only ciphertext.
// Records are found by keyed fingerprints of email addresses (HMAC-SHA-256), which cannot be
// turned back into addresses without the key.
//
// Plain JavaScript with Web Crypto only: the backend functions import it from here, the
// DesignRoom actor gets a copy (scripts/prebuild.mjs), and test/sealed.test.mjs runs it in Node.

const enc = new TextEncoder();
const dec = new TextDecoder();

function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

const fromBase64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** Sealing with one key (DATA_KEY: 32 random bytes, base64): lookupKey, seal and open. */
export function sealer(secret) {
  let raw = null;
  try {
    raw = fromBase64(String(secret ?? ''));
  } catch {
    // reported below
  }
  if (!raw || raw.length !== 32) throw new Error('DATA_KEY must be 32 random bytes in base64.');
  const keys = (async () => {
    const base = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey']);
    const derive = (info, algorithm, usages) => crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: enc.encode(info) },
      base, algorithm, false, usages);
    return {
      aes: await derive('rocket-in-cloud seal v1', { name: 'AES-GCM', length: 256 }, ['encrypt', 'decrypt']),
      mac: await derive('rocket-in-cloud lookup v1', { name: 'HMAC', hash: 'SHA-256', length: 256 }, ['sign']),
    };
  })();
  return {
    /** Fingerprint of an email address (case-insensitive), for finding records. */
    async lookupKey(email) {
      const { mac } = await keys;
      const sig = new Uint8Array(await crypto.subtle.sign('HMAC', mac, enc.encode(String(email).trim().toLowerCase())));
      return toBase64(sig).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    },
    /** Encrypts any JSON value. */
    async seal(value) {
      const { aes } = await keys;
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aes, enc.encode(JSON.stringify(value))));
      const out = new Uint8Array(iv.length + data.length);
      out.set(iv);
      out.set(data, iv.length);
      return `v1.${toBase64(out)}`;
    },
    /** Decrypts what seal() produced; throws if it was altered or sealed with another key. */
    async open(sealed) {
      const { aes } = await keys;
      if (!String(sealed).startsWith('v1.')) throw new Error('Not sealed data.');
      const bytes = fromBase64(String(sealed).slice(3));
      const data = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.subarray(0, 12) }, aes, bytes.subarray(12));
      return JSON.parse(dec.decode(data));
    },
  };
}

// ------------------------------------------------------------------ designs, motors, flights
//
// Design record: { room, people, sealed, sealed_preview, version, edited_at }
//   room            the design's id in links and in its DesignRoom actor session
//   people          lookup keys of the owner and members
//   sealed          { name, owner_email, owner_name, members: [{ email, role }] }
//   sealed_preview  OpenRocket's drawing of it for its card (server/src/preview.js), sealed apart
//                   so that its room can keep it without touching the rest
// Motor record: { owner, ref, sealed } with sealed = { filename, content, summary }
// SavedFlight record: { owner, ref, sealed } with sealed = { name, design_id, design_name,
//   launch_time, summary, data }
//   owner  the lookup key of the person it belongs to
//   ref    for a record moved from before records were sealed, its old id (links to it still work)

/**
 * A Design record as the site sees it: { id (the room), name, owner_email, owner_name, members,
 * preview, version, edited_at, created_date, updated_date }.
 */
export async function readDesign(s, r) {
  const p = await s.open(r.sealed);
  return {
    id: r.room,
    name: p.name,
    owner_email: p.owner_email,
    owner_name: p.owner_name,
    members: p.members ?? [],
    preview: r.sealed_preview ? await s.open(r.sealed_preview) : null,
    version: r.version ?? 0,
    edited_at: r.edited_at ?? r.updated_date ?? r.created_date,
    created_date: r.created_date,
    updated_date: r.updated_date,
  };
}

/** The stored fields for a design's name and people. */
export async function designFields(s, d) {
  const emails = [d.owner_email, ...d.members.map((m) => m.email)];
  return {
    people: await Promise.all(emails.map((e) => s.lookupKey(e))),
    sealed: await s.seal({ name: d.name, owner_email: d.owner_email, owner_name: d.owner_name, members: d.members }),
  };
}

/** 'owner', 'editor' or 'viewer' for this email, or null. */
export function roleIn(d, email) {
  const e = String(email ?? '').toLowerCase();
  if (String(d.owner_email).toLowerCase() === e) return 'owner';
  return d.members.find((m) => String(m.email).toLowerCase() === e)?.role ?? null;
}

/** A Motor record as the site sees it: { id, filename, content, summary, created_date }. */
export async function readMotor(s, r) {
  const p = await s.open(r.sealed);
  return { id: r.id, filename: p.filename, content: p.content, summary: p.summary ?? '[]', created_date: r.created_date };
}

export async function motorFields(s, ownerEmail, m) {
  return {
    owner: await s.lookupKey(ownerEmail),
    sealed: await s.seal({ filename: m.filename, content: m.content, summary: m.summary ?? '[]' }),
  };
}

const FLIGHT_FIELDS = ['name', 'design_id', 'design_name', 'launch_time', 'summary', 'data'];

/**
 * A SavedFlight record as the site sees it: { id, name, design_id, design_name, launch_time,
 * summary, data, created_date, updated_date }; a moved one keeps its old id.
 */
export async function readFlight(s, r) {
  const p = await s.open(r.sealed);
  const out = { id: r.ref || r.id };
  for (const k of FLIGHT_FIELDS) out[k] = p[k] ?? null;
  return { ...out, created_date: r.created_date, updated_date: r.updated_date };
}

export async function flightFields(s, ownerEmail, f) {
  const p = {};
  for (const k of FLIGHT_FIELDS) p[k] = f[k] ?? null;
  return { owner: await s.lookupKey(ownerEmail), sealed: await s.seal(p) };
}
