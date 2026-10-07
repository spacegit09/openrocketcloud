// One OpenRocket container per (user, project), started on demand and stopped when idle.
import Docker from 'dockerode';
import net from 'node:net';
import { PassThrough } from 'node:stream';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { config } from './config.js';
import { publish } from './events.js';
import { setSessionLookup } from './collab.js';

const docker = new Docker();
const LABEL = 'orcloud.session';
const VNC_PORT = 5901;

const sessions = new Map(); // id -> session
const byKey = new Map(); // `${userId}|${projectId}` -> id
const byToken = new Map(); // bridge token -> id

setSessionLookup((token) => {
  const id = typeof token === 'string' ? byToken.get(token) : null;
  return id ? sessions.get(id) : null;
});

const alnum = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const vncPassword = () => Array.from({ length: 8 }, () => alnum[randomInt(alnum.length)]).join('');
const volumeFor = (userId) => `orcloud-home-${createHash('sha256').update(userId).digest('hex').slice(0, 20)}`;

export class CapacityError extends Error {}

function setState(s, state, detail) {
  s.state = state;
  publish(s.projectId, { type: 'session', id: s.id, state, detail }, s.user.id);
}

export function getSession(id) {
  return sessions.get(id) ?? null;
}

export function sessionFor(userId, projectId) {
  const id = byKey.get(`${userId}|${projectId}`);
  return id ? sessions.get(id) : null;
}

export function publicView(s) {
  return s && { id: s.id, state: s.state, vncPassword: s.vncPassword, role: s.role, startedAt: s.createdAt };
}

const clampInt = (v, min, max, fallback) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
};

export async function ensureSession(user, project, role, { width, height } = {}) {
  const existing = sessionFor(user.id, project.id);
  if (existing && existing.state !== 'ended') {
    existing.role = role;
    return existing;
  }
  const live = [...sessions.values()].filter((s) => s.state !== 'ended');
  if (live.length >= config.worker.maxSessions) {
    throw new CapacityError('The server is at capacity right now. Please try again in a few minutes.');
  }
  if (live.filter((s) => s.user.id === user.id).length >= config.worker.maxPerUser) {
    throw new CapacityError(`You can have at most ${config.worker.maxPerUser} designs open at once. Close one first.`);
  }
  const id = randomBytes(6).toString('hex');
  const s = {
    id,
    key: `${user.id}|${project.id}`,
    user,
    projectId: project.id,
    role,
    token: randomBytes(32).toString('hex'),
    vncPassword: vncPassword(),
    host: `orc-session-${id}`,
    container: null,
    state: 'starting',
    createdAt: Date.now(),
    lastSeen: Date.now(),
    viewers: 0,
  };
  s.clientConnected = () => {
    if (s.state === 'starting') setState(s, 'loading');
  };
  s.attached = () => setState(s, 'ready');
  sessions.set(id, s);
  byKey.set(s.key, id);
  byToken.set(s.token, id);
  publish(project.id, { type: 'session', id, state: 'starting' }, user.id);

  try {
    s.container = await docker.createContainer({
      name: s.host,
      Image: config.worker.image,
      Env: [
        `ORC_COLLAB_URL=${config.worker.collabUrl}`,
        `ORC_TOKEN=${s.token}`,
        `ORC_VNC_PASSWORD=${s.vncPassword}`,
        `ORC_WIDTH=${clampInt(width, 800, 3840, 1600)}`,
        `ORC_HEIGHT=${clampInt(height, 600, 2160, 900)}`,
        `ORC_WORKDIR=/home/rocketeer/Projects/${project.id}`,
        ...(process.env.DEBUG_OPS === 'true' ? ['ORC_DEBUG=1'] : []),
      ],
      Labels: { [LABEL]: id, 'orcloud.user': user.id, 'orcloud.project': project.id },
      HostConfig: {
        NetworkMode: config.worker.network,
        AutoRemove: true,
        Memory: config.worker.memoryMb * 1024 * 1024,
        NanoCpus: Math.round(config.worker.cpus * 1e9),
        PidsLimit: 512,
        ReadonlyRootfs: true,
        Tmpfs: { '/tmp': 'rw,nosuid,nodev,size=512m' },
        ShmSize: 256 * 1024 * 1024,
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges'],
        Mounts: [{ Type: 'volume', Source: volumeFor(user.id), Target: '/home/rocketeer' }],
      },
    });
    await s.container.start();
    console.log(`session ${id}: started for ${user.email} on project ${project.id}`);
  } catch (e) {
    console.error(`session ${id}: failed to start:`, e.message);
    end(s, 'OpenRocket could not be started.');
    throw e;
  }
  return s;
}

function end(s, detail) {
  if (s.state === 'ended') return;
  setState(s, 'ended', detail);
  sessions.delete(s.id);
  if (byKey.get(s.key) === s.id) byKey.delete(s.key);
  byToken.delete(s.token);
}

export async function stopSession(s, detail = 'The session was closed.') {
  if (!s) return;
  const container = s.container;
  end(s, detail);
  try {
    await container?.stop({ t: 10 });
  } catch {
    // already gone
  }
}

export async function stopProjectSessions(projectId, userId = null, detail) {
  await Promise.all([...sessions.values()]
    .filter((s) => s.projectId === projectId && (!userId || s.user.id === userId))
    .map((s) => stopSession(s, detail)));
}

export function setRole(projectId, userId, role) {
  for (const s of sessions.values()) if (s.projectId === projectId && s.user.id === userId) s.role = role;
}

/** Opens a TCP connection to the session's VNC server, retrying while it boots. */
export async function connectVnc(s, isCancelled) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline && !isCancelled() && s.state !== 'ended') {
    const sock = await new Promise((resolve) => {
      const c = net.connect(VNC_PORT, s.host);
      c.once('connect', () => resolve(c));
      c.once('error', () => resolve(null));
    });
    if (sock) return sock;
    await new Promise((r) => setTimeout(r, 400));
  }
  return null;
}

// ------------------------------------------------------------------ files saved inside OpenRocket

const workDir = (s) => `/home/rocketeer/Projects/${s.projectId}`;
const MAX_FILE = 200 * 1024 * 1024;

/** Files the user saved or exported from OpenRocket (its file dialogs start in this folder). */
export async function listFiles(s) {
  if (!s?.container || s.state === 'ended') return [];
  const exec = await s.container.exec({
    Cmd: ['find', workDir(s), '-maxdepth', '4', '-type', 'f', '-printf', '%P\t%s\t%T@\n'],
    AttachStdout: true,
    AttachStderr: true,
  });
  const stream = await exec.start({ hijack: true, stdin: false });
  const out = new PassThrough();
  const chunks = [];
  out.on('data', (c) => chunks.push(c));
  docker.modem.demuxStream(stream, out, new PassThrough());
  await new Promise((resolve) => stream.on('end', resolve));
  return Buffer.concat(chunks).toString('utf8').split('\n').filter(Boolean).map((line) => {
    const [name, size, mtime] = line.split('\t');
    return { name, size: Number(size), modified: Math.round(Number(mtime) * 1000) };
  }).sort((a, b) => b.modified - a.modified);
}

/** Reads one of those files (path relative to the folder). */
export async function readFile(s, rel) {
  if (!s?.container || typeof rel !== 'string' || !rel || rel.length > 1024
    || rel.startsWith('/') || rel.split('/').some((p) => p === '..' || p === '')) {
    return null;
  }
  const tar = await s.container.getArchive({ path: `${workDir(s)}/${rel}` });
  const chunks = [];
  let total = 0;
  for await (const c of tar) {
    total += c.length;
    if (total > MAX_FILE + 1024) throw new Error('file too large');
    chunks.push(c);
  }
  const buf = Buffer.concat(chunks);
  const size = parseInt(buf.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim(), 8);
  const type = String.fromCharCode(buf[156]);
  if (!Number.isFinite(size) || (type !== '0' && type !== '\0')) return null;
  return buf.subarray(512, 512 + size);
}

async function watchContainers() {
  try {
    const stream = await docker.getEvents({ filters: { label: [LABEL], type: ['container'], event: ['die'] } });
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        try {
          const ev = JSON.parse(line);
          const s = sessions.get(ev.Actor?.Attributes?.[LABEL]);
          if (s) {
            console.log(`session ${s.id}: container exited (${ev.Actor?.Attributes?.exitCode ?? '?'})`);
            end(s, 'OpenRocket was closed.');
          }
        } catch {
          // partial line
        }
      }
    });
    stream.on('end', () => setTimeout(watchContainers, 2000));
    stream.on('error', () => setTimeout(watchContainers, 2000));
  } catch (e) {
    console.error('Cannot watch Docker events:', e.message);
    setTimeout(watchContainers, 5000);
  }
}

function reapIdle() {
  const now = Date.now();
  for (const s of sessions.values()) {
    if (s.viewers > 0) s.lastSeen = now;
    if (now - s.lastSeen > config.worker.idleMinutes * 60_000) {
      console.log(`session ${s.id}: idle, stopping`);
      stopSession(s, 'Closed after being idle. Your work is saved.');
    } else if (now - s.createdAt > config.worker.maxHours * 3_600_000) {
      stopSession(s, 'Sessions are restarted every few hours. Your work is saved.');
    }
  }
}

export async function initSessions() {
  try {
    await docker.ping();
  } catch (e) {
    throw new Error(`Docker is not reachable (${e.message}). Mount /var/run/docker.sock into the server.`);
  }
  try {
    await docker.getImage(config.worker.image).inspect();
  } catch {
    console.warn(`Worker image "${config.worker.image}" not found. Build it with: docker compose build worker`);
  }
  // Containers left over from a previous run cannot be re-attached (their tokens are gone).
  const stale = await docker.listContainers({ all: true, filters: { label: [LABEL] } });
  await Promise.all(stale.map((c) => docker.getContainer(c.Id).remove({ force: true }).catch(() => {})));
  if (stale.length) console.log(`Removed ${stale.length} stale session container(s).`);
  watchContainers();
  setInterval(reapIdle, 30_000).unref();
}

export async function stopAll() {
  await Promise.all([...sessions.values()].map((s) => stopSession(s, 'The server is restarting. Your work is saved.')));
}
