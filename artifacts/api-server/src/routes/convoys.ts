import { Router } from "express";
import { sql } from "drizzle-orm";
import { requireUser } from "../middleware/auth";
import { badRequest, conflict, handler, notFound, uuidParam } from "../lib/http";
import { Body } from "../lib/validate";
import { asUser, first, type Tx } from "../lib/userDb";
import { notify } from "../lib/notify";
import { cardColumns, CODE_PATTERN, normaliseCode, readJoinCode, rotateJoinCode, toCard } from "../lib/community";
import { rateLimit } from "../lib/rateLimit";

const router = Router();
const VISIBILITY = ["public", "friends", "private"] as const;
const codeLimit = rateLimit({ name: "join codes", windowMs: 60_000, max: 10 });

/** Convoy columns plus the caller's role and the participant count. */
const convoySelect = (userId: string) => sql`
  select c.id, c.owner_id as "ownerId", c.group_id as "groupId", c.name, c.description,
         c.destination_name as "destinationName", c.destination_lat as "destinationLat", c.destination_lng as "destinationLng",
         c.visibility, c.starts_at as "startsAt", c.status, c.started_at as "startedAt", c.ended_at as "endedAt",
         c.max_participants as "maxParticipants", c.created_at as "createdAt", c.updated_at as "updatedAt",
         (select count(*)::int from public.convoy_participants x where x.convoy_id = c.id) as "participantCount",
         (select x.role from public.convoy_participants x where x.convoy_id = c.id and x.user_id = ${userId}) as "myRole",
         (select p.display_name from public.profiles p where p.id = c.owner_id) as "leaderName"
  from public.convoys c`;

async function loadConvoy(tx: Tx, userId: string, id: string) {
  return first<Record<string, unknown>>(await tx.execute(sql`${convoySelect(userId)} where c.id = ${id} and private.can_view_convoy(c.id)`));
}

function readFields(b: Body, creating: boolean) {
  const f: Record<string, unknown> = {};
  if (creating || b.has("name")) f.name = b.str("name", { min: 1, max: 80 });
  if (b.has("description")) f.description = b.str("description", { max: 2000 });
  if (b.has("destinationName")) f.destination_name = b.str("destinationName", { max: 200 });
  if (b.has("destinationLat") || b.has("destinationLng")) {
    f.destination_lat = b.num("destinationLat", { nullable: true, min: -90, max: 90 }) ?? null;
    f.destination_lng = b.num("destinationLng", { nullable: true, min: -180, max: 180 }) ?? null;
    if ((f.destination_lat === null) !== (f.destination_lng === null)) throw badRequest("invalid_input", "destinationLat and destinationLng go together");
  }
  if (b.has("visibility")) f.visibility = b.oneOf("visibility", VISIBILITY);
  if (creating || b.has("startsAt")) f.starts_at = b.timestamp("startsAt");
  if (b.has("maxParticipants")) f.max_participants = b.int("maxParticipants", { nullable: true, min: 2, max: 500 }) ?? null;
  return f;
}

const setList = (f: Record<string, unknown>) => sql.join(Object.entries(f).map(([k, v]) => sql`${sql.identifier(k)} = ${v}`), sql`, `);

// GET /api/convoys?scope=mine|discover — upcoming and running convoys the
// caller may see: their own, ones they're in, public ones, friends' and
// their groups' convoys (blocks respected).
router.get("/convoys", requireUser, handler(async (req, res) => {
  const mine = req.query.scope === "mine";
  const rows = await asUser(req.userId, async (tx) => (await tx.execute(sql`
    ${convoySelect(req.userId)}
    where c.status in ('forming', 'active') and private.can_view_convoy(c.id)
      ${mine ? sql`and exists (select 1 from public.convoy_participants x where x.convoy_id = c.id and x.user_id = ${req.userId})` : sql``}
    order by c.starts_at limit 100`)).rows);
  res.json(rows);
}));

// POST /api/convoys — the creator becomes the leader
router.post("/convoys", requireUser, handler(async (req, res) => {
  const b = Body.of(req);
  const f = readFields(b, true);
  const groupId = b.uuid("groupId", { optional: true, nullable: true }) ?? null;
  const row = await asUser(req.userId, async (tx) => {
    if (groupId) {
      const role = first<{ role: string | null }>(await tx.execute(sql`select private.group_role(${groupId}) as role`))?.role;
      if (!role) throw badRequest("invalid_group", "You can only create convoys in groups you belong to.");
    }
    const created = first<{ id: string }>(await tx.execute(sql`
      insert into public.convoys (owner_id, group_id, name, description, destination_name, destination_lat, destination_lng,
                                  visibility, starts_at, max_participants)
      values (${req.userId}, ${groupId}, ${f.name}, ${f.description ?? ""}, ${f.destination_name ?? ""},
              ${f.destination_lat ?? null}, ${f.destination_lng ?? null}, ${f.visibility ?? "public"},
              ${f.starts_at}, ${f.max_participants ?? null})
      returning id`))!;
    await tx.execute(sql`insert into public.convoy_participants (convoy_id, user_id, role) values (${created.id}, ${req.userId}, 'leader')`);
    return loadConvoy(tx, req.userId, created.id);
  });
  res.status(201).json(row);
}));

// POST /api/convoys/join { code } — join any convoy (including private ones) by its code
router.post("/convoys/join", requireUser, codeLimit, handler(async (req, res) => {
  const code = normaliseCode(Body.of(req).str("code", { pattern: CODE_PATTERN })!);
  const row = await asUser(req.userId, async (tx) => {
    const target = first<{ id: string }>(await tx.execute(sql`select convoy_id as id from private.join_codes where code = ${code} and convoy_id is not null`));
    if (!target) throw notFound("invalid_code", "That code doesn't match a convoy.");
    return join(tx, req.userId, target.id, true);
  });
  res.json(row);
}));

// GET /api/convoys/:id — details and participants
router.get("/convoys/:id", requireUser, handler(async (req, res) => {
  const id = uuidParam(req, "id");
  const out = await asUser(req.userId, async (tx) => {
    const convoy = await loadConvoy(tx, req.userId, id);
    if (!convoy) throw notFound();
    const participants = (await tx.execute(sql`
      select ${cardColumns}, x.role, x.joined_at as "joinedAt"
      from public.convoy_participants x join public.profiles p on p.id = x.user_id
      where x.convoy_id = ${id} and (p.id = ${req.userId} or not private.is_blocked_between(p.id, ${req.userId}))
      order by x.role = 'leader' desc, x.joined_at`)).rows as Record<string, unknown>[];
    return { ...convoy, participants: participants.map((p) => ({ ...toCard(p), role: p.role, joinedAt: p.joinedAt })) };
  });
  res.json(out);
}));

// PATCH /api/convoys/:id — leader only. `status` moves forming → active →
// completed, or to cancelled; participants are told about changes.
router.patch("/convoys/:id", requireUser, handler(async (req, res) => {
  const id = uuidParam(req, "id");
  const b = Body.of(req);
  const f = readFields(b, false);
  const status = b.oneOf("status", ["active", "completed", "cancelled"] as const, { optional: true });
  const row = await asUser(req.userId, async (tx) => {
    const c = first<{ status: string; name: string; count: number }>(await tx.execute(sql`
      select status, name, (select count(*)::int from public.convoy_participants x where x.convoy_id = c.id) as count
      from public.convoys c where id = ${id} and owner_id = ${req.userId} for update`));
    if (!c) throw notFound();
    if (c.status === "completed" || c.status === "cancelled") throw conflict("convoy_closed", "This convoy has finished.");
    if (typeof f.max_participants === "number" && f.max_participants < c.count) {
      throw conflict("below_participant_count", "The limit can't be lower than the current number of participants.");
    }
    if (status) {
      if (status === "completed" && c.status !== "active") throw conflict("invalid_status", "Only a running convoy can be completed.");
      if (status === "active" && c.status !== "forming") throw conflict("invalid_status", "The convoy has already started.");
      f.status = status;
      if (status === "active") f.started_at = new Date();
      if (status === "completed") f.ended_at = new Date();
    }
    if (Object.keys(f).length) await tx.execute(sql`update public.convoys set ${setList(f)} where id = ${id}`);

    // Leading a convoy with at least one other driver to the end earns Convoy Leader (once).
    if (status === "completed" && c.count >= 2) {
      const won = first<{ xp: number; title: string }>(await tx.execute(sql`
        with ins as (
          insert into public.user_achievements (user_id, achievement_id) values (${req.userId}, 'convoy_leader')
          on conflict do nothing returning achievement_id)
        select a.xp_reward as xp, a.title from public.achievements a join ins on ins.achievement_id = a.id`));
      if (won) {
        await tx.execute(sql`update public.profiles set xp = xp + ${won.xp} where id = ${req.userId}`);
        await notify(tx, { userId: req.userId, type: "achievement_unlocked", title: `Achievement unlocked: ${won.title}`, body: `+${won.xp} XP`, data: { achievementId: "convoy_leader" } });
      }
    }

    if (status === "cancelled" || f.starts_at !== undefined) {
      const members = (await tx.execute(sql`select user_id as id from public.convoy_participants where convoy_id = ${id} and user_id <> ${req.userId}`)).rows as { id: string }[];
      for (const m of members) {
        await notify(tx, status === "cancelled"
          ? { userId: m.id, actorId: req.userId, type: "convoy_cancelled", title: `${c.name} was cancelled`, data: { convoyId: id } }
          : { userId: m.id, actorId: req.userId, type: "convoy_updated", title: `${c.name} has a new start time`, data: { convoyId: id } });
      }
    }
    return loadConvoy(tx, req.userId, id);
  });
  res.json(row);
}));

// DELETE /api/convoys/:id — leader only
router.delete("/convoys/:id", requireUser, handler(async (req, res) => {
  const r = await asUser(req.userId, async (tx) => tx.execute(sql`delete from public.convoys where id = ${uuidParam(req, "id")} and owner_id = ${req.userId} returning id`));
  if (!r.rows.length) throw notFound();
  res.status(204).send();
}));

/**
 * Adds the user to a convoy under a row lock, so the participant limit can't
 * be exceeded by simultaneous joins. Without a code, the convoy must be
 * visible to the user (public, a friend's, or their group's). Blocked users
 * can never join, even with a code.
 */
async function join(tx: Tx, userId: string, convoyId: string, viaCode: boolean) {
  const c = first<{ ownerId: string; status: string; max: number | null; name: string }>(await tx.execute(sql`
    select owner_id as "ownerId", status, max_participants as max, name from public.convoys where id = ${convoyId} for update`));
  if (!c) throw notFound();
  const already = first(await tx.execute(sql`select 1 from public.convoy_participants where convoy_id = ${convoyId} and user_id = ${userId}`));
  if (already) return loadConvoy(tx, userId, convoyId);
  const blocked = first<{ b: boolean }>(await tx.execute(sql`select private.is_blocked_between(${c.ownerId}, ${userId}) as b`))?.b;
  if (blocked) throw notFound();
  if (!viaCode) {
    const visible = first<{ v: boolean }>(await tx.execute(sql`select private.can_view_convoy(${convoyId}) as v`))?.v;
    if (!visible) throw notFound();
  }
  if (c.status !== "forming" && c.status !== "active") throw conflict("convoy_closed", "This convoy has finished.");
  if (c.max !== null) {
    const n = first<{ n: number }>(await tx.execute(sql`select count(*)::int as n from public.convoy_participants where convoy_id = ${convoyId}`))!.n;
    if (n >= c.max) throw conflict("convoy_full", "This convoy is full.");
  }
  await tx.execute(sql`insert into public.convoy_participants (convoy_id, user_id, role) values (${convoyId}, ${userId}, 'member')`);
  await notify(tx, { userId: c.ownerId, actorId: userId, type: "convoy_updated", title: `Someone joined ${c.name}`, data: { convoyId, userId } });
  return loadConvoy(tx, userId, convoyId);
}

// POST /api/convoys/:id/join — for convoys the caller can see
router.post("/convoys/:id/join", requireUser, handler(async (req, res) => {
  const id = uuidParam(req, "id");
  res.json(await asUser(req.userId, (tx) => join(tx, req.userId, id, false)));
}));

// POST /api/convoys/:id/leave — the leader can't leave (cancel instead)
router.post("/convoys/:id/leave", requireUser, handler(async (req, res) => {
  const id = uuidParam(req, "id");
  await asUser(req.userId, async (tx) => {
    const p = first<{ role: string }>(await tx.execute(sql`select role from public.convoy_participants where convoy_id = ${id} and user_id = ${req.userId}`));
    if (!p) throw notFound();
    if (p.role === "leader") throw conflict("leader_cannot_leave", "The leader can't leave; cancel the convoy instead.");
    await tx.execute(sql`delete from public.convoy_participants where convoy_id = ${id} and user_id = ${req.userId}`);
  });
  res.status(204).send();
}));

// DELETE /api/convoys/:id/participants/:userId — leader removes someone
router.delete("/convoys/:id/participants/:userId", requireUser, handler(async (req, res) => {
  const id = uuidParam(req, "id");
  const other = uuidParam(req, "userId");
  await asUser(req.userId, async (tx) => {
    if (!first(await tx.execute(sql`select 1 from public.convoys where id = ${id} and owner_id = ${req.userId}`))) throw notFound();
    if (other === req.userId) throw conflict("leader_cannot_leave");
    const r = await tx.execute(sql`delete from public.convoy_participants where convoy_id = ${id} and user_id = ${other} returning 1`);
    if (!r.rows.length) throw notFound();
  });
  res.status(204).send();
}));

// GET /api/convoys/:id/code — leader only; POST creates or replaces it
router.get("/convoys/:id/code", requireUser, handler(async (req, res) => {
  const id = uuidParam(req, "id");
  const code = await asUser(req.userId, async (tx) => {
    if (!first(await tx.execute(sql`select 1 from public.convoys where id = ${id} and owner_id = ${req.userId}`))) throw notFound();
    return readJoinCode(tx, { convoyId: id });
  });
  res.json({ code });
}));

router.post("/convoys/:id/code", requireUser, handler(async (req, res) => {
  const id = uuidParam(req, "id");
  const code = await asUser(req.userId, async (tx) => {
    const c = first<{ status: string }>(await tx.execute(sql`select status from public.convoys where id = ${id} and owner_id = ${req.userId} for update`));
    if (!c) throw notFound();
    if (c.status === "completed" || c.status === "cancelled") throw conflict("convoy_closed");
    return rotateJoinCode(tx, { convoyId: id });
  });
  res.status(201).json({ code });
}));

// DELETE /api/convoys/:id/code — stop joining by code
router.delete("/convoys/:id/code", requireUser, handler(async (req, res) => {
  const id = uuidParam(req, "id");
  await asUser(req.userId, async (tx) => {
    if (!first(await tx.execute(sql`select 1 from public.convoys where id = ${id} and owner_id = ${req.userId}`))) throw notFound();
    await tx.execute(sql`delete from private.join_codes where convoy_id = ${id}`);
  });
  res.status(204).send();
}));

export default router;
