// The DesignRoom actor: one session per design (session id = the Design record's room). The
// live-share logic is in room.js; this file connects it to Base44 (storage, connections, entities).
//
// The design's record is sealed (shared/sealed.js) and Base44 gives actors no app secrets, so the
// room reads only what it needs in the clear: who may open it, by user id and role (`access`,
// kept by the designs function), and it keeps the version and edit time. Browsers get the custom
// motor files and save the design's drawing through the designs function instead.
import { Actor } from "base44:runtime/actors";
import { Room } from "./room.js";

type Person = { id: string; email: string; name: string };

// Each lookup of the record takes a fraction of a second, so the room shares it: the design's
// record (who may open it) for everyone checking their access within a couple of seconds.
const RECORD_MS = 2_000;

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
  /** The Design record's own id (the session's id is its room). */
  recordId: string | null = null;

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
    const room = this.instanceId;
    // A lookup that fails throws (the room then keeps everyone's access as it was, and tries again).
    const design = (this.record ??= shared(RECORD_MS, async () => {
      const [r] = await db().Design.filter({ room });
      if (!r) return null;
      this.recordId = r.id;
      return r;
    }));
    // The design's name is sealed: the page shows it from the designs function.
    const accessOf = (r: any, user: Person) => {
      const role = (r?.access ?? []).find((a: any) => a.id === user.id)?.role;
      return role ? { role, name: null } : null;
    };
    const recordId = async () => this.recordId ?? (await design(true), this.recordId);
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
        accessOf(await design(), user) ?? (fresh ? accessOf(await design(true), user) : null),
      // Browsers get the motor files and keep the drawing through the designs function.
      motors: async () => [],
      touch: async ({ version }: { version: number }) => {
        const id = await recordId();
        if (id) await db().Design.update(id, { version, edited_at: new Date().toISOString() });
      },
      preview: async () => false,
    };
  }

  async handleConnect(conn: any) {
    try {
      const room = await this.ensureRoom();
      const refused = await room.handleConnect(conn);
      if (refused) conn.reject(4003, refused);
    } catch (e) {
      console.error("DesignRoom connect failed", e instanceof Error ? e.name : "error");
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
