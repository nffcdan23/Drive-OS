import { Router } from "express";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db, vehicles, photos } from "@workspace/db";
import { requireUser } from "../middleware/auth";
import { badRequest, handler, notFound, uuidParam } from "../lib/http";
import { Body } from "../lib/validate";
import { rateLimit } from "../lib/rateLimit";
import { config } from "../config";
import { logger } from "../lib/logger";
import { createSignedDownloadUrl } from "../lib/supabaseAdmin";

const router = Router();
const FUEL = ["petrol", "diesel", "electric", "hybrid", "other"] as const;
const VISIBILITY = ["private", "friends", "public"] as const;
const COVER_URL_TTL = 3600;

type VehicleRow = typeof vehicles.$inferSelect;

/**
 * Adds `coverPhotoUrl`, a 1-hour signed link to the vehicle's cover photo
 * (photo buckets are private). A Storage outage only blanks the image.
 */
async function withCoverUrls(rows: VehicleRow[]): Promise<Array<VehicleRow & { coverPhotoUrl: string | null }>> {
  const ids = rows.map((r) => r.coverPhotoId).filter((id): id is string => !!id);
  const urls = new Map<string, string>();
  if (ids.length) {
    const found = await db.select({ id: photos.id, bucket: photos.bucket, path: photos.storagePath })
      .from(photos).where(and(inArray(photos.id, ids), eq(photos.status, "ready")));
    await Promise.all(found.map(async (p) => {
      try {
        urls.set(p.id, await createSignedDownloadUrl(p.bucket, p.path, COVER_URL_TTL));
      } catch (err) {
        logger.warn({ err }, "Could not sign a vehicle cover photo URL");
      }
    }));
  }
  return rows.map((r) => ({ ...r, coverPhotoUrl: r.coverPhotoId ? urls.get(r.coverPhotoId) ?? null : null }));
}
const withCoverUrl = async (row: VehicleRow) => (await withCoverUrls([row]))[0]!;

/** Reads the editable vehicle fields present in the body. */
function readVehicleFields(b: Body, creating: boolean): Partial<typeof vehicles.$inferInsert> {
  const out: Partial<typeof vehicles.$inferInsert> = {};
  const text = (field: keyof typeof vehicles.$inferInsert & string, max: number) => {
    if (b.has(field)) (out as Record<string, unknown>)[field] = b.str(field, { max })!;
  };
  if (creating || b.has("nickname")) out.nickname = b.str("nickname", { min: 1, max: 60 })!;
  text("registration", 10);
  text("make", 60);
  text("model", 60);
  text("colour", 40);
  text("engine", 40);
  text("power", 40);
  text("torque", 40);
  text("zeroToSixty", 20);
  text("topSpeedSpec", 20);
  if (b.has("year")) out.year = b.int("year", { min: 1885, max: 2100, nullable: true });
  if (b.has("fuelType")) out.fuelType = b.oneOf("fuelType", FUEL)!;
  if (b.has("mileage")) out.mileage = b.int("mileage", { min: 0, max: 5_000_000 })!;
  if (b.has("visibility")) out.visibility = b.oneOf("visibility", VISIBILITY)!;
  if (out.registration !== undefined) out.registration = out.registration.replace(/\s+/g, "").toUpperCase();
  return out;
}

// GET /api/vehicles — own vehicles
router.get("/vehicles", requireUser, handler(async (req, res) => {
  const rows = await db.select().from(vehicles).where(eq(vehicles.ownerId, req.userId)).orderBy(asc(vehicles.createdAt));
  res.json(await withCoverUrls(rows));
}));

// POST /api/vehicles — idempotent when clientRef is supplied
router.post("/vehicles", requireUser, handler(async (req, res) => {
  const b = Body.of(req);
  const fields = readVehicleFields(b, true);
  const clientRef = b.str("clientRef", { optional: true, max: 100 });
  const makeActive = b.bool("isActive", { optional: true }) ?? false;

  if (clientRef) {
    const [existing] = await db.select().from(vehicles)
      .where(and(eq(vehicles.ownerId, req.userId), eq(vehicles.clientRef, clientRef))).limit(1);
    if (existing) { res.status(200).json(await withCoverUrl(existing)); return; }
  }

  const row = await db.transaction(async (tx) => {
    const hasActive = await tx.execute(sql`select 1 from public.vehicles where owner_id = ${req.userId} and is_active`);
    const active = makeActive || hasActive.rows.length === 0; // first vehicle becomes active
    if (active) await tx.update(vehicles).set({ isActive: false }).where(and(eq(vehicles.ownerId, req.userId), eq(vehicles.isActive, true)));
    const [created] = await tx.insert(vehicles)
      .values({ ...fields, nickname: fields.nickname!, ownerId: req.userId, clientRef: clientRef ?? null, isActive: active })
      .returning();
    return created!;
  });
  res.status(201).json(await withCoverUrl(row));
}));

// GET /api/vehicles/:id — own vehicle
router.get("/vehicles/:id", requireUser, handler(async (req, res) => {
  const [row] = await db.select().from(vehicles)
    .where(and(eq(vehicles.id, uuidParam(req, "id")), eq(vehicles.ownerId, req.userId))).limit(1);
  if (!row) throw notFound();
  res.json(await withCoverUrl(row));
}));

// PATCH /api/vehicles/:id
router.patch("/vehicles/:id", requireUser, handler(async (req, res) => {
  const id = uuidParam(req, "id");
  const b = Body.of(req);
  const fields = readVehicleFields(b, false);
  const [owned] = await db.select({ id: vehicles.id }).from(vehicles)
    .where(and(eq(vehicles.id, id), eq(vehicles.ownerId, req.userId))).limit(1);
  if (!owned) throw notFound();
  if (b.has("coverPhotoId")) {
    const cover = b.uuid("coverPhotoId", { nullable: true });
    if (cover) {
      const [ok] = await db.select({ id: photos.id }).from(photos)
        .where(and(eq(photos.id, cover), eq(photos.vehicleId, id), eq(photos.ownerId, req.userId), eq(photos.status, "ready"))).limit(1);
      if (!ok) throw badRequest("invalid_cover_photo", "The cover photo must be a ready photo of this vehicle.");
    }
    fields.coverPhotoId = cover ?? null;
  }
  const [row] = await db.update(vehicles).set(fields)
    .where(and(eq(vehicles.id, id), eq(vehicles.ownerId, req.userId))).returning();
  if (!row) throw notFound();
  res.json(await withCoverUrl(row));
}));

// DELETE /api/vehicles/:id — photos, documents and records go with it;
// journeys keep their history (vehicle_id is cleared).
router.delete("/vehicles/:id", requireUser, handler(async (req, res) => {
  const [row] = await db.delete(vehicles)
    .where(and(eq(vehicles.id, uuidParam(req, "id")), eq(vehicles.ownerId, req.userId))).returning({ id: vehicles.id });
  if (!row) throw notFound();
  res.status(204).send();
}));

// POST /api/vehicles/:id/activate — exactly one active vehicle, atomically
router.post("/vehicles/:id/activate", requireUser, handler(async (req, res) => {
  const id = uuidParam(req, "id");
  const row = await db.transaction(async (tx) => {
    const [target] = await tx.select({ id: vehicles.id }).from(vehicles)
      .where(and(eq(vehicles.id, id), eq(vehicles.ownerId, req.userId))).for("update").limit(1);
    if (!target) throw notFound();
    await tx.update(vehicles).set({ isActive: false }).where(and(eq(vehicles.ownerId, req.userId), eq(vehicles.isActive, true)));
    const [updated] = await tx.update(vehicles).set({ isActive: true }).where(eq(vehicles.id, id)).returning();
    return updated!;
  });
  res.json(await withCoverUrl(row));
}));

// ─── DVLA Vehicle Enquiry Service lookup ─────────────────────────────────────
// The API key stays on the server: a key shipped in the app bundle can be
// extracted by anyone who installs it.
type VesVehicle = {
  registrationNumber?: string; make?: string; colour?: string; fuelType?: string;
  yearOfManufacture?: number; engineCapacity?: number; motStatus?: string; taxStatus?: string;
};

/** Maps VES fuel text ("PETROL", "HYBRID ELECTRIC", …) onto the app's options. */
function normaliseFuelType(raw: string | undefined) {
  const value = (raw ?? "").toUpperCase();
  if (!value) return null;
  if (value.includes("HYBRID") || value.includes("BIFUEL") || value.includes("BI-FUEL")) return "hybrid";
  if (value.includes("ELECTRIC")) return "electric";
  if (value.includes("DIESEL") || value.includes("HEAVY OIL")) return "diesel";
  if (value.includes("PETROL") || value.includes("GAS")) return "petrol";
  return null;
}

const formatEngine = (cc: number | undefined) => (!cc || cc <= 0 ? "" : `${(cc / 1000).toFixed(1)}L`);

// POST /api/vehicles/lookup — 10 lookups per minute per user (DVLA quota)
router.post("/vehicles/lookup", requireUser, rateLimit({ name: "vehicle lookup", windowMs: 60_000, max: 10 }), handler(async (req, res) => {
  if (!config.dvlaApiKey) {
    res.status(503).json({ error: "lookup_not_configured", message: "Vehicle lookup is not configured on the server." });
    return;
  }
  const supplied = Body.of(req).str("registration", { max: 20 })!;
  const registrationNumber = supplied.replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z0-9]{2,8}$/.test(registrationNumber)) {
    res.status(400).json({ error: "invalid_registration", message: "Enter a valid UK registration number." });
    return;
  }

  const upstream = await fetch(config.dvlaUrl, {
    method: "POST",
    headers: { "x-api-key": config.dvlaApiKey, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ registrationNumber }),
    signal: AbortSignal.timeout(10_000),
  });

  if (upstream.status === 404) { res.status(404).json({ error: "not_found", message: "No vehicle found with that registration." }); return; }
  if (upstream.status === 400) { res.status(400).json({ error: "invalid_registration", message: "DVLA did not recognise that registration format." }); return; }
  if (upstream.status === 429) { res.status(429).json({ error: "rate_limited", message: "Too many lookups just now. Try again shortly." }); return; }
  if (!upstream.ok) {
    logger.error({ status: upstream.status }, "DVLA VES lookup failed");
    res.status(502).json({ error: "lookup_unavailable", message: "Vehicle lookup is unavailable right now." });
    return;
  }

  const data = (await upstream.json()) as VesVehicle;
  // VES has no model, power, torque, 0-60 or top speed — those stay manual.
  res.json({
    registration: data.registrationNumber ?? registrationNumber,
    make: data.make ?? "",
    colour: data.colour ?? "",
    fuelType: normaliseFuelType(data.fuelType),
    year: data.yearOfManufacture ?? null,
    engine: formatEngine(data.engineCapacity),
    motStatus: data.motStatus ?? null,
    taxStatus: data.taxStatus ?? null,
  });
}));

export default router;
