/**
 * Connects the live presence feed (lib/backend/presenceFeed) to Supabase
 * Realtime and the app's foreground/background state. Started by
 * AppProvider after start-up, alongside presence reporting, and stopped on
 * sign-out or unmount.
 *
 * The channel is private: Realtime lets a user join only `inbox:<their own
 * id>` (policy in migration 0017), and only the database sends on it.
 * supabase-js passes each refreshed access token to Realtime; every join also
 * fetches a current token first, so a token that expired while the app was
 * in the background never leaves the channel silently broken.
 */
import { AppState, type AppStateStatus } from 'react-native';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { CloudSync } from '@/lib/backend/cloudSync';
import { PresenceFeed, type InboxStatus } from '@/lib/backend/presenceFeed';

export interface RealtimePresenceSession {
  stop(): void;
}

/** On screen, including 'inactive' (Control Centre, a system prompt). */
const onScreen = (s: AppStateStatus) => s !== 'background';

export function startRealtimePresence(supabase: SupabaseClient, cloud: CloudSync, userId: string): RealtimePresenceSession {
  const topic = `inbox:${userId}`;
  const log = __DEV__ ? (message: string) => console.log(`[presence] realtime: ${message}`) : undefined;

  const feed = new PresenceFeed({
    log,
    snapshot: () => cloud.refreshFriends(),
    apply: (event) => {
      log?.(`${event.type}${event.type === 'presence' ? `=${event.status}` : ''}`);
      cloud.applyPresenceEvent(event);
    },
    decay: () => cloud.decayFriendPresence(),
    open: async ({ onEvent, onStatus }) => {
      // A current token first (refreshed if it expired in the background).
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) throw new Error('not signed in');
      await supabase.realtime.setAuth(token);
      // supabase.channel() returns an existing channel for the same topic:
      // remove any left over so there is only ever one.
      for (const old of supabase.getChannels()) {
        if (old.topic === `realtime:${topic}`) await supabase.removeChannel(old);
      }
      const channel = supabase.channel(topic, { config: { private: true } });
      channel.on('broadcast', { event: 'presence' }, (message) => onEvent(message.payload));
      channel.subscribe((status) => {
        const mapped: InboxStatus | null =
          status === 'SUBSCRIBED' ? 'subscribed'
            : status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' ? 'error'
              : status === 'CLOSED' ? 'closed' : null;
        if (mapped) onStatus(mapped);
      });
      return { close: () => { void supabase.removeChannel(channel); } };
    },
  });

  const sub = AppState.addEventListener('change', (s) => feed.setActive(onScreen(s)));
  feed.setActive(onScreen(AppState.currentState));

  let stopped = false;
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      sub.remove();
      feed.stop();
    },
  };
}
