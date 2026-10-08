// The follow camera's writes to the map.
//
// The Drive screen's frame loop produces a camera pose every frame while
// following.  Writing each one straight to the map is what built the crash
// seen on device: on Mapbox each write was a promise-returning native command
// run on the main thread, and JavaScript could issue them faster than the
// main thread resolved them, so thousands queued up (iOS watchdog kills,
// multi-gigabyte memory).
//
// Every pose now goes through a LatestPoseWriter:
//  - at most ONE write is in flight; the next starts only once it's applied;
//  - while one is in flight, a newer pose REPLACES the waiting one: only the
//    newest is ever written, never every pose in between;
//  - a pose within the tolerance of the last one written isn't written;
//  - writes are at most minIntervalMs apart (a visual rate, about 60 a second);
//  - paused (the app not on screen), nothing is written and nothing waits:
//    on resume the next frame's pose is written, no missed poses replayed;
//  - a write that never reports back is given up on after timeoutMs, so the
//    camera can't freeze, and still nothing piles up.
// So however fast poses arrive, there is one write in flight and one pose
// waiting, at most.
//
// Kept free of React Native imports so it can be unit-tested under node.

import type { FollowCameraPose } from "./locationSmoothing";
import { metersBetween } from "./locationSmoothing";

export const CAMERA_WRITES = {
  /** Writes at most this often (ms): about 60 a second */
  minIntervalMs: 16,
  /** A write not reported applied after this long (ms) is given up on */
  timeoutMs: 1000,
  /** Changes smaller than these aren't written (invisible on screen) */
  tolerance: { centerM: 0.03, headingDeg: 0.03, pitchDeg: 0.03, zoom: 0.0005 },
} as const;

export interface CameraWriterStats {
  /** Writes started and not yet applied (0 or 1) */
  inFlight: number;
  /** Poses waiting to be written (0 or 1) */
  waiting: number;
  written: number;
  /** Poses skipped as unchanged */
  skipped: number;
  /** Waiting poses replaced by a newer one before being written */
  replaced: number;
  /** Poses dropped while paused */
  dropped: number;
  timedOut: number;
  /** The most ever in flight at once (stays 1) */
  maxInFlight: number;
}

export interface LatestPoseWriterDeps<P> {
  /** Writes a pose; calls `applied` once the map has it */
  write(pose: P, applied: () => void): void;
  /** Whether two poses look the same on screen */
  same(a: P, b: P): boolean;
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(timer: unknown): void;
  minIntervalMs?: number;
  timeoutMs?: number;
}

export class LatestPoseWriter<P> {
  private waiting: P | null = null;
  private lastWritten: P | null = null;
  private lastWriteAt = -Infinity;
  private inFlight: number | null = null; // the write's token
  private token = 0;
  private timeout: unknown = null;
  private wake: unknown = null;
  private paused = false;
  private counts = {
    written: 0,
    skipped: 0,
    replaced: 0,
    dropped: 0,
    timedOut: 0,
    maxInFlight: 0,
  };

  constructor(private readonly deps: LatestPoseWriterDeps<P>) {}

  private get minInterval() {
    return this.deps.minIntervalMs ?? CAMERA_WRITES.minIntervalMs;
  }
  private get timeoutMs() {
    return this.deps.timeoutMs ?? CAMERA_WRITES.timeoutMs;
  }

  /** A new pose: written now if nothing is in flight, otherwise the one waiting */
  submit(pose: P): void {
    if (this.paused) {
      this.counts.dropped++;
      return;
    }
    if (this.waiting) this.counts.replaced++;
    this.waiting = pose;
    this.pump();
  }

  /** Stops writing; the waiting pose is dropped, not kept for later */
  pause(): void {
    this.paused = true;
    if (this.waiting) this.counts.dropped++;
    this.waiting = null;
    if (this.wake != null) {
      this.deps.clearTimer(this.wake);
      this.wake = null;
    }
  }

  /** Writing may start again (from the next pose submitted) */
  resume(): void {
    this.paused = false;
  }

  /**
   * Forget the last pose written, so the next one is written even if it
   * matches (the map was moved by something else, e.g. the user)
   */
  invalidate(): void {
    this.lastWritten = null;
  }

  get stats(): CameraWriterStats {
    return {
      ...this.counts,
      inFlight: this.inFlight == null ? 0 : 1,
      waiting: this.waiting ? 1 : 0,
    };
  }

  private pump() {
    if (this.paused || this.inFlight != null || !this.waiting) return;
    const pose = this.waiting;
    if (this.lastWritten && this.deps.same(pose, this.lastWritten)) {
      this.waiting = null;
      this.counts.skipped++;
      return;
    }
    const wait = this.lastWriteAt + this.minInterval - this.deps.now();
    if (wait > 0) {
      if (this.wake == null) {
        this.wake = this.deps.setTimer(() => {
          this.wake = null;
          this.pump();
        }, wait);
      }
      return;
    }
    this.waiting = null;
    this.lastWritten = pose;
    this.lastWriteAt = this.deps.now();
    const token = ++this.token;
    this.inFlight = token;
    this.counts.written++;
    this.counts.maxInFlight = Math.max(this.counts.maxInFlight, 1);
    this.timeout = this.deps.setTimer(() => {
      if (this.inFlight !== token) return;
      this.counts.timedOut++;
      this.finish(token);
    }, this.timeoutMs);
    this.deps.write(pose, () => this.finish(token));
  }

  private finish(token: number) {
    if (this.inFlight !== token) return; // late or repeated report
    this.inFlight = null;
    if (this.timeout != null) {
      this.deps.clearTimer(this.timeout);
      this.timeout = null;
    }
    this.pump();
  }
}

/** Whether two follow-camera poses would look the same on screen */
export function sameFollowPose(
  a: FollowCameraPose,
  b: FollowCameraPose,
): boolean {
  const t = CAMERA_WRITES.tolerance;
  const d = metersBetween(a.center, b.center);
  const turn = Math.abs(((a.heading - b.heading + 540) % 360) - 180);
  return (
    Math.hypot(d.x, d.y) < t.centerM &&
    turn < t.headingDeg &&
    Math.abs(a.pitch - b.pitch) < t.pitchDeg &&
    Math.abs(a.zoom - b.zoom) < t.zoom
  );
}
