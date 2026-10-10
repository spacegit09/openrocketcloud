// Called by the front page for a signed-in person: returns the OpenRocket server address with a
// one-time pass that signs them in there. Expected problems come back as { error } with HTTP 200.
import { createClientFromRequest } from 'npm:@base44/sdk';
import { secrets } from 'base44:runtime';
import { pass } from '../../shared/sign.ts';

const safeNext = (n: unknown) => (typeof n === 'string' && /^\/(?![/\\])/.test(n) && n.length < 500 ? n : '/');

export default async function (req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me().catch(() => null);
    if (!user?.email) return Response.json({ error: 'signin' });

    const secret = secrets.get('ENGINE_SECRET');
    if (!secret) return Response.json({ error: 'not_configured' });

    const [engine] = await base44.asServiceRole.entities.Engine.list('-updated_date', 1);
    if (!engine?.url) return Response.json({ error: 'offline' });

    // The OpenRocket server may be a laptop that is asleep: check before sending people there.
    const up = await fetch(`${engine.url}/healthz`, { signal: AbortSignal.timeout(8000) }).then((r) => r.ok, () => false);
    if (!up) return Response.json({ error: 'offline' });

    const { next } = await req.json().catch(() => ({}));
    const token = await pass(secret, user, safeNext(next));
    return Response.json({ url: `${engine.url}/auth/base44?pass=${token}` });
  } catch (e) {
    console.error('launch failed', e);
    return Response.json({ error: 'failed' }, { status: 500 });
  }
}
