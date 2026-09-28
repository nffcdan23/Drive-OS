import type { NextFunction, Request, Response } from "express";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { HttpError } from "../lib/http";
import { TokenError, verifyAccessToken } from "../lib/jwt";
import { logger } from "../lib/logger";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Supabase Auth user id (= profiles.id). Set by requireUser. */
      userId: string;
      userEmail: string | null;
    }
  }
}

/**
 * Requires a valid Supabase access token: `Authorization: Bearer <token>`.
 * The old device-ID scheme is gone — a device UUID is not a token and is
 * rejected like any other invalid credential.
 */
export async function requireUser(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (!token) throw new HttpError(401, "unauthenticated", "Sign in required.");

    let verified;
    try {
      verified = await verifyAccessToken(token);
    } catch (err) {
      if (err instanceof TokenError) {
        logger.debug({ reason: err.message }, "Rejected access token");
        throw new HttpError(401, "invalid_token", "Your session is invalid or has expired. Sign in again.");
      }
      throw err;
    }

    // The profile is created by the sign-up trigger; a missing row means the
    // account is being deleted or the sign-up did not complete.
    const found = await db.execute(sql`select 1 from public.profiles where id = ${verified.sub}`);
    if (!found.rows.length) throw new HttpError(403, "profile_missing", "This account is not set up.");

    req.userId = verified.sub;
    req.userEmail = verified.email;
    next();
  } catch (err) {
    next(err);
  }
}
