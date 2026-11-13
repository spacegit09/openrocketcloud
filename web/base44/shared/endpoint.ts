// Wraps a handler from api.js as a backend function: the signed-in person, the service-role
// entities and the sealer in; JSON out. Errors are logged without any personal data.
import { createClientFromRequest } from "npm:@base44/sdk";
import { secrets } from "base44:runtime";
import { ApiError } from "./api.js";
import { sealer } from "./sealed.js";

type Files = { sign(uri: string): Promise<string | null> };
type Handler = (ctx: { db: any; s: ReturnType<typeof sealer>; me: { id: string; email: string; name: string }; files: Files }, body: any) => Promise<unknown>;

export function endpoint(name: string, handler: Handler) {
  return async (req: Request): Promise<Response> => {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me().catch(() => null);
    if (!user?.email) return Response.json({ error: "Please sign in." }, { status: 401 });
    try {
      const email = String(user.email).toLowerCase();
      const me = { id: String(user.id ?? ""), email, name: String(user.full_name || email.split("@")[0]) };
      const body = await req.json().catch(() => ({}));
      // Signed links (an hour) to Base44 private files, as the service role: anyone a logbook is
      // shared with sees its photos, whoever uploaded them.
      const files: Files = {
        sign: async (uri) => (await base44.asServiceRole.integrations.Core.CreateFileSignedUrl({ file_uri: uri, expires_in: 3600 })).signed_url ?? null,
      };
      const out = await handler({ db: base44.asServiceRole.entities, s: sealer(secrets.get("DATA_KEY")), me, files }, body);
      return Response.json(out);
    } catch (e) {
      if (e instanceof ApiError) return Response.json({ error: e.message }, { status: e.status });
      // Only the kind of error: a message could quote a record.
      console.error(`${name} failed:`, e instanceof Error ? e.name : "error", (e as any)?.status ?? "");
      return Response.json({ error: "Something went wrong. Please try again." }, { status: 500 });
    }
  };
}
