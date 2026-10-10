/**
 * Background location updates during a drive (iOS and Android).
 *
 * The task is defined here, at module scope, and this module is imported by
 * the app's entry file (index.js) before anything else: when the system
 * relaunches the app in the background to deliver locations, no screens are
 * mounted, so the task has to exist without them.  Its fixes go to
 * BackgroundDriveRecorder (lib/backend/driveTracking), which hands them to
 * the same recorder the Drive screen feeds.
 *
 * Updates are started only when a drive starts (in the foreground, by the
 * user) and stopped when it ends; see CloudSync.  As Expo requires for
 * background location, they need background permission (iOS "Always"),
 * asked for when the first drive starts (see ensureBackgroundAccess).
 * Without it the drive is recorded by the Drive screen while the app is open.
 * The background location capability is turned on in app.json.
 *
 * Navigation reads the same fixes (lib/backend/sharedLocationUpdates): no
 * second location stream. While it guides, the updates aren't stopped by the
 * end of a drive; with no recording alongside it may start them itself, but
 * only with background access already granted (it never asks), and only from
 * the foreground.
 */
import { AppState, Platform } from 'react-native';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import {
  BackgroundDriveRecorder, ensureBackgroundAccess, type LocationPermissions,
} from '@/lib/backend/driveTracking';
import { SharedLocationUpdates, type LocationUser, type NativeLocationUpdates } from '@/lib/backend/sharedLocationUpdates';
import type { GpsFix } from '@/lib/backend/journeyRecorder';
import { requestBackgroundLocation, requestForegroundLocation } from '@/lib/locationPermission';
import { journal } from '@/lib/diagnostics';
import { deviceStorage } from '@/lib/secureStorage';

export const DRIVE_LOCATION_TASK = 'drive-location-recording';

/**
 * Settings for driving.  The recorder keeps at most one point every 3 s, and
 * only after 25 m or a turn, so a 10 m filter loses nothing it would keep
 * while sparing the phone fixes it would throw away.
 */
const OPTIONS: Location.LocationTaskOptions = {
  accuracy: Location.Accuracy.BestForNavigation,
  activityType: Location.ActivityType.AutomotiveNavigation,
  distanceInterval: 10,
  timeInterval: 1_000, // Android only; iOS delivers fixes as they come
  // iOS would otherwise pause updates at a long red light or in a jam, and a
  // paused session only restarts with the app on screen: the rest of the
  // drive would be lost.
  pausesUpdatesAutomatically: false,
  // The blue location pill in the status bar while recording in the
  // background, so the user can see the drive is being recorded (with
  // "Always" access iOS doesn't show it otherwise).
  showsBackgroundLocationIndicator: true,
  // In the background, deliver fixes in batches every few seconds rather than
  // waking JavaScript for each one (on screen they arrive at once).
  deferredUpdatesInterval: 5_000,
  // Android: a foreground service with a notification, while the drive lasts.
  foregroundService: {
    notificationTitle: 'Recording your drive',
    notificationBody: 'Your route is being recorded until you end the drive.',
    killServiceOnDestroy: false,
  },
};

/**
 * The same settings while navigating with no drive being recorded: only
 * Android's notification says so instead.
 */
const NAVIGATION_OPTIONS: Location.LocationTaskOptions = {
  ...OPTIONS,
  foregroundService: {
    notificationTitle: 'Navigating',
    notificationBody: 'Derwent is guiding you to your destination until you end navigation.',
    killServiceOnDestroy: false,
  },
};

const permissions: LocationPermissions = {
  async requestForeground() {
    return (await requestForegroundLocation()).status === 'granted';
  },
  async hasBackground() {
    return (await Location.getBackgroundPermissionsAsync()).status === 'granted';
  },
  async requestBackground() {
    // A system prompt makes the app inactive while it's on screen; that's how
    // we know iOS showed it (it shows it only once per install).
    let promptShown = false;
    const sub = AppState.addEventListener('change', (state) => { if (state === 'inactive') promptShown = true; });
    try {
      const { status } = await requestBackgroundLocation();
      return { granted: status === 'granted', promptShown };
    } finally {
      sub.remove();
    }
  },
};

/** Navigation never asks: only access the user already gave */
async function navigationAccess(): Promise<boolean> {
  if ((await Location.getForegroundPermissionsAsync()).status !== 'granted') return false;
  // Android: a foreground service, which may only be started from the screen
  if (Platform.OS === 'android') return AppState.currentState === 'active';
  return permissions.hasBackground();
}

const updates: NativeLocationUpdates = {
  async start(user: LocationUser) {
    if (Platform.OS === 'web') return 'unavailable';
    // Expo Go, or a build made without the background location capability.
    if (!TaskManager.isTaskDefined(DRIVE_LOCATION_TASK) || !(await TaskManager.isAvailableAsync())) return 'unavailable';
    if (user === 'navigation') {
      if (!(await navigationAccess())) return 'denied';
      await Location.startLocationUpdatesAsync(DRIVE_LOCATION_TASK, NAVIGATION_OPTIONS);
      return 'on';
    }
    // Android runs the updates as a foreground service started from the
    // screen, which needs only foreground access.
    const access = Platform.OS === 'ios'
      ? await ensureBackgroundAccess(permissions, deviceStorage)
      : (await permissions.requestForeground()) ? 'granted' : 'denied';
    if (access !== 'granted') return access;
    await Location.startLocationUpdatesAsync(DRIVE_LOCATION_TASK, OPTIONS);
    return 'on';
  },
  async stop() {
    if (Platform.OS === 'web') return;
    await Location.stopLocationUpdatesAsync(DRIVE_LOCATION_TASK);
  },
  async isRunning() {
    if (Platform.OS === 'web') return false;
    return Location.hasStartedLocationUpdatesAsync(DRIVE_LOCATION_TASK);
  },
  async relabel(user: LocationUser) {
    // Only Android shows anything (the service's notification); restarting
    // the service is only allowed from the screen. iOS's settings are the same.
    if (Platform.OS !== 'android' || AppState.currentState !== 'active') return;
    await Location.startLocationUpdatesAsync(DRIVE_LOCATION_TASK, user === 'navigation' ? NAVIGATION_OPTIONS : OPTIONS);
  },
};

/** The one background location stream: the drive recorder's, which navigation also reads */
export const sharedLocation: SharedLocationUpdates = new SharedLocationUpdates(updates, {
  // A drive in progress is using them ('unknown' counts as in use)
  driveInUse: async (): Promise<boolean> => (await driveTracker.running()) !== null,
  journal,
});

export const driveTracker: BackgroundDriveRecorder = new BackgroundDriveRecorder({
  store: deviceStorage,
  updates: sharedLocation.drive,
  journal,
  othersUsingUpdates: () => sharedLocation.navigationActive,
});

function toFix(loc: Location.LocationObject): GpsFix {
  return {
    latitude: loc.coords.latitude,
    longitude: loc.coords.longitude,
    speedMs: loc.coords.speed != null && loc.coords.speed >= 0 ? loc.coords.speed : null,
    headingDeg: loc.coords.heading,
    accuracyM: loc.coords.accuracy,
    altitudeM: loc.coords.altitude,
    timestamp: loc.timestamp,
  };
}

if (Platform.OS !== 'web') {
  TaskManager.defineTask<{ locations?: Location.LocationObject[] }>(DRIVE_LOCATION_TASK, async ({ data, error }) => {
    // An error here is a temporary failure to get a fix (e.g. in a tunnel);
    // updates carry on and the next fix continues the route.
    if (error || !data?.locations?.length) return;
    const fixes = [...data.locations].sort((a, b) => a.timestamp - b.timestamp).map(toFix);
    // Navigation reads them (in memory, at once); recording is untouched by it
    sharedLocation.deliver(fixes);
    // Awaited, so the system keeps the app awake until the fixes are stored.
    await driveTracker.deliver(fixes);
  });
}
