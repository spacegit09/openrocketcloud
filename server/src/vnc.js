// Browser <-> OpenRocket display. noVNC speaks RFB over a WebSocket; this bridges it to the
// session container's VNC port after checking the signed-in user owns the session.
import { WebSocketServer } from 'ws';
import { config } from './config.js';
import { userFromRequest } from './auth.js';
import { getSession, connectVnc } from './sessions.js';

const HIGH_WATER = 8 * 1024 * 1024;

export function vncUpgradeHandler() {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 4 * 1024 * 1024,
    handleProtocols: (protocols) => (protocols.has('binary') ? 'binary' : false),
  });
  const pub = new URL(config.publicUrl);
  const origins = new Set([pub.origin]);
  if (config.devLogin) {
    // Local testing: localhost and 127.0.0.1 keep separate cookies, handy for two test users.
    origins.add(`http://localhost:${pub.port}`).add(`http://127.0.0.1:${pub.port}`);
  }

  return (req, socket, head) => {
    const match = /^\/vnc\/([0-9a-f]{12})$/.exec(new URL(req.url, 'http://x').pathname);
    if (!match) return false;
    const user = userFromRequest(req);
    const session = getSession(match[1]);
    const reject = (code, text) => {
      socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };
    if (req.headers.origin && !origins.has(req.headers.origin)) {
      reject(403, 'Forbidden');
    } else if (!user || !session || session.user.id !== user.id) {
      reject(401, 'Unauthorized');
    } else {
      wss.handleUpgrade(req, socket, head, (ws) => proxy(ws, session));
    }
    return true;
  };
}

async function proxy(ws, session) {
  session.viewers++;
  session.lastSeen = Date.now();
  let closed = false;
  let tcp = null;
  const early = [];
  ws.on('message', (data) => {
    session.lastSeen = Date.now();
    if (tcp) tcp.write(data);
    else early.push(data);
  });
  ws.on('close', () => {
    if (closed) return;
    closed = true;
    session.viewers--;
    session.lastSeen = Date.now();
    tcp?.destroy();
  });
  ws.on('error', () => ws.terminate());

  tcp = await connectVnc(session, () => closed);
  if (closed) return tcp?.destroy();
  if (!tcp) return ws.close(1011, 'OpenRocket did not start');
  tcp.setNoDelay(true);
  for (const d of early) tcp.write(d);
  tcp.on('data', (d) => {
    ws.send(d, { binary: true });
    if (ws.bufferedAmount > HIGH_WATER) {
      tcp.pause();
      const resume = () => (ws.bufferedAmount < HIGH_WATER / 4 || closed ? tcp.resume() : setTimeout(resume, 20));
      setTimeout(resume, 20);
    }
  });
  tcp.on('close', () => ws.readyState === 1 && ws.close(1000, 'display closed'));
  tcp.on('error', () => ws.readyState === 1 && ws.close(1011, 'display error'));
}
