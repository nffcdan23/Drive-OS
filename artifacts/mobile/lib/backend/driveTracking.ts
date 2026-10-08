/**
 * Recording a drive while the app is in the background.
 *
 * The Drive screen's location watcher only runs while the app is on screen.
 * While a drive is in progress, the operating system's background location
 * updates (expo-location + expo-task-manager, see lib/driveBackgroundLocation)
 * keep delivering fixes after the user switches apps or locks the phone.
 * Those fixes come here, and go to the same recorder as the screen's:
 *
 *  - while CloudSync is running (the app is open, or in the background but
 *    still alive, the usual case) they are handed straight to it, so the
 *    drive in memory, its upload and the live route on screen all see them;
 *  - when the system relaunched the app in the background with no screens
 *    (after iOS ended it mid-drive), there is no CloudSync, so they are
 *    applied to the drive saved on the device, with the same rules.  CloudSync
 *    picks the drive up from there when the app is next opened.
 *
 * Background updates run only between the start and end of a drive.  The
 * drive they belong to (user and clientRef) is saved on the device, so a fix
 * can never land on a different drive, and updates found running with no
 * drive in progress are stopped.
 *
 * No React Native imports, so it is unit-tested under node with a fake
 * LocationUpdates.
 */
import {
  JourneyStore, acceptDriveFix, lastRecordedFix, noteFixTime, recordFix,
  type FixRef, type GpsFix, type JourneyRecord,
} from './journeyRecorder';
import { noJournal, type Journal } from './journal';
import { errorText, readJsonChecked, writeJson, type KeyValueStore } from './storage';

/** The drive background updates belong to. */
export interface DriveSession {
  userId: string;
  clientRef: string;
}

/**
 * Whether the drive in progress is also recorded in the background:
 *  - on: background updates are running;
 *  - denied: no location access at all (nothing can be recorded);
 *  - always-declined: the user just answered the "Always" prompt with
 *    something other than Always (recorded only while open);
 *  - always-off: "Always" isn't allowed and won't be asked for again (asked
 *    on an earlier drive, or changed in Settings); recorded only while open;
 *  - unavailable: this build or device can't (e.g. no background location
 *    capability in the build, or Expo Go);
 *  - off: no drive, or not started yet.
 */
export type BackgroundTracking = 'off' | 'on' | 'denied' | 'always-declined' | 'always-off' | 'unavailable';

// ─── Permission ─────────────────────────────────────────────────────────────
//
// Expo's background location updates need background permission, which is
// iOS "Always".  It is asked for once, when the first drive starts (the map
// asks for foreground, "While Using", when it opens).  iOS shows the
// "Always" prompt only once per install, and expo-location can't tell after a
// relaunch whether it was shown, so whether it was is remembered here; after
// that, drives record in the background only if the user chose Always (or
// turns it on in Settings later), and never prompt again.

/** The platform's location permissions (expo-location in the app). */
export interface LocationPermissions {
  /** Asks for foreground ("While Using") access if not yet answered; true when granted. */
  requestForeground(): Promise<boolean>;
  /** Background ("Always") access, without asking. */
  hasBackground(): Promise<boolean>;
  /** Asks for background access; whether it was granted, and whether a prompt appeared. */
  requestBackground(): Promise<{ granted: boolean; promptShown: boolean }>;
}

export const ALWAYS_PROMPT_SHOWN_KEY = '@driveos/drive/always-prompt-shown';

/** Gets the location access a background drive recording needs, asking at most once. */
export async function ensureBackgroundAccess(
  permissions: LocationPermissions,
  store: KeyValueStore,
): Promise<'granted' | 'denied' | 'always-declined' | 'always-off'> {
  if (!(await permissions.requestForeground())) return 'denied';
  if (await permissions.hasBackground()) return 'granted';
  if (await store.getItem(ALWAYS_PROMPT_SHOWN_KEY)) return 'always-off';
  const answer = await permissions.requestBackground();
  if (answer.promptShown) await store.setItem(ALWAYS_PROMPT_SHOWN_KEY, '1');
  if (answer.granted) return 'granted';
  // No prompt appeared (e.g. "Allow Once" access, where iOS won't offer
  // Always): try again on a later drive.
  return answer.promptShown ? 'always-declined' : 'always-off';
}

/** The platform's background location updates (expo-location in the app). */
export interface LocationUpdates {
  /** Starts updates; says why not when they can't run. */
  start(): Promise<Exclude<BackgroundTracking, 'off'>>;
  stop(): Promise<void>;
  isRunning(): Promise<boolean>;
}

/** What CloudSync needs from background recording. */
export interface DriveTracker {
  /** Starts background updates for this drive and checks they are running. */
  start(session: DriveSession): Promise<Exclude<BackgroundTracking, 'off'>>;
  /** Stops background updates; nothing more is recorded after this resolves. */
  stop(): Promise<void>;
  /**
   * The drive background updates are running for, if any; 'unknown' when
   * updates are running but the saved session couldn't be read (the caller
   * decides from its own drive, and may adopt() it).
   */
  running(): Promise<DriveSession | null | 'unknown'>;
  /** Re-asserts the session for running updates whose saved session couldn't be read. */
  adopt(session: DriveSession): Promise<void>;
  /**
   * Hands background fixes for `userId`'s drives to `onFixes` until the
   * returned function is called.  Anything recorded without a listener is
   * saved to the device first, so the caller can then load the drive.
   */
  attach(userId: string, onFixes: (fixes: GpsFix[]) => void): Promise<() => void>;
}

export const DRIVE_SESSION_KEY = '@driveos/drive/background-session';
/** With no CloudSync running, the drive is saved at most this often. */
export const HEADLESS_SAVE_EVERY_MS = 10_000;
/**
 * Fixes held in memory while the drive (or its session) can't be read, to be
 * recorded once it can: about two hours at one a second.
 */
export const HELD_FIXES_MAX = 7_200;

interface Headless {
  journeys: JourneyStore;
  rec: JourneyRecord;
  last: FixRef | null;
  dirty: boolean;
  savedAt: number;
}

const isSession = (v: unknown): boolean =>
  !!v && typeof v === 'object' && typeof (v as DriveSession).userId === 'string' && typeof (v as DriveSession).clientRef === 'string';

export class BackgroundDriveRecorder implements DriveTracker {
  /** undefined until read from the device (or after a read that failed) */
  private session: DriveSession | null | undefined;
  private listener: { userId: string; onFixes: (fixes: GpsFix[]) => void } | null = null;
  private headless: Headless | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  /** Fixes that arrived while their drive couldn't be read: recorded once it can */
  private held: GpsFix[] = [];
  private deliveries = 0;

  constructor(private readonly deps: { store: KeyValueStore; updates: LocationUpdates; now?: () => number; journal?: Journal }) {}

  private now() { return this.deps.now ? this.deps.now() : Date.now(); }
  private get journal() { return this.deps.journal ?? noJournal; }

  /** Runs jobs one at a time, so fixes, hand-over and stop never interleave. */
  private serial<T>(job: () => Promise<T>): Promise<T> {
    const run = this.queue.then(job, job);
    this.queue = run.catch(() => {});
    return run;
  }

  /** The saved session; 'unreadable' when the read failed (retried next time, never taken as "no drive"). */
  private async loadSession(): Promise<DriveSession | null | 'unreadable'> {
    if (this.session !== undefined) return this.session;
    const read = await readJsonChecked<DriveSession>(this.deps.store, DRIVE_SESSION_KEY, isSession);
    if (!read.ok) {
      this.journal.log('storage_read_failed', { what: 'background-session', reason: read.reason, error: read.error });
      return 'unreadable';
    }
    this.session = read.value;
    return this.session;
  }

  private async setSession(session: DriveSession | null) {
    this.session = session;
    try {
      if (session) await writeJson(this.deps.store, DRIVE_SESSION_KEY, session);
      else await this.deps.store.removeItem(DRIVE_SESSION_KEY);
    } catch (err) {
      this.journal.log('storage_write_failed', { what: 'background-session', error: errorText(err) });
      throw err;
    }
  }

  start(session: DriveSession) {
    return this.serial(async () => {
      this.headless = null;
      this.held = [];
      // Saved first: the first background fix may arrive before start() returns.
      await this.setSession(session);
      let result: Exclude<BackgroundTracking, 'off'>;
      try {
        result = await this.deps.updates.start();
        if (result === 'on' && !(await this.deps.updates.isRunning())) result = 'unavailable';
      } catch {
        result = 'unavailable';
      }
      this.journal.log('tracking_start', { clientRef: session.clientRef, result });
      if (result !== 'on') {
        await this.deps.updates.stop().catch(() => {});
        await this.setSession(null).catch(() => {});
      }
      return result;
    });
  }

  stop() {
    return this.serial(() => this.stopNow('requested'));
  }

  private async stopNow(reason: string) {
    try {
      if (await this.deps.updates.isRunning()) await this.deps.updates.stop();
    } catch {
      // Not running (or already stopped by the system).
    }
    this.journal.log('tracking_stop', { reason, clientRef: this.session ? this.session.clientRef : null });
    await this.flushHeadless();
    this.headless = null;
    this.held = [];
    await this.setSession(null);
  }

  running() {
    return this.serial(async (): Promise<DriveSession | null | 'unknown'> => {
      const session = await this.loadSession();
      const updates = await this.deps.updates.isRunning().catch(() => false);
      if (session === 'unreadable') return updates ? 'unknown' : null;
      if (!session) return null;
      return updates ? session : null;
    });
  }

  adopt(session: DriveSession) {
    return this.serial(async () => {
      this.journal.log('tracking_adopt', { clientRef: session.clientRef });
      this.session = session;
      await writeJson(this.deps.store, DRIVE_SESSION_KEY, session).catch((err) => {
        this.journal.log('storage_write_failed', { what: 'background-session', error: errorText(err) });
      });
    });
  }

  async attach(userId: string, onFixes: (fixes: GpsFix[]) => void): Promise<() => void> {
    const listener = { userId, onFixes };
    await this.serial(async () => {
      await this.flushHeadless();
      this.headless = null;
      this.listener = listener;
      // Fixes held while nothing could be read go to the listener, which
      // records them (or drops them, with no drive in progress)
      if (this.held.length) {
        const held = this.held;
        this.held = [];
        onFixes(held);
      }
    });
    return () => { if (this.listener === listener) this.listener = null; };
  }

  /** Fixes from the background location task. */
  deliver(fixes: GpsFix[]): Promise<void> {
    return this.serial(async () => {
      if (++this.deliveries === 1) this.journal.log('background_fixes', { first: true, count: fixes.length, listener: !!this.listener });
      const session = await this.loadSession();
      if (session === 'unreadable') {
        // Not "no drive": keep recording.  With CloudSync listening, it
        // decides (it knows its drive); otherwise hold the fixes for later.
        if (this.listener) this.listener.onFixes(fixes);
        else this.hold(fixes);
        return;
      }
      if (!session) {
        // Updates with no drive in progress (left over from a crash, say):
        // stop them rather than track with nothing to record.
        await this.stopNow('no-drive');
        return;
      }
      if (this.listener) {
        // Another account signed in on this phone: not its drive.
        if (this.listener.userId === session.userId) this.listener.onFixes(fixes);
        return;
      }
      await this.recordHeadless(session, fixes);
    });
  }

  private hold(fixes: GpsFix[]) {
    if (!this.held.length) this.journal.log('background_fixes_held', { count: fixes.length });
    this.held.push(...fixes);
    if (this.held.length > HELD_FIXES_MAX) this.held.splice(0, this.held.length - HELD_FIXES_MAX);
  }

  /** No CloudSync running: apply the fixes to the drive saved on the device. */
  private async recordHeadless(session: DriveSession, fixes: GpsFix[]) {
    let h = this.headless;
    if (!h || h.rec.clientRef !== session.clientRef) {
      const journeys = new JourneyStore(this.deps.store, session.userId);
      const read = await journeys.readActive();
      if (!read.ok) {
        // Couldn't read the drive: never taken for "no drive".  Hold the
        // fixes and try again with the next batch; CloudSync preserves an
        // unreadable record when it starts.
        this.journal.log('storage_read_failed', { what: 'active-drive', reason: read.reason, error: read.error, clientRef: session.clientRef });
        this.hold(fixes);
        return;
      }
      const rec = read.value;
      if (!rec || rec.clientRef !== session.clientRef || rec.endedAt) {
        // The drive was ended (or discarded) without stopping the updates.
        await this.stopNow('drive-not-in-progress');
        return;
      }
      h = this.headless = { journeys, rec, last: lastRecordedFix(rec), dirty: false, savedAt: this.now() };
    }
    const all = this.held.length ? [...this.held, ...fixes] : fixes;
    this.held = [];
    for (const fix of all) {
      noteFixTime(h.rec, fix);
      h.dirty = true;
      if (!acceptDriveFix(h.rec, h.last, fix)) continue;
      h.last = fix;
      recordFix(h.rec, fix);
    }
    if (h.dirty && this.now() - h.savedAt >= HEADLESS_SAVE_EVERY_MS) await this.flushHeadless();
  }

  private async flushHeadless() {
    const h = this.headless;
    if (!h || !h.dirty) return;
    h.savedAt = this.now();
    try {
      await h.journeys.saveActive(h.rec);
      h.dirty = false;
    } catch (err) {
      // Still dirty: saved with the next batch.
      this.journal.log('storage_write_failed', { what: 'active-drive', clientRef: h.rec.clientRef, error: errorText(err) });
    }
  }
}
