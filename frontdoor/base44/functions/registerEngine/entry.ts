// Called over HTTP by the OpenRocket server when it starts (and every few hours) to say where it
// is now. The request is signed with the shared secret, so only that server can move the address.
import { createClientFromRequest } from 'npm:@base44/sdk';
import { secrets } from 'base44:runtime';
import { mac, sameString } from '../../shared/sign.ts';

export default async function (req: Request): Promise<Response> {
  if (req.method !== 'POST') return Response.json({ error: 'POST only' }, { status: 405 });
  const secret = secrets.get('ENGINE_SECRET');
  if (!secret) return Response.json({ error: 'ENGINE_SECRET is not set' }, { status: 503 });

  const { url, ts, sig } = await req.json().catch(() => ({}));
  if (typeof url !== 'string' || typeof ts !== 'number' || typeof sig !== 'string') {
    return Response.json({ error: 'expected { url, ts, sig }' }, { status: 400 });
  }
  if (Math.abs(Date.now() - ts) > 5 * 60_000) return Response.json({ error: 'stale request' }, { status: 401 });
  if (!sameString(sig, await mac(secret, 'engine', `${url}.${ts}`))) {
    return Response.json({ error: 'bad signature' }, { status: 401 });
  }
  let origin: string;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') throw new Error('not https');
    origin = u.origin;
  } catch {
    return Response.json({ error: 'url must be an https address' }, { status: 400 });
  }

  const engines = createClientFromRequest(req).asServiceRole.entities.Engine;
  const data = { url: origin, seen_at: new Date().toISOString() };
  const [current] = await engines.list('-updated_date', 1);
  if (current) await engines.update(current.id, data);
  else await engines.create(data);
  return Response.json({ ok: true, url: origin });
}
