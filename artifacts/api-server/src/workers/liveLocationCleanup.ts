import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "../lib/logger";

/**
 * Deletes live positions that have expired. Reads already treat an expired
 * row as absent (migration 0018), so this is housekeeping, not security:
 * it keeps the table to current positions only, and the delete trigger tells
 * viewers to drop the marker. Positions are never logged.
 */
export async function purgeExpiredLiveLocations(): Promise<number> {
  const r = await db.execute(sql`delete from public.live_locations where expires_at <= now() returning 1`);
  return r.rows.length;
}

export function startLiveLocationCleanup(intervalMs = 60_000): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const removed = await purgeExpiredLiveLocations();
      if (removed) logger.debug({ removed }, "Expired live locations removed");
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, "Live location clean-up failed");
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
