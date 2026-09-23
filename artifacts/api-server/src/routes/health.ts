import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { checkDatabase } from "@workspace/db";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// Liveness: the process is up (used by the host's startup check; no DB).
router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

// Readiness: the API can reach the database.
router.get("/readyz", async (_req, res) => {
  try {
    await checkDatabase();
    res.json({ status: "ok", database: "ok" });
  } catch (err) {
    logger.error({ err }, "Readiness check failed");
    res.status(503).json({ status: "unavailable", database: "unreachable" });
  }
});

export default router;
