import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const env = process.env;
const list = (v) => (v ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const int = (v, d) => (v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);

const dataDir = env.DATA_DIR ?? join(import.meta.dirname, '../data');
mkdirSync(dataDir, { recursive: true });

function sessionSecret() {
  if (env.SESSION_SECRET) return env.SESSION_SECRET;
  const file = join(dataDir, 'session-secret');
  if (!existsSync(file)) writeFileSync(file, randomBytes(32).toString('hex'), { mode: 0o600 });
  return readFileSync(file, 'utf8').trim();
}

const publicUrl = (env.PUBLIC_URL ?? 'http://localhost:8080').replace(/\/$/, '');

export const config = {
  publicUrl,
  secureCookies: publicUrl.startsWith('https://'),
  port: int(env.PORT, 8080),
  internalPort: int(env.INTERNAL_PORT, 8081),
  dataDir,
  sessionSecret: sessionSecret(),
  google: {
    clientId: env.GOOGLE_CLIENT_ID ?? '',
    clientSecret: env.GOOGLE_CLIENT_SECRET ?? '',
  },
  // Empty = any verified Google account may sign in.
  allowedDomains: list(env.ALLOWED_EMAIL_DOMAINS),
  allowedEmails: list(env.ALLOWED_EMAILS),
  // Local testing without Google. Refused unless the site runs on localhost.
  devLogin: env.DEV_LOGIN === 'true' && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(publicUrl),
  // Optional Base44 front door (frontdoor/): people sign in on the Base44 site, which sends them
  // here with a short-lived pass signed with the shared secret.
  base44: {
    appUrl: (env.BASE44_APP_URL ?? '').replace(/\/$/, ''),
    secret: env.BASE44_SECRET ?? '',
  },
  worker: {
    image: env.WORKER_IMAGE ?? 'orcloud-worker',
    network: env.SESSION_NETWORK ?? 'orcloud-sessions',
    collabUrl: env.COLLAB_INTERNAL_URL ?? 'ws://orcloud-server:8081/collab',
    memoryMb: int(env.SESSION_MEMORY_MB, 1536),
    cpus: int(env.SESSION_CPUS, 2),
    idleMinutes: int(env.SESSION_IDLE_MINUTES, 15),
    maxHours: int(env.SESSION_MAX_HOURS, 12),
    maxSessions: int(env.MAX_SESSIONS, 20),
    maxPerUser: int(env.MAX_SESSIONS_PER_USER, 2),
  },
  maxUploadMb: int(env.MAX_UPLOAD_MB, 50),
  templatesDir: env.TEMPLATES_DIR ?? join(import.meta.dirname, '../templates'),
};
