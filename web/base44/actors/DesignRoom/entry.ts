// The DesignRoom actor: one session per design (session id = Design record id). The live-share
// logic is in room.js; this file connects it to Base44 (storage, connections, entities).
import { Actor } from "base44:runtime/actors";
import { Room } from "./room.js";

type Person = { id: string; email: string; name: string };

const motorFileName = (m: { id: string; filename: string }) =>
  `${m.id.slice(0, 8)}-${m.filename.replace(/[^A-Za-z0-9._-]/g, "_")}`;

// Each lookup of a record takes a fraction of a second, so the room shares them: the design's
// record (who it is shared with) for everyone checking their access within a couple of seconds,
// and the motors for everyone joining within a few.
const RECORD_MS = 2_000;
const MOTORS_MS = 5_000;

/** A shared lookup: one at a time, its answer kept for `ms` (a failed or empty one not kept). */
function shared<T>(ms: number, look: () => Promise<T>) {
  let kept: { at: number; p: Promise<T> } | null = null;
  return (fresh = false): Promise<T> => {
    if (fresh || !kept || Date.now() - kept.at > ms) {
      const entry = { at: Date.now(), p: look() };
      kept = entry;
      entry.p.then(
        (v) => { if (v == null && kept === entry) kept = null; },
        () => { if (kept === entry) kept = null; },
      );
    }
    return kept.p;
  };
}

export default class DesignRoom extends Actor {
  room: Room | null = null;
  people = new Map<string, Promise<Person | null>>();
  record: ((fresh?: boolean) => Promise<any>) | null = null;
  motorList: (() => Promise<{ name: string; content: string }[]>) | null = null;

  async ensureRoom(): Promise<Room> {
    if (!this.room) {
      const room = new Room(this.roomEnv());
      await room.start();
      // After an idle period the connections are still open, but who they are must be looked up again.
      await Promise.all(this.getConnections().map((conn: any) => room.client(conn).catch(() => null)));
      this.room = room;
    }
    return this.room;
  }

  // (Not named env: the Actor base class already has an env property.)
  roomEnv() {
    // Looked up when used: the session's client is only available inside handlers.
    const db = () => this.client.asServiceRole.entities;
    const designId = this.instanceId;
    // A lookup that fails throws (the room then keeps everyone's access as it was, and tries again).
    const design = (this.record ??= shared(RECORD_MS, () => db().Design.get(designId)));
    const roleIn = (d: any, user: Person) => {
      if (!d) return null;
      const same = (email: string) => String(email ?? "").toLowerCase() === user.email;
      const role = same(d.owner_email)
        ? "owner"
        : (d.members ?? []).find((m: any) => same(m.email))?.role;
      return role ? { role, name: d.name } : null;
    };
    const motors = (this.motorList ??= shared(MOTORS_MS, async () => {
      const d = await design().catch(() => null);
      if (!d) return [];
      const emails = [d.owner_email, ...(d.members ?? []).map((m: any) => m.email)];
      const lists = await Promise.all(emails.map((email: string) => db().Motor.filter({ owner_email: email })));
      return lists.flat().map((m: any) => ({ name: motorFileName(m), content: m.content }));
    }));
    return {
      storage: this.storage,
      connections: () => this.getConnections(),
      user: (conn: any): Promise<Person | null> => {
        if (conn.identity?.type !== "authenticated") return Promise.resolve(null);
        const id = String(conn.identity.userId);
        if (!this.people.has(id)) {
          const p = db().User.get(id).then(
            (u: any) => {
              if (!u?.email) return null;
              const email = String(u.email).toLowerCase();
              return { id, email, name: u.full_name || email.split("@")[0] };
            },
            () => null,
          );
          this.people.set(id, p);
          p.then((person) => { if (!person) this.people.delete(id); });
        }
        return this.people.get(id)!;
      },
      // From a record a moment old; before refusing someone, from a fresh one (they may just have
      // been added).
      access: async (user: Person, { fresh = false } = {}) =>
        roleIn(await design(), user) ?? (fresh ? roleIn(await design(true), user) : null),
      motors: () => motors(),
      touch: ({ version }: { version: number }) =>
        db().Design.update(designId, { version, edited_at: new Date().toISOString() }),
      preview: async (preview: string, { onlyIfMissing = false } = {}) => {
        if (onlyIfMissing) {
          const d = await design(true).catch(() => null);
          if (!d || d.preview != null) return false;
        }
        await db().Design.update(designId, { preview });
        return true;
      },
    };
  }

  async handleConnect(conn: any) {
    try {
      const room = await this.ensureRoom();
      const refused = await room.handleConnect(conn);
      if (refused) conn.reject(4003, refused);
    } catch (e) {
      console.error("DesignRoom connect failed", e);
      conn.reject(1011, "The design could not be opened.");
    }
  }

  async handleMessage(conn: any, msg: any) {
    const room = await this.ensureRoom();
    await room.handleMessage(conn, msg);
  }

  async handleClose(conn: any) {
    await this.room?.handleClose(conn);
  }

  handleTick() {}
}
