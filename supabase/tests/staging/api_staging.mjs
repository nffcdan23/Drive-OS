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
import { createRequire } from 'node:module';

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
      LIVE_LOCATION_CLEANUP_INTERVAL_MS: '2000',
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

  // ─── Presence (migration 0016) ───────────────────────────────────────────
  const presenceOfA = async (viewer) => (await api(viewer, 'GET', '/friends')).json?.find((f) => f.id === a.id)?.presence;
  const hb = await api(a, 'PUT', '/me/presence', { appState: 'foreground' });
  check('presence: heartbeat accepted', hb.status === 200 && hb.json?.status === 'online', `HTTP ${hb.status} ${hb.json?.status}`);
  check('presence: a friend sees online with a last-active time', (await presenceOfA(b))?.status === 'online' && !!(await presenceOfA(b))?.lastSeenAt);
  check('presence: a stranger has no way to see it', !(await api(c, 'GET', '/friends')).json?.some((f) => f.id === a.id));
  await api(a, 'PUT', '/me/presence', { appState: 'background' });
  check('presence: backgrounded shows as away', (await presenceOfA(b))?.status === 'away');
  const drive = await api(a, 'POST', '/journeys', { clientRef: `presence-${Date.now()}` });
  const driving = await api(a, 'PUT', '/me/presence', { appState: 'foreground', driving: true, journeyId: drive.json?.id });
  check('presence: driving with its journey', driving.status === 200 && driving.json?.journeyId === drive.json?.id, `HTTP ${driving.status}`);
  check('presence: a friend sees driving', (await presenceOfA(b))?.status === 'driving');
  check('presence: someone else\'s journey is refused',
    (await api(b, 'PUT', '/me/presence', { appState: 'foreground', driving: true, journeyId: drive.json?.id })).status === 400);
  await api(a, 'PATCH', '/me/settings', { showActivityStatus: false });
  check('presence: hidden from friends when activity status is off', (await presenceOfA(b)) === null);
  check('presence: the owner still sees their own', (await api(a, 'GET', '/me/presence')).json?.status === 'driving');
  await api(a, 'PATCH', '/me/settings', { showActivityStatus: true });
  await api(a, 'PUT', '/me/presence', { appState: 'signed_out' });
  check('presence: signed out shows offline', (await presenceOfA(b))?.status === 'offline');

  // ─── Live presence over Supabase Realtime (migration 0017) ────────────────
  await liveInboxChecks(a, b, c);

  const convoy = await api(a, 'POST', '/convoys', { name: 'Staging convoy', visibility: 'private', startsAt: new Date(Date.now() + 3600_000).toISOString(), maxParticipants: 2 });
  check('private convoy created', convoy.status === 201, `HTTP ${convoy.status}`);
  check('private convoy hidden from a stranger', (await api(c, 'GET', `/convoys/${convoy.json?.id}`)).status === 404);
  const jc = (await api(a, 'POST', `/convoys/${convoy.json?.id}/code`)).json?.code;
  check('join by code', (await api(c, 'POST', '/convoys/join', { code: jc })).status === 200);
  const full = await api(b, 'POST', '/convoys/join', { code: jc });
  check('participant limit enforced', full.status === 409 && full.json?.error === 'convoy_full', `HTTP ${full.status}`);

  // Live location with a Convoy: only when turned on for it, only for its members
  await api(a, 'PATCH', '/me/location-sharing', { mode: 'while_using' });
  await api(a, 'PUT', '/me/presence', { appState: 'foreground' });
  await api(a, 'PUT', '/me/live-location', { latitude: 51.5, longitude: -0.1 });
  const seesA = async (u) => ((await api(u, 'GET', '/live-locations')).json ?? []).some((l) => l.userId === a.id);
  check('live location: joining a Convoy shares nothing by itself', !(await seesA(c)));
  const conv = await api(a, 'PUT', `/me/location-sharing/convoys/${convoy.json?.id}`);
  check('live location: shared with a private Convoy', conv.status === 200, `HTTP ${conv.status}`);
  check('live location: its member sees it', await seesA(c));
  check('live location: a non-member friend does not', !(await seesA(b)));
  await api(a, 'DELETE', `/me/location-sharing/convoys/${convoy.json?.id}`);
  check('live location: turning the Convoy off ends it', !(await seesA(c)));
  await api(a, 'PATCH', '/me/location-sharing', { mode: 'off' });

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

  // Live-location broadcasts carry positions; the API deletes them from
  // realtime.messages a minute after sending (no trail of positions kept).
  const testInboxes = Object.values(users).map((u) => `'inbox:${u.id}'`).join(',');
  const liveMessages = () => sql(`select count(*) from realtime.messages where event = 'live_location' and topic in (${testInboxes})`);
  const sentLive = liveMessages();
  let purgedLive = false;
  for (let i = 0; i < 50 && !purgedLive; i++) {
    purgedLive = liveMessages() === '0';
    if (!purgedLive) await sleep(2000);
  }
  check('live location: delivered messages are removed from realtime.messages', sentLive !== '0' && purgedLive,
    `${sentLive} sent, ${liveMessages()} left`);

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

// Real Supabase Realtime, as the app uses it: private inbox channels.
async function liveInboxChecks(a, b, c) {
  const { createClient } = createRequire(new URL('../../../artifacts/mobile/package.json', import.meta.url))('@supabase/supabase-js');
  const clients = [];
  const join = async (user, topic) => {
    const client = createClient(BASE, PUB_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    clients.push(client);
    await client.realtime.setAuth(user.token);
    const received = [];
    const status = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve('NO_ANSWER'), 15_000);
      client.channel(topic, { config: { private: true } })
        .on('broadcast', { event: 'presence' }, (m) => received.push(m.payload))
        .on('broadcast', { event: 'live_location' }, (m) => received.push(m.payload))
        .subscribe((s) => { if (s !== 'CLOSED') { clearTimeout(timer); resolve(s); } });
    });
    return { status, received };
  };
  const waitFor = async (list, test, ms = 15_000) => {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(250)) if (list.some(test)) return true;
    return false;
  };
  // Read-only: Realtime stores broadcasts in realtime.messages, partitioned
  // by day; it creates the partitions itself once the project's Realtime is
  // in use. Without today's partition, joins and broadcasts fail.
  const partitions = sql(`select coalesce(string_agg(c.relname, ', ' order by c.relname), 'none')
    from pg_inherits i join pg_class c on c.oid = i.inhrelid where i.inhparent = 'realtime.messages'::regclass`);
  const today = sql(`select exists (select 1 from pg_inherits i join pg_class c on c.oid = i.inhrelid
    where i.inhparent = 'realtime.messages'::regclass
      and c.relname = 'messages_' || to_char((now() at time zone 'utc')::date, 'YYYY_MM_DD'))`);
  console.log(`     realtime.messages partitions: ${partitions}`);
  check('realtime: today\'s realtime.messages partition exists', today === 't', partitions);
  try {
    let inboxB = await join(b, `inbox:${b.id}`);
    if (inboxB.status !== 'SUBSCRIBED') {
      // The first connection to a project's Realtime may still be setting it up
      console.log(`     own inbox: ${inboxB.status} on the first try; retrying in 10 s`);
      await sleep(10_000);
      inboxB = await join(b, `inbox:${b.id}`);
    }
    check('realtime: a user can join their own private inbox', inboxB.status === 'SUBSCRIBED', inboxB.status);
    const spy = await join(c, `inbox:${b.id}`);
    check('realtime: a stranger cannot join someone else\'s inbox', spy.status !== 'SUBSCRIBED', spy.status);
    await api(b, 'PUT', '/me/presence', { appState: 'foreground' }); // B has the app open
    await api(a, 'PUT', '/me/presence', { appState: 'foreground', driving: true });
    check('realtime: the friend receives Driving live',
      await waitFor(inboxB.received, (p) => p.userId === a.id && p.status === 'driving'));
    await api(a, 'PUT', '/me/presence', { appState: 'foreground', driving: false });
    check('realtime: and Online when the drive ends',
      await waitFor(inboxB.received, (p) => p.userId === a.id && p.status === 'online'));
    await api(a, 'PATCH', '/me/settings', { showActivityStatus: false });
    check('realtime: hiding activity is pushed at once',
      await waitFor(inboxB.received, (p) => p.userId === a.id && p.type === 'hidden'));
    await api(a, 'PATCH', '/me/settings', { showActivityStatus: true });

    // ─── Private live location (migration 0018) ──────────────────────────
    const sharing = await api(a, 'PATCH', '/me/location-sharing', { mode: 'while_driving', friendAudience: 'selected' });
    check('live location: sharing settings saved', sharing.status === 200 && sharing.json?.sharingWithCount === 0, `HTTP ${sharing.status}`);
    const chosen = await api(a, 'PUT', `/me/location-sharing/friends/${b.id}`);
    check('live location: a friend chosen', chosen.status === 200 && chosen.json?.sharingWithCount === 1, `HTTP ${chosen.status}`);
    check('live location: a stranger cannot be chosen', (await api(a, 'PUT', `/me/location-sharing/friends/${c.id}`)).status === 404);
    await api(a, 'PUT', '/me/presence', { appState: 'foreground', driving: true });
    const pub = await api(a, 'PUT', '/me/live-location', { latitude: 51.50101, longitude: -0.14189, speedMps: 12, headingDeg: 90, accuracyM: 8 });
    check('live location: published while driving', pub.status === 200 && pub.json?.driving === true, `HTTP ${pub.status}`);
    check('live location: the chosen friend receives it live',
      await waitFor(inboxB.received, (p) => p.userId === a.id && p.type === 'live_location' && p.latitude === 51.50101));
    const snapB = (await api(b, 'GET', '/live-locations')).json ?? [];
    check('live location: and in their snapshot', snapB.some((l) => l.userId === a.id));
    check('live location: a stranger\'s snapshot does not include it', !((await api(c, 'GET', '/live-locations')).json ?? []).some((l) => l.userId === a.id));
    check('live location: no per-user lookup exists', (await api(c, 'GET', `/users/${a.id}/live-location`)).status === 404);
    await api(a, 'DELETE', `/me/location-sharing/friends/${b.id}`);
    check('live location: removing the friend tells them to drop it at once',
      await waitFor(inboxB.received, (p) => p.userId === a.id && p.type === 'live_location_hidden'));
    check('live location: and it is gone from their snapshot', !((await api(b, 'GET', '/live-locations')).json ?? []).some((l) => l.userId === a.id));
    await api(a, 'PATCH', '/me/location-sharing', { mode: 'off', friendAudience: 'none' });
    await api(a, 'PUT', '/me/presence', { appState: 'foreground', driving: false });
    check('live location: nothing is stored once sharing is off',
      sql(`select count(*) from public.live_locations where user_id = '${a.id}'`) === '0');
    check('realtime: the stranger received nothing', spy.received.length === 0, `${spy.received.length} messages`);
  } finally {
    for (const client of clients) await client.removeAllChannels().catch(() => {});
  }
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
       + (select count(*) from private.storage_delete_queue where split_part(path, '/', 1) in (${idList}))
       + (select count(*) from public.live_locations where user_id in (${idList}))
       + (select count(*) from public.location_share_friends where owner_id in (${idList}) or friend_id in (${idList}))`);
check('nothing left behind (users, profiles, files, delete queue, live locations)', leftovers === '0', `${leftovers} leftover rows`);

const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} staging API checks passed`);
if (failed || bad.length) process.exit(1);
