/**
 * HTTP client for the DriveOS API. Every request carries the signed-in
 * user's Supabase access token. Failures are classified, never swallowed:
 *
 *   NetworkError     the API could not be reached (offline, DNS, timeout)
 *   ApiError 5xx     the API is up but failing
 *   ApiError 4xx     the request was rejected (validation, not found, …)
 *   AuthRequiredError the session is gone or was revoked
 *
 * Each outcome is reported to `onStatus`, which drives the visible
 * connection indicator in the app.
 */
export type ConnectionState = 'online' | 'offline' | 'server_error' | 'signed_out';

export class NetworkError extends Error {
  constructor(message = 'Could not reach the server.') { super(message); }
}

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
  get isServerError() { return this.status >= 500; }
}

export class AuthRequiredError extends Error {
  constructor() { super('Your session has ended. Please sign in again.'); }
}

export interface ApiClientOptions {
  baseUrl: string;
  /** Current access token, or null when signed out. */
  getAccessToken: () => Promise<string | null>;
  /** Refreshes the session once after a 401; returns the new token or null. */
  refreshAccessToken: () => Promise<string | null>;
  onStatus?: (state: ConnectionState, detail?: string) => void;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class ApiClient {
  constructor(private readonly opts: ApiClientOptions) {}

  get baseUrl() { return this.opts.baseUrl; }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let token: string | null;
    try {
      token = await this.opts.getAccessToken();
    } catch (err) {
      // The session couldn't be refreshed because the auth server is unreachable.
      if (err instanceof NetworkError) this.opts.onStatus?.('offline');
      throw err;
    }
    if (!token) {
      this.opts.onStatus?.('signed_out');
      throw new AuthRequiredError();
    }
    let res = await this.send(method, path, body, token);
    if (res.status === 401) {
      const fresh = await this.opts.refreshAccessToken().catch(() => null);
      if (!fresh) {
        this.opts.onStatus?.('signed_out');
        throw new AuthRequiredError();
      }
      res = await this.send(method, path, body, fresh);
      if (res.status === 401) {
        this.opts.onStatus?.('signed_out');
        throw new AuthRequiredError();
      }
    }
    const text = await res.text();
    let json: unknown = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    if (res.status >= 500) {
      const err = errorFrom(res.status, json, 'The server had a problem. Try again shortly.');
      this.opts.onStatus?.('server_error', err.message);
      throw err;
    }
    this.opts.onStatus?.('online');
    if (res.status >= 400) throw errorFrom(res.status, json, 'The request was rejected.');
    return json as T;
  }

  get<T>(path: string) { return this.request<T>('GET', path); }
  post<T>(path: string, body: unknown = {}) { return this.request<T>('POST', path, body); }
  put<T>(path: string, body: unknown) { return this.request<T>('PUT', path, body); }
  patch<T>(path: string, body: unknown) { return this.request<T>('PATCH', path, body); }
  delete<T = void>(path: string, body?: unknown) { return this.request<T>('DELETE', path, body); }

  /** Checks the API is reachable without needing a session. */
  async ping(): Promise<boolean> {
    try {
      const res = await this.fetchWithTimeout(`${this.opts.baseUrl}/api/healthz`, { method: 'GET' });
      const ok = res.ok;
      this.opts.onStatus?.(ok ? 'online' : 'server_error');
      return ok;
    } catch {
      this.opts.onStatus?.('offline');
      return false;
    }
  }

  private async send(method: string, path: string, body: unknown, token: string): Promise<Response> {
    try {
      return await this.fetchWithTimeout(`${this.opts.baseUrl}/api${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      this.opts.onStatus?.('offline');
      throw new NetworkError();
    }
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const f = this.opts.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 20_000);
    try {
      return await f(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }
}

function errorFrom(status: number, json: unknown, fallback: string): ApiError {
  const body = (json ?? {}) as { error?: string; message?: string };
  return new ApiError(status, body.error ?? `http_${status}`, body.message ?? fallback);
}

/** A short, user-facing description of any error. */
export function describeError(err: unknown): string {
  if (err instanceof NetworkError) return "You're offline or the server can't be reached.";
  if (err instanceof AuthRequiredError) return err.message;
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error && err.message) return err.message;
  return 'Something went wrong.';
}

/** True when retrying later could succeed (offline or a server fault). */
export const isRetryable = (err: unknown) =>
  err instanceof NetworkError || (err instanceof ApiError && (err.isServerError || err.status === 429));
