import { Router } from "express";
import { and, desc, eq, isNull, lt, sql } from "drizzle-orm";
import { db, notifications } from "@workspace/db";
import { requireUser } from "../middleware/auth";
import { handler, notFound, uuidParam } from "../lib/http";
import { Body } from "../lib/validate";
import { asUser, first } from "../lib/userDb";
import { rateLimit } from "../lib/rateLimit";

const router = Router();

const columns = {
  id: notifications.id, actorUserId: notifications.actorUserId, type: notifications.type,
  title: notifications.title, body: notifications.body, data: notifications.data,
  readAt: notifications.readAt, isRead: notifications.isRead, createdAt: notifications.createdAt,
};

// GET /api/notifications?before=<ISO time> — newest first, 50 per page
router.get("/notifications", requireUser, handler(async (req, res) => {
  const before = typeof req.query.before === "string" ? new Date(req.query.before) : null;
  const rows = await db.select(columns).from(notifications)
    .where(and(eq(notifications.userId, req.userId), before && !Number.isNaN(before.getTime()) ? lt(notifications.createdAt, before) : undefined))
    .orderBy(desc(notifications.createdAt)).limit(50);
  const unread = first<{ n: number }>(await db.execute(sql`
    select count(*)::int as n from public.notifications where user_id = ${req.userId} and read_at is null`))!.n;
  res.json({ items: rows, unreadCount: unread });
}));

// POST /api/notifications/:id/read
router.post("/notifications/:id/read", requireUser, handler(async (req, res) => {
  const [row] = await db.update(notifications).set({ readAt: sql`coalesce(${notifications.readAt}, now())` })
    .where(and(eq(notifications.id, uuidParam(req, "id")), eq(notifications.userId, req.userId))).returning(columns);
  if (!row) throw notFound();
  res.json(row);
}));

// POST /api/notifications/read-all
router.post("/notifications/read-all", requireUser, handler(async (req, res) => {
  await db.update(notifications).set({ readAt: sql`now()` })
    .where(and(eq(notifications.userId, req.userId), isNull(notifications.readAt)));
  res.status(204).send();
}));

// DELETE /api/notifications/:id
router.delete("/notifications/:id", requireUser, handler(async (req, res) => {
  const [row] = await db.delete(notifications)
    .where(and(eq(notifications.id, uuidParam(req, "id")), eq(notifications.userId, req.userId))).returning({ id: notifications.id });
  if (!row) throw notFound();
  res.status(204).send();
}));

// ─── Reports ────────────────────────────────────────────────────────────────

const TARGETS = ["location", "photo", "profile", "group", "event", "convoy", "journey"] as const;
const REASONS = ["spam", "inappropriate", "harassment", "dangerous", "privacy", "other"] as const;

/** Visibility check per target type — you can only report what you can see. */
const visible: Record<(typeof TARGETS)[number], (id: string) => ReturnType<typeof sql>> = {
  location: (id) => sql`private.can_view_location(${id})`,
  photo: (id) => sql`exists (select 1 from public.photos p where p.id = ${id} and p.status = 'ready' and private.can_read_photo_object(p.bucket, p.storage_path))`,
  profile: (id) => sql`exists (select 1 from public.profiles p where p.id = ${id} and not private.is_blocked_between(p.id, auth.uid()))`,
  group: (id) => sql`private.can_view_group(${id})`,
  event: (id) => sql`private.can_view_event(${id})`,
  convoy: (id) => sql`private.can_view_convoy(${id})`,
  journey: (id) => sql`private.can_view_journey(${id})`,
};

// POST /api/reports { targetType, targetId, reason, details? }
router.post("/reports", requireUser, rateLimit({ name: "reports", windowMs: 60 * 60_000, max: 20 }), handler(async (req, res) => {
  const b = Body.of(req);
  const targetType = b.oneOf("targetType", TARGETS)!;
  const targetId = b.uuid("targetId")!;
  const reason = b.oneOf("reason", REASONS)!;
  const details = b.str("details", { optional: true, max: 2000 }) ?? "";
  const id = await asUser(req.userId, async (tx) => {
    if (!first<{ ok: boolean }>(await tx.execute(sql`select ${visible[targetType](targetId)} as ok`))?.ok) throw notFound();
    const r = first<{ id: string }>(await tx.execute(sql`
      insert into public.content_reports (reporter_id, target_type, target_id, reason, details)
      values (${req.userId}, ${targetType}, ${targetId}, ${reason}, ${details})
      on conflict do nothing returning id`));
    return r?.id ?? null;
  });
  // A second open report of the same thing is accepted silently.
  res.status(id ? 201 : 200).json({ status: "received" });
}));

export default router;
