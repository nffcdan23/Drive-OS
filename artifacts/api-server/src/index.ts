import app from "./app";
import { config } from "./config";
import { logger } from "./lib/logger";
import { startStorageWorker } from "./workers/storageCleanup";
import { startLiveLocationCleanup } from "./workers/liveLocationCleanup";

const server = app.listen(config.port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }
  logger.info({ port: config.port, env: config.env }, "Server listening");
});

if (config.supabaseSecretKey && config.storageWorker) {
  startStorageWorker(config.storageWorkerIntervalMs);
} else {
  logger.warn("Storage clean-up worker is off (no SUPABASE_SECRET_KEY or STORAGE_WORKER=off)");
}

// Expired live positions are already unreadable; this only tidies the table.
startLiveLocationCleanup();

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    logger.info({ signal }, "Shutting down");
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}
