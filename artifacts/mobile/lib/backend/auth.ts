/**
 * Supabase Auth for DriveOS: email + password, Sign in with Apple and
 * Sign in with Google. Only the project URL and publishable key are used;
 * the session (access + refresh token) is persisted by the storage adapter
 * passed in — the device's secure keychain in the app.
 */
import { createClient, type AuthError, type Session, type SupabaseClient } from '@supabase/supabase-js';
import type { KeyValueStore } from './storage';
import { NetworkError } from './http';

export type { Session, SupabaseClient };

export const MIN_PASSWORD_LENGTH = 8;

export function createAuthClient(opts: { url: string; publishableKey: string; storage: KeyValueStore; fetchImpl?: typeof fetch }): SupabaseClient {
  return createClient(opts.url, opts.publishableKey, {
    auth: {
      storage: opts.storage,
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
      // Codes returned to the app (email links, Google) are exchanged with a
      // verifier kept on this device, so an intercepted link is useless.
      flowType: 'pkce',
    },
    ...(opts.fetchImpl ? { global: { fetch: opts.fetchImpl } } : {}),
  });
}

export class AuthFlowError extends Error {}

/** True when Supabase Auth couldn't be reached (offline), as opposed to a rejected session. */
export const isOfflineAuthError = (err: unknown): boolean =>
  !!err && (err as { name?: string }).name === 'AuthRetryableFetchError';

/**
 * The access token for API requests (refreshed by supabase-js when expired).
 * Returns null when signed out; throws NetworkError when the token needs a
 * refresh but the auth server can't be reached (offline, still signed in).
 */
export async function currentAccessToken(client: SupabaseClient): Promise<string | null> {
  const { data, error } = await client.auth.getSession();
  if (data.session) return data.session.access_token;
  if (isOfflineAuthError(error)) throw new NetworkError();
  return null;
}

/**
 * The user saved on this device, read without contacting the server. Used
 * when the app starts offline with an expired access token: supabase-js then
 * reports no session (it can't refresh), but the user hasn't signed out.
 */
export async function storedSessionUser(client: SupabaseClient, storage: KeyValueStore): Promise<{ id: string; email: string | null } | null> {
  const key = (client.auth as unknown as { storageKey?: string }).storageKey;
  if (!key) return null;
  try {
    const raw = await storage.getItem(key);
    const parsed = raw ? (JSON.parse(raw) as { user?: { id?: string; email?: string }; refresh_token?: string }) : null;
    if (!parsed?.user?.id || !parsed.refresh_token) return null;
    return { id: parsed.user.id, email: parsed.user.email ?? null };
  } catch {
    return null;
  }
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateCredentials(email: string, password: string, creating: boolean): string | null {
  if (!EMAIL.test(email.trim())) return 'Enter a valid email address.';
  if (creating && password.length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters for your password.`;
  if (!password) return 'Enter your password.';
  return null;
}

/** User-facing text for Supabase Auth errors. */
export function describeAuthError(err: unknown): string {
  const e = err as Partial<AuthError> & { message?: string };
  const code = (e.code ?? '').toString();
  const msg = (e.message ?? '').toLowerCase();
  if (code === 'invalid_credentials' || msg.includes('invalid login credentials')) return 'That email and password don\'t match an account.';
  if (code === 'email_not_confirmed' || msg.includes('email not confirmed')) return 'Confirm your email first — check your inbox for the link.';
  if (code === 'user_already_exists' || msg.includes('already registered')) return 'An account with this email already exists. Sign in instead.';
  if (code === 'weak_password' || msg.includes('password should')) return 'Choose a stronger password.';
  if (code === 'over_request_rate_limit' || code === 'over_email_send_rate_limit' || msg.includes('rate limit')) return 'Too many attempts. Wait a minute and try again.';
  if (msg.includes('network') || msg.includes('fetch')) return "Can't reach the sign-in service. Check your connection.";
  if (err instanceof AuthFlowError) return err.message;
  return e.message || 'Sign-in failed. Please try again.';
}

export async function signUpWithEmail(client: SupabaseClient, email: string, password: string, redirectTo: string, displayName?: string) {
  const { data, error } = await client.auth.signUp({
    email: email.trim(),
    password,
    options: { emailRedirectTo: redirectTo, ...(displayName ? { data: { display_name: displayName } } : {}) },
  });
  if (error) throw error;
  // With email confirmation on, there is no session until the link is opened.
  // Supabase also returns a user with no identities for an existing address.
  if (data.user && data.user.identities && data.user.identities.length === 0) {
    throw new AuthFlowError('An account with this email already exists. Sign in instead.');
  }
  return { session: data.session, needsConfirmation: !data.session, userId: data.user?.id ?? null };
}

export async function signInWithEmail(client: SupabaseClient, email: string, password: string) {
  const { data, error } = await client.auth.signInWithPassword({ email: email.trim(), password });
  if (error) throw error;
  return data.session;
}

export async function sendPasswordReset(client: SupabaseClient, email: string, redirectTo: string) {
  const { error } = await client.auth.resetPasswordForEmail(email.trim(), { redirectTo });
  if (error) throw error;
}

export async function updatePassword(client: SupabaseClient, password: string) {
  if (password.length < MIN_PASSWORD_LENGTH) throw new AuthFlowError(`Use at least ${MIN_PASSWORD_LENGTH} characters for your password.`);
  const { error } = await client.auth.updateUser({ password });
  if (error) throw error;
}

/** Native Sign in with Apple: the identity token is verified by Supabase. */
export async function signInWithAppleToken(client: SupabaseClient, identityToken: string, rawNonce: string) {
  const { data, error } = await client.auth.signInWithIdToken({ provider: 'apple', token: identityToken, nonce: rawNonce });
  if (error) throw error;
  return data.session;
}

/** Starts a browser-based OAuth sign-in (Google); returns the URL to open. */
export async function oauthUrl(client: SupabaseClient, provider: 'google' | 'apple', redirectTo: string): Promise<string> {
  const { data, error } = await client.auth.signInWithOAuth({
    provider,
    options: { redirectTo, skipBrowserRedirect: true, ...(provider === 'google' ? { queryParams: { prompt: 'select_account' } } : {}) },
  });
  if (error) throw error;
  if (!data.url) throw new AuthFlowError('Could not start sign-in.');
  return data.url;
}

/** Reads the parameters Supabase puts on a return link (query and fragment). */
export function parseAuthCallback(url: string): { code: string | null; error: string | null; type: string | null } {
  const params: Record<string, string> = {};
  const decode = (s: string) => {
    try { return decodeURIComponent(s.replace(/\+/g, ' ')); } catch { return s; }
  };
  const q = url.indexOf('?');
  const h = url.indexOf('#');
  const parts = [
    q >= 0 ? url.slice(q + 1, h > q ? h : undefined) : '',
    h >= 0 ? url.slice(h + 1) : '',
  ];
  for (const part of parts) {
    for (const pair of part.split('&')) {
      if (!pair) continue;
      const eq = pair.indexOf('=');
      const key = decode(eq >= 0 ? pair.slice(0, eq) : pair);
      params[key] = decode(eq >= 0 ? pair.slice(eq + 1) : '');
    }
  }
  return {
    code: params.code || null,
    error: params.error_description || params.error || null,
    type: params.type || null,
  };
}

/**
 * Completes a sign-in returned to the app by URL (Google, email
 * confirmation, password reset). Errors in the URL are reported.
 */
export async function completeFromUrl(client: SupabaseClient, url: string): Promise<Session | null> {
  const { code, error } = parseAuthCallback(url);
  if (error) throw new AuthFlowError(error);
  if (!code) return null;
  const { data, error: exchangeError } = await client.auth.exchangeCodeForSession(code);
  if (exchangeError) throw exchangeError;
  return data.session;
}
