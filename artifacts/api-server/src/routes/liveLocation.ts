import { Router } from "express";
import { sql } from "drizzle-orm";
import { requireUser } from "../middleware/auth";
import { conflict, handler, notFound, uuidParam } from "../lib/http";
import { Body } from "../lib/validate";
import { asUser, first, type Tx } from "../lib/userDb";
import { cardColumns, toCard } from "../lib/community";
import { rateLimit } from "../lib/rateLimit";

/**
 * Private live location (migration 0018).
 *
 * Who may see a position is decided in ONE place, the database function
 * private.can_see_live_location(owner, viewer): the RLS policy, the Realtime
 * fan-out and every read here use it. The API connects as the table owner,
 * so reads that return other people's positions call it explicitly.
 *
 * There is deliberately no "location of user X" endpoint: a viewer asks for
 * the positions shared with them (GET /live-locations), nothing else.
 *
 * Coordinates are never logged.
 */
const router = Router();

// During a drive the app sends at most one position every 5 s; on screen
// (not driving) about once a minute. Room for retries, nothing more.
const publishLimit = rateLimit({ name: "live location", windowMs: 60_000, max: 30 });
const settingsLimit = rateLimit({ name: "location sharing", windowMs: 60_000, max: 60 });

/** How long a position stays current without a newer one. */
const TTL_SECONDS = 180;
/** A fix older than this (by the phone's own clock) is not "live". */
const MAX_FIX_AGE_MS = 2 * 60_000;
const MODES = ["off", "while_driving", "while_using"] as const;
const AUDIENCES = ["none", "selected", "all"] as const;

/** 5 decimal places, about a metre: enough for a marker, no more. */
const round5 = (v: number) => Math.round(v * 1e5) / 1e5;

/** Speeds the phone reports as unknown (negative) or impossible are dropped, not stored. */
function cleanSpeedKmh(mps: number | null | undefined): number | null {
  if (mps == null || !Number.isFinite(mps) || mps < 0) return null;
  const kmh = mps * 3.6;
  return kmh > 400 ? null : Math.round(kmh * 10) / 10;
}

/** Headings the phone reports as unknown (negative) are dropped; others normalised into [0, 360). */
function cleanHeading(deg: number | null | undefined): number | null {
  if (deg == null || !Number.isFinite(deg) || deg < 0) return null;
  const h = Math.round((deg % 360) * 10) / 10;
  return h >= 360 ? 0 : h;
}

interface LiveRow {
  user_id: string;
  latitude: number;
  longitude: number;
  heading_deg: number | null;
  speed_kmh: number | null;
  accuracy_m: number | null;
  driving: boolean;
  recorded_at: Date | string;
  expires_at: Date | string;
}

/**
 * A database error from a statement carrying a position would carry the
 * coordinates too (the driver includes bound parameters in its message), and
 * unexpected errors are logged: keep only the error code.
 */
async function withoutValues<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (err) {
    const code = (err as { code?: unknown; cause?: { code?: unknown } })?.cause?.code ?? (err as { code?: unknown })?.code;
    const safe = new Error(`live location write failed (${typeof code === "string" ? code : "unknown"})`);
    if (typeof code === "string") Object.assign(safe, { code });
    throw safe;
  }
}

const presentLive = (r: LiveRow & { expires_in_ms?: number }) => ({
  userId: r.user_id,
  latitude: r.latitude,
  longitude: r.longitude,
  headingDeg: r.heading_deg,
  speedKmh: r.speed_kmh,
  accuracyM: r.accuracy_m,
  driving: r.driving,
  recordedAt: new Date(r.recorded_at).toISOString(),
  expiresAt: new Date(r.expires_at).toISOString(),
  // Remaining lifetime by the server's clock, so the app never keeps a
  // position past its expiry whatever its own clock says.
  ...(r.expires_in_ms !== undefined ? { expiresInMs: Math.max(0, Math.floor(Number(r.expires_in_ms))) } : {}),
});

// ─── Publishing your own position ────────────────────────────────────────────

// PUT /api/me/live-location — the app's current position
//   latitude, longitude   required
//   accuracyM             optional, metres
//   speedMps              optional, m/s (negative = unknown, dropped)
//   headingDeg            optional, degrees (negative = unknown, dropped)
//   capturedAt            optional, when the phone took the fix; a fix
//                         older than 2 minutes is refused as stale
// The server decides everything else: whether sharing applies right now
// (WHEN, from the owner's settings and presence), `driving` (from presence),
// the time and the expiry. Nothing is stored when sharing is off.
router.put("/me/live-location", requireUser, publishLimit, handler(async (req, res) => {
  const b = Body.of(req);
  const latitude = round5(b.num("latitude", { min: -90, max: 90 })!);
  const longitude = round5(b.num("longitude", { min: -180, max: 180 })!);
  const accuracy = b.num("accuracyM", { optional: true, nullable: true, min: 0, max: 100_000 }) ?? null;
  const speedKmh = cleanSpeedKmh(b.num("speedMps", { optional: true, nullable: true }));
  const capturedAt = b.timestamp("capturedAt", { optional: true });
  const stationary = speedKmh != null && speedKmh < 3;
  // A heading means nothing when standing still.
  const headingDeg = stationary ? null : cleanHeading(b.num("headingDeg", { optional: true, nullable: true }));
  if (capturedAt && Date.now() - capturedAt.getTime() > MAX_FIX_AGE_MS) throw conflict("stale_fix", "That position is too old to share as live.");

  const row = await asUser(req.userId, async (tx) => {
    // Read WHEN and presence with share locks: a concurrent "sharing off",
    // drive end, sign-out or backgrounding either finishes first (and this
    // is refused) or waits for this to commit (and its trigger then removes
    // the position). Row locks first, then the sharer's fan-out lock.
    const settings = first<{ mode: string }>(await tx.execute(sql`
      select location_sharing as mode from public.user_settings where user_id = ${req.userId} for share`));
    const presence = first<{ app_state: string; driving: boolean; fresh: boolean }>(await tx.execute(sql`
      select app_state, driving, last_seen_at > now() - interval '3 minutes' as fresh
      from public.user_presence where user_id = ${req.userId} for share`));
    await tx.execute(sql`select private.lock_live_owner(${req.userId})`);
    const mode = settings?.mode ?? "off";
    const live = presence?.fresh === true && presence.app_state !== "signed_out";
    const driving = live && presence?.driving === true;
    // While Using means the app is in the foreground, drive or not: a drive
    // in the background is shared only under While Driving.
    const using = live && presence?.app_state === "foreground";
    if (mode === "off") throw conflict("sharing_off", "Location sharing is off.");
    if (mode === "while_driving" && !driving) throw conflict("not_driving", "Location is shared only while driving.");
    if (mode === "while_using" && !using) throw conflict("not_in_use", "Location is shared only while Derwent is open.");

    return first<LiveRow>(await withoutValues(tx.execute(sql`
      insert into public.live_locations
        (user_id, latitude, longitude, heading_deg, speed_kmh, accuracy_m, driving, recorded_at, expires_at)
      values (${req.userId}, ${latitude}, ${longitude}, ${headingDeg}, ${speedKmh}, ${accuracy}, ${driving},
              now(), now() + make_interval(secs => ${TTL_SECONDS}))
      on conflict (user_id) do update
        set latitude = excluded.latitude, longitude = excluded.longitude, heading_deg = excluded.heading_deg,
            speed_kmh = excluded.speed_kmh, accuracy_m = excluded.accuracy_m, driving = excluded.driving,
            recorded_at = excluded.recorded_at, expires_at = excluded.expires_at
      returning *`)))!;
  });
  res.json({ driving: row.driving, expiresAt: new Date(row.expires_at).toISOString() });
}));

// DELETE /api/me/live-location — stop showing the current position now
// (viewers are told at once). Sharing settings are unchanged.
router.delete("/me/live-location", requireUser, handler(async (req, res) => {
  await asUser(req.userId, (tx) => tx.execute(sql`delete from public.live_locations where user_id = ${req.userId}`));
  res.status(204).send();
}));

// ─── Positions shared with you ───────────────────────────────────────────────

// GET /api/live-locations — every position currently shared with the caller
// (the snapshot the app loads before applying Realtime updates). Only people
// who could have granted access are considered, and each is checked with the
// canonical rule.
router.get("/live-locations", requireUser, handler(async (req, res) => {
  const rows = await asUser(req.userId, async (tx) => (await tx.execute(sql`
    select l.*, (extract(epoch from (l.expires_at - now())) * 1000)::float8 as expires_in_ms
    from public.live_locations l
    where l.expires_at > now()
      and l.user_id in (
        select f.friend_id from public.friendships f where f.user_id = ${req.userId}
        union
        select g.owner_id from public.location_share_convoys g
          join public.convoy_participants pv on pv.convoy_id = g.convoy_id and pv.user_id = ${req.userId})
      and private.can_see_live_location(l.user_id, ${req.userId})`)).rows as unknown as LiveRow[]);
  res.json(rows.map(presentLive));
}));

// ─── Your sharing settings ───────────────────────────────────────────────────

async function sharingState(tx: Tx, userId: string) {
  const s = first<{ mode: string; audience: string }>(await tx.execute(sql`
    select location_sharing as mode, location_friend_audience as audience
    from public.user_settings where user_id = ${userId}`));
  const friends = (await tx.execute(sql`
    select ${cardColumns},
           exists (select 1 from public.location_share_friends g where g.owner_id = ${userId} and g.friend_id = p.id) as "selected"
    from public.friendships f join public.profiles p on p.id = f.friend_id
    where f.user_id = ${userId} and not private.is_blocked_between(${userId}, p.id)
    order by p.display_name`)).rows as Record<string, unknown>[];
  // Convoys the caller is in that haven't ended. Only private Convoys with
  // no Community can be shared with (anyone could join the others).
  const convoys = (await tx.execute(sql`
    select c.id, c.name, c.status, c.visibility, c.starts_at as "startsAt",
           (c.visibility = 'private' and c.group_id is null) as "eligible",
           exists (select 1 from public.location_share_convoys g where g.owner_id = ${userId} and g.convoy_id = c.id) as "shared",
           (select count(*)::int - 1 from public.convoy_participants x where x.convoy_id = c.id) as "otherMembers"
    from public.convoys c
    join public.convoy_participants me on me.convoy_id = c.id and me.user_id = ${userId}
    where c.status in ('forming', 'active')
    order by c.starts_at`)).rows as Record<string, unknown>[];
  const counts = first<{ granted: number; current: boolean }>(await tx.execute(sql`
    select (select count(*)::int from private.live_location_candidates(${userId}) c
             where private.live_location_granted(${userId}, c)) as granted,
           exists (select 1 from public.live_locations where user_id = ${userId} and expires_at > now()) as current`))!;
  return {
    mode: s?.mode ?? "off",
    friendAudience: s?.audience ?? "none",
    // People who would see your position whenever it is being shared.
    sharingWithCount: counts.granted,
    // Whether a position is being shown right now.
    live: counts.current,
    friends: friends.map((r) => ({ ...toCard(r), selected: r.selected === true })),
    convoys: convoys.map((r) => ({
      id: String(r.id), name: String(r.name), status: String(r.status), visibility: String(r.visibility),
      startsAt: r.startsAt, eligible: r.eligible === true, shared: r.shared === true && r.eligible === true,
      otherMembers: Number(r.otherMembers),
    })),
  };
}

// GET /api/me/location-sharing — WHO and WHEN, with the friends and Convoys
// that can be chosen and how many people it currently covers
router.get("/me/location-sharing", requireUser, handler(async (req, res) => {
  res.json(await asUser(req.userId, (tx) => sharingState(tx, req.userId)));
}));

// PATCH /api/me/location-sharing — mode (off | while_driving | while_using),
// friendAudience (none | selected | all). Turning it off removes the current
// position and tells everyone at once.
router.patch("/me/location-sharing", requireUser, settingsLimit, handler(async (req, res) => {
  const b = Body.of(req);
  const mode = b.oneOf("mode", MODES, { optional: true });
  const audience = b.oneOf("friendAudience", AUDIENCES, { optional: true });
  res.json(await asUser(req.userId, async (tx) => {
    if (mode !== undefined || audience !== undefined) {
      await tx.execute(sql`
        update public.user_settings
           set location_sharing = coalesce(${mode ?? null}, location_sharing),
               location_friend_audience = coalesce(${audience ?? null}, location_friend_audience)
         where user_id = ${req.userId}`);
    }
    return sharingState(tx, req.userId);
  }));
}));

// PUT /api/me/location-sharing/friends/:userId — choose a friend (only an
// actual friend, with no block either way). Used when friendAudience is
// 'selected'.
router.put("/me/location-sharing/friends/:userId", requireUser, settingsLimit, handler(async (req, res) => {
  const friendId = uuidParam(req, "userId");
  res.json(await asUser(req.userId, async (tx) => {
    const ok = first<{ ok: boolean }>(await tx.execute(sql`
      select private.is_friend(${req.userId}, ${friendId}) and not private.is_blocked_between(${req.userId}, ${friendId}) as ok`));
    if (!ok?.ok) throw notFound("not_friend", "Only friends can be chosen.");
    await tx.execute(sql`
      insert into public.location_share_friends (owner_id, friend_id) values (${req.userId}, ${friendId})
      on conflict do nothing`);
    return sharingState(tx, req.userId);
  }));
}));

// DELETE /api/me/location-sharing/friends/:userId — they stop seeing it at once
router.delete("/me/location-sharing/friends/:userId", requireUser, settingsLimit, handler(async (req, res) => {
  const friendId = uuidParam(req, "userId");
  res.json(await asUser(req.userId, async (tx) => {
    await tx.execute(sql`delete from public.location_share_friends where owner_id = ${req.userId} and friend_id = ${friendId}`);
    return sharingState(tx, req.userId);
  }));
}));

// PUT /api/me/location-sharing/convoys/:id — share with a Convoy's members.
// Only a Convoy the caller is in, private, with no Community, not over.
router.put("/me/location-sharing/convoys/:id", requireUser, settingsLimit, handler(async (req, res) => {
  const convoyId = uuidParam(req, "id");
  res.json(await asUser(req.userId, async (tx) => {
    const c = first<{ eligible: boolean }>(await tx.execute(sql`
      select (c.visibility = 'private' and c.group_id is null and c.status in ('forming', 'active')) as eligible
      from public.convoys c
      join public.convoy_participants me on me.convoy_id = c.id and me.user_id = ${req.userId}
      where c.id = ${convoyId}`));
    if (!c) throw notFound();
    if (!c.eligible) {
      throw conflict("convoy_not_eligible", "Location can be shared only with private Convoys that aren't part of a Community.");
    }
    await tx.execute(sql`
      insert into public.location_share_convoys (owner_id, convoy_id) values (${req.userId}, ${convoyId})
      on conflict do nothing`);
    return sharingState(tx, req.userId);
  }));
}));

// DELETE /api/me/location-sharing/convoys/:id — its members stop seeing it at once
router.delete("/me/location-sharing/convoys/:id", requireUser, settingsLimit, handler(async (req, res) => {
  const convoyId = uuidParam(req, "id");
  res.json(await asUser(req.userId, async (tx) => {
    await tx.execute(sql`delete from public.location_share_convoys where owner_id = ${req.userId} and convoy_id = ${convoyId}`);
    return sharingState(tx, req.userId);
  }));
}));

export default router;
