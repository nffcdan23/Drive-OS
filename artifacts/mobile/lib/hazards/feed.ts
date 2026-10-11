// Keeps the hazard store current around the driver while the app is on
// screen, with as little traffic as possible:
//
//  - one snapshot of the area around the driver (POST /hazards/in-view, about
//    15 km each way), loaded again only after moving 4 km from where it was
//    loaded, every 5 minutes, or after a Realtime reconnect; never per GPS
//    fix, and never more often than every 20 s;
//  - live updates from the Realtime area topics that area touches (at most
//    a handful of 0.5° cells, migration 0020), joined before the snapshot
//    loads; updates that arrive meanwhile are applied after it;
//  - off screen: the topics are left and nothing loads. Back on screen it
//    loads again at once.
//
// Never critical: if the server or Realtime can't be reached, the map simply
// shows what it had (each hazard still disappears at its expiry) and tries
// again later with backoff.
//
// No React Native imports (loading and Realtime are passed in), so it is
// unit-tested under node.

import { areaAround, distanceM, hazardTopicsFor, parseHazardEvent, type Area, type HazardEvent, type RoadHazard } from './model';
import type { HazardStore } from './store';

export const HAZARD_FEED = {
  /** The area loaded around the driver, each way */
  radiusKm: 15,
  /** Load again after moving this far from where the area was loaded */
  refreshMovedM: 4_000,
  /** And at least this often on screen (Realtime fills the gaps between) */
  refreshEveryMs: 5 * 60_000,
  /** Never load more often than this */
  minGapMs: 20_000,
  /** After a failure, wait this long before trying again */
  retryMs: [5_000, 15_000, 60_000] as readonly number[],
  /** Drop expired hazards this often */
  pruneEveryMs: 30_000,
} as const;

export type HazardChannelStatus = 'subscribed' | 'error' | 'closed';

export interface HazardFeedDeps {
  store: HazardStore;
  /** POST /hazards/in-view */
  load(area: Area): Promise<RoadHazard[]>;
  /** Joins these area topics (receive only); events and status come back through the handlers */
  openTopics(topics: string[], handlers: { onEvent: (payload: unknown) => void; onStatus: (status: HazardChannelStatus) => void }): Promise<{ close(): void }>;
  now?: () => number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
  /** Development diagnostics: never positions */
  log?: (message: string) => void;
}

export class HazardFeed {
  private active = false;
  private stopped = false;
  private position: { lat: number; lng: number } | null = null;
  private loadedAt = 0;
  private loadedCentre: { lat: number; lng: number } | null = null;
  private loading = false;
  private nextAllowedAt = 0;
  private failures = 0;
  private held: HazardEvent[] = [];
  private topicsKey = '';
  private connection: { close(): void } | null = null;
  /** Bumped whenever the topics are left; late callbacks from older joins are ignored */
  private generation = 0;
  /** Bumped when the app leaves the screen; a load started before is ignored */
  private epoch = 0;
  private rejoinTimer: unknown = null;
  private rejoinFailures = 0;
  private pruneTimer: unknown = null;
  private wasSubscribed = false;

  private readonly now: () => number;
  private readonly setT: (fn: () => void, ms: number) => unknown;
  private readonly clearT: (h: unknown) => void;
  private readonly setI: (fn: () => void, ms: number) => unknown;
  private readonly clearI: (h: unknown) => void;

  constructor(private readonly deps: HazardFeedDeps) {
    this.now = deps.now ?? Date.now;
    this.setT = deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearT = deps.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.setI = deps.setInterval ?? ((fn, ms) => setInterval(fn, ms));
    this.clearI = deps.clearInterval ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));
  }

  /** On screen (true) or not */
  setActive(active: boolean) {
    if (this.stopped || active === this.active) return;
    this.active = active;
    if (active) {
      this.pruneTimer = this.setI(() => this.deps.store.prune(this.now()), HAZARD_FEED.pruneEveryMs);
      this.deps.store.prune(this.now());
      // Back on screen: load at once (anything may have changed meanwhile)
      this.loadedAt = 0;
      this.nextAllowedAt = 0;
      this.maybeLoad();
    } else {
      if (this.pruneTimer != null) this.clearI(this.pruneTimer);
      this.pruneTimer = null;
      this.epoch++;
      this.leaveTopics();
    }
  }

  /** The driver's latest accepted position. Cheap: it loads only when needed. */
  notePosition(lat: number, lng: number) {
    if (this.stopped || !Number.isFinite(lat) || !Number.isFinite(lng)) return;
    this.position = { lat, lng };
    this.maybeLoad();
  }

  /** Load again as soon as allowed (e.g. after the driver's own report) */
  refreshSoon() {
    this.loadedAt = 0;
    this.maybeLoad();
  }

  stop() {
    if (this.stopped) return;
    this.setActive(false);
    this.stopped = true;
    this.deps.store.clear();
  }

  private due(): boolean {
    if (!this.position) return false;
    if (!this.loadedCentre || this.now() - this.loadedAt >= HAZARD_FEED.refreshEveryMs) return true;
    return distanceM(this.loadedCentre.lat, this.loadedCentre.lng, this.position.lat, this.position.lng) >= HAZARD_FEED.refreshMovedM;
  }

  private maybeLoad() {
    if (!this.active || this.stopped || this.loading || !this.position) return;
    if (this.now() < this.nextAllowedAt || !this.due()) return;
    void this.load(this.position);
  }

  private async load(at: { lat: number; lng: number }) {
    this.loading = true;
    this.nextAllowedAt = this.now() + HAZARD_FEED.minGapMs;
    const area = areaAround(at.lat, at.lng, HAZARD_FEED.radiusKm);
    const epoch = this.epoch;
    this.joinTopics(hazardTopicsFor(area));
    try {
      const hazards = await this.deps.load(area);
      if (this.stopped || !this.active || epoch !== this.epoch) return;
      const now = this.now();
      this.deps.store.replace(area, hazards, now);
      for (const e of this.held.splice(0)) this.deps.store.apply(e, now);
      this.loadedAt = now;
      this.loadedCentre = at;
      this.failures = 0;
      this.deps.log?.(`loaded ${hazards.length}`);
    } catch {
      const wait = HAZARD_FEED.retryMs[Math.min(this.failures, HAZARD_FEED.retryMs.length - 1)]!;
      this.failures++;
      this.nextAllowedAt = this.now() + wait;
      this.deps.log?.(`load failed, again in ${wait / 1000}s`);
    } finally {
      this.loading = false;
      this.held = [];
    }
  }

  private onEvent(payload: unknown, generation: number) {
    if (generation !== this.generation || this.stopped) return;
    const e = parseHazardEvent(payload, this.now());
    if (!e) return;
    if (this.loading) this.held.push(e);
    else this.deps.store.apply(e, this.now());
  }

  private joinTopics(topics: string[]) {
    const key = topics.join(',');
    if (key === this.topicsKey && this.connection) return;
    this.leaveTopics();
    this.topicsKey = key;
    this.open(topics);
  }

  private open(topics: string[]) {
    const generation = this.generation;
    this.deps
      .openTopics(topics, {
        onEvent: (payload) => this.onEvent(payload, generation),
        onStatus: (status) => this.onStatus(status, generation, topics),
      })
      .then((connection) => {
        if (generation !== this.generation || this.stopped || !this.active) connection.close();
        else this.connection = connection;
      })
      .catch(() => this.scheduleRejoin(generation, topics));
  }

  private onStatus(status: HazardChannelStatus, generation: number, topics: string[]) {
    if (generation !== this.generation) return;
    if (status === 'subscribed') {
      this.rejoinFailures = 0;
      // A reconnect may have missed updates: load again (the first join needs no second load)
      if (this.wasSubscribed) this.refreshSoon();
      this.wasSubscribed = true;
      return;
    }
    this.scheduleRejoin(generation, topics);
  }

  private scheduleRejoin(generation: number, topics: string[]) {
    if (generation !== this.generation || this.stopped || !this.active || this.rejoinTimer != null) return;
    const wait = HAZARD_FEED.retryMs[Math.min(this.rejoinFailures, HAZARD_FEED.retryMs.length - 1)]!;
    this.rejoinFailures++;
    this.connection?.close();
    this.connection = null;
    this.rejoinTimer = this.setT(() => {
      this.rejoinTimer = null;
      if (generation !== this.generation || !this.active || this.stopped) return;
      this.generation++;
      this.open(topics);
    }, wait);
  }

  private leaveTopics() {
    this.generation++;
    if (this.rejoinTimer != null) this.clearT(this.rejoinTimer);
    this.rejoinTimer = null;
    this.connection?.close();
    this.connection = null;
    this.topicsKey = '';
    this.wasSubscribed = false;
    this.held = [];
  }
}
