import { Router } from "express";
import { randomUUID } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { db, photos, vehicleDocuments, profiles, groups, events } from "@workspace/db";
import { requireUser } from "../middleware/auth";
import { badRequest, conflict, forbidden, handler, notFound, uuidParam } from "../lib/http";
import { Body } from "../lib/validate";
import { asUser, first } from "../lib/userDb";
import { rateLimit } from "../lib/rateLimit";
import { createSignedDownloadUrl, createSignedUploadUrl, publicUrl } from "../lib/supabaseAdmin";

/**
 * Uploads never pass through the API. The flow is:
 *   1. POST /api/uploads            → the API checks ownership and limits,
 *      creates a `pending` row and returns a one-time signed upload URL for
 *      a server-chosen path inside the user's own folder.
 *   2. The app PUTs the file to that URL (Supabase Storage).
 *   3. POST /api/uploads/:id/confirm → the API checks the stored object's
 *      real size and type and marks the row `ready`.
 * Downloads of private files go through short-lived signed URLs issued only
 * after the same visibility checks the RLS policies enforce.
 */
const router = Router();

const IMAGE_TYPES = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" } as const;
const DOC_TYPES = { ...IMAGE_TYPES, "application/pdf": "pdf", "image/heic": "heic" } as const;
const PHOTO_MAX = 5 * 1024 * 1024;
const DOC_MAX = 10 * 1024 * 1024;
const AVATAR_MAX = 1024 * 1024;
const COMMUNITY_MAX = 3 * 1024 * 1024;
const PHOTO_URL_TTL = 3600;
const DOC_URL_TTL = 60;

const PHOTO_KINDS = {
  "vehicle-photo": { bucket: "vehicle-photos", table: "vehicles", column: "vehicleId" },
  "journey-photo": { bucket: "journey-photos", table: "journeys", column: "journeyId" },
  "location-photo": { bucket: "location-photos", table: "saved_locations", column: "locationId" },
} as const;
type PhotoKind = keyof typeof PHOTO_KINDS;

const uploadLimiter = rateLimit({ name: "upload", windowMs: 60_000, max: 30 });

/** Size and MIME type of a stored object, straight from Storage's table. */
async function storedObject(bucket: string, path: string): Promise<{ size: number; mime: string } | null> {
  const row = first<{ size: string | null; mime: string | null }>(await db.execute(sql`
    select metadata ->> 'size' as size, metadata ->> 'mimetype' as mime
    from storage.objects where bucket_id = ${bucket} and name = ${path}`));
  if (!row) return null;
  return { size: Number(row.size ?? Number.NaN), mime: row.mime ?? "" };
}

async function ownsRow(table: "vehicles" | "journeys" | "saved_locations", id: string, userId: string) {
  return !!first(await db.execute(sql`select 1 from public.${sql.raw(table)} where id = ${id} and owner_id = ${userId}`));
}

// POST /api/uploads
router.post("/uploads", requireUser, uploadLimiter, handler(async (req, res) => {
  const b = Body.of(req);
  const kind = b.oneOf("kind", ["avatar", "vehicle-photo", "journey-photo", "location-photo", "vehicle-document", "group-logo", "event-cover"] as const)!;
  const sizeBytes = b.int("sizeBytes", { min: 1, max: DOC_MAX })!;

  // ── Single images stored on a parent row (public buckets) ──
  if (kind === "avatar" || kind === "group-logo" || kind === "event-cover") {
    const mime = b.oneOf("mimeType", Object.keys(IMAGE_TYPES) as Array<keyof typeof IMAGE_TYPES>)!;
    const ext = IMAGE_TYPES[mime];
    let bucket: string, path: string, max: number;
    if (kind === "avatar") {
      bucket = "avatars"; max = AVATAR_MAX; path = `${req.userId}/${randomUUID()}.${ext}`;
    } else {
      const parentId = b.uuid("parentId")!;
      bucket = "community-media"; max = COMMUNITY_MAX;
      if (kind === "group-logo") {
        const role = first<{ role: string | null }>(await asUser(req.userId, async (tx) => tx.execute(sql`select private.group_role(${parentId}) as role`)));
        if (role?.role !== "owner" && role?.role !== "admin") throw forbidden("not_group_admin", "Only group owners and admins can change the logo.");
        path = `groups/${parentId}/${randomUUID()}.${ext}`;
      } else {
        const [ev] = await db.select({ id: events.id }).from(events).where(and(eq(events.id, parentId), eq(events.organiserId, req.userId))).limit(1);
        if (!ev) throw forbidden("not_organiser", "Only the organiser can change the cover.");
        path = `events/${parentId}/${randomUUID()}.${ext}`;
      }
    }
    if (sizeBytes > max) throw badRequest("too_large", `Images of this kind are limited to ${max / 1024 / 1024} MB.`);
    const signed = await createSignedUploadUrl(bucket, path);
    res.status(201).json({ kind, bucket, path, uploadUrl: signed.url, token: signed.token, mimeType: mime });
    return;
  }

  const parentId = b.uuid("parentId")!;

  // ── Vehicle documents (private, owner only) ──
  if (kind === "vehicle-document") {
    const mime = b.oneOf("mimeType", Object.keys(DOC_TYPES) as Array<keyof typeof DOC_TYPES>)!;
    if (!(await ownsRow("vehicles", parentId, req.userId))) throw notFound("vehicle_not_found");
    const id = randomUUID();
    const path = `${req.userId}/${parentId}/${id}.${DOC_TYPES[mime]}`;
    const [row] = await db.insert(vehicleDocuments).values({
      id, vehicleId: parentId, ownerId: req.userId, storagePath: path, mimeType: mime, sizeBytes, status: "pending",
      docType: b.oneOf("docType", ["v5c", "insurance", "mot", "service_receipt", "warranty", "other"] as const)!,
      title: b.str("title", { optional: true, max: 120 }) ?? "",
      expiresOn: b.date("expiresOn", { optional: true, nullable: true }) ?? null,
    }).returning();
    const signed = await createSignedUploadUrl("vehicle-documents", path);
    res.status(201).json({ kind, id: row!.id, bucket: "vehicle-documents", path, uploadUrl: signed.url, token: signed.token });
    return;
  }

  // ── Photos of a vehicle, journey or saved location (private buckets) ──
  const spec = PHOTO_KINDS[kind as PhotoKind];
  const mime = b.oneOf("mimeType", Object.keys(IMAGE_TYPES) as Array<keyof typeof IMAGE_TYPES>)!;
  if (sizeBytes > PHOTO_MAX) throw badRequest("too_large", "Photos are limited to 5 MB.");
  if (!(await ownsRow(spec.table, parentId, req.userId))) throw notFound("parent_not_found");
  const withThumbnail = b.bool("withThumbnail", { optional: true }) ?? false;
  const id = randomUUID();
  const path = `${req.userId}/${parentId}/${id}.${IMAGE_TYPES[mime]}`;
  const thumbPath = withThumbnail ? `${req.userId}/${parentId}/${id}_thumb.jpg` : null;
  await db.insert(photos).values({
    id, ownerId: req.userId, [spec.column]: parentId, bucket: spec.bucket, storagePath: path, thumbPath,
    mimeType: mime, sizeBytes, status: "pending",
    width: b.int("width", { optional: true, nullable: true, min: 1, max: 20_000 }) ?? null,
    height: b.int("height", { optional: true, nullable: true, min: 1, max: 20_000 }) ?? null,
    caption: b.str("caption", { optional: true, max: 500 }) ?? "",
  });
  const signed = await createSignedUploadUrl(spec.bucket, path);
  const thumb = thumbPath ? await createSignedUploadUrl(spec.bucket, thumbPath) : null;
  res.status(201).json({
    kind, id, bucket: spec.bucket, path, uploadUrl: signed.url, token: signed.token,
    thumbnail: thumb ? { path: thumbPath, uploadUrl: thumb.url, token: thumb.token } : null,
  });
}));

// POST /api/uploads/image/confirm — avatars, group logos, event covers
router.post("/uploads/image/confirm", requireUser, handler(async (req, res) => {
  const b = Body.of(req);
  const kind = b.oneOf("kind", ["avatar", "group-logo", "event-cover"] as const)!;
  const path = b.str("path", { max: 300 })!;
  const bucket = kind === "avatar" ? "avatars" : "community-media";
  const max = kind === "avatar" ? AVATAR_MAX : COMMUNITY_MAX;

  const parts = path.split("/");
  const obj = await storedObject(bucket, path);
  if (!obj) throw badRequest("not_uploaded", "The file has not been uploaded yet.");
  if (!(obj.size <= max) || !(obj.mime in IMAGE_TYPES)) throw badRequest("invalid_file", "The uploaded file is not an allowed image.");

  if (kind === "avatar") {
    if (parts.length !== 2 || parts[0] !== req.userId) throw forbidden();
    await db.update(profiles).set({ avatarPath: path }).where(eq(profiles.id, req.userId));
    res.json({ avatarUrl: publicUrl("avatars", path) });
  } else if (kind === "group-logo") {
    const groupId = parts[1] ?? "";
    if (parts.length !== 3 || parts[0] !== "groups") throw forbidden();
    const role = first<{ role: string | null }>(await asUser(req.userId, async (tx) => tx.execute(sql`select private.group_role(${groupId}::uuid) as role`)));
    if (role?.role !== "owner" && role?.role !== "admin") throw forbidden("not_group_admin");
    await db.update(groups).set({ logoPath: path }).where(eq(groups.id, groupId));
    res.json({ logoUrl: publicUrl("community-media", path) });
  } else {
    const eventId = parts[1] ?? "";
    if (parts.length !== 3 || parts[0] !== "events") throw forbidden();
    const [ev] = await db.update(events).set({ coverPath: path })
      .where(and(eq(events.id, eventId), eq(events.organiserId, req.userId))).returning({ id: events.id });
    if (!ev) throw forbidden("not_organiser");
    res.json({ coverUrl: publicUrl("community-media", path) });
  }
}));

// POST /api/uploads/:id/confirm — photos and vehicle documents
router.post("/uploads/:id/confirm", requireUser, handler(async (req, res) => {
  const id = uuidParam(req, "id");
  const [photo] = await db.select().from(photos).where(and(eq(photos.id, id), eq(photos.ownerId, req.userId))).limit(1);
  if (photo) {
    if (photo.status === "ready") { res.json(photo); return; }
    const obj = await storedObject(photo.bucket, photo.storagePath);
    if (!obj) throw badRequest("not_uploaded", "The file has not been uploaded yet.");
    if (!(obj.size <= PHOTO_MAX) || obj.mime !== photo.mimeType) throw badRequest("invalid_file", "The uploaded file does not match what was declared.");
    const thumb = photo.thumbPath ? await storedObject(photo.bucket, photo.thumbPath) : null;
    const [row] = await db.update(photos).set({
      status: "ready", sizeBytes: obj.size,
      thumbPath: thumb && thumb.size <= PHOTO_MAX && thumb.mime in IMAGE_TYPES ? photo.thumbPath : null,
    }).where(eq(photos.id, id)).returning();
    res.json(row);
    return;
  }
  const [doc] = await db.select().from(vehicleDocuments).where(and(eq(vehicleDocuments.id, id), eq(vehicleDocuments.ownerId, req.userId))).limit(1);
  if (!doc) throw notFound();
  if (doc.status === "ready") { res.json(doc); return; }
  const obj = await storedObject("vehicle-documents", doc.storagePath);
  if (!obj) throw badRequest("not_uploaded", "The file has not been uploaded yet.");
  if (!(obj.size <= DOC_MAX) || obj.mime !== doc.mimeType) throw badRequest("invalid_file", "The uploaded file does not match what was declared.");
  const [row] = await db.update(vehicleDocuments).set({ status: "ready", sizeBytes: obj.size }).where(eq(vehicleDocuments.id, id)).returning();
  res.json(row);
}));

/** A photo the caller may see: their own, or a ready one of a visible parent. */
async function visiblePhoto(userId: string, id: string) {
  return asUser(userId, async (tx) => {
    const [row] = await tx.select().from(photos).where(and(eq(photos.id, id), sql`(
      ${photos.ownerId} = ${userId} or (${photos.status} = 'ready' and case
        when ${photos.vehicleId} is not null then private.can_view_vehicle(${photos.vehicleId})
        when ${photos.journeyId} is not null then private.can_view_journey(${photos.journeyId})
        when ${photos.locationId} is not null then private.can_view_location(${photos.locationId})
        else false end))`)).limit(1);
    return row;
  });
}

async function withUrls(p: typeof photos.$inferSelect) {
  const ready = p.status === "ready";
  return {
    id: p.id, ownerId: p.ownerId, vehicleId: p.vehicleId, journeyId: p.journeyId, locationId: p.locationId,
    caption: p.caption, width: p.width, height: p.height, sortOrder: p.sortOrder, status: p.status, createdAt: p.createdAt,
    url: ready ? await createSignedDownloadUrl(p.bucket, p.storagePath, PHOTO_URL_TTL) : null,
    thumbnailUrl: ready && p.thumbPath ? await createSignedDownloadUrl(p.bucket, p.thumbPath, PHOTO_URL_TTL) : null,
    urlExpiresIn: ready ? PHOTO_URL_TTL : null,
  };
}

// GET /api/photos?vehicleId=|journeyId=|locationId= — photos of one item
router.get("/photos", requireUser, handler(async (req, res) => {
  const pick = (["vehicleId", "journeyId", "locationId"] as const).find((k) => typeof req.query[k] === "string");
  if (!pick) throw badRequest("invalid_input", "Pass vehicleId, journeyId or locationId.");
  const parentId = String(req.query[pick]);
  if (!/^[0-9a-f-]{36}$/i.test(parentId)) throw notFound();
  const column = pick === "vehicleId" ? photos.vehicleId : pick === "journeyId" ? photos.journeyId : photos.locationId;
  const rows = await asUser(req.userId, async (tx) => tx.select().from(photos).where(and(eq(column, parentId.toLowerCase()), sql`(
      ${photos.ownerId} = ${req.userId} or (${photos.status} = 'ready' and case
        when ${photos.vehicleId} is not null then private.can_view_vehicle(${photos.vehicleId})
        when ${photos.journeyId} is not null then private.can_view_journey(${photos.journeyId})
        when ${photos.locationId} is not null then private.can_view_location(${photos.locationId})
        else false end))`)).orderBy(asc(photos.sortOrder), asc(photos.createdAt)).limit(50));
  res.json(await Promise.all(rows.map(withUrls)));
}));

// GET /api/photos/:id — one photo with fresh signed URLs
router.get("/photos/:id", requireUser, handler(async (req, res) => {
  const row = await visiblePhoto(req.userId, uuidParam(req, "id"));
  if (!row) throw notFound();
  res.json(await withUrls(row));
}));

// PATCH /api/photos/:id — caption / order (own only)
router.patch("/photos/:id", requireUser, handler(async (req, res) => {
  const b = Body.of(req);
  const u: Partial<typeof photos.$inferInsert> = {};
  if (b.has("caption")) u.caption = b.str("caption", { max: 500 })!;
  if (b.has("sortOrder")) u.sortOrder = b.int("sortOrder", { min: 0, max: 10_000 })!;
  const [row] = await db.update(photos).set(u).where(and(eq(photos.id, uuidParam(req, "id")), eq(photos.ownerId, req.userId))).returning();
  if (!row) throw notFound();
  res.json(await withUrls(row));
}));

// DELETE /api/photos/:id — the file is removed by the Storage worker
router.delete("/photos/:id", requireUser, handler(async (req, res) => {
  const [row] = await db.delete(photos).where(and(eq(photos.id, uuidParam(req, "id")), eq(photos.ownerId, req.userId))).returning({ id: photos.id });
  if (!row) throw notFound();
  res.status(204).send();
}));

// GET /api/documents?vehicleId= — own vehicle documents (metadata only)
router.get("/documents", requireUser, handler(async (req, res) => {
  const vehicleId = typeof req.query.vehicleId === "string" ? req.query.vehicleId.toLowerCase() : null;
  if (vehicleId && !/^[0-9a-f-]{36}$/.test(vehicleId)) throw notFound();
  const rows = await db.select({
    id: vehicleDocuments.id, vehicleId: vehicleDocuments.vehicleId, docType: vehicleDocuments.docType,
    title: vehicleDocuments.title, mimeType: vehicleDocuments.mimeType, sizeBytes: vehicleDocuments.sizeBytes,
    status: vehicleDocuments.status, expiresOn: vehicleDocuments.expiresOn,
    serviceRecordId: vehicleDocuments.serviceRecordId, createdAt: vehicleDocuments.createdAt,
  }).from(vehicleDocuments)
    .where(and(eq(vehicleDocuments.ownerId, req.userId), vehicleId ? eq(vehicleDocuments.vehicleId, vehicleId) : undefined))
    .orderBy(asc(vehicleDocuments.createdAt));
  res.json(rows);
}));

// GET /api/documents/:id/url — 60-second download link, owner only
router.get("/documents/:id/url", requireUser, handler(async (req, res) => {
  const [doc] = await db.select().from(vehicleDocuments)
    .where(and(eq(vehicleDocuments.id, uuidParam(req, "id")), eq(vehicleDocuments.ownerId, req.userId))).limit(1);
  if (!doc) throw notFound();
  if (doc.status !== "ready") throw conflict("not_ready", "The document upload has not been confirmed.");
  res.json({ url: await createSignedDownloadUrl("vehicle-documents", doc.storagePath, DOC_URL_TTL), expiresIn: DOC_URL_TTL });
}));

// PATCH /api/documents/:id — type, title, expiry
router.patch("/documents/:id", requireUser, handler(async (req, res) => {
  const b = Body.of(req);
  const u: Partial<typeof vehicleDocuments.$inferInsert> = {};
  if (b.has("docType")) u.docType = b.oneOf("docType", ["v5c", "insurance", "mot", "service_receipt", "warranty", "other"] as const)!;
  if (b.has("title")) u.title = b.str("title", { max: 120 })!;
  if (b.has("expiresOn")) u.expiresOn = b.date("expiresOn", { nullable: true }) ?? null;
  const [row] = await db.update(vehicleDocuments).set(u)
    .where(and(eq(vehicleDocuments.id, uuidParam(req, "id")), eq(vehicleDocuments.ownerId, req.userId))).returning({ id: vehicleDocuments.id });
  if (!row) throw notFound();
  res.json({ id: row.id });
}));

// DELETE /api/documents/:id
router.delete("/documents/:id", requireUser, handler(async (req, res) => {
  const [row] = await db.delete(vehicleDocuments)
    .where(and(eq(vehicleDocuments.id, uuidParam(req, "id")), eq(vehicleDocuments.ownerId, req.userId))).returning({ id: vehicleDocuments.id });
  if (!row) throw notFound();
  res.status(204).send();
}));

export default router;
