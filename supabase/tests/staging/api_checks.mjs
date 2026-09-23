// ============================================================================
// Staging live checks — exercises the REAL Supabase Auth, Data API and
// Storage API of the staging project (never production).
//
//   1. Creates two throwaway users through the Auth admin API, so the sign-up
//      trigger runs exactly as it will for real sign-ups, and checks their
//      profile and settings rows were created.
//   2. Signs them in and checks the Data API exposes nothing (no table or
//      function is reachable with a user token or the publishable key).
//   3. Checks Storage policies end to end through the Storage API: folder
//      ownership on upload, public avatars, photo visibility following the
//      vehicle, owner-only documents, anonymous uploads refused.
//   4. Deletes everything it created (files, rows, users) — also on failure —
//      and checks that deleting a user removes their profile.
//
// Needs: node 22+, psql. Environment (from GitHub secrets, never printed):
//   STAGING_DB_URL, SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, SUPABASE_SECRET_KEY
// ============================================================================
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const need = (k) => {
  const v = process.env[k];
  if (!v) { console.error(`Missing environment variable ${k}`); process.exit(2); }
  return v;
};
const DB_URL   = need('STAGING_DB_URL');
const BASE     = need('SUPABASE_URL').replace(/\/+$/, '');
const PUB_KEY  = need('SUPABASE_PUBLISHABLE_KEY');
const SEC_KEY  = need('SUPABASE_SECRET_KEY');
const RUN      = process.env.GITHUB_RUN_ID ?? String(Date.now());

// New-style keys (sb_publishable_ / sb_secret_) go only in `apikey`; legacy
// JWT keys (anon / service_role) also go in Authorization.
const keyHeaders = (key) => (key.startsWith('sb_') ? { apikey: key } : { apikey: key, Authorization: `Bearer ${key}` });
const userHeaders = (token) => ({ apikey: PUB_KEY, Authorization: `Bearer ${token}` });
const adminHeaders = keyHeaders(SEC_KEY);
const anonHeaders  = keyHeaders(PUB_KEY);

// Runs one SQL statement as the database owner; returns trimmed text output.
const sql = (statement) =>
  execFileSync('psql', [DB_URL, '-X', '-A', '-t', '-q', '-v', 'ON_ERROR_STOP=1', '-c', statement],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

async function http(method, path, { headers = {}, body, raw } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...headers, ...(body !== undefined && !raw ? { 'Content-Type': 'application/json' } : {}) },
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text };
}
const is2xx = (r) => r.status >= 200 && r.status < 300;

// 1x1 JPEG and a tiny PDF: Storage checks the declared content type against
// the bucket's allow-list, not the bytes.
const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64');
const PDF  = Buffer.from('%PDF-1.4\n%%EOF\n');

const upload = (token, bucket, path, type, bytes) =>
  http('POST', `/storage/v1/object/${bucket}/${path}`, {
    headers: { ...(token ? userHeaders(token) : anonHeaders), 'Content-Type': type, 'x-upsert': 'false' },
    raw: bytes,
  });
const download = (token, bucket, path) =>
  http('GET', `/storage/v1/object/authenticated/${bucket}/${path}`, { headers: userHeaders(token) });

const users = {};           // name -> { id, email, password, token }
const createdFiles = [];    // [bucket, path]

async function createUser(name) {
  const email = `driveos-staging-${RUN}-${name}@example.com`;
  const password = randomBytes(18).toString('base64url');
  console.log(`::add-mask::${password}`);
  const r = await http('POST', '/auth/v1/admin/users', {
    headers: adminHeaders,
    body: { email, password, email_confirm: true, user_metadata: { display_name: `Staging ${name}` } },
  });
  if (!is2xx(r) || !r.json?.id) throw new Error(`Auth admin could not create a test user (HTTP ${r.status}: ${r.json?.msg ?? r.json?.message ?? r.text.slice(0, 200)})`);
  users[name] = { id: r.json.id, email, password };
  return users[name];
}

async function signIn(name) {
  const u = users[name];
  const r = await http('POST', '/auth/v1/token?grant_type=password', { headers: anonHeaders, body: { email: u.email, password: u.password } });
  if (!is2xx(r) || !r.json?.access_token) throw new Error(`Password sign-in failed for test user ${name} (HTTP ${r.status})`);
  console.log(`::add-mask::${r.json.access_token}`);
  u.token = r.json.access_token;
}

async function run() {
  // ─── 1. Sign-up trigger through the real Auth service ─────────────────────
  const a = await createUser('a');
  const b = await createUser('b');
  const prof = sql(`select display_name || '|' || (friend_code ~ '^[A-Z0-9]{8}$') || '|' || level
                    from public.profiles where id = '${a.id}'`);
  check('sign-up trigger creates the profile (via real Supabase Auth)', prof === 'Staging a|true|1', prof || 'no profile row');
  check('sign-up trigger creates the settings row',
    sql(`select count(*) from public.user_settings where user_id in ('${a.id}', '${b.id}')`) === '2');

  await signIn('a');
  await signIn('b');
  const payload = JSON.parse(Buffer.from(users.a.token.split('.')[1], 'base64url').toString());
  check('Auth issues tokens for the authenticated role with the user id', payload.role === 'authenticated' && payload.sub === a.id);

  // ─── 2. Data API exposes nothing yet ──────────────────────────────────────
  for (const table of ['profiles', 'user_settings', 'vehicles', 'vehicle_documents', 'journeys', 'journey_route_points', 'saved_locations', 'notifications']) {
    const asUser = await http('GET', `/rest/v1/${table}?select=*&limit=1`, { headers: userHeaders(users.a.token) });
    const asAnon = await http('GET', `/rest/v1/${table}?select=*&limit=1`, { headers: anonHeaders });
    check(`Data API: ${table} not readable by a signed-in user`, !is2xx(asUser), `HTTP ${asUser.status} ${asUser.json?.code ?? ''}`.trim());
    check(`Data API: ${table} not readable anonymously`, !is2xx(asAnon), `HTTP ${asAnon.status} ${asAnon.json?.code ?? ''}`.trim());
  }
  const write = await http('POST', '/rest/v1/vehicles', { headers: userHeaders(users.a.token), body: { owner_id: a.id, nickname: 'x' } });
  check('Data API: a signed-in user cannot insert', !is2xx(write), `HTTP ${write.status} ${write.json?.code ?? ''}`.trim());
  const rpc = await http('POST', '/rest/v1/rpc/nearby_spots', { headers: userHeaders(users.a.token), body: { p_lat: 54.46, p_lng: -3.09 } });
  check('Data API: Beauty Spot functions not callable yet', !is2xx(rpc), `HTTP ${rpc.status} ${rpc.json?.code ?? ''}`.trim());
  const priv = await http('GET', '/rest/v1/join_codes?select=*', { headers: { ...userHeaders(users.a.token), 'Accept-Profile': 'private' } });
  check('Data API: the private schema is not exposed', !is2xx(priv), `HTTP ${priv.status}`);

  // ─── 3. Storage policies through the real Storage API ─────────────────────
  const avatar = `${a.id}/probe-${RUN}.jpg`;
  let r = await upload(users.a.token, 'avatars', avatar, 'image/jpeg', JPEG);
  if (is2xx(r)) createdFiles.push(['avatars', avatar]);
  check('Storage: a user can upload their own avatar', is2xx(r), `HTTP ${r.status}`);
  r = await http('GET', `/storage/v1/object/public/avatars/${avatar}`);
  check('Storage: avatars are served publicly', is2xx(r), `HTTP ${r.status}`);
  r = await upload(users.b.token, 'avatars', `${a.id}/evil-${RUN}.jpg`, 'image/jpeg', JPEG);
  check('Storage: a user cannot upload into someone else\'s avatar folder', !is2xx(r), `HTTP ${r.status}`);
  r = await upload(null, 'avatars', `anon-${RUN}.jpg`, 'image/jpeg', JPEG);
  check('Storage: anonymous uploads are refused', !is2xx(r), `HTTP ${r.status}`);
  r = await upload(users.a.token, 'avatars', `${a.id}/not-an-image-${RUN}.pdf`, 'application/pdf', PDF);
  check('Storage: bucket file-type limits are enforced', !is2xx(r), `HTTP ${r.status}`);

  const vehicleId = sql(`insert into public.vehicles (owner_id, nickname, visibility)
                         values ('${a.id}', 'Staging probe', 'public') returning id`);
  const photo = `${a.id}/${vehicleId}/probe-${RUN}.jpg`;
  r = await upload(users.a.token, 'vehicle-photos', photo, 'image/jpeg', JPEG);
  if (is2xx(r)) createdFiles.push(['vehicle-photos', photo]);
  check('Storage: a user can upload into their own photo folder', is2xx(r), `HTTP ${r.status}`);
  r = await upload(users.a.token, 'vehicle-photos', `${b.id}/x/probe-${RUN}.jpg`, 'image/jpeg', JPEG);
  check('Storage: a user cannot upload into someone else\'s photo folder', !is2xx(r), `HTTP ${r.status}`);

  r = await download(users.b.token, 'vehicle-photos', photo);
  check('Storage: a file with no metadata row is not readable by others', !is2xx(r), `HTTP ${r.status}`);
  sql(`insert into public.photos (owner_id, vehicle_id, bucket, storage_path, mime_type, size_bytes, status)
       values ('${a.id}', '${vehicleId}', 'vehicle-photos', '${photo}', 'image/jpeg', ${JPEG.length}, 'ready')`);
  r = await download(users.b.token, 'vehicle-photos', photo);
  check('Storage: another user can read a ready photo of a public vehicle', is2xx(r), `HTTP ${r.status}`);
  sql(`update public.vehicles set visibility = 'private' where id = '${vehicleId}'`);
  r = await download(users.b.token, 'vehicle-photos', photo);
  check('Storage: making the vehicle private hides its photo file from others', !is2xx(r), `HTTP ${r.status}`);
  r = await download(users.a.token, 'vehicle-photos', photo);
  check('Storage: the owner can still read their private vehicle photo', is2xx(r), `HTTP ${r.status}`);

  const doc = `${a.id}/${vehicleId}/doc-${RUN}.pdf`;
  r = await upload(users.a.token, 'vehicle-documents', doc, 'application/pdf', PDF);
  if (is2xx(r)) createdFiles.push(['vehicle-documents', doc]);
  check('Storage: a user can upload their own vehicle document', is2xx(r), `HTTP ${r.status}`);
  sql(`insert into public.vehicle_documents (vehicle_id, owner_id, doc_type, storage_path, mime_type, size_bytes, status)
       values ('${vehicleId}', '${a.id}', 'v5c', '${doc}', 'application/pdf', ${PDF.length}, 'ready')`);
  r = await download(users.a.token, 'vehicle-documents', doc);
  check('Storage: the owner can read their document', is2xx(r), `HTTP ${r.status}`);
  r = await download(users.b.token, 'vehicle-documents', doc);
  check('Storage: another user cannot read the document', !is2xx(r), `HTTP ${r.status}`);
  r = await http('GET', `/storage/v1/object/public/vehicle-documents/${doc}`);
  check('Storage: documents have no public URL', !is2xx(r), `HTTP ${r.status}`);
}

async function cleanup() {
  console.log('--- cleanup');
  const byBucket = {};
  for (const [bucket, path] of createdFiles) (byBucket[bucket] ??= []).push(path);
  for (const [bucket, prefixes] of Object.entries(byBucket)) {
    const r = await http('DELETE', `/storage/v1/object/${bucket}`, { headers: adminHeaders, body: { prefixes } });
    check(`cleanup: removed ${prefixes.length} test file(s) from ${bucket}`, is2xx(r), `HTTP ${r.status}`);
  }
  const ids = Object.values(users).map((u) => `'${u.id}'`);
  if (ids.length) {
    // Deleting the user cascades to all their rows; the Storage queue rows the
    // cascade creates refer only to the files removed above.
    for (const u of Object.values(users)) {
      const r = await http('DELETE', `/auth/v1/admin/users/${u.id}`, { headers: adminHeaders });
      check(`cleanup: deleted test user`, is2xx(r), `HTTP ${r.status}`);
    }
    check('deleting a user through Auth removes their profile and data',
      sql(`select (select count(*) from public.profiles where id in (${ids}))
                + (select count(*) from public.vehicles where owner_id in (${ids}))`) === '0');
    sql(`delete from private.storage_delete_queue where ${ids.map((id) => `path like ${id.slice(0, -1)}/%'`).join(' or ')}`);
  }
}

let fatal = null;
try {
  await run();
} catch (err) {
  fatal = err;
  console.log(`FAIL stopped early: ${err.message}`);
} finally {
  try { await cleanup(); } catch (err) { console.log(`FAIL cleanup: ${err.message}`); fatal ??= err; }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} live checks passed`);
process.exit(fatal || failed.length ? 1 : 0);
