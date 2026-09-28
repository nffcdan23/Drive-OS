import { sql } from "drizzle-orm";
import { db } from "@workspace/db";

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Runs work in a transaction that carries the caller's identity, exactly as
 * Supabase's own APIs do (`request.jwt.claims`). That makes auth.uid() and
 * the RLS helper functions in the `private` schema (can_view,
 * can_view_convoy, group_role, …) evaluate for this user, so the API applies
 * the very same visibility rules that the RLS test suite verifies, instead of
 * re-implementing them.
 *
 * The API connects as the table owner, so RLS itself does not filter these
 * queries: every read that returns other people's data must filter with the
 * helpers, and every write must check ownership explicitly.
 */
export async function asUser<T>(userId: string, work: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    const claims = JSON.stringify({ sub: userId, role: "authenticated" });
    await tx.execute(sql`select set_config('request.jwt.claims', ${claims}, true)`);
    return work(tx);
  });
}

/** First row of a raw query result, typed. */
export function first<T>(result: { rows: unknown[] }): T | undefined {
  return result.rows[0] as T | undefined;
}
