import { Router } from "express";
import { and, desc, eq, sql } from "drizzle-orm";
import { db, journeys, journeyRoutes, journeyCategories, vehicles } from "@workspace/db";
import { requireUser } from "../middleware/auth";
import { badRequest, conflict, handler, notFound, uuidParam } from "../lib/http";
import { Body, isTimeZone } from "../lib/validate";
import { asUser, first, type Tx } from "../lib/userDb";
import { encodePolyline, pathLengthMetres, simplify, trimEnds, type LatLng } from "../lib/geo";
import { notify } from "../lib/notify";

const router = Router();
const VISIBILITY = ["private", "friends", "public"] as const;
const MAX_POINTS_PER_BATCH = 1000;
const MAX_ACCURACY_M = 100;       // points less accurate than this are not used for distance
const MAX_SPEED_KMH = 350;        // anything faster is treated as a GPS glitch
const CLOCK_SKEW_MS = 5 * 60_000;

interface PointInput {
  journey_id: string; recorded_at: Date; latitude: number; longitude: number;
  speed_kmh: number; heading_deg: number | null; accuracy_m: number | null; altitude_m: number | null;
}

/** Validates a batch of GPS points from the app. */
function readPoints(items: unknown[], journeyId: string, startedAt: Date): PointInput[] {
  const latest = Date.now() + CLOCK_SKEW_MS;
  const earliest = startedAt.getTime() - CLOCK_SKEW_MS;
  return items.map((item, i) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) throw badRequest("invalid_input", `points[${i}] must be an object`);
    const p = new Body(item as Record<string, unknown>);
    const recordedAt = p.timestamp("recordedAt")!;
    if (recordedAt.getTime() > latest || recordedAt.getTime() < earliest) {
      throw badRequest("invalid_input", `points[${i}].recordedAt is outside the journey`);
    }
    const heading = p.num("headingDeg", { optional: true, nullable: true, min: 0, max: 360 });
    return {
      journey_id: journeyId,
      recorded_at: recordedAt,
      latitude: p.num("latitude", { min: -90, max: 90 })!,
      longitude: p.num("longitude", { min: -180, max: 180 })!,
      speed_kmh: Math.min(p.num("speedKmh", { optional: true, min: 0, max: 1000 }) ?? 0, MAX_SPEED_KMH),
      heading_deg: heading == null ? null : heading % 360,
      accuracy_m: p.num("accuracyM", { optional: true, nullable: true, min: 0, max: 100_000 }) ?? null,
      altitude_m: p.num("altitudeM", { optional: true, nullable: true, min: -1000, max: 10_000 }) ?? null,
    };
  });
}

async function insertPoints(tx: Tx, points: PointInput[]): Promise<number> {
  if (!points.length) return 0;
  const result = await tx.execute(sql`
    insert into public.journey_route_points
      (journey_id, recorded_at, latitude, longitude, speed_kmh, heading_deg, accuracy_m, altitude_m)
    select * from jsonb_to_recordset(${JSON.stringify(points)}::jsonb) as p(
      journey_id uuid, recorded_at timestamptz, latitude double precision, longitude double precision,
      speed_kmh real, heading_deg real, accuracy_m real, altitude_m real)
    on conflict (journey_id, recorded_at) do nothing`);
  return result.rowCount ?? 0;
}

/** Category must be a shared default or one of the user's own. */
async function checkCategory(userId: string, categoryId: string | null | undefined) {
  if (!categoryId) return;
  const [c] = await db.select({ id: journeyCategories.id, ownerId: journeyCategories.ownerId })
    .from(journeyCategories).where(eq(journeyCategories.id, categoryId)).limit(1);
  if (!c || (c.ownerId !== null && c.ownerId !== userId)) throw badRequest("invalid_category", "Unknown category.");
}

/** Journey as its owner sees it (includes the full route summary). */
async function ownJourney(userId: string, id: string) {
  const [row] = await db
    .select({ journey: journeys, route: journeyRoutes })
    .from(journeys)
    .leftJoin(journeyRoutes, eq(journeyRoutes.journeyId, journeys.id))
    .where(and(eq(journeys.id, id), eq(journeys.ownerId, userId)))
    .limit(1);
  return row ? { ...row.journey, route: row.route ?? null } : null;
}

// GET /api/journeys — own journeys (completed by default; ?status=active|all)
router.get("/journeys", requireUser, handler(async (req, res) => {
  const status = req.query.status === "active" ? "active" : req.query.status === "all" ? null : "completed";
  const rows = await db
    .select({ journey: journeys, route: journeyRoutes })
    .from(journeys)
    .leftJoin(journeyRoutes, eq(journeyRoutes.journeyId, journeys.id))
    .where(and(eq(journeys.ownerId, req.userId), status ? eq(journeys.status, status) : undefined))
    .orderBy(desc(journeys.startedAt))
    .limit(500);
  res.json(rows.map((r) => ({ ...r.journey, route: r.route ?? null })));
}));

// POST /api/journeys — start a journey (idempotent when clientRef is supplied)
router.post("/journeys", requireUser, handler(async (req, res) => {
  const b = Body.of(req);
  const clientRef = b.str("clientRef", { optional: true, max: 100 });
  const vehicleId = b.uuid("vehicleId", { optional: true, nullable: true }) ?? null;
  const startedAt = b.timestamp("startedAt", { optional: true }) ?? new Date();
  const timezone = b.str("timezone", { optional: true, max: 64 }) ?? "Europe/London";
  const journeyType = b.oneOf("journeyType", ["personal", "convoy"] as const, { optional: true }) ?? "personal";
  const convoyId = b.uuid("convoyId", { optional: true, nullable: true }) ?? null;
  const name = b.str("name", { optional: true, min: 1, max: 120 });
  if (!isTimeZone(timezone)) throw badRequest("invalid_input", "timezone: unknown time zone");
  if (startedAt.getTime() > Date.now() + CLOCK_SKEW_MS) throw badRequest("invalid_input", "startedAt is in the future");

  if (clientRef) {
    const [existing] = await db.select().from(journeys)
      .where(and(eq(journeys.ownerId, req.userId), eq(journeys.clientRef, clientRef))).limit(1);
    if (existing) { res.status(200).json(existing); return; }
  }

  const row = await asUser(req.userId, async (tx) => {
    let snapshot: Record<string, unknown> | null = null;
    if (vehicleId) {
      const [v] = await tx.select().from(vehicles).where(and(eq(vehicles.id, vehicleId), eq(vehicles.ownerId, req.userId))).limit(1);
      if (!v) throw badRequest("invalid_vehicle", "Unknown vehicle.");
      snapshot = { vehicleId: v.id, nickname: v.nickname, make: v.make, model: v.model, year: v.year, colour: v.colour };
    }
    if (convoyId && !first(await tx.execute(sql`select 1 from public.convoy_participants where convoy_id = ${convoyId} and user_id = ${req.userId}`))) {
      throw badRequest("invalid_convoy", "You are not in that convoy.");
    }
    const settings = first<{ v: string }>(await tx.execute(sql`select default_journey_visibility as v from public.user_settings where user_id = ${req.userId}`));
    const [created] = await tx.insert(journeys).values({
      ownerId: req.userId, clientRef: clientRef ?? null, vehicleId, vehicleSnapshot: snapshot,
      name: name ?? "Active Journey", status: "active", startedAt, timezone,
      journeyType: convoyId ? "convoy" : journeyType, convoyId, visibility: settings?.v ?? "private",
    }).returning();
    return created!;
  });
  res.status(201).json(row);
}));

// GET /api/journeys/:id — own journey in full; someone else's only if its
// visibility allows, and then only with the trimmed public route.
router.get("/journeys/:id", requireUser, handler(async (req, res) => {
  const id = uuidParam(req, "id");
  const own = await ownJourney(req.userId, id);
  if (own) { res.json(own); return; }
  const other = await asUser(req.userId, async (tx) => first<Record<string, unknown>>(await tx.execute(sql`
    select j.id, j.owner_id as "ownerId", j.name, j.visibility, j.journey_type as "journeyType",
           j.started_at as "startedAt", j.ended_at as "endedAt", j.timezone,
           j.duration_seconds as "durationSeconds", j.distance_km as "distanceKm",
           j.avg_speed_kmh as "avgSpeedKmh", j.top_speed_kmh as "topSpeedKmh",
           j.vehicle_snapshot as "vehicleSnapshot", j.public_route_polyline as "publicRoutePolyline"
    from public.journeys j
    where j.id = ${id} and private.can_view_journey(j.id)`)));
  if (!other) throw notFound();
  res.json(other);
}));

// PATCH /api/journeys/:id — name, notes, category, visibility
router.patch("/journeys/:id", requireUser, handler(async (req, res) => {
  const id = uuidParam(req, "id");
  const b = Body.of(req);
  const u: Partial<typeof journeys.$inferInsert> = {};
  if (b.has("name")) u.name = b.str("name", { min: 1, max: 120 })!;
  if (b.has("notes")) u.notes = b.str("notes", { max: 5000 })!;
  if (b.has("visibility")) u.visibility = b.oneOf("visibility", VISIBILITY)!;
  if (b.has("categoryId")) {
    u.categoryId = b.uuid("categoryId", { nullable: true }) ?? null;
    await checkCategory(req.userId, u.categoryId);
  }
  const [row] = await db.update(journeys).set(u).where(and(eq(journeys.id, id), eq(journeys.ownerId, req.userId))).returning({ id: journeys.id });
  if (!row) throw notFound();
  res.json(await ownJourney(req.userId, id));
}));

// DELETE /api/journeys/:id — removes the journey, its points and photos, and
// takes it out of the owner's totals (XP already earned is kept).
router.delete("/journeys/:id", requireUser, handler(async (req, res) => {
  const id = uuidParam(req, "id");
  await db.transaction(async (tx) => {
    const [row] = await tx.delete(journeys).where(and(eq(journeys.id, id), eq(journeys.ownerId, req.userId)))
      .returning({ status: journeys.status, distanceKm: journeys.distanceKm });
    if (!row) throw notFound();
    if (row.status === "completed") {
      await tx.execute(sql`
        update public.profiles
        set total_journeys = greatest(total_journeys - 1, 0),
            total_distance_km = greatest(total_distance_km - ${row.distanceKm}, 0)
        where id = ${req.userId}`);
    }
  });
  res.status(204).send();
}));

// POST /api/journeys/:id/route-points — append GPS points to an active
// journey. Re-sending a batch is harmless (duplicates are ignored).
router.post("/journeys/:id/route-points", requireUser, handler(async (req, res) => {
  const id = uuidParam(req, "id");
  const items = Body.of(req).array("points", { max: MAX_POINTS_PER_BATCH })!;
  const outcome = await db.transaction(async (tx) => {
    const j = first<{ status: string; started_at: Date }>(await tx.execute(sql`
      select status, started_at from public.journeys where id = ${id} and owner_id = ${req.userId} for update`));
    if (!j) throw notFound();
    if (j.status !== "active") return { saved: 0, status: j.status };
    const saved = await insertPoints(tx, readPoints(items, id, new Date(j.started_at)));
    return { saved, status: j.status };
  });
  res.json(outcome);
}));

// GET /api/journeys/:id/points — own raw GPS points (owner only)
router.get("/journeys/:id/points", requireUser, handler(async (req, res) => {
  const id = uuidParam(req, "id");
  const owned = first(await db.execute(sql`select 1 from public.journeys where id = ${id} and owner_id = ${req.userId}`));
  if (!owned) throw notFound();
  const rows = await db.execute(sql`
    select recorded_at as "recordedAt", latitude, longitude, speed_kmh as "speedKmh",
           heading_deg as "headingDeg", accuracy_m as "accuracyM", altitude_m as "altitudeM"
    from public.journey_route_points where journey_id = ${id} order by recorded_at limit 20000`);
  res.json(rows.rows);
}));

/** XP for a completed drive: 10 per km, 50–500, nothing for very short drives. */
function xpForDistance(km: number, verified: boolean): number {
  if (km < 0.5) return 0;
  const xp = Math.min(500, Math.max(50, Math.round(km * 10)));
  return verified ? xp : Math.min(xp, 50); // unverifiable distances earn the minimum
}

// POST /api/journeys/:id/complete — finalises a journey. Distance, speeds and
// XP are worked out on the server from the stored GPS points; the app's own
// figures are only used (and capped) when there are too few points.
// Idempotent: completing twice returns the already-completed journey.
router.post("/journeys/:id/complete", requireUser, handler(async (req, res) => {
  const id = uuidParam(req, "id");
  const b = Body.of(req);
  const endedAtIn = b.timestamp("endedAt", { optional: true }) ?? new Date();
  const clientDistanceKm = b.num("distanceKm", { optional: true, min: 0, max: 5000 }) ?? 0;
  const name = b.str("name", { optional: true, min: 1, max: 120 });
  const notes = b.str("notes", { optional: true, max: 5000 });
  const visibility = b.oneOf("visibility", VISIBILITY, { optional: true });
  const categoryId = b.uuid("categoryId", { optional: true, nullable: true });
  const remaining = b.array("remainingPoints", { optional: true, max: MAX_POINTS_PER_BATCH }) ?? [];
  await checkCategory(req.userId, categoryId);

  const result = await asUser(req.userId, async (tx) => {
    const j = first<{ status: string; started_at: Date; timezone: string; name: string; visibility: string }>(await tx.execute(sql`
      select status, started_at, timezone, name, visibility
      from public.journeys where id = ${id} and owner_id = ${req.userId} for update`));
    if (!j) throw notFound();
    if (j.status === "completed") return { alreadyCompleted: true };
    if (j.status !== "active") throw conflict("journey_not_active", "This journey can no longer be completed.");

    const startedAt = new Date(j.started_at);
    await insertPoints(tx, readPoints(remaining, id, startedAt));
    if (endedAtIn.getTime() < startedAt.getTime()) throw badRequest("invalid_input", "endedAt is before the journey started");
    const endedAt = new Date(Math.min(endedAtIn.getTime(), Date.now() + CLOCK_SKEW_MS));
    const durationSeconds = Math.round((endedAt.getTime() - startedAt.getTime()) / 1000);

    const pts = (await tx.execute(sql`
      select latitude as lat, longitude as lng, speed_kmh, accuracy_m, altitude_m
      from public.journey_route_points where journey_id = ${id} order by recorded_at`)).rows as Array<
      { lat: number; lng: number; speed_kmh: number; accuracy_m: number | null; altitude_m: number | null }>;
    const usable: LatLng[] = pts.filter((p) => p.accuracy_m == null || p.accuracy_m <= MAX_ACCURACY_M).map((p) => ({ lat: p.lat, lng: p.lng }));

    const verified = usable.length >= 2;
    let distanceKm = verified ? pathLengthMetres(usable) / 1000 : clientDistanceKm;
    // Never more than a plausible distance for the elapsed time.
    distanceKm = Math.min(distanceKm, (durationSeconds / 3600) * MAX_SPEED_KMH);
    distanceKm = Math.round(distanceKm * 1000) / 1000;
    let topSpeedKmh = 0, maxAltitude = -Infinity;
    for (const p of pts) {
      if (p.speed_kmh > topSpeedKmh) topSpeedKmh = p.speed_kmh;
      if (p.altitude_m != null && p.altitude_m > maxAltitude) maxAltitude = p.altitude_m;
    }
    topSpeedKmh = Math.min(topSpeedKmh, MAX_SPEED_KMH);
    const avgSpeedKmh = durationSeconds > 0 ? Math.min((distanceKm / durationSeconds) * 3600, MAX_SPEED_KMH) : 0;
    const xpEarned = xpForDistance(distanceKm, verified);

    // Route summaries: full (owner only) and start/end-trimmed (shareable).
    const full = simplify(usable, 5);
    const trimmed = simplify(trimEnds(usable, 400), 5);
    if (usable.length) {
      let minLat = Infinity, minLng = Infinity, maxLat = -Infinity, maxLng = -Infinity;
      for (const p of usable) {
        if (p.lat < minLat) minLat = p.lat;
        if (p.lat > maxLat) maxLat = p.lat;
        if (p.lng < minLng) minLng = p.lng;
        if (p.lng > maxLng) maxLng = p.lng;
      }
      await tx.insert(journeyRoutes).values({
        journeyId: id, ownerId: req.userId, routePolyline: encodePolyline(full), pointCount: pts.length,
        startLat: usable[0]!.lat, startLng: usable[0]!.lng,
        endLat: usable[usable.length - 1]!.lat, endLng: usable[usable.length - 1]!.lng,
        bboxMinLat: minLat, bboxMinLng: minLng, bboxMaxLat: maxLat, bboxMaxLng: maxLng,
      }).onConflictDoNothing();
    }

    await tx.update(journeys).set({
      status: "completed", endedAt, durationSeconds, distanceKm,
      avgSpeedKmh: Math.round(avgSpeedKmh * 10) / 10, topSpeedKmh: Math.round(topSpeedKmh * 10) / 10,
      xpEarned, publicRoutePolyline: trimmed.length >= 2 ? encodePolyline(trimmed) : null,
      name: name ?? (j.name === "Active Journey" ? "Unnamed Journey" : j.name),
      ...(typeof notes === "string" ? { notes } : {}),
      ...(visibility ? { visibility } : {}),
      ...(categoryId !== undefined ? { categoryId } : {}),
    }).where(eq(journeys.id, id));

    const totals = first<{ total_distance_km: number; total_journeys: number }>(await tx.execute(sql`
      update public.profiles
      set xp = xp + ${xpEarned}, total_journeys = total_journeys + 1,
          total_distance_km = total_distance_km + ${distanceKm}
      where id = ${req.userId}
      returning total_distance_km, total_journeys`))!;

    // Achievements (each at most once, via the primary key).
    const localHour = first<{ h: number }>(await tx.execute(sql`
      select extract(hour from ${startedAt.toISOString()}::timestamptz at time zone ${j.timezone})::int as h`))!.h;
    const earned = [
      totals.total_journeys >= 1 && "first_drive",
      distanceKm >= 100 && "century_run",
      verified && localHour < 7 && localHour >= 3 && "early_bird",
      totals.total_distance_km >= 1000 && "road_warrior",
      maxAltitude > 600 && "mountain_road",
    ].filter(Boolean) as string[];
    const unlocked = earned.length
      ? ((await tx.execute(sql`
          insert into public.user_achievements (user_id, achievement_id, source_journey_id)
          select ${req.userId}, a.id, ${id} from public.achievements a where a.id in (${sql.join(earned.map((e) => sql`${e}`), sql`, `)})
          on conflict do nothing
          returning achievement_id`)).rows as Array<{ achievement_id: string }>).map((r) => r.achievement_id)
      : [];
    if (unlocked.length) {
      const rows = (await tx.execute(sql`
        select id, title, xp_reward from public.achievements where id in (${sql.join(unlocked.map((e) => sql`${e}`), sql`, `)})`)).rows as Array<{ id: string; title: string; xp_reward: number }>;
      const bonus = rows.reduce((s, r) => s + r.xp_reward, 0);
      if (bonus) await tx.execute(sql`update public.profiles set xp = xp + ${bonus} where id = ${req.userId}`);
      for (const r of rows) {
        await notify(tx, { userId: req.userId, type: "achievement_unlocked", title: `Achievement unlocked: ${r.title}`, body: `+${r.xp_reward} XP`, data: { achievementId: r.id } });
      }
    }
    return { alreadyCompleted: false, unlocked };
  });

  const journey = await ownJourney(req.userId, id);
  res.json({ ...journey, unlockedAchievements: result.alreadyCompleted ? [] : result.unlocked });
}));

export default router;
