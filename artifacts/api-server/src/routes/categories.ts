import { Router } from 'express';
import { param } from '../utils/param';
import { db, journeyCategories } from '@workspace/db';
import { eq, and, or, isNull } from 'drizzle-orm';
import { requireUser } from '../middleware/userId';

const router = Router();

const DEFAULT_CATEGORIES = [
  { name: 'Daily Commute',   icon: 'car',          colour: '#4B9EFF' },
  { name: 'Road Trip',       icon: 'map',          colour: '#FF6B6B' },
  { name: 'Track Day',       icon: 'flag',         colour: '#FFD700' },
  { name: 'Weekend Drive',   icon: 'sun',          colour: '#4ECDC4' },
  { name: 'Night Cruise',    icon: 'moon',         colour: '#9B59B6' },
  { name: 'Mountain Run',    icon: 'triangle',     colour: '#E67E22' },
  { name: 'Coastal Drive',   icon: 'anchor',       colour: '#3498DB' },
  { name: 'Cross Country',   icon: 'compass',      colour: '#2ECC71' },
];

// GET /api/categories – list user's categories (including defaults)
router.get('/categories', requireUser, async (req, res, next) => {
  try {
    const rows = await db
      .select()
      .from(journeyCategories)
      .where(
        or(
          eq(journeyCategories.userId, req.userId),
          and(isNull(journeyCategories.userId), eq(journeyCategories.isDefault, true)),
        ),
      );

    // Seed defaults if user has none yet
    if (rows.filter((r) => r.isDefault).length === 0) {
      const seeded = await db
        .insert(journeyCategories)
        .values(
          DEFAULT_CATEGORIES.map((c, i) => ({
            userId:    null, // shared defaults have no owner
            name:      c.name,
            icon:      c.icon,
            colour:    c.colour,
            isDefault: true,
            sortOrder: i,
          })),
        )
        .onConflictDoNothing()
        .returning();
      rows.push(...seeded);
    }

    res.json(rows.sort((a, b) => a.sortOrder - b.sortOrder));
  } catch (err) {
    next(err);
  }
});

// POST /api/categories
router.post('/categories', requireUser, async (req, res, next) => {
  try {
    const { name, icon, colour } = req.body as { name: string; icon: string; colour: string };
    const [row] = await db
      .insert(journeyCategories)
      .values({ userId: req.userId, name, icon, colour, isDefault: false })
      .returning();
    res.status(201).json(row);
  } catch (err) {
    next(err);
  }
});

// PUT /api/categories/:id
router.put('/categories/:id', requireUser, async (req, res, next) => {
  try {
    const { name, icon, colour } = req.body as { name?: string; icon?: string; colour?: string };
    const updates: Partial<typeof journeyCategories.$inferInsert> = {};
    if (name !== undefined) updates.name = name;
    if (icon !== undefined) updates.icon = icon;
    if (colour !== undefined) updates.colour = colour;

    const [row] = await db
      .update(journeyCategories)
      .set(updates)
      .where(
        and(
          eq(journeyCategories.id, param(req.params.id)),
          eq(journeyCategories.userId, req.userId),
        ),
      )
      .returning();

    if (!row) { res.status(404).json({ error: 'Not found or not yours' }); return; }
    res.json(row);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/categories/:id
router.delete('/categories/:id', requireUser, async (req, res, next) => {
  try {
    await db
      .delete(journeyCategories)
      .where(
        and(
          eq(journeyCategories.id, param(req.params.id)),
          eq(journeyCategories.userId, req.userId),
          eq(journeyCategories.isDefault, false),
        ),
      );
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
