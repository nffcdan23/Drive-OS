import { config } from "../config";
import { HttpError } from "./http";

/**
 * Server-side calls to Supabase Storage and Auth using the secret key.
 * The key is only ever sent to Supabase, never to clients.
 */
function adminHeaders(): Record<string, string> {
  const key = config.supabaseSecretKey;
  if (!key || !config.supabaseUrl) {
    throw new HttpError(503, "storage_not_configured", "File storage is not configured on the server.");
  }
  // New-style secret keys go only in `apikey`; legacy service_role JWTs also
  // go in Authorization.
  return key.startsWith("sb_") ? { apikey: key } : { apikey: key, Authorization: `Bearer ${key}` };
}

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${config.supabaseUrl}${path}`, {
    method,
    headers: { ...adminHeaders(), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: res.status, json };
}

const encodePath = (path: string) => path.split("/").map(encodeURIComponent).join("/");

/** One-time upload URL for exactly this object (expires after ~2 hours). */
export async function createSignedUploadUrl(bucket: string, path: string): Promise<{ url: string; token: string }> {
  const r = await call("POST", `/storage/v1/object/upload/sign/${bucket}/${encodePath(path)}`);
  const data = r.json as { url?: string; token?: string } | null;
  if (r.status >= 300 || !data?.url) throw new HttpError(502, "storage_error", "Could not prepare the upload.");
  const token = data.token ?? new URL(data.url, config.supabaseUrl!).searchParams.get("token") ?? "";
  return { url: `${config.supabaseUrl}/storage/v1${data.url}`, token };
}

/** Short-lived download URL for a private object. */
export async function createSignedDownloadUrl(bucket: string, path: string, expiresInSeconds: number): Promise<string> {
  const r = await call("POST", `/storage/v1/object/sign/${bucket}/${encodePath(path)}`, { expiresIn: expiresInSeconds });
  const data = r.json as { signedURL?: string; signedUrl?: string } | null;
  const signed = data?.signedURL ?? data?.signedUrl;
  if (r.status >= 300 || !signed) throw new HttpError(502, "storage_error", "Could not create a download link.");
  return `${config.supabaseUrl}/storage/v1${signed}`;
}

/** Public URL (public buckets only: avatars, community-media). */
export function publicUrl(bucket: string, path: string): string {
  return `${config.supabaseUrl}/storage/v1/object/public/${bucket}/${encodePath(path)}`;
}

/** Deletes objects; returns the number removed. */
export async function removeObjects(bucket: string, paths: string[]): Promise<number> {
  if (!paths.length) return 0;
  const r = await call("DELETE", `/storage/v1/object/${bucket}`, { prefixes: paths });
  if (r.status >= 300) throw new Error(`Storage delete failed (HTTP ${r.status})`);
  return Array.isArray(r.json) ? r.json.length : 0;
}

/** Deletes a user from Supabase Auth; their data cascades from auth.users. */
export async function deleteAuthUser(userId: string): Promise<void> {
  const r = await call("DELETE", `/auth/v1/admin/users/${userId}`);
  if (r.status === 404) return;
  if (r.status >= 300) throw new HttpError(502, "auth_error", "Could not delete the account.");
}
