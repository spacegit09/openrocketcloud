// Wraps a handler from api.js as a backend function: the signed-in person, the service-role
// entities and the sealer in; JSON out. Errors are logged without any personal data.
//
// With `open`, the function is for people with a plan (shared/billing.js): someone whose free week
// has ended gets a 402 (code plan_required) for any action not in `open`.
import { createClientFromRequest } from "npm:@base44/sdk";
import { secrets } from "base44:runtime";
import { ApiError } from "./api.js";
import { BillingError, paddleApi, requirePlan } from "./billing.js";
import { sealer } from "./sealed.js";

type Files = { sign(uri: string): Promise<string | null> };
type Me = { id: string; email: string; name: string; created: string | null; role: string | null };
type Ctx = { db: any; s: ReturnType<typeof sealer>; me: Me; files: Files; paddle: ReturnType<typeof paddleApi> | null; paddleToken: string | null };
type Handler = (ctx: Ctx, body: any) => Promise<unknown>;

export function endpoint(name: string, handler: Handler, { open = null }: { open?: string[] | null } = {}) {
  return async (req: Request): Promise<Response> => {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me().catch(() => null);
    if (!user?.email) return Response.json({ error: "Please sign in." }, { status: 401 });
    try {
      const email = String(user.email).toLowerCase();
      const me = {
        id: String(user.id ?? ""),
        email,
        name: String(user.full_name || email.split("@")[0]),
        created: user.created_date ? String(user.created_date) : null,
        role: user.role ? String(user.role) : null,
      };
      const body = await req.json().catch(() => ({}));
      // Signed links (an hour) to Base44 private files, as the service role: anyone a logbook is
      // shared with sees its photos, whoever uploaded them.
      const files: Files = {
        sign: async (uri) => (await base44.asServiceRole.integrations.Core.CreateFileSignedUrl({ file_uri: uri, expires_in: 3600 })).signed_url ?? null,
      };
      // Paddle (payments): set up once its keys are app secrets (README: Plans and payments).
      const key = secrets.get("PADDLE_API_KEY");
      const paddle = key ? paddleApi(key, secrets.get("PADDLE_ENVIRONMENT") === "sandbox" ? { sandbox: true } : {}) : null;
      const ctx = { db: base44.asServiceRole.entities, s: sealer(secrets.get("DATA_KEY")), me, files, paddle, paddleToken: secrets.get("PADDLE_CLIENT_TOKEN") ?? null };
      if (open) await requirePlan(ctx, String(body?.action ?? ""), open);
      const out = await handler(ctx, body);
      return Response.json(out);
    } catch (e) {
      if (e instanceof ApiError) return Response.json({ error: e.message }, { status: e.status });
      if (e instanceof BillingError) return Response.json({ error: e.message, ...(e.code ? { code: e.code } : {}) }, { status: e.status });
      // Only the kind of error: a message could quote a record.
      console.error(`${name} failed:`, e instanceof Error ? e.name : "error", (e as any)?.status ?? "");
      return Response.json({ error: "Something went wrong. Please try again." }, { status: 500 });
    }
  };
}
