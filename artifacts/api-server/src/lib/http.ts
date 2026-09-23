import type { NextFunction, Request, RequestHandler, Response } from "express";

/** An error that is safe to show to the client, with an HTTP status. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
  }
}

export const badRequest = (code: string, message?: string) => new HttpError(400, code, message);
export const forbidden = (code = "forbidden", message?: string) => new HttpError(403, code, message);
export const notFound = (code = "not_found", message?: string) => new HttpError(404, code, message);
export const conflict = (code: string, message?: string) => new HttpError(409, code, message);

/** Wraps an async handler so rejections reach the error middleware. */
export const handler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next);
  };

/** Normalises an Express 5 route param to a single string. */
export function param(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);

/** Reads a UUID route param, answering 404 for anything malformed. */
export function uuidParam(req: Request, name: string): string {
  const v = param(req.params[name]);
  if (!isUuid(v)) throw notFound();
  return v.toLowerCase();
}
