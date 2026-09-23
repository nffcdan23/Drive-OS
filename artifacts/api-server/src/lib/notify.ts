import { sql } from "drizzle-orm";
import type { Tx } from "./userDb";

type NotificationType =
  | "friend_request" | "friend_accepted" | "convoy_invite" | "convoy_updated" | "convoy_cancelled"
  | "group_invite" | "group_request_result" | "group_news" | "event_invite" | "event_reminder"
  | "achievement_unlocked" | "system";

/** Which user preference (user_settings.notification_prefs) mutes each type. */
const PREF: Partial<Record<NotificationType, string>> = {
  friend_request: "friends", friend_accepted: "friends",
  convoy_invite: "convoys", convoy_updated: "convoys", convoy_cancelled: "convoys",
  group_invite: "groups", group_request_result: "groups", group_news: "groups",
  event_invite: "events", event_reminder: "events",
  achievement_unlocked: "achievements",
};

/**
 * Creates an in-app notification inside the caller's transaction (so it is
 * only kept if the action that caused it commits). Skipped when the
 * recipient has muted that category, or when recipient and actor are the
 * same person.
 */
export async function notify(
  tx: Tx,
  n: { userId: string; type: NotificationType; title: string; body?: string; data?: Record<string, unknown>; actorId?: string | null },
): Promise<void> {
  if (n.actorId && n.actorId === n.userId) return;
  const pref = PREF[n.type];
  await tx.execute(sql`
    insert into public.notifications (user_id, actor_user_id, type, title, body, data)
    select ${n.userId}, ${n.actorId ?? null}, ${n.type}, ${n.title.slice(0, 120)}, ${(n.body ?? "").slice(0, 500)},
           ${JSON.stringify(n.data ?? {})}::jsonb
    where not exists (
      select 1 from public.user_settings s
      where s.user_id = ${n.userId} and ${pref ?? null}::text is not null
        and (s.notification_prefs ->> ${pref ?? ""}) = 'false'
    )`);
}
