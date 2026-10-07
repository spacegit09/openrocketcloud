import http from 'node:http';
import { join } from 'node:path';
import express from 'express';
import { config } from './config.js';
import { authRouter } from './auth.js';
import { apiRouter } from './api.js';
import { attachCollab, persistAll } from './collab.js';
import { initSessions, stopAll } from './sessions.js';
import { vncUpgradeHandler } from './vnc.js';

await initSessions();

// ---- public site: pages, API, sign-in and the VNC proxy
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 'loopback, uniquelocal');
app.use((req, res, next) => {
  res.set('x-content-type-options', 'nosniff');
  res.set('referrer-policy', 'same-origin');
  res.set('x-frame-options', 'DENY');
  next();
});
app.get('/healthz', (req, res) => res.json({ ok: true }));
app.use('/auth', authRouter());
app.use('/api', apiRouter());
const pub = join(import.meta.dirname, '../public');
app.use('/novnc', express.static(join(import.meta.dirname, '../node_modules/@novnc/novnc'), { maxAge: '1d' }));
app.use(express.static(pub, { extensions: ['html'], maxAge: 0 }));
app.get('/p/:id', (req, res) => res.sendFile(join(pub, 'session.html')));

const server = http.createServer(app);
const vnc = vncUpgradeHandler();
server.on('upgrade', (req, socket, head) => {
  if (!vnc(req, socket, head)) socket.destroy();
});
server.listen(config.port, () => console.log(`OpenRocket Cloud on ${config.publicUrl} (port ${config.port})`));

// ---- internal: live-share connections from session containers only (not published)
const internal = http.createServer((req, res) => res.writeHead(404).end());
attachCollab(internal);
internal.listen(config.internalPort, () => console.log(`Live-share hub on internal port ${config.internalPort}`));

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`${signal}: saving designs and stopping sessions`);
  await stopAll();
  await new Promise((r) => setTimeout(r, 3000)); // let bridges flush final edits
  persistAll();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
