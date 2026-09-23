# DriveOS — Supabase backend

The SQL files in `migrations/` are the **source of truth** for the database
schema, Row Level Security, Storage buckets and database functions.

- `lib/db/src/schema/supabase.ts` is a typed Drizzle mirror for the API. It is
  checked against the migrations but never used to change a database.
- **Never run `drizzle-kit push`** (or `drizzle-kit generate`) against any
  database. The old push workflow has been removed.
- To change the schema, add a new migration file. Never edit a migration that
  has already been applied to a hosted project.

## Layout

| Path | Purpose |
|---|---|
| `config.toml` | Supabase CLI project config (local stack, Auth defaults) |
| `migrations/` | Ordered SQL migrations, `YYYYMMDDHHMMSS_name.sql` |
| `tests/local/00_supabase_stub.sql` | Stand-in for Supabase's `auth`/`storage` schemas and roles, for local verification only |
| `tests/local/10_schema_smoke.sql` | Schema smoke tests (structure, constraints, exposure) |
| `tests/local/20_rls_security.sql` | RLS and security tests, run as real `authenticated` / `anon` sessions |
| `tests/local/run.sh` | Throwaway-database verification runner |
| `../.github/workflows/database.yml` | CI: runs all of the above on every pull request touching the database |

## Migrations

| # | File | Contents |
|---|---|---|
| 0001 | `foundation` | PostGIS (in `extensions`), `private` schema, locked-down default privileges, shared trigger helpers |
| 0002 | `profiles` | `profiles` (= `auth.users.id`), `user_settings`, `user_blocks`, XP/level functions, sign-up trigger |
| 0003 | `vehicles` | `vehicles`, `vehicle_service_records`, `vehicle_documents`, `vehicle_modifications` |
| 0004 | `community` | `groups`, `group_members`, `convoys`, `convoy_participants`, `events`, `event_rsvps`, `private.join_codes` |
| 0005 | `journeys` | `journey_categories` (+ defaults), `journeys`, `journey_route_points`, owner-only `journey_routes` |
| 0006 | `social` | `friendships`, `friend_requests` |
| 0007 | `locations` | `saved_locations` (incl. Beauty Spots, PostGIS `geog`) |
| 0008 | `media` | `photos`, cover-photo keys, Storage deletion queue and triggers |
| 0009 | `notifications` | `notifications`, `push_devices`, `content_reports` |
| 0010 | `achievements` | `achievements` (+ catalogue), `user_achievements` |
| 0011 | `rls_helpers` | Security-definer helper functions used by policies |
| 0012 | `rls_policies` | All table policies; revokes every client-role privilege |
| 0013 | `storage` | Six buckets with limits, `storage.objects` policies |
| 0014 | `geo_functions` | `nearby_spots`, `spots_in_view` |
| 0015 | `client_write_guards` | Per-table list of the columns clients may change; everything else is server-only |

## Security model (current stage)

- RLS is enabled on every table in the same migration that creates it.
- `anon` and `authenticated` hold **no privileges** on any `public` table or
  function. Nothing is reachable through the Data API with the publishable key,
  even with a valid user token.
- The Express API connects as the table owner (not restricted by RLS) and
  enforces the same rules in its queries.
- The policies in 0012/0013 define what each signed-in user may do. They take
  effect table by table when a later migration grants privileges to
  `authenticated` for direct app access.
- Server-only writes (XP, stats, notifications, friendships, capacity-checked
  joins, journey start/complete) have no policy at all, so they stay
  impossible for clients even after privileges are granted.
- RLS controls rows, not columns, so migration 0015 adds a guard trigger per
  table listing the columns a client may change (e.g. a journey's name and
  visibility, never its distance or XP; a group's details, never its owner).
- Photo and document rows can only reference files in their owner's own
  folder, so a metadata row can never unlock somebody else's file.
- Data that must never be shared lives in its own owner-only table rather
  than on a shareable row: raw GPS points, the full route summary
  (`journey_routes`) and join codes (`private.join_codes`).
- Private files (vehicle/journey/location photos, vehicle documents) are in
  private buckets; vehicle documents are readable by their owner only.

## Local verification

Applies every migration to a throwaway PostgreSQL + PostGIS instance (Unix
socket only, deleted afterwards), runs the schema smoke tests, checks the
Drizzle mirror for drift, then runs the RLS and security suite in a second,
clean database. It never connects to Supabase, Railway or any remote database.

The RLS suite first proves that client roles currently hold no privileges,
then grants full table privileges to `anon` and `authenticated` (the worst
case for any future direct-access migration) and checks, as alice, her friend
bob, stranger carol, blocked user dave and an anonymous caller, that RLS, the
write guards and the constraints alone still enforce every rule — including
Storage object access.

The same checks run in CI (`.github/workflows/database.yml`) on every pull
request that touches `supabase/` or `lib/db/`.

```bash
pnpm install            # once, for the Drizzle drift check
pnpm run db:verify-local
```

Requires PostgreSQL server binaries and PostGIS 3 for the same major version
(e.g. Debian/Ubuntu: `postgresql-16` and `postgresql-16-postgis-3`). Set
`PG_BIN` to choose a version, `KEEP_DB=1` to keep the database for inspection, `MIGRATIONS_DIR` to test
a modified copy of the migrations.

## Applying to a hosted project (later phases)

Not done yet. Migrations will be applied to the staging project with the
Supabase CLI (`supabase db push`) from a manually triggered GitHub Action,
after review. Secrets (access token, database password) live only in GitHub
Actions / Railway settings, never in this repository.
