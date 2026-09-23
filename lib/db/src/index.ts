import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema/supabase";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

type SslMode = "disable" | "require" | "verify-full";

/**
 * Builds the pool configuration from DATABASE_URL.
 *
 * TLS is configured here rather than through `sslmode` in the URL, because
 * recent `pg` versions reinterpret `sslmode=require` as full verification.
 *   DATABASE_SSL_MODE  disable | require | verify-full
 *                      (default: disable for local sockets / localhost,
 *                       verify-full when DATABASE_SSL_CA is set, else require)
 *   DATABASE_SSL_CA    PEM certificate to verify the server against
 *                      (Supabase: Project Settings → Database → SSL)
 *   DATABASE_POOL_MAX  maximum connections (default 5; Supabase pools too)
 */
export function poolConfig(env: NodeJS.ProcessEnv = process.env): pg.PoolConfig & { sslMode: SslMode } {
  // Unix-socket URLs (postgresql://user@/db?host=/path) have an empty host,
  // which WHATWG URL rejects; parse them with a placeholder host.
  const raw = env.DATABASE_URL as string;
  const emptyHost = /^postgres(?:ql)?:\/\/(?:[^/@]*@)?\//.test(raw);
  const url = new URL(emptyHost ? raw.replace(/^(postgres(?:ql)?:\/\/(?:[^/@]*@)?)\//, "$1socket.invalid/") : raw);
  for (const p of ["sslmode", "sslcert", "sslkey", "sslrootcert", "uselibpqcompat"]) url.searchParams.delete(p);

  const socketHost = url.searchParams.get("host") ?? "";
  const isLocal =
    emptyHost || socketHost.startsWith("/") || ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  const ca = env.DATABASE_SSL_CA?.replace(/\\n/g, "\n");
  const mode = (env.DATABASE_SSL_MODE as SslMode | undefined) ??
    (isLocal ? "disable" : ca ? "verify-full" : "require");

  const ssl =
    mode === "disable" ? false :
    mode === "verify-full" ? { rejectUnauthorized: true, ...(ca ? { ca } : {}) } :
    { rejectUnauthorized: false };

  return {
    connectionString: emptyHost ? url.toString().replace("socket.invalid/", "/") : url.toString(),
    ssl,
    sslMode: mode,
    max: Number(env.DATABASE_POOL_MAX ?? 5),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    application_name: "driveos-api",
  };
}

const { sslMode, ...config } = poolConfig();
export const dbSslMode = sslMode;
export const pool = new Pool(config);
export const db = drizzle(pool, { schema });

/** Throws if the database cannot be reached (used by the readiness check). */
export async function checkDatabase(): Promise<void> {
  await pool.query("select 1");
}

export * from "./schema/supabase";
