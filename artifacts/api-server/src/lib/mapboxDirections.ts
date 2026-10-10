/**
 * Mapbox Directions client for route previews (Navigation Phase 2A).
 *
 * The token (MAPBOX_DIRECTIONS_TOKEN) stays on this server: it is sent only
 * to Mapbox's own API host and never appears in a response or a log. Neither
 * do coordinates: logs carry status codes and error kinds only.
 *
 * Mapbox's terms don't allow Directions results to be cached or stored, so
 * nothing here keeps a response: each call is answered and forgotten (no
 * cache, no database). Every outcome becomes one of our stable error codes,
 * and the app only ever sees Derwent's own route format, never Mapbox's
 * response.
 *
 * Deliberately self-contained (no imports from the rest of the API) so it can
 * be unit-tested directly.
 */

// ─── Configuration ──────────────────────────────────────────────────────────

/** The only host the token may ever be sent to */
export const MAPBOX_API_ORIGIN = "https://api.mapbox.com";
export const DIRECTIONS_PATH = "/directions/v5/mapbox/driving-traffic/";
/** Requests time out after this long (ms) */
export const DIRECTIONS_TIMEOUT_MS = 8_000;
/** Largest Mapbox response accepted (three long routes with steps stay well under it) */
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/**
 * UK-first: instructions in British English, voice distances in yards and
 * miles. Fixed here so every route Derwent requests is consistent.
 */
export const DIRECTIONS_PARAMS = {
  alternatives: "true",
  steps: "true",
  banner_instructions: "true",
  voice_instructions: "true",
  voice_units: "british_imperial",
  language: "en-GB",
  geometries: "polyline6",
  overview: "full",
  annotations: "duration,distance,congestion,maxspeed",
} as const;

export interface DirectionsConfig {
  token: string | null;
  /** Always MAPBOX_API_ORIGIN, except a loopback stub in the test suite */
  origin: string;
}

export class DirectionsConfigError extends Error {}

/**
 * Reads MAPBOX_DIRECTIONS_TOKEN: a server-only Mapbox token (a dedicated
 * token, not the app's public one). Unset: route previews answer
 * navigation_unavailable. Malformed: the server stops at startup.
 *
 * MAPBOX_DIRECTIONS_URL exists only for the integration tests: a plain-HTTP
 * loopback stub, accepted only when NODE_ENV is "test". Anything else stops
 * the server, so the token can only ever be sent to Mapbox.
 */
export function readDirectionsConfig(env: Record<string, string | undefined>): DirectionsConfig {
  const token = env.MAPBOX_DIRECTIONS_TOKEN?.trim() || null;
  if (token && !/^(pk|sk)\.[A-Za-z0-9._-]{20,4096}$/.test(token)) {
    throw new DirectionsConfigError(
      "MAPBOX_DIRECTIONS_TOKEN has an unexpected format (a Mapbox token starts with pk. or sk.; check for stray spaces or line breaks).",
    );
  }
  const raw = env.MAPBOX_DIRECTIONS_URL?.trim();
  let origin = MAPBOX_API_ORIGIN;
  if (raw) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new DirectionsConfigError("MAPBOX_DIRECTIONS_URL is not a valid URL.");
    }
    const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
    if (env.NODE_ENV !== "test" || url.protocol !== "http:" || !loopback || url.pathname !== "/" || url.search || url.username) {
      throw new DirectionsConfigError("MAPBOX_DIRECTIONS_URL is only for the test suite; leave it unset.");
    }
    origin = url.origin;
  }
  return { token, origin };
}

// ─── Requests, results and errors ───────────────────────────────────────────

export interface LatLng { lat: number; lng: number }

export interface RouteRequest {
  /**
   * speedMs and accuracyM come with a reroute while driving (the app sends
   * them only then): see rerouteParams.
   */
  origin: LatLng & { headingDeg?: number | null; speedMs?: number | null; accuracyM?: number | null };
  destination: LatLng;
}

/**
 * A route from a moving car (a reroute) starts where the car can safely go:
 *
 *  - avoid_maneuver_radius: no manoeuvre within the distance the car covers
 *    in about 8 s at its speed (50 to 300 m), so the new route doesn't begin
 *    with a turn the car is already past or a U-turn. Directions decides
 *    the route (and returns one anyway if it can't avoid a manoeuvre there);
 *    nothing is built by hand.
 *  - radiuses: the start may snap to a road within the fix's uncertainty
 *    (3 × its accuracy, 50 to 200 m), so a poor fix doesn't start the route
 *    on the wrong road far away; the destination's is unlimited.
 *
 * Previews (no speed or accuracy) are requested exactly as before.
 */
export const REROUTE_PARAMS = {
  maneuverMinSpeedMs: 4,
  maneuverSeconds: 8,
  maneuverRadiusM: { min: 50, max: 300 },
  radiusAccuracyFactor: 3,
  radiusM: { min: 50, max: 200 },
} as const;

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/** The extra Directions parameters for a route from a moving car (empty for a preview) */
export function rerouteParams(origin: RouteRequest["origin"]): Record<string, string> {
  const out: Record<string, string> = {};
  const r = REROUTE_PARAMS;
  const v = origin.speedMs;
  if (v != null && Number.isFinite(v) && v >= r.maneuverMinSpeedMs) {
    out.avoid_maneuver_radius = String(Math.round(clamp(v * r.maneuverSeconds, r.maneuverRadiusM.min, r.maneuverRadiusM.max)));
  }
  const a = origin.accuracyM;
  if (a != null && Number.isFinite(a) && a >= 0) {
    out.radiuses = `${Math.round(clamp(a * r.radiusAccuracyFactor, r.radiusM.min, r.radiusM.max))};unlimited`;
  }
  return out;
}

/** One manoeuvre of a route, in Derwent's provider-neutral format */
export interface RouteStepDto {
  maneuver: {
    type: string;
    modifier: string | null;
    /** Roundabout exit number, when there is one */
    exit: number | null;
    bearingBefore: number | null;
    bearingAfter: number | null;
    location: LatLng;
    instruction: string | null;
  };
  /** Metres from the start of the route to this step */
  startDistanceM: number;
  distanceM: number;
  durationS: number;
  roadName: string | null;
  /** Road number, e.g. "A591" */
  roadRef: string | null;
  /** Signposted destinations, e.g. "Keswick" */
  signposts: string | null;
  /** Junction number(s), e.g. "36" */
  junctionRef: string | null;
  drivingSide: "left" | "right" | null;
  /** Text to show for this manoeuvre (primary / secondary banner) */
  banner: { primary: string; secondary: string | null } | null;
  /** Spoken prompts: text, and how far before the manoeuvre (m) */
  voice: Array<{ distanceBeforeM: number; text: string }>;
}

export interface RouteLegDto {
  distanceM: number;
  durationS: number;
  summary: string;
  steps: RouteStepDto[];
  /** Per segment: 0 unknown, 1 low, 2 moderate, 3 heavy, 4 severe (null if not supplied) */
  congestion: number[] | null;
  /** Per segment speed limit in km/h; null where unknown (null if not supplied) */
  maxspeedKmh: Array<number | null> | null;
}

export interface RouteDto {
  /** 0 is the provider's recommended route; the rest are alternatives */
  index: number;
  /** Route line, encoded as a precision-6 polyline */
  geometry: string;
  distanceM: number;
  durationS: number;
  /** Duration without live traffic, when supplied */
  typicalDurationS: number | null;
  /** Main roads, e.g. "A591, M6" */
  summary: string;
  legs: RouteLegDto[];
}

export interface RoutesResult {
  provider: "mapbox";
  /** Mapbox's response id, kept for a later route refresh (never stored) */
  providerResponseId: string | null;
  routes: RouteDto[];
}

export type RoutingErrorCode =
  | "navigation_unavailable"
  | "route_not_found"
  | "route_no_road"
  | "routing_busy"
  | "routing_unavailable"
  | "routing_timeout"
  | "routing_bad_response";

const ERRORS: Record<RoutingErrorCode, { status: number; message: string }> = {
  navigation_unavailable: { status: 503, message: "Route previews aren't available on this server yet." },
  route_not_found: { status: 404, message: "No driving route was found to that place." },
  route_no_road: { status: 422, message: "Couldn't find a road near the start or the destination." },
  routing_busy: { status: 503, message: "Routing is busy right now. Try again shortly." },
  routing_unavailable: { status: 503, message: "Routing is unavailable right now." },
  routing_timeout: { status: 504, message: "The route took too long to calculate." },
  routing_bad_response: { status: 502, message: "The routing service sent a response we couldn't read." },
};

export class RoutingError extends Error {
  readonly status: number;
  constructor(readonly code: RoutingErrorCode, readonly retryAfterSec?: number) {
    super(ERRORS[code].message);
    this.status = ERRORS[code].status;
  }
}

/** The Mapbox request URL. Exported for tests; never logged. */
export function directionsUrl(req: RouteRequest, token: string, origin: string = MAPBOX_API_ORIGIN): string {
  const c = (p: LatLng) => `${fix6(p.lng)},${fix6(p.lat)}`;
  const params = new URLSearchParams(DIRECTIONS_PARAMS);
  const h = req.origin.headingDeg;
  if (h != null && Number.isFinite(h) && h >= 0 && h < 360) {
    // Leave in the direction the car is pointing (±45°), not with a U-turn
    params.set("bearings", `${Math.round(h)},45;`);
  }
  for (const [k, v] of Object.entries(rerouteParams(req.origin))) params.set(k, v);
  params.set("access_token", token);
  return `${origin}${DIRECTIONS_PATH}${c(req.origin)};${c(req.destination)}.json?${params.toString()}`;
}

const fix6 = (n: number) => (Math.round(n * 1e6) / 1e6).toString();

// ─── Parsing and normalisation ──────────────────────────────────────────────

class BadResponse extends Error {}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown, field: string): number => {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new BadResponse(field);
  return v;
};
const optNum = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const optText = (v: unknown, max = 300): string | null => {
  if (typeof v !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
  return s || null;
};
const location = (v: unknown): LatLng => {
  if (!Array.isArray(v) || v.length < 2) throw new BadResponse("location");
  const [lng, lat] = v;
  if (typeof lat !== "number" || typeof lng !== "number" || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    throw new BadResponse("location");
  }
  return { lat, lng };
};

const CONGESTION: Record<string, number> = { unknown: 0, low: 1, moderate: 2, heavy: 3, severe: 4 };

function parseStep(s: unknown, startDistanceM: number): RouteStepDto {
  if (!isObj(s) || !isObj(s.maneuver)) throw new BadResponse("step");
  const m = s.maneuver;
  const banner = Array.isArray(s.bannerInstructions) && isObj(s.bannerInstructions[0]) ? s.bannerInstructions[0] : null;
  const primary = banner && isObj(banner.primary) ? optText(banner.primary.text) : null;
  const secondary = banner && isObj(banner.secondary) ? optText(banner.secondary.text) : null;
  const voice = Array.isArray(s.voiceInstructions)
    ? s.voiceInstructions.flatMap((v) => {
        if (!isObj(v)) return [];
        const text = optText(v.announcement, 500);
        const d = optNum(v.distanceAlongGeometry);
        return text && d != null && d >= 0 ? [{ distanceBeforeM: d, text }] : [];
      })
    : [];
  const side = s.driving_side === "left" || s.driving_side === "right" ? s.driving_side : null;
  return {
    maneuver: {
      type: optText(m.type, 50) ?? "unknown",
      modifier: optText(m.modifier, 50),
      exit: typeof m.exit === "number" && Number.isInteger(m.exit) && m.exit > 0 ? m.exit : null,
      bearingBefore: optNum(m.bearing_before),
      bearingAfter: optNum(m.bearing_after),
      location: location(m.location),
      instruction: optText(m.instruction),
    },
    startDistanceM,
    distanceM: num(s.distance, "step.distance"),
    durationS: num(s.duration, "step.duration"),
    roadName: optText(s.name),
    roadRef: optText(s.ref, 50),
    signposts: optText(s.destinations),
    junctionRef: optText(s.exits, 50),
    drivingSide: side,
    banner: primary ? { primary, secondary } : null,
    voice,
  };
}

function parseLeg(l: unknown, routeStartM: number): RouteLegDto {
  if (!isObj(l)) throw new BadResponse("leg");
  if (!Array.isArray(l.steps)) throw new BadResponse("leg.steps");
  let at = routeStartM;
  const steps = l.steps.map((s) => {
    const step = parseStep(s, at);
    at += step.distanceM;
    return step;
  });
  const a = isObj(l.annotation) ? l.annotation : null;
  const congestion = a && Array.isArray(a.congestion)
    ? a.congestion.map((c) => (typeof c === "string" ? CONGESTION[c] ?? 0 : 0))
    : null;
  const maxspeedKmh = a && Array.isArray(a.maxspeed)
    ? a.maxspeed.map((m) => {
        if (!isObj(m) || typeof m.speed !== "number" || !Number.isFinite(m.speed)) return null;
        if (m.unit === "mph") return Math.round(m.speed * 1.609344);
        if (m.unit === "km/h") return Math.round(m.speed);
        return null;
      })
    : null;
  return {
    distanceM: num(l.distance, "leg.distance"),
    durationS: num(l.duration, "leg.duration"),
    summary: optText(l.summary) ?? "",
    steps,
    congestion,
    maxspeedKmh,
  };
}

/**
 * Validates a Directions response strictly where it matters (routes, their
 * geometry, distance and duration) and leniently for optional detail, and
 * converts it to Derwent's format. Throws RoutingError for "no route"
 * answers and BadResponse for anything unreadable.
 */
export function parseDirectionsResponse(body: unknown): RoutesResult {
  if (!isObj(body)) throw new BadResponse("body");
  if (body.code === "NoRoute") throw new RoutingError("route_not_found");
  if (body.code === "NoSegment") throw new RoutingError("route_no_road");
  // e.g. the places are too far apart, or across the sea
  if (body.code === "InvalidInput") throw new RoutingError("route_not_found");
  if (body.code !== "Ok") throw new BadResponse("code");
  if (!Array.isArray(body.routes) || !body.routes.length) throw new RoutingError("route_not_found");
  const routes = body.routes.slice(0, 3).map((r, index): RouteDto => {
    if (!isObj(r) || typeof r.geometry !== "string" || !r.geometry || r.geometry.length > 2_000_000) {
      throw new BadResponse("route.geometry");
    }
    if (!Array.isArray(r.legs) || !r.legs.length) throw new BadResponse("route.legs");
    let at = 0;
    const legs = r.legs.map((l) => {
      const leg = parseLeg(l, at);
      at += leg.distanceM;
      return leg;
    });
    const summary = legs.map((l) => l.summary).filter(Boolean).join(", ");
    return {
      index,
      geometry: r.geometry,
      distanceM: num(r.distance, "route.distance"),
      durationS: num(r.duration, "route.duration"),
      typicalDurationS: optNum(r.duration_typical),
      summary,
      legs,
    };
  });
  return { provider: "mapbox", providerResponseId: optText(body.uuid, 200), routes };
}

// ─── Client ─────────────────────────────────────────────────────────────────

export interface DirectionsClientDeps {
  fetch?: typeof fetch;
  now?: () => number;
  /** Receives status codes and error kinds only: never a coordinate, URL or the token */
  log?: { warn: (obj: object, msg: string) => void; error: (obj: object, msg: string) => void };
}

const DEFAULT_BUSY_PAUSE_MS = 30_000;
const TOKEN_REJECTED_PAUSE_MS = 5 * 60_000;

export class DirectionsClient {
  private pausedUntil = 0;
  private pauseCode: "routing_busy" | "routing_unavailable" = "routing_unavailable";
  /** Calls actually made to Mapbox (for tests and diagnostics) */
  upstreamCalls = 0;

  constructor(private readonly cfg: DirectionsConfig, private readonly deps: DirectionsClientDeps = {}) {}

  get configured() { return !!this.cfg.token; }
  private now() { return (this.deps.now ?? Date.now)(); }

  async routes(req: RouteRequest): Promise<RoutesResult> {
    if (!this.cfg.token) throw new RoutingError("navigation_unavailable");
    const remaining = this.pausedUntil - this.now();
    if (remaining > 0) throw new RoutingError(this.pauseCode, Math.ceil(remaining / 1000));

    const doFetch = this.deps.fetch ?? fetch;
    let res: Response;
    this.upstreamCalls++;
    try {
      res = await doFetch(directionsUrl(req, this.cfg.token, this.cfg.origin), {
        method: "GET",
        headers: { Accept: "application/json" },
        // Never follow a redirect: the token must only ever reach Mapbox's API host.
        redirect: "error",
        signal: AbortSignal.timeout(DIRECTIONS_TIMEOUT_MS),
      });
    } catch (err) {
      const timedOut = (err as Error)?.name === "TimeoutError" || (err as Error)?.name === "AbortError";
      this.deps.log?.warn({ kind: timedOut ? "timeout" : "network" }, "Directions request failed");
      throw new RoutingError(timedOut ? "routing_timeout" : "routing_unavailable");
    }

    if (res.status === 429) {
      await discard(res);
      const retry = Number(res.headers.get("retry-after"));
      const ms = Number.isFinite(retry) && retry > 0 ? Math.min(retry, 300) * 1000 : DEFAULT_BUSY_PAUSE_MS;
      this.pausedUntil = this.now() + ms;
      this.pauseCode = "routing_busy";
      this.deps.log?.warn({ status: 429 }, "Mapbox is throttling Directions requests");
      throw new RoutingError("routing_busy", Math.ceil(ms / 1000));
    }
    if (res.status === 401 || res.status === 403) {
      await discard(res);
      this.pausedUntil = this.now() + TOKEN_REJECTED_PAUSE_MS;
      this.pauseCode = "routing_unavailable";
      this.deps.log?.error({ status: res.status }, "Mapbox rejected MAPBOX_DIRECTIONS_TOKEN");
      throw new RoutingError("routing_unavailable");
    }
    // Mapbox answers "no route" with 200 or 422 depending on the case; read the body
    if (res.status !== 200 && res.status !== 422 && res.status !== 404) {
      await discard(res);
      this.deps.log?.warn({ status: res.status }, "Directions request failed");
      throw new RoutingError("routing_unavailable");
    }

    let body: unknown;
    try {
      body = await readJson(res);
    } catch {
      this.deps.log?.warn({ status: res.status, kind: "unreadable" }, "Directions response unreadable");
      throw new RoutingError("routing_bad_response");
    }
    try {
      return parseDirectionsResponse(body);
    } catch (err) {
      if (err instanceof RoutingError) throw err;
      const field = err instanceof BadResponse ? err.message : "unknown";
      this.deps.log?.warn({ status: res.status, kind: "invalid", field }, "Directions response invalid");
      throw new RoutingError("routing_bad_response");
    }
  }
}

async function discard(res: Response) {
  try { await res.body?.cancel(); } catch { /* ignore */ }
}

/** Reads a JSON body, refusing anything larger than MAX_RESPONSE_BYTES */
async function readJson(res: Response): Promise<unknown> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await discard(res);
    throw new BadResponse("too_large");
  }
  const text = await res.text();
  if (text.length > MAX_RESPONSE_BYTES) throw new BadResponse("too_large");
  return JSON.parse(text);
}
