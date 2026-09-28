import type { NextFunction, Request, Response } from "express";
import { HttpError } from "../lib/http";
import { logger } from "../lib/logger";

/** 404 for unknown routes, as JSON. */
export function notFoundHandler(_req: Request, res: Response): void {
  res.status(404).json({ error: "not_found", message: "Not found." });
}

/** Postgres errors that mean "the client sent something invalid". */
const CLIENT_PG_ERRORS: Record<string, [number, string]> = {
  "23505": [409, "conflict"],             // unique violation
  "23503": [400, "invalid_reference"],    // foreign key violation
  "23514": [400, "invalid_input"],        // check constraint violation
  "23502": [400, "invalid_input"],        // not null violation
  "22P02": [400, "invalid_input"],        // invalid text representation
  "22003": [400, "invalid_input"],        // numeric out of range
  "22001": [400, "invalid_input"],        // string too long
};

/**
 * Converts every error into a JSON response. Messages from HttpError are
 * shown to the client; anything unexpected is logged and reported only as
 * "internal_error" — never a stack trace, SQL or internal detail.
 */
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  if (res.headersSent) return;

  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.code, message: err.message });
    return;
  }

  const pgCode = (err as { code?: unknown; cause?: { code?: unknown } })?.code ??
    (err as { cause?: { code?: unknown } })?.cause?.code;
  if (typeof pgCode === "string" && CLIENT_PG_ERRORS[pgCode]) {
    const [status, code] = CLIENT_PG_ERRORS[pgCode]!;
    const constraint = (err as { constraint?: string; cause?: { constraint?: string } }).constraint ??
      (err as { cause?: { constraint?: string } }).cause?.constraint;
    res.status(status).json({ error: code, message: constraint ? `Rejected by rule: ${constraint}` : "The request was rejected." });
    return;
  }

  if ((err as { type?: string })?.type === "entity.parse.failed") {
    res.status(400).json({ error: "invalid_json", message: "The request body is not valid JSON." });
    return;
  }
  if ((err as { type?: string })?.type === "entity.too.large") {
    res.status(413).json({ error: "too_large", message: "The request body is too large." });
    return;
  }

  logger.error({ err, method: req.method, url: req.originalUrl?.split("?")[0] }, "Unhandled error");
  res.status(500).json({ error: "internal_error", message: "Something went wrong." });
}
