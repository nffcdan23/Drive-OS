/**
 * Supabase Auth for DriveOS: email + password, Sign in with Apple and
 * Sign in with Google. Only the project URL and publishable key are used;
 * the session (access + refresh token) is persisted by the storage adapter
 * passed in — the device's secure keychain in the app.
 */
import { createClient, isAuthError, isAuthRetryableFetchError, type AuthError, type Session, type SupabaseClient } from '@supabase/supabase-js';
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
 * supabase-js remembers a failed refresh for a minute and replays it without
 * contacting the server, so after an offline start the app would stay
 * "offline" for up to a minute once the network is back. Clearing that
 * memory lets the next attempt go to the server. The field is internal to
 * @supabase/auth-js (pinned); the unit tests fail if it stops working.
 */
function forgetRefreshFailure(client: SupabaseClient): void {
  const auth = client.auth as unknown as { lastRefreshFailure?: unknown };
  if ('lastRefreshFailure' in auth) auth.lastRefreshFailure = null;
}

/**
 * `currentAccessToken` for the API client. When the token can't be refreshed
 * because the phone seemed offline, it checks (at most every few seconds)
 * whether Supabase Auth answers again and, if so, retries straight away.
 */
export function accessTokenGetter(
  client: SupabaseClient,
  authReachable: () => Promise<boolean>,
  opts: { minProbeIntervalMs?: number; now?: () => number } = {},
): () => Promise<string | null> {
  const minInterval = opts.minProbeIntervalMs ?? 5_000;
  const now = opts.now ?? Date.now;
  let lastProbe = -Infinity;
  return async () => {
    try {
      return await currentAccessToken(client);
    } catch (err) {
      if (!(err instanceof NetworkError) || now() - lastProbe < minInterval) throw err;
      lastProbe = now();
      if (!(await authReachable().catch(() => false))) throw err;
      forgetRefreshFailure(client);
      return currentAccessToken(client);
    }
  };
}

/** True when the Supabase Auth server answers at all (any HTTP status). */
export function authServerProbe(url: string, publishableKey: string, fetchImpl: typeof fetch = fetch): () => Promise<boolean> {
  return async () => {
    try {
      await fetchImpl(`${url.replace(/\/+$/, '')}/auth/v1/health`, { headers: { apikey: publishableKey } });
      return true;
    } catch {
      return false;
    }
  };
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

export type AuthFailureKind = 'offline' | 'service_unavailable' | 'rejected' | 'flow' | 'unknown';

export interface AuthFailure {
  kind: AuthFailureKind;
  /** HTTP status from Supabase Auth (0 when no response arrived). */
  status: number | null;
  /** Supabase error code (e.g. "user_already_exists"), when given. */
  code: string | null;
  /** Error class name (e.g. "AuthApiError", "AuthRetryableFetchError"). */
  name: string;
  message: string;
}

/**
 * Classifies a failure by the error's class and HTTP status, never by words
 * in its message: only "no response at all" is treated as a connection
 * problem. (Matching "fetch" in messages used to turn real server answers
 * into "Can't reach the sign-in service".)
 */
export function classifyAuthError(err: unknown): AuthFailure {
  const e = (err ?? {}) as { name?: string; message?: string; status?: number; code?: string };
  const status = typeof e.status === 'number' ? e.status : null;
  const code = typeof e.code === 'string' && e.code ? e.code : null;
  const name = e.name || (err instanceof Error ? err.constructor.name : typeof err);
  const message = typeof e.message === 'string' ? e.message : String(err);
  let kind: AuthFailureKind;
  if (err instanceof AuthFlowError) kind = 'flow';
  else if (isAuthRetryableFetchError(err)) kind = !status ? 'offline' : 'service_unavailable';
  else if (isAuthError(err) && status !== null && status >= 500) kind = 'service_unavailable';
  else if (isAuthError(err)) kind = 'rejected';
  else kind = 'unknown';
  return { kind, status, code, name, message };
}

const CODE_MESSAGES: Record<string, string> = {
  invalid_credentials: "That email and password don't match an account.",
  email_not_confirmed: 'Confirm your email first — check your inbox for the link.',
  user_already_exists: 'An account with this email already exists. Sign in instead.',
  email_exists: 'An account with this email already exists. Sign in instead.',
  weak_password: 'Choose a stronger password.',
  over_request_rate_limit: 'Too many attempts. Wait a minute and try again.',
  over_email_send_rate_limit: 'Too many emails sent. Wait a few minutes and try again.',
  signup_disabled: 'New accounts are not being accepted on this server right now.',
  email_provider_disabled: 'Email sign-in is turned off on this server.',
  provider_disabled: 'This sign-in method is turned off on this server.',
  email_address_invalid: "The sign-in service doesn't accept that email address. Try another one.",
  email_address_not_authorized: "The sign-in service can't send email to that address yet.",
  flow_state_not_found: 'That sign-in has expired or was started elsewhere. Please start again.',
  flow_state_expired: 'That sign-in has expired. Please start again.',
  bad_code_verifier: 'That sign-in was started on another device or app. Please start again here.',
  otp_expired: 'That link has expired. Request a new one.',
  same_password: 'Choose a password different from your current one.',
};

/** User-facing text for Supabase Auth errors: always the real reason. */
export function describeAuthError(err: unknown): string {
  const f = classifyAuthError(err);
  if (f.kind === 'flow') return f.message;
  if (f.kind === 'offline') return "Can't reach the sign-in service. Check your connection.";
  if (f.code && CODE_MESSAGES[f.code]) return CODE_MESSAGES[f.code]!;
  // Older servers answer without a code.
  const msg = f.message.toLowerCase();
  if (msg.includes('invalid login credentials')) return CODE_MESSAGES.invalid_credentials!;
  if (msg.includes('already registered')) return CODE_MESSAGES.user_already_exists!;
  if (msg.includes('email not confirmed')) return CODE_MESSAGES.email_not_confirmed!;
  const ref = [f.code, f.status ? `HTTP ${f.status}` : null].filter(Boolean).join(', ');
  if (f.kind === 'service_unavailable') {
    return `The sign-in service had a problem${ref ? ` (${ref})` : ''}: ${redact(f.message) || 'no details'}. Try again shortly.`;
  }
  return `Sign-in failed${ref ? ` (${ref})` : ''}: ${redact(f.message) || 'no details'}`;
}

// ─── Development diagnostics ────────────────────────────────────────────────

/** Removes anything sensitive from text: emails, tokens/keys, full URLs (kept as scheme://host). */
export function redact(text: string): string {
  return text
    .replace(/\b[A-Za-z][A-Za-z0-9+.-]*:\/\/([^\s/?#]*)[^\s]*/g, (_m, host) => `${_m.split(':')[0]}://${host}`)
    .replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, '<email>')
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, '<token>')
    .replace(/\b(sb_[a-z]+_)[\w-]+/g, '$1<redacted>')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '<redacted>')
    .slice(0, 300);
}

/** "exp://192.168.1.20:8081" or "driveos-staging://auth" — scheme and host only, never the path or query. */
export function describeRedirect(uri: string): string {
  const m = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)/.exec(uri);
  return m ? `${m[1]}://${m[2]}` : '(not a URL)';
}

type DiagSink = (line: string) => void;
let diagSink: DiagSink | null = null;
/** Development builds set a sink (console); nothing is logged otherwise. */
export function setAuthDiagnostics(sink: DiagSink | null) { diagSink = sink; }

/**
 * Logs an auth step for development: operation, outcome, HTTP status, error
 * code, class and a redacted message; for redirects, only scheme and host.
 * Never tokens, passwords, keys, emails or full auth URLs.
 */
export function authDiag(operation: string, detail: { error?: unknown; redirect?: string; outcome?: string } = {}) {
  if (!diagSink) return;
  const parts = [`[auth] ${operation}`];
  if (detail.outcome) parts.push(`outcome=${detail.outcome}`);
  if (detail.redirect) parts.push(`redirect=${describeRedirect(detail.redirect)}`);
  if (detail.error !== undefined) {
    const f = classifyAuthError(detail.error);
    parts.push(`kind=${f.kind}`, `status=${f.status ?? '-'}`, `code=${f.code ?? '-'}`, `class=${f.name}`, `message="${redact(f.message)}"`);
  }
  diagSink(parts.join(' '));
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
  // The same return link can arrive twice (the auth browser's result and the
  // app's link listener). A code can only be exchanged once, so the second
  // attempt shares the first one's result instead of failing.
  const pending = exchanges.get(code);
  if (pending) return pending;
  const run = (async () => {
    const { data, error: exchangeError } = await client.auth.exchangeCodeForSession(code);
    if (exchangeError) throw exchangeError;
    return data.session;
  })();
  exchanges.set(code, run);
  if (exchanges.size > 20) exchanges.delete(exchanges.keys().next().value!);
  return run;
}

const exchanges = new Map<string, Promise<Session | null>>();
