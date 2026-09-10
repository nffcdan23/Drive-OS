import { Router } from 'express';
import { db, vehicles } from '@workspace/db';
import { eq, and } from 'drizzle-orm';
import { requireUser } from '../middleware/userId';
import { param } from '../utils/param';
import { logger } from '../lib/logger';

const router = Router();

// ─── DVLA Vehicle Enquiry Service lookup ─────────────────────────────────────
// The API key stays on the server: a key shipped in the app bundle can be
// extracted by anyone who installs it.
const DVLA_VES_URL =
  process.env.DVLA_VES_URL ??
  'https://driver-vehicle-licensing.api.gov.uk/vehicle-enquiry/v1/vehicles';

type VesVehicle = {
  registrationNumber?: string;
  make?: string;
  colour?: string;
  fuelType?: string;
  yearOfManufacture?: number;
  engineCapacity?: number;
  motStatus?: string;
  taxStatus?: string;
};

/**
 * VES reports fuel as free-ish text ("PETROL", "ELECTRICITY", "HYBRID ELECTRIC",
 * "HEAVY OIL", "GAS BI-FUEL"), so map it onto the four options the app offers.
 * Returns null when it matches none, leaving the user's current choice alone.
 */
function normaliseFuelType(raw: string | undefined) {
  const value = (raw ?? '').toUpperCase();
  if (!value) return null;
  if (value.includes('HYBRID') || value.includes('BIFUEL') || value.includes('BI-FUEL')) return 'hybrid';
  if (value.includes('ELECTRIC')) return 'electric';
  if (value.includes('DIESEL') || value.includes('HEAVY OIL')) return 'diesel';
  if (value.includes('PETROL') || value.includes('GAS')) return 'petrol';
  return null;
}

/** VES gives engine size in cc; the form wants a label like "1.6L". */
function formatEngine(cc: number | undefined): string {
  if (!cc || cc <= 0) return '';
  return `${(cc / 1000).toFixed(1)}L`;
}

// POST /api/vehicles/lookup
// Declared before /vehicles/:id so the path can never be read as an id.
router.post('/vehicles/lookup', requireUser, async (req, res, next) => {
  try {
    const apiKey = process.env.DVLA_API_KEY;
    if (!apiKey) {
      res.status(503).json({
        error: 'lookup_not_configured',
        message: 'Vehicle lookup is not configured on the server.',
      });
      return;
    }

    const supplied = typeof req.body?.registration === 'string' ? req.body.registration : '';
    const registrationNumber = supplied.replace(/\s+/g, '').toUpperCase();
    if (!/^[A-Z0-9]{2,8}$/.test(registrationNumber)) {
      res.status(400).json({
        error: 'invalid_registration',
        message: 'Enter a valid UK registration number.',
      });
      return;
    }

    const upstream = await fetch(DVLA_VES_URL, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ registrationNumber }),
      signal: AbortSignal.timeout(10_000),
    });

    if (upstream.status === 404) {
      res.status(404).json({
        error: 'not_found',
        message: 'No vehicle found with that registration.',
      });
      return;
    }

    if (upstream.status === 400) {
      res.status(400).json({
        error: 'invalid_registration',
        message: 'DVLA did not recognise that registration format.',
      });
      return;
    }

    if (upstream.status === 429) {
      res.status(429).json({
        error: 'rate_limited',
        message: 'Too many lookups just now. Try again shortly.',
      });
      return;
    }

    if (!upstream.ok) {
      // 401/403 means our key is wrong or revoked — a server-side problem the
      // user can do nothing about, so report it as one and never echo the body.
      logger.error({ status: upstream.status }, 'DVLA VES lookup failed');
      res.status(502).json({
        error: 'lookup_unavailable',
        message: 'Vehicle lookup is unavailable right now.',
      });
      return;
    }

    const data = (await upstream.json()) as VesVehicle;

    // VES has no model, power, torque, 0-60 or top speed — those stay manual.
    res.json({
      registration: data.registrationNumber ?? registrationNumber,
      make: data.make ?? '',
      colour: data.colour ?? '',
      fuelType: normaliseFuelType(data.fuelType),
      year: data.yearOfManufacture ?? null,
      engine: formatEngine(data.engineCapacity),
      motStatus: data.motStatus ?? null,
      taxStatus: data.taxStatus ?? null,
    });
  } catch (err) {
    next(err);
  }
});

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
