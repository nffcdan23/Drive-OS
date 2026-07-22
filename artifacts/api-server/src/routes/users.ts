import { Router } from 'express';
import { db, users, userAchievements, achievements } from '@workspace/db';
import { eq } from 'drizzle-orm';
import { requireUser } from '../middleware/userId';

const router = Router();

// GET /api/users/me – return current user profile (upserted by middleware)
router.get('/users/me', requireUser, async (req, res, next) => {
  try {
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, req.userId))
      .limit(1);

    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    res.json(user);
  } catch (err) {
    next(err);
  }
});

// PUT /api/users/me – update profile fields
router.put('/users/me', requireUser, async (req, res, next) => {
  try {
    const { name, username, bio } = req.body as {
      name?: string;
      username?: string;
      bio?: string;
    };

    const updates: Partial<typeof users.$inferInsert> = {
      updatedAt: new Date(),
    };
    if (name !== undefined) updates.name = name;
    if (username !== undefined) updates.username = username;
    if (bio !== undefined) updates.bio = bio;

    const [updated] = await db
      .update(users)
      .set(updates)
      .where(eq(users.id, req.userId))
      .returning();

    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// GET /api/users/me/achievements – list unlocked achievements
router.get('/users/me/achievements', requireUser, async (req, res, next) => {
  try {
    const rows = await db
      .select({
        id: achievements.id,
        title: achievements.title,
        description: achievements.description,
        icon: achievements.icon,
        unlockedAt: userAchievements.unlockedAt,
      })
      .from(userAchievements)
      .innerJoin(achievements, eq(userAchievements.achievementId, achievements.id))
      .where(eq(userAchievements.userId, req.userId));

    res.json(rows);
  } catch (err) {
    next(err);
  }
});

export default router;
