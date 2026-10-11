// What the Drive screen shows, decided once, separately from what is running
// underneath.
//
//   idle       no drive, no navigation: the map with search and Start Drive
//   freeDrive  a drive being recorded without navigation: the full recording
//              dashboard (speedometer, distance, duration, Pause, End Drive,
//              Save Point, GPS status), exactly as before
//   navigation turn-by-turn guidance: the banner, lanes, the route and the
//              guidance bar (arrival, time and distance left, voice, End,
//              Overview / Recenter); never the recording dashboard
//
// Navigation always wins: Start Navigation records the drive underneath
// (and a drive may already have been recording), and that recording carries
// on exactly as before, only its dashboard isn't shown while guiding. Ending
// navigation with a drive still recording (one the user started) brings the
// dashboard back. Navigation without a recording (Passenger Mode) looks the
// same as with one.
//
// No React Native imports, so it is unit-tested under node.

export type DrivePresentation = 'idle' | 'freeDrive' | 'navigation';

export function drivePresentation(s: {
  /** A drive is being recorded (by the user, or by Start Navigation) */
  isDriving: boolean;
  /** A navigation session exists (guiding, arrived or failed): its UI is up */
  navigating: boolean;
}): DrivePresentation {
  if (s.navigating) return 'navigation';
  return s.isDriving ? 'freeDrive' : 'idle';
}
