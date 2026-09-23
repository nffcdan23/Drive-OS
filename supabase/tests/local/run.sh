#!/usr/bin/env bash
# ============================================================================
# Local verification of the Supabase migrations — never touches a real
# Supabase project, Railway, or any remote database.
#
# 1. Starts a throwaway PostgreSQL cluster in a temp directory (Unix socket
#    only, no TCP listener).
# 2. Loads a stub of the Supabase `auth` / `storage` schemas and roles.
# 3. Applies every migration in supabase/migrations in order.
# 4. Runs the schema smoke tests.
# 5. Checks the Drizzle mirror (lib/db/src/schema/supabase.ts) against the
#    migrated database (skipped with a warning if node_modules is missing).
# 6. Stops the cluster and deletes it.
#
# Requirements: PostgreSQL server binaries (initdb, pg_ctl) and PostGIS 3 for
# the same major version; Node 22+ with `pnpm install` done for the drift check.
#   PG_BIN=/usr/lib/postgresql/16/bin  overrides binary auto-detection.
#   KEEP_DB=1                          leaves the cluster running for inspection.
# ============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATIONS="$ROOT/supabase/migrations"
TESTS="$ROOT/supabase/tests/local"
PORT="${PORT_OVERRIDE:-55433}"

if [[ -z "${PG_BIN:-}" ]]; then
  PG_BIN="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1 || true)"
  [[ -z "$PG_BIN" ]] && PG_BIN="$(dirname "$(command -v initdb 2>/dev/null || echo /nonexistent/initdb)")"
fi
[[ -x "$PG_BIN/initdb" ]] || { echo "initdb not found; set PG_BIN" >&2; exit 2; }

WORK="$(mktemp -d /tmp/driveos-db-verify.XXXXXX)"
chmod 755 "$WORK"

# initdb refuses to run as root; use the postgres OS user when we are root.
as_pg() {
  if [[ "$(id -u)" == "0" ]]; then su postgres -s /bin/bash -c "$*"; else bash -c "$*"; fi
}
if [[ "$(id -u)" == "0" ]]; then chown postgres "$WORK"; fi

cleanup() {
  if [[ "${KEEP_DB:-0}" == "1" ]]; then
    echo "KEEP_DB=1: cluster left running — psql -h $WORK -p $PORT -U postgres driveos_verify"
    return
  fi
  as_pg "'$PG_BIN/pg_ctl' -D '$WORK/data' -m immediate stop" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

echo "==> Starting throwaway PostgreSQL ($("$PG_BIN/postgres" --version))"
as_pg "'$PG_BIN/initdb' -D '$WORK/data' -A trust -U postgres --no-sync" >/dev/null
as_pg "'$PG_BIN/pg_ctl' -D '$WORK/data' -o \"-p $PORT -k $WORK -c listen_addresses='' -c fsync=off\" -l '$WORK/pg.log' -w start" >/dev/null

PSQL=(psql -h "$WORK" -p "$PORT" -U postgres -X -q -v ON_ERROR_STOP=1)
"${PSQL[@]}" -d postgres -c "create database driveos_verify"
PSQL+=(-d driveos_verify)

echo "==> Loading Supabase stub (auth, storage, roles)"
"${PSQL[@]}" -f "$TESTS/00_supabase_stub.sql"

echo "==> Applying migrations"
count=0
for f in "$MIGRATIONS"/*.sql; do
  echo "    $(basename "$f")"
  "${PSQL[@]}" -f "$f"
  count=$((count + 1))
done
echo "    $count migrations applied"

echo "==> Schema smoke tests"
"${PSQL[@]}" -f "$TESTS/10_schema_smoke.sql" 2>&1 | sed -e 's/^psql:[^ ]* NOTICE:  /    /' -e 's/^NOTICE:  /    /'
status=${PIPESTATUS[0]}
[[ $status -eq 0 ]] || { echo "Schema smoke tests FAILED" >&2; exit 1; }

echo "==> Drizzle mirror drift check"
if [[ -d "$ROOT/lib/db/node_modules/drizzle-orm" ]]; then
  # Compares structure only, so the smoke-test rows left in the database are irrelevant.
  DRIFT_DATABASE_URL="postgresql://postgres@/driveos_verify?host=$WORK&port=$PORT" \
    node --experimental-strip-types --no-warnings "$ROOT/lib/db/scripts/check-drift.mjs"
else
  echo "    SKIPPED: run 'pnpm install' first (lib/db/node_modules missing)"
fi

echo "==> All local verification checks passed"
