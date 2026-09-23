#!/bin/bash
set -e
pnpm install --frozen-lockfile
# The database schema is no longer pushed from here. It is managed by the SQL
# migrations in supabase/migrations (see supabase/README.md).
