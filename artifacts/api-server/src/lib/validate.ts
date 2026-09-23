import type { Request } from "express";
import { badRequest, isUuid } from "./http";

/**
 * Minimal request-body reader. Every field a route uses is read through a
 * typed accessor that enforces type, length, range and allowed values; any
 * other fields in the body are ignored (never passed through to the database).
 *
 *   optional: missing / undefined → returns undefined
 *   nullable: null is accepted and returned as null
 */
interface Opts {
  optional?: boolean;
  nullable?: boolean;
}

const invalid = (field: string, why: string) => badRequest("invalid_input", `${field}: ${why}`);

export class Body {
  constructor(private readonly data: Record<string, unknown>) {}

  static of(req: Request): Body {
    const b = req.body;
    if (b === undefined || b === null) return new Body({});
    if (typeof b !== "object" || Array.isArray(b)) throw badRequest("invalid_body", "Expected a JSON object");
    return new Body(b as Record<string, unknown>);
  }

  has(field: string): boolean {
    return this.data[field] !== undefined;
  }

  private raw<T>(field: string, opts: Opts, read: (v: unknown) => T): T | undefined | null {
    const v = this.data[field];
    if (v === undefined) {
      if (opts.optional) return undefined;
      throw invalid(field, "is required");
    }
    if (v === null) {
      if (opts.nullable) return null;
      throw invalid(field, "must not be null");
    }
    return read(v);
  }

  str(field: string, o: Opts & { min?: number; max?: number; pattern?: RegExp; trim?: boolean } = {}) {
    return this.raw(field, o, (v) => {
      if (typeof v !== "string") throw invalid(field, "must be a string");
      const s = o.trim === false ? v : v.trim();
      if (s.length < (o.min ?? 0)) throw invalid(field, `must be at least ${o.min} characters`);
      if (s.length > (o.max ?? 500)) throw invalid(field, `must be at most ${o.max ?? 500} characters`);
      if (o.pattern && !o.pattern.test(s)) throw invalid(field, "has an invalid format");
      return s;
    });
  }

  int(field: string, o: Opts & { min?: number; max?: number } = {}) {
    return this.raw(field, o, (v) => {
      if (typeof v !== "number" || !Number.isInteger(v)) throw invalid(field, "must be a whole number");
      if (o.min !== undefined && v < o.min) throw invalid(field, `must be ≥ ${o.min}`);
      if (o.max !== undefined && v > o.max) throw invalid(field, `must be ≤ ${o.max}`);
      return v;
    });
  }

  num(field: string, o: Opts & { min?: number; max?: number } = {}) {
    return this.raw(field, o, (v) => {
      if (typeof v !== "number" || !Number.isFinite(v)) throw invalid(field, "must be a number");
      if (o.min !== undefined && v < o.min) throw invalid(field, `must be ≥ ${o.min}`);
      if (o.max !== undefined && v > o.max) throw invalid(field, `must be ≤ ${o.max}`);
      return v;
    });
  }

  bool(field: string, o: Opts = {}) {
    return this.raw(field, o, (v) => {
      if (typeof v !== "boolean") throw invalid(field, "must be true or false");
      return v;
    });
  }

  oneOf<const T extends readonly string[]>(field: string, values: T, o: Opts = {}) {
    return this.raw(field, o, (v) => {
      if (typeof v !== "string" || !values.includes(v)) throw invalid(field, `must be one of ${values.join(", ")}`);
      return v as T[number];
    });
  }

  uuid(field: string, o: Opts = {}) {
    return this.raw(field, o, (v) => {
      if (!isUuid(v)) throw invalid(field, "must be a UUID");
      return v.toLowerCase();
    });
  }

  /** Calendar date, YYYY-MM-DD. */
  date(field: string, o: Opts = {}) {
    return this.raw(field, o, (v) => {
      if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) {
        throw invalid(field, "must be a date (YYYY-MM-DD)");
      }
      return v;
    });
  }

  /** ISO-8601 timestamp with a time zone (e.g. 2026-09-23T10:00:00Z). */
  timestamp(field: string, o: Opts = {}) {
    return this.raw(field, o, (v) => {
      if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:?\d{2})$/.test(v)) {
        throw invalid(field, "must be an ISO timestamp with a time zone");
      }
      const d = new Date(v);
      if (Number.isNaN(d.getTime())) throw invalid(field, "is not a valid timestamp");
      return d;
    });
  }

  array(field: string, o: Opts & { max?: number } = {}) {
    return this.raw(field, o, (v) => {
      if (!Array.isArray(v)) throw invalid(field, "must be an array");
      if (o.max !== undefined && v.length > o.max) throw invalid(field, `must have at most ${o.max} items`);
      return v as unknown[];
    });
  }

  /** A nested object, read with its own Body. */
  object(field: string, o: Opts = {}) {
    return this.raw(field, o, (v) => {
      if (typeof v !== "object" || Array.isArray(v)) throw invalid(field, "must be an object");
      return new Body(v as Record<string, unknown>);
    });
  }
}

/** Reads query-string numbers (e.g. ?lat=…). */
export function queryNumber(req: Request, name: string, o: { min?: number; max?: number; fallback?: number } = {}): number {
  const raw = req.query[name];
  if (raw === undefined && o.fallback !== undefined) return o.fallback;
  const n = typeof raw === "string" ? Number(raw) : Number.NaN;
  if (!Number.isFinite(n)) throw badRequest("invalid_input", `${name}: must be a number`);
  if (o.min !== undefined && n < o.min) throw badRequest("invalid_input", `${name}: must be ≥ ${o.min}`);
  if (o.max !== undefined && n > o.max) throw badRequest("invalid_input", `${name}: must be ≤ ${o.max}`);
  return n;
}

/** IANA time zone names accepted by the runtime (e.g. Europe/London). */
export function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
