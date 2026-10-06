/**
 * Reports this user's presence (on screen / in the background / driving) to
 * the API, which turns it into Online, Away, Offline or Driving for friends
 * (see the 0016 migration: the status is derived from timestamps, so a phone
 * that stops reporting drifts to Away and then Offline by itself).
 *
 * What is sent, and when:
 *  - at start, and on every change of app state or drive state, at once;
 *  - every 60 s while the app is on screen;
 *  - during a drive, at most every 60 s, piggybacking on the drive's own GPS
 *    fixes (noteDriveActivity), which keep arriving with the phone locked;
 *    no extra timers or location work in the background;
 *  - "signed_out" just before signing out (best effort, never blocks it).
 *
 * Presence is never critical: failures are swallowed (the next heartbeat
 * tries again) and nothing here can throw into the app.
 *
 * No React Native imports, so it is unit-tested under node.
 */
import { ApiError } from './http';

export type PresenceAppState = 'foreground' | 'background';

export interface PresenceUpdate {
  appState: PresenceAppState | 'signed_out';
  driving?: boolean;
  /** The server journey being recorded; omitted when not known yet. */
  journeyId?: string | null;
}

export interface DriveState {
  driving: boolean;
  /** Server id of the drive in progress, once it has one (null while offline). */
  journeyId: string | null;
}

export const PRESENCE_HEARTBEAT_MS = 60_000;
/** Sign-out waits at most this long for the "signed out" update. */
export const PRESENCE_SIGN_OUT_WAIT_MS = 3_000;

export interface PresenceDeps {
  send: (update: PresenceUpdate) => Promise<unknown>;
  now?: () => number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
  /** Called with heartbeat failures (development logging only). */
  onError?: (err: unknown) => void;
}

export class PresenceReporter {
  private appState: PresenceAppState = 'foreground';
  private drive: DriveState = { driving: false, journeyId: null };
  private timer: unknown = null;
  private running = false;
  private lastSentAt = -Infinity;
  private inFlight: Promise<void> | null = null;
  private again = false;

  constructor(private readonly deps: PresenceDeps) {}

  private now() { return this.deps.now ? this.deps.now() : Date.now(); }

  get isRunning() { return this.running; }

  /** Begins reporting (after sign-in and app start-up), with the current state. */
  start(appState: PresenceAppState, drive: DriveState): void {
    if (this.running) return;
    this.running = true;
    this.appState = appState;
    this.drive = { ...drive };
    this.updateTimer();
    this.report();
  }

  /** The app went to the background or came back. Driving is unaffected. */
  setAppState(appState: PresenceAppState): void {
    if (!this.running || appState === this.appState) return;
    this.appState = appState;
    this.updateTimer();
    this.report();
  }

  /** A drive started, ended, was discarded or recovered, or got its server id. */
  setDrive(drive: DriveState): void {
    if (!this.running) return;
    const next = { driving: drive.driving, journeyId: drive.driving ? drive.journeyId : null };
    if (next.driving === this.drive.driving && next.journeyId === this.drive.journeyId) return;
    this.drive = next;
    this.updateTimer();
    this.report();
  }

  /**
   * A GPS fix arrived for the drive in progress (on screen or in the
   * background). Keeps "Driving" fresh while the phone is locked, at most
   * once a heartbeat interval.
   */
  noteDriveActivity(): void {
    if (!this.running || !this.drive.driving) return;
    if (this.now() - this.lastSentAt >= PRESENCE_HEARTBEAT_MS) this.report();
  }

  /** Stops all reporting (provider unmounted, account switched). */
  stop(): void {
    this.running = false;
    this.clearTimer();
  }

  /**
   * Reports "signed out" (best effort, waiting at most a few seconds) and
   * stops. Never throws, so sign-out always goes ahead.
   */
  async signOut(): Promise<void> {
    const wasRunning = this.running;
    this.stop();
    if (!wasRunning) return;
    const sent = this.deps.send({ appState: 'signed_out' }).catch(() => {});
    let wait: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([sent, new Promise((r) => { wait = setTimeout(r, PRESENCE_SIGN_OUT_WAIT_MS); })]);
    clearTimeout(wait);
  }

  // A timer runs while on screen, and while driving (if the system keeps
  // JavaScript running in the background it helps; drive fixes cover it if not).
  private updateTimer() {
    const wanted = this.running && (this.appState === 'foreground' || this.drive.driving);
    if (wanted && this.timer == null) {
      const set = this.deps.setInterval ?? ((fn: () => void, ms: number) => setInterval(fn, ms));
      this.timer = set(() => this.report(), PRESENCE_HEARTBEAT_MS);
    } else if (!wanted) {
      this.clearTimer();
    }
  }

  private clearTimer() {
    if (this.timer == null) return;
    const clear = this.deps.clearInterval ?? ((h: unknown) => clearInterval(h as ReturnType<typeof setInterval>));
    clear(this.timer);
    this.timer = null;
  }

  /** Sends the current state; one request at a time, the latest state wins. */
  private report(): void {
    if (!this.running) return;
    if (this.inFlight) { this.again = true; return; }
    this.lastSentAt = this.now();
    this.inFlight = this.sendCurrent().finally(() => {
      this.inFlight = null;
      if (this.again) { this.again = false; this.report(); }
    });
  }

  private async sendCurrent(): Promise<void> {
    const update: PresenceUpdate = { appState: this.appState, driving: this.drive.driving };
    if (this.drive.driving && this.drive.journeyId) update.journeyId = this.drive.journeyId;
    try {
      await this.deps.send(update);
    } catch (err) {
      // The journey ended or was deleted on the server meanwhile: report the
      // drive without it rather than not at all.
      if (err instanceof ApiError && err.code === 'invalid_journey' && update.journeyId) {
        this.drive = { ...this.drive, journeyId: null };
        await this.deps.send({ appState: this.appState, driving: this.drive.driving, journeyId: null }).catch((e) => this.deps.onError?.(e));
        return;
      }
      this.deps.onError?.(err);
    }
  }
}
