/**
 * Live friend presence and shared live locations: the user's private
 * Realtime inbox (`inbox:<user id>`, migrations 0017 and 0018), kept open
 * only while the app is on screen.
 *
 *  - On screen: join the inbox; once joined, load a fresh friends snapshot
 *    (so nothing sent while the app was closed is missed), then apply each
 *    update as it arrives. Updates that arrive while the snapshot loads are
 *    held and applied after it, so an older snapshot never overwrites them.
 *  - In the background: leave the inbox (no socket kept open), and drop
 *    every shared live location (onLeave): positions are never kept while
 *    nothing can tell us they were revoked. The snapshot on return reloads
 *    the ones still shared.
 *  - On a dropped or refused connection (network, expired token): rejoin
 *    with backoff while on screen. The join fetches a current token first.
 *  - Every 30 s on screen, statuses that have gone quiet age out
 *    (decayPresence), so a friend whose phone died doesn't stay Online.
 *
 * Realtime is never critical: if it can't connect, the friend list keeps
 * the last snapshot and pull-to-refresh still works.
 *
 * No React Native imports (the Supabase channel is passed in as `open`),
 * so it is unit-tested under node.
 */
import { parsePresenceEvent, type PresenceEvent } from './presence';
import { parseLiveLocationEvent, type LiveLocationEvent } from './liveLocation';

/** Anything the inbox delivers: presence (0017) or live location (0018). */
export type InboxEvent = PresenceEvent | LiveLocationEvent;

export interface InboxConnection {
  close(): void;
}

export type InboxStatus = 'subscribed' | 'error' | 'closed';

export interface PresenceFeedDeps {
  /** Joins the inbox with a current token; status callbacks report the join and any drop. */
  open(handlers: { onEvent: (payload: unknown) => void; onStatus: (status: InboxStatus) => void }): Promise<InboxConnection>;
  /**
   * Loads the snapshot (GET /friends, GET /live-locations). `isCurrent()`
   * turns false if the app left the screen meanwhile: a late result must not
   * bring back positions that were dropped.
   */
  snapshot(isCurrent: () => boolean): Promise<void>;
  /** Merges one update into the friend list or the shared locations. */
  apply(event: InboxEvent): void;
  /** Ages out statuses and positions that have gone quiet. */
  decay(): void;
  /** The app left the screen: drop whatever can't be kept up to date. */
  onLeave?(): void;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
  /** Development diagnostics. */
  log?: (message: string) => void;
}

/** Waits before rejoining after a failure: 2 s, 5 s, 15 s, then every 30 s. */
export const FEED_RETRY_MS = [2_000, 5_000, 15_000, 30_000] as const;
export const FEED_DECAY_EVERY_MS = 30_000;

export class PresenceFeed {
  private active = false;
  private stopped = false;
  /** Bumped on every join attempt and every leave; late callbacks from older ones are ignored. */
  private generation = 0;
  private connection: InboxConnection | null = null;
  private joined = false;
  private retryTimer: unknown = null;
  private retries = 0;
  private decayTimer: unknown = null;
  private snapshotting = false;
  private held: InboxEvent[] = [];

  constructor(private readonly deps: PresenceFeedDeps) {}

  get isConnected() { return this.joined; }

  /** The app is on screen (true) or not. Repeated calls with the same value do nothing. */
  setActive(active: boolean): void {
    if (this.stopped || active === this.active) return;
    this.active = active;
    if (active) {
      this.deps.decay();
      const every = this.deps.setInterval ?? ((fn: () => void, ms: number) => setInterval(fn, ms));
      this.decayTimer = every(() => this.deps.decay(), FEED_DECAY_EVERY_MS);
      this.retries = 0;
      void this.join();
    } else {
      this.leave();
      this.deps.onLeave?.();
      if (this.decayTimer != null) {
        (this.deps.clearInterval ?? ((h: unknown) => clearInterval(h as ReturnType<typeof setInterval>)))(this.decayTimer);
        this.decayTimer = null;
      }
    }
  }

  /** Leaves for good (sign-out, account switch). */
  stop(): void {
    this.setActive(false);
    this.stopped = true;
  }

  private async join(): Promise<void> {
    this.leave();
    const generation = ++this.generation;
    let connection: InboxConnection;
    try {
      connection = await this.deps.open({
        onEvent: (payload) => { if (generation === this.generation) this.receive(payload); },
        onStatus: (status) => { if (generation === this.generation) this.onStatus(status); },
      });
    } catch (err) {
      if (generation !== this.generation) return;
      this.deps.log?.(`join failed: ${err instanceof Error ? err.message : String(err)}`);
      this.retryLater();
      return;
    }
    // Left (or rejoined) while connecting: don't keep this one.
    if (generation !== this.generation || !this.active) { connection.close(); return; }
    this.connection = connection;
  }

  private leave(): void {
    this.generation++;
    this.joined = false;
    // Updates held for a snapshot that will no longer be applied are dropped
    // with it; the next join takes a fresh snapshot.
    this.snapshotting = false;
    this.held = [];
    if (this.retryTimer != null) {
      (this.deps.clearTimeout ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>)))(this.retryTimer);
      this.retryTimer = null;
    }
    this.connection?.close();
    this.connection = null;
  }

  private onStatus(status: InboxStatus): void {
    if (status === 'subscribed') {
      this.joined = true;
      this.retries = 0;
      this.deps.log?.('joined');
      void this.catchUp();
      return;
    }
    this.deps.log?.(`connection ${status}`);
    this.retryLater();
  }

  private retryLater(): void {
    if (!this.active || this.stopped) return;
    this.leave();
    const wait = FEED_RETRY_MS[Math.min(this.retries, FEED_RETRY_MS.length - 1)]!;
    this.retries++;
    const later = this.deps.setTimeout ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
    this.retryTimer = later(() => {
      this.retryTimer = null;
      if (this.active && !this.stopped) void this.join();
    }, wait);
  }

  /** A snapshot right after joining, with updates held until it lands. */
  private async catchUp(): Promise<void> {
    const generation = this.generation;
    const isCurrent = () => generation === this.generation && this.active && !this.stopped;
    this.snapshotting = true;
    try {
      await this.deps.snapshot(isCurrent);
    } catch {
      // Keep the friend list as it was; updates still apply.
    } finally {
      // Left (or rejoined) meanwhile: that attempt owns the state now.
      if (!isCurrent()) return;
      this.snapshotting = false;
      const held = this.held;
      this.held = [];
      for (const e of held) this.deps.apply(e);
    }
  }

  private receive(payload: unknown): void {
    const event = parsePresenceEvent(payload) ?? parseLiveLocationEvent(payload);
    if (!event) return;
    if (this.snapshotting) this.held.push(event);
    else this.deps.apply(event);
  }
}
