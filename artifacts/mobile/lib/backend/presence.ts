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

/** Why an update was sent (for development diagnostics). */
export type PresenceReason = 'startup' | 'heartbeat' | 'app-state' | 'drive-change' | 'drive-activity' | 'journey-retry';

/** One update and its outcome (development diagnostics; never tokens or coordinates). */
export interface PresenceLogEntry {
  reason: PresenceReason;
  update: PresenceUpdate;
  outcome: 'ok' | 'failed';
  /** Error code or message when it failed. */
  error?: string;
}

export const PRESENCE_HEARTBEAT_MS = 60_000;

// ─── Friends' presence, received ────────────────────────────────────────────

export type FriendPresenceStatus = 'online' | 'away' | 'offline' | 'driving';

/** A live update from the user's Realtime inbox (migration 0017). */
export type PresenceEvent =
  | { type: 'presence'; userId: string; status: FriendPresenceStatus; lastSeenAt: string | null }
  | { type: 'hidden'; userId: string }
  | { type: 'unfriended'; userId: string };

const STATUSES: readonly FriendPresenceStatus[] = ['online', 'away', 'offline', 'driving'];

/** Validates an inbox payload; anything unexpected is ignored (null). */
export function parsePresenceEvent(payload: unknown): PresenceEvent | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.userId !== 'string' || !p.userId) return null;
  if (p.type === 'hidden' || p.type === 'unfriended') return { type: p.type, userId: p.userId };
  if (p.type !== 'presence' || !STATUSES.includes(p.status as FriendPresenceStatus)) return null;
  return {
    type: 'presence', userId: p.userId, status: p.status as FriendPresenceStatus,
    lastSeenAt: typeof p.lastSeenAt === 'string' ? p.lastSeenAt : null,
  };
}

/**
 * A status as it stands `now`, given when it was received: the server's
 * rules (0016) applied on the device, so a friend whose phone stops
 * reporting (crash, no signal) drifts to Away and then Offline on screen
 * without another message. Timed from receipt, so the two phones' clocks
 * don't matter.
 */
export function decayPresence(status: FriendPresenceStatus | null, receivedAt: number | null | undefined, now: number): FriendPresenceStatus | null {
  if (status == null || receivedAt == null || status === 'offline') return status;
  const age = now - receivedAt;
  if (age > 10 * 60_000) return 'offline';
  if (status === 'driving') return age <= 3 * 60_000 ? 'driving' : 'away';
  if (status === 'online') return age <= 2 * 60_000 ? 'online' : 'away';
  return 'away';
}
/** Sign-out waits at most this long for the "signed out" update. */
export const PRESENCE_SIGN_OUT_WAIT_MS = 3_000;

export interface PresenceDeps {
  send: (update: PresenceUpdate) => Promise<unknown>;
  now?: () => number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
  /** Called with every update sent and whether it succeeded (development diagnostics). */
  log?: (entry: PresenceLogEntry) => void;
}

export class PresenceReporter {
  private appState: PresenceAppState = 'foreground';
  private drive: DriveState = { driving: false, journeyId: null };
  private timer: unknown = null;
  private running = false;
  private lastSentAt = -Infinity;
  private inFlight: Promise<void> | null = null;
  private again: PresenceReason | null = null;

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
    this.report('startup');
  }

  /** The app went to the background or came back. Driving is unaffected. */
  setAppState(appState: PresenceAppState): void {
    if (!this.running || appState === this.appState) return;
    this.appState = appState;
    this.updateTimer();
    this.report('app-state');
  }

  /** A drive started, ended, was discarded or recovered, or got its server id. */
  setDrive(drive: DriveState): void {
    if (!this.running) return;
    const next = { driving: drive.driving, journeyId: drive.driving ? drive.journeyId : null };
    if (next.driving === this.drive.driving && next.journeyId === this.drive.journeyId) return;
    this.drive = next;
    this.updateTimer();
    this.report('drive-change');
  }

  /**
   * A GPS fix arrived for the drive in progress (on screen or in the
   * background). Keeps "Driving" fresh while the phone is locked, at most
   * once a heartbeat interval.
   */
  noteDriveActivity(): void {
    if (!this.running || !this.drive.driving) return;
    if (this.now() - this.lastSentAt >= PRESENCE_HEARTBEAT_MS) this.report('drive-activity');
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
      this.timer = set(() => this.report('heartbeat'), PRESENCE_HEARTBEAT_MS);
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
  private report(reason: PresenceReason): void {
    if (!this.running) return;
    // A state change while a request is out is sent as soon as it returns
    // (a change outranks a routine heartbeat as the reason).
    if (this.inFlight) {
      if (!this.again || this.again === 'heartbeat' || this.again === 'drive-activity') this.again = reason;
      return;
    }
    this.lastSentAt = this.now();
    this.inFlight = this.sendCurrent(reason).finally(() => {
      this.inFlight = null;
      const next = this.again;
      this.again = null;
      if (next) this.report(next);
    });
  }

  private async sendCurrent(reason: PresenceReason): Promise<void> {
    const update: PresenceUpdate = { appState: this.appState, driving: this.drive.driving };
    if (this.drive.driving && this.drive.journeyId) update.journeyId = this.drive.journeyId;
    await this.attempt(reason, update);
  }

  /** Sends one update; true when it succeeded (or was handled). */
  private async attempt(reason: PresenceReason, update: PresenceUpdate): Promise<boolean> {
    try {
      await this.deps.send(update);
      this.deps.log?.({ reason, update, outcome: 'ok' });
      return true;
    } catch (err) {
      this.deps.log?.({ reason, update, outcome: 'failed', error: describe(err) });
      // The journey ended or was deleted on the server meanwhile: report the
      // drive without it rather than not at all.
      if (err instanceof ApiError && err.code === 'invalid_journey' && update.journeyId) {
        this.drive = { ...this.drive, journeyId: null };
        return this.attempt('journey-retry', { appState: this.appState, driving: this.drive.driving, journeyId: null });
      }
      return false;
    }
  }
}

function describe(err: unknown): string {
  if (err instanceof ApiError) return `${err.status} ${err.code}`;
  return err instanceof Error ? err.name || err.message : String(err);
}
