// The route preview's state (Navigation Phase 2A), outside React.
//
//   idle ──open──▶ routing ──▶ preview ──cancel──▶ idle
//                     │            │ update (keeps the routes on screen)
//                     ▼            ▼
//               previewFailed ──retry──▶ routing
//
// Routes are fetched only when the user asks: opening a preview, Update
// Route or Retry. Mapbox's terms allow requests only in response to the
// user, so nothing here fetches on its own: after 10 minutes, or once the
// phone has moved 300 m from where the route starts, the preview is only
// marked out of date and the user chooses to update it. Every request has an
// id; a response to anything but the newest request is dropped, so a slow
// answer can never replace a newer one or reopen a cancelled preview.
//
// Routes live here, in memory, and nowhere else: nothing is written to the
// device, a journey or the server.
//
// No React Native imports, so it is unit-tested under node.

import { distanceM } from '../backend/geo';
import type { ServerRoutes } from '../backend/endpoints';
import {
  routeRequestBody, routesFromServer, type Destination, type LatLng, type NavRoute, type RouteOrigin,
} from './model';

export const PREVIEW = {
  /** A preview older than this is marked out of date (ms) */
  staleAfterMs: 10 * 60_000,
  /** ...as is one whose start the phone has moved this far from (m) */
  staleMovedM: 300,
} as const;

export interface PreviewError { code: string; message: string }

export type StaleReason = 'age' | 'moved';

export type PreviewState =
  | { phase: 'idle' }
  | { phase: 'routing'; destination: Destination; origin: RouteOrigin; requestId: number }
  | {
      phase: 'preview';
      destination: Destination;
      origin: RouteOrigin;
      requestId: number;
      routes: NavRoute[];
      selectedIndex: number;
      fetchedAt: number;
      /** Why the routes may be out of date (null: current) */
      stale: StaleReason | null;
      /** An Update Route request is in flight; the routes stay on screen */
      refreshing: boolean;
      /** The last Update Route failed; the routes shown are the earlier ones */
      updateError: PreviewError | null;
    }
  | { phase: 'previewFailed'; destination: Destination; origin: RouteOrigin; requestId: number; error: PreviewError };

export type PreviewPhase = PreviewState['phase'];

export interface PreviewStoreDeps {
  fetchRoutes(body: ReturnType<typeof routeRequestBody>): Promise<ServerRoutes>;
  /** What to tell the user about a failed request */
  describe(err: unknown): PreviewError;
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(timer: unknown): void;
}

const IDLE: PreviewState = { phase: 'idle' };

export class RoutePreviewStore {
  private current: PreviewState = IDLE;
  private listeners = new Set<() => void>();
  private nextRequestId = 0;
  private ageTimer: unknown = null;
  /** Requests made (for tests and diagnostics) */
  requests = 0;

  constructor(private readonly deps: PreviewStoreDeps) {}

  get state(): PreviewState {
    return this.current;
  }

  get phase(): PreviewPhase {
    return this.current.phase;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private set(next: PreviewState) {
    if (next === this.current) return;
    this.current = next;
    for (const fn of [...this.listeners]) fn();
  }

  /** The user chose a destination: fetch routes to it from `origin` */
  open(destination: Destination, origin: RouteOrigin): Promise<void> {
    const requestId = ++this.nextRequestId;
    this.stopAgeTimer();
    this.set({ phase: 'routing', destination, origin, requestId });
    return this.fetch(requestId, destination, origin);
  }

  /**
   * The user asked for fresh routes (Update Route, or Retry after a failure),
   * from where the phone is now. The routes already shown stay until the new
   * ones arrive.
   */
  update(origin: RouteOrigin): Promise<void> {
    const s = this.current;
    if (s.phase === 'preview') {
      const requestId = ++this.nextRequestId;
      this.set({ ...s, requestId, refreshing: true, updateError: null });
      return this.fetch(requestId, s.destination, origin);
    }
    if (s.phase === 'previewFailed') return this.open(s.destination, origin);
    return Promise.resolve();
  }

  /** The user picked one of the routes */
  select(index: number): void {
    const s = this.current;
    if (s.phase !== 'preview' || index === s.selectedIndex) return;
    if (!s.routes.some((r) => r.index === index)) return;
    this.set({ ...s, selectedIndex: index });
  }

  /** Closes the preview; any request in flight is ignored when it answers */
  cancel(): void {
    this.nextRequestId++;
    this.stopAgeTimer();
    this.set(IDLE);
  }

  /**
   * The phone's position. Only ever marks the preview out of date (once it's
   * PREVIEW.staleMovedM from where the route starts); never fetches.
   */
  noteFix(position: LatLng, now: number = this.deps.now()): void {
    const s = this.current;
    if (s.phase !== 'preview' || s.stale) return;
    if (now - s.fetchedAt >= PREVIEW.staleAfterMs) {
      this.set({ ...s, stale: 'age' });
    } else if (distanceM(s.origin.coordinate, position) >= PREVIEW.staleMovedM) {
      this.set({ ...s, stale: 'moved' });
    }
  }

  /** The selected route, when previewing */
  get selected(): NavRoute | null {
    const s = this.current;
    return s.phase === 'preview' ? s.routes.find((r) => r.index === s.selectedIndex) ?? s.routes[0] ?? null : null;
  }

  private async fetch(requestId: number, destination: Destination, origin: RouteOrigin): Promise<void> {
    this.requests++;
    let routes: NavRoute[] | null = null;
    let error: PreviewError | null = null;
    try {
      routes = routesFromServer(await this.deps.fetchRoutes(routeRequestBody(origin, destination)), `r${requestId}`);
      if (!routes.length) error = { code: 'route_not_found', message: 'No driving route was found to that place.' };
    } catch (err) {
      error = this.deps.describe(err);
    }
    // Cancelled, or a newer request has been made: this answer is stale
    if (requestId !== this.nextRequestId) return;
    const s = this.current;
    if (s.phase === 'idle') return;

    if (error || !routes) {
      const e = error ?? { code: 'unknown', message: 'Something went wrong.' };
      // An update that failed keeps the routes already on screen
      if (s.phase === 'preview') this.set({ ...s, refreshing: false, updateError: e });
      else this.set({ phase: 'previewFailed', destination, origin, requestId, error: e });
      return;
    }
    const fetchedAt = this.deps.now();
    this.set({
      phase: 'preview', destination, origin, requestId, routes,
      selectedIndex: routes[0]!.index, fetchedAt, stale: null, refreshing: false, updateError: null,
    });
    this.startAgeTimer();
  }

  // Marks the preview out of date at PREVIEW.staleAfterMs even with no fixes
  // arriving (a timer, not a request)
  private startAgeTimer() {
    this.stopAgeTimer();
    this.ageTimer = this.deps.setTimer(() => {
      this.ageTimer = null;
      const s = this.current;
      if (s.phase === 'preview' && !s.stale) this.set({ ...s, stale: 'age' });
    }, PREVIEW.staleAfterMs);
  }

  private stopAgeTimer() {
    if (this.ageTimer != null) this.deps.clearTimer(this.ageTimer);
    this.ageTimer = null;
  }
}
