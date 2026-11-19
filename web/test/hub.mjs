// Local stand-in for the DesignRoom Base44 actor, for tests: runs the same room.js behind a plain
// WebSocket server, with in-memory storage and a made-up design list.
//   ws://localhost:PORT/?design=ID&user=EMAIL&name=NAME&conn=CONNECTION-ID
// The design page uses it when opened from localhost with ?hub=ws://localhost:PORT.
import { WebSocketServer } from 'ws';
import { Room } from '../base44/actors/DesignRoom/room.js';

// motors: the custom motor files ([{ name, content }]) every session of every design gets, or
// (designId, email) => such a list, for one person's session to have motors another's lacks
// (email: whoever said hello last; the room asks for a welcome's motors right after the hello).
// delay: milliseconds the room takes to answer an edit or request, as on the live site (the actor
// writes the edit to its storage before it shares it; 0: at once). Messages keep their order.
export function startHub({ port = 8788, designs = new Map(), motors = [], delay = 0 } = {}) {
  const sessions = new Map(); // design id -> { room, conns }

  function session(designId) {
    let s = sessions.get(designId);
    if (s) return s;
    const store = new Map();
    const conns = new Set();
    const room = new Room({
      storage: {
        get: async (k) => (store.has(k) ? structuredClone(store.get(k)) : undefined),
        put: async (k, v) => void store.set(k, structuredClone(v)),
        delete: async (k) => store.delete(k),
        deleteAll: async () => store.clear(),
      },
      connections: () => [...conns],
      user: async (conn) => conn.user,
      access: async (user) => {
        const d = designs.get(designId);
        if (!d) return null;
        const role = d.owner === user.email ? 'owner' : d.members?.[user.email];
        // d.locked: people without a plan (web/base44/shared/billing.js).
        return role ? { role, name: d.name, locked: Boolean(d.locked?.includes(user.email)) } : null;
      },
      motors: async () => (typeof motors === 'function' ? motors(designId, sessions.get(designId)?.helloFrom) : motors),
      touch: async () => {},
      preview: async (preview, { onlyIfMissing = false } = {}) => {
        const d = designs.get(designId);
        if (!d || (onlyIfMissing && d.preview != null)) return false;
        d.preview = preview;
        return true;
      },
    });
    s = { room, conns, store, started: room.start() };
    sessions.set(designId, s);
    return s;
  }

  const wss = new WebSocketServer({ port, maxPayload: 64 * 1024 * 1024 });
  wss.on('connection', async (ws, req) => {
    const url = new URL(req.url, 'http://localhost');
    const designId = url.searchParams.get('design');
    const email = (url.searchParams.get('user') ?? '').toLowerCase();
    const s = session(designId);
    await s.started;
    let due = 0;
    const conn = {
      id: url.searchParams.get('conn') ?? crypto.randomUUID(),
      user: email ? { id: `local:${email}`, email, name: url.searchParams.get('name') ?? email.split('@')[0] } : null,
      send: (m) => {
        const text = JSON.stringify(m);
        if (!delay) return ws.readyState === 1 && ws.send(text);
        // `delay` ms later, in order.
        due = Math.max(Date.now() + delay, due);
        setTimeout(() => ws.readyState === 1 && ws.send(text), due - Date.now());
        return true;
      },
    };
    // A reconnect with the same id replaces the old socket, as in Base44.
    for (const c of s.conns) if (c.id === conn.id) s.conns.delete(c);
    s.conns.add(conn);
    const pending = [];
    let ready = false;
    ws.on('message', async (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString('utf8'));
      } catch {
        return;
      }
      if (msg?.type === '__ping') return void ws.send('{"type":"__pong"}');
      if (!ready) return void pending.push(msg);
      if (msg?.type === 'hello') s.helloFrom = conn.user?.email;
      await s.room.handleMessage(conn, msg);
    });
    ws.on('close', () => {
      if (!s.conns.has(conn)) return;
      s.conns.delete(conn);
      s.room.handleClose(conn);
    });
    const refused = await s.room.handleConnect(conn);
    if (refused) {
      s.conns.delete(conn);
      return ws.close(4003, refused);
    }
    ready = true;
    for (const m of pending) {
      if (m?.type === 'hello') s.helloFrom = conn.user?.email;
      await s.room.handleMessage(conn, m);
    }
  });
  return {
    port,
    designs,
    sessions,
    close: () => {
      for (const ws of wss.clients) ws.terminate();
      return new Promise((r) => wss.close(r));
    },
    /** Drops every connection, as a network hiccup would (the pages reconnect by themselves). */
    drop: () => {
      for (const ws of wss.clients) ws.terminate();
    },
  };
}

// Run directly: node test/hub.mjs [port] — one open design "demo" owned by a@test.local,
// shared with b@test.local (editor) and v@test.local (viewer).
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.argv[2] ?? 8788);
  const designs = new Map([['demo', { name: 'Demo rocket', owner: 'a@test.local', members: { 'b@test.local': 'editor', 'v@test.local': 'viewer' } }]]);
  startHub({ port, designs });
  console.log(`Local design hub on ws://localhost:${port}`);
}
