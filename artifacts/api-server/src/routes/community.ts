import { Router } from 'express';
import { param } from '../utils/param';
import {
  db, users, convoys, convoyParticipants,
  groups, groupMembers, events, eventRsvps,
  friendships, friendRequests,
} from '@workspace/db';
import { eq, and, or, desc } from 'drizzle-orm';
import { requireUser } from '../middleware/userId';

const router = Router();

// ─── Convoys ──────────────────────────────────────────────────────────────────

router.get('/convoys', requireUser, async (req, res, next) => {
  try {
    // Public convoys + user's own
    const rows = await db
      .select()
      .from(convoys)
      .orderBy(desc(convoys.createdAt))
      .limit(50);
    res.json(rows);
  } catch (err) { next(err); }
});

router.post('/convoys', requireUser, async (req, res, next) => {
  try {
    const body = req.body as Partial<typeof convoys.$inferInsert>;
    const [row] = await db
      .insert(convoys)
      .values({
        ownerId:         req.userId,
        name:            body.name            ?? 'New Convoy',
        destination:     body.destination     ?? '',
        isPrivate:       body.isPrivate       ?? false,
        startTime:       body.startTime       ?? new Date().toISOString(),
        description:     body.description     ?? '',
        maxParticipants: body.maxParticipants ?? null,
      })
      .returning();
    // Auto-join as owner
    await db.insert(convoyParticipants).values({ convoyId: row.id, userId: req.userId });
    res.status(201).json(row);
  } catch (err) { next(err); }
});

router.put('/convoys/:id', requireUser, async (req, res, next) => {
  try {
    const body = req.body as Partial<typeof convoys.$inferInsert>;
    const [row] = await db
      .update(convoys)
      .set({
        name:            body.name,
        destination:     body.destination,
        isPrivate:       body.isPrivate,
        startTime:       body.startTime,
        description:     body.description,
        status:          body.status,
        maxParticipants: body.maxParticipants,
      })
      .where(and(eq(convoys.id, param(req.params.id)), eq(convoys.ownerId, req.userId)))
      .returning();
    if (!row) { res.status(404).json({ error: 'Not found or not owner' }); return; }
    res.json(row);
  } catch (err) { next(err); }
});

router.delete('/convoys/:id', requireUser, async (req, res, next) => {
  try {
    await db.delete(convoys).where(and(eq(convoys.id, param(req.params.id)), eq(convoys.ownerId, req.userId)));
    res.status(204).send();
  } catch (err) { next(err); }
});

router.post('/convoys/:id/join', requireUser, async (req, res, next) => {
  try {
    await db
      .insert(convoyParticipants)
      .values({ convoyId: param(req.params.id), userId: req.userId })
      .onConflictDoNothing();
    res.status(204).send();
  } catch (err) { next(err); }
});

router.post('/convoys/:id/leave', requireUser, async (req, res, next) => {
  try {
    await db
      .delete(convoyParticipants)
      .where(
        and(
          eq(convoyParticipants.convoyId, param(req.params.id)),
          eq(convoyParticipants.userId, req.userId),
        ),
      );
    res.status(204).send();
  } catch (err) { next(err); }
});

// ─── Groups ───────────────────────────────────────────────────────────────────

router.get('/groups', requireUser, async (req, res, next) => {
  try {
    const rows = await db.select().from(groups).orderBy(desc(groups.createdAt)).limit(50);
    res.json(rows);
  } catch (err) { next(err); }
});

router.post('/groups', requireUser, async (req, res, next) => {
  try {
    const body = req.body as Partial<typeof groups.$inferInsert>;
    const [row] = await db
      .insert(groups)
      .values({
        ownerId:          req.userId,
        name:             body.name             ?? 'New Group',
        description:      body.description      ?? '',
        logoUrl:          body.logoUrl          ?? null,
        isPublic:         body.isPublic         ?? true,
        membershipMethod: body.membershipMethod ?? 'open',
        primaryLocation:  body.primaryLocation  ?? '',
        vehicleInterests: body.vehicleInterests ?? '',
      })
      .returning();
    await db.insert(groupMembers).values({ groupId: row.id, userId: req.userId, role: 'owner' });
    res.status(201).json(row);
  } catch (err) { next(err); }
});

router.put('/groups/:id', requireUser, async (req, res, next) => {
  try {
    const body = req.body as Partial<typeof groups.$inferInsert>;
    const [row] = await db
      .update(groups)
      .set({
        name:             body.name,
        description:      body.description,
        logoUrl:          body.logoUrl,
        isPublic:         body.isPublic,
        membershipMethod: body.membershipMethod,
        primaryLocation:  body.primaryLocation,
        vehicleInterests: body.vehicleInterests,
      })
      .where(and(eq(groups.id, param(req.params.id)), eq(groups.ownerId, req.userId)))
      .returning();
    if (!row) { res.status(404).json({ error: 'Not found or not owner' }); return; }
    res.json(row);
  } catch (err) { next(err); }
});

router.post('/groups/:id/join', requireUser, async (req, res, next) => {
  try {
    await db
      .insert(groupMembers)
      .values({ groupId: param(req.params.id), userId: req.userId, role: 'member' })
      .onConflictDoNothing();
    res.status(204).send();
  } catch (err) { next(err); }
});

router.post('/groups/:id/leave', requireUser, async (req, res, next) => {
  try {
    await db
      .delete(groupMembers)
      .where(
        and(
          eq(groupMembers.groupId, param(req.params.id)),
          eq(groupMembers.userId, req.userId),
        ),
      );
    res.status(204).send();
  } catch (err) { next(err); }
});

// ─── Events ───────────────────────────────────────────────────────────────────

router.get('/events', requireUser, async (req, res, next) => {
  try {
    const rows = await db.select().from(events).orderBy(desc(events.createdAt)).limit(50);
    res.json(rows);
  } catch (err) { next(err); }
});

router.post('/events', requireUser, async (req, res, next) => {
  try {
    const body = req.body as Partial<typeof events.$inferInsert>;
    const now = new Date();
    const [row] = await db
      .insert(events)
      .values({
        organiserId:     req.userId,
        groupId:         body.groupId         ?? null,
        name:            body.name            ?? 'New Event',
        description:     body.description     ?? '',
        coverUrl:        body.coverUrl        ?? null,
        location:        body.location        ?? '',
        date:            body.date            ?? now.toISOString().split('T')[0],
        startTime:       body.startTime       ?? '09:00',
        endTime:         body.endTime         ?? '17:00',
        eventType:       body.eventType       ?? 'other',
        isPublic:        body.isPublic        ?? true,
        capacity:        body.capacity        ?? 0,
        entryCost:       body.entryCost       ?? 'Free',
        vehicleCategory: body.vehicleCategory ?? 'All',
      })
      .returning();
    res.status(201).json(row);
  } catch (err) { next(err); }
});

router.post('/events/:id/rsvp', requireUser, async (req, res, next) => {
  try {
    const { status } = req.body as { status: string };
    if (!['going','interested','declined'].includes(status)) {
      res.status(400).json({ error: 'Invalid status' });
      return;
    }
    await db
      .insert(eventRsvps)
      .values({ eventId: param(req.params.id), userId: req.userId, status })
      .onConflictDoUpdate({
        target: [eventRsvps.eventId, eventRsvps.userId],
        set:    { status },
      });
    res.status(204).send();
  } catch (err) { next(err); }
});

// ─── Friends ─────────────────────────────────────────────────────────────────

router.get('/friends', requireUser, async (req, res, next) => {
  try {
    const rows = await db
      .select({
        id:        users.id,
        name:      users.name,
        username:  users.username,
        level:     users.level,
        friendCode: users.friendCode,
      })
      .from(friendships)
      .innerJoin(users, eq(users.id, friendships.friendId))
      .where(eq(friendships.userId, req.userId));
    res.json(rows);
  } catch (err) { next(err); }
});

router.delete('/friends/:friendId', requireUser, async (req, res, next) => {
  try {
    await db
      .delete(friendships)
      .where(
        or(
          and(eq(friendships.userId, req.userId), eq(friendships.friendId, param(req.params.friendId))),
          and(eq(friendships.userId, param(req.params.friendId)), eq(friendships.friendId, req.userId)),
        ),
      );
    res.status(204).send();
  } catch (err) { next(err); }
});

// GET /api/friend-requests
router.get('/friend-requests', requireUser, async (req, res, next) => {
  try {
    const rows = await db
      .select()
      .from(friendRequests)
      .where(eq(friendRequests.fromId, req.userId))
      .orderBy(desc(friendRequests.createdAt));
    res.json(rows);
  } catch (err) { next(err); }
});

// POST /api/friend-requests – send by friend code
router.post('/friend-requests', requireUser, async (req, res, next) => {
  try {
    const { friendCode } = req.body as { friendCode: string };
    if (!friendCode) { res.status(400).json({ error: 'friendCode required' }); return; }

    const [row] = await db
      .insert(friendRequests)
      .values({ fromId: req.userId, toFriendCode: friendCode.toUpperCase() })
      .returning();

    res.status(201).json(row);
  } catch (err) { next(err); }
});

// PUT /api/friend-requests/:id/accept
router.put('/friend-requests/:id/accept', requireUser, async (req, res, next) => {
  try {
    // Look up the request
    const [req2] = await db
      .select()
      .from(friendRequests)
      .where(eq(friendRequests.id, param(req.params.id)))
      .limit(1);

    if (!req2 || req2.status !== 'pending') {
      res.status(404).json({ error: 'Request not found or already handled' });
      return;
    }

    // Find the sender
    const [sender] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, req2.fromId))
      .limit(1);

    if (!sender) { res.status(404).json({ error: 'Sender not found' }); return; }

    // Create mutual friendship
    await db
      .insert(friendships)
      .values([
        { userId: req.userId, friendId: sender.id },
        { userId: sender.id, friendId: req.userId },
      ])
      .onConflictDoNothing();

    // Update request status
    await db
      .update(friendRequests)
      .set({ status: 'accepted' })
      .where(eq(friendRequests.id, param(req.params.id)));

    res.status(204).send();
  } catch (err) { next(err); }
});

// PUT /api/friend-requests/:id/decline
router.put('/friend-requests/:id/decline', requireUser, async (req, res, next) => {
  try {
    await db
      .update(friendRequests)
      .set({ status: 'declined' })
      .where(eq(friendRequests.id, param(req.params.id)));
    res.status(204).send();
  } catch (err) { next(err); }
});

export default router;
