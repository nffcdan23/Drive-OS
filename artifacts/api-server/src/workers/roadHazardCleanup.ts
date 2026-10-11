import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "../lib/logger";

/**
 * Housekeeping for road hazards (migration 0020). Every read already treats
 * an expired or removed hazard as absent, so none of this is needed for
 * correctness:
 *  - a hazard (and with it who reported or voted on it) is deleted a day
 *    after it ended: kept that long only so the daily report limit holds;
 *  - hazard broadcasts are removed from realtime.messages once delivered
 *    (ten minutes is ample), so no record of reports builds up there.
 */
export async function purgeEndedRoadHazards(): Promise<number> {
  const r = await db.execute(sql`
    delete from public.road_hazards
    where least(expires_at, coalesce(removed_at, expires_at)) < now() - interval '1 day'
    returning 1`);
  return r.rows.length;
}

export async function purgeDeliveredHazardMessages(): Promise<number> {
  const r = await db.execute(sql`
    delete from realtime.messages
    where event = 'hazard' and inserted_at < now() - interval '10 minutes'
    returning 1`);
  return r.rows.length;
}

/** Only the error code: a message could quote the statement's values. */
function errorCode(err: unknown): string {
  const e = err as { code?: unknown; cause?: { code?: unknown } };
  const code = e?.cause?.code ?? e?.code;
  return typeof code === "string" ? code : err instanceof Error ? err.name : "unknown";
}

export function startRoadHazardCleanup(intervalMs = 10 * 60_000): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const removed = await purgeEndedRoadHazards();
      if (removed) logger.debug({ removed }, "Ended road hazards removed");
    } catch (err) {
      logger.warn({ code: errorCode(err) }, "Road hazard clean-up failed");
    }
    try {
      const purged = await purgeDeliveredHazardMessages();
      if (purged) logger.debug({ purged }, "Delivered hazard messages removed");
    } catch (err) {
      logger.warn({ code: errorCode(err) }, "Hazard message clean-up failed");
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
