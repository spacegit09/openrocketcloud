// The Base44 client for this site, and sign-in helpers.
import { createClient, getAccessToken } from '@base44/sdk';

export const base44 = createClient({
  appId: import.meta.env.VITE_BASE44_APP_ID,
  token: getAccessToken(),
  functionsVersion: import.meta.env.VITE_BASE44_FUNCTIONS_VERSION,
  serverUrl: '',
  appBaseUrl: import.meta.env.VITE_BASE44_APP_BASE_URL,
});

export const db = base44.entities;

/** The signed-in person ({ id, email, full_name }), or null. */
export async function currentUser() {
  try {
    const u = await base44.auth.me();
    return u?.email ? { ...u, email: u.email.toLowerCase(), name: u.full_name || u.email.split('@')[0] } : null;
  } catch {
    return null;
  }
}

export function signIn() {
  const url = new URL(location.href);
  url.searchParams.delete('access_token');
  base44.auth.loginWithProvider('google', url.toString());
}

export const signOut = () => base44.auth.logout(new URL('/', location.href).toString());
