/**
 * The one background location stream, shared (Navigation background
 * guidance).
 *
 * The operating system's background location updates (one expo-location
 * task, lib/driveBackgroundLocation) have two possible users:
 *
 *  - the drive recorder (BackgroundDriveRecorder), exactly as before: it
 *    starts updates when a drive starts and stops them when it ends;
 *  - navigation, which reads the same fixes while the app is in the
 *    background, so guidance keeps up with the car.
 *
 * There is never a second stream: navigation only reads what the task
 * delivers. Navigation asks for the updates to stay on while it guides
 * (`holdForNavigation`), so the end of a drive doesn't cut them off mid-route;
 * it starts them itself only when there's no recording alongside (Passenger
 * Mode, or the drive was finished) and only if background access was already
 * granted: navigation never asks for a permission. When navigation ends, the
 * updates stop unless a drive is still using them.
 *
 * Every fix the task delivers goes to the recorder as before, and to the
 * listeners here (navigation) first; they only read it.
 *
 * No React Native imports, so it is unit-tested under node.
 */
import type { BackgroundTracking, LocationUpdates } from './driveTracking';
import type { GpsFix } from './journeyRecorder';
import { noJournal, type Journal } from './journal';

export type LocationUser = 'drive' | 'navigation';

/** The platform's background location updates (expo-location in the app). */
export interface NativeLocationUpdates {
  /**
   * Starts (or re-starts) updates for `user`. For the drive: as before
   * (asks for access the first time). For navigation: never asks; 'denied'
   * without access already granted.
   */
  start(user: LocationUser): Promise<Exclude<BackgroundTracking, 'off'>>;
  stop(): Promise<void>;
  isRunning(): Promise<boolean>;
  /** Already running: now for `user` (Android's notification text); may do nothing */
  relabel?(user: LocationUser): Promise<void>;
}

export type NavigationHold = 'shared' | 'started' | 'not-started' | Exclude<BackgroundTracking, 'off' | 'on'>;

export class SharedLocationUpdates {
  private navigationWants = false;
  /** Who the running updates were last started or relabelled for (Android's notification) */
  private label: LocationUser | null = null;
  private listeners = new Set<(fixes: GpsFix[]) => void>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly native: NativeLocationUpdates,
    private readonly deps: {
      /** Whether a drive is using the updates (the recorder has a drive in progress); true when unsure */
      driveInUse(): Promise<boolean>;
      journal?: Journal;
    },
  ) {}

  private get journal() { return this.deps.journal ?? noJournal; }

  /** Navigation is guiding and wants the updates kept on */
  get navigationActive(): boolean {
    return this.navigationWants;
  }

  /** Navigation's calls run one at a time */
  private serial<T>(job: () => Promise<T>): Promise<T> {
    const run = this.queue.then(job, job);
    this.queue = run.catch(() => {});
    return run;
  }

  /** What the drive recorder gets: the same contract as the plain updates */
  readonly drive: LocationUpdates = {
    start: async () => {
      const result = await this.native.start('drive');
      if (result === 'on') this.label = 'drive';
      return result;
    },
    stop: async () => {
      if (this.navigationWants) {
        // Navigation is still guiding: keep them on for it
        this.journal.log('location_shared', { action: 'kept_for_navigation' });
        if (this.label !== 'navigation') {
          this.label = 'navigation';
          await this.native.relabel?.('navigation').catch(() => {});
        }
        return;
      }
      this.label = null;
      await this.native.stop();
    },
    isRunning: () => this.native.isRunning(),
  };

  /**
   * Navigation is guiding. The updates stay on while it does; with `start`
   * (no recording alongside) they're started for it if they aren't running,
   * and only with access already granted.
   */
  holdForNavigation(start: boolean): Promise<NavigationHold> {
    this.navigationWants = true;
    return this.serial(async () => {
      if (!this.navigationWants) return 'not-started';
      if (await this.native.isRunning().catch(() => false)) return 'shared';
      if (!start) return 'not-started';
      const result = await this.native.start('navigation').catch(() => 'unavailable' as const);
      if (result !== 'on') {
        await this.native.stop().catch(() => {});
        return result;
      }
      this.label = 'navigation';
      return 'started';
    });
  }

  /** Navigation ended: the updates stop, unless a drive is using them */
  releaseForNavigation(): Promise<void> {
    if (!this.navigationWants) return Promise.resolve();
    this.navigationWants = false;
    return this.serial(async () => {
      if (this.navigationWants) return;
      if (await this.deps.driveInUse().catch(() => true)) return;
      if (await this.native.isRunning().catch(() => false)) {
        this.label = null;
        await this.native.stop().catch(() => {});
        this.journal.log('location_shared', { action: 'stopped_after_navigation' });
      }
    });
  }

  /** Reads every background fix the task delivers (navigation) */
  subscribe(fn: (fixes: GpsFix[]) => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  /** Fixes from the background location task, in time order: readers first, never changed */
  deliver(fixes: readonly GpsFix[]): void {
    if (!fixes.length) return;
    for (const fn of [...this.listeners]) {
      try {
        fn(fixes.map((f) => ({ ...f })));
      } catch {
        // A reader's failure never affects recording
      }
    }
  }
}
