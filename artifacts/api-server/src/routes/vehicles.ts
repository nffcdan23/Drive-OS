import { Router } from 'express';
import { db, vehicles } from '@workspace/db';
import { eq, and } from 'drizzle-orm';
import { requireUser } from '../middleware/userId';
import { param } from '../utils/param';

const router = Router();

// GET /api/vehicles
router.get('/vehicles', requireUser, async (req, res, next) => {
  try {
    const rows = await db
      .select()
      .from(vehicles)
      .where(eq(vehicles.userId, req.userId));
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// POST /api/vehicles
router.post('/vehicles', requireUser, async (req, res, next) => {
  try {
    const body = req.body as Partial<typeof vehicles.$inferInsert>;
    const [row] = await db
      .insert(vehicles)
      .values({
        nickname:     body.nickname     ?? 'My Car',
        registration: body.registration ?? '',
        make:         body.make         ?? '',
        model:        body.model        ?? '',
        year:         body.year         ?? new Date().getFullYear(),
        colour:       body.colour       ?? '',
        fuelType:     body.fuelType     ?? 'petrol',
        engine:       body.engine       ?? '',
        power:        body.power        ?? '',
        torque:       body.torque       ?? '',
        zeroToSixty:  body.zeroToSixty  ?? '',
        topSpeedSpec: body.topSpeedSpec ?? '',
        mileage:      body.mileage      ?? 0,
        imageUrl:     body.imageUrl     ?? null,
        isActive:     body.isActive     ?? false,
        userId:       req.userId,
      })
      .returning();
    res.status(201).json(row);
  } catch (err) {
    next(err);
  }
});

// GET /api/vehicles/:id
router.get('/vehicles/:id', requireUser, async (req, res, next) => {
  try {
    const [row] = await db
      .select()
      .from(vehicles)
      .where(and(eq(vehicles.id, param(req.params.id)), eq(vehicles.userId, req.userId)))
      .limit(1);
    if (!row) { res.status(404).json({ error: 'Not found' }); return; }
    res.json(row);
  } catch (err) {
    next(err);
  }
});

// PUT /api/vehicles/:id
router.put('/vehicles/:id', requireUser, async (req, res, next) => {
  try {
    const body = req.body as Partial<typeof vehicles.$inferInsert>;
    const allowed: Partial<typeof vehicles.$inferInsert> = { updatedAt: new Date() };
    const fields = [
      'nickname','registration','make','model','year','colour','fuelType',
      'engine','power','torque','zeroToSixty','topSpeedSpec','mileage','imageUrl','isActive',
    ] as const;
    for (const f of fields) {
      if (body[f] !== undefined) (allowed as Record<string, unknown>)[f] = body[f];
    }

    const [row] = await db
      .update(vehicles)
      .set(allowed)
      .where(and(eq(vehicles.id, param(req.params.id)), eq(vehicles.userId, req.userId)))
      .returning();

    if (!row) { res.status(404).json({ error: 'Not found' }); return; }
    res.json(row);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/vehicles/:id
router.delete('/vehicles/:id', requireUser, async (req, res, next) => {
  try {
    await db
      .delete(vehicles)
      .where(and(eq(vehicles.id, param(req.params.id)), eq(vehicles.userId, req.userId)));
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// POST /api/vehicles/:id/activate – set as active vehicle, deactivate others
router.post('/vehicles/:id/activate', requireUser, async (req, res, next) => {
  try {
    // Deactivate all
    await db
      .update(vehicles)
      .set({ isActive: false, updatedAt: new Date() })
      .where(eq(vehicles.userId, req.userId));
    // Activate this one
    const [row] = await db
      .update(vehicles)
      .set({ isActive: true, updatedAt: new Date() })
      .where(and(eq(vehicles.id, param(req.params.id)), eq(vehicles.userId, req.userId)))
      .returning();
    if (!row) { res.status(404).json({ error: 'Not found' }); return; }
    res.json(row);
  } catch (err) {
    next(err);
  }
});

export default router;
