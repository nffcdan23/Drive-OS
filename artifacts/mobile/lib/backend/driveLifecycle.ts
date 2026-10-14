/**
 * The intelligent drive lifecycle: whether a drive is being driven, has
 * stopped for a moment, has (probably) stopped for good, or has been driven
 * on again — worked out from the drive's own GPS fixes. CloudSync acts on it
 * (cloudSync.ts: applyLifecycle): the "Looks like you've stopped" prompt,
 * driving on by itself, and finishing the drive where it stopped.
 *
 * One module for both places fixes reach a drive: the app (CloudSync.addFix)
 * and the background with no app running (DriveTracking.recordHeadless). Both
 * call observeLifecycleFix with the drive record; the state lives on the
 * record (JourneyRecord.lifecycle), so it is saved with it, survives a
 * restart, and the two paths can never disagree.
 *
 * States (derived from the saved timestamps and the time now, so they can be
 * worked out again after any restart):
 *   driving             moved like a vehicle recently
 *   stop_candidate      no vehicle movement for LIFECYCLE.candidateAfterMs
 *                       (lights, queues: nothing happens)
 *   temporarily_stopped none for LIFECYCLE.temporaryStopMs: the stop is
 *                       backdated to the last vehicle movement (the stop
 *                       point); the prompt is offered, the time stopped
 *                       doesn't count as driving, and points recorded after
 *                       the stop point wait (they belong to the drive only
 *                       if it drives on)
 *   manual_paused       the user's Pause: the classifier stands aside
 *   finished            the grace period (from the stop point, or a later
 *                       Continue Drive) ran out, or a failsafe fired: the
 *                       drive ends at the stop point
 *
 * Vehicle movement needs a good fix, a vehicle speed (reported, or inferred
 * from two good fixes when the phone gives none) and displacement that
 * agrees with it: never speed alone, never a missing speed taken as 0.
 * Resuming after a temporary stop needs more: several consecutive fast,
 * consistent fixes, clear of the stop point, so walking away from the car
 * never counts.
 *
 * Nothing logged identifies a place or a time: buckets and reasons only.
 *
 * No React Native imports, so it is unit-tested under node.
 */
import { msToKmh } from '../units';
import { distanceM } from './geo';
import type { Journal } from './journal';
import type { GpsFix, JourneyRecord } from './journeyRecorder';

/** Thresholds (provisional: confirmed against real drives through the diagnostics) */
export const LIFECYCLE = {
  /** A fix this vague (m), or with no accuracy, is no evidence of anything */
  moveMaxAccuracyM: 50,
  /** Vehicle speed (m/s, ~11 km/h): faster than a brisk walk */
  moveMinSpeedMs: 3,
  /** Displacement must agree with the speed: at least this share of speed × time */
  moveConsistency: 0.5,
  /** Faster than this (m/s, ~250 km/h) between two fixes is a GPS jump, not driving */
  maxPlausibleMs: 70,
  /**
   * A fix too vague to judge speed by (or with nothing to pair it with) still
   * shows the car moving when it is clearly away from where it last moved:
   * accuracy up to this (m), and further than both accuracies plus bridgeMarginM
   */
  bridgeMaxAccuracyM: 200,
  bridgeMarginM: 50,
  /** A speed is checked against a good fix at least this much older (ms)… */
  pairMinGapMs: 5_000,
  /** …and no more than this (ms) */
  pairMaxGapMs: 15_000,
  /** No vehicle movement for this long (ms): a stop candidate */
  candidateAfterMs: 15_000,
  /** …for this long (ms): temporarily stopped, backdated to the stop point */
  temporaryStopMs: 5 * 60_000,
  /** Resume: this many consecutive fixes… */
  resumeFixes: 3,
  /** …spread over at least this long (ms)… */
  resumeMinSpanMs: 8_000,
  /** …each no further apart than this (ms)… */
  resumeMaxGapMs: 5_000,
  /** …each this accurate (m)… */
  resumeMaxAccuracyM: 30,
  /** …each at least this fast (km/h)… */
  resumeMinSpeedKmh: 20,
  /** …and the car this far from the stop point (m) */
  resumeMinFromStopM: 100,
  /** The drive is kept resumable this long after the stop point (ms) */
  graceMs: 60 * 60_000,
  /** Failsafe: net displacement under this (m)… */
  lowDisplacementM: 200,
  /** …over this long (ms) means parked, whatever the speeds say */
  lowDisplacementWindowMs: 20 * 60_000,
  /** Failsafe: no vehicle movement for this long (ms) */
  longStillMs: 3 * 60 * 60_000,
  /** Failsafe: a drive this old (ms) */
  maxDriveAgeMs: 24 * 60 * 60_000,
  /** Fixes this close in time (ms) are one fix delivered twice */
  duplicateMs: 500,
  /** Lifecycle diagnostics per drive (the journal is shared and small) */
  maxLogs: 80,
} as const;

export type LifecyclePhase = 'driving' | 'stop_candidate' | 'temporarily_stopped' | 'manual_paused' | 'finished';
export type AutoEndReason = 'stop_grace' | 'failsafe_long_still' | 'failsafe_age';
export type Failsafe = 'low_displacement' | 'long_still' | 'age';

interface FixRefPoint {
  latitude: number;
  longitude: number;
  accuracyM: number | null;
  /** ms */
  t: number;
}

/** What is saved on the drive record (JourneyRecord.lifecycle); every field optional for older records */
export interface DriveLifecycleState {
  /** Last meaningful vehicle movement: when (ISO) and where (the stop point) */
  lastMovingAt?: string | null;
  lastMovingPoint?: { latitude: number; longitude: number; accuracyM: number | null } | null;
  /** The current stop: when it began (the last vehicle movement), and whether it is a temporary stop yet */
  stopStartedAt?: string | null;
  stopConfirmed?: boolean;
  /** Temporary stops that ended with the car driven on (ISO from/to) */
  closedStops?: Array<{ from: string; to: string }>;
  /** Kept open past the grace period until then (Keep Drive Open, later) */
  keepOpenUntil?: string | null;
  /** The stop prompt was answered with Continue Drive for the current stop (not asked again) */
  stopPromptShown?: boolean;
  /** Why the drive would have ended by itself */
  autoEndReason?: AutoEndReason | null;
  /** When it would have ended (the stop point) */
  wouldEndAt?: string | null;
  // ── Working state (bounded) ──
  /** Good fixes of the last pairMaxGapMs (at most one a second), to confirm or infer speeds */
  recent?: FixRefPoint[];
  /** The newest fix seen at all (ms), for duplicates */
  seenAt?: number | null;
  /** Consecutive resume-grade fixes while temporarily stopped (the shortest run spanning resumeMinSpanMs) */
  resumeRun?: FixRefPoint[];
  /** Coarse positions (one a minute, ~21) for the low-displacement failsafe */
  samples?: FixRefPoint[];
  /** Failsafes that would have fired (each once) */
  failsafes?: Failsafe[];
  /** Manual pause seen (the classifier stands aside), and the record's paused total when last looked at */
  manualPaused?: boolean;
  pausedMsSeen?: number;
  /** Navigation arrival seen (ms) */
  arrivedAt?: number | null;
  /** Diagnostics written for this drive, and stop lengths by bucket */
  logs?: number;
  stopHist?: Record<string, number>;
}

export interface LifecycleDeps {
  journal?: Journal;
  /** Which path saw it (diagnostics only) */
  path: 'app' | 'background';
}

// ─── Buckets (diagnostics: never a place or an exact time) ───────────────────

export function elapsedBucket(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return 'unknown';
  const s = ms / 1000;
  if (s < 30) return '<30s';
  if (s < 60) return '30s-1m';
  if (s < 120) return '1-2m';
  if (s < 300) return '2-5m';
  if (s < 600) return '5-10m';
  if (s < 1_800) return '10-30m';
  if (s < 3_600) return '30-60m';
  if (s < 3 * 3_600) return '1-3h';
  return '>3h';
}

export function speedBucket(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return 'unknown';
  const kmh = msToKmh(ms);
  if (kmh < 5) return '0-5kmh';
  if (kmh < 11) return '5-11kmh';
  if (kmh < 20) return '11-20kmh';
  if (kmh < 50) return '20-50kmh';
  if (kmh < 90) return '50-90kmh';
  return '90+kmh';
}

export function accuracyBucket(m: number | null | undefined): string {
  if (m == null || !Number.isFinite(m) || m < 0) return 'unknown';
  if (m <= 10) return '<=10m';
  if (m <= 30) return '10-30m';
  if (m <= 50) return '30-50m';
  if (m <= 100) return '50-100m';
  return '>100m';
}

export function displacementBucket(m: number | null): string {
  if (m == null || !Number.isFinite(m) || m < 0) return 'unknown';
  if (m < 10) return '<10m';
  if (m < 50) return '10-50m';
  if (m < 100) return '50-100m';
  if (m < 500) return '100-500m';
  if (m < 1_000) return '500m-1km';
  return '>1km';
}

// ─── Movement ────────────────────────────────────────────────────────────────

export type MovementReason = 'moving' | 'gap_bridged' | 'slow' | 'poor_accuracy' | 'speed_unknown' | 'inconsistent' | 'no_reference';

export interface Movement {
  moving: boolean;
  reason: MovementReason;
  /** The speed judged by (reported, or inferred), m/s; null when unknown */
  speedMs: number | null;
  /** Displacement from the reference fix (m), when there is one */
  displacementM: number | null;
}

const good = (accuracyM: number | null | undefined, max: number) => accuracyM != null && Number.isFinite(accuracyM) && accuracyM >= 0 && accuracyM <= max;
const known = (v: number | null | undefined): v is number => v != null && Number.isFinite(v) && v >= 0;

/**
 * Whether `fix` shows the car moving like a vehicle, against a good fix
 * pairMinGapMs–pairMaxGapMs before it (`prev`). The displacement between them
 * must be clear of both fixes' accuracy (parked GPS wander never adds up to
 * movement) and agree with the reported speed; with no reported speed, one
 * is inferred from the two fixes. An unknown speed is never "stationary":
 * with nothing to infer it from, it is no evidence either way.
 */
export function classifyMovement(fix: GpsFix, prev: FixRefPoint | null): Movement {
  const L = LIFECYCLE;
  const speed = known(fix.speedMs) ? fix.speedMs : null;
  if (!good(fix.accuracyM, L.moveMaxAccuracyM)) return { moving: false, reason: 'poor_accuracy', speedMs: speed, displacementM: null };
  if (speed != null && speed < L.moveMinSpeedMs) return { moving: false, reason: 'slow', speedMs: speed, displacementM: null };
  const dt = prev ? fix.timestamp - prev.t : NaN;
  if (!prev || !(dt >= L.pairMinGapMs && dt <= L.pairMaxGapMs)) return { moving: false, reason: 'no_reference', speedMs: speed, displacementM: null };
  const disp = distanceM(prev, fix);
  const noise = fix.accuracyM! + (prev.accuracyM ?? L.moveMaxAccuracyM);
  if (disp <= noise) return { moving: false, reason: speed == null ? 'speed_unknown' : 'inconsistent', speedMs: speed, displacementM: disp };
  const s = dt / 1000;
  // Further than any car could go: a GPS jump, evidence of nothing
  if (disp / s > L.maxPlausibleMs) return { moving: false, reason: 'inconsistent', speedMs: speed, displacementM: disp };
  if (speed != null) {
    // The ground covered agrees with the speed: never too little (a spurious
    // speed). More than it says (the reported speed lagging while
    // accelerating) is still the car moving: a false stop mid-drive is far
    // worse than a stop noticed a little late.
    const moving = disp >= L.moveConsistency * speed * s;
    return { moving, reason: moving ? 'moving' : 'inconsistent', speedMs: speed, displacementM: disp };
  }
  // No reported speed: inferred, cautiously
  const inferred = disp / s;
  if (inferred < L.moveMinSpeedMs) return { moving: false, reason: 'slow', speedMs: inferred, displacementM: disp };
  return { moving: true, reason: 'moving', speedMs: inferred, displacementM: disp };
}

/** The newest remembered good fix pairMinGapMs–pairMaxGapMs before `t` */
function referenceFor(s: DriveLifecycleState, t: number): FixRefPoint | null {
  const list = s.recent ?? [];
  for (let i = list.length - 1; i >= 0; i--) {
    const dt = t - list[i]!.t;
    if (dt >= LIFECYCLE.pairMinGapMs) return dt <= LIFECYCLE.pairMaxGapMs ? list[i]! : null;
  }
  return null;
}

function remember(s: DriveLifecycleState, fix: GpsFix) {
  if (!good(fix.accuracyM, LIFECYCLE.moveMaxAccuracyM)) return;
  const list = (s.recent ??= []);
  const last = list[list.length - 1];
  if (last && fix.timestamp - last.t < 1_000) return;
  list.push(refOf(fix));
  while (list.length > 20 || (list.length > 1 && fix.timestamp - list[0]!.t > LIFECYCLE.pairMaxGapMs)) list.shift();
}

/**
 * After a GPS gap (a tunnel, the system holding updates back), or through
 * fixes too vague to judge a speed by (an urban canyon), there is no pair to
 * judge: the car having got well away from where it last moved, at vehicle
 * speed on average, is movement all the same. So neither is ever taken for a
 * stop; a parked phone's wander (within its accuracy) never adds up to it.
 */
function bridgeGap(s: DriveLifecycleState, fix: GpsFix, movement: Movement, sinceMs: number): Movement {
  const L = LIFECYCLE;
  const from = s.lastMovingPoint;
  if (!from || !Number.isFinite(sinceMs) || !good(fix.accuracyM, L.bridgeMaxAccuracyM)) return movement;
  const dt = (fix.timestamp - sinceMs) / 1000;
  const d = distanceM(from, fix);
  const noise = fix.accuracyM! + (from.accuracyM ?? L.bridgeMaxAccuracyM) + L.bridgeMarginM;
  if (!(dt > 0) || d < L.resumeMinFromStopM || d <= noise || d / dt > L.maxPlausibleMs) return movement;
  return d / dt >= L.moveMinSpeedMs ? { moving: true, reason: 'gap_bridged', speedMs: d / dt, displacementM: d } : movement;
}

// ─── The lifecycle ───────────────────────────────────────────────────────────

const iso = (ms: number) => new Date(ms).toISOString();
const ms = (s: string | null | undefined) => (s ? Date.parse(s) : NaN);
const refOf = (fix: GpsFix): FixRefPoint => ({ latitude: fix.latitude, longitude: fix.longitude, accuracyM: fix.accuracyM ?? null, t: fix.timestamp });

type Rec = Pick<JourneyRecord, 'startedAt' | 'endedAt' | 'pausedAt' | 'pausedMs' | 'lifecycle'>;

function stateOf(rec: Rec): DriveLifecycleState {
  rec.lifecycle ??= { pausedMsSeen: rec.pausedMs ?? 0 };
  return rec.lifecycle;
}

/**
 * Where a stop is measured from: the last vehicle movement, or the start of
 * the drive when it hasn't moved like a vehicle yet.
 */
const anchorOf = (rec: Rec, s: DriveLifecycleState) => s.lastMovingAt ?? rec.startedAt;

/** The phase now, from the saved state alone (no fix needed) */
export function lifecyclePhase(rec: Rec, now: number): LifecyclePhase {
  const s = rec.lifecycle ?? {};
  if (s.wouldEndAt) return 'finished';
  if (rec.pausedAt) return 'manual_paused';
  const last = ms(anchorOf(rec, s));
  if (!Number.isFinite(last)) return 'driving';
  const still = now - last;
  if (s.stopConfirmed || still >= LIFECYCLE.temporaryStopMs) return 'temporarily_stopped';
  if (still >= LIFECYCLE.candidateAfterMs) return 'stop_candidate';
  return 'driving';
}

/** When a temporarily stopped drive would end by itself: the grace period from the stop point (or a later keep-open) */
export function graceDeadline(s: DriveLifecycleState): number | null {
  const stop = ms(s.stopStartedAt ?? s.lastMovingAt);
  if (!Number.isFinite(stop)) return null;
  const keep = ms(s.keepOpenUntil);
  return Math.max(stop + LIFECYCLE.graceMs, Number.isFinite(keep) ? keep : -Infinity);
}

class Logger {
  constructor(private readonly s: DriveLifecycleState, private readonly deps: LifecycleDeps) {}
  log(step: string, data: Record<string, string | number | boolean | null> = {}) {
    const count = this.s.logs ?? 0;
    if (count >= LIFECYCLE.maxLogs) return;
    this.s.logs = count + 1;
    this.deps.journal?.log('drive_lifecycle', { step, path: this.deps.path, ...data });
  }
}

/**
 * One fix for a drive in progress (every fix, accepted for recording or
 * not): advances the lifecycle state saved on the record and logs what it
 * would do. Changes nothing else on the record. Deterministic: the same
 * fixes give the same state on either path.
 */
export function observeLifecycleFix(rec: Rec, fix: GpsFix, deps: LifecycleDeps): void {
  shielded(rec, deps, () => observe(rec, fix, deps));
}

/** Drives that have already logged a lifecycle error (once each: the journal is shared) */
const failed = new WeakSet<object>();

/**
 * The lifecycle must never get in the way of recording: whatever goes wrong
 * in here is logged (its kind only, once per drive) and swallowed.
 */
function shielded<T>(rec: Rec, deps: Pick<LifecycleDeps, 'journal' | 'path'>, fn: () => T, fallback?: T): T {
  try {
    return fn();
  } catch (err) {
    try {
      if (!failed.has(rec)) {
        failed.add(rec);
        deps.journal?.log('drive_lifecycle', { step: 'error', path: deps.path, error: err instanceof Error ? err.name : 'unknown' });
      }
    } catch {
      // nothing more to do
    }
    return fallback as T;
  }
}

function observe(rec: Rec, fix: GpsFix, deps: LifecycleDeps): void {
  if (rec.endedAt) return;
  if (!Number.isFinite(fix.timestamp) || !Number.isFinite(fix.latitude) || !Number.isFinite(fix.longitude)) return;
  const s = stateOf(rec);
  if (s.seenAt != null && fix.timestamp <= s.seenAt + LIFECYCLE.duplicateMs) return;
  s.seenAt = fix.timestamp;
  const log = new Logger(s, deps);
  const now = fix.timestamp;

  // Manual pause: the user's choice stands; the classifier stands aside
  syncPause(rec, s, now, log, fix);
  if (rec.pausedAt) {
    remember(s, fix);
    return;
  }

  sample(s, fix);
  // Not moved like a vehicle yet: the first usable fix is where it is measured from
  if (!s.lastMovingPoint && good(fix.accuracyM, LIFECYCLE.bridgeMaxAccuracyM)) {
    s.lastMovingPoint = { latitude: fix.latitude, longitude: fix.longitude, accuracyM: fix.accuracyM ?? null };
  }
  let movement = classifyMovement(fix, referenceFor(s, now));
  remember(s, fix);
  if (!movement.moving && (movement.reason === 'no_reference' || movement.reason === 'poor_accuracy') && !s.stopConfirmed && !s.wouldEndAt) {
    movement = bridgeGap(s, fix, movement, ms(anchorOf(rec, s)));
  }

  // The safety nets look at every fix: a car "moving" for 24 hours, or GPS wander read as movement
  failsafes(rec, s, now, log);

  if (s.wouldEndAt) {
    // It would have ended already. Driving on afterwards would have split the drive: the one number that matters most
    if (resumeGrade(s, fix, movement)) {
      log.log('would_have_split', { since: elapsedBucket(now - ms(s.wouldEndAt)), reason: s.autoEndReason ?? null });
      s.wouldEndAt = null;
      s.autoEndReason = null;
      s.stopStartedAt = null;
      s.stopConfirmed = false;
      s.resumeRun = [];
      s.samples = [];
      s.lastMovingAt = iso(now);
      s.lastMovingPoint = { latitude: fix.latitude, longitude: fix.longitude, accuracyM: fix.accuracyM ?? null };
    }
    return;
  }

  if (s.stopConfirmed) {
    // Temporarily stopped: only the stricter resume rule brings the drive back
    if (resumeGrade(s, fix, movement)) {
      const first = s.resumeRun![0]!;
      const from = s.stopStartedAt!;
      (s.closedStops ??= []).push({ from, to: iso(first.t) });
      bump(s, elapsedBucket(first.t - ms(from)));
      log.log('resumed', {
        stopped: elapsedBucket(first.t - ms(from)), speed: speedBucket(movement.speedMs),
        fromStop: displacementBucket(s.lastMovingPoint ? distanceM(s.lastMovingPoint, fix) : null), accuracy: accuracyBucket(fix.accuracyM),
      });
      s.stopStartedAt = null;
      s.stopConfirmed = false;
      s.resumeRun = [];
      s.samples = [];
      s.stopPromptShown = false;
      s.keepOpenUntil = null;
      s.lastMovingAt = iso(now);
      s.lastMovingPoint = { latitude: fix.latitude, longitude: fix.longitude, accuracyM: fix.accuracyM ?? null };
      return;
    }
    evaluate(rec, now, log);
    return;
  }

  if (movement.moving) {
    if (s.stopStartedAt) {
      // A stop that ended before it became a temporary stop (lights, a queue)
      const stopped = now - ms(s.stopStartedAt);
      bump(s, elapsedBucket(stopped));
      log.log('movement_detected', {
        stopped: elapsedBucket(stopped), speed: speedBucket(movement.speedMs),
        displacement: displacementBucket(movement.displacementM), accuracy: accuracyBucket(fix.accuracyM),
      });
      s.stopStartedAt = null;
    } else if (!s.lastMovingAt) {
      log.log('movement_detected', { first: true, speed: speedBucket(movement.speedMs), accuracy: accuracyBucket(fix.accuracyM) });
    }
    s.lastMovingAt = iso(now);
    s.lastMovingPoint = { latitude: fix.latitude, longitude: fix.longitude, accuracyM: fix.accuracyM ?? null };
    return;
  }
  evaluate(rec, now, log, movement.reason);
}

/**
 * The lifecycle at a moment with no fix (start-up, coming back on screen,
 * the end of a drive): reconstructs the phase from the saved timestamps,
 * backdated as with a fix. Logs what it would do.
 */
export function evaluateLifecycle(rec: Rec, now: number, deps: LifecycleDeps): LifecyclePhase | 'unknown' {
  return shielded<LifecyclePhase | 'unknown'>(rec, deps, () => {
    const s = stateOf(rec);
    if (!rec.endedAt) {
      const log = new Logger(s, deps);
      syncPause(rec, s, now, log);
      if (!rec.pausedAt) evaluate(rec, now, log);
    }
    return lifecyclePhase(rec, now);
  }, 'unknown');
}

/**
 * Keeps the lifecycle in step with the user's Pause, from the record itself
 * (so a pause and resume with no fix between them is still seen): a pause
 * replaces whatever stop was building; on resuming, a stop is measured from
 * then, never across the pause.
 */
function syncPause(rec: Rec, s: DriveLifecycleState, now: number, log: Logger, fix?: GpsFix) {
  if (rec.pausedAt) {
    if (s.manualPaused) return;
    s.manualPaused = true;
    log.log('manual_pause_override', { state: s.stopConfirmed ? 'temporarily_stopped' : s.stopStartedAt ? 'stop_candidate' : 'driving' });
    s.stopStartedAt = null;
    s.stopConfirmed = false;
    s.resumeRun = [];
    s.samples = [];
    return;
  }
  const pausedMs = rec.pausedMs ?? 0;
  if (!s.manualPaused && pausedMs === (s.pausedMsSeen ?? pausedMs)) return;
  if (!s.manualPaused) {
    // Paused and resumed with nothing seen in between: the pause still replaces any stop
    log.log('manual_pause_override', { state: s.stopConfirmed ? 'temporarily_stopped' : s.stopStartedAt ? 'stop_candidate' : 'driving' });
    s.stopStartedAt = null;
    s.stopConfirmed = false;
    s.resumeRun = [];
  }
  // Positions from before the pause never count towards a stop after it
  s.samples = [];
  s.manualPaused = false;
  s.pausedMsSeen = pausedMs;
  if (!s.wouldEndAt) {
    s.lastMovingAt = iso(now);
    if (fix) s.lastMovingPoint = { latitude: fix.latitude, longitude: fix.longitude, accuracyM: fix.accuracyM ?? null };
  }
  log.log('manual_pause_ended');
}

/** The user paused or resumed the drive: noted at once */
export function noteLifecyclePause(rec: Rec, now: number, deps: LifecycleDeps): void {
  if (rec.endedAt || !rec.lifecycle) return;
  const s = rec.lifecycle;
  shielded(rec, deps, () => syncPause(rec, s, now, new Logger(s, deps)));
}

function evaluate(rec: Rec, now: number, log: Logger, reason?: MovementReason) {
  const s = stateOf(rec);
  if (s.wouldEndAt || rec.pausedAt) return;
  const anchor = anchorOf(rec, s);
  const last = ms(anchor);
  failsafes(rec, s, now, log);
  if (s.wouldEndAt || !Number.isFinite(last)) return;
  const still = now - last;
  if (!s.stopStartedAt && still >= LIFECYCLE.candidateAfterMs) {
    s.stopStartedAt = anchor;
    log.log('stop_candidate_started', { reason: reason ?? 'no_fix', after: elapsedBucket(still), neverMoved: !s.lastMovingAt });
  }
  if (s.stopStartedAt && !s.stopConfirmed && still >= LIFECYCLE.temporaryStopMs) {
    s.stopConfirmed = true;
    s.resumeRun = [];
    // Backdated: the stop began at the last vehicle movement, not now
    log.log('temporary_stop', { decidedAfter: elapsedBucket(still), by: 'rules', arrivedBefore: s.arrivedAt != null ? elapsedBucket(last - s.arrivedAt) : null });
  }
  const deadline = graceDeadline(s);
  if (s.stopConfirmed && deadline != null && now >= deadline) {
    s.wouldEndAt = s.stopStartedAt!;
    s.autoEndReason = 'stop_grace';
    log.log('auto_finish', { reason: 'stop_grace', stopped: elapsedBucket(now - ms(s.stopStartedAt)), keptOpen: !!s.keepOpenUntil });
  }
}

/** Safety nets: each logged once, when it fires */
function failsafes(rec: Rec, s: DriveLifecycleState, now: number, log: Logger) {
  const fired = (s.failsafes ??= []);
  const fire = (f: Failsafe, reason: Exclude<AutoEndReason, 'stop_grace'>, data: Record<string, string | number | boolean | null>) => {
    if (fired.includes(f)) return;
    fired.push(f);
    log.log('failsafe', { failsafe: f, ...data });
    if (!s.wouldEndAt) {
      // Ends where the car last moved like a vehicle (the stop point)
      const anchor = anchorOf(rec, s);
      s.wouldEndAt = anchor;
      s.autoEndReason = reason;
      log.log('auto_finish', { reason, stopped: elapsedBucket(now - ms(anchor)), neverMoved: !s.lastMovingAt });
    }
  };
  const last = ms(anchorOf(rec, s));
  if (Number.isFinite(last) && now - last >= LIFECYCLE.longStillMs) fire('long_still', 'failsafe_long_still', { still: elapsedBucket(now - last) });
  const started = ms(rec.startedAt);
  if (Number.isFinite(started) && now - started >= LIFECYCLE.maxDriveAgeMs) fire('age', 'failsafe_age', { age: elapsedBucket(now - started) });
  const samples = s.samples ?? [];
  const first = samples[0];
  if (s.wouldEndAt || !first || samples.length < 2 || now - first.t < LIFECYCLE.lowDisplacementWindowMs) return;
  const furthest = Math.max(...samples.map((p) => distanceM(first, p)));
  if (furthest >= LIFECYCLE.lowDisplacementM) return;
  if (!s.stopConfirmed) {
    // Parked, whatever the speeds said (GPS wander read as movement): a
    // temporary stop from the start of the window, so the grace period
    // still applies; never an end by itself
    if (!fired.includes('low_displacement')) fired.push('low_displacement');
    log.log('failsafe', { failsafe: 'low_displacement', window: elapsedBucket(now - first.t), agrees: false });
    s.stopStartedAt = iso(first.t);
    s.stopConfirmed = true;
    s.resumeRun = [];
    s.lastMovingPoint = { latitude: first.latitude, longitude: first.longitude, accuracyM: first.accuracyM };
    log.log('temporary_stop', { decidedAfter: elapsedBucket(now - first.t), by: 'failsafe', arrivedBefore: null });
  } else if (!fired.includes('low_displacement')) {
    // The stop rules got there first: the failsafe agrees
    fired.push('low_displacement');
    log.log('failsafe', { failsafe: 'low_displacement', window: elapsedBucket(now - first.t), agrees: true });
  }
}

/** One coarse position a minute over the low-displacement window (bounded) */
function sample(s: DriveLifecycleState, fix: GpsFix) {
  if (!good(fix.accuracyM, LIFECYCLE.moveMaxAccuracyM)) return;
  const list = (s.samples ??= []);
  const last = list[list.length - 1];
  if (last && fix.timestamp - last.t < 60_000) return;
  list.push(refOf(fix));
  // The oldest kept is the newest one at least a window old: the samples always cover the whole window
  while (list.length > 2 && fix.timestamp - list[1]!.t >= LIFECYCLE.lowDisplacementWindowMs) list.shift();
}

/**
 * The stricter rule for driving on after a temporary stop: resumeFixes
 * consecutive accurate fixes at vehicle speed, over at least resumeMinSpanMs,
 * covering the ground their speed says, and the car clear of the stop point.
 * Walking (or a phone carried about) never meets it.
 */
function resumeGrade(s: DriveLifecycleState, fix: GpsFix, movement: Movement): boolean {
  const L = LIFECYCLE;
  const run = (s.resumeRun ??= []);
  const fast = good(fix.accuracyM, L.resumeMaxAccuracyM) && movement.speedMs != null && msToKmh(movement.speedMs) >= L.resumeMinSpeedKmh;
  const prev = run[run.length - 1];
  if (!fast || (prev && fix.timestamp - prev.t > L.resumeMaxGapMs)) {
    s.resumeRun = fast ? [refOf(fix)] : [];
    return false;
  }
  run.push(refOf(fix));
  // Kept to the shortest run still spanning resumeMinSpanMs (about 9 fixes at one a second)
  while (run.length > L.resumeFixes && fix.timestamp - run[1]!.t >= L.resumeMinSpanMs) run.shift();
  if (run.length < L.resumeFixes) return false;
  const first = run[0]!;
  const span = fix.timestamp - first.t;
  if (span < L.resumeMinSpanMs) return false;
  // The ground covered agrees with the speed (no GPS jump)
  const covered = distanceM(first, fix);
  if (covered < L.moveConsistency * (L.resumeMinSpeedKmh / msToKmh(1)) * (span / 1000)) return false;
  const stop = s.lastMovingPoint;
  return !stop || distanceM(stop, fix) >= L.resumeMinFromStopM;
}

function bump(s: DriveLifecycleState, bucket: string) {
  const h = (s.stopHist ??= {});
  h[bucket] = (h[bucket] ?? 0) + 1;
}

/** Navigation arrived: noted, and what the classifier thought then */
export function noteLifecycleArrival(rec: Rec, now: number, deps: LifecycleDeps): void {
  shielded(rec, deps, () => arrival(rec, now, deps));
}

function arrival(rec: Rec, now: number, deps: LifecycleDeps): void {
  if (rec.endedAt) return;
  const s = stateOf(rec);
  // The same arrival seen again (the screen re-rendering it)
  if (s.arrivedAt != null && Math.abs(now - s.arrivedAt) < 60_000) return;
  s.arrivedAt = now;
  new Logger(s, deps).log('navigation_arrival_seen', { phase: lifecyclePhase(rec, now) });
}

/** At the end of a drive: one compact summary for calibration */
export function summariseLifecycle(rec: Rec, now: number, journal: Journal | undefined, path: LifecycleDeps['path']): void {
  shielded(rec, { journal, path }, () => summary(rec, now, journal, path));
}

function summary(rec: Rec, now: number, journal: Journal | undefined, path: LifecycleDeps['path']): void {
  const s = rec.lifecycle;
  if (!s) return;
  const end = rec.endedAt ? Date.parse(rec.endedAt) : now;
  const stops = s.stopHist ?? {};
  journal?.log('drive_lifecycle', {
    step: 'summary', path,
    phase: lifecyclePhase(rec, end),
    wouldEnd: s.autoEndReason ?? null,
    wouldEndEarlierBy: s.wouldEndAt ? elapsedBucket(end - Date.parse(s.wouldEndAt)) : null,
    closedStops: (s.closedStops ?? []).length,
    arrived: s.arrivedAt != null,
    failsafes: (s.failsafes ?? []).join(',') || null,
    stops: Object.entries(stops).map(([k, v]) => `${k}:${v}`).join(',') || null,
    active: elapsedBucket(activeDurationMs(rec, end)),
    wall: elapsedBucket(end - Date.parse(rec.startedAt)),
  });
}

// ─── The drive's duration ───────────────────────────────────────────────────

/**
 * How long the drive was actually driven (ms) at `endMs`: wall clock, less
 * manual pauses (including one still open) and temporary stops (closed, and
 * one still open from its backdated start). The drive timer, Drive Complete
 * and the saved journey (as excludedSeconds) all use it.
 */
export function activeDurationMs(rec: Rec, endMs: number): number {
  const start = Date.parse(rec.startedAt);
  const end = rec.endedAt ? Math.min(Date.parse(rec.endedAt), endMs) : endMs;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0;
  const clip = (from: number, to: number) => Math.max(0, Math.min(to, end) - Math.max(from, start));
  let excluded = rec.pausedMs ?? 0;
  if (rec.pausedAt) excluded += clip(Date.parse(rec.pausedAt), end);
  const s = rec.lifecycle ?? {};
  for (const stop of s.closedStops ?? []) excluded += clip(Date.parse(stop.from), Date.parse(stop.to));
  if (s.stopConfirmed && s.stopStartedAt) excluded += clip(Date.parse(s.stopStartedAt), end);
  return Math.max(0, end - start - excluded);
}

// ─── What the app acts on ───────────────────────────────────────────────────

export interface StopState {
  phase: LifecyclePhase;
  /** The stop point (ms): where the drive would end, backdated */
  stoppedAt: number | null;
  /** When the drive finishes by itself if nothing changes (ms) */
  graceEndsAt: number | null;
  /** Ask "Looks like you've stopped" now */
  prompt: boolean;
  /** Finished: end the drive at this time (ms) */
  endAt: number | null;
}

/** The stop the drive is in (if any), as the app acts on it */
export function stopState(rec: Rec, now: number): StopState {
  const phase = lifecyclePhase(rec, now);
  const s = rec.lifecycle ?? {};
  const endAt = s.wouldEndAt ? Date.parse(s.wouldEndAt) : null;
  if (phase === 'finished') return { phase, stoppedAt: endAt, graceEndsAt: null, prompt: false, endAt };
  if (phase !== 'temporarily_stopped') return { phase, stoppedAt: null, graceEndsAt: null, prompt: false, endAt: null };
  const stop = ms(s.stopStartedAt ?? anchorOf(rec, s));
  return {
    phase,
    stoppedAt: Number.isFinite(stop) ? stop : null,
    graceEndsAt: graceDeadline({ ...s, stopStartedAt: s.stopStartedAt ?? anchorOf(rec, s) }),
    prompt: !s.stopPromptShown,
    endAt: null,
  };
}

/**
 * Continue Drive, answering the stop prompt: the drive is kept open for
 * another grace period from now (driving on still resumes it as usual; the
 * time stopped still doesn't count), and the prompt isn't asked again for
 * this stop.
 */
export function continueAfterStop(rec: Rec, now: number, deps: LifecycleDeps): void {
  shielded(rec, deps, () => {
    const s = stateOf(rec);
    s.stopPromptShown = true;
    const until = now + LIFECYCLE.graceMs;
    const keep = ms(s.keepOpenUntil);
    s.keepOpenUntil = iso(Number.isFinite(keep) ? Math.max(keep, until) : until);
    new Logger(s, deps).log('user_continued', { stopped: elapsedBucket(now - ms(s.stopStartedAt ?? anchorOf(rec, s))) });
  });
}
