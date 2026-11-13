// Wraps a handler from api.js as a backend function: the signed-in person, the service-role
// entities and the sealer in; JSON out. Errors are logged without any personal data.
import { createClientFromRequest } from "npm:@base44/sdk";
import { secrets } from "base44:runtime";
import { ApiError } from "./api.js";
import { sealer } from "./sealed.js";

type Handler = (ctx: { db: any; s: ReturnType<typeof sealer>; me: { id: string; email: string; name: string } }, body: any) => Promise<unknown>;

export function endpoint(name: string, handler: Handler) {
  return async (req: Request): Promise<Response> => {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me().catch(() => null);
    if (!user?.email) return Response.json({ error: "Please sign in." }, { status: 401 });
    try {
      const email = String(user.email).toLowerCase();
      const me = { id: String(user.id ?? ""), email, name: String(user.full_name || email.split("@")[0]) };
      const body = await req.json().catch(() => ({}));
      const out = await handler({ db: base44.asServiceRole.entities, s: sealer(secrets.get("DATA_KEY")), me }, body);
      return Response.json(out);
    } catch (e) {
      if (e instanceof ApiError) return Response.json({ error: e.message }, { status: e.status });
      // Only the kind of error: a message could quote a record.
      console.error(`${name} failed:`, e instanceof Error ? e.name : "error", (e as any)?.status ?? "");
      return Response.json({ error: "Something went wrong. Please try again." }, { status: 500 });
    }
  };
}
