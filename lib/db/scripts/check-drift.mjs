// Compares the Drizzle mirror (src/schema/supabase.ts) with a database built
// from supabase/migrations. Read-only: it only queries the catalog.
//
// Checks, per public table: the table set, column names, SQL types,
// nullability, whether a default/generated value exists, and generated-ness.
// Constraints, indexes and policies are intentionally out of scope — the SQL
// migrations own them.
//
// Usage (run by supabase/tests/local/run.sh):
//   DRIFT_DATABASE_URL=postgresql://... node --experimental-strip-types lib/db/scripts/check-drift.mjs
import pg from 'pg';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import * as schema from '../src/schema/supabase.ts';

const url = process.env.DRIFT_DATABASE_URL;
if (!url) {
  console.error('DRIFT_DATABASE_URL is not set');
  process.exit(2);
}

const normaliseType = (t) => t.replace(/^extensions\./, '').replace(/\s+/g, '');

const drizzleTables = new Map();
for (const value of Object.values(schema)) {
  if (!(value instanceof PgTable)) continue;
  const cfg = getTableConfig(value);
  drizzleTables.set(cfg.name, new Map(cfg.columns.map((c) => [c.name, {
    type:      normaliseType(c.getSQLType()),
    notNull:   c.notNull,
    hasValue:  c.hasDefault || c.generated !== undefined,
    generated: c.generated !== undefined,
  }])));
}

const client = new pg.Client({ connectionString: url });
await client.connect();
const { rows } = await client.query(`
  select c.relname                                   as table_name,
         a.attname                                   as column_name,
         format_type(a.atttypid, a.atttypmod)        as type,
         a.attnotnull                                as not_null,
         (a.atthasdef or a.attidentity <> '')        as has_value,
         (a.attgenerated <> '')                      as generated
  from pg_attribute a
  join pg_class c     on c.oid = a.attrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped
  order by c.relname, a.attnum`);
await client.end();

const dbTables = new Map();
for (const r of rows) {
  if (!dbTables.has(r.table_name)) dbTables.set(r.table_name, new Map());
  dbTables.get(r.table_name).set(r.column_name, {
    type: normaliseType(r.type), notNull: r.not_null, hasValue: r.has_value, generated: r.generated,
  });
}

const problems = [];
for (const t of dbTables.keys()) if (!drizzleTables.has(t)) problems.push(`table ${t}: in database, missing from Drizzle mirror`);
for (const t of drizzleTables.keys()) if (!dbTables.has(t)) problems.push(`table ${t}: in Drizzle mirror, missing from database`);

let columns = 0;
for (const [t, dbCols] of dbTables) {
  const dzCols = drizzleTables.get(t);
  if (!dzCols) continue;
  for (const c of dbCols.keys()) if (!dzCols.has(c)) problems.push(`${t}.${c}: in database, missing from Drizzle mirror`);
  for (const c of dzCols.keys()) if (!dbCols.has(c)) problems.push(`${t}.${c}: in Drizzle mirror, missing from database`);
  for (const [c, db] of dbCols) {
    const dz = dzCols.get(c);
    if (!dz) continue;
    columns++;
    if (dz.type !== db.type)           problems.push(`${t}.${c}: type ${dz.type} (Drizzle) vs ${db.type} (database)`);
    if (dz.notNull !== db.notNull)     problems.push(`${t}.${c}: notNull ${dz.notNull} (Drizzle) vs ${db.notNull} (database)`);
    if (dz.hasValue !== db.hasValue)   problems.push(`${t}.${c}: default/generated ${dz.hasValue} (Drizzle) vs ${db.hasValue} (database)`);
    if (dz.generated !== db.generated) problems.push(`${t}.${c}: generated ${dz.generated} (Drizzle) vs ${db.generated} (database)`);
  }
}

if (problems.length) {
  console.error(`    Drizzle mirror DRIFT (${problems.length}):`);
  for (const p of problems) console.error(`      - ${p}`);
  process.exit(1);
}
console.log(`    ok   Drizzle mirror matches the database (${dbTables.size} tables, ${columns} columns)`);
