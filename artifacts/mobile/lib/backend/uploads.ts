/**
 * Photo uploads go straight to Supabase Storage through a one-time signed
 * URL issued by the API (the API picks the path inside the user's own
 * folder and checks ownership and size limits). The API then confirms the
 * stored object's real size and type before the photo is used.
 */
import type { Endpoints, ServerVehicle } from './endpoints';
import { ApiError, NetworkError } from './http';

export interface PreparedFile {
  /** Anything fetch accepts as a body (Blob in the app, Uint8Array in tests). */
  body: BodyInit;
  size: number;
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
}

export interface UploadDeps {
  ep: Endpoints;
  publishableKey: string;
  fetchImpl?: typeof fetch;
}

async function putToSignedUrl(deps: UploadDeps, url: string, file: PreparedFile): Promise<void> {
  const f = deps.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await f(url, {
      method: 'PUT',
      headers: { apikey: deps.publishableKey, 'Content-Type': file.mimeType, 'x-upsert': 'false' },
      body: file.body,
    });
  } catch {
    throw new NetworkError('The photo could not be uploaded. Check your connection.');
  }
  if (!res.ok) throw new ApiError(res.status, 'upload_failed', `The photo upload failed (HTTP ${res.status}).`);
}

/** Uploads a vehicle photo and makes it the vehicle's cover; returns the updated vehicle. */
export async function uploadVehiclePhoto(deps: UploadDeps, vehicleId: string, file: PreparedFile): Promise<ServerVehicle> {
  const ticket = await deps.ep.requestUpload({ kind: 'vehicle-photo', parentId: vehicleId, sizeBytes: file.size, mimeType: file.mimeType });
  await putToSignedUrl(deps, ticket.uploadUrl, file);
  await deps.ep.confirmUpload(ticket.id!);
  return deps.ep.updateVehicle(vehicleId, { coverPhotoId: ticket.id! });
}

/** Uploads a new avatar; returns its public URL. */
export async function uploadAvatar(deps: UploadDeps, file: PreparedFile): Promise<string> {
  const ticket = await deps.ep.requestUpload({ kind: 'avatar', sizeBytes: file.size, mimeType: file.mimeType });
  await putToSignedUrl(deps, ticket.uploadUrl, file);
  const done = await deps.ep.confirmImage('avatar', ticket.path);
  return done.avatarUrl!;
}
