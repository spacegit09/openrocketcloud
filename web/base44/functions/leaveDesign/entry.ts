// Removes the signed-in person from a design shared with them (only the owner can edit the
// Design record directly).
import { createClientFromRequest } from "npm:@base44/sdk";

export default async function (req: Request): Promise<Response> {
  const base44 = createClientFromRequest(req);
  const me = await base44.auth.me().catch(() => null);
  if (!me?.email) return Response.json({ error: "Please sign in." }, { status: 401 });
  const { designId } = await req.json().catch(() => ({}));
  const db = base44.asServiceRole.entities;
  const d = await db.Design.get(String(designId ?? "")).catch(() => null);
  if (!d) return Response.json({ error: "Design not found." }, { status: 404 });
  const email = String(me.email).toLowerCase();
  if (String(d.owner_email).toLowerCase() === email) {
    return Response.json({ error: "You own this design. Delete it instead." }, { status: 400 });
  }
  const members = (d.members ?? []).filter((m: { email: string }) => String(m.email).toLowerCase() !== email);
  await db.Design.update(d.id, { members, member_emails: [d.owner_email, ...members.map((m: { email: string }) => m.email)] });
  return Response.json({ ok: true });
}
