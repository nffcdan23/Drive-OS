import { sql } from "drizzle-orm";

/**
 * Presence as seen by others: online / away / offline / driving, and when
 * the person was last active. Derived in SQL from timestamps
 * (private.presence_status), so a phone that stops reporting goes Away, then
 * Offline, on its own.
 */
export type PresenceStatus = "online" | "away" | "offline" | "driving";

export interface FriendPresence {
  status: PresenceStatus;
  /** Last heartbeat; null if they have never used a build that reports presence. */
  lastSeenAt: string | null;
}

/**
 * SQL selecting the presence of profile alias `p` for the signed-in user
 * (run inside asUser). Every value is NULL unless private.can_see_presence
 * allows it, so nothing a viewer may not see leaves the database. Needs
 * `left join public.user_presence pr on pr.user_id = p.id`.
 */
export const presenceColumns = sql.raw(`
  private.can_see_presence(p.id) as "presenceVisible",
  case when private.can_see_presence(p.id)
       then private.presence_status(pr.app_state, pr.driving, pr.last_seen_at) end as "presenceStatus",
  case when private.can_see_presence(p.id) then pr.last_seen_at end as "presenceLastSeenAt"`);

export function toPresence(row: Record<string, unknown>): FriendPresence | null {
  if (row.presenceVisible !== true) return null;
  const seen = row.presenceLastSeenAt;
  return {
    status: String(row.presenceStatus) as PresenceStatus,
    lastSeenAt: seen == null ? null : new Date(seen as string | Date).toISOString(),
  };
}
