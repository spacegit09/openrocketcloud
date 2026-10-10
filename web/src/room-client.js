// Connection from a page to a design's room: the DesignRoom Base44 actor, or for local tests the
// stand-in hub (web/test/hub.mjs, used when the page is opened from localhost with ?hub=ws://…).
// Adds what both pages need on top: large messages in fragments, requests with replies, and
// "open"/"closed" events (the actor greets every new or re-established connection with "hi").
import { base44 } from './base44.js';

const FRAG = 400_000;

/** The local test hub, if this page was opened for testing. */
export function testHub() {
  const params = new URLSearchParams(location.search);
  const local = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  return local && params.get('hub') ? { url: params.get('hub'), user: params.get('user') ?? 'a@test.local', name: params.get('name') } : null;
}

export class RoomClient {
  constructor(designId, { connectionId } = {}) {
    this.designId = designId;
    this.connectionId = connectionId ?? crypto.randomUUID();
    this.listeners = new Map(); // type -> Set<fn>; type '*' gets every message
    this.frags = new Map();
    this.pending = new Map(); // rid -> { resolve, reject, timer }
    this.queue = []; // sent before the connection was open
    this.open = false;
    this.closed = false;
    this.hi = null;
  }

  on(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
    return () => this.listeners.get(type).delete(fn);
  }

  emit(type, msg, text) {
    for (const fn of this.listeners.get(type) ?? []) fn(msg, text);
    if (type !== 'open' && type !== 'closed') for (const fn of this.listeners.get('*') ?? []) fn(msg, text);
  }

  connect() {
    const hub = testHub();
    if (hub) this.connectTestHub(hub);
    else this.connectActor();
    return this;
  }

  connectActor() {
    this.conn = base44.actors.DesignRoom(this.designId).connect({ id: this.connectionId });
    this.conn.subscribe((msg) => this.receive(msg));
    // The SDK reconnects by itself; watch its socket to know when the room is unreachable.
    this.conn.ws?.addEventListener?.('close', () => this.lost('connection lost'));
    this.transport = {
      sendText: (text) => this.conn.send(JSON.parse(text)),
      close: () => this.conn.close(),
      reconnect: () => this.conn.ws?.reconnect?.(),
    };
  }

  connectTestHub(hub) {
    const url = `${hub.url}/?design=${encodeURIComponent(this.designId)}&user=${encodeURIComponent(hub.user)}`
      + `&conn=${this.connectionId}${hub.name ? `&name=${encodeURIComponent(hub.name)}` : ''}`;
    const open = () => {
      const ws = new WebSocket(url);
      ws.onmessage = (ev) => this.receive(JSON.parse(ev.data), ev.data);
      ws.onclose = (ev) => {
        this.lost(ev.reason || 'connection lost');
        if (!this.closed && ev.code !== 4003) setTimeout(open, 1000);
      };
      this.ws = ws;
    };
    open();
    this.transport = {
      sendText: (text) => this.ws?.readyState === 1 && this.ws.send(text),
      close: () => this.ws?.close(),
      reconnect: () => this.ws?.close(),
    };
  }

  lost(reason) {
    if (!this.open) return;
    this.open = false;
    this.emit('closed', { reason });
  }

  receive(msg, text) {
    if (msg?.type === 'frag') {
      const parts = this.frags.get(msg.fid) ?? [];
      parts[msg.i] = msg.s;
      this.frags.set(msg.fid, parts);
      if (parts.filter((x) => x !== undefined).length < msg.n) return;
      this.frags.delete(msg.fid);
      const whole = parts.join('');
      return this.receive(JSON.parse(whole), whole);
    }
    if (msg?.type === 'hi') {
      this.hi = msg;
      this.open = true;
      const queued = this.queue.splice(0);
      for (const t of queued) this.sendText(t);
      this.emit('open', msg);
    }
    if (msg?.type === 'reply') {
      const p = this.pending.get(msg.rid);
      if (p) {
        this.pending.delete(msg.rid);
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg.data);
        else p.reject(new Error(msg.error));
      }
      return;
    }
    this.emit(msg?.type, msg, text);
  }

  /** Sends a message given as JSON text (from the OpenRocket bridge) or as an object. */
  send(msg) {
    this.sendText(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }

  sendText(text) {
    if (!this.open) {
      this.queue.push(text);
      return;
    }
    if (text.length <= FRAG) return this.transport.sendText(text);
    const fid = crypto.randomUUID();
    const n = Math.ceil(text.length / FRAG);
    for (let i = 0; i < n; i++) {
      this.transport.sendText(JSON.stringify({ type: 'frag', fid, i, n, s: text.slice(i * FRAG, (i + 1) * FRAG) }));
    }
  }

  /** A request to the room; resolves with its answer. */
  request(type, data = {}, timeoutMs = 60_000) {
    const rid = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(rid);
        reject(new Error('The design did not answer. Check your connection and try again.'));
      }, timeoutMs);
      this.pending.set(rid, { resolve, reject, timer });
      this.send({ type, rid, ...data });
    });
  }

  reconnect() {
    this.lost('resync');
    this.transport?.reconnect();
  }

  close() {
    this.closed = true;
    this.transport?.close();
  }
}

/** Opens a room just for one request (dashboard: download, history, saved copies). */
export async function withRoom(designId, fn) {
  const room = new RoomClient(designId).connect();
  try {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Could not reach the design. Check your connection and try again.')), 20_000);
      room.on('open', () => {
        clearTimeout(t);
        resolve();
      });
      room.on('kick', (m) => reject(new Error(m.message)));
    });
    return await fn(room);
  } finally {
    room.close();
  }
}
