/**
 * DVLA Vehicle Enquiry Service (VES) client.
 *
 * The API key stays on this server: it is sent only to DVLA's own hosts, in
 * the x-api-key header, and never appears in responses or logs. Neither do
 * registrations: logs carry status codes only.
 *
 * Every outcome becomes one of our stable error codes (LookupError), so the
 * app never sees DVLA's own responses. Lookups are transient: results are
 * kept in memory for a few minutes and nothing is stored in the database.
 *
 * Deliberately self-contained (no imports from the rest of the API) so it can
 * be unit-tested directly.
 */
import { parseUkRegistration } from "@workspace/vehicle-registration";

// ─── Configuration ──────────────────────────────────────────────────────────

export const DVLA_VES_PATH = "/vehicle-enquiry/v1/vehicles";
/** The only hosts the API key may ever be sent to (live and DVLA's test environment). */
export const DVLA_HOSTS = ["driver-vehicle-licensing.api.gov.uk", "uat.driver-vehicle-licensing.api.gov.uk"] as const;
export const DEFAULT_DVLA_URL = `https://${DVLA_HOSTS[0]}${DVLA_VES_PATH}`;

export interface DvlaConfig {
  apiKey: string | null;
  url: string;
  timeoutMs: number;
}

export class DvlaConfigError extends Error {}

/**
 * Reads DVLA_API_KEY, DVLA_VES_URL and DVLA_TIMEOUT_MS. The URL must be one of
 * DVLA's hosts over HTTPS; a plain-HTTP loopback stub is accepted only when
 * NODE_ENV is "test". Anything else stops the server at startup.
 */
export function readDvlaConfig(env: Record<string, string | undefined>): DvlaConfig {
  const apiKey = env.DVLA_API_KEY?.trim() || null;
  if (apiKey && !/^[\x21-\x7e]{8,256}$/.test(apiKey)) {
    throw new DvlaConfigError("DVLA_API_KEY has an unexpected format (check for stray spaces or line breaks).");
  }

  const raw = env.DVLA_VES_URL?.trim() || DEFAULT_DVLA_URL;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new DvlaConfigError("DVLA_VES_URL is not a valid URL.");
  }
  const clean = !url.username && !url.password && !url.search && !url.hash;
  const official = clean && url.protocol === "https:" && url.port === "" &&
    (DVLA_HOSTS as readonly string[]).includes(url.hostname) && url.pathname === DVLA_VES_PATH;
  const testStub = clean && env.NODE_ENV === "test" && url.protocol === "http:" &&
    (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  if (!official && !testStub) {
    throw new DvlaConfigError(
      `DVLA_VES_URL must be https://${DVLA_HOSTS.join(" or https://")}${DVLA_VES_PATH}.`,
    );
  }

  const timeout = Number(env.DVLA_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(timeout) && timeout > 0 ? Math.min(Math.max(timeout, 100), 15_000) : 8_000;
  return { apiKey, url: url.toString(), timeoutMs };
}

// ─── Results and errors ─────────────────────────────────────────────────────

export type AppFuelType = "petrol" | "diesel" | "electric" | "hybrid" | "other";

export interface VehicleLookupResult {
  registration: string;
  displayRegistration: string;
  source: "dvla";
  /** When DVLA answered (cached answers keep their original time). */
  checkedAt: string;
  /** DVLA's values, as published (cleaned of stray whitespace). */
  vehicle: {
    make: string | null;
    colour: string | null;
    fuelType: string | null;
    yearOfManufacture: number | null;
    engineCapacityCc: number | null;
  };
  /** The same values in the app's form conventions. */
  suggested: {
    make: string | null;
    colour: string | null;
    fuelType: AppFuelType | null;
    year: number | null;
    engine: string | null;
  };
}

export type LookupErrorCode =
  | "invalid_registration"
  | "vehicle_not_found"
  | "lookup_not_configured"
  | "lookup_busy"
  | "lookup_unavailable"
  | "lookup_timeout"
  | "lookup_bad_response";

const ERRORS: Record<LookupErrorCode, { status: number; message: string }> = {
  invalid_registration: { status: 400, message: "That isn't a valid UK registration." },
  vehicle_not_found: { status: 404, message: "DVLA has no vehicle with that registration." },
  lookup_not_configured: { status: 503, message: "Live DVLA lookup is not connected on this server." },
  lookup_busy: { status: 503, message: "DVLA is busy right now. Try again shortly." },
  lookup_unavailable: { status: 503, message: "DVLA lookup is unavailable right now." },
  lookup_timeout: { status: 504, message: "DVLA took too long to respond." },
  lookup_bad_response: { status: 502, message: "DVLA sent a response we couldn't read." },
};

export class LookupError extends Error {
  readonly status: number;
  constructor(readonly code: LookupErrorCode, readonly retryAfterSec?: number) {
    super(ERRORS[code].message);
    this.status = ERRORS[code].status;
  }
}

// ─── Parsing and normalisation ──────────────────────────────────────────────

/** Largest DVLA response accepted (a real one is well under 1 KB). */
export const MAX_RESPONSE_BYTES = 64 * 1024;

class BadResponse extends Error {}

function cleanText(v: unknown, field: string, max: number): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string" || v.length > max) throw new BadResponse(field);
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return s || null;
}

function cleanInt(v: unknown, field: string, min: number, max: number): number | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw new BadResponse(field);
  return v;
}

/**
 * Validates a VES response body strictly. Unknown fields are ignored; a known
 * field with the wrong type, or a registration other than the one asked for,
 * rejects the whole response.
 */
export function parseVesResponse(body: unknown, requested: string): VehicleLookupResult["vehicle"] {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new BadResponse("body");
  const b = body as Record<string, unknown>;
  const reg = cleanText(b.registrationNumber, "registrationNumber", 20);
  if (reg !== null && reg.replace(/\s+/g, "").toUpperCase() !== requested) throw new BadResponse("registrationNumber");
  return {
    make: cleanText(b.make, "make", 100),
    colour: cleanText(b.colour, "colour", 100),
    fuelType: cleanText(b.fuelType, "fuelType", 100),
    yearOfManufacture: cleanInt(b.yearOfManufacture, "yearOfManufacture", 1885, 2100),
    engineCapacityCc: cleanInt(b.engineCapacity, "engineCapacity", 0, 100_000),
  };
}

/**
 * Maps VES fuel text onto the app's options. VES values include PETROL,
 * DIESEL, ELECTRICITY, HYBRID ELECTRIC, ELECTRIC DIESEL (a diesel hybrid),
 * GAS, GAS BI-FUEL (LPG), PETROL/GAS, GAS DIESEL, STEAM, FUEL CELLS, OTHER.
 */
export function suggestFuelType(raw: string | null): AppFuelType | null {
  const v = (raw ?? "").toUpperCase().replace(/\s+/g, " ").trim();
  if (!v) return null;
  if (v === "PETROL") return "petrol";
  if (v === "DIESEL" || v === "HEAVY OIL") return "diesel";
  if (v === "ELECTRICITY" || v === "ELECTRIC") return "electric";
  if (v.includes("HYBRID") || (v.includes("ELECTRIC") && (v.includes("PETROL") || v.includes("DIESEL")))) return "hybrid";
  return "other";
}

/** 1598 cc → "1.6L". Electric vehicles have no engine capacity. */
export function suggestEngine(cc: number | null): string | null {
  return cc && cc > 0 ? `${(cc / 1000).toFixed(1)}L` : null;
}

const KEEP_UPPER = new Set(["MINI", "SEAT", "DAF"]);

/** "VOLKSWAGEN" → "Volkswagen", "MERCEDES-BENZ" → "Mercedes-Benz"; short names stay upper case (BMW, MG). */
export function suggestMake(raw: string | null): string | null {
  if (!raw) return null;
  return raw.toUpperCase().split(" ").map((word) =>
    KEEP_UPPER.has(word) || word.length <= 3 ? word : word.split("-").map(titleWord).join("-"),
  ).join(" ");
}

/** "DARK BLUE" → "Dark Blue". */
export function suggestColour(raw: string | null): string | null {
  return raw ? raw.split(" ").map(titleWord).join(" ") : null;
}

const titleWord = (w: string) => (w ? w[0]!.toUpperCase() + w.slice(1).toLowerCase() : w);

// ─── Client ─────────────────────────────────────────────────────────────────

export interface DvlaClientDeps {
  fetch?: typeof fetch;
  now?: () => number;
  /** Receives status codes and error kinds only — never a registration or the key. */
  log?: { warn: (obj: object, msg: string) => void; error: (obj: object, msg: string) => void };
}

const FOUND_TTL_MS = 15 * 60_000;
const NOT_FOUND_TTL_MS = 10 * 60_000;
const CACHE_MAX = 1_000;
const FAILURES_BEFORE_PAUSE = 5;
const FAILURE_PAUSE_MS = 30_000;
const KEY_REJECTED_PAUSE_MS = 5 * 60_000;
const DEFAULT_BUSY_PAUSE_MS = 60_000;

type CacheEntry = { expires: number; result?: VehicleLookupResult; notFound?: true };

export class DvlaClient {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<VehicleLookupResult>>();
  private failures = 0;
  private pausedUntil = 0;
  private pauseCode: "lookup_busy" | "lookup_unavailable" = "lookup_unavailable";
  /** Calls actually made to DVLA (for tests and diagnostics). */
  upstreamCalls = 0;

  constructor(private readonly cfg: DvlaConfig, private readonly deps: DvlaClientDeps = {}) {}

  get configured() { return !!this.cfg.apiKey; }

  private now() { return (this.deps.now ?? Date.now)(); }

  async lookup(input: string): Promise<VehicleLookupResult> {
    const parsed = typeof input === "string" && input.length <= 20 ? parseUkRegistration(input) : null;
    if (!parsed) throw new LookupError("invalid_registration");
    if (!this.cfg.apiKey) throw new LookupError("lookup_not_configured");

    const key = parsed.registration;
    const cached = this.cache.get(key);
    if (cached && cached.expires > this.now()) {
      if (cached.notFound) throw new LookupError("vehicle_not_found");
      return cached.result!;
    }
    if (cached) this.cache.delete(key);

    // Identical lookups at the same moment share one DVLA call.
    const pending = this.inFlight.get(key);
    if (pending) return pending;
    const call = this.fetchFromDvla(parsed.registration, parsed.display).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, call);
    return call;
  }

  private remember(key: string, entry: CacheEntry) {
    if (this.cache.size >= CACHE_MAX) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(key, entry);
  }

  private pause(ms: number, code: "lookup_busy" | "lookup_unavailable") {
    this.pausedUntil = this.now() + ms;
    this.pauseCode = code;
  }

  private failed(kind: string, status?: number) {
    this.failures++;
    this.deps.log?.warn({ kind, status, consecutiveFailures: this.failures }, "DVLA lookup failed");
    if (this.failures >= FAILURES_BEFORE_PAUSE) {
      this.pause(FAILURE_PAUSE_MS, "lookup_unavailable");
      this.failures = 0;
    }
  }

  private async fetchFromDvla(registration: string, display: string): Promise<VehicleLookupResult> {
    const remaining = this.pausedUntil - this.now();
    if (remaining > 0) throw new LookupError(this.pauseCode, Math.ceil(remaining / 1000));

    const doFetch = this.deps.fetch ?? fetch;
    let res: Response;
    this.upstreamCalls++;
    try {
      res = await doFetch(this.cfg.url, {
        method: "POST",
        headers: { "x-api-key": this.cfg.apiKey!, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ registrationNumber: registration }),
        // Never follow a redirect: the key must only ever reach DVLA's own host.
        redirect: "error",
        signal: AbortSignal.timeout(this.cfg.timeoutMs),
      });
    } catch (err) {
      const timedOut = (err as Error)?.name === "TimeoutError" || (err as Error)?.name === "AbortError";
      this.failed(timedOut ? "timeout" : "network");
      throw new LookupError(timedOut ? "lookup_timeout" : "lookup_unavailable");
    }

    if (res.status === 404) {
      await discard(res);
      this.failures = 0;
      this.remember(registration, { expires: this.now() + NOT_FOUND_TTL_MS, notFound: true });
      throw new LookupError("vehicle_not_found");
    }
    if (res.status === 400) {
      await discard(res);
      throw new LookupError("invalid_registration");
    }
    if (res.status === 429) {
      await discard(res);
      const retry = Number(res.headers.get("retry-after"));
      const ms = Number.isFinite(retry) && retry > 0 ? Math.min(retry, 300) * 1000 : DEFAULT_BUSY_PAUSE_MS;
      this.pause(ms, "lookup_busy");
      this.deps.log?.warn({ status: 429 }, "DVLA is throttling lookups");
      throw new LookupError("lookup_busy", Math.ceil(ms / 1000));
    }
    if (res.status === 401 || res.status === 403) {
      await discard(res);
      this.pause(KEY_REJECTED_PAUSE_MS, "lookup_unavailable");
      this.deps.log?.error({ status: res.status }, "DVLA rejected the API key (check DVLA_API_KEY)");
      throw new LookupError("lookup_unavailable", KEY_REJECTED_PAUSE_MS / 1000);
    }
    if (res.status !== 200) {
      await discard(res);
      this.failed("status", res.status);
      throw new LookupError("lookup_unavailable");
    }

    let vehicle: VehicleLookupResult["vehicle"];
    try {
      const text = await readLimited(res, MAX_RESPONSE_BYTES);
      vehicle = parseVesResponse(JSON.parse(text), registration);
    } catch (err) {
      if ((err as Error)?.name === "TimeoutError" || (err as Error)?.name === "AbortError") {
        this.failed("timeout");
        throw new LookupError("lookup_timeout");
      }
      this.failed(!(err instanceof BadResponse) ? "bad_body" : err.message === "size" ? "too_large" : `bad_field:${err.message}`);
      throw new LookupError("lookup_bad_response");
    }

    this.failures = 0;
    const result: VehicleLookupResult = {
      registration,
      displayRegistration: display,
      source: "dvla",
      checkedAt: new Date(this.now()).toISOString(),
      vehicle,
      suggested: {
        make: suggestMake(vehicle.make),
        colour: suggestColour(vehicle.colour),
        fuelType: suggestFuelType(vehicle.fuelType),
        year: vehicle.yearOfManufacture,
        engine: suggestEngine(vehicle.engineCapacityCc),
      },
    };
    this.remember(registration, { expires: this.now() + FOUND_TTL_MS, result });
    return result;
  }
}

async function discard(res: Response) {
  try { await res.body?.cancel(); } catch { /* already closed */ }
}

/** Reads a response body as text, refusing more than `max` bytes. */
async function readLimited(res: Response, max: number): Promise<string> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) {
    await discard(res);
    throw new BadResponse("size");
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      throw new BadResponse("size");
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}
