// One-off move to sealed records (shared/migrate.js; this function is removed after use). Admins
// only; { finish: true } also deletes the plain records. Reports counts, nothing personal.
import { createClientFromRequest } from "npm:@base44/sdk";
import { secrets } from "base44:runtime";
import { migrateToSealed } from "../../shared/migrate.js";
import { sealer } from "../../shared/sealed.js";

export default async function (req: Request): Promise<Response> {
  const base44 = createClientFromRequest(req);
  const user = await base44.auth.me().catch(() => null);
  if (user?.role !== "admin") return Response.json({ error: "Admins only." }, { status: 403 });
  const { finish = false } = await req.json().catch(() => ({}));
  try {
    const report = await migrateToSealed({
      db: base44.asServiceRole.entities,
      s: sealer(secrets.get("DATA_KEY")),
      finish: finish === true,
    });
    return Response.json(report);
  } catch (e) {
    // Only the kind of error: a message could quote a record.
    console.error("migrateSealed failed:", e instanceof Error ? e.name : "error", (e as any)?.status ?? "");
    return Response.json({ error: "The move stopped part way; it is safe to run again." }, { status: 500 });
  }
}
