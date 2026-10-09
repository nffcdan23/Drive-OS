// Destination search (Navigation Phase 2B): Mapbox Search Box, called from
// the phone with the app's public Mapbox token (as Mapbox's own Search SDKs
// do), behind a provider-neutral result model the screens use.
//
// Search Box works in sessions: /suggest as the user types, then /retrieve
// for the one they pick, all under one session token, billed once. Here:
//  - one token per search session: made on the first suggestion request,
//    reused for every request after it, and dropped once a result is
//    retrieved, the search is closed, 50 suggestion requests have been made,
//    or it has been idle for two minutes (Mapbox ends a session then anyway);
//  - typing is debounced; under three characters nothing is sent; a query
//    already answered (or being answered) is never sent again; a newer query
//    cancels the request still in flight; nothing retries on its own.
//
// Search Box results are for temporary use only (Mapbox's terms): they are
// shown, and the one chosen is routed to, but they are never stored. Only
// the fields the app needs are kept, in memory, for the session.
//
// No React Native imports, so it is unit-tested under node.

import type { Destination, LatLng } from './model';
import { parseCoordinates } from './coordinates';

export const SEARCH = {
  origin: 'https://api.mapbox.com',
  suggestPath: '/search/searchbox/v1/suggest',
  retrievePath: '/search/searchbox/v1/retrieve/',
  /** Wait this long after the last keystroke before asking (ms) */
  debounceMs: 300,
  /** Shorter queries are never sent ("Ely" is a town) */
  minQueryLength: 3,
  limit: 8,
  /** UK results (Northern Ireland included); nearer ones rank first via proximity */
  country: 'GB',
  /** Search Box takes an ISO 639-1 language code; with country GB this gives UK English names */
  language: 'en',
  /** A session is ended by Mapbox after 50 suggestions without a retrieve... */
  maxSuggestPerSession: 50,
  /** ...or a short idle time; a new token is used well before either */
  sessionIdleMs: 120_000,
  timeoutMs: 8_000,
} as const;

export type SearchResultKind = 'poi' | 'address' | 'street' | 'postcode' | 'place' | 'region' | 'other';

/** One search result, whatever it came from */
export interface SearchResult {
  /** Stable within a session: `search:<provider ref>` */
  id: string;
  name: string;
  /** Address, or town and county */
  subtitle: string | null;
  kind: SearchResultKind;
  /** e.g. "Petrol station" (POIs only) */
  category: string | null;
  /** Distance from the phone, when the provider gives it (m) */
  distanceM: number | null;
  source: 'search';
  /** What retrieve needs (the provider's id for the result); session use only */
  providerRef: string;
}

export type RemoteStatus = 'idle' | 'loading' | 'ready' | 'offline' | 'error' | 'unavailable';

export interface SearchState {
  query: string;
  /** Coordinates typed into the box (no request is made for them) */
  coordinates: LatLng | null;
  status: RemoteStatus;
  results: SearchResult[];
  /** What to tell the user when status is offline, error or unavailable */
  message: string | null;
}

export class SearchError extends Error {
  constructor(readonly kind: 'offline' | 'busy' | 'unavailable' | 'failed' | 'not_found', message: string) {
    super(message);
  }
}

// ─── Normalising provider answers ───────────────────────────────────────────

const KINDS: Record<string, SearchResultKind> = {
  poi: 'poi', address: 'address', street: 'street', postcode: 'postcode',
  place: 'place', city: 'place', locality: 'place', neighborhood: 'place', district: 'region', region: 'region',
};
// Suggestions that are searches in themselves ("Petrol stations"), not places
const NOT_A_PLACE = new Set(['category', 'brand', 'country']);

const text = (v: unknown, max = 200): string | null => {
  if (typeof v !== 'string') return null;
  const t = v.replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, max) : null;
};

const title = (s: string) => s.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

/** One /suggest answer as search results: only what the app shows, nothing else kept */
export function resultsFromSuggest(body: unknown): SearchResult[] {
  const list = (body as { suggestions?: unknown })?.suggestions;
  if (!Array.isArray(list)) return [];
  const out: SearchResult[] = [];
  for (const raw of list) {
    const s = raw as Record<string, unknown>;
    const ref = text(s.mapbox_id, 512);
    const name = text(s.name);
    const type = typeof s.feature_type === 'string' ? s.feature_type : '';
    if (!ref || !name || NOT_A_PLACE.has(type)) continue;
    const full = text(s.full_address) ?? text(s.place_formatted) ?? text(s.address);
    const category = Array.isArray(s.poi_category) ? text(s.poi_category[0], 60) : null;
    out.push({
      id: `search:${ref}`,
      name,
      subtitle: full && full !== name ? full : text(s.place_formatted),
      kind: KINDS[type] ?? 'other',
      category: category ? title(category) : null,
      distanceM: typeof s.distance === 'number' && Number.isFinite(s.distance) ? s.distance : null,
      source: 'search',
      providerRef: ref,
    });
  }
  return out;
}

const validPoint = (lat: unknown, lng: unknown): LatLng | null =>
  typeof lat === 'number' && typeof lng === 'number' && Number.isFinite(lat) && Number.isFinite(lng)
  && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { latitude: lat, longitude: lng } : null;

/**
 * The /retrieve answer for `result` as a destination. Driving to a place
 * means driving to where a car can reach it (its routable point, e.g. the
 * car park entrance) when Mapbox gives one.
 */
export function destinationFromRetrieve(body: unknown, result: SearchResult): Destination {
  const features = (body as { features?: unknown })?.features;
  const f = Array.isArray(features) ? (features[0] as Record<string, unknown> | undefined) : undefined;
  const props = (f?.properties ?? {}) as Record<string, unknown>;
  const coords = (props.coordinates ?? {}) as Record<string, unknown>;
  const routable = Array.isArray(coords.routable_points) ? (coords.routable_points[0] as Record<string, unknown> | undefined) : undefined;
  const geometry = (f?.geometry as { coordinates?: unknown } | undefined)?.coordinates;
  const point =
    validPoint(routable?.latitude, routable?.longitude)
    ?? validPoint(coords.latitude, coords.longitude)
    ?? (Array.isArray(geometry) ? validPoint(geometry[1], geometry[0]) : null);
  if (!point) throw new SearchError('not_found', "Couldn't find where that place is. Try another result.");
  const name = text(props.name) ?? result.name;
  const full = text(props.full_address) ?? text(props.place_formatted) ?? result.subtitle;
  return {
    id: result.id,
    name,
    subtitle: full && full !== name ? full : result.subtitle,
    coordinate: point,
    source: 'search',
  };
}

// ─── Requests ───────────────────────────────────────────────────────────────

export function suggestUrl(q: string, opts: { token: string; session: string; proximity: LatLng | null }): string {
  const p = new URLSearchParams({
    q: q.slice(0, 256),
    access_token: opts.token,
    session_token: opts.session,
    language: SEARCH.language,
    country: SEARCH.country,
    limit: String(SEARCH.limit),
  });
  if (opts.proximity) p.set('proximity', `${opts.proximity.longitude.toFixed(4)},${opts.proximity.latitude.toFixed(4)}`);
  return `${SEARCH.origin}${SEARCH.suggestPath}?${p.toString()}`;
}

export function retrieveUrl(ref: string, opts: { token: string; session: string }): string {
  const p = new URLSearchParams({ access_token: opts.token, session_token: opts.session, language: SEARCH.language });
  return `${SEARCH.origin}${SEARCH.retrievePath}${encodeURIComponent(ref)}?${p.toString()}`;
}

/** The session token Search Box bills by */
export class SearchSession {
  private token: string | null = null;
  private suggests = 0;
  private lastUsed = 0;
  /** Sessions started (for tests and diagnostics) */
  started = 0;

  constructor(private readonly newToken: () => string, private readonly now: () => number) {}

  /** The token for the next request: the current one, or a new one if it has run its course */
  use(kind: 'suggest' | 'retrieve'): string {
    const now = this.now();
    if (
      !this.token
      || now - this.lastUsed > SEARCH.sessionIdleMs
      || (kind === 'suggest' && this.suggests >= SEARCH.maxSuggestPerSession)
    ) {
      this.token = this.newToken();
      this.suggests = 0;
      this.started++;
    }
    if (kind === 'suggest') this.suggests++;
    this.lastUsed = now;
    return this.token;
  }

  /** The session is over (a result was retrieved, or the search was closed) */
  end(): void {
    this.token = null;
    this.suggests = 0;
  }

  get active(): string | null {
    return this.token;
  }
}

export interface SearchDeps {
  /** The app's public Mapbox token; null: remote search unavailable */
  token: string | null;
  fetch: (url: string, init: { signal: AbortSignal; method: 'GET'; redirect: 'error' }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
  newSessionToken: () => string;
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (t: unknown) => void;
}

const idle = (query = '', coordinates: LatLng | null = null): SearchState =>
  ({ query, coordinates, status: 'idle', results: [], message: null });

function describe(err: unknown): SearchError {
  if (err instanceof SearchError) return err;
  // fetch rejects with a TypeError when there's no connection
  return new SearchError('offline', "You're offline. Saved places and coordinates still work.");
}

function errorForStatus(status: number): SearchError {
  if (status === 401 || status === 403) return new SearchError('unavailable', "Place search isn't available right now.");
  if (status === 429) return new SearchError('busy', 'Search is busy. Try again in a moment.');
  return new SearchError('failed', "Couldn't search just now. Try again.");
}

/**
 * The search box's remote half: what the user typed in, what Mapbox
 * suggested for it, and the one request (if any) in flight. Screens render
 * local matches themselves and read this store for the rest.
 */
export class DestinationSearch {
  private current: SearchState = idle();
  private listeners = new Set<() => void>();
  private timer: unknown = null;
  private inFlight: { key: string; abort: AbortController } | null = null;
  private answered: { key: string; results: SearchResult[] } | null = null;
  private proximity: LatLng | null = null;
  readonly session: SearchSession;
  /** Requests made (for tests and diagnostics) */
  requests = { suggest: 0, retrieve: 0 };

  constructor(private readonly deps: SearchDeps) {
    this.session = new SearchSession(deps.newSessionToken, deps.now);
  }

  get state(): SearchState {
    return this.current;
  }

  get available(): boolean {
    return !!this.deps.token;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private set(next: SearchState) {
    this.current = next;
    for (const fn of [...this.listeners]) fn();
  }

  /** Where results should be near (the phone's position, when known) */
  setProximity(p: LatLng | null): void {
    this.proximity = p;
  }

  /** What's in the search box now */
  setQuery(query: string): void {
    this.cancelTimer();
    const q = query.trim();
    const coordinates = parseCoordinates(q);
    // Coordinates and short queries never reach Mapbox
    if (coordinates || q.length < SEARCH.minQueryLength) {
      this.abortInFlight();
      this.set(idle(query, coordinates));
      return;
    }
    if (!this.available) {
      this.set({ ...idle(query), status: 'unavailable', message: "Place search isn't set up in this build." });
      return;
    }
    const key = this.keyFor(q);
    if (this.answered?.key === key) {
      this.set({ query, coordinates: null, status: 'ready', results: this.answered.results, message: null });
      return;
    }
    // Shown as searching straight away (results so far stay until replaced)
    this.set({ ...this.current, query, coordinates: null, status: 'loading', message: null });
    if (this.inFlight?.key === key) return;
    this.timer = this.deps.setTimer(() => {
      this.timer = null;
      void this.suggest(q, key);
    }, SEARCH.debounceMs);
  }

  /** Try the current query again (the user tapped Retry) */
  retry(): void {
    this.answered = null;
    this.abortInFlight();
    this.setQuery(this.current.query);
  }

  /**
   * The user picked `result`: where it is, as a destination. Ends the
   * session (the next search starts a new one).
   */
  async select(result: SearchResult): Promise<Destination> {
    if (!this.deps.token) throw new SearchError('unavailable', "Place search isn't available right now.");
    this.cancelTimer();
    this.abortInFlight();
    const session = this.session.use('retrieve');
    const abort = new AbortController();
    const timeout = this.deps.setTimer(() => abort.abort(), SEARCH.timeoutMs);
    try {
      this.requests.retrieve++;
      const res = await this.deps.fetch(retrieveUrl(result.providerRef, { token: this.deps.token, session }), {
        signal: abort.signal, method: 'GET', redirect: 'error',
      });
      if (!res.ok) throw res.status === 404 ? new SearchError('not_found', "That place couldn't be found any more.") : errorForStatus(res.status);
      return destinationFromRetrieve(await res.json(), result);
    } catch (err) {
      throw describe(err);
    } finally {
      this.deps.clearTimer(timeout);
      // Retrieve ends the session, whatever came back
      this.endSession();
    }
  }

  /** The search was closed: no more requests, nothing kept */
  close(): void {
    this.cancelTimer();
    this.abortInFlight();
    this.endSession();
    this.set(idle());
  }

  private endSession() {
    this.session.end();
    this.answered = null;
  }

  private keyFor(q: string): string {
    const p = this.proximity;
    // ~1 km buckets: moving a few metres doesn't make a query new
    return `${q.toLowerCase().replace(/\s+/g, ' ')}|${p ? `${p.latitude.toFixed(2)},${p.longitude.toFixed(2)}` : '-'}`;
  }

  private cancelTimer() {
    if (this.timer != null) this.deps.clearTimer(this.timer);
    this.timer = null;
  }

  private abortInFlight() {
    this.inFlight?.abort.abort();
    this.inFlight = null;
  }

  private async suggest(q: string, key: string) {
    const token = this.deps.token;
    if (!token) return;
    // A newer query replaces the one still being answered
    this.abortInFlight();
    const abort = new AbortController();
    const mine = { key, abort };
    this.inFlight = mine;
    const timeout = this.deps.setTimer(() => abort.abort(), SEARCH.timeoutMs);
    const session = this.session.use('suggest');
    try {
      this.requests.suggest++;
      const res = await this.deps.fetch(suggestUrl(q, { token, session, proximity: this.proximity }), {
        signal: abort.signal, method: 'GET', redirect: 'error',
      });
      if (!res.ok) throw errorForStatus(res.status);
      const results = resultsFromSuggest(await res.json());
      if (this.inFlight !== mine) return;
      this.answered = { key, results };
      this.set({ ...this.current, status: 'ready', results, message: null });
    } catch (err) {
      // Cancelled for a newer query (or the search closed): say nothing
      if (this.inFlight !== mine) return;
      if (abort.signal.aborted && !(err instanceof SearchError)) {
        this.set({ ...this.current, status: 'error', results: [], message: 'Search took too long. Try again.' });
        return;
      }
      const e = describe(err);
      this.set({
        ...this.current,
        status: e.kind === 'offline' ? 'offline' : e.kind === 'unavailable' ? 'unavailable' : 'error',
        results: [],
        message: e.message,
      });
    } finally {
      this.deps.clearTimer(timeout);
      if (this.inFlight === mine) this.inFlight = null;
    }
  }
}
