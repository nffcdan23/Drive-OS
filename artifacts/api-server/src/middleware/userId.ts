import { Request, Response, NextFunction } from 'express';
import { db, users } from '@workspace/db';
import { eq, sql } from 'drizzle-orm';
import { randomUUID } from 'crypto';

// Augment Express Request so route handlers can access req.userId
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId: string;
      deviceId: string;
    }
  }
}

/**
 * Reads the device ID from the `Authorization: Bearer <device-id>` header
 * or the `X-Device-ID` header, then performs a conflict-safe upsert so
 * parallel first-run requests never race on the unique `device_id` constraint.
 */
export async function requireUser(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const authHeader = req.headers.authorization;
    const xDeviceId  = req.headers['x-device-id'];

    let deviceId: string | null = null;
    if (authHeader?.startsWith('Bearer ')) {
      deviceId = authHeader.slice(7).trim() || null;
    } else if (typeof xDeviceId === 'string') {
      deviceId = xDeviceId.trim() || null;
    }

    if (!deviceId) {
      res.status(401).json({ error: 'Missing device ID' });
      return;
    }

    // Conflict-safe upsert:
    //   INSERT ... ON CONFLICT (device_id) DO UPDATE SET updated_at = now()
    // Always returns the row (new or pre-existing) in a single round-trip,
    // so concurrent first-run requests from the same device don't race.
    const friendCode = randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase();
    const [row] = await db
      .insert(users)
      .values({ deviceId, friendCode })
      .onConflictDoUpdate({
        target: users.deviceId,
        set:    { updatedAt: new Date() },
      })
      .returning({ id: users.id });

    req.userId  = row.id;
    req.deviceId = deviceId;
    next();
  } catch (err) {
    next(err);
  }
}
