// ============================================================================
// Phase 5 end-to-end checks against STAGING (never production, never Railway).
//
// Drives the app's own data layer — the same auth, CloudSync, outbox,
// journey recorder and upload code the app runs — against real Supabase
// Auth and Storage and the DriveOS API (started on the CI runner against the
// staging database). "Devices" are separate storage areas, so restarts,
// reinstalls and second phones are simulated faithfully.
//
// Everything created is deleted at the end, also on failure.
//
// Env (GitHub secrets, never printed): STAGING_DB_URL, SUPABASE_URL,
//   SUPABASE_PUBLISHABLE_KEY, SUPABASE_SECRET_KEY
// Run: node --experimental-transform-types --import ./test/register.mjs test/staging-e2e.ts
// ============================================================================
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createAuthClient, signInWithEmail, signUpWithEmail, type SupabaseClient } from '@/lib/backend/auth';
import { ApiClient, ApiError, AuthRequiredError, type ConnectionState } from '@/lib/backend/http';
import { endpoints, type Endpoints } from '@/lib/backend/endpoints';
import { CloudSync } from '@/lib/backend/cloudSync';
import { MemoryStore, LEGACY_KEYS } from '@/lib/backend/storage';
import type { Vehicle } from '@/lib/backend/model';

const need = (k: string) => {
  const v = process.env[k];
  if (!v) { console.error(`Missing environment variable ${k}`); process.exit(2); }
  return v;
};
const DB_URL = need('STAGING_DB_URL');
const BASE = need('SUPABASE_URL').replace(/\/+$/, '');
const PUB_KEY = need('SUPABASE_PUBLISHABLE_KEY');
const SEC_KEY = need('SUPABASE_SECRET_KEY');
const RUN = process.env.GITHUB_RUN_ID ?? String(Date.now());
// Domain for sign-up test addresses. Only used when staging auto-confirms
// sign-ups, so no email is ever sent to it. Override with the repository
// variable STAGING_SIGNUP_EMAIL_DOMAIN if Supabase rejects the default.
const SIGNUP_DOMAIN = process.env.SIGNUP_TEST_EMAIL_DOMAIN || 'example.com';
const PORT = 18090;
const API_URL = `http://127.0.0.1:${PORT}`;

const adminHeaders: Record<string, string> = SEC_KEY.startsWith('sb_') ? { apikey: SEC_KEY } : { apikey: SEC_KEY, Authorization: `Bearer ${SEC_KEY}` };
const sql = (q: string) => execFileSync('psql', [DB_URL, '-X', '-A', '-t', '-q', '-v', 'ON_ERROR_STOP=1', '-c', q], { encoding: 'utf8' }).trim();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
function check(name: string, ok: unknown, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}
function section(title: string) { console.log(`\n── ${title}`); }

// 1x1 JPEG
const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64');

/** One simulated phone: its own secure store, Supabase client, API client and CloudSync. */
interface Device {
  name: string;
  store: MemoryStore;
  auth: SupabaseClient;
  api: ApiClient;
  ep: Endpoints;
  connection: ConnectionState | 'unknown';
  /** Simulated network failures for this phone. */
  network: 'up' | 'offline' | 'server-error';
  sync?: CloudSync;
}

function device(name: string, store = new MemoryStore()): Device {
  const d = { name, store, connection: 'unknown', network: 'up' } as Device;
  d.auth = createAuthClient({ url: BASE, publishableKey: PUB_KEY, storage: store });
  d.api = new ApiClient({
    baseUrl: API_URL,
    getAccessToken: async () => (await d.auth.auth.getSession()).data.session?.access_token ?? null,
    refreshAccessToken: async () => (await d.auth.auth.refreshSession()).data.session?.access_token ?? null,
    onStatus: (s, detail) => { d.connection = s; d.sync?.reportConnection(s, detail); },
    fetchImpl: (async (url: string, init?: RequestInit) => {
      if (d.network === 'offline') throw new TypeError('Network request failed');
      if (d.network === 'server-error') return new Response('{"error":"internal_error","message":"Something went wrong."}', { status: 503 });
      return fetch(url, init);
    }) as typeof fetch,
  });
  d.ep = endpoints(d.api);
  return d;
}

function cloud(d: Device, userId: string, clock?: { t: number }): CloudSync {
  d.sync?.dispose();
  d.sync = new CloudSync({
    ep: d.ep, store: d.store, userId, publishableKey: PUB_KEY, newId: () => randomUUID(), timezone: () => 'Europe/London',
    ...(clock ? { now: () => clock.t } : {}),
    prepareFile: async () => ({ body: JPEG, size: JPEG.length, mimeType: 'image/jpeg' }),
  });
  return d.sync;
}

const createdUsers = new Set<string>();

async function adminCreate(email: string, password: string, name: string): Promise<string> {
  const r = await fetch(`${BASE}/auth/v1/admin/users`, {
    method: 'POST', headers: { ...adminHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { display_name: name } }),
  });
  const j = await r.json() as { id?: string };
  if (!r.ok || !j.id) throw new Error(`Auth admin could not create a test user (HTTP ${r.status})`);
  createdUsers.add(j.id);
  return j.id;
}

function startApi(): ChildProcess {
  const entry = fileURLToPath(new URL('../../api-server/dist/index.mjs', import.meta.url));
  return spawn(process.execPath, ['--enable-source-maps', entry], {
    env: {
      PATH: process.env.PATH, NODE_ENV: 'production', PORT: String(PORT), LOG_LEVEL: 'warn',
      DATABASE_URL: DB_URL, SUPABASE_URL: BASE, SUPABASE_SECRET_KEY: SEC_KEY, STORAGE_WORKER_INTERVAL_MS: '1000',
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
}

async function waitForApi(child: ChildProcess) {
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`API exited with code ${child.exitCode}`);
    try { if ((await fetch(`${API_URL}/api/healthz`)).ok) return; } catch { /* starting */ }
    await sleep(200);
  }
  throw new Error('API did not start');
}

async function run() {
  // ─── Staging Auth configuration (what the app can use) ───────────────────
  section('Staging Auth providers');
  const settings = await (await fetch(`${BASE}/auth/v1/settings`, { headers: { apikey: PUB_KEY } })).json() as {
    external?: Record<string, boolean>; mailer_autoconfirm?: boolean; disable_signup?: boolean;
  };
  const ext = settings.external ?? {};
  console.log(`     email: ${ext.email ? 'on' : 'off'} · Apple: ${ext.apple ? 'on' : 'off'} · Google: ${ext.google ? 'on' : 'off'} · ` +
    `email confirmation: ${settings.mailer_autoconfirm ? 'off (auto-confirm)' : 'required'} · sign-ups: ${settings.disable_signup ? 'disabled' : 'allowed'}`);
  check('email + password sign-in is enabled on staging', ext.email === true);

  let email = `driveos-mobile-${RUN}-a@${SIGNUP_DOMAIN}`;
  const password = randomBytes(18).toString('base64url');
  console.log(`::add-mask::${password}`);

  // ─── 1. Create an email + password account ───────────────────────────────
  section('1. Create an email/password account');
  const phone1 = device('phone 1');
  let userA: string | null = null;
  if (!settings.mailer_autoconfirm) {
    // With confirmation on and Supabase's built-in mailer, a sign-up needs a
    // deliverable address the mailer is allowed to send to, so a throwaway
    // test account can't be created without emailing someone. Not attempted.
    check('sign-up through the app (staging config)', false,
      'staging requires email confirmation — turn off "Confirm email" for the staging project (Auth → Providers → Email), or add custom SMTP');
  } else if (settings.disable_signup) {
    check('sign-up through the app (staging config)', false, 'sign-ups are disabled on staging (Auth → Providers → Email → Allow new users)');
  } else {
    try {
      const r = await signUpWithEmail(phone1.auth, email, password, 'driveos-staging://auth/callback', 'Mobile Tester');
      userA = r.userId;
      if (userA) createdUsers.add(userA);
      check('sign-up through the app creates a signed-in account', !!userA && !r.needsConfirmation && !!r.session,
        r.needsConfirmation ? 'unexpected: confirmation still required' : 'signed in immediately');
      const again = await signUpWithEmail(device('same address').auth, email, password, 'driveos-staging://auth/callback').catch((e) => e);
      check('signing up twice with the same email is refused', again instanceof Error, again instanceof Error ? again.message : 'accepted');
    } catch (err) {
      const msg = (err as Error).message;
      check('sign-up through the app creates a signed-in account', false,
        /invalid/i.test(msg) ? `${msg} — set the repository variable STAGING_SIGNUP_EMAIL_DOMAIN to a domain you control` : msg);
    }
  }
  if (!userA) {
    // Carry on with the other scenarios using an account made by the admin API.
    email = `driveos-mobile-${RUN}-a@example.com`;
    userA = await adminCreate(email, password, 'Mobile Tester');
    await signInWithEmail(phone1.auth, email, password);
  }
  const me = await phone1.ep.getMe();
  check('the new account has a cloud profile (sign-up trigger)', me.id === userA && me.displayName === 'Mobile Tester', me.displayName);

  // ─── 2–4. Sign out, sign in, session survives restart ────────────────────
  section('2. Sign out');
  await phone1.auth.auth.signOut({ scope: 'local' });
  check('no session is left on the phone after sign-out', !(await phone1.auth.auth.getSession()).data.session);
  const afterSignOut = await phone1.ep.getMe().catch((e) => e);
  check('the app cannot call the API while signed out', afterSignOut instanceof AuthRequiredError);

  section('3. Sign back in');
  await signInWithEmail(phone1.auth, email, password);
  check('signed in again with email + password', (await phone1.ep.getMe()).id === userA);
  const wrong = await signInWithEmail(phone1.auth, email, 'wrong-password').catch((e) => e);
  check('a wrong password is refused', wrong instanceof Error);
  await signInWithEmail(phone1.auth, email, password);

  section('4. Session survives an app restart');
  const phone1b = device('phone 1 after restart', phone1.store); // same secure storage, new process
  const restored = (await phone1b.auth.auth.getSession()).data.session;
  check('session restored from secure storage', restored?.user.id === userA);
  const refreshed = await phone1b.auth.auth.refreshSession();
  check('refresh token works after restart', !!refreshed.data.session && !refreshed.error);
  check('API accepts the restored session', (await phone1b.ep.getMe()).id === userA);
  const p1 = phone1b; // continue as the restarted app

  // ─── 5. Profile persists ─────────────────────────────────────────────────
  section('5. Profile persists');
  let app = cloud(p1, userA);
  await app.start();
  await app.sync();
  await app.updateProfile({ name: 'Alex Driver', bio: 'Weekend B-roads' });
  await app.outbox.flush();
  const fresh = device('fresh install');
  await signInWithEmail(fresh.auth, email, password);
  const freshApp = cloud(fresh, userA);
  await freshApp.start();
  await freshApp.refresh();
  check('profile edits are stored in the cloud', freshApp.data.profile.name === 'Alex Driver' && freshApp.data.profile.bio === 'Weekend B-roads', freshApp.data.profile.name);
  check('level and XP come from the server', freshApp.data.profile.level === 1 && freshApp.data.profile.xp === 0);
  freshApp.dispose();

  // ─── 6–8. Vehicles and photos ────────────────────────────────────────────
  section('6. Add a vehicle');
  const vehicleInput: Omit<Vehicle, 'id'> = {
    nickname: 'Test MX-5', registration: 'AB12CDE', make: 'Mazda', model: 'MX-5', year: 2019, colour: 'Red', fuelType: 'petrol',
    engine: '2.0L', power: '184 PS', torque: '', zeroToSixty: '', topSpeed: '', mileage: 12000, fuelPercentage: 0, imageUri: null, isActive: false,
  };
  const localId = await app.addVehicle(vehicleInput);
  await app.outbox.flush();
  const vehicle = app.data.vehicles.find((v) => v.nickname === 'Test MX-5');
  check('vehicle saved to the account', !!vehicle && !vehicle.id.startsWith('local:') && app.status.pendingChanges === 0, `${localId} → ${vehicle?.id}`);
  check('first vehicle is the active one', vehicle?.isActive === true);
  const vehicleId = vehicle!.id;
  await app.writeCache();

  section('7. Restart: vehicle remains');
  app.dispose();
  app = cloud(p1, userA);
  await app.start();
  check('vehicle shown from the phone cache straight after restart', app.data.vehicles.some((v) => v.id === vehicleId));
  await app.refresh();
  check('vehicle still there after refreshing from the server', app.data.vehicles.some((v) => v.id === vehicleId));

  section('8. Upload a vehicle photo');
  await app.updateVehicle(vehicleId, { imageUri: 'file:///data/photo.jpg' });
  await app.outbox.flush();
  const withPhoto = app.data.vehicles.find((v) => v.id === vehicleId);
  check('photo uploaded to Storage and set as the cover', !!withPhoto?.imageUri?.startsWith(BASE) && app.status.rejected.length === 0, app.status.rejected[0]?.message ?? '');
  const img = withPhoto?.imageUri ? await fetch(withPhoto.imageUri) : null;
  check('the cover photo URL downloads the image', img?.status === 200, `HTTP ${img?.status}`);

  // ─── 9–10. Saved places & Beauty Spots ───────────────────────────────────
  section('9. Save a location');
  const homeLocal = await app.addPlace({ kind: 'home', name: 'Home', coordinate: { latitude: 51.5007, longitude: -0.1246 }, visibility: 'public' });
  await app.outbox.flush();
  const home = app.data.places.find((p) => p.kind === 'home');
  check('Home saved to the account', !!home && !home.id.startsWith('local:'), `${homeLocal} → ${home?.id}`);
  check('Home is private even when asked to be public', home?.visibility === 'private');

  section('10. Create a Beauty Spot');
  await app.addPlace({ kind: 'beauty_spot', name: 'Staging Viewpoint', category: 'viewpoint', visibility: 'public', description: 'Test spot', coordinate: { latitude: 54.4609, longitude: -3.0886 } });
  await app.outbox.flush();
  const spot = app.data.places.find((p) => p.kind === 'beauty_spot');
  check('Beauty Spot saved as public', !!spot && !spot.id.startsWith('local:') && spot.visibility === 'public');

  // ─── 11–12. Record a journey ─────────────────────────────────────────────
  section('11. Record a journey');
  const clock = { t: Date.now() - 12 * 60_000 };
  app.dispose();
  app = cloud(p1, userA, clock);
  await app.start();
  await app.refresh();
  await app.startDrive(app.data.vehicles.find((v) => v.id === vehicleId)!);
  let lat = 54.40, lng = -3.10, kept = 0;
  const FIXES = 540;
  for (let s = 0; s < FIXES; s++) {
    clock.t += 1000;
    if (app.addFix({ latitude: lat, longitude: lng, speedMs: 15, headingDeg: 0, accuracyM: 6, altitudeM: 120, timestamp: clock.t })) kept++;
    lat += 15 / 111_320;
    lng += Math.sin(s / 60) * 0.00005;
  }
  const endClock = Date.now();
  clock.t = endClock;
  const journey = await app.endDrive();
  check('GPS points thinned before upload', kept > 150 && kept < FIXES / 2, `${kept} of ${FIXES} fixes kept`);
  check('journey uploaded and completed on the server', !!journey && !journey.id.startsWith('local:') && journey.syncState === 'synced', journey?.id);
  check('distance computed by the server from the route', !!journey && journey.distance > 7.5 && journey.distance < 8.5, `${journey?.distance} km`);
  check('XP awarded by the server', (journey?.xpEarned ?? 0) >= 50, `${journey?.xpEarned} XP`);
  check('route polyline returned for display', (journey?.routeCoordinates.length ?? 0) >= 10, `${journey?.routeCoordinates.length} points`);
  const journeyId = journey!.id;
  await app.writeCache();

  section('12. Journey persists and its route displays after restart');
  app.dispose();
  const reinstall = device('reinstalled app');
  await signInWithEmail(reinstall.auth, email, password);
  const app2 = cloud(reinstall, userA);
  await app2.start();
  await app2.refresh();
  const again = app2.data.journeys.find((j) => j.id === journeyId);
  check('journey present after reinstall', !!again);
  check('route displays after restart (decoded from the server)', (again?.routeCoordinates.length ?? 0) >= 10, `${again?.routeCoordinates.length} points`);
  check('journey stats match the server', again?.distance === journey?.distance && again?.xpEarned === journey?.xpEarned);
  check('XP and totals updated on the profile', app2.data.profile.totalJourneys === 1 && app2.data.profile.xp >= 150, `XP ${app2.data.profile.xp}`);
  app2.dispose();

  // ─── 13. Second account can't see private data ───────────────────────────
  section('13. A second account cannot access private data');
  const emailB = `driveos-mobile-${RUN}-b@example.com`;
  const passwordB = randomBytes(18).toString('base64url');
  console.log(`::add-mask::${passwordB}`);
  const userB = await adminCreate(emailB, passwordB, 'Other Driver');
  const phoneB = device('other person\'s phone');
  await signInWithEmail(phoneB.auth, emailB, passwordB);
  const status = async (p: Promise<unknown>) => p.then(() => 200, (e) => (e instanceof ApiError ? e.status : 0));
  check('B cannot read A\'s vehicle', (await status(phoneB.api.get(`/vehicles/${vehicleId}`))) === 404);
  check('B cannot edit A\'s vehicle', (await status(phoneB.ep.updateVehicle(vehicleId, { nickname: 'Mine' }))) === 404);
  check('B cannot see A\'s private journey', (await status(phoneB.ep.getJourney(journeyId))) === 404);
  check('B cannot read A\'s raw GPS points', (await status(phoneB.api.get(`/journeys/${journeyId}/points`))) === 404);
  check('B cannot see A\'s Home', (await status(phoneB.api.get(`/locations/${home!.id}`))) === 404);
  const bPhotos = await phoneB.ep.listPhotos({ vehicleId }).catch(() => []);
  check('B cannot list A\'s vehicle photos', Array.isArray(bPhotos) && bPhotos.length === 0);
  check('B\'s own lists contain none of A\'s data',
    (await phoneB.ep.listVehicles()).length === 0 && (await phoneB.ep.listJourneys()).length === 0 && (await phoneB.ep.listLocations()).length === 0);
  const bNearby = await phoneB.ep.nearbySpots(54.46, -3.09, 5000);
  check('B can see A\'s public Beauty Spot', bNearby.some((s) => s.id === spot!.id));
  check('B does not see A\'s Home among nearby spots', !bNearby.some((s) => s.id === home!.id));

  // ─── 14. Offline / server failures are visible ───────────────────────────
  section('14. Offline and server failures are visible');
  const app3 = cloud(p1, userA);
  await app3.start();
  p1.network = 'offline';
  await app3.addVehicle({ ...vehicleInput, nickname: 'Offline Golf', registration: '', isActive: false });
  await app3.outbox.flush();
  const offlineCar = app3.data.vehicles.find((v) => v.nickname === 'Offline Golf');
  check('offline: the change shows at once, marked as waiting', offlineCar?.syncState === 'pending');
  check('offline: status reports offline with 1 change waiting', app3.status.connection === 'offline' && app3.status.pendingChanges === 1,
    `${app3.status.connection}, ${app3.status.pendingChanges} pending, "${app3.status.lastError}"`);
  p1.network = 'server-error';
  await app3.refresh();
  check('server failure: status reports a server problem', app3.status.connection === 'server_error' && !!app3.status.lastError, app3.status.lastError ?? '');
  check('server failure: cached data is still shown', app3.data.vehicles.some((v) => v.id === vehicleId));
  p1.network = 'up';
  await app3.sync();
  check('back online: the waiting change uploads', app3.status.pendingChanges === 0 && app3.status.connection === 'online'
    && (await p1.ep.listVehicles()).some((v) => v.nickname === 'Offline Golf'));

  // ─── 16. Same account on a second phone ──────────────────────────────────
  section('16. Same account on a second phone sees the same cloud data');
  const phone2 = device('second phone');
  await signInWithEmail(phone2.auth, email, password);
  const app4 = cloud(phone2, userA);
  await app4.start();
  check('second phone starts with nothing cached', app4.data.vehicles.length === 0);
  await app4.refresh();
  const ids = (xs: Array<{ id: string }>) => xs.map((x) => x.id).sort().join(',');
  await app3.refresh();
  check('same vehicles', ids(app4.data.vehicles) === ids(app3.data.vehicles) && app4.data.vehicles.length === 2);
  check('same journeys', ids(app4.data.journeys) === ids(app3.data.journeys) && app4.data.journeys.some((j) => j.id === journeyId));
  check('same saved places and Beauty Spots', ids(app4.data.places) === ids(app3.data.places) && app4.data.places.length === 2);
  check('same profile', app4.data.profile.name === 'Alex Driver' && app4.data.profile.xp === app3.data.profile.xp);
  check('vehicle photo visible on the second phone', !!app4.data.vehicles.find((v) => v.id === vehicleId)?.imageUri);
  check('legacy device data keys untouched', LEGACY_KEYS.every((k) => !phone2.store.data.has(k)));
  app3.dispose();
  app4.dispose();

  // ─── 15. Account deletion ────────────────────────────────────────────────
  section('15. Account deletion');
  await p1.ep.deleteAccount();
  const authUser = await fetch(`${BASE}/auth/v1/admin/users/${userA}`, { headers: adminHeaders });
  check('the Auth account is gone', authUser.status === 404, `HTTP ${authUser.status}`);
  check('profile, vehicles, journeys and places are gone',
    sql(`select (select count(*) from public.profiles where id = '${userA}') + (select count(*) from public.vehicles where owner_id = '${userA}')
         + (select count(*) from public.journeys where owner_id = '${userA}') + (select count(*) from public.saved_locations where owner_id = '${userA}')`) === '0');
  const signIn = await signInWithEmail(device('after deletion').auth, email, password).catch((e) => e);
  check('the deleted account can no longer sign in', signIn instanceof Error);
  let filesGone = false;
  for (let i = 0; i < 30 && !filesGone; i++) {
    await sleep(1000);
    filesGone = sql(`select count(*) from storage.objects where split_part(name, '/', 1) = '${userA}'`) === '0';
  }
  check('the account\'s files were removed from Storage', filesGone);
  createdUsers.delete(userA);
  void userB;
}

async function cleanup() {
  for (const id of createdUsers) {
    const files = sql(`select bucket_id || '|' || name from storage.objects where split_part(name, '/', 1) = '${id}'`);
    const byBucket: Record<string, string[]> = {};
    for (const line of files ? files.split('\n') : []) { const [b, n] = line.split('|'); (byBucket[b!] ??= []).push(n!); }
    for (const [bucket, prefixes] of Object.entries(byBucket)) {
      await fetch(`${BASE}/storage/v1/object/${bucket}`, { method: 'DELETE', headers: { ...adminHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ prefixes }) });
    }
    await fetch(`${BASE}/auth/v1/admin/users/${id}`, { method: 'DELETE', headers: adminHeaders });
  }
  for (let i = 0; i < 20; i++) {
    if (sql(`select count(*) from private.storage_delete_queue`) === '0') break;
    await sleep(1000);
  }
}

const api = startApi();
let failed = false;
try {
  await waitForApi(api);
  await run();
} catch (err) {
  failed = true;
  console.error(`ERROR: ${(err as Error).stack ?? err}`);
} finally {
  try { await cleanup(); } catch (err) { failed = true; console.error(`Cleanup error: ${(err as Error).message}`); }
  api.kill('SIGTERM');
}

const leftovers = sql(`
  select (select count(*) from auth.users where email like 'driveos-mobile-${RUN}-%')
       + (select count(*) from public.profiles p join auth.users u on u.id = p.id where u.email like 'driveos-mobile-${RUN}-%')`);
check('nothing left behind (test accounts)', leftovers === '0', `${leftovers} leftover rows`);
const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} Phase 5 staging checks passed`);
process.exit(failed || bad.length ? 1 : 0);
