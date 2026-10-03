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
 * user) and stopped when it ends; see CloudSync.  Starting them from the
 * foreground needs only "While Using the App" location access: iOS keeps a
 * session started in the foreground running in the background (with the blue
 * location indicator), given the background location capability, which
 * app.json turns on.  "Always" access is not asked for.
 */
import { Platform } from 'react-native';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import { BackgroundDriveRecorder, type LocationUpdates } from '@/lib/backend/driveTracking';
import type { GpsFix } from '@/lib/backend/journeyRecorder';
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
  // background, so the user can see it (iOS shows it anyway with "While
  // Using" access; this keeps it with "Always" too).
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

const updates: LocationUpdates = {
  async start() {
    if (Platform.OS === 'web') return 'unavailable';
    const permission = await Location.getForegroundPermissionsAsync();
    if (permission.status !== 'granted') return 'denied';
    if (!TaskManager.isTaskDefined(DRIVE_LOCATION_TASK)) return 'unavailable';
    // Expo Go, or a build made without the background location capability.
    if (!(await TaskManager.isAvailableAsync())) return 'unavailable';
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
};

export const driveTracker = new BackgroundDriveRecorder({ store: deviceStorage, updates });

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
    // Awaited, so the system keeps the app awake until the fixes are stored.
    await driveTracker.deliver(fixes);
  });
}
