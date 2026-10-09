import { Router, type Request, type Response } from "express";
import { config } from "../config";
import { requireUser } from "../middleware/auth";
import { handler } from "../lib/http";
import { logger } from "../lib/logger";
import { rateLimit } from "../lib/rateLimit";
import { Body } from "../lib/validate";
import { DirectionsClient, RoutingError, type RouteRequest } from "../lib/mapboxDirections";

const router = Router();

// ─── Route previews (Navigation Phase 2A) ────────────────────────────────────
// The Mapbox token stays on the server (lib/mapboxDirections). Origins and
// destinations arrive in the request body only (never a URL), are passed to
// Mapbox and forgotten: never logged, stored or cached. Requests are made
// only when the user asks for a route (the app never polls).
const directions = new DirectionsClient(config.directions, { log: logger });

/** Reads the request body: origin {lat, lng, headingDeg?}, destination {lat, lng} */
export function readRouteRequest(body: Body): RouteRequest {
  const origin = body.object("origin")!;
  const destination = body.object("destination")!;
  return {
    origin: {
      lat: origin.num("lat", { min: -90, max: 90 })!,
      lng: origin.num("lng", { min: -180, max: 180 })!,
      headingDeg: origin.num("headingDeg", { optional: true, nullable: true, min: 0, max: 360 }) ?? null,
    },
    destination: {
      lat: destination.num("lat", { min: -90, max: 90 })!,
      lng: destination.num("lng", { min: -180, max: 180 })!,
    },
  };
}

/** Sends a RoutingError as our JSON error shape */
export function sendRoutingError(res: Response, err: RoutingError) {
  if (err.retryAfterSec) res.setHeader("Retry-After", String(err.retryAfterSec));
  res.status(err.status).json({ error: err.code, message: err.message });
}

// POST /api/navigation/routes — per user: 10 a minute, 60 an hour
router.post("/navigation/routes", requireUser,
  rateLimit({ name: "route", windowMs: 60_000, max: 10 }),
  rateLimit({ name: "route", windowMs: 60 * 60_000, max: 60 }),
  handler(async (req: Request, res: Response) => {
    const request = readRouteRequest(Body.of(req));
    try {
      res.json(await directions.routes(request));
    } catch (err) {
      if (!(err instanceof RoutingError)) throw err;
      sendRoutingError(res, err);
    }
  }));

export default router;
