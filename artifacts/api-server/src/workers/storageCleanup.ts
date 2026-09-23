import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { removeObjects } from "../lib/supabaseAdmin";
import { logger } from "../lib/logger";

/**
 * Removes Storage files whose database rows were deleted or replaced.
 *
 * Triggers put every such file on `private.storage_delete_queue` (in the same
 * transaction as the delete), so no file is forgotten even if the API
 * crashes. This worker drains the queue through the Storage API — Supabase
 * forbids deleting storage.objects rows with SQL. `FOR UPDATE SKIP LOCKED`
 * lets several API instances run it safely. It also drops uploads that were
 * never confirmed within 24 hours (their rows' triggers queue the files).
 */
const BATCH = 100;
const MAX_ATTEMPTS = 10;

export async function drainStorageQueue(): Promise<{ removed: number; failed: number }> {
  let removed = 0;
  let failed = 0;
  await db.transaction(async (tx) => {
    const rows = (await tx.execute(sql`
      select id, bucket, path from private.storage_delete_queue
      where attempts < ${MAX_ATTEMPTS}
      order by queued_at limit ${BATCH}
      for update skip locked`)).rows as { id: string; bucket: string; path: string }[];

    const byBucket = new Map<string, typeof rows>();
    for (const r of rows) byBucket.set(r.bucket, [...(byBucket.get(r.bucket) ?? []), r]);

    for (const [bucket, items] of byBucket) {
      const idList = sql.join(items.map((i) => sql`${i.id}`), sql`, `);
      try {
        // Already-missing files are not an error: Storage just skips them.
        await removeObjects(bucket, items.map((i) => i.path));
        await tx.execute(sql`delete from private.storage_delete_queue where id in (${idList})`);
        removed += items.length;
      } catch (err) {
        const message = err instanceof Error ? err.message.slice(0, 300) : "unknown error";
        await tx.execute(sql`
          update private.storage_delete_queue set attempts = attempts + 1, last_error = ${message}
          where id in (${idList})`);
        failed += items.length;
      }
    }
  });
  return { removed, failed };
}

export async function purgeAbandonedUploads(): Promise<number> {
  const a = await db.execute(sql`delete from public.photos where status = 'pending' and created_at < now() - interval '24 hours' returning 1`);
  const b = await db.execute(sql`delete from public.vehicle_documents where status = 'pending' and created_at < now() - interval '24 hours' returning 1`);
  return a.rows.length + b.rows.length;
}

export function startStorageWorker(intervalMs = 60_000): () => void {
  let running = false;
  let ticks = 0;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      if (ticks++ % 60 === 0) {
        const purged = await purgeAbandonedUploads();
        if (purged) logger.info({ purged }, "storage worker: removed abandoned uploads");
      }
      const { removed, failed } = await drainStorageQueue();
      if (removed || failed) logger.info({ removed, failed }, "storage worker: processed delete queue");
    } catch (err) {
      logger.error({ err }, "storage worker failed");
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  void tick();
  return () => clearInterval(timer);
}
