// The one-off move to sealed records (functions/migrateSealed runs it; test/api.test.mjs runs it
// against an in-memory stand-in for Base44). Copies each plain Design, Motor and SavedFlight record
// into a sealed one created by the service role, so no person shows as its creator: a design keeps
// its id as its room (links, content and history stay), a motor and a saved flight keep their old
// id as `ref`. Safe to run more than once: a copy is refreshed only from a plain record changed
// since it was made (never over a newer copy). With finish, it then deletes the plain records,
// each after its copy. Reports counts only, nothing personal.
//   db = service-role entities, s = sealer(DATA_KEY)
import { designFields, flightFields, motorFields } from './sealed.js';

const lower = (e) => String(e ?? '').trim().toLowerCase();
const newer = (a, b) => Date.parse(a?.updated_date ?? '') > Date.parse(b?.updated_date ?? '');
const isPlain = (r) => !r.sealed && Boolean(r.owner_email);

export async function migrateToSealed({ db, s, finish = false }) {
  const report = {
    designs: { plain: 0, copied: 0, refreshed: 0, removed: 0 },
    motors: { plain: 0, copied: 0, removed: 0 },
    flights: { plain: 0, copied: 0, refreshed: 0, removed: 0 },
  };

  // Designs: the copy is the sealed record whose room is the plain record's id.
  const designs = await db.Design.list('-created_date', 5000);
  const designCopy = new Map(designs.filter((r) => r.sealed && r.room).map((r) => [r.room, r]));
  for (const r of designs.filter(isPlain)) {
    report.designs.plain++;
    const copy = designCopy.get(r.id);
    if (!copy || newer(r, copy)) {
      const owner = lower(r.owner_email);
      const d = {
        name: String(r.name ?? 'Rocket'),
        owner_email: owner,
        owner_name: String(r.owner_name || owner.split('@')[0]),
        members: (r.members ?? [])
          .map((m) => ({ email: lower(m.email), role: m.role === 'viewer' ? 'viewer' : 'editor' }))
          .filter((m) => m.email && m.email !== owner),
      };
      const fields = {
        version: Math.max(r.version ?? 0, copy?.version ?? 0),
        edited_at: [r.edited_at, r.updated_date, copy?.edited_at].filter(Boolean).sort().pop(),
        ...(await designFields(s, d)),
      };
      if (r.preview != null) fields.sealed_preview = await s.seal(r.preview);
      if (copy) {
        await db.Design.update(copy.id, fields);
        report.designs.refreshed++;
      } else {
        await db.Design.create({ room: r.id, ...fields });
        report.designs.copied++;
      }
    }
    if (finish) {
      await db.Design.delete(r.id);
      report.designs.removed++;
    }
  }

  // Motors never change: one copy each.
  const motors = await db.Motor.list('-created_date', 5000);
  const motorCopied = new Set(motors.filter((r) => r.sealed && r.ref).map((r) => r.ref));
  for (const r of motors.filter(isPlain)) {
    report.motors.plain++;
    if (!motorCopied.has(r.id)) {
      const m = { filename: r.filename, content: r.content, summary: r.summary };
      await db.Motor.create({ ref: r.id, ...(await motorFields(s, lower(r.owner_email), m)) });
      report.motors.copied++;
    }
    if (finish) {
      await db.Motor.delete(r.id);
      report.motors.removed++;
    }
  }

  // Saved launch plans: the copy is the sealed record whose ref is the plain record's id.
  const flights = await db.SavedFlight.list('-created_date', 5000);
  const flightCopy = new Map(flights.filter((r) => r.sealed && r.ref).map((r) => [r.ref, r]));
  for (const r of flights.filter(isPlain)) {
    report.flights.plain++;
    const copy = flightCopy.get(r.id);
    if (!copy || newer(r, copy)) {
      const fields = await flightFields(s, lower(r.owner_email), r);
      if (copy) {
        await db.SavedFlight.update(copy.id, fields);
        report.flights.refreshed++;
      } else {
        await db.SavedFlight.create({ ref: r.id, ...fields });
        report.flights.copied++;
      }
    }
    if (finish) {
      await db.SavedFlight.delete(r.id);
      report.flights.removed++;
    }
  }
  return report;
}
