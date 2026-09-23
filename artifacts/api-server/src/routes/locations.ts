import { Router } from "express";
import { and, desc, eq, sql } from "drizzle-orm";
import { db, savedLocations, photos } from "@workspace/db";
import { requireUser } from "../middleware/auth";
import { badRequest, handler, notFound, uuidParam } from "../lib/http";
import { Body, queryNumber } from "../lib/validate";
import { asUser, first } from "../lib/userDb";

const router = Router();
const KINDS = ["home", "work", "favourite_road", "meeting_point", "car_park", "poi", "beauty_spot"] as const;
const CATEGORIES = ["viewpoint", "coastal", "mountain_pass", "lake", "forest", "scenic_road", "landmark", "photo_spot", "other"] as const;
const VISIBILITY = ["private", "friends", "public"] as const;
const PRIVATE_KINDS = new Set<string>(["home", "work"]);

// Columns returned for saved locations (never the internal `geog` column).
const columns = {
  id: savedLocations.id, ownerId: savedLocations.ownerId, clientRef: savedLocations.clientRef,
  kind: savedLocations.kind, category: savedLocations.category, name: savedLocations.name,
  description: savedLocations.description, address: savedLocations.address,
  lat: savedLocations.lat, lng: savedLocations.lng, routePolyline: savedLocations.routePolyline,
  visibility: savedLocations.visibility, status: savedLocations.status,
  coverPhotoId: savedLocations.coverPhotoId, sourceJourneyId: savedLocations.sourceJourneyId,
  createdAt: savedLocations.createdAt, updatedAt: savedLocations.updatedAt,
};

function readFields(b: Body, creating: boolean): Partial<typeof savedLocations.$inferInsert> {
  const out: Partial<typeof savedLocations.$inferInsert> = {};
  if (creating || b.has("kind")) out.kind = b.oneOf("kind", KINDS)!;
  if (b.has("category")) out.category = b.oneOf("category", CATEGORIES, { nullable: true }) ?? null;
  if (creating || b.has("name")) out.name = b.str("name", { min: 1, max: 100 })!;
  if (b.has("description")) out.description = b.str("description", { max: 2000 })!;
  if (b.has("address")) out.address = b.str("address", { max: 300 })!;
  if (creating || b.has("lat")) out.lat = b.num("lat", { min: -90, max: 90 })!;
  if (creating || b.has("lng")) out.lng = b.num("lng", { min: -180, max: 180 })!;
  if (b.has("routePolyline")) out.routePolyline = b.str("routePolyline", { nullable: true, max: 100_000, trim: false }) ?? null;
  if (b.has("visibility")) out.visibility = b.oneOf("visibility", VISIBILITY)!;
  return out;
}

// GET /api/locations — own saved locations (optionally ?kind=beauty_spot)
router.get("/locations", requireUser, handler(async (req, res) => {
  const kind = typeof req.query.kind === "string" && (KINDS as readonly string[]).includes(req.query.kind) ? req.query.kind : null;
  const rows = await db.select(columns).from(savedLocations)
    .where(and(eq(savedLocations.ownerId, req.userId), kind ? eq(savedLocations.kind, kind) : undefined))
    .orderBy(desc(savedLocations.createdAt));
  res.json(rows);
}));

// POST /api/locations — idempotent when clientRef is supplied. Home and Work
// are always private; only Beauty Spots and meeting points can be public.
router.post("/locations", requireUser, handler(async (req, res) => {
  const b = Body.of(req);
  const fields = readFields(b, true);
  const clientRef = b.str("clientRef", { optional: true, max: 100 });
  const sourceJourneyId = b.uuid("sourceJourneyId", { optional: true, nullable: true }) ?? null;

  if (clientRef) {
    const [existing] = await db.select(columns).from(savedLocations)
      .where(and(eq(savedLocations.ownerId, req.userId), eq(savedLocations.clientRef, clientRef))).limit(1);
    if (existing) { res.status(200).json(existing); return; }
  }
  if (sourceJourneyId && !first(await db.execute(sql`select 1 from public.journeys where id = ${sourceJourneyId} and owner_id = ${req.userId}`))) {
    throw badRequest("invalid_journey", "Unknown journey.");
  }
  if (PRIVATE_KINDS.has(fields.kind!) && fields.visibility !== undefined && fields.visibility !== "private") {
    throw badRequest("location_must_be_private", "Home and Work locations are always private.");
  }
  if (fields.visibility === undefined) {
    const s = first<{ v: string }>(await db.execute(sql`select default_location_visibility as v from public.user_settings where user_id = ${req.userId}`));
    fields.visibility = fields.kind === "home" || fields.kind === "work" ? "private" : s?.v ?? "private";
    if (fields.visibility === "public" && fields.kind !== "beauty_spot" && fields.kind !== "meeting_point") fields.visibility = "friends";
  }
  const [row] = await db.insert(savedLocations).values({
    ...fields, kind: fields.kind!, name: fields.name!, lat: fields.lat!, lng: fields.lng!,
    ownerId: req.userId, clientRef: clientRef ?? null, sourceJourneyId, status: "active",
  }).returning(columns);
  res.status(201).json(row);
}));

// GET /api/locations/nearby?lat=&lng=&radius= — Beauty Spots near a point:
// public ones, friends' friends-only ones and the user's own.
router.get("/locations/nearby", requireUser, handler(async (req, res) => {
  const lat = queryNumber(req, "lat", { min: -90, max: 90 });
  const lng = queryNumber(req, "lng", { min: -180, max: 180 });
  const radius = queryNumber(req, "radius", { min: 100, max: 200_000, fallback: 25_000 });
  const rows = await asUser(req.userId, async (tx) => (await tx.execute(sql`
    select id, owner_id as "ownerId", name, category, description, lat, lng, visibility,
           cover_photo_id as "coverPhotoId", distance_m as "distanceM"
    from public.nearby_spots(${lat}, ${lng}, ${radius}, 100)`)).rows);
  res.json(rows);
}));

// GET /api/locations/in-view?minLat=&minLng=&maxLat=&maxLng= — for the map
router.get("/locations/in-view", requireUser, handler(async (req, res) => {
  const minLat = queryNumber(req, "minLat", { min: -90, max: 90 });
  const minLng = queryNumber(req, "minLng", { min: -180, max: 180 });
  const maxLat = queryNumber(req, "maxLat", { min: -90, max: 90 });
  const maxLng = queryNumber(req, "maxLng", { min: -180, max: 180 });
  if (minLat > maxLat || minLng > maxLng) throw badRequest("invalid_input", "min must not exceed max");
  const rows = await asUser(req.userId, async (tx) => (await tx.execute(sql`
    select id, owner_id as "ownerId", name, category, lat, lng, visibility, cover_photo_id as "coverPhotoId"
    from public.spots_in_view(${minLat}, ${minLng}, ${maxLat}, ${maxLng}, 300)`)).rows);
  res.json(rows);
}));

// GET /api/locations/:id — own, or someone else's if its visibility allows
router.get("/locations/:id", requireUser, handler(async (req, res) => {
  const id = uuidParam(req, "id");
  const row = await asUser(req.userId, async (tx) => {
    const [r] = await tx.select(columns).from(savedLocations)
      .where(and(eq(savedLocations.id, id), sql`private.can_view_location(${savedLocations.id})`)).limit(1);
    return r;
  });
  if (!row) throw notFound();
  res.json(row);
}));

// PATCH /api/locations/:id — own only; moderation status is server-only
router.patch("/locations/:id", requireUser, handler(async (req, res) => {
  const id = uuidParam(req, "id");
  const b = Body.of(req);
  const fields = readFields(b, false);
  if (b.has("coverPhotoId")) {
    const cover = b.uuid("coverPhotoId", { nullable: true });
    if (cover) {
      const [ok] = await db.select({ id: photos.id }).from(photos)
        .where(and(eq(photos.id, cover), eq(photos.locationId, id), eq(photos.ownerId, req.userId), eq(photos.status, "ready"))).limit(1);
      if (!ok) throw badRequest("invalid_cover_photo", "The cover photo must be a ready photo of this location.");
    }
    fields.coverPhotoId = cover ?? null;
  }
  if (fields.kind !== undefined && PRIVATE_KINDS.has(fields.kind)) {
    if (fields.visibility !== undefined && fields.visibility !== "private") throw badRequest("location_must_be_private", "Home and Work locations are always private.");
    fields.visibility = "private";
  }
  const [row] = await db.update(savedLocations).set(fields)
    .where(and(eq(savedLocations.id, id), eq(savedLocations.ownerId, req.userId),
      // Home/Work can't be made visible to anyone else.
      fields.visibility !== undefined && fields.visibility !== "private" ? sql`${savedLocations.kind} not in ('home', 'work')` : undefined))
    .returning(columns);
  if (!row) throw notFound();
  res.json(row);
}));

// DELETE /api/locations/:id
router.delete("/locations/:id", requireUser, handler(async (req, res) => {
  const [row] = await db.delete(savedLocations)
    .where(and(eq(savedLocations.id, uuidParam(req, "id")), eq(savedLocations.ownerId, req.userId)))
    .returning({ id: savedLocations.id });
  if (!row) throw notFound();
  res.status(204).send();
}));

export default router;
