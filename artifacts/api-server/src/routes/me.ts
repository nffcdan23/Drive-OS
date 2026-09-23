import { Router } from "express";
import { and, eq, sql } from "drizzle-orm";
import { db, profiles, userSettings, achievements, userAchievements } from "@workspace/db";
import { requireUser } from "../middleware/auth";
import { handler, notFound, uuidParam } from "../lib/http";
import { Body } from "../lib/validate";
import { asUser, first } from "../lib/userDb";
import { deleteAuthUser, publicUrl } from "../lib/supabaseAdmin";
import { rateLimit } from "../lib/rateLimit";
import { logger } from "../lib/logger";

const router = Router();
const VISIBILITY = ["private", "friends", "public"] as const;
const XP_PER_LEVEL = 1000; // matches private.level_for_xp

function presentProfile(p: typeof profiles.$inferSelect, s: typeof userSettings.$inferSelect | undefined) {
  return {
    id: p.id,
    username: p.username,
    displayName: p.displayName,
    bio: p.bio,
    avatarUrl: p.avatarPath ? publicUrl("avatars", p.avatarPath) : null,
    friendCode: p.friendCode,
    xp: p.xp,
    level: p.level,
    xpIntoLevel: p.xp % XP_PER_LEVEL,
    xpToNextLevel: XP_PER_LEVEL - (p.xp % XP_PER_LEVEL),
    totalDistanceKm: p.totalDistanceKm,
    totalJourneys: p.totalJourneys,
    createdAt: p.createdAt,
    settings: s
      ? {
          unitSystem: s.unitSystem,
          profileVisibility: s.profileVisibility,
          defaultJourneyVisibility: s.defaultJourneyVisibility,
          defaultLocationVisibility: s.defaultLocationVisibility,
          allowFriendRequests: s.allowFriendRequests,
          shareLiveLocationInConvoys: s.shareLiveLocationInConvoys,
          notificationPrefs: s.notificationPrefs,
        }
      : null,
  };
}

async function loadMe(userId: string) {
  const [p] = await db.select().from(profiles).where(eq(profiles.id, userId)).limit(1);
  if (!p) throw notFound();
  const [s] = await db.select().from(userSettings).where(eq(userSettings.userId, userId)).limit(1);
  return presentProfile(p, s);
}

// GET /api/me — own profile and settings
router.get("/me", requireUser, handler(async (req, res) => {
  res.json(await loadMe(req.userId));
}));

// PATCH /api/me — name, username, bio (XP, level and stats are server-only)
router.patch("/me", requireUser, handler(async (req, res) => {
  const b = Body.of(req);
  const updates: Partial<typeof profiles.$inferInsert> = {};
  if (b.has("displayName")) updates.displayName = b.str("displayName", { min: 1, max: 50 })!;
  if (b.has("username")) updates.username = b.str("username", { nullable: true, pattern: /^[A-Za-z0-9_.]{3,30}$/ }) ?? null;
  if (b.has("bio")) updates.bio = b.str("bio", { max: 500 })!;
  if (Object.keys(updates).length) await db.update(profiles).set(updates).where(eq(profiles.id, req.userId));
  res.json(await loadMe(req.userId));
}));

// PATCH /api/me/settings
router.patch("/me/settings", requireUser, handler(async (req, res) => {
  const b = Body.of(req);
  const u: Partial<typeof userSettings.$inferInsert> = {};
  if (b.has("unitSystem")) u.unitSystem = b.oneOf("unitSystem", ["auto", "metric", "imperial"] as const)!;
  if (b.has("profileVisibility")) u.profileVisibility = b.oneOf("profileVisibility", VISIBILITY)!;
  if (b.has("defaultJourneyVisibility")) u.defaultJourneyVisibility = b.oneOf("defaultJourneyVisibility", VISIBILITY)!;
  if (b.has("defaultLocationVisibility")) u.defaultLocationVisibility = b.oneOf("defaultLocationVisibility", VISIBILITY)!;
  if (b.has("allowFriendRequests")) u.allowFriendRequests = b.oneOf("allowFriendRequests", ["everyone", "nobody"] as const)!;
  if (b.has("shareLiveLocationInConvoys")) u.shareLiveLocationInConvoys = b.bool("shareLiveLocationInConvoys")!;
  if (b.has("notificationPrefs")) {
    const prefs = b.object("notificationPrefs")!;
    const out: Record<string, boolean> = {};
    for (const key of ["friends", "convoys", "groups", "events", "achievements"]) {
      if (prefs.has(key)) out[key] = prefs.bool(key)!;
    }
    u.notificationPrefs = out;
  }
  if (Object.keys(u).length) await db.update(userSettings).set(u).where(eq(userSettings.userId, req.userId));
  res.json(await loadMe(req.userId));
}));

// GET /api/me/stats — live counts
router.get("/me/stats", requireUser, handler(async (req, res) => {
  const row = first<{ friends: number; vehicles: number; journeys: number; total_distance_km: number }>(
    await db.execute(sql`
      select (select count(*)::int from public.friendships where user_id = ${req.userId}) as friends,
             (select count(*)::int from public.vehicles where owner_id = ${req.userId}) as vehicles,
             (select count(*)::int from public.journeys where owner_id = ${req.userId} and status = 'completed') as journeys,
             (select coalesce(sum(distance_km), 0)::float from public.journeys
               where owner_id = ${req.userId} and status = 'completed') as total_distance_km`),
  )!;
  res.json({ friends: row.friends, vehicles: row.vehicles, journeys: row.journeys, totalDistanceKm: row.total_distance_km });
}));

// GET /api/me/achievements — the catalogue with unlock state
router.get("/me/achievements", requireUser, handler(async (req, res) => {
  const rows = await db
    .select({
      id: achievements.id, title: achievements.title, description: achievements.description,
      icon: achievements.icon, xpReward: achievements.xpReward, unlockedAt: userAchievements.unlockedAt,
    })
    .from(achievements)
    .leftJoin(userAchievements, and(eq(userAchievements.achievementId, achievements.id), eq(userAchievements.userId, req.userId)))
    .where(eq(achievements.isHidden, false))
    .orderBy(achievements.sortOrder);
  res.json(rows);
}));

// GET /api/users/:id — another user's public card, respecting blocks and
// their profile visibility setting.
router.get("/users/:id", requireUser, handler(async (req, res) => {
  const id = uuidParam(req, "id");
  const row = await asUser(req.userId, async (tx) => first<Record<string, unknown>>(await tx.execute(sql`
    select p.id, p.username, p.display_name, p.avatar_path, p.level,
           private.profile_details_visible(p.id) as details_visible,
           p.bio, p.xp, p.total_distance_km, p.total_journeys,
           private.is_friend(${req.userId}, p.id) as is_friend
    from public.profiles p
    where p.id = ${id} and (p.id = ${req.userId} or not private.is_blocked_between(p.id, ${req.userId}))`)));
  if (!row) throw notFound();
  const details = row.details_visible === true;
  res.json({
    id: row.id, username: row.username, displayName: row.display_name, level: row.level,
    avatarUrl: row.avatar_path ? publicUrl("avatars", String(row.avatar_path)) : null,
    isFriend: row.is_friend === true,
    bio: details ? row.bio : null,
    xp: details ? row.xp : null,
    totalDistanceKm: details ? row.total_distance_km : null,
    totalJourneys: details ? row.total_journeys : null,
  });
}));

// DELETE /api/me — permanently deletes the account and all its data.
// Deleting the Auth user cascades to every table; triggers queue the user's
// Storage files, which the Storage worker removes.
router.delete("/me", requireUser, rateLimit({ name: "account deletion", windowMs: 60_000, max: 3 }), handler(async (req, res) => {
  const b = Body.of(req);
  if (b.str("confirm") !== "DELETE") {
    res.status(400).json({ error: "confirmation_required", message: 'Send {"confirm":"DELETE"} to delete the account.' });
    return;
  }
  await deleteAuthUser(req.userId);
  // Belt and braces: remove the profile even if Auth had no such user.
  await db.delete(profiles).where(eq(profiles.id, req.userId));
  logger.info({ userId: req.userId }, "Account deleted");
  res.status(204).send();
}));

export default router;
