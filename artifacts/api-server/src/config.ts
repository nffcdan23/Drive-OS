/**
 * Runtime configuration, read once at startup.
 *
 *   PORT                  required
 *   NODE_ENV              "production" on Railway; "test" only for the test suite
 *   DATABASE_URL          Supabase Postgres (session pooler); see @workspace/db
 *   SUPABASE_URL          https://<project-ref>.supabase.co
 *   SUPABASE_SECRET_KEY   secret (or legacy service_role) key — server only;
 *                         used for Storage signed URLs, file deletion and
 *                         account deletion. Never sent to clients.
 *   SUPABASE_JWT_SECRET   only for projects that still sign tokens with the
 *                         legacy shared secret (HS256). Projects using signing
 *                         keys are verified against the public JWKS instead.
 *   DVLA_API_KEY          optional; enables registration lookup
 *   STORAGE_WORKER        "off" disables the Storage clean-up worker
 *   STORAGE_WORKER_INTERVAL_MS  how often it runs (default 60000)
 */
export interface Config {
  port: number;
  env: string;
  isProduction: boolean;
  supabaseUrl: string | null;
  supabaseSecretKey: string | null;
  jwtSecret: string | null;
  dvlaApiKey: string | null;
  dvlaUrl: string;
  storageWorker: boolean;
  storageWorkerIntervalMs: number;
}

function read(env: NodeJS.ProcessEnv): Config {
  const rawPort = env.PORT;
  if (!rawPort) throw new Error("PORT environment variable is required but was not provided.");
  const port = Number(rawPort);
  if (Number.isNaN(port) || port <= 0) throw new Error(`Invalid PORT value: "${rawPort}"`);

  const nodeEnv = env.NODE_ENV ?? "development";
  const supabaseUrl = env.SUPABASE_URL ? env.SUPABASE_URL.replace(/\/+$/, "") : null;

  const config: Config = {
    port,
    env: nodeEnv,
    isProduction: nodeEnv === "production",
    supabaseUrl,
    supabaseSecretKey: env.SUPABASE_SECRET_KEY || null,
    jwtSecret: env.SUPABASE_JWT_SECRET || null,
    dvlaApiKey: env.DVLA_API_KEY || null,
    dvlaUrl: env.DVLA_VES_URL ?? "https://driver-vehicle-licensing.api.gov.uk/vehicle-enquiry/v1/vehicles",
    storageWorker: env.STORAGE_WORKER !== "off",
    storageWorkerIntervalMs: Math.max(200, Number(env.STORAGE_WORKER_INTERVAL_MS) || 60_000),
  };

  if (!config.supabaseUrl) {
    throw new Error("SUPABASE_URL is required: every request is authenticated with a Supabase token.");
  }
  if (config.isProduction && !config.supabaseSecretKey) {
    throw new Error("SUPABASE_SECRET_KEY is required in production (uploads and account deletion).");
  }
  return config;
}

export const config: Config = read(process.env);
