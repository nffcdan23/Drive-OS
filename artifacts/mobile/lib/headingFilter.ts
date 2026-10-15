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
//     is measured from the latest readings and the course is carried on at
//     that rate (dead-reckoned, like the arrow's position) for up to
//     predictMaxMs, at most maxPredictDeg: a steady bend is one continuous
//     rotation. Small changes are GPS noise on a straight road: a weak rate
//     (under strongYawDegS) counts only when a fit through the last few
//     fixes shows the same steady turn, so noise has nothing to drift on,
//     while a slow bend still turns continuously. The route source
//     moves every frame already; the compass is many readings a second.
//
//     Timed by when each fix was taken, not when it reached JavaScript. Fixes
//     are taken about a second apart but can arrive bunched (two within a
//     few ms after the JS thread was busy) or late; timing them by arrival
//     measured no rate from a bunched pair, so the turn stopped until the
//     next fix (the Free Drive stop-start), and placed each reading late by
//     its delivery delay, so the target stepped back at every fix. Now the
//     rate is measured against the newest earlier fix taken at least
//     yawMinGapMs before (from a short history), and the reading is carried
//     on from the time it was taken.
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
  // GPS course: a turn rate measured from the last fix is taken as it is
  // from this much up (°/s; course noise of a degree or so between fixes is
  // under it)…
  strongYawDegS: 3,
  // …and below it, only once a straight-line fit through the last few fixes
  // (at least slowYawFixes, spanning slowYawSpanMs) shows a steady turn of at
  // least this much the same way: a slow bend, which noise isn't
  slowYawMinDegS: 1,
  slowYawFixes: 3,
  slowYawSpanMs: 1_500,
  // Turn rates are measured from readings taken 0.3–2.5 s apart, and capped (°/s)
  yawMinGapMs: 300,
  yawMaxGapMs: 2_500,
  maxYawRateDegS: 45,
  // The course is carried on at its turn rate for at most this long after a
  // reading was taken: the usual second's gap plus delivery delay, or one
  // fix held back to arrive with the next, so neither stops the turn…
  predictMaxMs: 2_200,
  // …and never further than this from the reading (a second at the highest rate)
  maxPredictDeg: 45,
  // A fix said to be taken longer than this before it arrived is timed as if
  // taken this long before (a clock that disagrees, or a fix replayed late)
  maxFixDelayMs: 1_000,
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
  /** Recent GPS course readings: when taken, and the course unwrapped (no jump at north) */
  private courses: Array<{ t: number; deg: number }> = [];
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
   * A new reading (arriving at `atMs`, the same clock as step's).  A GPS
   * course should say when its fix was taken (`fixMs`, same clock): it is
   * timed by that, and a fix no newer than the last is ignored.  Returns
   * whether the target moved (so the caller knows to wake its frame loop).
   * The first reading is drawn as-is.
   */
  update(
    deg: number,
    source: HeadingSource,
    atMs: number = Date.now(),
    fixMs?: number | null,
  ): boolean {
    if (!Number.isFinite(deg) || deg < 0) return false;
    const next = norm(deg);
    const H = HEADING_FILTER;
    const timed = source === "course" && fixMs != null && Number.isFinite(fixMs);
    const at = timed ? clamp(fixMs, atMs - H.maxFixDelayMs, atMs) : atMs;
    if (timed && this.source === "course" && this.courses.length > 0 && at <= this.baseAt) {
      return false; // the same fix again, or an older one delivered late
    }
    if (this.base == null) {
      this.base = next;
      this.baseAt = at;
      this.drawn = next;
      this.rate = 0;
      this.yawRate = 0;
      this.source = source;
      this.courses = source === "course" ? [{ t: at, deg: next }] : [];
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
    if (source === "course") {
      yaw = this.courseYaw(next, at);
    } else {
      this.courses = [];
    }
    this.base = next;
    this.baseAt = at;
    this.yawRate = yaw;
    this.source = source;
    return true;
  }

  /** Records a GPS course reading taken at `at` and returns the turn rate it shows (°/s, 0 for none) */
  private courseYaw(next: number, at: number): number {
    const H = HEADING_FILTER;
    // Only readings from this run of GPS course, taken within the last 2.5 s
    const prior = this.source === "course" ? this.courses.filter((c) => at - c.t <= H.yawMaxGapMs) : [];
    const last = prior.at(-1);
    const deg = last ? last.deg + angleDelta(norm(last.deg), next) : next;
    this.courses = [...prior, { t: at, deg }];
    // The newest earlier reading taken far enough before this one: a fix
    // taken moments before (or arriving bunched, untimed) is skipped over
    let ref = -1;
    for (let i = prior.length - 1; i >= 0; i--) {
      if (at - prior[i].t >= H.yawMinGapMs) {
        ref = i;
        break;
      }
    }
    if (ref < 0) return 0;
    const clampYaw = (v: number) => clamp(v, -H.maxYawRateDegS, H.maxYawRateDegS);
    const fromLast = ((deg - prior[ref].deg) / (at - prior[ref].t)) * 1000;
    if (Math.abs(fromLast) >= H.strongYawDegS) return clampYaw(fromLast);
    // Weak: a least-squares slope through the history, kept only if steady
    const run = this.courses;
    if (run.length < H.slowYawFixes || at - run[0].t < H.slowYawSpanMs) return 0;
    const mt = run.reduce((a, c) => a + c.t, 0) / run.length;
    const md = run.reduce((a, c) => a + c.deg, 0) / run.length;
    let num = 0;
    let den = 0;
    for (const c of run) {
      num += (c.t - mt) * (c.deg - md);
      den += (c.t - mt) ** 2;
    }
    const slope = den > 0 ? (num / den) * 1000 : 0;
    return Math.abs(slope) >= H.slowYawMinDegS && Math.sign(slope) === Math.sign(fromLast)
      ? clampYaw(slope)
      : 0;
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
