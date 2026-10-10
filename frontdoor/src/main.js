// Rocket in Cloud front door, hosted on Base44: sign in with Google here, then go on to the OpenRocket
// server with a one-time pass from the `launch` function.
import { createClient, getAccessToken } from '@base44/sdk';
import './style.css';

const base44 = createClient({
  appId: import.meta.env.VITE_BASE44_APP_ID,
  token: getAccessToken(),
  functionsVersion: import.meta.env.VITE_BASE44_FUNCTIONS_VERSION,
  serverUrl: '',
  appBaseUrl: import.meta.env.VITE_BASE44_APP_BASE_URL,
});

const $ = (s) => document.querySelector(s);
const svg = (paths, size = 16) =>
  `<svg class="i" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const CHECK = '<path d="M20 6 9 17l-5-5"/>';

const ERRORS = {
  not_allowed: 'This Google account is not allowed to use Rocket in Cloud. Ask the administrator to add it.',
  signin_expired: 'The sign-in link expired. Please try again.',
  signin_failed: 'Sign-in failed. Please try again.',
  offline: 'Rocket in Cloud is offline right now: the computer that runs OpenRocket is switched off or asleep. Please try again later.',
  not_configured: 'Rocket in Cloud is not set up yet (the shared secret is missing).',
  failed: 'Something went wrong while opening Rocket in Cloud. Please try again.',
};

const params = new URLSearchParams(location.search);
const next = params.get('next') ?? '/';

function notice(text) {
  $('#notice').textContent = text;
  $('#notice').hidden = !text;
}
function status(text) {
  $('#status').textContent = text;
  $('#status').hidden = !text;
}

/** This page's address without one-off parameters, to come back to after Google sign-in. */
function returnUrl() {
  const u = new URL(location.href);
  for (const k of ['error', 'signout', 'access_token']) u.searchParams.delete(k);
  return u.toString();
}

async function launch() {
  $('#open').disabled = true;
  notice('');
  status('Opening Rocket in Cloud…');
  try {
    const { data } = await base44.functions.invoke('launch', { next });
    if (data?.url) return location.replace(data.url);
    if (data?.error === 'signin') return base44.auth.loginWithProvider('google', returnUrl());
    notice(ERRORS[data?.error] ?? ERRORS.failed);
  } catch {
    notice(ERRORS.failed);
  }
  status('');
  $('#open').disabled = false;
  $('#open').textContent = 'Try again';
  $('#open').hidden = false;
}

async function main() {
  $('#points').innerHTML = [
    'The official OpenRocket 24.12 with its unchanged physics engine and interface',
    "Everyone's edits appear instantly for everyone else",
    'Sign in with your Google account; upload and download .ork files any time',
  ].map((t) => `<li>${svg(CHECK)}<span>${t}</span></li>`).join('');
  $('#hero-art').innerHTML = `<svg viewBox="0 0 420 260" fill="none" font-family="system-ui" font-size="11">
    <rect x="1" y="1" width="418" height="258" rx="8" fill="var(--surface-2)" stroke="var(--border)"/>
    <rect x="1" y="1" width="418" height="22" rx="8" fill="var(--surface)"/>
    <circle cx="14" cy="12" r="4" fill="#ff5f57"/><circle cx="27" cy="12" r="4" fill="#febc2e"/><circle cx="40" cy="12" r="4" fill="#28c840"/>
    <rect x="12" y="34" width="120" height="214" rx="4" fill="var(--surface)" stroke="var(--border)"/>
    <g fill="var(--muted)"><text x="22" y="52">Rocket</text><text x="32" y="68">Sustainer</text><text x="42" y="84">Nose cone</text><text x="42" y="100">Body tube</text><text x="52" y="116">Fin set</text><text x="52" y="132">Parachute</text></g>
    <rect x="38" y="90" width="88" height="14" rx="3" fill="#1c7ed6" fill-opacity=".18" stroke="#1c7ed6"/>
    <rect x="48" y="106" width="78" height="14" rx="3" fill="#e8590c" fill-opacity=".18" stroke="#e8590c"/>
    <g transform="translate(150 70)" stroke="var(--text)" stroke-width="1.6">
      <path d="M0 40 C 30 20, 55 22, 70 24 L 230 24 L 230 56 L 70 56 C 55 58, 30 60, 0 40 Z" fill="var(--surface)"/>
      <path d="M70 24 V56 M160 24 V56"/>
      <path d="M190 24 L 222 2 L 238 2 L 230 24 M190 56 L 222 78 L 238 78 L 230 56" fill="var(--accent)" fill-opacity=".25"/>
    </g>
    <g font-weight="700" fill="#fff"><rect x="282" y="168" width="124" height="22" rx="11" fill="#1c7ed6"/><text x="294" y="183">Mina · Body tube</text>
    <rect x="238" y="200" width="168" height="22" rx="11" fill="#e8590c"/><text x="250" y="215">Joon edited Fin set</text></g>
  </svg>`;

  // Signing out of OpenRocket also signs out here, or this page would sign straight back in.
  if (params.has('signout')) return base44.auth.logout(new URL('/', location.href).toString());

  const user = await base44.auth.me().catch(() => null);
  if (!user) {
    if (params.get('error')) notice(ERRORS[params.get('error')] ?? ERRORS.signin_failed);
    $('#signin').hidden = false;
    $('#signin').onclick = () => base44.auth.loginWithProvider('google', returnUrl());
    return;
  }

  $('#me-name').textContent = user.full_name || user.email;
  $('#me').hidden = false;
  $('#signout').onclick = () => base44.auth.logout(new URL('/', location.href).toString());
  $('#open').onclick = launch;

  // After a problem on the OpenRocket side, wait for a click instead of looping back there.
  if (params.get('error')) {
    notice(ERRORS[params.get('error')] ?? ERRORS.signin_failed);
    $('#open').hidden = false;
    return;
  }
  launch();
}

main();
