// ============================================================================
// Staging API checks — runs the built Express API on the CI runner against
// the STAGING Supabase project (never production, never Railway) and drives
// it the way the app will:
//
//   * real users created through the Auth admin API and signed in with a
//     password, so the API verifies genuine Supabase access tokens (JWKS);
//   * real Storage: signed upload URLs, confirmation against the stored
//     object's real size/type, signed download URLs, deletion by the worker;
//   * account deletion through the Auth admin API.
//
// Everything it creates is deleted at the end — also on failure — and the
// script fails if anything is left behind.
//
// Needs: node 22+, psql, a built API (artifacts/api-server/dist).
// Environment (from GitHub secrets, never printed):
//   STAGING_DB_URL, SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, SUPABASE_SECRET_KEY
// ============================================================================
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const need = (k) => {
  const v = process.env[k];
  if (!v) { console.error(`Missing environment variable ${k}`); process.exit(2); }
  return v;
};
const DB_URL  = need('STAGING_DB_URL');
const BASE    = need('SUPABASE_URL').replace(/\/+$/, '');
const PUB_KEY = need('SUPABASE_PUBLISHABLE_KEY');
const SEC_KEY = need('SUPABASE_SECRET_KEY');
const RUN     = process.env.GITHUB_RUN_ID ?? String(Date.now());
const PORT    = 18080;
const API     = `http://127.0.0.1:${PORT}/api`;

const keyHeaders = (key) => (key.startsWith('sb_') ? { apikey: key } : { apikey: key, Authorization: `Bearer ${key}` });
const adminHeaders = keyHeaders(SEC_KEY);
const anonHeaders  = keyHeaders(PUB_KEY);

const sql = (statement) =>
  execFileSync('psql', [DB_URL, '-X', '-A', '-t', '-q', '-v', 'ON_ERROR_STOP=1', '-c', statement],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function http(method, url, { headers = {}, body, raw } = {}) {
  const res = await fetch(url, {
    method,
    headers: { ...headers, ...(body !== undefined && !raw ? { 'Content-Type': 'application/json' } : {}) },
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text, bytes: text.length };
}
const is2xx = (r) => r.status >= 200 && r.status < 300;
const api = (user, method, path, body) =>
  http(method, `${API}${path}`, { headers: user ? { Authorization: `Bearer ${user.token}` } : {}, body });

const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64');
const PDF  = Buffer.from('%PDF-1.4\n%%EOF\n');

const users = {};
const allIds = []; // every test user created, for the final leftover check

async function createUser(name) {
  const email = `driveos-api-${RUN}-${name}@example.com`;
  const password = randomBytes(18).toString('base64url');
  console.log(`::add-mask::${password}`);
  const r = await http('POST', `${BASE}/auth/v1/admin/users`, {
    headers: adminHeaders,
    body: { email, password, email_confirm: true, user_metadata: { display_name: `API ${name}` } },
  });
  if (!is2xx(r) || !r.json?.id) throw new Error(`Auth admin could not create a test user (HTTP ${r.status})`);
  allIds.push(r.json.id);
  const s = await http('POST', `${BASE}/auth/v1/token?grant_type=password`, { headers: anonHeaders, body: { email, password } });
  if (!is2xx(s) || !s.json?.access_token) {
    users[name] = { id: r.json.id, email, token: '' }; // still cleaned up
    throw new Error(`Password sign-in failed for test user ${name} (HTTP ${s.status})`);
  }
  console.log(`::add-mask::${s.json.access_token}`);
  users[name] = { id: r.json.id, email, token: s.json.access_token };
  return users[name];
}

// Uploads bytes to a signed upload URL exactly as the app will.
const putSigned = (uploadUrl, type, bytes) =>
  http('PUT', uploadUrl, { headers: { ...anonHeaders, 'Content-Type': type, 'x-upsert': 'false' }, raw: bytes });

function startApi() {
  const entry = fileURLToPath(new URL('../../../artifacts/api-server/dist/index.mjs', import.meta.url));
  const child = spawn(process.execPath, ['--enable-source-maps', entry], {
    env: {
      PATH: process.env.PATH, NODE_ENV: 'production', PORT: String(PORT), LOG_LEVEL: 'warn',
      DATABASE_URL: DB_URL, DATABASE_POOL_MAX: '5',
      SUPABASE_URL: BASE, SUPABASE_SECRET_KEY: SEC_KEY, STORAGE_WORKER_INTERVAL_MS: '1000',
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  return child;
}

async function waitForApi(child) {
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`API exited with code ${child.exitCode}`);
    try { if ((await fetch(`${API}/healthz`)).ok) return; } catch { /* starting */ }
    await sleep(200);
  }
  throw new Error('API did not start');
}

async function run() {
  const ready = await api(null, 'GET', '/readyz');
  check('API reaches the staging database (TLS, session pooler)', ready.status === 200, `HTTP ${ready.status}`);

  const a = await createUser('a');
  const b = await createUser('b');
  const c = await createUser('c');
  const alg = JSON.parse(Buffer.from(a.token.split('.')[0], 'base64url').toString()).alg;
  check('staging issues asymmetric access tokens (verified via JWKS, no shared secret)', alg === 'ES256' || alg === 'RS256', `alg ${alg}`);

  // ─── Authentication ──────────────────────────────────────────────────────
  const me = await api(a, 'GET', '/me');
  check('a real Supabase access token is accepted', me.status === 200 && me.json?.id === a.id, `HTTP ${me.status}`);
  check('the sign-up trigger profile is served', me.json?.displayName === 'API a' && me.json?.level === 1);
  check('no token → 401', (await api(null, 'GET', '/me')).status === 401);
  check('the publishable key is not a user token → 401',
    (await http('GET', `${API}/me`, { headers: { Authorization: `Bearer ${PUB_KEY}` } })).status === 401);
  const tampered = a.token.slice(0, -4) + (a.token.endsWith('AAAA') ? 'BBBB' : 'AAAA');
  check('a tampered token → 401', (await http('GET', `${API}/me`, { headers: { Authorization: `Bearer ${tampered}` } })).status === 401);
  check('a device UUID (old scheme) → 401', (await http('GET', `${API}/me`, { headers: { Authorization: `Bearer ${a.id}` } })).status === 401);

  // ─── Profile, vehicles, journeys ─────────────────────────────────────────
  const p = await api(a, 'PATCH', '/me', { displayName: 'API a2', xp: 999999 });
  check('profile edit keeps XP server-side', p.status === 200 && p.json?.displayName === 'API a2' && p.json?.xp === 0);

  const v = await api(a, 'POST', '/vehicles', { nickname: 'Staging car', make: 'Mazda', model: 'MX-5' });
  check('create vehicle (first becomes active)', v.status === 201 && v.json?.isActive === true, `HTTP ${v.status}`);
  check("another user cannot edit it", (await api(b, 'PATCH', `/vehicles/${v.json?.id}`, { nickname: 'x' })).status === 404);

  const startedAt = new Date(Date.now() - 20 * 60_000);
  // A time zone where the start isn't 03:00–07:00 local, so Early Bird can't add XP.
  const timezone = ['Europe/London', 'Asia/Tokyo', 'America/New_York'].find((tz) => {
    const h = Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' }).format(startedAt));
    return h < 3 || h >= 7;
  });
  const j = await api(a, 'POST', '/journeys', { startedAt: startedAt.toISOString(), vehicleId: v.json?.id, timezone });
  const points = Array.from({ length: 11 }, (_, i) => ({
    recordedAt: new Date(startedAt.getTime() + (i + 1) * 60_000).toISOString(),
    latitude: 51.5 + i * 0.009, longitude: -0.1, speedKmh: 55, accuracyM: 5, altitudeM: 40,
  }));
  const rp = await api(a, 'POST', `/journeys/${j.json?.id}/route-points`, { points });
  check('route points stored', rp.status === 200 && rp.json?.saved === 11, `HTTP ${rp.status} saved ${rp.json?.saved}`);
  const done = await api(a, 'POST', `/journeys/${j.json?.id}/complete`, { distanceKm: 999 });
  check('journey distance computed on the server', done.status === 200 && done.json?.distanceKm > 9.5 && done.json?.distanceKm < 10.5, `${done.json?.distanceKm} km`);
  check('XP from server distance plus First Drive', (await api(a, 'GET', '/me')).json?.xp === 200);
  check('private journey hidden from others', (await api(b, 'GET', `/journeys/${j.json?.id}`)).status === 404);

  // ─── Friends and convoys ─────────────────────────────────────────────────
  const code = (await api(b, 'GET', '/me')).json?.friendCode;
  const fr = await api(a, 'POST', '/friend-requests', { friendCode: code });
  check('friend request sent', fr.status === 201, `HTTP ${fr.status}`);
  check('a third person cannot accept it', (await api(c, 'POST', `/friend-requests/${fr.json?.id}/accept`)).status === 404);
  check('the recipient accepts it', (await api(b, 'POST', `/friend-requests/${fr.json?.id}/accept`)).status === 200);
  check('friendship exists both ways',
    (await api(a, 'GET', '/friends')).json?.length === 1 && (await api(b, 'GET', '/friends')).json?.length === 1);

  const convoy = await api(a, 'POST', '/convoys', { name: 'Staging convoy', visibility: 'private', startsAt: new Date(Date.now() + 3600_000).toISOString(), maxParticipants: 2 });
  check('private convoy created', convoy.status === 201, `HTTP ${convoy.status}`);
  check('private convoy hidden from a stranger', (await api(c, 'GET', `/convoys/${convoy.json?.id}`)).status === 404);
  const jc = (await api(a, 'POST', `/convoys/${convoy.json?.id}/code`)).json?.code;
  check('join by code', (await api(c, 'POST', '/convoys/join', { code: jc })).status === 200);
  const full = await api(b, 'POST', '/convoys/join', { code: jc });
  check('participant limit enforced', full.status === 409 && full.json?.error === 'convoy_full', `HTTP ${full.status}`);

  // ─── Storage through the API ─────────────────────────────────────────────
  const up = await api(a, 'POST', '/uploads', { kind: 'vehicle-photo', parentId: v.json?.id, sizeBytes: JPEG.length, mimeType: 'image/jpeg' });
  check('signed upload URL issued for a server-chosen path', up.status === 201 && up.json?.path?.startsWith(`${a.id}/${v.json?.id}/`), `HTTP ${up.status}`);
  check('confirm before upload is refused', (await api(a, 'POST', `/uploads/${up.json?.id}/confirm`)).status === 400);
  const put = await putSigned(up.json?.uploadUrl, 'image/jpeg', JPEG);
  check('file uploaded to the signed URL (real Storage)', is2xx(put), `HTTP ${put.status}`);
  const conf = await api(a, 'POST', `/uploads/${up.json?.id}/confirm`);
  check('upload confirmed from the stored object', conf.status === 200 && conf.json?.status === 'ready', `HTTP ${conf.status}`);
  check('a stranger cannot see the photo (private vehicle)', (await api(c, 'GET', `/photos/${up.json?.id}`)).status === 404);
  const ph = await api(a, 'GET', `/photos/${up.json?.id}`);
  const fetched = ph.json?.url ? await http('GET', ph.json.url) : { status: 0 };
  check('owner gets a working signed download URL', ph.status === 200 && fetched.status === 200, `HTTP ${ph.status}/${fetched.status}`);

  const doc = await api(a, 'POST', '/uploads', { kind: 'vehicle-document', parentId: v.json?.id, sizeBytes: PDF.length, mimeType: 'application/pdf', docType: 'insurance' });
  const docPut = await putSigned(doc.json?.uploadUrl, 'application/pdf', PDF);
  const docConf = await api(a, 'POST', `/uploads/${doc.json?.id}/confirm`);
  check('vehicle document uploaded and confirmed', doc.status === 201 && is2xx(docPut) && docConf.status === 200, `HTTP ${doc.status}/${docPut.status}/${docConf.status}`);
  check('a friend cannot get the document link', (await api(b, 'GET', `/documents/${doc.json?.id}/url`)).status === 404);
  const du = await api(a, 'GET', `/documents/${doc.json?.id}/url`);
  const df = du.json?.url ? await http('GET', du.json.url) : { status: 0 };
  check('owner gets a 60-second document link that works', du.status === 200 && du.json?.expiresIn === 60 && df.status === 200, `HTTP ${du.status}/${df.status}`);

  // Deleting the photo queues its file; the worker removes it via the Storage API.
  check('delete photo', (await api(a, 'DELETE', `/photos/${up.json?.id}`)).status === 204);
  let gone = false;
  for (let i = 0; i < 30 && !gone; i++) {
    await sleep(1000);
    gone = sql(`select count(*) from storage.objects where bucket_id = 'vehicle-photos' and name = '${up.json?.path}'`) === '0'
      && sql(`select count(*) from private.storage_delete_queue where path = '${up.json?.path}'`) === '0';
  }
  check('the Storage worker removed the deleted photo\'s file', gone);

  // ─── Account deletion ────────────────────────────────────────────────────
  check('account deletion needs confirmation', (await api(c, 'DELETE', '/me', {})).status === 400);
  const delC = await api(c, 'DELETE', '/me', { confirm: 'DELETE' });
  check('account deleted through the API', delC.status === 204, `HTTP ${delC.status}`);
  const authGone = await http('GET', `${BASE}/auth/v1/admin/users/${c.id}`, { headers: adminHeaders });
  check('the Auth user is gone', authGone.status === 404, `HTTP ${authGone.status}`);
  check('the profile and convoy membership are gone',
    sql(`select (select count(*) from public.profiles where id = '${c.id}') + (select count(*) from public.convoy_participants where user_id = '${c.id}')`) === '0');
  if (delC.status === 204) delete users.c;
}

async function cleanup() {
  const ids = Object.values(users).map((u) => u.id);
  if (!ids.length) return;
  const list = ids.map((id) => `'${id}'`).join(',');
  // Remove files in the test users' folders through the Storage API (SQL deletes are blocked by Supabase).
  const rows = sql(`select bucket_id || '|' || name from storage.objects where split_part(name, '/', 1) in (${list})`);
  const byBucket = {};
  for (const line of rows ? rows.split('\n') : []) {
    const [bucket, name] = line.split('|');
    (byBucket[bucket] ??= []).push(name);
  }
  for (const [bucket, prefixes] of Object.entries(byBucket)) {
    await http('DELETE', `${BASE}/storage/v1/object/${bucket}`, { headers: adminHeaders, body: { prefixes } });
  }
  for (const u of Object.values(users)) {
    await http('DELETE', `${BASE}/auth/v1/admin/users/${u.id}`, { headers: adminHeaders });
  }
  // Give the worker a moment to drain what the deletions queued.
  for (let i = 0; i < 20; i++) {
    if (sql(`select count(*) from private.storage_delete_queue`) === '0') break;
    await sleep(1000);
  }
}

const child = startApi();
let failed = false;
try {
  await waitForApi(child);
  await run();
} catch (err) {
  failed = true;
  console.error(`ERROR: ${err.message}`);
} finally {
  try { await cleanup(); } catch (err) { failed = true; console.error(`Cleanup error: ${err.message}`); }
  child.kill('SIGTERM');
}

const idList = allIds.length ? allIds.map((id) => `'${id}'`).join(',') : `'00000000-0000-0000-0000-000000000000'`;
const leftovers = sql(`
  select (select count(*) from auth.users where email like 'driveos-api-${RUN}-%@example.com')
       + (select count(*) from public.profiles where id in (${idList}))
       + (select count(*) from storage.objects where split_part(name, '/', 1) in (${idList}))
       + (select count(*) from private.storage_delete_queue where split_part(path, '/', 1) in (${idList}))`);
check('nothing left behind (users, profiles, files, delete queue)', leftovers === '0', `${leftovers} leftover rows`);

const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} staging API checks passed`);
if (failed || bad.length) process.exit(1);
