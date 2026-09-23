import { Router } from "express";
import { sql } from "drizzle-orm";
import { requireUser } from "../middleware/auth";
import { badRequest, conflict, forbidden, handler, notFound, uuidParam } from "../lib/http";
import { Body } from "../lib/validate";
import { asUser, first, type Tx } from "../lib/userDb";
import { notify } from "../lib/notify";
import { cardColumns, CODE_PATTERN, normaliseCode, readJoinCode, rotateJoinCode, toCard } from "../lib/community";
import { publicUrl } from "../lib/supabaseAdmin";
import { rateLimit } from "../lib/rateLimit";

const router = Router();
const METHODS = ["open", "request", "invite", "code"] as const;
const codeLimit = rateLimit({ name: "join codes", windowMs: 60_000, max: 10 });

const groupSelect = (userId: string) => sql`
  select g.id, g.owner_id as "ownerId", g.name, g.description, g.logo_path as "logoPath", g.is_public as "isPublic",
         g.membership_method as "membershipMethod", g.primary_location as "primaryLocation",
         g.vehicle_interests as "vehicleInterests", g.created_at as "createdAt", g.updated_at as "updatedAt",
         (select count(*)::int from public.group_members m where m.group_id = g.id and m.status = 'active') as "memberCount",
         (select m.role from public.group_members m where m.group_id = g.id and m.user_id = ${userId}) as "myRole",
         (select m.status from public.group_members m where m.group_id = g.id and m.user_id = ${userId}) as "myStatus"
  from public.groups g`;

function present(row: Record<string, unknown>) {
  const { logoPath, ...rest } = row;
  return { ...rest, logoUrl: logoPath ? publicUrl("community-media", String(logoPath)) : null };
}

async function loadGroup(tx: Tx, userId: string, id: string) {
  const row = first<Record<string, unknown>>(await tx.execute(sql`${groupSelect(userId)} where g.id = ${id} and private.can_view_group(g.id)`));
  return row ? present(row) : undefined;
}

/** The caller's active role in the group (owner/admin/member), or null. */
async function myRole(tx: Tx, groupId: string): Promise<string | null> {
  return first<{ role: string | null }>(await tx.execute(sql`select private.group_role(${groupId}) as role`))?.role ?? null;
}

async function requireAdmin(tx: Tx, groupId: string): Promise<string> {
  const role = await myRole(tx, groupId);
  if (role === "owner" || role === "admin") return role;
  if (role) throw forbidden("admins_only", "Only group admins can do that.");
  throw notFound();
}

function readFields(b: Body, creating: boolean) {
  const f: Record<string, unknown> = {};
  if (creating || b.has("name")) f.name = b.str("name", { min: 1, max: 80 });
  if (b.has("description")) f.description = b.str("description", { max: 2000 });
  if (b.has("isPublic")) f.is_public = b.bool("isPublic");
  if (b.has("membershipMethod")) f.membership_method = b.oneOf("membershipMethod", METHODS);
  if (b.has("primaryLocation")) f.primary_location = b.str("primaryLocation", { max: 120 });
  if (b.has("vehicleInterests")) f.vehicle_interests = b.str("vehicleInterests", { max: 300 });
  return f;
}

const setList = (f: Record<string, unknown>) => sql.join(Object.entries(f).map(([k, v]) => sql`${sql.identifier(k)} = ${v}`), sql`, `);

async function adminIds(tx: Tx, groupId: string): Promise<string[]> {
  const r = await tx.execute(sql`select user_id as id from public.group_members where group_id = ${groupId} and status = 'active' and role in ('owner', 'admin')`);
  return (r.rows as { id: string }[]).map((x) => x.id);
}

// GET /api/groups?scope=mine — public groups plus the caller's own
router.get("/groups", requireUser, handler(async (req, res) => {
  const mine = req.query.scope === "mine";
  const rows = await asUser(req.userId, async (tx) => (await tx.execute(sql`
    ${groupSelect(req.userId)}
    where private.can_view_group(g.id)
      and (g.owner_id = ${req.userId} or not private.is_blocked_between(g.owner_id, ${req.userId}))
    order by g.created_at desc limit 200`)).rows as Record<string, unknown>[]);
  res.json(rows.filter((g) => !mine || g.myStatus === "active").map(present));
}));

// POST /api/groups — the creator becomes the owner
router.post("/groups", requireUser, handler(async (req, res) => {
  const f = readFields(Body.of(req), true);
  const row = await asUser(req.userId, async (tx) => {
    const g = first<{ id: string }>(await tx.execute(sql`
      insert into public.groups (owner_id, name, description, is_public, membership_method, primary_location, vehicle_interests)
      values (${req.userId}, ${f.name}, ${f.description ?? ""}, ${f.is_public ?? true}, ${f.membership_method ?? "open"},
              ${f.primary_location ?? ""}, ${f.vehicle_interests ?? ""})
      returning id`))!;
    await tx.execute(sql`insert into public.group_members (group_id, user_id, role, status) values (${g.id}, ${req.userId}, 'owner', 'active')`);
    return loadGroup(tx, req.userId, g.id);
  });
  res.status(201).json(row);
}));

// POST /api/groups/join { code } — join a group (public or not) by its code
router.post("/groups/join", requireUser, codeLimit, handler(async (req, res) => {
  const code = normaliseCode(Body.of(req).str("code", { pattern: CODE_PATTERN })!);
  const row = await asUser(req.userId, async (tx) => {
    const target = first<{ id: string }>(await tx.execute(sql`select group_id as id from private.join_codes where code = ${code} and group_id is not null`));
    if (!target) throw notFound("invalid_code", "That code doesn't match a group.");
    return join(tx, req.userId, target.id, true);
  });
  res.json(row);
}));

// GET /api/groups/:id — details, active members; admins also see pending
// requests and outstanding invitations.
router.get("/groups/:id", requireUser, handler(async (req, res) => {
  const id = uuidParam(req, "id");
  const out = await asUser(req.userId, async (tx) => {
    const group = await loadGroup(tx, req.userId, id);
    if (!group) throw notFound();
    const role = await myRole(tx, id);
    const isAdmin = role === "owner" || role === "admin";
    const members = (await tx.execute(sql`
      select ${cardColumns}, m.role, m.status, m.joined_at as "joinedAt"
      from public.group_members m join public.profiles p on p.id = m.user_id
      where m.group_id = ${id} and (m.status = 'active' or ${isAdmin})
        and (p.id = ${req.userId} or not private.is_blocked_between(p.id, ${req.userId}))
      order by case m.role when 'owner' then 0 when 'admin' then 1 else 2 end, m.joined_at
      limit 500`)).rows as Record<string, unknown>[];
    return { ...group, members: members.map((m) => ({ ...toCard(m), role: m.role, status: m.status, joinedAt: m.joinedAt })) };
  });
  res.json(out);
}));

// PATCH /api/groups/:id — owner or admin
router.patch("/groups/:id", requireUser, handler(async (req, res) => {
  const id = uuidParam(req, "id");
  const f = readFields(Body.of(req), false);
  const row = await asUser(req.userId, async (tx) => {
    await requireAdmin(tx, id);
    if (Object.keys(f).length) await tx.execute(sql`update public.groups set ${setList(f)} where id = ${id}`);
    return loadGroup(tx, req.userId, id);
  });
  res.json(row);
}));

// DELETE /api/groups/:id — owner only
router.delete("/groups/:id", requireUser, handler(async (req, res) => {
  const r = await asUser(req.userId, (tx) => tx.execute(sql`delete from public.groups where id = ${uuidParam(req, "id")} and owner_id = ${req.userId} returning id`));
  if (!r.rows.length) throw notFound();
  res.status(204).send();
}));

/**
 * Joins under a row lock on the group. Invited users accept their
 * invitation; otherwise the membership method decides: open → member,
 * request → pending approval, invite → refused, code → only with the code.
 * Blocked users can't join a group whose owner they are blocked with.
 */
async function join(tx: Tx, userId: string, groupId: string, viaCode: boolean) {
  const g = first<{ ownerId: string; method: string; name: string }>(await tx.execute(sql`
    select owner_id as "ownerId", membership_method as method, name from public.groups where id = ${groupId} for update`));
  if (!g) throw notFound();
  if (first<{ b: boolean }>(await tx.execute(sql`select private.is_blocked_between(${g.ownerId}, ${userId}) as b`))?.b) throw notFound();
  if (!viaCode && !first<{ v: boolean }>(await tx.execute(sql`select private.can_view_group(${groupId}) as v`))?.v) throw notFound();

  const existing = first<{ status: string }>(await tx.execute(sql`select status from public.group_members where group_id = ${groupId} and user_id = ${userId} for update`));
  if (existing?.status === "active") return loadGroup(tx, userId, groupId);
  if (existing?.status === "pending" && !viaCode) throw conflict("request_pending", "Your request to join is waiting for approval.");

  let status: "active" | "pending";
  if (existing?.status === "invited" || viaCode || g.method === "open") status = "active";
  else if (g.method === "request") status = "pending";
  else if (g.method === "invite") throw forbidden("invite_only", "This group is invite-only.");
  else throw forbidden("code_required", "This group needs a join code.");

  await tx.execute(sql`
    insert into public.group_members (group_id, user_id, role, status) values (${groupId}, ${userId}, 'member', ${status})
    on conflict (group_id, user_id) do update set status = excluded.status`);
  if (status === "pending") {
    for (const admin of await adminIds(tx, groupId)) {
      await notify(tx, { userId: admin, actorId: userId, type: "group_news", title: `New request to join ${g.name}`, data: { groupId, userId } });
    }
  }
  return loadGroup(tx, userId, groupId);
}

// POST /api/groups/:id/join
router.post("/groups/:id/join", requireUser, handler(async (req, res) => {
  const id = uuidParam(req, "id");
  res.json(await asUser(req.userId, (tx) => join(tx, req.userId, id, false)));
}));

// POST /api/groups/:id/leave — also withdraws a pending request or declines
// an invitation. The owner can't leave (delete the group instead).
router.post("/groups/:id/leave", requireUser, handler(async (req, res) => {
  const id = uuidParam(req, "id");
  await asUser(req.userId, async (tx) => {
    const m = first<{ role: string }>(await tx.execute(sql`select role from public.group_members where group_id = ${id} and user_id = ${req.userId}`));
    if (!m) throw notFound();
    if (m.role === "owner") throw conflict("owner_cannot_leave", "The owner can't leave; delete the group instead.");
    await tx.execute(sql`delete from public.group_members where group_id = ${id} and user_id = ${req.userId}`);
  });
  res.status(204).send();
}));

// POST /api/groups/:id/invites { userId } — admins invite their friends
router.post("/groups/:id/invites", requireUser, handler(async (req, res) => {
  const id = uuidParam(req, "id");
  const other = Body.of(req).uuid("userId")!;
  await asUser(req.userId, async (tx) => {
    await requireAdmin(tx, id);
    const ok = first<{ ok: boolean }>(await tx.execute(sql`
      select private.is_friend(${req.userId}, ${other}) and not private.is_blocked_between(${req.userId}, ${other}) as ok`))?.ok;
    if (!ok) throw badRequest("not_a_friend", "You can only invite your friends.");
    const r = await tx.execute(sql`
      insert into public.group_members (group_id, user_id, role, status, invited_by)
      values (${id}, ${other}, 'member', 'invited', ${req.userId})
      on conflict (group_id, user_id) do nothing returning 1`);
    if (!r.rows.length) throw conflict("already_member", "They're already a member or invited.");
    const name = first<{ n: string }>(await tx.execute(sql`select name as n from public.groups where id = ${id}`))!.n;
    await notify(tx, { userId: other, actorId: req.userId, type: "group_invite", title: `You're invited to join ${name}`, data: { groupId: id } });
  });
  res.status(201).json({ status: "invited" });
}));

// POST /api/groups/:id/members/:userId/approve | decline — admins handle requests
router.post("/groups/:id/members/:userId/:decision", requireUser, handler(async (req, res) => {
  const id = uuidParam(req, "id");
  const other = uuidParam(req, "userId");
  const decision = req.params.decision;
  if (decision !== "approve" && decision !== "decline") throw notFound();
  await asUser(req.userId, async (tx) => {
    await requireAdmin(tx, id);
    const r = decision === "approve"
      ? await tx.execute(sql`update public.group_members set status = 'active', joined_at = now() where group_id = ${id} and user_id = ${other} and status = 'pending' returning 1`)
      : await tx.execute(sql`delete from public.group_members where group_id = ${id} and user_id = ${other} and status = 'pending' returning 1`);
    if (!r.rows.length) throw notFound();
    const name = first<{ n: string }>(await tx.execute(sql`select name as n from public.groups where id = ${id}`))!.n;
    await notify(tx, { userId: other, actorId: req.userId, type: "group_request_result",
      title: decision === "approve" ? `You've joined ${name}` : `Your request to join ${name} wasn't accepted`, data: { groupId: id } });
  });
  res.json({ status: decision === "approve" ? "active" : "declined" });
}));

// PATCH /api/groups/:id/members/:userId { role } — owner promotes/demotes admins
router.patch("/groups/:id/members/:userId", requireUser, handler(async (req, res) => {
  const id = uuidParam(req, "id");
  const other = uuidParam(req, "userId");
  const role = Body.of(req).oneOf("role", ["admin", "member"] as const)!;
  await asUser(req.userId, async (tx) => {
    if ((await myRole(tx, id)) !== "owner") throw forbidden("owner_only", "Only the owner can change roles.");
    const r = await tx.execute(sql`update public.group_members set role = ${role} where group_id = ${id} and user_id = ${other} and status = 'active' and role <> 'owner' returning 1`);
    if (!r.rows.length) throw notFound();
  });
  res.json({ role });
}));

// DELETE /api/groups/:id/members/:userId — admins remove members; only the
// owner can remove an admin; nobody can remove the owner.
router.delete("/groups/:id/members/:userId", requireUser, handler(async (req, res) => {
  const id = uuidParam(req, "id");
  const other = uuidParam(req, "userId");
  await asUser(req.userId, async (tx) => {
    const role = await requireAdmin(tx, id);
    const r = await tx.execute(sql`
      delete from public.group_members
      where group_id = ${id} and user_id = ${other} and role <> 'owner' and (role = 'member' or ${role === "owner"})
      returning 1`);
    if (!r.rows.length) throw notFound();
  });
  res.status(204).send();
}));

// GET/POST/DELETE /api/groups/:id/code — admins manage the join code
router.get("/groups/:id/code", requireUser, handler(async (req, res) => {
  const id = uuidParam(req, "id");
  res.json({ code: await asUser(req.userId, async (tx) => { await requireAdmin(tx, id); return readJoinCode(tx, { groupId: id }); }) });
}));

router.post("/groups/:id/code", requireUser, handler(async (req, res) => {
  const id = uuidParam(req, "id");
  res.status(201).json({ code: await asUser(req.userId, async (tx) => { await requireAdmin(tx, id); return rotateJoinCode(tx, { groupId: id }); }) });
}));

router.delete("/groups/:id/code", requireUser, handler(async (req, res) => {
  const id = uuidParam(req, "id");
  await asUser(req.userId, async (tx) => {
    await requireAdmin(tx, id);
    await tx.execute(sql`delete from private.join_codes where group_id = ${id}`);
  });
  res.status(204).send();
}));

export default router;
