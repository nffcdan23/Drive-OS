import { Router } from "express";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { requireUser } from "../middleware/auth";
import { badRequest, conflict, forbidden, handler, notFound, uuidParam } from "../lib/http";
import { Body } from "../lib/validate";
import { asUser, first, type Tx } from "../lib/userDb";
import { notify } from "../lib/notify";
import { cardColumns, toCard } from "../lib/community";
import { rateLimit } from "../lib/rateLimit";

const router = Router();
const requestLimit = rateLimit({ name: "friend requests", windowMs: 60_000, max: 20 });

async function displayName(tx: Tx, userId: string): Promise<string> {
  return first<{ n: string }>(await tx.execute(sql`select display_name as n from public.profiles where id = ${userId}`))?.n ?? "Someone";
}

async function isBlocked(tx: Tx, a: string, b: string): Promise<boolean> {
  return first<{ b: boolean }>(await tx.execute(sql`select private.is_blocked_between(${a}, ${b}) as b`))?.b === true;
}

/** Makes two users friends (both directions) — idempotent. */
async function befriend(tx: Tx, a: string, b: string) {
  await tx.execute(sql`
    insert into public.friendships (user_id, friend_id) values (${a}, ${b}), (${b}, ${a})
    on conflict do nothing`);
}

// ─── Friends ────────────────────────────────────────────────────────────────

// GET /api/friends
router.get("/friends", requireUser, handler(async (req, res) => {
  const r = await db.execute(sql`
    select ${cardColumns}, f.created_at as "since"
    from public.friendships f join public.profiles p on p.id = f.friend_id
    where f.user_id = ${req.userId}
    order by p.display_name`);
  res.json(r.rows.map((row) => ({ ...toCard(row), since: (row as { since: unknown }).since })));
}));

// DELETE /api/friends/:userId — removes the friendship for both people
router.delete("/friends/:userId", requireUser, handler(async (req, res) => {
  const other = uuidParam(req, "userId");
  const r = await db.execute(sql`
    delete from public.friendships
    where (user_id = ${req.userId} and friend_id = ${other}) or (user_id = ${other} and friend_id = ${req.userId})
    returning 1`);
  if (!r.rows.length) throw notFound();
  res.status(204).send();
}));

// ─── Friend requests ────────────────────────────────────────────────────────

// GET /api/friend-requests — pending requests, incoming and outgoing
router.get("/friend-requests", requireUser, handler(async (req, res) => {
  const r = await db.execute(sql`
    select fr.id as "requestId", fr.created_at as "createdAt",
           case when fr.to_user_id = ${req.userId} then 'incoming' else 'outgoing' end as "direction",
           ${cardColumns}
    from public.friend_requests fr
    join public.profiles p on p.id = case when fr.to_user_id = ${req.userId} then fr.from_user_id else fr.to_user_id end
    where fr.status = 'pending' and (fr.to_user_id = ${req.userId} or fr.from_user_id = ${req.userId})
    order by fr.created_at desc`);
  const rows = r.rows as Record<string, unknown>[];
  const out = (dir: string) => rows.filter((x) => x.direction === dir)
    .map((x) => ({ id: x.requestId, createdAt: x.createdAt, user: toCard(x) }));
  res.json({ incoming: out("incoming"), outgoing: out("outgoing") });
}));

// POST /api/friend-requests { friendCode } or { userId }
// Unknown codes and blocked users get the same answer, so a request can't be
// used to discover who has blocked you.
router.post("/friend-requests", requireUser, requestLimit, handler(async (req, res) => {
  const b = Body.of(req);
  const code = b.str("friendCode", { optional: true, pattern: /^[A-Za-z0-9]{8}$/ });
  const byId = b.uuid("userId", { optional: true });
  if (!code === !byId) throw badRequest("invalid_input", "Send exactly one of friendCode or userId.");

  const result = await db.transaction(async (tx) => {
    const target = first<{ id: string }>(await tx.execute(code
      ? sql`select id from public.profiles where friend_code = ${code.toUpperCase()}`
      : sql`select id from public.profiles where id = ${byId}`));
    if (!target || await isBlocked(tx, target.id, req.userId)) {
      throw notFound("user_not_found", "No driver has that friend code.");
    }
    if (target.id === req.userId) throw badRequest("cannot_add_self", "That's your own friend code.");
    if (first(await tx.execute(sql`select 1 from public.friendships where user_id = ${req.userId} and friend_id = ${target.id}`))) {
      throw conflict("already_friends", "You're already friends.");
    }
    // If they already asked us, accept their request instead of making a second one.
    const incoming = first<{ id: string }>(await tx.execute(sql`
      select id from public.friend_requests
      where from_user_id = ${target.id} and to_user_id = ${req.userId} and status = 'pending' for update`));
    if (incoming) {
      await tx.execute(sql`update public.friend_requests set status = 'accepted', responded_at = now() where id = ${incoming.id}`);
      await befriend(tx, req.userId, target.id);
      await notify(tx, { userId: target.id, actorId: req.userId, type: "friend_accepted",
        title: `${await displayName(tx, req.userId)} accepted your friend request`, data: { userId: req.userId } });
      return { status: 200, body: { id: incoming.id, status: "accepted" } };
    }
    if (!first<{ ok: boolean }>(await tx.execute(sql`select private.accepts_friend_requests(${target.id}) as ok`))?.ok) {
      throw forbidden("not_accepting_requests", "This driver isn't accepting friend requests.");
    }
    const created = first<{ id: string }>(await tx.execute(sql`
      insert into public.friend_requests (from_user_id, to_user_id) values (${req.userId}, ${target.id})
      on conflict do nothing returning id`));
    if (!created) throw conflict("request_pending", "A friend request is already pending.");
    await notify(tx, { userId: target.id, actorId: req.userId, type: "friend_request",
      title: `${await displayName(tx, req.userId)} sent you a friend request`, data: { requestId: created.id, userId: req.userId } });
    return { status: 201, body: { id: created.id, status: "pending" } };
  });
  res.status(result.status).json(result.body);
}));

// POST /api/friend-requests/:id/accept — only the recipient
router.post("/friend-requests/:id/accept", requireUser, handler(async (req, res) => {
  const id = uuidParam(req, "id");
  await db.transaction(async (tx) => {
    const fr = first<{ from: string }>(await tx.execute(sql`
      select from_user_id as "from" from public.friend_requests
      where id = ${id} and to_user_id = ${req.userId} and status = 'pending' for update`));
    if (!fr) throw notFound();
    if (await isBlocked(tx, fr.from, req.userId)) throw notFound();
    await tx.execute(sql`update public.friend_requests set status = 'accepted', responded_at = now() where id = ${id}`);
    await befriend(tx, req.userId, fr.from);
    await notify(tx, { userId: fr.from, actorId: req.userId, type: "friend_accepted",
      title: `${await displayName(tx, req.userId)} accepted your friend request`, data: { userId: req.userId } });
  });
  res.json({ id, status: "accepted" });
}));

// POST /api/friend-requests/:id/decline — only the recipient (the sender isn't told)
router.post("/friend-requests/:id/decline", requireUser, handler(async (req, res) => {
  const id = uuidParam(req, "id");
  const r = await db.execute(sql`
    update public.friend_requests set status = 'declined', responded_at = now()
    where id = ${id} and to_user_id = ${req.userId} and status = 'pending' returning id`);
  if (!r.rows.length) throw notFound();
  res.json({ id, status: "declined" });
}));

// DELETE /api/friend-requests/:id — only the sender can cancel
router.delete("/friend-requests/:id", requireUser, handler(async (req, res) => {
  const r = await db.execute(sql`
    update public.friend_requests set status = 'cancelled', responded_at = now()
    where id = ${uuidParam(req, "id")} and from_user_id = ${req.userId} and status = 'pending' returning id`);
  if (!r.rows.length) throw notFound();
  res.status(204).send();
}));

// ─── Blocks ─────────────────────────────────────────────────────────────────

// GET /api/blocks
router.get("/blocks", requireUser, handler(async (req, res) => {
  const r = await db.execute(sql`
    select ${cardColumns} from public.user_blocks b join public.profiles p on p.id = b.blocked_id
    where b.blocker_id = ${req.userId} order by b.created_at desc`);
  res.json(r.rows.map(toCard));
}));

// POST /api/blocks { userId } — also ends the friendship, pending requests,
// shared convoy membership and invitations between the two users.
router.post("/blocks", requireUser, handler(async (req, res) => {
  const other = Body.of(req).uuid("userId")!;
  if (other === req.userId) throw badRequest("cannot_block_self");
  await asUser(req.userId, async (tx) => {
    if (!first(await tx.execute(sql`select 1 from public.profiles where id = ${other}`))) throw notFound();
    await tx.execute(sql`insert into public.user_blocks (blocker_id, blocked_id) values (${req.userId}, ${other}) on conflict do nothing`);
    await tx.execute(sql`
      delete from public.friendships
      where (user_id = ${req.userId} and friend_id = ${other}) or (user_id = ${other} and friend_id = ${req.userId})`);
    await tx.execute(sql`
      update public.friend_requests set status = 'cancelled', responded_at = now()
      where status = 'pending' and ((from_user_id = ${req.userId} and to_user_id = ${other})
                                 or (from_user_id = ${other} and to_user_id = ${req.userId}))`);
    // Leave each other's convoys (the leader keeps theirs).
    await tx.execute(sql`
      delete from public.convoy_participants cp using public.convoys c
      where cp.convoy_id = c.id and cp.role <> 'leader'
        and ((c.owner_id = ${req.userId} and cp.user_id = ${other}) or (c.owner_id = ${other} and cp.user_id = ${req.userId}))`);
    // Withdraw outstanding invitations between them.
    await tx.execute(sql`
      delete from public.event_rsvps r using public.events e
      where r.event_id = e.id and r.status = 'invited'
        and ((e.organiser_id = ${req.userId} and r.user_id = ${other}) or (e.organiser_id = ${other} and r.user_id = ${req.userId}))`);
    await tx.execute(sql`
      delete from public.group_members m
      where m.status = 'invited' and ((m.invited_by = ${req.userId} and m.user_id = ${other}) or (m.invited_by = ${other} and m.user_id = ${req.userId}))`);
  });
  res.status(204).send();
}));

// DELETE /api/blocks/:userId
router.delete("/blocks/:userId", requireUser, handler(async (req, res) => {
  const r = await db.execute(sql`
    delete from public.user_blocks where blocker_id = ${req.userId} and blocked_id = ${uuidParam(req, "userId")} returning 1`);
  if (!r.rows.length) throw notFound();
  res.status(204).send();
}));

export default router;
