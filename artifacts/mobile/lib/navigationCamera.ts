// The Drive map's navigation camera: the one configuration every way into
// follow mode uses (Continue Following, the locate button, starting a drive,
// coming back after the user moved the map).  Tune it here after a road test.
//
// Kept free of React Native imports so it can be unit-tested under node.

export const NAV_CAMERA = {
  // Tilt toward the horizon, in degrees from straight down.  Apple Maps'
  // own driving view sits around here, and it is about the most MapKit will
  // render at street distances: MapKit clamps pitch by camera distance
  // (60° holds at ~800 m and is flattened at ~1000 m), so any steeper and
  // the camera would have to come much closer to keep it.
  pitchDeg: 60,

  // Camera distance from eye to map centre, in metres (iOS).  The camera's
  // altitude is derived from this and the pitch, so tilting in or out keeps
  // the same distance, and with it MapKit's pitch limit and the map scale.
  // 800 m is the farthest that keeps the full 60° (see above); with the tilt
  // it shows far more road ahead than the old 450 m / 50° drive camera and
  // sits a little further out than the old flat 700 m street view.
  distanceM: 800,

  // Android (Google Maps) states zoom rather than distance
  androidZoom: 16.5,

  // How far ahead of the vehicle the map centre sits, along its heading, so
  // the vehicle draws below the centre and the screen fills with road ahead.
  // It grows gently with speed: shorter in town, longer on fast roads.  The
  // range is bounded by the drive telemetry panel, which covers roughly the
  // bottom 38% of the screen: at 60 m the vehicle is still about 2.3° below
  // the centre of view, which stays clear of the panel for any plausible
  // MapKit field of view.  Only applied heading-up; north-up centres exactly.
  lookAhead: {
    minM: 25,
    maxM: 60,
    // Speeds (km/h) at which look-ahead is at its minimum / maximum
    slowKmh: 30,
    fastKmh: 100,
    // Speed is smoothed over this long before it moves the look-ahead, so
    // ordinary speed changes drift the view rather than nudging it each fix
    speedTauMs: 3000,
  },
} as const;

/** Map types MapKit renders flat whatever pitch is asked for */
const FLAT_MAP_TYPES = new Set(["satellite", "hybrid"]);

/**
 * Camera tilt: the navigation pitch heading-up, flat north-up (a tilted
 * north-up map is disorienting rather than useful).  Satellite and hybrid
 * maps can't tilt in MapKit, so they ask for flat rather than have the
 * camera's distance worked out for a tilt that never happens.
 */
export function navPitch(headingUp: boolean, mapType: string): number {
  return headingUp && !FLAT_MAP_TYPES.has(mapType) ? NAV_CAMERA.pitchDeg : 0;
}

/** Look-ahead (m) for a speed (km/h): an eased ramp between the two limits */
export function lookAheadForSpeed(speedKmh: number): number {
  const { minM, maxM, slowKmh, fastKmh } = NAV_CAMERA.lookAhead;
  const u = Math.min(
    Math.max((speedKmh - slowKmh) / (fastKmh - slowKmh), 0),
    1,
  );
  const eased = u * u * (3 - 2 * u); // smoothstep: no kink at either end
  return minM + (maxM - minM) * eased;
}
