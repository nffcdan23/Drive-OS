import type { Request, RequestHandler } from "express";
import { HttpError } from "./http";

/**
 * Fixed-window, in-memory rate limiter keyed by user (or IP when signed
 * out). Suitable for a single API instance; move to a shared store if the
 * API is ever scaled horizontally.
 */
export function rateLimit(opts: { name: string; windowMs: number; max: number }): RequestHandler {
  const hits = new Map<string, { count: number; resetAt: number }>();
  let lastSweep = Date.now();

  return (req: Request, res, next) => {
    const now = Date.now();
    if (now - lastSweep > opts.windowMs) {
      for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
      lastSweep = now;
    }
    const key = req.userId ?? req.ip ?? "unknown";
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + opts.windowMs };
      hits.set(key, entry);
    }
    entry.count++;
    res.setHeader("RateLimit-Limit", String(opts.max));
    res.setHeader("RateLimit-Remaining", String(Math.max(0, opts.max - entry.count)));
    if (entry.count > opts.max) {
      res.setHeader("Retry-After", String(Math.ceil((entry.resetAt - now) / 1000)));
      next(new HttpError(429, "rate_limited", `Too many ${opts.name} requests. Try again shortly.`));
      return;
    }
    next();
  };
}
