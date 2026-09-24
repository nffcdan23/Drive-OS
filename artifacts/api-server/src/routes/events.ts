import { Router } from "express";
import { sql } from "drizzle-orm";
import { requireUser } from "../middleware/auth";
import { badRequest, conflict, handler, isUuid, notFound, uuidParam } from "../lib/http";
import { Body, isTimeZone } from "../lib/validate";
import { asUser, first, type Tx } from "../lib/userDb";
import { notify } from "../lib/notify";
import { cardColumns, toCard } from "../lib/community";
import { publicUrl } from "../lib/supabaseAdmin";

const router = Router();
const EVENT_TYPES = [
  "static_car_meet", "scenic_drive", "convoy", "road_trip", "show", "track_day",
  "closed_course", "charity", "photography", "owner_club", "other",
] as const;
const VISIBILITY = ["public", "group", "private"] as const;

const eventSelect = (userId: string) => sql`
  select e.id, e.organiser_id as "organiserId", e.group_id as "groupId", e.name, e.description,
         e.cover_path as "coverPath", e.location_name as "locationName", e.lat, e.lng,
         e.starts_at as "startsAt", e.ends_at as "endsAt", e.timezone, e.event_type as "eventType",
         e.visibility, e.capacity, e.entry_cost as "entryCost", e.vehicle_category as "vehicleCategory",
         e.created_at as "createdAt", e.updated_at as "updatedAt",
         (select count(*)::int from public.event_rsvps r where r.event_id = e.id and r.status = 'going') as "goingCount",
         (select count(*)::int from public.event_rsvps r where r.event_id = e.id and r.status = 'interested') as "interestedCount",
         (select r.status from public.event_rsvps r where r.event_id = e.id and r.user_id = ${userId}) as "myRsvp",
         (select p.display_name from public.profiles p where p.id = e.organiser_id) as "organiserName"
  from public.events e`;

function present(row: Record<string, unknown>) {
  const { coverPath, ...rest } = row;
  return { ...rest, coverUrl: coverPath ? publicUrl("community-media", String(coverPath)) : null };
}

async function loadEvent(tx: Tx, userId: string, id: string) {
  const row = first<Record<string, unknown>>(await tx.execute(sql`${eventSelect(userId)} where e.id = ${id} and private.can_view_event(e.id)`));
  return row ? present(row) : undefined;
}

function readFields(b: Body, creating: boolean) {
  const f: Record<string, unknown> = {};
  if (creating || b.has("name")) f.name = b.str("name", { min: 1, max: 120 });
  if (b.has("description")) f.description = b.str("description", { max: 5000 });
  if (b.has("locationName")) f.location_name = b.str("locationName", { max: 200 });
  if (b.has("lat") || b.has("lng")) {
    f.lat = b.num("lat", { nullable: true, min: -90, max: 90 }) ?? null;
    f.lng = b.num("lng", { nullable: true, min: -180, max: 180 }) ?? null;
    if ((f.lat === null) !== (f.lng === null)) throw badRequest("invalid_input", "lat and lng go together");
  }
  if (creating || b.has("startsAt")) f.starts_at = b.timestamp("startsAt");
  if (b.has("endsAt")) f.ends_at = b.timestamp("endsAt", { nullable: true }) ?? null;
  if (b.has("timezone")) {
    const tz = b.str("timezone", { max: 64 })!;
    if (!isTimeZone(tz)) throw badRequest("invalid_input", "timezone: unknown time zone");
    f.timezone = tz;
  }
  if (b.has("eventType")) f.event_type = b.oneOf("eventType", EVENT_TYPES);
  if (b.has("visibility")) f.visibility = b.oneOf("visibility", VISIBILITY);
  if (b.has("capacity")) f.capacity = b.int("capacity", { nullable: true, min: 1, max: 100_000 }) ?? null;
  if (b.has("entryCost")) f.entry_cost = b.str("entryCost", { max: 60 });
  if (b.has("vehicleCategory")) f.vehicle_category = b.str("vehicleCategory", { max: 60 });
  return f;
}

const setList = (f: Record<string, unknown>) => sql.join(Object.entries(f).map(([k, v]) => sql`${sql.identifier(k)} = ${v}`), sql`, `);

async function requireGroupAdmin(tx: Tx, groupId: string) {
  const role = first<{ role: string | null }>(await tx.execute(sql`select private.group_role(${groupId}) as role`))?.role;
  if (role !== "owner" && role !== "admin") throw badRequest("invalid_group", "Only group admins can create events for a group.");
}

// GET /api/events?groupId=&scope=mine — upcoming events the caller may see
router.get("/events", requireUser, handler(async (req, res) => {
  const groupId = typeof req.query.groupId === "string" ? req.query.groupId : null;
  if (groupId !== null && !isUuid(groupId)) throw badRequest("invalid_input", "groupId: must be a UUID");
  const mine = req.query.scope === "mine";
  const rows = await asUser(req.userId, async (tx) => (await tx.execute(sql`
    ${eventSelect(req.userId)}
    where private.can_view_event(e.id) and coalesce(e.ends_at, e.starts_at) >= now() - interval '1 day'
      ${groupId ? sql`and e.group_id = ${groupId}` : sql``}
      ${mine ? sql`and (e.organiser_id = ${req.userId} or exists (select 1 from public.event_rsvps r where r.event_id = e.id and r.user_id = ${req.userId} and r.status in ('going', 'interested')))` : sql``}
    order by e.starts_at limit 200`)).rows as Record<string, unknown>[]);
  res.json(rows.map(present));
}));

// POST /api/events
router.post("/events", requireUser, handler(async (req, res) => {
  const b = Body.of(req);
  const f = readFields(b, true);
  const groupId = b.uuid("groupId", { optional: true, nullable: true }) ?? null;
  if (f.visibility === "group" && !groupId) throw badRequest("invalid_input", "Group events need a groupId.");
  const row = await asUser(req.userId, async (tx) => {
    if (groupId) await requireGroupAdmin(tx, groupId);
    const cols = { ...f, organiser_id: req.userId, group_id: groupId };
    const e = first<{ id: string }>(await tx.execute(sql`
      insert into public.events (${sql.join(Object.keys(cols).map((k) => sql.identifier(k)), sql`, `)})
      values (${sql.join(Object.values(cols).map((v) => sql`${v}`), sql`, `)})
      returning id`))!;
    return loadEvent(tx, req.userId, e.id);
  });
  res.status(201).json(row);
}));

// GET /api/events/:id — details plus who's going
router.get("/events/:id", requireUser, handler(async (req, res) => {
  const id = uuidParam(req, "id");
  const out = await asUser(req.userId, async (tx) => {
    const event = await loadEvent(tx, req.userId, id);
    if (!event) throw notFound();
    const going = (await tx.execute(sql`
      select ${cardColumns} from public.event_rsvps r join public.profiles p on p.id = r.user_id
      where r.event_id = ${id} and r.status = 'going'
        and (p.id = ${req.userId} or not private.is_blocked_between(p.id, ${req.userId}))
      order by r.created_at limit 200`)).rows as Record<string, unknown>[];
    return { ...event, going: going.map(toCard) };
  });
  res.json(out);
}));

// PATCH /api/events/:id — organiser only
router.patch("/events/:id", requireUser, handler(async (req, res) => {
  const id = uuidParam(req, "id");
  const b = Body.of(req);
  const f = readFields(b, false);
  if (b.has("groupId")) f.group_id = b.uuid("groupId", { nullable: true }) ?? null;
  const row = await asUser(req.userId, async (tx) => {
    const e = first<{ capacity: number | null; name: string }>(await tx.execute(sql`
      select capacity, name from public.events where id = ${id} and organiser_id = ${req.userId} for update`));
    if (!e) throw notFound();
    if (typeof f.group_id === "string") await requireGroupAdmin(tx, f.group_id);
    if (typeof f.capacity === "number") {
      const going = first<{ n: number }>(await tx.execute(sql`select count(*)::int as n from public.event_rsvps where event_id = ${id} and status = 'going'`))!.n;
      if (f.capacity < going) throw conflict("below_attendee_count", "Capacity can't be lower than the number of people going.");
    }
    if (Object.keys(f).length) await tx.execute(sql`update public.events set ${setList(f)} where id = ${id}`);
    return loadEvent(tx, req.userId, id);
  });
  res.json(row);
}));

// DELETE /api/events/:id — organiser only
router.delete("/events/:id", requireUser, handler(async (req, res) => {
  const r = await asUser(req.userId, (tx) => tx.execute(sql`delete from public.events where id = ${uuidParam(req, "id")} and organiser_id = ${req.userId} returning id`));
  if (!r.rows.length) throw notFound();
  res.status(204).send();
}));

// PUT /api/events/:id/rsvp { status: going | interested | declined }
// The event row is locked so capacity can't be exceeded by simultaneous RSVPs.
router.put("/events/:id/rsvp", requireUser, handler(async (req, res) => {
  const id = uuidParam(req, "id");
  const status = Body.of(req).oneOf("status", ["going", "interested", "declined"] as const)!;
  const row = await asUser(req.userId, async (tx) => {
    const e = first<{ capacity: number | null; endsAt: Date }>(await tx.execute(sql`
      select capacity, coalesce(ends_at, starts_at) as "endsAt" from public.events
      where id = ${id} and private.can_view_event(id) for update`));
    if (!e) throw notFound();
    if (new Date(e.endsAt).getTime() < Date.now()) throw conflict("event_finished", "This event has finished.");
    if (status === "going" && e.capacity !== null) {
      const n = first<{ n: number }>(await tx.execute(sql`
        select count(*)::int as n from public.event_rsvps where event_id = ${id} and status = 'going' and user_id <> ${req.userId}`))!.n;
      if (n >= e.capacity) throw conflict("event_full", "This event is full.");
    }
    await tx.execute(sql`
      insert into public.event_rsvps (event_id, user_id, status) values (${id}, ${req.userId}, ${status})
      on conflict (event_id, user_id) do update set status = excluded.status`);
    return loadEvent(tx, req.userId, id);
  });
  res.json(row);
}));

// DELETE /api/events/:id/rsvp — withdraw
router.delete("/events/:id/rsvp", requireUser, handler(async (req, res) => {
  const r = await asUser(req.userId, (tx) => tx.execute(sql`
    delete from public.event_rsvps where event_id = ${uuidParam(req, "id")} and user_id = ${req.userId} returning 1`));
  if (!r.rows.length) throw notFound();
  res.status(204).send();
}));

// POST /api/events/:id/invites { userId } — organiser invites a friend or a
// member of the event's group. Invitations make private events visible.
router.post("/events/:id/invites", requireUser, handler(async (req, res) => {
  const id = uuidParam(req, "id");
  const other = Body.of(req).uuid("userId")!;
  await asUser(req.userId, async (tx) => {
    const e = first<{ name: string; groupId: string | null }>(await tx.execute(sql`
      select name, group_id as "groupId" from public.events where id = ${id} and organiser_id = ${req.userId}`));
    if (!e) throw notFound();
    const ok = first<{ ok: boolean }>(await tx.execute(sql`
      select not private.is_blocked_between(${req.userId}, ${other})
             and (private.is_friend(${req.userId}, ${other})
                  or exists (select 1 from public.group_members m where m.group_id = ${e.groupId} and m.user_id = ${other} and m.status = 'active')) as ok`))?.ok;
    if (!ok) throw badRequest("cannot_invite", "You can invite friends and members of the event's group.");
    const r = await tx.execute(sql`
      insert into public.event_rsvps (event_id, user_id, status) values (${id}, ${other}, 'invited')
      on conflict (event_id, user_id) do nothing returning 1`);
    if (!r.rows.length) throw conflict("already_invited", "They've already responded or been invited.");
    await notify(tx, { userId: other, actorId: req.userId, type: "event_invite", title: `You're invited to ${e.name}`, data: { eventId: id } });
  });
  res.status(201).json({ status: "invited" });
}));

export default router;
