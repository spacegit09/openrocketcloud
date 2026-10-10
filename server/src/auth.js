// Google sign-in (OAuth 2.0 authorization code flow with PKCE), sign-in through the optional
// Base44 front door, and signed session cookies.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import express from 'express';
import { config } from './config.js';
import { users } from './db.js';

const SESSION_COOKIE = 'orc_session';
const OAUTH_COOKIE = 'orc_oauth';
const SESSION_DAYS = 30;

const b64url = (buf) => Buffer.from(buf).toString('base64url');

function sign(payload) {
  const body = b64url(JSON.stringify(payload));
  const mac = createHmac('sha256', config.sessionSecret).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function verify(token) {
  if (typeof token !== 'string') return null;
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;
  const expected = createHmac('sha256', config.sessionSecret).update(body).digest();
  const given = Buffer.from(mac, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return payload.e > Date.now() ? payload : null;
  } catch {
    return null;
  }
}

export function parseCookies(header) {
  const out = {};
  for (const part of (header ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at > 0) out[part.slice(0, at).trim()] = decodeURIComponent(part.slice(at + 1).trim());
  }
  return out;
}

function cookie(name, value, { maxAge, path = '/' } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`, 'HttpOnly', 'SameSite=Lax'];
  if (config.secureCookies) parts.push('Secure');
  if (maxAge != null) parts.push(`Max-Age=${Math.floor(maxAge / 1000)}`);
  return parts.join('; ');
}

/** The signed-in user for a request (HTTP or WebSocket upgrade), or null. */
export function userFromRequest(req) {
  const session = verify(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
  return session ? users.get(session.u) ?? null : null;
}

export function requireUser(req, res, next) {
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ error: 'Please sign in.' });
  req.user = user;
  next();
}

/** State-changing API calls must carry this header, which cross-site forms cannot set. */
export function requireAppHeader(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.get('x-orcloud') === '1') return next();
  res.status(403).json({ error: 'Missing request header.' });
}

function emailAllowed(email) {
  const e = email.toLowerCase();
  if (!config.allowedDomains.length && !config.allowedEmails.length) return true;
  return config.allowedEmails.includes(e) || config.allowedDomains.includes(e.split('@')[1]);
}

function startSession(res, user) {
  res.append('Set-Cookie', cookie(SESSION_COOKIE, sign({ u: user.id, e: Date.now() + SESSION_DAYS * 864e5 }), {
    maxAge: SESSION_DAYS * 864e5,
  }));
}

const safeReturn = (r) => (typeof r === 'string' && /^\/(?![/\\])/.test(r) ? r : '/');

// ---- Base44 front door (frontdoor/). The Base44 site signs people in with Google and sends them
// to /auth/base44 with a one-time pass: base64url(JSON) + "." + HMAC-SHA256(secret, "pass." + body).
const frontDoor = config.base44.appUrl && config.base44.secret ? config.base44.appUrl : '';
const usedPasses = new Map(); // nonce -> expiry, so each pass works once

const base44Mac = (kind, body) => createHmac('sha256', config.base44.secret).update(`${kind}.${body}`).digest();

function verifyPass(pass) {
  if (typeof pass !== 'string') return null;
  const [body, mac] = pass.split('.');
  if (!body || !mac) return null;
  const expected = base44Mac('pass', body);
  const given = Buffer.from(mac, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let p;
  try {
    p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  const now = Date.now();
  if (!(p.exp > now) || p.exp - now > 5 * 60e3) return null;
  if (typeof p.n !== 'string' || typeof p.sub !== 'string' || !/^[^@\s]+@[^@\s]+$/.test(p.email ?? '')) return null;
  for (const [n, exp] of usedPasses) if (exp <= now) usedPasses.delete(n);
  if (usedPasses.has(p.n)) return null;
  usedPasses.set(p.n, p.exp);
  return p;
}

/** Tells the Base44 front door where this server is (PUBLIC_URL): at start and every few hours. */
export function registerWithFrontDoor() {
  if (!frontDoor) return;
  const send = async (attempt = 0) => {
    const url = config.publicUrl;
    const ts = Date.now();
    try {
      const res = await fetch(`${frontDoor}/functions/registerEngine`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url, ts, sig: base44Mac('engine', `${url}.${ts}`).toString('base64url') }),
        signal: AbortSignal.timeout(30e3),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 200)}`);
      console.log(`Front door ${frontDoor} now sends people to ${url}`);
    } catch (e) {
      console.error(`Could not register with the front door ${frontDoor}: ${e.message}`);
      if (attempt < 10) setTimeout(() => send(attempt + 1), Math.min(15e3 * 2 ** attempt, 30 * 60e3)).unref();
    }
  };
  send();
  setInterval(() => send(), 6 * 3600e3).unref();
}

export function authRouter() {
  const router = express.Router();
  const redirectUri = `${config.publicUrl}/auth/google/callback`;

  router.get('/config', (req, res) => {
    res.json({ google: Boolean(config.google.clientId), devLogin: config.devLogin, frontDoor: frontDoor || null });
  });

  // Where "Sign in" goes: the Base44 front door when there is one, otherwise Google directly.
  router.get('/login', (req, res) => {
    const ret = safeReturn(req.query.return);
    if (frontDoor) return res.redirect(`${frontDoor}/?next=${encodeURIComponent(ret)}`);
    res.redirect(`/auth/google?return=${encodeURIComponent(ret)}`);
  });

  router.get('/base44', (req, res) => {
    if (!frontDoor) return res.status(404).send('Base44 sign-in is not configured (BASE44_APP_URL, BASE44_SECRET).');
    const pass = verifyPass(req.query.pass);
    if (!pass) return res.redirect(`${frontDoor}/?error=signin_expired`);
    if (!emailAllowed(pass.email)) return res.redirect(`${frontDoor}/?error=not_allowed`);
    const user = users.upsert({ id: `base44:${pass.sub}`, email: pass.email, name: pass.name || pass.email.split('@')[0] });
    startSession(res, user);
    res.redirect(safeReturn(pass.next));
  });

  router.get('/google', (req, res) => {
    if (!config.google.clientId) return res.status(500).send('Google sign-in is not configured (GOOGLE_CLIENT_ID).');
    const state = b64url(randomBytes(24));
    const verifier = b64url(randomBytes(48));
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    res.append('Set-Cookie', cookie(OAUTH_COOKIE, sign({ s: state, v: verifier, r: safeReturn(req.query.return), e: Date.now() + 600e3 }), {
      maxAge: 600e3,
      path: '/auth',
    }));
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({
      client_id: config.google.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      prompt: 'select_account',
    }).toString();
    res.redirect(url.toString());
  });

  router.get('/google/callback', async (req, res) => {
    const pending = verify(parseCookies(req.headers.cookie)[OAUTH_COOKIE]);
    res.append('Set-Cookie', cookie(OAUTH_COOKIE, '', { maxAge: 0, path: '/auth' }));
    if (req.query.error) return res.redirect(`/?error=${encodeURIComponent(String(req.query.error))}`);
    if (!pending || pending.s !== req.query.state || typeof req.query.code !== 'string') {
      return res.redirect('/?error=signin_expired');
    }
    try {
      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code: req.query.code,
          client_id: config.google.clientId,
          client_secret: config.google.clientSecret,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
          code_verifier: pending.v,
        }),
      });
      const tokens = await tokenRes.json();
      if (!tokenRes.ok || !tokens.access_token) throw new Error(tokens.error_description ?? tokens.error ?? 'token exchange failed');
      const infoRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
        headers: { authorization: `Bearer ${tokens.access_token}` },
      });
      const info = await infoRes.json();
      if (!infoRes.ok || !info.sub || !info.email) throw new Error('could not read Google profile');
      if (!info.email_verified) return res.redirect('/?error=email_not_verified');
      if (!emailAllowed(info.email)) return res.redirect('/?error=not_allowed');
      const user = users.upsert({ id: `google:${info.sub}`, email: info.email, name: info.name || info.email, picture: info.picture });
      startSession(res, user);
      res.redirect(pending.r);
    } catch (e) {
      console.error('Google sign-in failed:', e.message);
      res.redirect('/?error=signin_failed');
    }
  });

  router.post('/logout', (req, res) => {
    res.append('Set-Cookie', cookie(SESSION_COOKIE, '', { maxAge: 0 }));
    // With a front door, sign out there too, or it would sign the person straight back in.
    res.json({ ok: true, next: frontDoor ? `${frontDoor}/?signout=1` : '/' });
  });

  if (config.devLogin) {
    console.warn('\n  DEV_LOGIN is enabled: anyone can sign in as any email at /auth/dev. Local testing only.\n');
    router.get('/dev', (req, res) => {
      const email = String(req.query.email ?? '').trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+$/.test(email)) return res.status(400).send('?email=someone@example.com');
      const user = users.upsert({ id: `dev:${email}`, email, name: String(req.query.name ?? email.split('@')[0]) });
      startSession(res, user);
      res.redirect(safeReturn(req.query.return));
    });
  }

  return router;
}
