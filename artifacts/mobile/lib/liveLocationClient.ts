/**
 * Connects the live-location publisher (lib/backend/liveLocation) to the
 * running app. It adds no location work of its own:
 *  - during a drive it uses the fixes the drive already accepts (on screen
 *    or in the background, through the existing drive pipeline);
 *  - outside a drive, only fixes from the Drive screen's foreground stream
 *    (noteForegroundFix), only while the app is on screen.
 * Sharing never touches recording: every failure is swallowed here.
 *
 * Started by AppProvider after start-up and stopped on sign-out or unmount.
 */
import { AppState, type AppStateStatus } from 'react-native';
import type { CloudSync } from '@/lib/backend/cloudSync';
import type { Endpoints } from '@/lib/backend/endpoints';
import type { GpsFix } from '@/lib/backend/journeyRecorder';
import { LiveLocationPublisher, type LocationSharingMode } from '@/lib/backend/liveLocation';

export interface LiveLocationSession {
  /** A fix from the Drive screen's foreground stream (outside a drive). */
  noteForegroundFix(fix: GpsFix): void;
  /** The user changed WHEN in settings. */
  setMode(mode: LocationSharingMode): void;
  /** Removes the position (best effort) and every listener. */
  stop(): Promise<void>;
}

const onScreen = (s: AppStateStatus) => s !== 'background';

export function startLiveLocation(
  cloud: CloudSync,
  ep: Endpoints,
  opts: { initialMode: LocationSharingMode; onSharingOff?: () => void },
): LiveLocationSession {
  const publisher = new LiveLocationPublisher({
    send: (update) => ep.publishLiveLocation(update),
    remove: () => ep.removeLiveLocation(),
    onSharingOff: opts.onSharingOff,
    // Development only, and never the coordinates.
    log: __DEV__ ? (message) => console.log(`[live-location] ${message}`) : undefined,
  });
  publisher.start({ mode: opts.initialMode, onScreen: onScreen(AppState.currentState), driving: cloud.driveState.driving });

  const unsubscribeDrive = cloud.onDriveChange((drive) => publisher.setDriving(drive.driving));
  const unsubscribeFixes = cloud.onDriveFix((fix) => publisher.noteDriveFix(fix));
  const appStateSub = AppState.addEventListener('change', (s) => publisher.setOnScreen(onScreen(s)));

  let stopped = false;
  return {
    noteForegroundFix: (fix) => { if (!stopped) publisher.noteForegroundFix(fix); },
    setMode: (mode) => publisher.setMode(mode),
    async stop() {
      if (stopped) return;
      stopped = true;
      unsubscribeDrive();
      unsubscribeFixes();
      appStateSub.remove();
      await publisher.stop();
    },
  };
}
