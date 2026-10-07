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

/**
 * Realtime stores every broadcast in realtime.messages (kept for days) so it
 * can deliver it. Live-location messages carry positions, so once delivered
 * (a minute is ample) they are deleted: no trail of positions is kept there.
 */
export async function purgeDeliveredLiveLocationMessages(): Promise<number> {
  const r = await db.execute(sql`
    delete from realtime.messages
    where event = 'live_location' and inserted_at < now() - interval '1 minute'
    returning 1`);
  return r.rows.length;
}

/** Only the error code: a message could quote the statement's values. */
function errorCode(err: unknown): string {
  const e = err as { code?: unknown; cause?: { code?: unknown } };
  const code = e?.cause?.code ?? e?.code;
  return typeof code === "string" ? code : err instanceof Error ? err.name : "unknown";
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
      logger.warn({ code: errorCode(err) }, "Live location clean-up failed");
    }
    try {
      const purged = await purgeDeliveredLiveLocationMessages();
      if (purged) logger.debug({ purged }, "Delivered live location messages removed");
    } catch (err) {
      logger.warn({ code: errorCode(err) }, "Live location message clean-up failed");
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
