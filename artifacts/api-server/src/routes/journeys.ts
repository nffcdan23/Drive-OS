import { Router } from 'express';
import { param } from '../utils/param';
import { db, journeys, journeyRoutePoints, users } from '@workspace/db';
import { eq, and, desc, sql } from 'drizzle-orm';
import { requireUser } from '../middleware/userId';

const router = Router();

// GET /api/journeys
router.get('/journeys', requireUser, async (req, res, next) => {
  try {
    const rows = await db
      .select()
      .from(journeys)
      .where(and(eq(journeys.userId, req.userId), eq(journeys.status, 'completed')))
      .orderBy(desc(journeys.createdAt));
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// POST /api/journeys – start a new in-progress journey
router.post('/journeys', requireUser, async (req, res, next) => {
  try {
    const body = req.body as {
      vehicleId?: string;
      vehicleSnapshot?: unknown;
      name?: string;
      date?: string;
      startTimeIso?: string;
      journeyType?: string;
    };

    const now = new Date();
    const dateStr = body.date ?? now.toISOString().split('T')[0];
    const startIso = body.startTimeIso ?? now.toISOString();

    const [row] = await db
      .insert(journeys)
      .values({
        userId:          req.userId,
        vehicleId:       body.vehicleId       ?? null,
        vehicleSnapshot: body.vehicleSnapshot ?? null,
        name:            body.name            ?? 'Active Journey',
        date:            dateStr,
        startTimeIso:    startIso,
        journeyType:     body.journeyType     ?? 'personal',
        status:          'active',
      })
      .returning();

    res.status(201).json(row);
  } catch (err) {
    next(err);
  }
});

// GET /api/journeys/:id
router.get('/journeys/:id', requireUser, async (req, res, next) => {
  try {
    const [row] = await db
      .select()
      .from(journeys)
      .where(and(eq(journeys.id, param(req.params.id)), eq(journeys.userId, req.userId)))
      .limit(1);
    if (!row) { res.status(404).json({ error: 'Not found' }); return; }
    res.json(row);
  } catch (err) {
    next(err);
  }
});

// PUT /api/journeys/:id – update metadata
router.put('/journeys/:id', requireUser, async (req, res, next) => {
  try {
    const body = req.body as Partial<typeof journeys.$inferInsert>;
    const allowed: Partial<typeof journeys.$inferInsert> = { updatedAt: new Date() };
    const fields = ['name','notes','categoryId','privacy','photos','journeyType'] as const;
    for (const f of fields) {
      if (body[f] !== undefined) (allowed as Record<string, unknown>)[f] = body[f];
    }

    const [row] = await db
      .update(journeys)
      .set(allowed)
      .where(and(eq(journeys.id, param(req.params.id)), eq(journeys.userId, req.userId)))
      .returning();

    if (!row) { res.status(404).json({ error: 'Not found' }); return; }
    res.json(row);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/journeys/:id
router.delete('/journeys/:id', requireUser, async (req, res, next) => {
  try {
    await db
      .delete(journeys)
      .where(and(eq(journeys.id, param(req.params.id)), eq(journeys.userId, req.userId)));
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// POST /api/journeys/:id/route-points – batch append GPS coordinates during a drive
router.post('/journeys/:id/route-points', requireUser, async (req, res, next) => {
  try {
    const body = req.body as {
      points: Array<{
        latitude: number;
        longitude: number;
        speedKmh?: number;
        accuracyM?: number;
        recordedAt: string;
      }>;
    };

    if (!Array.isArray(body.points) || body.points.length === 0) {
      res.status(400).json({ error: 'points array required' });
      return;
    }

    const journeyId = param(req.params.id);
    const userId    = req.userId;

    const pointRows = body.points.map((p) => ({
      journeyId,
      latitude:   p.latitude,
      longitude:  p.longitude,
      speedKmh:   p.speedKmh   ?? 0,
      accuracyM:  p.accuracyM  ?? null,
      recordedAt: new Date(p.recordedAt),
    }));

    // Wrap check + insert in a transaction using SELECT … FOR UPDATE to lock
    // the journey row.  A concurrent /journeys/:id/complete that holds or
    // acquires the same row lock will serialize with this transaction — one
    // wins the lock, the other waits.  When this transaction commits first,
    // /complete sees status='active' and proceeds.  When /complete commits
    // first (status→'completed'), this transaction sees the updated status
    // and returns saved:0 without inserting any rows.
    const outcome = await db.transaction(async (tx) => {
      const lockResult = await tx.execute(
        sql`SELECT id, status FROM journeys WHERE id = ${journeyId} AND user_id = ${userId} FOR UPDATE LIMIT 1`,
      );
      const row = lockResult.rows[0] as { id: string; status: string } | undefined;

      if (!row)                   return { found: false, active: false, saved: 0 } as const;
      if (row.status !== 'active') return { found: true,  active: false, saved: 0 } as const;

      await tx.insert(journeyRoutePoints).values(pointRows);
      return { found: true, active: true, saved: pointRows.length } as const;
    });

    if (!outcome.found) { res.status(404).json({ error: 'Journey not found' }); return; }
    if (!outcome.active) {
      res.json({ saved: 0, note: 'journey already completed' });
      return;
    }
    res.json({ saved: outcome.saved });
  } catch (err) {
    next(err);
  }
});

// POST /api/journeys/:id/complete – finalize journey with stats (idempotent)
router.post('/journeys/:id/complete', requireUser, async (req, res, next) => {
  try {
    const body = req.body as {
      name?: string;
      endTimeIso: string;
      durationSeconds: number;
      distanceKm: number;
      avgSpeedKmh: number;
      topSpeedKmh: number;
      notes?: string;
      categoryId?: string;
      privacy?: string;
      journeyType?: string;
      xpEarned?: number;
      remainingPoints?: Array<{
        latitude: number;
        longitude: number;
        speedKmh?: number;
        accuracyM?: number;
        recordedAt: string;
      }>;
    };

    if (!body.endTimeIso || body.durationSeconds == null || body.distanceKm == null) {
      res.status(400).json({ error: 'endTimeIso, durationSeconds, and distanceKm are required' });
      return;
    }

    const journeyId = param(req.params.id);
    const userId    = req.userId;

    // XP: 10 per km, clamped 50–500
    const xpEarned = body.xpEarned
      ?? Math.min(500, Math.max(50, Math.round(body.distanceKm * 10)));

    // Single transaction that acquires the same FOR UPDATE row lock used by
    // /route-points.  This ensures /complete and /route-points fully serialize:
    // whichever acquires the lock first completes its work; the loser either
    // sees status='completed' (and returns 200 / saved:0) or waits and then
    // finds the journey already sealed.  All writes happen while the lock is
    // held — no TOCTOU gap between status check and remainingPoints insert.
    const completed = await db.transaction(async (tx) => {
      // 1. Acquire row lock (matches lock order in /route-points)
      const lockResult = await tx.execute(
        sql`SELECT id, status, name FROM journeys WHERE id = ${journeyId} AND user_id = ${userId} FOR UPDATE LIMIT 1`,
      );
      const locked = lockResult.rows[0] as { id: string; status: string; name: string } | undefined;

      if (!locked) {
        throw Object.assign(new Error('not_found'), { notFound: true });
      }

      // 2. Idempotency: already completed → return existing row without any writes
      if (locked.status === 'completed') {
        throw Object.assign(new Error('already_completed'), { alreadyCompleted: true });
      }

      // 3. Persist final route points (within the lock, before status transition)
      if (body.remainingPoints?.length) {
        const ptRows = body.remainingPoints.map((p) => ({
          journeyId,
          latitude:   p.latitude,
          longitude:  p.longitude,
          speedKmh:   p.speedKmh  ?? 0,
          accuracyM:  p.accuracyM ?? null,
          recordedAt: new Date(p.recordedAt),
        }));
        await tx.insert(journeyRoutePoints).values(ptRows);
      }

      // 4. Transition status to 'completed'
      const [row] = await tx
        .update(journeys)
        .set({
          status:          'completed',
          name:            body.name          ?? locked.name,
          endTimeIso:      body.endTimeIso,
          durationSeconds: body.durationSeconds,
          distanceKm:      body.distanceKm,
          avgSpeedKmh:     body.avgSpeedKmh,
          topSpeedKmh:     body.topSpeedKmh,
          notes:           body.notes         ?? '',
          categoryId:      body.categoryId    ?? null,
          privacy:         body.privacy       ?? 'private',
          journeyType:     body.journeyType   ?? 'personal',
          xpEarned,
          updatedAt:       new Date(),
        })
        .where(eq(journeys.id, journeyId))
        .returning();

      // 5. Increment user stats atomically
      await tx
        .update(users)
        .set({
          totalJourneys: sql`total_journeys + 1`,
          totalDistance: sql`total_distance + ${body.distanceKm}`,
          xp:            sql`xp + ${xpEarned}`,
          updatedAt:     new Date(),
        })
        .where(eq(users.id, userId));

      return row;
    });

    res.json(completed);
  } catch (err: unknown) {
    if (err instanceof Error && 'notFound' in err) {
      res.status(404).json({ error: 'Journey not found' });
      return;
    }
    // Concurrent completion won the lock: return the already-completed row
    if (err instanceof Error && 'alreadyCompleted' in err) {
      const [existing] = await db
        .select()
        .from(journeys)
        .where(eq(journeys.id, param(req.params.id)))
        .limit(1);
      res.json(existing);
      return;
    }
    next(err);
  }
});

export default router;
