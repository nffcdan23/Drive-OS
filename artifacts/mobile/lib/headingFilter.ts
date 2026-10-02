// The one heading the Drive map draws: the location arrow, and the map's
// bearing in heading-up follow mode.
//
// Two sensors can supply it — the compass when stopped or crawling, the GPS
// course once moving — but only one at a time feeds this filter, and the screen
// reads only its output.  The target is the latest reading as it is (no
// per-event smoothing, no coarse steps); the drawn value eases toward it every
// frame on a single time constant, always the short way round north.
//
// Kept free of React Native imports so it can be unit-tested under node.

import { angleDelta, approachAngle } from "./locationSmoothing";

export type HeadingSource = "compass" | "course";

export const HEADING_FILTER = {
  // Magnetometer noise is high-frequency and readings arrive many times a
  // second, so a short time constant smooths it without feeling laggy
  compassTauMs: 140,
  // GPS course arrives about once a second; a longer constant turns those
  // steps into a continuous turn
  courseTauMs: 450,
  // Compass changes smaller than this are sensor noise, not the phone turning.
  // Far below what the eye can see, so it never makes the arrow step.
  compassNoiseDeg: 0.4,
  // Close enough to call it caught up (lets the frame loop rest)
  settledDeg: 0.05,
} as const;

const norm = (deg: number) => ((deg % 360) + 360) % 360;

export class HeadingFilter {
  private target: number | null = null;
  private drawn = 0;
  private source: HeadingSource = "compass";

  /** The heading to draw this frame */
  get value(): number {
    return this.drawn;
  }

  /** The heading being eased toward (null before the first reading) */
  get targetValue(): number | null {
    return this.target;
  }

  get settled(): boolean {
    return (
      this.target == null ||
      Math.abs(angleDelta(this.drawn, this.target)) < HEADING_FILTER.settledDeg
    );
  }

  /**
   * A new reading.  Returns whether the target moved (so the caller knows to
   * wake its frame loop).  The first reading is drawn as-is.
   */
  update(deg: number, source: HeadingSource): boolean {
    if (!Number.isFinite(deg) || deg < 0) return false;
    const next = norm(deg);
    if (this.target == null) {
      this.target = next;
      this.drawn = next;
      this.source = source;
      return true;
    }
    if (
      source === "compass" &&
      this.source === "compass" &&
      Math.abs(angleDelta(this.target, next)) < HEADING_FILTER.compassNoiseDeg
    ) {
      return false;
    }
    this.target = next;
    this.source = source;
    return true;
  }

  /** Advances the drawn heading by one frame and returns it */
  step(dtMs: number): number {
    if (this.target == null) return this.drawn;
    const tau =
      this.source === "course"
        ? HEADING_FILTER.courseTauMs
        : HEADING_FILTER.compassTauMs;
    this.drawn = approachAngle(this.drawn, this.target, dtMs, tau);
    if (this.settled) this.drawn = this.target;
    return this.drawn;
  }
}

/**
 * The arrow's on-screen rotation.  Apple Maps annotations stay upright as the
 * map turns, so the arrow is turned by the heading relative to the map's
 * current bearing: where the vehicle points minus where the map points.
 */
export function markerScreenRotation(
  headingDeg: number,
  mapBearingDeg: number,
): number {
  return norm(headingDeg - mapBearingDeg);
}

/**
 * Runs an async read (react-native-maps' getCamera) as often as asked, but
 * never more than one at a time: a request made while one is in flight is
 * remembered, and one more read follows as soon as it lands.  So during a
 * gesture the newest bearing always arrives, nothing older ever overwrites
 * it, and calls don't pile up behind the map.
 */
export class LatestReader<T> {
  private pending = false;
  private again = false;

  constructor(
    private readonly read: () => Promise<T>,
    private readonly apply: (value: T) => void,
  ) {}

  request(): void {
    if (this.pending) {
      this.again = true;
      return;
    }
    this.pending = true;
    this.read()
      .then(this.apply, () => {})
      .finally(() => {
        this.pending = false;
        if (this.again) {
          this.again = false;
          this.request();
        }
      });
  }
}
