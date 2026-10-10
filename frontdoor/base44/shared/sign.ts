// HMAC-SHA256 with the secret shared with the OpenRocket server (BASE44_SECRET there,
// ENGINE_SECRET here). Must match server/src/auth.js: mac = HMAC(secret, `${kind}.${body}`),
// base64url without padding.
const enc = new TextEncoder();

export function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function mac(secret: string, kind: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(`${kind}.${body}`))));
}

export function sameString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** A pass that signs `user` in on the OpenRocket server once, within the next minute. */
export async function pass(secret: string, user: { id: string; email: string; full_name?: string }, next: string): Promise<string> {
  const payload = {
    sub: String(user.id),
    email: user.email,
    name: user.full_name ?? '',
    next,
    exp: Date.now() + 60_000,
    n: crypto.randomUUID(),
  };
  const body = b64url(enc.encode(JSON.stringify(payload)));
  return `${body}.${await mac(secret, 'pass', body)}`;
}
