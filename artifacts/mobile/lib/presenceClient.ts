/**
 * Connects the presence reporter (lib/backend/presence) to the running app:
 * the app's foreground/background state and CloudSync's drive lifecycle.
 * Started by AppProvider once the signed-in user's data has loaded (so a
 * drive recovered after a relaunch is reported as Driving at once), and
 * stopped when the provider unmounts.
 */
import { AppState, type AppStateStatus } from 'react-native';
import type { CloudSync } from '@/lib/backend/cloudSync';
import type { Endpoints } from '@/lib/backend/endpoints';
import { PresenceReporter, type PresenceAppState } from '@/lib/backend/presence';

/** 'inactive' (Control Centre, a system prompt, the app switcher) is still on screen. */
const appStateOf = (s: AppStateStatus): PresenceAppState => (s === 'background' ? 'background' : 'foreground');

export interface PresenceSession {
  /** Best-effort "signed out" before the session is cleared; never throws. */
  signOut(): Promise<void>;
  /** Removes every timer and listener. */
  stop(): void;
}

export function startPresence(cloud: CloudSync, ep: Endpoints): PresenceSession {
  const reporter = new PresenceReporter({
    send: (update) => ep.updatePresence(update),
    onError: (err) => { if (__DEV__) console.log('[presence] update failed:', err instanceof Error ? err.message : err); },
  });
  const unsubscribeDrive = cloud.onDriveChange((drive) => reporter.setDrive(drive));
  const unsubscribeActivity = cloud.onDriveActivity(() => reporter.noteDriveActivity());
  const appStateSub = AppState.addEventListener('change', (s) => reporter.setAppState(appStateOf(s)));
  reporter.start(appStateOf(AppState.currentState), cloud.driveState);

  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    reporter.stop();
    unsubscribeDrive();
    unsubscribeActivity();
    appStateSub.remove();
  };
  return {
    async signOut() {
      try {
        await reporter.signOut();
      } finally {
        stop();
      }
    },
    stop,
  };
}
