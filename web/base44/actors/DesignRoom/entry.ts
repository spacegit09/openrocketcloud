// The DesignRoom actor: one session per design (session id = Design record id). The live-share
// logic is in room.js; this file connects it to Base44 (storage, connections, entities).
import { Actor } from "base44:runtime/actors";
import { Room } from "./room.js";

type Person = { id: string; email: string; name: string };

const motorFileName = (m: { id: string; filename: string }) =>
  `${m.id.slice(0, 8)}-${m.filename.replace(/[^A-Za-z0-9._-]/g, "_")}`;

export default class DesignRoom extends Actor {
  room: Room | null = null;
  people = new Map<string, Person>();

  async ensureRoom(): Promise<Room> {
    if (!this.room) {
      const room = new Room(this.roomEnv());
      await room.start();
      // After an idle period the connections are still open, but who they are must be looked up again.
      for (const conn of this.getConnections()) await room.client(conn).catch(() => null);
      this.room = room;
    }
    return this.room;
  }

  // (Not named env: the Actor base class already has an env property.)
  roomEnv() {
    // Looked up when used: the session's client is only available inside handlers.
    const db = () => this.client.asServiceRole.entities;
    const designId = this.instanceId;
    const design = () => db().Design.get(designId).catch(() => null);
    return {
      storage: this.storage,
      connections: () => this.getConnections(),
      user: async (conn: any): Promise<Person | null> => {
        if (conn.identity?.type !== "authenticated") return null;
        const id = String(conn.identity.userId);
        if (!this.people.has(id)) {
          const u = await db().User.get(id).catch(() => null);
          if (!u?.email) return null;
          const email = String(u.email).toLowerCase();
          this.people.set(id, { id, email, name: u.full_name || email.split("@")[0] });
        }
        return this.people.get(id)!;
      },
      access: async (user: Person) => {
        const d = await design();
        if (!d) return null;
        const same = (email: string) => String(email ?? "").toLowerCase() === user.email;
        const role = same(d.owner_email)
          ? "owner"
          : (d.members ?? []).find((m: any) => same(m.email))?.role;
        return role ? { role, name: d.name } : null;
      },
      motors: async () => {
        const d = await design();
        if (!d) return [];
        const emails = [d.owner_email, ...(d.members ?? []).map((m: any) => m.email)];
        const out = [];
        for (const email of emails) {
          for (const m of await db().Motor.filter({ owner_email: email })) {
            out.push({ name: motorFileName(m), content: m.content });
          }
        }
        return out;
      },
      touch: ({ version }: { version: number }) =>
        db().Design.update(designId, { version, edited_at: new Date().toISOString() }),
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
