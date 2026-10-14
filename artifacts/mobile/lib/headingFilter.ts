// The one heading the Drive map draws: the location arrow, and the map's
// bearing in heading-up follow mode (the camera is turned to exactly this
// value every frame, so camera and arrow turn together).
//
// Three sources can supply it, one at a time: the compass when stopped or
// crawling, the GPS course once moving, and, while navigating on the route,
// the route's own direction at the arrow (lib/navigation/routeHeading.ts).
//
// Why it used to step: the GPS course arrives about once a second. The drawn
// heading eased toward each new reading on an exponential, which moves fast
// just after the reading and slows to nearly nothing before the next one: in
// a bend that is turn, stop, turn, stop, on the arrow and the camera alike.
// Smoothing a once-a-second target harder only adds lag; it can't make the
// motion between readings continuous.
//
// What runs now, every frame:
//  1. The target moves between readings. For the GPS course, the turn rate
//     is measured from the last two readings and the course is carried on at
//     that rate (dead-reckoned, like the arrow's position) for up to
//     predictMaxMs, at most maxPredictDeg: a steady bend is one continuous
//     rotation. Small changes (under yawNoiseDeg between readings) are GPS
//     noise on a straight road: no rate, nothing to drift. The route source
//     moves every frame already; the compass is many readings a second.
//  2. The drawn heading follows the target with a critically damped spring
//     (position and rate both continuous): when a new reading corrects the
//     prediction, the rotation bends toward it instead of jumping or
//     stopping. Always the short way round north.
//
// Kept free of React Native imports so it can be unit-tested under node.

import { angleDelta } from "./locationSmoothing";

export type HeadingSource = "compass" | "course" | "route";

export const HEADING_FILTER = {
  // How quickly the drawn heading closes on its target (the spring's
  // smoothing time, ms): short for the many-a-second compass and the
  // every-frame route direction, longer for the once-a-second course
  compassSmoothMs: 110,
  courseSmoothMs: 320,
  routeSmoothMs: 160,
  // Compass changes smaller than this are sensor noise, not the phone turning.
  // Far below what the eye can see, so it never makes the arrow step.
  compassNoiseDeg: 0.4,
  // GPS course: a change smaller than this between readings is noise (no turn rate)
  yawNoiseDeg: 1.5,
  // Turn rates are measured from readings 0.3–2.5 s apart, and capped (°/s)
  yawMinGapMs: 300,
  yawMaxGapMs: 2_500,
  maxYawRateDegS: 45,
  // The course is carried on at its turn rate for at most this long after a
  // reading (a little over the usual gap, so a late reading doesn't stop it)…
  predictMaxMs: 1_300,
  // …and never further than this from the reading
  maxPredictDeg: 30,
  // Close enough, and slow enough, to call it caught up (lets the frame loop rest)
  settledDeg: 0.05,
  settledRateDegS: 0.3,
} as const;

const norm = (deg: number) => ((deg % 360) + 360) % 360;
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

export class HeadingFilter {
  /** The last reading, and when it came */
  private base: number | null = null;
  private baseAt = 0;
  /** Turn rate carried on from it (°/s; course only) */
  private yawRate = 0;
  private drawn = 0;
  /** The drawn heading's rate of turn (°/s), kept continuous */
  private rate = 0;
  private lastStepAt: number | null = null;
  private source: HeadingSource = "compass";

  /** The heading to draw this frame */
  get value(): number {
    return this.drawn;
  }

  /** The heading being eased toward now (null before the first reading) */
  get targetValue(): number | null {
    return this.base == null ? null : this.targetAt(this.lastStepAt ?? this.baseAt);
  }

  /** Whether the heading is still turning toward a moving target */
  private predicting(now: number): boolean {
    return this.yawRate !== 0 && now - this.baseAt < HEADING_FILTER.predictMaxMs;
  }

  get settled(): boolean {
    if (this.base == null) return true;
    const now = this.lastStepAt ?? this.baseAt;
    return (
      !this.predicting(now) &&
      Math.abs(angleDelta(this.drawn, this.targetAt(now))) < HEADING_FILTER.settledDeg &&
      Math.abs(this.rate) < HEADING_FILTER.settledRateDegS
    );
  }

  /** The target at `now`: the reading, carried on at its turn rate */
  private targetAt(now: number): number {
    const base = this.base ?? 0;
    if (this.yawRate === 0) return base;
    const H = HEADING_FILTER;
    const ms = clamp(now - this.baseAt, 0, H.predictMaxMs);
    return norm(base + clamp((this.yawRate * ms) / 1000, -H.maxPredictDeg, H.maxPredictDeg));
  }

  /**
   * A new reading (at `atMs`, the same clock as step's).  Returns whether the
   * target moved (so the caller knows to wake its frame loop).  The first
   * reading is drawn as-is.
   */
  update(deg: number, source: HeadingSource, atMs: number = Date.now()): boolean {
    if (!Number.isFinite(deg) || deg < 0) return false;
    const next = norm(deg);
    const H = HEADING_FILTER;
    if (this.base == null) {
      this.base = next;
      this.baseAt = atMs;
      this.drawn = next;
      this.rate = 0;
      this.yawRate = 0;
      this.source = source;
      return true;
    }
    if (
      source === "compass" &&
      this.source === "compass" &&
      Math.abs(angleDelta(this.base, next)) < H.compassNoiseDeg
    ) {
      return false;
    }
    let yaw = 0;
    if (source === "course" && this.source === "course") {
      const gap = atMs - this.baseAt;
      const turned = angleDelta(this.base, next);
      if (gap >= H.yawMinGapMs && gap <= H.yawMaxGapMs && Math.abs(turned) >= H.yawNoiseDeg) {
        yaw = clamp((turned / gap) * 1000, -H.maxYawRateDegS, H.maxYawRateDegS);
      }
    }
    this.base = next;
    this.baseAt = atMs;
    this.yawRate = yaw;
    this.source = source;
    return true;
  }

  /** Advances the drawn heading by one frame (`dtMs` long, ending at `nowMs`) and returns it */
  step(dtMs: number, nowMs: number = Date.now()): number {
    this.lastStepAt = nowMs;
    if (this.base == null) return this.drawn;
    const H = HEADING_FILTER;
    const target = this.targetAt(nowMs);
    const smoothMs =
      this.source === "course"
        ? H.courseSmoothMs
        : this.source === "route"
          ? H.routeSmoothMs
          : H.compassSmoothMs;
    // Critically damped spring toward the target (both in unwrapped degrees
    // relative to it, so the short way round north)
    const dt = Math.max(dtMs, 0) / 1000;
    const omega = 2 / (smoothMs / 1000);
    const x = omega * dt;
    const decay = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
    const change = -angleDelta(this.drawn, target); // drawn − target
    const temp = (this.rate + omega * change) * dt;
    this.rate = (this.rate - omega * temp) * decay;
    let offset = (change + temp) * decay;
    // Never carried past the target by the spring's own momentum
    if (Math.sign(offset) !== Math.sign(change) && change !== 0 && !this.predicting(nowMs)) {
      offset = 0;
      this.rate = 0;
    }
    this.drawn = norm(target + offset);
    if (this.settled) {
      this.drawn = target;
      this.rate = 0;
    }
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
