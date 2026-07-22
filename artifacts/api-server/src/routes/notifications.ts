import { Router } from 'express';
import { db, notifications } from '@workspace/db';
import { eq, and, desc } from 'drizzle-orm';
import { requireUser } from '../middleware/userId';
import { param } from '../utils/param';

const router = Router();

// GET /api/notifications
router.get('/notifications', requireUser, async (req, res, next) => {
  try {
    const rows = await db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, req.userId))
      .orderBy(desc(notifications.createdAt))
      .limit(100);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// PUT /api/notifications/:id/read
router.put('/notifications/:id/read', requireUser, async (req, res, next) => {
  try {
    await db
      .update(notifications)
      .set({ read: true })
      .where(
        and(
          eq(notifications.id, param(req.params.id)),
          eq(notifications.userId, req.userId),
        ),
      );
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// POST /api/notifications/read-all
router.post('/notifications/read-all', requireUser, async (req, res, next) => {
  try {
    await db
      .update(notifications)
      .set({ read: true })
      .where(eq(notifications.userId, req.userId));
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
