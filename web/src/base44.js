// The Base44 client for this site, and sign-in helpers.
import { createClient, getAccessToken } from '@base44/sdk';

export const base44 = createClient({
  appId: import.meta.env.VITE_BASE44_APP_ID,
  token: getAccessToken(),
  functionsVersion: import.meta.env.VITE_BASE44_FUNCTIONS_VERSION,
  serverUrl: '',
  appBaseUrl: import.meta.env.VITE_BASE44_APP_BASE_URL,
});

/**
 * Calls one of the app's backend functions ('designs', 'motors', 'flights') and returns its result.
 * Designs, motors and saved launch plans are stored sealed, so these functions are the only way to
 * read or change them.
 */
export async function api(name, body) {
  try {
    return (await base44.functions.invoke(name, body)).data;
  } catch (e) {
    throw new Error(e.response?.data?.error ?? e.message);
  }
}

/** The signed-in person ({ id, email, full_name }), or null. */
export async function currentUser() {
  try {
    const u = await base44.auth.me();
    return u?.email ? { ...u, email: u.email.toLowerCase(), name: u.full_name || u.email.split('@')[0] } : null;
  } catch {
    return null;
  }
}

/** Signs in with Google, then comes back to `to` (this page by default). */
export function signIn(to = location.href) {
  const url = new URL(to, location.href);
  url.searchParams.delete('access_token');
  base44.auth.loginWithProvider('google', url.toString());
}

export const signOut = () => base44.auth.logout(new URL('/', location.href).toString());
