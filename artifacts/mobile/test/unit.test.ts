import { fileURLToPath } from 'node:url';
// Unit tests for the app's data layer (no network).
// Run: node --experimental-transform-types --import ./test/register.mjs --test test/unit.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkEnv, isServerSecret, ConfigError } from '@/lib/backend/env';
import { decodePolyline, distanceM } from '@/lib/backend/geo';
import { encodePolyline } from '../../api-server/src/lib/geo';
import { shouldKeepPoint, newJourneyRecord, recordFix, THINNING, type GpsFix } from '@/lib/backend/journeyRecorder';
import { Outbox } from '@/lib/backend/outbox';
import { MemoryStore, userKey } from '@/lib/backend/storage';
import { ApiError, NetworkError, AuthRequiredError, ApiClient } from '@/lib/backend/http';
import { CloudSync } from '@/lib/backend/cloudSync';
import type { Endpoints, ServerJourney, ServerLocation, ServerVehicle } from '@/lib/backend/endpoints';

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');

// ─── Configuration guard ────────────────────────────────────────────────────

test('the app refuses server secrets and insecure non-dev URLs', () => {
  assert.equal(isServerSecret('sb_secret_abc'), true);
  assert.equal(isServerSecret(`x.${b64({ role: 'service_role' })}.y`), true);
  assert.equal(isServerSecret(`x.${b64({ role: 'anon' })}.y`), false);
  assert.equal(isServerSecret('sb_publishable_abc'), false);
  const ok = { appEnv: 'staging', supabaseUrl: 'https://ref.supabase.co', supabasePublishableKey: 'sb_publishable_x', apiUrl: 'https://api.example.com' };
  assert.equal(checkEnv(ok).appEnv, 'staging');
  assert.throws(() => checkEnv({ ...ok, supabasePublishableKey: 'sb_secret_x' }), ConfigError);
  assert.throws(() => checkEnv({ ...ok, apiUrl: 'http://api.example.com' }), ConfigError);
  assert.throws(() => checkEnv({ ...ok, apiUrl: undefined }), /EXPO_PUBLIC_API_URL/);
  assert.equal(checkEnv({ ...ok, appEnv: 'development', apiUrl: 'http://localhost:8080' }).apiUrl, 'http://localhost:8080');
});

// ─── Polylines ──────────────────────────────────────────────────────────────

test('routes encoded by the API decode to the same points in the app', () => {
  const pts = Array.from({ length: 50 }, (_, i) => ({ lat: 51.5 + i * 0.0013, lng: -0.12 - Math.sin(i / 5) * 0.004 }));
  const decoded = decodePolyline(encodePolyline(pts));
  assert.equal(decoded.length, pts.length);
  decoded.forEach((p, i) => {
    assert.ok(Math.abs(p.latitude - pts[i]!.lat) < 1e-5);
    assert.ok(Math.abs(p.longitude - pts[i]!.lng) < 1e-5);
  });
  assert.deepEqual(decodePolyline(null), []);
});

// ─── GPS thinning ───────────────────────────────────────────────────────────

const t0 = Date.parse('2026-09-24T09:00:00Z');
/** Fixes once a second moving north at `speed` m/s (optionally turning east after `turnAt` s). */
function drive(seconds: number, speed: number, turnAt = Infinity): GpsFix[] {
  const out: GpsFix[] = [];
  let lat = 51.5, lng = -0.1;
  for (let s = 0; s < seconds; s++) {
    out.push({ latitude: lat, longitude: lng, speedMs: speed, accuracyM: 5, timestamp: t0 + s * 1000 });
    if (s < turnAt) lat += speed / 111_320;
    else lng += speed / (111_320 * Math.cos((lat * Math.PI) / 180));
  }
  return out;
}

function thin(fixes: GpsFix[]) {
  const rec = newJourneyRecord({ clientRef: 'c', startedAt: new Date(t0), timezone: 'UTC', vehicleId: null, vehicleSnapshot: null });
  for (const f of fixes) recordFix(rec, f);
  return rec;
}

test('thinning keeps a point every 3 s at speed, fewer when slow, none when parked', () => {
  const fast = thin(drive(300, 15)); // 54 km/h: 45 m every 3 s
  assert.ok(fast.points.length >= 95 && fast.points.length <= 101, `fast: ${fast.points.length}`);
  for (let i = 1; i < fast.points.length; i++) {
    assert.ok(Date.parse(fast.points[i]!.recordedAt) - Date.parse(fast.points[i - 1]!.recordedAt) >= THINNING.minIntervalMs);
  }
  assert.ok(Math.abs(fast.clientDistanceKm - 4.5) < 0.1, `distance ${fast.clientDistanceKm}`);

  const slow = thin(drive(300, 5)); // 25 m reached every 5–6 s
  assert.ok(slow.points.length >= 45 && slow.points.length <= 61, `slow: ${slow.points.length}`);
  assert.ok(slow.points.length < fast.points.length);

  const parked = thin(drive(300, 0));
  assert.equal(parked.points.length, 1);
});

test('thinning keeps a sharp turn even below 25 m', () => {
  const kept: ReturnType<typeof thin>['points'] = [];
  const rec = thin(drive(60, 3, 30)); // 3 m/s, turns 90° at 30 s
  kept.push(...rec.points);
  const turned = kept.some((p, i) => i > 0 && p.longitude !== kept[i - 1]!.longitude && distanceM(kept[i - 1]!, p) < 25);
  assert.ok(turned, 'a turn point under 25 m apart was kept');
});

test('thinning drops inaccurate fixes', () => {
  assert.equal(shouldKeepPoint([], { latitude: 1, longitude: 1, speedMs: 1, accuracyM: 150, timestamp: t0 }), false);
});

// ─── Outbox ─────────────────────────────────────────────────────────────────

test('outbox merges edits of an unsent record and cancels create+delete', async () => {
  const store = new MemoryStore();
  const ran: string[] = [];
  const box = new Outbox(store, 'u1', async (op) => { ran.push(op.kind); });
  await box.enqueue({ kind: 'vehicle.create', id: 'local:1', fields: { nickname: 'A' } });
  await box.enqueue({ kind: 'vehicle.update', id: 'local:1', fields: { make: 'Mazda' } });
  assert.equal(box.state.pending, 1);
  assert.deepEqual(box.queued[0], { kind: 'vehicle.create', id: 'local:1', fields: { nickname: 'A', make: 'Mazda' } });
  await box.enqueue({ kind: 'vehicle.delete', id: 'local:1' });
  assert.equal(box.state.pending, 0, 'never reached the server, so nothing to send');
  await box.flush();
  assert.deepEqual(ran, []);
});

test('outbox replays in order, maps local ids, stops when offline, reports rejections', async () => {
  const store = new MemoryStore();
  let offline = true;
  const calls: string[] = [];
  const exec = async (op: Parameters<ConstructorParameters<typeof Outbox>[2]>[0]) => {
    if (offline) throw new NetworkError();
    calls.push(`${op.kind}:${'id' in op ? op.id : ''}`);
    if (op.kind === 'vehicle.create') return 'server-1';
    if (op.kind === 'location.create') throw new ApiError(400, 'invalid_input', 'lat: must be ≤ 90');
  };
  const box = new Outbox(store, 'u1', exec);
  await box.enqueue({ kind: 'vehicle.create', id: 'local:v', fields: { nickname: 'A' } });
  await box.enqueue({ kind: 'vehicle.activate', id: 'local:v' });
  await box.enqueue({ kind: 'location.create', id: 'local:l', fields: { lat: 99 } });
  await box.enqueue({ kind: 'location.update', id: 'local:l', fields: { name: 'x' } });
  await box.flush();
  assert.equal(box.state.pending, 3, 'offline: everything kept (update merged into create)');
  assert.match(box.state.lastError ?? '', /offline/);

  // Survives an app restart.
  const box2 = new Outbox(store, 'u1', exec);
  await box2.load();
  assert.equal(box2.state.pending, 3);
  offline = false;
  await box2.flush();
  assert.deepEqual(calls, ['vehicle.create:local:v', 'vehicle.activate:server-1', 'location.create:local:l']);
  assert.equal(box2.state.pending, 0);
  assert.equal(box2.state.rejected.length, 1);
  assert.match(box2.state.rejected[0]!.message, /lat/);
  assert.equal(box2.resolve('local:v'), 'server-1');
});

test('outbox keeps ops when the session has ended', async () => {
  const box = new Outbox(new MemoryStore(), 'u1', async () => { throw new AuthRequiredError(); });
  await box.enqueue({ kind: 'profile.update', fields: { displayName: 'A' } });
  await box.flush();
  assert.equal(box.state.pending, 1);
});

test('outbox data is namespaced per user', async () => {
  const store = new MemoryStore();
  const a = new Outbox(store, 'user-a', async () => {});
  await a.enqueue({ kind: 'profile.update', fields: { displayName: 'A' } });
  const b = new Outbox(store, 'user-b', async () => {});
  await b.load();
  assert.equal(b.state.pending, 0);
  assert.ok(store.data.has(userKey('user-a', 'outbox/v1')));
});

// ─── HTTP client ────────────────────────────────────────────────────────────

test('the HTTP client classifies failures and refreshes once on 401', async () => {
  const states: string[] = [];
  let calls = 0;
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    calls++;
    const auth = (init.headers as Record<string, string>).Authorization;
    if (auth === 'Bearer old') return new Response('{}', { status: 401 });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;
  const client = new ApiClient({
    baseUrl: 'http://x', getAccessToken: async () => 'old', refreshAccessToken: async () => 'new', fetchImpl,
    onStatus: (s) => states.push(s),
  });
  assert.deepEqual(await client.get('/me'), { ok: true });
  assert.equal(calls, 2);

  const down = new ApiClient({ baseUrl: 'http://x', getAccessToken: async () => 't', refreshAccessToken: async () => null,
    fetchImpl: (async () => { throw new TypeError('Network request failed'); }) as typeof fetch, onStatus: (s) => states.push(s) });
  await assert.rejects(down.get('/me'), NetworkError);
  const broken = new ApiClient({ baseUrl: 'http://x', getAccessToken: async () => 't', refreshAccessToken: async () => null,
    fetchImpl: (async () => new Response('{"error":"internal_error","message":"Something went wrong."}', { status: 500 })) as typeof fetch,
    onStatus: (s) => states.push(s) });
  await assert.rejects(broken.get('/me'), (e) => e instanceof ApiError && e.isServerError);
  assert.deepEqual(states.slice(-2), ['offline', 'server_error']);
  const signedOut = new ApiClient({ baseUrl: 'http://x', getAccessToken: async () => null, refreshAccessToken: async () => null, onStatus: (s) => states.push(s) });
  await assert.rejects(signedOut.get('/me'), AuthRequiredError);
});

// ─── CloudSync against a fake server ────────────────────────────────────────

class FakeServer {
  offline = false;
  vehicles: ServerVehicle[] = [];
  locations: ServerLocation[] = [];
  journeys: ServerJourney[] = [];
  points = new Map<string, number>();
  /** Each journey's stored point times, as the server keeps them (duplicates ignored) */
  pointTimes = new Map<string, Set<string>>();
  deletedJourneys: string[] = [];
  /** Every endpoint called, in order */
  calls: string[] = [];
  loseNextStartReply = false;
  private n = 0;
  private guard() { if (this.offline) throw new NetworkError(); }
  ep(): Endpoints {
    const self = this;
    const empty = async () => { self.guard(); return []; };
    const e = {
      getMe: async () => { self.guard(); return { id: 'u1', username: null, displayName: 'Tester', bio: '', avatarUrl: null, friendCode: 'ABCD2345', xp: 0, level: 1, xpIntoLevel: 0, xpToNextLevel: 1000, totalDistanceKm: 0, totalJourneys: self.journeys.length, createdAt: '', settings: null }; },
      getAchievements: empty, listCategories: empty, listFriends: empty, listBlocks: empty, listConvoys: empty, listGroups: empty, listEvents: empty,
      getStats: async () => { self.guard(); return { friends: 0, vehicles: self.vehicles.length, journeys: self.journeys.length, totalDistanceKm: 0 }; },
      listFriendRequests: async () => { self.guard(); return { incoming: [], outgoing: [] }; },
      listNotifications: async () => { self.guard(); return { items: [], unreadCount: 0 }; },
      listVehicles: async () => { self.guard(); return self.vehicles; },
      listLocations: async () => { self.guard(); return self.locations; },
      listJourneys: async () => { self.guard(); return self.journeys.filter((j) => j.status === 'completed'); },
      createVehicle: async (f: Record<string, unknown>) => {
        self.guard();
        const existing = self.vehicles.find((v) => v.clientRef === f.clientRef);
        if (existing) return existing;
        const v = { id: `v${++self.n}`, clientRef: f.clientRef, nickname: f.nickname, registration: '', make: f.make ?? '', model: '', year: null, colour: '', fuelType: 'petrol', engine: '', power: '', torque: '', zeroToSixty: '', topSpeedSpec: '', mileage: 0, visibility: 'private', isActive: !!f.isActive, coverPhotoId: null, coverPhotoUrl: null, createdAt: '', updatedAt: '' } as ServerVehicle;
        self.vehicles.push(v);
        return v;
      },
      updateVehicle: async (id: string, f: Record<string, unknown>) => { self.guard(); const v = self.vehicles.find((x) => x.id === id)!; Object.assign(v, f); return v; },
      createLocation: async (f: Record<string, unknown>) => {
        self.guard();
        const l = { id: `l${++self.n}`, ownerId: 'u1', clientRef: f.clientRef, kind: f.kind, category: null, name: f.name, description: '', address: typeof f.address === 'string' ? f.address : '', lat: f.lat, lng: f.lng, routePolyline: null, visibility: f.kind === 'home' ? 'private' : (f.visibility ?? 'private'), status: 'active', coverPhotoId: null, sourceJourneyId: null, createdAt: '', updatedAt: '' } as ServerLocation;
        self.locations.push(l);
        return l;
      },
      startJourney: async (i: { clientRef: string; startedAt: string }) => {
        self.guard();
        const existing = self.journeys.find((j) => j.clientRef === i.clientRef);
        if (existing) return existing;
        const j = { id: `j${++self.n}`, clientRef: i.clientRef, status: 'active', startedAt: i.startedAt, name: 'Active Journey', route: null } as unknown as ServerJourney;
        self.journeys.push(j);
        // The request arrived and was stored, but the reply is lost on the way back
        if (self.loseNextStartReply) { self.loseNextStartReply = false; throw new NetworkError(); }
        return j;
      },
      deleteJourney: async (id: string) => {
        self.guard();
        self.deletedJourneys.push(id);
        self.journeys = self.journeys.filter((j) => j.id !== id);
      },
      addRoutePoints: async (id: string, pts: { recordedAt: string }[]) => {
        self.guard();
        self.points.set(id, (self.points.get(id) ?? 0) + pts.length);
        const times = self.pointTimes.get(id) ?? new Set<string>();
        for (const p of pts) times.add(p.recordedAt);
        self.pointTimes.set(id, times);
        const j = self.journeys.find((x) => x.id === id);
        return { saved: pts.length, status: j?.status ?? 'active' };
      },
      listActiveJourneys: async () => { self.guard(); return self.journeys.filter((j) => j.status === 'active'); },
      getJourneyPoints: async (id: string) => { self.guard(); return [...(self.pointTimes.get(id) ?? [])].sort().map((recordedAt) => ({ recordedAt })); },
      completeJourney: async (id: string, i: { endedAt: string; distanceKm: number; name?: string; visibility?: string }) => {
        self.guard();
        const j = self.journeys.find((x) => x.id === id)!;
        Object.assign(j, { name: i.name ?? j.name, status: 'completed', endedAt: i.endedAt, distanceKm: i.distanceKm, durationSeconds: 60, avgSpeedKmh: 0, topSpeedKmh: 0, xpEarned: 50, timezone: 'UTC', notes: '', visibility: i.visibility ?? 'private', journeyType: 'personal', vehicleId: null, categoryId: null, convoyId: null, vehicleSnapshot: null, publicRoutePolyline: null });
        return j;
      },
    };
    for (const [name, fn] of Object.entries(e)) {
      (e as Record<string, unknown>)[name] = (...args: unknown[]) => { self.calls.push(name); return (fn as (...a: unknown[]) => unknown)(...args); };
    }
    return e as unknown as Endpoints;
  }
}

function makeSync(server: FakeServer, store: MemoryStore, clock: { t: number }) {
  let id = 0;
  return new CloudSync({
    ep: server.ep(), store, userId: 'u1', publishableKey: 'sb_publishable_x', newId: () => `id-${++id}-${Math.random()}`,
    timezone: () => 'UTC', now: () => clock.t,
    prepareFile: async () => ({ body: new Uint8Array([1]), size: 1, mimeType: 'image/jpeg' }),
  });
}

test('offline edits show immediately, survive a restart and upload later', async () => {
  const server = new FakeServer();
  const store = new MemoryStore();
  const clock = { t: Date.now() - 10 * 60_000 };
  server.offline = true;
  const app = makeSync(server, store, clock);
  await app.start();
  await app.addVehicle({ nickname: 'Offline car', registration: '', make: 'Mazda', model: 'MX-5', year: 1990, colour: '', fuelType: 'petrol', engine: '', power: '', torque: '', zeroToSixty: '', topSpeed: '', mileage: 0, fuelPercentage: 0, imageUri: null, isActive: false });
  await app.addPlace({ kind: 'home', name: 'Home', coordinate: { latitude: 51.5, longitude: -0.1 }, visibility: 'public' });
  await app.outbox.flush();
  assert.equal(app.data.vehicles.length, 1);
  assert.equal(app.data.vehicles[0]!.syncState, 'pending');
  assert.equal(app.data.vehicles[0]!.isActive, true, 'first vehicle is active');
  assert.equal(app.data.places[0]!.visibility, 'private', 'home is always private');
  assert.equal(app.status.pendingChanges, 2);

  // A drive recorded offline.
  await app.startDrive(app.data.vehicles[0]!);
  for (let s = 0; s < 120; s++) { clock.t += 1000; app.addFix({ latitude: 51.5 + s * 0.0001, longitude: -0.1, speedMs: 11, accuracyM: 5, timestamp: clock.t }); }
  const drove = await app.endDrive();
  assert.ok(drove && drove.id.startsWith('local:') && drove.syncState === 'pending');
  assert.equal(app.status.pendingJourneys, 1);
  await app.refresh(); // fails offline, keeps cached data
  assert.equal(app.data.vehicles.length, 1);
  assert.ok(app.status.lastError);
  await app.writeCache();
  app.dispose();

  // Restart while still offline: everything is still there.
  const again = makeSync(server, store, clock);
  await again.start();
  assert.equal(again.data.vehicles.length, 1);
  assert.equal(again.data.journeys.filter((j) => j.syncState === 'pending').length, 1);
  assert.equal(again.status.pendingChanges, 2);

  // Back online: everything uploads, with the vehicle's local id mapped.
  server.offline = false;
  await again.sync();
  assert.equal(again.status.pendingChanges, 0);
  assert.equal(again.status.pendingJourneys, 0);
  assert.equal(server.vehicles.length, 1);
  assert.equal(server.locations.length, 1);
  assert.equal(server.journeys.length, 1);
  assert.equal(server.journeys[0]!.status, 'completed');
  assert.ok((server.points.get(server.journeys[0]!.id) ?? 0) > 20);
  assert.equal(again.data.vehicles[0]!.id, server.vehicles[0]!.id);
  assert.equal(again.data.journeys[0]!.syncState, 'synced');

  // Retrying is idempotent: nothing is duplicated.
  await again.sync();
  assert.equal(server.vehicles.length, 1);
  assert.equal(server.journeys.length, 1);
});

test('each user has separate cached data on the same phone', async () => {
  const store = new MemoryStore();
  const server = new FakeServer();
  const a = makeSync(server, store, { t: Date.now() });
  await a.start();
  await a.addPlace({ kind: 'work', name: 'Office', coordinate: { latitude: 1, longitude: 1 } });
  await a.writeCache();
  const b = new CloudSync({ ep: server.ep(), store, userId: 'someone-else', publishableKey: 'k', newId: () => 'x', timezone: () => 'UTC', prepareFile: async () => ({ body: '', size: 0, mimeType: 'image/jpeg' }) });
  await b.start();
  assert.equal(b.data.places.length, 0);
  await a.wipeLocal();
  assert.equal([...store.data.keys()].filter((k) => k.includes('/u1/')).length, 0, 'sign-out removes the user\'s cache');
});

// ─── Sign-in links, photo bytes, app identity ───────────────────────────────

import { parseAuthCallback } from '@/lib/backend/auth';
import { base64ToBytes } from '@/lib/backend/bytes';
import { createRequire } from 'node:module';

test('sign-in return links are parsed from the query and the fragment', () => {
  assert.deepEqual(parseAuthCallback('starscale-drive-staging://auth/callback?type=recovery&code=abc-123'),
    { code: 'abc-123', error: null, type: 'recovery' });
  assert.deepEqual(parseAuthCallback('exp://192.168.1.2:8081/--/auth/callback#error=access_denied&error_description=Email+link+is+invalid+or+has+expired'),
    { code: null, error: 'Email link is invalid or has expired', type: null });
  // Values containing "=" and malformed escapes don't break parsing.
  assert.equal(parseAuthCallback('driveos://auth/callback?code=a%3Db==&x=%E0%A4%A').code, 'a=b==');
});

test('photo bytes decode from base64', () => {
  const bytes = base64ToBytes(Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x10]).toString('base64'));
  assert.deepEqual([...bytes], [0xff, 0xd8, 0xff, 0x00, 0x10]);
  assert.equal(base64ToBytes('data:image/jpeg;base64,/9g=').length, 2);
});

test('the staging (TestFlight) identity is chosen; the App Store identity is not', () => {
  const { identity } = createRequire(import.meta.url)('../app.identity.js');
  const tf = identity('staging', {});
  assert.deepEqual([tf.appName, tf.slug, tf.scheme, tf.bundleId, tf.usingPlaceholders],
    ['Derwent', 'starscale-drive-staging', 'starscale-drive-staging', 'uk.co.starscale.drive.staging', false]);
  assert.equal(`${tf.scheme}://auth/callback`, 'starscale-drive-staging://auth/callback');
  assert.deepEqual(identity('development', {}).bundleId, 'uk.co.starscale.drive.staging', 'local builds are the staging app');
  const store = identity('production', {});
  assert.equal(store.bundleId, null, 'no App Store bundle id is set');
  assert.equal(store.usingPlaceholders, true);
  // Environment variables are base values; staging adds its suffixes.
  const chosen = identity('production', { APP_DISPLAY_NAME: 'Name', APP_SCHEME: 'name', APP_BUNDLE_ID: 'com.example.name' });
  assert.deepEqual([chosen.appName, chosen.scheme, chosen.bundleId, chosen.usingPlaceholders], ['Name', 'name', 'com.example.name', false]);
  assert.equal(identity('staging', { APP_BUNDLE_ID: 'com.example.name' }).bundleId, 'com.example.name.staging');
  assert.equal(identity('staging', { APP_SCHEME: 'name' }).scheme, 'name-staging');
  // The EAS project is linked only in CHOSEN: no environment override, none for the App Store app.
  assert.deepEqual([tf.easProjectId, tf.owner, tf.committed], ['a5ecd99b-322f-4531-b3d9-4bdd3ddb93cf', 'dancaw23', true]);
  assert.equal(identity('staging', { EAS_PROJECT_ID: 'p-2' }).easProjectId, 'a5ecd99b-322f-4531-b3d9-4bdd3ddb93cf');
  assert.deepEqual([store.easProjectId, store.owner, store.committed], [null, null, false]);
});

test('the build keeps one EAS project id and one identity', () => {
  const appConfig = createRequire(import.meta.url)('../app.config.js') as (a: { config: object }) => { owner?: string; extra: { eas?: { projectId: string } } };
  const cfg = (extra: object = {}) => ({ config: { ios: { infoPlist: {} }, android: {}, plugins: [], extra } });
  const saved = { ...process.env };
  try {
    for (const k of Object.keys(process.env)) if (k.startsWith('EXPO_PUBLIC_') || k.startsWith('APP_') || k === 'EAS_PROJECT_ID') delete process.env[k];
    Object.assign(process.env, {
      EXPO_PUBLIC_APP_ENV: 'staging',
      EXPO_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
      EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_' + 'abc',
      EXPO_PUBLIC_API_URL: 'https://api.example.invalid',
    });
    const tf = appConfig(cfg());
    assert.deepEqual([tf.owner, tf.extra.eas?.projectId], ['dancaw23', 'a5ecd99b-322f-4531-b3d9-4bdd3ddb93cf']);
    // What `eas init` writes into app.json: harmless when identical, refused when different.
    assert.doesNotThrow(() => appConfig(cfg({ eas: { projectId: 'a5ecd99b-322f-4531-b3d9-4bdd3ddb93cf' } })));
    assert.throws(() => appConfig(cfg({ eas: { projectId: 'other' } })), /Keep the EAS project id only in app\.identity\.js/);
    // The staging project id in app.json must never reach an App Store build.
    process.env.EXPO_PUBLIC_APP_ENV = 'production';
    assert.throws(() => appConfig(cfg({ eas: { projectId: 'a5ecd99b-322f-4531-b3d9-4bdd3ddb93cf' } })), /has none/);
    assert.equal(appConfig(cfg()).extra.eas, undefined, 'the App Store build has no EAS project yet');
    // A leftover APP_* variable can't replace the committed TestFlight identity.
    process.env.EXPO_PUBLIC_APP_ENV = 'staging';
    process.env.APP_BUNDLE_ID = 'com.someone.devtest';
    assert.throws(() => appConfig(cfg()), /APP_BUNDLE_ID would override the staging identity/);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

test('an unchosen identity falls back to placeholders and sets no bundle id', () => {
  const { identity } = createRequire(import.meta.url)('../app.identity.js');
  const none = { staging: {}, production: {} };
  const s = identity('staging', {}, none);
  assert.deepEqual([s.appName, s.scheme, s.bundleId, s.easProjectId, s.usingPlaceholders],
    ['DriveOS Staging', 'driveos-staging', null, null, true]);
  assert.deepEqual([identity('production', {}, none).scheme, identity('production', {}, none).bundleId], ['driveos', null]);
});

// ─── Outbox / sync edge cases (review fixes) ────────────────────────────────

import { storedSessionUser } from '@/lib/backend/auth';

function deferred<T = void>() {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('an edit made while its create is being sent is not lost', async () => {
  const gate = deferred<void>();
  const sent: Array<{ kind: string; id?: string; fields?: Record<string, unknown> }> = [];
  const box = new Outbox(new MemoryStore(), 'u', async (op) => {
    sent.push(JSON.parse(JSON.stringify(op)));
    if (op.kind === 'vehicle.create') { await gate.promise; return 'srv-1'; }
  });
  await box.enqueue({ kind: 'vehicle.create', id: 'local:a', fields: { nickname: 'A' } });
  const flushing = box.flush();
  await new Promise((r) => setTimeout(r, 5)); // create is now in flight
  await box.enqueue({ kind: 'vehicle.update', id: 'local:a', fields: { nickname: 'B' } });
  gate.resolve();
  await flushing;
  await box.flush();
  assert.deepEqual(sent.map((o) => o.kind), ['vehicle.create', 'vehicle.update']);
  assert.equal(sent[1]!.id, 'srv-1', 'the update targets the server id');
  assert.equal(sent[1]!.fields!.nickname, 'B');
  assert.equal(box.state.pending, 0);
});

test('a delete made while its create is being sent still deletes on the server', async () => {
  const gate = deferred<void>();
  const sent: string[] = [];
  const box = new Outbox(new MemoryStore(), 'u', async (op) => {
    sent.push(`${op.kind}:${'id' in op ? op.id : ''}`);
    if (op.kind === 'location.create') { await gate.promise; return 'srv-9'; }
  });
  await box.enqueue({ kind: 'location.create', id: 'local:p', fields: { name: 'X' } });
  const flushing = box.flush();
  await new Promise((r) => setTimeout(r, 5));
  await box.enqueue({ kind: 'location.delete', id: 'local:p' });
  gate.resolve();
  await flushing;
  await box.flush();
  assert.deepEqual(sent, ['location.create:local:p', 'location.delete:srv-9']);
});

test('only the latest photo choice for a vehicle is uploaded', async () => {
  const box = new Outbox(new MemoryStore(), 'u', async () => { throw new NetworkError(); });
  await box.enqueue({ kind: 'vehicle.photo', id: 'v1', uri: 'file:///a.jpg' });
  await box.enqueue({ kind: 'vehicle.photo', id: 'v1', uri: 'file:///b.jpg' });
  assert.deepEqual(box.queued, [{ kind: 'vehicle.photo', id: 'v1', uri: 'file:///b.jpg' }]);
  await box.enqueue({ kind: 'vehicle.photoRemove', id: 'v1' });
  assert.deepEqual(box.queued, [{ kind: 'vehicle.photoRemove', id: 'v1' }]);
});

/** A small in-memory API with photos, categories and journeys for CloudSync tests. */
class PhotoServer extends FakeServer {
  photos = new Map<string, { vehicleId: string }>();
  deletedPhotos: string[] = [];
  categories: Array<{ id: string; ownerId: string | null; name: string; icon: string; colour: string; sortOrder: number }> = [];
  categoryCreates = 0;
  journeyUpdates: Array<{ id: string; fields: Record<string, unknown> }> = [];
  private k = 0;
  ep(): Endpoints {
    const base = super.ep() as unknown as Record<string, unknown>;
    const self = this;
    return {
      ...base,
      getVehicle: async (id: string) => { const v = self.vehicles.find((x) => x.id === id); if (!v) throw new ApiError(404, 'not_found', 'Not found.'); return v; },
      requestUpload: async (i: { parentId: string }) => ({ kind: 'vehicle-photo', id: `ph${++self.k}`, bucket: 'vehicle-photos', path: `u/${i.parentId}/x.jpg`, uploadUrl: 'https://storage.test/upload', token: 't' }),
      confirmUpload: async (id: string) => ({ id, status: 'ready' }),
      updateVehicle: async (id: string, f: Record<string, unknown>) => {
        const v = self.vehicles.find((x) => x.id === id)!;
        if ('coverPhotoId' in f) { self.photos.set(f.coverPhotoId as string, { vehicleId: id }); v.coverPhotoUrl = `https://signed/${f.coverPhotoId}`; }
        Object.assign(v, f);
        return v;
      },
      deletePhoto: async (id: string) => {
        self.deletedPhotos.push(id);
        self.photos.delete(id);
        for (const v of self.vehicles) if (v.coverPhotoId === id) { v.coverPhotoId = null; v.coverPhotoUrl = null; }
      },
      listCategories: async () => self.categories,
      createCategory: async (c: { name: string; icon: string; colour: string }) => {
        self.categoryCreates++;
        const row = { id: `c${++self.k}`, ownerId: 'u1', sortOrder: 100, ...c };
        self.categories.push(row);
        return row;
      },
      updateJourney: async (id: string, fields: Record<string, unknown>) => { self.journeyUpdates.push({ id, fields }); return {}; },
    } as unknown as Endpoints;
  }
}

function photoSync(server: PhotoServer, store = new MemoryStore(), clock = { t: Date.now() }) {
  let n = 0;
  return new CloudSync({
    ep: server.ep(), store, userId: 'u1', publishableKey: 'k', newId: () => `id${++n}-${Math.random()}`, timezone: () => 'UTC',
    now: () => clock.t,
    fetchImpl: (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch,
    prepareFile: async () => ({ body: new Uint8Array([1, 2, 3]), size: 3, mimeType: 'image/jpeg' }),
  });
}

const car = { nickname: 'Car', registration: '', make: 'Mazda', model: 'MX-5', year: 2020, colour: '', fuelType: 'petrol' as const, engine: '', power: '', torque: '', zeroToSixty: '', topSpeed: '', mileage: 0, fuelPercentage: 0, imageUri: null, isActive: false };

test('replacing a vehicle photo deletes the old one; removing it deletes the cover', async () => {
  const server = new PhotoServer();
  const app = photoSync(server);
  await app.start();
  await app.addVehicle({ ...car, imageUri: 'file:///first.jpg' });
  await app.outbox.flush();
  const v = server.vehicles[0]!;
  const first = v.coverPhotoId;
  assert.ok(first, 'first photo is the cover');
  await app.updateVehicle(app.data.vehicles[0]!.id, { imageUri: 'file:///second.jpg' });
  await app.outbox.flush();
  assert.notEqual(v.coverPhotoId, first);
  assert.deepEqual(server.deletedPhotos, [first], 'the replaced photo is deleted (its file is then removed from Storage)');
  const second = v.coverPhotoId;
  await app.updateVehicle(app.data.vehicles[0]!.id, { imageUri: null });
  await app.outbox.flush();
  assert.deepEqual(server.deletedPhotos, [first, second]);
  assert.equal(v.coverPhotoId, null);
  assert.equal(app.data.vehicles[0]!.imageUri, null);
  assert.equal(app.status.rejected.length, 0);
});

test('retrying a category create after a lost response does not duplicate it', async () => {
  const server = new PhotoServer();
  const app = photoSync(server);
  await app.start();
  // The first attempt reached the server but the response was lost.
  server.categories.push({ id: 'c-existing', ownerId: 'u1', name: 'Track', icon: 'flag', colour: '#FF0000', sortOrder: 100 });
  await app.addCategory({ name: 'Track', icon: 'flag', colour: '#FF0000' });
  await app.outbox.flush();
  assert.equal(server.categoryCreates, 0);
  assert.ok(app.data.categories.some((c) => c.id === 'c-existing'));
});

test('a record created while a refresh is in progress does not vanish', async () => {
  const server = new PhotoServer();
  const app = photoSync(server);
  await app.start();
  const listGate = deferred<void>();
  const ep = app['deps'].ep as unknown as { listVehicles: () => Promise<unknown> };
  const realList = ep.listVehicles;
  let firstCall = true;
  ep.listVehicles = async () => {
    const snapshot = [...server.vehicles]; // read before the create lands
    if (firstCall) { firstCall = false; await listGate.promise; }
    return snapshot;
  };
  const refreshing = app.refresh();
  await new Promise((r) => setTimeout(r, 5));
  await app.addVehicle(car);
  await app.outbox.flush();
  listGate.resolve();
  await refreshing;
  ep.listVehicles = realList;
  assert.equal(app.data.vehicles.length, 1, 'still shown after the refresh');
  assert.equal(app.data.vehicles[0]!.id, server.vehicles[0]!.id);
});

test('a drive cut short by a crash is finished and uploaded on the next start', async () => {
  const server = new PhotoServer();
  const store = new MemoryStore();
  const clock = { t: Date.now() - 20 * 60_000 };
  const app = photoSync(server, store, clock);
  server.offline = true;
  await app.start();
  await app.startDrive(null);
  for (let s = 0; s < 90; s++) { clock.t += 1000; app.addFix({ latitude: 52 + s * 0.0002, longitude: 0, speedMs: 20, accuracyM: 5, timestamp: clock.t }); }
  await new Promise((r) => setTimeout(r, 10));
  // The app is killed here (no endDrive). Points were persisted every 5 s.
  const saved = JSON.parse((await store.getItem('@driveos/u/u1/journey/active'))!);
  assert.ok(saved.points.length > 5, 'drive saved on the device while recording');
  server.offline = false;
  const again = photoSync(server, store, clock);
  await again.start();
  assert.equal(again.status.pendingJourneys, 1, 'the interrupted drive is waiting to upload');
  await again.sync();
  assert.equal(again.status.pendingJourneys, 0);
  assert.equal(server.journeys[0]!.status, 'completed');
});

test('renaming a drive while it uploads keeps the name; clearing a category is sent', async () => {
  const server = new PhotoServer();
  const clock = { t: Date.now() - 10 * 60_000 };
  const app = photoSync(server, new MemoryStore(), clock);
  server.offline = true;
  await app.start();
  await app.startDrive(null);
  for (let s = 0; s < 30; s++) { clock.t += 2000; app.addFix({ latitude: 51 + s * 0.0005, longitude: 0, speedMs: 25, accuracyM: 5, timestamp: clock.t }); }
  const j = await app.endDrive();
  await app.updateJourney(j!.id, { name: 'Sunday run' });
  server.offline = false;
  await app.sync();
  assert.equal(server.journeys[0]!.name, 'Sunday run');
  const serverId = server.journeys[0]!.id;
  await app.updateJourney(serverId, { categoryId: undefined });
  await app.outbox.flush();
  assert.deepEqual(server.journeyUpdates.at(-1), { id: serverId, fields: { categoryId: null } });
});

test('choosing who can see a drive while it uploads is sent when it completes; afterwards it is an update', async () => {
  const server = new PhotoServer();
  const clock = { t: Date.now() - 10 * 60_000 };
  const app = photoSync(server, new MemoryStore(), clock);
  server.offline = true;
  await app.start();
  await app.startDrive(null);
  for (let s = 0; s < 30; s++) { clock.t += 2000; app.addFix({ latitude: 51 + s * 0.0005, longitude: 0, speedMs: 25, accuracyM: 5, timestamp: clock.t }); }
  const j = await app.endDrive();
  assert.ok(j!.id.startsWith('local:'), 'still uploading');
  await app.updateJourney(j!.id, { privacy: 'friends' });
  assert.equal(app.data.journeys.find((x) => x.id === j!.id)!.privacy, 'friends', 'shown at once');
  server.offline = false;
  await app.sync();
  assert.equal(server.journeys[0]!.visibility, 'friends', 'sent with the completed drive');
  const serverId = server.journeys[0]!.id;
  await app.updateJourney(serverId, { privacy: 'public' });
  await app.outbox.flush();
  assert.deepEqual(server.journeyUpdates.at(-1), { id: serverId, fields: { visibility: 'public' } });
});

test('offline token refresh is reported as offline, not signed out', async () => {
  const states: string[] = [];
  const client = new ApiClient({
    baseUrl: 'http://x', getAccessToken: async () => { throw new NetworkError(); }, refreshAccessToken: async () => null,
    onStatus: (s) => states.push(s),
  });
  await assert.rejects(client.get('/me'), NetworkError);
  assert.deepEqual(states, ['offline']);
});

test('the saved session user can be read without contacting the server', async () => {
  const store = new MemoryStore();
  const fakeClient = { auth: { storageKey: 'sb-ref-auth-token' } } as never;
  assert.equal(await storedSessionUser(fakeClient, store), null);
  await store.setItem('sb-ref-auth-token', JSON.stringify({ refresh_token: 'r', user: { id: 'user-1', email: 'a@b.c' } }));
  assert.deepEqual(await storedSessionUser(fakeClient, store), { id: 'user-1', email: 'a@b.c' });
  await store.setItem('sb-ref-auth-token', 'not json');
  assert.equal(await storedSessionUser(fakeClient, store), null);
});

import { accessTokenGetter, authServerProbe, createAuthClient, currentAccessToken } from '@/lib/backend/auth';

test('back online after an offline start, the token refreshes at once (not a minute later)', { timeout: 90_000 }, async () => {
  let online = false;
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const jwt = (exp: number) => `${b64({ alg: 'HS256' })}.${b64({ sub: 'u1', exp })}.sig`;
  const user = { id: 'u1', aud: 'authenticated', email: 'a@b.c', app_metadata: {}, user_metadata: {}, created_at: '' };
  const net = (async (url: string) => {
    if (!online) throw new TypeError('Network request failed');
    if (String(url).endsWith('/auth/v1/health')) return new Response('{}', { status: 200 });
    const exp = Math.floor(Date.now() / 1000) + 3600;
    return new Response(JSON.stringify({ access_token: jwt(exp), refresh_token: 'r2', expires_in: 3600, expires_at: exp, token_type: 'bearer', user }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const store = new MemoryStore();
  const expired = Math.floor(Date.now() / 1000) - 60;
  await store.setItem('sb-x-auth-token', JSON.stringify({ access_token: jwt(expired), refresh_token: 'r1', expires_in: 3600, expires_at: expired, token_type: 'bearer', user }));
  const client = createAuthClient({ url: 'https://x.supabase.co', publishableKey: 'sb_publishable_x', storage: store, fetchImpl: net });
  const clock = { t: 0 };
  const getToken = accessTokenGetter(client, authServerProbe('https://x.supabase.co', 'sb_publishable_x', net), { now: () => clock.t });

  // Offline: reported as offline, and the saved session is kept.
  await assert.rejects(getToken(), NetworkError);
  assert.ok(await store.getItem('sb-x-auth-token'));
  online = true;
  clock.t += 6_000; // the app's next retry, after the probe throttle
  // supabase-js alone keeps replaying the offline failure for a minute…
  await assert.rejects(currentAccessToken(client), NetworkError);
  // …the app's getter notices the server is back and refreshes straight away.
  const t0 = Date.now();
  const token = await getToken();
  assert.ok(token && token !== jwt(expired));
  assert.ok(Date.now() - t0 < 2_000);
});

// ─── DVLA registration lookup (v1) ──────────────────────────────────────────
import { endpoints } from '@/lib/backend/endpoints';
import { toVehicle } from '@/lib/backend/mappers';
import {
  acceptConflicts, initialSources, lookupErrorMessage, lookupInputProblem, markEdited, mergeLookup, type Suggestions,
} from '@/lib/backend/vehicleLookup';
import { parseUkRegistration } from '@workspace/vehicle-registration';

const SUGGESTED: Suggestions = { make: 'Volkswagen', colour: 'Blue', fuelType: 'diesel', year: 2018, engine: '2.0L' };
const blankForm = () => ({ registration: '', make: '', colour: '', fuelType: 'petrol' as const, year: new Date().getFullYear(), engine: '' });

test('a DVLA failure does not raise the app-wide server banner; other 5xx still do', async () => {
  const states: string[] = [];
  const fetchImpl = (async () => new Response('{"error":"lookup_unavailable","message":"DVLA lookup is unavailable right now."}', { status: 503 })) as typeof fetch;
  const api = new ApiClient({ baseUrl: 'http://x', getAccessToken: async () => 't', refreshAccessToken: async () => null, fetchImpl, onStatus: (s) => states.push(s) });
  await assert.rejects(endpoints(api).lookupVehicle('AB12CDE'), (e) => e instanceof ApiError && e.code === 'lookup_unavailable');
  assert.deepEqual(states, [], 'lookup failures are quiet');
  await assert.rejects(api.get('/vehicles'), ApiError);
  assert.deepEqual(states, ['server_error'], 'the rest of the API still reports');
});

test('a lookup fills a new vehicle form, including its placeholder defaults', () => {
  const r = mergeLookup(blankForm(), initialSources(null), 'AB12 CDE', SUGGESTED);
  assert.deepEqual(r.form, { registration: 'AB12 CDE', make: 'Volkswagen', colour: 'Blue', fuelType: 'diesel', year: 2018, engine: '2.0L' });
  assert.deepEqual(r.applied, ['make', 'colour', 'fuelType', 'year', 'engine']);
  assert.deepEqual(r.conflicts, []);
});

test('a lookup never replaces what the user typed; differences are offered instead', () => {
  let sources = initialSources(null);
  const form = { ...blankForm(), colour: 'British Racing Green', year: 2019 };
  sources = markEdited(sources, 'colour');
  sources = markEdited(sources, 'year');
  const r = mergeLookup(form, sources, 'AB12 CDE', SUGGESTED);
  assert.equal(r.form.colour, 'British Racing Green');
  assert.equal(r.form.year, 2019);
  assert.equal(r.form.make, 'Volkswagen', 'blank fields are still filled');
  assert.deepEqual(r.conflicts.map((c) => [c.field, c.yours, c.suggested]), [['colour', 'British Racing Green', 'Blue'], ['year', '2019', '2018']]);
  // Only when the user asks.
  const used = acceptConflicts(r.form, r.sources, r.conflicts, SUGGESTED);
  assert.equal(used.form.colour, 'Blue');
  assert.equal(used.form.year, 2018);
});

test("a saved vehicle's values count as the user's; same values in other casing aren't conflicts", () => {
  const saved = { registration: 'AB12CDE', make: 'VOLKSWAGEN', colour: 'Alpine White', fuelType: 'petrol' as const, year: 2017, engine: '' };
  const r = mergeLookup(saved, initialSources(saved), 'AB12 CDE', SUGGESTED);
  assert.equal(r.form.make, 'VOLKSWAGEN');
  assert.equal(r.form.colour, 'Alpine White');
  assert.equal(r.form.fuelType, 'petrol');
  assert.equal(r.form.engine, '2.0L', 'blank saved field filled');
  assert.deepEqual(r.conflicts.map((c) => c.field), ['colour', 'fuelType', 'year'], 'make differs only in case');
});

test('a second lookup may replace values the first one filled, but blank suggestions never wipe anything', () => {
  const first = mergeLookup(blankForm(), initialSources(null), 'AB12 CDE', SUGGESTED);
  const second = mergeLookup(first.form, first.sources, 'XY34 ZZZ', { make: 'Ford', colour: null, fuelType: null, year: null, engine: null });
  assert.equal(second.form.make, 'Ford');
  assert.equal(second.form.colour, 'Blue');
  assert.equal(second.form.registration, 'XY34 ZZZ');
  assert.deepEqual(second.conflicts, []);
});

test('lookup input checks and messages keep manual entry open', () => {
  assert.equal(lookupInputProblem('ab12 cde'), null);
  assert.match(lookupInputProblem('')!, /Enter the registration/);
  assert.match(lookupInputProblem('B-MW 1234')!, /enter the vehicle's details yourself/);
  assert.match(lookupErrorMessage(new NetworkError()), /offline/);
  for (const code of ['invalid_registration', 'vehicle_not_found', 'rate_limited', 'lookup_not_configured', 'lookup_busy', 'lookup_unavailable', 'lookup_timeout', 'lookup_bad_response', 'something_new']) {
    assert.match(lookupErrorMessage(new ApiError(503, code, 'x')), /yourself/, code);
  }
  assert.match(lookupErrorMessage(new ApiError(503, 'lookup_not_configured', 'x')), /isn't connected/);
  assert.equal(parseUkRegistration('ab12 cde')?.registration, 'AB12CDE', 'shared module resolves from the app');
});

test("'other' fuel survives the server mapping", () => {
  const v = toVehicle({ id: 'v', clientRef: null, nickname: 'n', registration: '', make: '', model: '', year: null, colour: '', fuelType: 'other', engine: '', power: '', torque: '', zeroToSixty: '', topSpeedSpec: '', mileage: 0, visibility: 'private', isActive: false, coverPhotoId: null, coverPhotoUrl: null, createdAt: '', updatedAt: '' });
  assert.equal(v.fuelType, 'other');
});

test('the app build refuses anything that would put DVLA credentials in the bundle', () => {
  const appConfig = createRequire(import.meta.url)('../app.config.js') as (a: { config: object }) => object;
  const base = { config: { ios: { infoPlist: {} }, android: {}, plugins: [], extra: {} } };
  const saved = { ...process.env };
  try {
    for (const k of Object.keys(process.env)) if (k.startsWith('EXPO_PUBLIC_') || k === 'DVLA_API_KEY') delete process.env[k];
    assert.doesNotThrow(() => appConfig(base), 'a normal development build');
    process.env.EXPO_PUBLIC_DVLA_API_KEY = 'anything';
    assert.throws(() => appConfig(base), /EXPO_PUBLIC_DVLA_API_KEY .*DVLA credentials/);
    delete process.env.EXPO_PUBLIC_DVLA_API_KEY;
    // The key's value hidden under an innocent-looking public name.
    process.env.DVLA_API_KEY = 'secret-dvla-key-123';
    process.env.EXPO_PUBLIC_EXTRA = 'prefix-secret-dvla-key-123';
    assert.throws(() => appConfig(base), /EXPO_PUBLIC_EXTRA/);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

test('the app build refuses a Supabase secret, service-role key or database password in a public value', () => {
  const appConfig = createRequire(import.meta.url)('../app.config.js') as (a: { config: object }) => object;
  const base = { config: { ios: { infoPlist: {} }, android: {}, plugins: [], extra: {} } };
  // Built at runtime so no secret-shaped literal sits in the repository.
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const jwt = (role: string) => [b64({ alg: 'HS256' }), b64({ role }), 'sig'].join('.');
  const saved = { ...process.env };
  try {
    for (const k of Object.keys(process.env)) if (k.startsWith('EXPO_PUBLIC_')) delete process.env[k];
    Object.assign(process.env, {
      EXPO_PUBLIC_APP_ENV: 'staging',
      EXPO_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
      EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_' + 'abc',
      EXPO_PUBLIC_API_URL: 'https://api.example.invalid',
    });
    assert.doesNotThrow(() => appConfig(base), 'public values only');
    process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY = jwt('anon');
    assert.doesNotThrow(() => appConfig(base), 'a legacy anon key is public');
    for (const [name, value] of [
      ['EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'sb_' + 'secret_abc'],
      ['EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY', jwt('service_role')],
      ['EXPO_PUBLIC_DB', ['postgresql', '://postgres:pw@db.example.test:5432/postgres'].join('')],
    ] as const) {
      const before = process.env[name];
      process.env[name] = value;
      assert.throws(() => appConfig(base), new RegExp(`${name} holds a server secret`));
      if (before === undefined) delete process.env[name]; else process.env[name] = before;
    }
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

test('the motion purpose string stays true: the app never requests motion activity', async () => {
  // expo-location compiles Core Motion activity code into the iOS app, so App
  // Store Connect requires NSMotionUsageDescription. The string says the app
  // never requests it; these are the only calls that could show the prompt.
  const { readdir, readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const root = fileURLToPath(new URL('..', import.meta.url));
  const motionCalls = /\b(requestMotionActivityPermissionsAsync|getMotionActivityPermissionsAsync|getMotionActivityAsync|watchMotionActivityAsync)\b/;
  const offenders: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, e.name);
      if (e.isDirectory()) await walk(path);
      else if (/\.(ts|tsx|js)$/.test(e.name) && motionCalls.test(await readFile(path, 'utf8'))) offenders.push(path.slice(root.length));
    }
  };
  for (const dir of ['app', 'components', 'context', 'hooks', 'lib', 'constants']) await walk(join(root, dir));
  assert.deepEqual(offenders, [], 'a motion activity call needs a real purpose string in app.config.js first');

  const appConfig = createRequire(import.meta.url)('../app.config.js') as (a: { config: object }) => { ios: { infoPlist: Record<string, string> } };
  const plist = appConfig({ config: { ios: { infoPlist: {} }, android: {}, plugins: [], extra: {} } }).ios.infoPlist;
  assert.match(plist.NSMotionUsageDescription, /never requests it/);
});

import { shareInFlight } from '@/lib/shareInFlight';

test('location permission: concurrent requests share one answer', async () => {
  // Models expo-location's iOS requester: while the system prompt is open it
  // keeps only the latest caller, so an earlier caller never hears back.
  let calls = 0;
  let latest: ((status: string) => void) | null = null;
  const nativeRequest = () => { calls++; return new Promise<string>((resolve) => { latest = resolve; }); };
  const settled = (p: Promise<unknown>) => Promise.race([p.then(() => true), new Promise((r) => setTimeout(() => r(false), 20))]);

  // Before: the map's position watcher and compass each asked directly.
  const position = nativeRequest();
  const compass = nativeRequest();
  latest!('granted'); // the user taps Allow
  assert.equal(await settled(compass), true);
  assert.equal(await settled(position), false, 'the first caller is left waiting (no location on the map)');

  // After: both go through one shared request and both get the answer.
  calls = 0;
  const request = shareInFlight(nativeRequest);
  const a = request();
  const b = request();
  assert.equal(calls, 1, 'one native request while the prompt is open');
  latest!('granted');
  assert.deepEqual(await Promise.all([a, b]), ['granted', 'granted']);
  // Once answered, a later call asks again (e.g. after a change in Settings).
  const c = request();
  assert.equal(calls, 2);
  latest!('denied');
  assert.equal(await c, 'denied');
  // A failure reaches every waiting caller and doesn't block the next request.
  const failing = shareInFlight(() => Promise.reject(new Error('boom')));
  await Promise.all([assert.rejects(failing(), /boom/), assert.rejects(failing(), /boom/)]);
  await assert.rejects(failing(), /boom/);
});

test('location permission is only requested through the shared helper', async () => {
  const { readdir, readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const root = fileURLToPath(new URL('..', import.meta.url));
  const offenders: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, e.name);
      if (e.isDirectory()) await walk(path);
      else if (/\.(ts|tsx|js)$/.test(e.name) && path !== join(root, 'lib/locationPermission.ts')
        && /\.requestForegroundPermissionsAsync\(/.test(await readFile(path, 'utf8'))) offenders.push(path.slice(root.length));
    }
  };
  for (const dir of ['app', 'components', 'context', 'hooks', 'lib', 'constants']) await walk(join(root, dir));
  assert.deepEqual(offenders, [], 'use requestForegroundLocation() from lib/locationPermission');
});

// ─── Auth error classification and diagnostics ─────────────────────────────
import { AuthApiError, AuthRetryableFetchError, AuthUnknownError } from '@supabase/supabase-js';
import { authDiag, classifyAuthError, completeFromUrl, describeAuthError, describeRedirect, redact, setAuthDiagnostics, AuthFlowError } from '@/lib/backend/auth';

test('only a missing response counts as a connection problem', () => {
  assert.equal(classifyAuthError(new AuthRetryableFetchError('Network request failed', 0)).kind, 'offline');
  assert.match(describeAuthError(new AuthRetryableFetchError('Network request failed', 0)), /Can't reach the sign-in service/);
  // A real answer whose message happens to mention "fetch" or "network" is not "offline".
  const withFetchWord = new AuthApiError('Failed to fetch user from database', 500, 'unexpected_failure');
  assert.equal(classifyAuthError(withFetchWord).kind, 'service_unavailable');
  assert.match(describeAuthError(withFetchWord), /unexpected_failure, HTTP 500.*Failed to fetch user/);
  assert.doesNotMatch(describeAuthError(new AuthApiError('network policy denied', 403, 'not_admin')), /Can't reach/);
  assert.match(describeAuthError(new AuthRetryableFetchError('{}', 503)), /had a problem \(HTTP 503\)/);
});

test('Supabase error codes become specific messages; anything else shows the real reason', () => {
  assert.match(describeAuthError(new AuthApiError('User already registered', 422, 'user_already_exists')), /already exists/);
  assert.match(describeAuthError(new AuthApiError('Signups not allowed for this instance', 422, 'signup_disabled')), /not being accepted/);
  assert.match(describeAuthError(new AuthApiError('Unsupported provider: provider is not enabled', 400, 'validation_failed')), /Sign-in failed \(validation_failed, HTTP 400\): Unsupported provider/);
  assert.match(describeAuthError(new AuthApiError('Invalid login credentials', 400, undefined as unknown as string)), /don't match/);
  assert.match(describeAuthError(new AuthApiError('Database error saving new user', 500, 'unexpected_failure')), /Database error saving new user/);
  assert.match(describeAuthError(new AuthUnknownError('JSON Parse error', {})), /Sign-in failed.*JSON Parse error/);
  assert.equal(describeAuthError(new AuthFlowError('Apple did not return an identity token.')), 'Apple did not return an identity token.');
  assert.match(describeAuthError(new TypeError('undefined is not a function')), /Sign-in failed: undefined is not a function/);
});

test('diagnostics never contain tokens, keys, emails or full URLs', () => {
  const lines: string[] = [];
  setAuthDiagnostics((l) => lines.push(l));
  try {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJlLXNpZ25hdHVyZQ';
    const err = new AuthApiError(`Bad token ${jwt} for alex@example.com key sb_publishable_abc123def456 at https://ref.supabase.co/auth/v1/token?grant_type=password&code=secretcode123`, 400, 'bad_jwt');
    authDiag('sign in (email)', { outcome: 'failed', error: err, redirect: 'exp://192.168.1.20:8081/--/auth/callback?code=abcdef' });
    const line = lines.join('\n');
    assert.match(line, /\[auth\] sign in \(email\) outcome=failed redirect=exp:\/\/192\.168\.1\.20:8081\/--\/auth\/callback kind=rejected status=400 code=bad_jwt class=AuthApiError/);
    for (const secret of [jwt, 'alex@example.com', 'abc123def456', 'grant_type', 'secretcode123', 'code=abcdef']) {
      assert.ok(!line.includes(secret), `diagnostics must not include ${secret}`);
    }
    assert.match(line, /https:\/\/ref\.supabase\.co/);
  } finally {
    setAuthDiagnostics(null);
  }
  authDiag('nothing logged without a sink');
  assert.equal(lines.length, 1);
});

test('redirects are described without their query or fragment', () => {
  assert.equal(describeRedirect('exp://192.168.1.20:8081/--/auth/callback'), 'exp://192.168.1.20:8081/--/auth/callback');
  assert.equal(describeRedirect('exp://u.exp.direct/--/auth/callback?code=secret#access_token=t'), 'exp://u.exp.direct/--/auth/callback');
  assert.equal(describeRedirect('starscale-drive-staging://auth/callback'), 'starscale-drive-staging://auth/callback');
  assert.equal(describeRedirect('not a url'), '(not a URL)');
  assert.equal(redact('see http://host.example/path?token=abc'), 'see http://host.example');
});

test('a return link that arrives twice exchanges its code only once', async () => {
  let exchanges = 0;
  const client = { auth: { exchangeCodeForSession: async () => { exchanges++; return { data: { session: { access_token: 't' } }, error: null }; } } } as never;
  const url = 'exp://192.168.1.20:8081/--/auth/callback?code=same-code-1';
  const [a, b] = await Promise.all([completeFromUrl(client, url), completeFromUrl(client, url)]);
  assert.equal(exchanges, 1);
  assert.deepEqual(a, b);
  await assert.rejects(completeFromUrl(client, 'starscale-drive-staging://auth/callback?error_description=Access+denied'), /Access denied/);
});

import { enabledProviders } from '@/lib/backend/auth';

test('provider check reads public settings and fails open', async () => {
  const seen: string[] = [];
  const fetchOk = (async (url: string, init: RequestInit) => {
    seen.push(`${url} ${(init.headers as Record<string, string>).apikey}`);
    return new Response(JSON.stringify({ external: { email: true, google: false, apple: false } }), { status: 200 });
  }) as typeof fetch;
  assert.deepEqual(await enabledProviders('https://ref.supabase.co/', 'sb_publishable_x', fetchOk), { email: true, google: false, apple: false });
  assert.deepEqual(seen, ['https://ref.supabase.co/auth/v1/settings sb_publishable_x']);
  assert.equal(await enabledProviders('https://ref.supabase.co', 'k', (async () => { throw new TypeError('offline'); }) as typeof fetch), null);
  assert.equal(await enabledProviders('https://ref.supabase.co', 'k', (async () => new Response('nope', { status: 500 })) as typeof fetch), null);
});

// ─── Drive map follow camera ────────────────────────────────────────────────

import { buildFollowCamera, FollowZoomTarget, GESTURE_SETTLE_MS } from '@/lib/followCamera';

test('the follow target is only ever set explicitly, never from the map', () => {
  const target = new FollowZoomTarget({ zoom: 17, distance: 700 });
  const here = { latitude: 51.5, longitude: -0.12 };
  const sent: number[] = [];
  for (let i = 0; i < 200; i++) {
    const cam = buildFollowCamera(here, (i * 7) % 360, 0, target.current, 'ios');
    assert.equal(cam.zoom, undefined); // iOS states altitude only
    sent.push(cam.altitude!);
  }
  assert.ok(sent.every((a) => a === 700), 'altitude drifted');
  // There is no longer any way to write a reported camera into the target
  assert.equal((target as unknown as { settle?: unknown }).settle, undefined);
  const android = buildFollowCamera(here, 90, 0, target.current, 'android');
  assert.equal(android.zoom, 17);
  assert.equal(android.altitude, undefined);
});

test('the gesture window holds follow off, and resets clear it', () => {
  const target = new FollowZoomTarget({ zoom: 17, distance: 700 });
  target.touchStart(1000);
  assert.equal(target.gestureActive(1500), true); // follow holds off mid-gesture
  target.touchEnd(2000);
  assert.equal(target.gestureActive(2000 + GESTURE_SETTLE_MS), true);
  assert.equal(target.gestureActive(2000 + GESTURE_SETTLE_MS + 1), false);
  // A deliberate reset (resume following) closes the window
  target.touchStart(6000);
  target.clearGesture();
  target.set({ zoom: 17, distance: 700 });
  assert.equal(target.gestureActive(6001), false);
  assert.deepEqual(target.current, { zoom: 17, distance: 700 });
  // Junk is ignored, and the backstop limits hold whatever is asked for
  target.set({ distance: 0, zoom: Number.NaN });
  assert.deepEqual(target.current, { zoom: 17, distance: 700 });
  const bounded = new FollowZoomTarget({ zoom: 17, distance: 800 }, { min: 150, max: 5000 });
  bounded.set({ distance: 12_000_000 });
  assert.equal(bounded.current.distance, 5000);
  bounded.set({ distance: 1 });
  assert.equal(bounded.current.distance, 150);
});

// ─── Drive map live-position smoothing ──────────────────────────────────────

import {
  LocationSmoother, FollowCameraEaser, approachAngle, metersBetween, offsetMeters, lookAheadCenter,
  extrapolationSeconds, SMOOTHING, type LatLng,
} from '@/lib/locationSmoothing';

const START: LatLng = { latitude: 52.9225, longitude: -1.4746 };
const distM = (a: LatLng, b: LatLng) => { const d = metersBetween(a, b); return Math.hypot(d.x, d.y); };
// A car heading 60° at `speed` m/s, position at time t (ms)
const truthAt = (t: number, speed: number, course = 60) =>
  offsetMeters(START, speed * (t / 1000) * Math.sin(course * Math.PI / 180), speed * (t / 1000) * Math.cos(course * Math.PI / 180));
// Deterministic noise in [-1, 1)
const rand = (() => { let s = 7; return () => ((s = (s * 16807) % 2147483647) / 2147483647) * 2 - 1; })();

/** Drives the smoother at 60 fps; fixes are [arrivalMs, fix] pairs */
function simulateDrive(fixes: Array<[number, Parameters<LocationSmoother['addFix']>[0]]>, endMs: number) {
  const sm = new LocationSmoother();
  const frames: Array<{ t: number; p: LatLng }> = [];
  let next = 0;
  for (let t = 0; t <= endMs; t += 1000 / 60) {
    while (next < fixes.length && fixes[next]![0] <= t) sm.addFix(fixes[next]![1], fixes[next++]![0]);
    const p = sm.sample(t);
    if (p) frames.push({ t, p });
  }
  return { sm, frames };
}

test('at motorway speed the display glides with no per-fix jump and no lag', () => {
  const speed = 31; // ~70 mph
  const fixes: Array<[number, Parameters<LocationSmoother['addFix']>[0]]> = [];
  for (let t = 0; t <= 20_000; t += 1000) {
    const taken = t - 150; // delivered 150 ms after the fix was taken
    fixes.push([t, { ...truthAt(taken, speed), speed, course: 60, accuracy: 5, time: taken }]);
  }
  const { frames } = simulateDrive(fixes, 20_000);
  const frameM = speed / 60;
  let maxStep = 0, maxErr = 0;
  for (let i = 1; i < frames.length; i++) {
    maxStep = Math.max(maxStep, distM(frames[i - 1]!.p, frames[i]!.p));
    maxErr = Math.max(maxErr, distM(frames[i]!.p, truthAt(frames[i]!.t, speed)));
  }
  assert.ok(maxStep < frameM * 1.05, `jumped ${maxStep.toFixed(2)} m in one frame (steady ${frameM.toFixed(2)})`);
  assert.ok(maxErr < 0.5, `trailed the car by ${maxErr.toFixed(2)} m`);
});

test('irregular, noisy fixes still give continuous motion that tracks the GPS', () => {
  const speed = 13; // ~30 mph
  const fixes: Array<[number, Parameters<LocationSmoother['addFix']>[0]]> = [];
  let t = 0;
  while (t < 30_000) {
    const p = offsetMeters(truthAt(t, speed), rand() * 3, rand() * 3); // ±3 m GPS noise
    fixes.push([t, { ...p, speed: speed + rand() * 0.5, course: 60 + rand() * 3, accuracy: 6, time: t }]);
    t += 600 + Math.abs(rand()) * 1000; // 0.6–1.6 s gaps
  }
  const { frames } = simulateDrive(fixes, 30_000);
  const frameM = speed / 60;
  let maxStep = 0, maxErr = 0;
  for (let i = 1; i < frames.length; i++) {
    maxStep = Math.max(maxStep, distM(frames[i - 1]!.p, frames[i]!.p));
    if (frames[i]!.t > 2000) maxErr = Math.max(maxErr, distM(frames[i]!.p, truthAt(frames[i]!.t, speed)));
  }
  // A raw-fix display would hop ~13 m at each fix; corrections here are spread out
  assert.ok(maxStep < frameM * 2.5, `jumped ${maxStep.toFixed(2)} m in one frame`);
  assert.ok(maxErr < 6, `drifted ${maxErr.toFixed(2)} m from the true track`);
});

test('a parked car stays still through GPS jitter and the loop can rest', () => {
  const fixes: Array<[number, Parameters<LocationSmoother['addFix']>[0]]> = [];
  for (let t = 0; t <= 10_000; t += 1000) {
    fixes.push([t, { ...offsetMeters(START, rand() * 2.5, rand() * 2.5), speed: 0.2, course: Math.abs(rand()) * 359, accuracy: 8, time: t }]);
  }
  const { sm, frames } = simulateDrive(fixes, 10_000);
  const first = frames[0]!.p;
  assert.ok(frames.every((f) => distM(f.p, first) === 0), 'parked car moved');
  assert.equal(sm.isSettled(10_000), true);
  // Unknown speed and course (some Android fixes) is stationary too, not a guess
  const sm2 = new LocationSmoother();
  sm2.addFix({ ...START, speed: null, course: null, accuracy: 5, time: 0 }, 0);
  assert.deepEqual(sm2.sample(5000), START);
});

test('when fixes stop, the display coasts briefly then stops instead of driving on', () => {
  const speed = 20;
  const fixes: Array<[number, Parameters<LocationSmoother['addFix']>[0]]> = [];
  for (let t = 0; t <= 5000; t += 1000) fixes.push([t, { ...truthAt(t, speed), speed, course: 60, accuracy: 5, time: t }]);
  const { sm, frames } = simulateDrive(fixes, 15_000);
  const last = frames[frames.length - 1]!.p;
  const coasted = distM(truthAt(5000, speed), last);
  assert.ok(Math.abs(coasted - speed * extrapolationSeconds(Infinity)) < 0.01);
  assert.ok(coasted < speed * 2, `coasted ${coasted.toFixed(1)} m on no data`);
  assert.equal(sm.isSettled(15_000), true);
  // ...and velocity never jumps while it slows (no sudden stop)
  for (let i = 1; i < frames.length; i++) assert.ok(distM(frames[i - 1]!.p, frames[i]!.p) < (speed / 60) * 1.05);
});

test('a real relocation snaps; an ordinary correction blends and converges', () => {
  const sm = new LocationSmoother();
  assert.equal(sm.addFix({ ...START, speed: 0, course: null, accuracy: 5, time: 0 }, 0), 'snap');
  const far = offsetMeters(START, 2000, 0);
  assert.equal(sm.addFix({ ...far, speed: 0, course: null, accuracy: 5, time: 1000 }, 1000), 'snap');
  assert.deepEqual(sm.sample(1000), far);
  const near = offsetMeters(far, 0, 20);
  assert.equal(sm.addFix({ ...near, speed: 0, course: null, accuracy: 5, time: 2000 }, 2000), 'blend');
  assert.ok(distM(sm.sample(2000)!, far) < 1e-6, 'a new fix must not move the display instantly');
  assert.ok(distM(sm.sample(2000 + SMOOTHING.correctionTauMs * 10)!, near) < SMOOTHING.settledM);
  assert.equal(sm.isSettled(2000 + SMOOTHING.correctionTauMs * 10), true);
});

test('heading easing turns the short way round north', () => {
  let h = 350;
  for (let i = 0; i < 5; i++) {
    h = approachAngle(h, 10, 16, 250);
    assert.ok(h > 349 || h < 11, `went the long way: ${h}`);
  }
  assert.ok(Math.abs(approachAngle(350, 10, 10_000, 250) - 10) < 1e-6);
});

test('the follow camera adds no lag when following and eases in from a panned map', () => {
  const target = (position: LatLng, heading = 60) =>
    ({ position, heading, pitch: 50, distance: 700, zoom: 17, lookAheadM: 80 });
  const cam = new FollowCameraEaser();
  assert.equal(cam.step(target(START), 16), null); // unseeded: hands off
  // Resume from a map panned 400 m away, flat and zoomed out
  cam.seed({ center: offsetMeters(START, 400, 0), heading: 0, pitch: 0, altitude: 2000 }, target(START));
  let prev = cam.step(target(START), 16)!.pose;
  let settledAt = -1;
  for (let i = 1; i < 200 && settledAt < 0; i++) {
    const s = cam.step(target(START), 16)!;
    // An exponential ease moves 400·(1−e^(−16/280)) ≈ 22 m in its first frame
    assert.ok(distM(prev.center, s.pose.center) < 30, 'recentring jumped');
    prev = s.pose;
    if (s.settled) settledAt = i;
  }
  assert.ok(settledAt > 0 && settledAt * 16 < 3000, `took ${settledAt * 16} ms to settle`);
  // Settled: the camera is exactly the target, so steady following has no lag
  let pos = START;
  for (let i = 0; i < 120; i++) {
    pos = offsetMeters(pos, 0.3, 0.2);
    const { pose } = cam.step(target(pos, 60 + i * 0.5), 16)!;
    assert.ok(distM(pose.center, lookAheadCenter(pos, 60 + i * 0.5, 80)) < 1e-6);
    assert.equal(pose.heading, 60 + i * 0.5);
    assert.equal(pose.distance, 700); // heading changes never touch zoom
    assert.equal(pose.pitch, 50);
  }
  // A seed thousands of metres away jumps rather than smearing across the map
  const far = new FollowCameraEaser();
  far.seed({ center: offsetMeters(START, 50_000, 0) }, target(START));
  assert.ok(distM(far.step(target(START), 16)!.pose.center, lookAheadCenter(START, 60, 80)) < 1e-6);
});

// ─── Drive map navigation camera ────────────────────────────────────────────

import { NAV_CAMERA, navPitch, lookAheadForSpeed } from '@/lib/navigationCamera';
import { altitudeForDistance, distanceForAltitude } from '@/lib/followCamera';

test('the navigation camera tilts heading-up only, and never on maps that cannot tilt', () => {
  assert.equal(navPitch(true, 'standard'), NAV_CAMERA.pitchDeg);
  assert.equal(navPitch(true, 'mutedStandard'), NAV_CAMERA.pitchDeg);
  assert.equal(navPitch(false, 'standard'), 0);
  assert.equal(navPitch(true, 'satellite'), 0);
  assert.equal(navPitch(true, 'hybrid'), 0);
  // MapKit flattens a 60° camera beyond roughly 800 m; keep tuning inside that
  if (NAV_CAMERA.pitchDeg >= 60) assert.ok(NAV_CAMERA.distanceM <= 800);
});

test('look-ahead grows gently with speed between its limits', () => {
  const { minM, maxM, slowKmh, fastKmh } = NAV_CAMERA.lookAhead;
  assert.equal(lookAheadForSpeed(0), minM);
  assert.equal(lookAheadForSpeed(slowKmh), minM);
  assert.equal(lookAheadForSpeed(fastKmh), maxM);
  assert.equal(lookAheadForSpeed(200), maxM);
  let prev = minM, maxStep = 0;
  for (let k = 0; k <= 200; k += 1) {
    const l = lookAheadForSpeed(k);
    assert.ok(l >= prev - 1e-9, 'look-ahead must not shrink as speed rises');
    maxStep = Math.max(maxStep, l - prev);
    prev = l;
  }
  // No jump anywhere: at most ~1 m per km/h
  assert.ok(maxStep < 1, `look-ahead jumped ${maxStep.toFixed(2)} m for 1 km/h`);
});

test('the camera centre sits ahead of the vehicle, and the vehicle stays above the drive panel', () => {
  const pos = START;
  for (const heading of [0, 90, 213, 359]) {
    const c = lookAheadCenter(pos, heading, 40);
    const d = metersBetween(pos, c);
    const bearing = (Math.atan2(d.x, d.y) * 180 / Math.PI + 360) % 360;
    assert.ok(Math.abs(((bearing - heading + 540) % 360) - 180) < 0.01, `centre not ahead at ${heading}°`);
    assert.ok(Math.abs(Math.hypot(d.x, d.y) - 40) < 0.01);
  }
  // Where the vehicle lands on screen: the angle below the centre of view,
  // mapped through a field of view.  MapKit doesn't publish its FOV, so check a
  // plausible 30–45° range against the panel (top ≈ 62% down an iPhone 17 Pro,
  // 874 pt) with room for the 60 pt marker frame.
  const pitch = NAV_CAMERA.pitchDeg * Math.PI / 180;
  const alt = altitudeForDistance(NAV_CAMERA.distanceM, NAV_CAMERA.pitchDeg);
  const toCentre = alt * Math.tan(pitch);
  for (const lookAhead of [NAV_CAMERA.lookAhead.minM, NAV_CAMERA.lookAhead.maxM]) {
    const below = pitch - Math.atan((toCentre - lookAhead) / alt);
    assert.ok(below > 0, 'vehicle should draw below the centre');
    for (const fovDeg of [30, 37, 45]) {
      const y = 0.5 + Math.tan(below) / (2 * Math.tan((fovDeg / 2) * Math.PI / 180));
      assert.ok(y + 30 / 874 < 0.62, `marker reaches the panel at fov ${fovDeg}° (y=${y.toFixed(3)})`);
    }
  }
});

test('tilting keeps the camera distance; altitude is derived from it', () => {
  assert.ok(Math.abs(altitudeForDistance(800, 60) - 400) < 1e-9);
  assert.ok(Math.abs(distanceForAltitude(400, 60) - 800) < 1e-9);
  assert.equal(altitudeForDistance(700, 0), 700);
  const cam = new FollowCameraEaser();
  const target = { position: START, heading: 30, pitch: 60, distance: 800, zoom: 16.5, lookAheadM: 25 };
  // Resume from a flat, panned map at 700 m altitude
  cam.seed({ center: offsetMeters(START, 120, -80), heading: 0, pitch: 0, altitude: 700 }, target);
  let pitchPrev = 0, settled = false;
  for (let i = 0; i < 300 && !settled; i++) {
    const s = cam.step(target, 16)!;
    assert.ok(s.pose.pitch >= pitchPrev - 1e-9, 'tilt should only rise toward the target');
    assert.ok(s.pose.pitch - pitchPrev < 5, 'tilt jumped');
    pitchPrev = s.pose.pitch;
    // The camera never sits farther out than the larger of start and target,
    // so MapKit's distance-based pitch limit is never crossed on the way in
    assert.ok(s.pose.distance <= 800 + 1e-6);
    settled = s.settled;
  }
  assert.ok(settled);
  const final = cam.step(target, 16)!.pose;
  assert.equal(final.pitch, 60);
  assert.equal(final.distance, 800);
  assert.ok(distM(final.center, lookAheadCenter(START, 30, 25)) < 1e-6);
  assert.equal(buildFollowCamera(final.center, final.heading, final.pitch, final, 'ios').altitude, altitudeForDistance(800, 60));
});

// ─── Follow camera: runaway zoom regression ─────────────────────────────────
// The device bug: during and after Continue Following, every heading change
// zoomed the map out a little more, until a whole country was in view.  These
// drive the follow controller exactly as the Drive screen does, against a fake
// MapKit that reports a tilted camera's altitude back *wrong* (as its distance,
// i.e. doubled at 60°).  Any read-back into follow state would show as drift.

import { FollowCameraController, type FollowFrameTarget } from '@/lib/followController';

class FakeMapKit {
  camera = { center: START, heading: 0, pitch: 0, altitude: 0 };
  reads = 0;
  writes = 0;
  setCamera(c: { center: LatLng; heading: number; pitch: number; altitude?: number }) {
    this.writes++;
    this.camera = { center: c.center, heading: c.heading, pitch: c.pitch, altitude: c.altitude! };
  }
  /** Reports altitude as if it were the centre distance: wrong when tilted */
  getCamera() {
    this.reads++;
    const c = this.camera;
    return { ...c, altitude: c.altitude / Math.cos((c.pitch * Math.PI) / 180) };
  }
}

const NAV = { distance: NAV_CAMERA.distanceM, pitch: NAV_CAMERA.pitchDeg };
const navTarget = (position: LatLng, heading: number): FollowFrameTarget =>
  ({ position, heading, pitch: NAV.pitch, lookAheadM: NAV_CAMERA.lookAhead.minM });

/** One frame, the way the Drive screen's loop runs it */
function followFrame(ctl: FollowCameraController, map: FakeMapKit, target: FollowFrameTarget, gesture = false) {
  const f = ctl.frame(target, 16, gesture);
  if (f.kind === 'needsSeed') {
    const token = ctl.beginSeed();
    if (token != null) ctl.completeSeed(token, map.getCamera(), target);
    return null;
  }
  if (f.kind === 'paused') return null;
  map.setCamera(buildFollowCamera(f.pose.center, f.pose.heading, f.pose.pitch, f.pose, 'ios'));
  return f;
}

function newController() {
  return new FollowCameraController(
    { zoom: NAV_CAMERA.androidZoom, distance: NAV_CAMERA.distanceM },
    { min: NAV_CAMERA.minDistanceM, max: NAV_CAMERA.maxDistanceM },
  );
}

/** Following and fully settled at the navigation camera */
function settledFollowing() {
  const ctl = newController();
  const map = new FakeMapKit();
  map.camera = { center: START, heading: 0, pitch: NAV.pitch, altitude: altitudeForDistance(NAV.distance, NAV.pitch) };
  ctl.enter(false);
  for (let i = 0; i < 400; i++) followFrame(ctl, map, navTarget(START, 0));
  const f = ctl.frame(navTarget(START, 0), 16, false);
  assert.ok(f.kind === 'camera' && f.settled);
  return { ctl, map };
}

const NAV_ALTITUDE = altitudeForDistance(NAV_CAMERA.distanceM, NAV_CAMERA.pitchDeg);

test('heading changes while following change only the heading', () => {
  const { ctl, map } = settledFollowing();
  const readsBefore = map.reads;
  for (const heading of [0, 45, 90, 180, 270, 359, 1, 120, 300]) {
    for (let i = 0; i < 30; i++) {
      const f = followFrame(ctl, map, navTarget(START, heading))!;
      assert.equal(f.pose.distance, NAV.distance, `distance moved at ${heading}°`);
      assert.equal(f.pose.pitch, NAV.pitch, `pitch moved at ${heading}°`);
      assert.equal(f.pose.heading, heading);
      assert.equal(map.camera.altitude, NAV_ALTITUDE, `altitude sent moved at ${heading}°`);
    }
  }
  assert.equal(map.reads, readsBefore, 'following must never read the map camera back');
});

test('heading changes during Continue Following do not interrupt or undo the zoom-in', () => {
  const ctl = newController();
  const map = new FakeMapKit();
  // The user zoomed right out and panned away: most of the Earth in view
  map.camera = { center: offsetMeters(START, 900_000, 400_000), heading: 37, pitch: 0, altitude: 12_000_000 };
  ctl.enter(false); // Continue Following from free mode
  followFrame(ctl, map, navTarget(START, 0)); // the one camera read
  assert.equal(map.reads, 1);
  let prev = Infinity, prevPitch = -Infinity, frames = 0, settled = false;
  for (let i = 0; i < 2000 && !settled; i++) {
    // Rapid, erratic heading changes the whole way in
    const heading = (i * 73 + (i % 3) * 140) % 360;
    // Continue Following pressed again part-way, and a drive starting: both
    // re-assert follow mode, and must carry on rather than restart
    if (i === 10 || i === 20) ctl.enter(true);
    const f = followFrame(ctl, map, navTarget(START, heading))!;
    assert.ok(f.pose.distance <= prev + 1e-6, `zoomed back out at frame ${i}: ${prev} → ${f.pose.distance}`);
    assert.ok(f.pose.pitch >= prevPitch - 1e-9, `tilt went backwards at frame ${i}`);
    prev = f.pose.distance;
    prevPitch = f.pose.pitch;
    settled = f.settled;
    frames = i;
  }
  assert.ok(settled, 'transition never finished');
  assert.ok(frames * 16 < 6000, `took ${frames * 16} ms`);
  assert.equal(prev, NAV.distance);
  assert.equal(prevPitch, NAV.pitch);
  assert.equal(map.camera.altitude, NAV_ALTITUDE);
  assert.equal(map.reads, 1, 'the transition must not re-read the map camera');
});

test('hundreds of alternating heading changes and taps never drift the scale', () => {
  const { ctl, map } = settledFollowing();
  const readsBefore = map.reads;
  const headings = [0, 180, 359, 1, 90, 270];
  for (let i = 0; i < 3000; i++) {
    // A tap on the map every so often: follow pauses, then resumes
    const tapping = i % 250 >= 200 && i % 250 < 210;
    const f = followFrame(ctl, map, navTarget(START, headings[i % headings.length]!), tapping);
    if (!f) continue;
    assert.equal(f.pose.distance, NAV.distance, `distance drifted at frame ${i}`);
    assert.equal(f.pose.pitch, NAV.pitch);
    assert.equal(map.camera.altitude, NAV_ALTITUDE, `altitude drifted at frame ${i}`);
  }
  assert.equal(map.reads, readsBefore);
});

test('moving and turning together keep the navigation distance', () => {
  const { ctl, map } = settledFollowing();
  const sm = new LocationSmoother();
  const speed = 18;
  let course = 10;
  for (let t = 0; t <= 60_000; t += 1000 / 60) {
    if (Math.round(t) % 1000 < 17) {
      course = (course + 23) % 360; // a winding road
      sm.addFix({ ...truthAt(t, speed, course), speed, course, accuracy: 5, time: t }, t);
    }
    const p = sm.sample(t)!;
    const f = followFrame(ctl, map, navTarget(p, course))!;
    assert.equal(f.pose.distance, NAV.distance);
    assert.equal(f.pose.pitch, NAV.pitch);
    assert.equal(map.camera.altitude, NAV_ALTITUDE);
  }
});

test('a camera read from an earlier entry into follow mode is never applied', () => {
  const ctl = newController();
  const target = navTarget(START, 0);
  ctl.enter(false);
  assert.equal(ctl.frame(target, 16, false).kind, 'needsSeed');
  const stale = ctl.beginSeed()!;
  assert.equal(ctl.beginSeed(), null, 'one read per entry');
  // The user pans away (follow ends) and presses Continue Following again
  ctl.leave();
  ctl.enter(false);
  // The first read lands late, carrying a zoomed-out camera: dropped
  assert.equal(ctl.completeSeed(stale, { center: START, pitch: 0, altitude: 9_000_000 }, target), false);
  assert.equal(ctl.isSeeded, false);
  const fresh = ctl.beginSeed()!;
  assert.equal(ctl.completeSeed(fresh, { center: START, pitch: 0, altitude: 900 }, target), true);
  assert.equal(ctl.completeSeed(fresh, { center: START, pitch: 0, altitude: 9_000_000 }, target), false);
});

// ─── Drive map location arrow perspective ───────────────────────────────────

import { markerPerspective, MARKER_PERSPECTIVE } from '@/lib/markerPerspective';

test('the location arrow lies flat on the map as it tilts, and is unchanged top-down', () => {
  const flat = markerPerspective(0);
  assert.deepEqual(flat, { scaleY: 1, edgeLift: 0, shadowLift: MARKER_PERSPECTIVE.shadowBasePt });
  // The navigation camera's tilt: foreshortened, with a visible side wall
  const nav = markerPerspective(NAV_CAMERA.pitchDeg);
  const tilt = NAV_CAMERA.pitchDeg * MARKER_PERSPECTIVE.tiltFactor;
  assert.ok(Math.abs(nav.scaleY - Math.cos((tilt * Math.PI) / 180)) < 1e-9);
  assert.ok(nav.scaleY > 0.6 && nav.scaleY < 0.75, `scaleY ${nav.scaleY} would read poorly`);
  assert.ok(nav.edgeLift > 1 && nav.shadowLift > flat.shadowLift);
  // Steeper always means flatter on screen, never a jump
  let prev = flat;
  for (let p = 1; p <= 90; p++) {
    const v = markerPerspective(p);
    assert.ok(v.scaleY <= prev.scaleY && v.edgeLift >= prev.edgeLift);
    assert.ok(prev.scaleY - v.scaleY < 0.03);
    prev = v;
  }
  // Out-of-range or junk pitch never produces a broken marker
  assert.ok(markerPerspective(500).scaleY >= Math.cos((MARKER_PERSPECTIVE.maxTiltDeg * Math.PI) / 180) - 1e-9);
  assert.deepEqual(markerPerspective(Number.NaN), flat);
  assert.deepEqual(markerPerspective(-20), flat);
});

// ─── Map rotation, heading smoothing, minimum drive length ──────────────────

import { HeadingFilter, HEADING_FILTER, LatestReader, markerScreenRotation } from '@/lib/headingFilter';
import { MIN_DRIVE_MS, isLongEnoughToSave } from '@/lib/backend/journeyRecorder';
import { angleDelta } from '@/lib/locationSmoothing';

test('the arrow stays locked to the map while the user rotates it', async () => {
  // A drive heading 75°, the user spinning the map through a full turn.  The
  // camera is read asynchronously (getCamera); each read lands a frame later.
  const heading = 75;
  let mapBearing = 0;            // what MapKit is showing right now
  let arrowBearing = 0;          // the bearing the arrow was last drawn against
  let reads = 0;
  const reader = new LatestReader(
    // Like getCamera: the camera is captured when the read runs, delivered later
    () => { reads++; const b = mapBearing; return new Promise<number>((r) => setTimeout(() => r(b), 0)); },
    (b) => { arrowBearing = b; },
  );
  const flush = async () => { for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 1)); };
  let prevRotation = markerScreenRotation(heading, 0);
  for (let frame = 0; frame < 120; frame++) {
    // The gesture turns the map 3° a frame, reported in two region changes
    mapBearing = (mapBearing + 1.5) % 360;
    reader.request();
    mapBearing = (mapBearing + 1.5) % 360;
    reader.request();                       // arrives while the first read is out
    await flush();
    const rotation = markerScreenRotation(heading, arrowBearing);
    // Live: by the end of each frame the arrow is on the map's latest bearing
    assert.equal(arrowBearing, mapBearing, `frame ${frame}: arrow drawn against a stale bearing`);
    assert.ok(Math.abs(angleDelta(prevRotation, rotation)) <= 3.01, `arrow jumped at frame ${frame}`);
    prevRotation = rotation;
  }
  assert.ok(reads <= 2 * 120, 'reads never pile up');
  // Letting go: the settle read lands on what's already drawn — no correction
  await flush(); await flush();
  const before = markerScreenRotation(heading, arrowBearing);
  reader.request();
  await flush(); await flush();
  assert.ok(Math.abs(angleDelta(before, markerScreenRotation(heading, arrowBearing))) < 1e-9);
  assert.equal(arrowBearing, mapBearing);
  // Correct relative to the map at any bearing
  for (const [h, b, want] of [[0, 0, 0], [90, 0, 90], [90, 90, 0], [10, 350, 20], [350, 10, 340], [180, 270, 270], [0, 359, 1]]) {
    assert.equal(markerScreenRotation(h!, b!), want, `heading ${h} on map ${b}`);
  }
});

test('turning the phone gives one smooth, prompt arrow rotation', () => {
  const f = new HeadingFilter();
  let seed = 11;
  const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 0.6; // ±0.3°
  let truth = 10;
  f.update(truth, 'compass');
  let prev = f.value, maxStep = 0, maxLag = 0, backwards = 0, restMin = Infinity, restMax = -Infinity, restStep = 0;
  for (let t = 0; t < 3500; t += 1000 / 60) {
    truth = 10 + 90 * Math.min(t / 1000, 2); // turning at 90°/s for 2 s, then still
    if (Math.round(t) % 20 < 17) f.update(truth + noise(), 'compass'); // ~50 Hz readings
    const v = f.step(1000 / 60);
    const d = angleDelta(prev, v);
    if (t < 2000 && d < -1e-9) backwards++;
    maxStep = Math.max(maxStep, Math.abs(d));
    if (t > 200 && t < 2000) maxLag = Math.max(maxLag, Math.abs(angleDelta(v, truth)));
    if (t > 2700) { restMin = Math.min(restMin, v); restMax = Math.max(restMax, v); restStep = Math.max(restStep, Math.abs(d)); }
    prev = v;
  }
  assert.equal(backwards, 0, 'the arrow twitched backwards while turning');
  assert.ok(maxStep < (90 / 60) * 2, `jumped ${maxStep.toFixed(2)}° in a frame`);
  assert.ok(maxLag < 20, `trailed the phone by ${maxLag.toFixed(1)}°`);
  // Once the phone stops, sensor noise can't make it visibly wobble or snap
  assert.ok(restMax - restMin < 0.7, `wobbled ${(restMax - restMin).toFixed(2)}° at rest`);
  assert.ok(restStep < 0.1, `snapped ${restStep.toFixed(3)}° at rest`);
  // Held still: sensor noise doesn't move it, and it comes to rest
  const rest = new HeadingFilter();
  rest.update(120, 'compass');
  for (let i = 0; i < 200; i++) {
    rest.update(120 + noise(), 'compass');
    rest.step(16);
  }
  assert.equal(rest.value, 120);
  assert.ok(rest.settled);
  assert.ok(HEADING_FILTER.compassNoiseDeg < 0.5, 'the noise gate must stay below what the eye can see');
});

test('heading wraps across north the short way, from either sensor', () => {
  for (const source of ['compass', 'course'] as const) {
    const f = new HeadingFilter();
    f.update(355, source);
    f.update(5, source);
    for (let i = 0; i < 200; i++) {
      const v = f.step(16);
      assert.ok(v >= 354.999 || v <= 5.001, `${source} went the long way: ${v}`);
    }
    assert.equal(f.value, 5);
  }
  // GPS course arriving once a second becomes a continuous turn, not steps
  const g = new HeadingFilter();
  g.update(0, 'course');
  let prev = 0, maxStep = 0;
  for (let t = 0; t < 5000; t += 1000 / 60) {
    if (Math.round(t) % 1000 < 17) g.update((t / 1000) * 12, 'course'); // 12°/s turn
    const v = g.step(1000 / 60);
    maxStep = Math.max(maxStep, Math.abs(angleDelta(prev, v)));
    prev = v;
  }
  assert.ok(maxStep < 1, `course step drew a ${maxStep.toFixed(2)}° jump`);
});

test('map bearing and heading changing together give the right arrow rotation', () => {
  const f = new HeadingFilter();
  f.update(30, 'compass');
  for (let i = 0; i < 60; i++) f.step(16);
  // Heading-up following: the map's bearing is the drawn heading, so the arrow
  // points straight up however the heading moves
  for (const h of [30, 31, 45, 359, 2, 180]) {
    f.update(h, 'compass');
    for (let i = 0; i < 5; i++) {
      const v = f.step(16);
      assert.equal(markerScreenRotation(v, v), 0);
    }
  }
  // Exploring: the user turns the map while the phone also turns
  const g = new HeadingFilter();
  g.update(100, 'compass');
  let bearing = 0;
  for (let i = 0; i < 100; i++) {
    g.update(100 + i * 0.8, 'compass');
    const v = g.step(16);
    bearing = (bearing + 2) % 360;
    const r = markerScreenRotation(v, bearing);
    assert.ok(Math.abs(angleDelta(r, v - bearing)) < 1e-9);
  }
});

// A drive as the Drive screen runs it: driving and paused segments, the
// on-screen timer counting whole seconds of driving only, Pause/Resume noted on
// the record, and End Drive gated on that timer (under 10 s: discard).
type Segment = { drive: number } | { pause: number };

async function driveSegments(segments: Segment[], opts: { offline?: boolean; loseReply?: boolean } = {}) {
  const server = new FakeServer();
  const store = new MemoryStore();
  const clock = { t: Date.now() - 10 * 60_000 };
  const app = makeSync(server, store, clock);
  await app.start();
  server.offline = !!opts.offline;
  server.loseNextStartReply = !!opts.loseReply;
  await app.startDrive(null);
  await new Promise((r) => setTimeout(r, 5)); // the start-of-drive upload
  const start = clock.t;
  let activeMs = 0;
  for (const seg of segments) {
    if ('pause' in seg) {
      app.setDrivePaused(true);
      clock.t += seg.pause; // paused: no fixes are recorded, the timer stops
      app.setDrivePaused(false);
      continue;
    }
    const until = clock.t + seg.drive;
    while (clock.t < until) {
      const step = Math.min(1000, until - clock.t);
      clock.t += step;
      activeMs += step;
      app.addFix({ latitude: 51.5 + (clock.t - start) * 1e-7, longitude: -0.1, speedMs: 12, accuracyM: 5, timestamp: clock.t });
    }
  }
  const timerSeconds = Math.floor(activeMs / 1000); // what the drive timer shows
  const result = isLongEnoughToSave(timerSeconds * 1000)
    ? { saved: true as const, journey: await app.endDrive() }
    : (await app.discardDrive(), { saved: false as const });
  await app.outbox.flush();
  return { server, store, app, clock, result, wallMs: clock.t - start, timerSeconds };
}

const driveFor = (ms: number, opts?: { offline?: boolean; loseReply?: boolean }) => driveSegments([{ drive: ms }], opts);

async function assertNothingKept(d: Awaited<ReturnType<typeof driveFor>>) {
  assert.equal(d.result.saved, false);
  assert.equal(d.app.isDriving, false);
  assert.equal(d.app.data.journeys.length, 0, 'not in drive history');
  assert.equal(d.app.status.pendingJourneys, 0, 'nothing waiting to upload');
  const active = await d.store.getItem('@driveos/u/u1/journey/active');
  assert.ok(active == null || JSON.parse(active) == null, 'no drive left on the device');
  assert.deepEqual(JSON.parse((await d.store.getItem('@driveos/u/u1/journey/pending')) ?? '[]'), []);
  assert.equal(d.server.journeys.length, 0, 'no journey left on the server');
}

test('drives under 10 seconds are not saved anywhere', async () => {
  assert.equal(MIN_DRIVE_MS, 10_000);
  for (const ms of [5000, 9900]) {
    const d = await driveFor(ms);
    await assertNothingKept(d);
    assert.equal(d.server.deletedJourneys.length, 1, 'the journey created at drive start is deleted');
  }
});

test('drives of 10 seconds or more save as normal', async () => {
  for (const ms of [10_000, 15_000]) {
    const d = await driveFor(ms);
    assert.equal(d.result.saved, true, `${ms} ms should save`);
    assert.ok(d.result.saved && d.result.journey);
    assert.equal(d.server.journeys.length, 1);
    assert.equal(d.server.journeys[0]!.status, 'completed');
    assert.equal(d.server.deletedJourneys.length, 0);
  }
});

test('a short drive leaves nothing behind even offline, or after a lost server reply', async () => {
  // Offline the whole time: nothing reached the server, nothing kept locally
  const offline = await driveFor(4000, { offline: true });
  offline.server.offline = false;
  await offline.app.outbox.flush();
  await assertNothingKept(offline);
  // The server stored the journey but its reply never came back: still found and removed
  const lost = await driveFor(6000, { loseReply: true });
  await assertNothingKept(lost);
  assert.equal(lost.server.deletedJourneys.length, 1);
  // Ending a short drive any other way is refused too (backstop in endDrive)
  const d = await driveFor(20_000);
  const server = new FakeServer();
  const clock = { t: Date.now() - 60_000 };
  const app = makeSync(server, new MemoryStore(), clock);
  await app.start();
  await app.startDrive(null);
  await new Promise((r) => setTimeout(r, 5));
  clock.t += 3000;
  assert.equal(await app.endDrive(), null);
  await app.outbox.flush();
  assert.equal(server.journeys.length, 0);
  assert.equal(app.data.journeys.length, 0);
  assert.equal(d.result.saved, true);
});

test('a short drive cut off by the app being killed is not saved on restart, and its server journey is left alone', async () => {
  const server = new FakeServer();
  const store = new MemoryStore();
  const clock = { t: Date.now() - 60_000 };
  const app = makeSync(server, store, clock);
  await app.start();
  await app.startDrive(null);
  await new Promise((r) => setTimeout(r, 5));
  for (let s = 0; s < 4; s++) { clock.t += 1000; app.addFix({ latitude: 51.5 + s * 1e-4, longitude: -0.1, speedMs: 12, accuracyM: 5, timestamp: clock.t }); }
  await new Promise((r) => setTimeout(r, 5));
  // Killed here.  On the next launch:
  const again = makeSync(server, store, clock);
  await again.start();
  await again.outbox.flush();
  assert.equal(again.status.pendingJourneys, 0);
  assert.equal(again.data.journeys.length, 0);
  // Recovery can't prove from the device's copy (which may be missing its
  // last seconds) that the drive was short, so it deletes nothing on the
  // server: the journey is left for the orphan check, which only finishes it
  // if its own points show a real drive (here they don't)
  assert.equal(server.deletedJourneys.length, 0, 'nothing deleted during recovery');
  assert.equal(server.journeys.length, 1);
  assert.equal(server.journeys[0]!.status, 'active');
});

test('paused time does not count toward the 10-second minimum', async () => {
  // Drive 4 s, pause 20 s, drive 3 s: 27 s on the clock, 7 s driven
  const d = await driveSegments([{ drive: 4000 }, { pause: 20_000 }, { drive: 3000 }]);
  assert.equal(d.wallMs, 27_000);
  assert.equal(d.timerSeconds, 7);
  await assertNothingKept(d);
  // Long pauses either side of a short drive change nothing
  const e = await driveSegments([{ pause: 60_000 }, { drive: 9000 }, { pause: 60_000 }]);
  assert.equal(e.wallMs, 129_000);
  await assertNothingKept(e);
});

test('exactly 10 seconds of active driving saves, however long the pauses', async () => {
  const d = await driveSegments([{ drive: 4000 }, { pause: 20_000 }, { drive: 6000 }]);
  assert.equal(d.timerSeconds, 10);
  assert.equal(d.result.saved, true);
  assert.ok(d.result.saved && d.result.journey);
  assert.equal(d.server.journeys[0]!.status, 'completed');
  assert.equal(d.server.deletedJourneys.length, 0);
});

test('the save backstop and crash recovery also count only active time', async () => {
  const server = new FakeServer();
  const clock = { t: Date.now() - 60 * 60_000 };
  let step = 0;
  const drive = (app: CloudSync, ms: number) => {
    for (let s = 0; s < ms; s += 1000) { clock.t += 1000; app.addFix({ latitude: 51.5 + ++step * 1e-4, longitude: -0.1, speedMs: 12, accuracyM: 5, timestamp: clock.t }); }
  };
  // endDrive itself refuses 7 s of driving spread over 27 s
  const a = makeSync(server, new MemoryStore(), clock);
  await a.start();
  await a.startDrive(null);
  await new Promise((r) => setTimeout(r, 5));
  drive(a, 4000); a.setDrivePaused(true); clock.t += 20_000; a.setDrivePaused(false); drive(a, 3000);
  assert.equal(a.activeDriveMs(), 7000);
  assert.equal(await a.endDrive(), null);
  await a.outbox.flush();
  assert.equal(server.journeys.length, 0);
  // Ending while still paused: the open pause doesn't count either
  const b = makeSync(server, new MemoryStore(), clock);
  await b.start();
  await b.startDrive(null);
  drive(b, 6000); b.setDrivePaused(true); clock.t += 30_000;
  assert.equal(b.activeDriveMs(), 6000);
  assert.equal(await b.endDrive(), null);
  // The app killed during a pause after 7 s of driving: discarded on restart,
  // because the pause was saved on the device with the drive
  const store = new MemoryStore();
  const c = makeSync(server, store, clock);
  await c.start();
  await c.startDrive(null);
  await new Promise((r) => setTimeout(r, 5));
  drive(c, 4000); c.setDrivePaused(true); clock.t += 20_000; c.setDrivePaused(false); drive(c, 3000);
  await new Promise((r) => setTimeout(r, 5));
  const restarted = makeSync(server, store, clock);
  const deletedBefore = server.deletedJourneys.length;
  await restarted.start();
  await restarted.outbox.flush();
  assert.equal(restarted.status.pendingJourneys, 0);
  // Not saved, but not deleted from the server during recovery either
  assert.equal(server.deletedJourneys.length, deletedBefore);
  assert.ok(server.journeys.every((j) => j.status === 'active'));
  // ...while 14 s of driving with the same pause is kept.  (Recovery can only
  // count up to the last point saved on the device, every 5 s while driving.)
  const store2 = new MemoryStore();
  const e = makeSync(server, store2, clock);
  await e.start();
  await e.startDrive(null);
  await new Promise((r) => setTimeout(r, 5));
  drive(e, 6000); e.setDrivePaused(true); clock.t += 20_000; e.setDrivePaused(false); drive(e, 8000);
  await new Promise((r) => setTimeout(r, 5));
  const restarted2 = makeSync(server, store2, clock);
  await restarted2.start();
  assert.equal(restarted2.status.pendingJourneys, 1);
});

// ─── Drive marker and live trail ────────────────────────────────────────────

import { LiveTrailHead, LIVE_TRAIL } from '@/lib/liveTrail';
import { readFileSync } from 'node:fs';
import { fileURLToPath as toPath } from 'node:url';

/**
 * A drive as the Drive screen's frame loop runs it: each frame the smoothed
 * position goes to the marker and to the live trail head; each GPS fix is
 * recorded raw (the trail and the saved journey) and restarts the head.
 */
function liveDrive(seconds: number, speed = 15, onFrame?: (f: { t: number; marker: LatLng; head: LatLng[] | null; recorded: LatLng[] }) => void) {
  const sm = new LocationSmoother();
  const trail = new LiveTrailHead();
  const recorded: LatLng[] = [];
  let course = 40;
  let pos = START;
  let marker: LatLng | null = null;
  let head: LatLng[] | null = null;
  for (let t = 0; t <= seconds * 1000; t += 1000 / 60) {
    if (Math.round(t) % 1000 < 17) {
      // A gentle bend: a second's travel along the course, then turn 9°
      if (t > 0) pos = offsetMeters(pos, speed * Math.sin((course * Math.PI) / 180), speed * Math.cos((course * Math.PI) / 180));
      course = (course + 9) % 360;
      const raw = pos;
      sm.addFix({ ...raw, speed, course, accuracy: 5, time: t }, t);
      recorded.push(raw);
      trail.recordedPoint(raw);
    }
    const p = sm.sample(t)!;
    marker = p;
    head = trail.frame(p);
    onFrame?.({ t, marker, head, recorded });
  }
  return { sm, trail, recorded, marker: marker!, head };
}

test('the live trail head runs from the last recorded fix to exactly where the marker is', () => {
  let frames = 0;
  liveDrive(10, 15, ({ marker, head, recorded }) => {
    frames++;
    assert.ok(head && head.length >= 2 || (head && head.length === 1 && distM(head[0]!, marker) === 0));
    // Same source: the trail meets the marker, no gap
    assert.deepEqual(head!.at(-1), { latitude: marker.latitude, longitude: marker.longitude });
    // ...and starts on the trail's last recorded point
    assert.deepEqual(head![0], recorded.at(-1));
  });
  assert.ok(frames > 500);
});

test('between fixes the head moves smoothly; each fix restarts it cleanly', () => {
  const speed = 20;
  let prevEnd: LatLng | null = null;
  let prevAnchor: LatLng | null = null;
  let maxStep = 0, restarts = 0;
  liveDrive(12, speed, ({ head }) => {
    const end = head!.at(-1)!;
    if (prevEnd) maxStep = Math.max(maxStep, distM(prevEnd, end));
    if (prevAnchor && distM(prevAnchor, head![0]!) > 0) {
      restarts++;
      // The new head starts at the new fix and carries no trace from before it
      assert.ok(head!.length <= 3, `stale trace kept: ${head!.length} points`);
    }
    prevEnd = end;
    prevAnchor = head![0]!;
  });
  assert.ok(maxStep < (speed / 60) * 1.6, `head end jumped ${maxStep.toFixed(2)} m in a frame`);
  assert.ok(restarts >= 10, 'every fix should restart the head');
});

test('the head follows bends rather than cutting a straight line to the marker', () => {
  const trail = new LiveTrailHead();
  trail.recordedPoint(START);
  // The marker drives a quarter circle (radius 40 m) after the fix
  let head: LatLng[] | null = null;
  for (let i = 1; i <= 30; i++) {
    const a = (i / 30) * (Math.PI / 2);
    head = trail.frame(offsetMeters(START, 40 * (1 - Math.cos(a)), 40 * Math.sin(a)));
  }
  assert.ok(head!.length > 8, 'the bend is traced');
  for (const p of head!) assert.ok(Math.abs(distM(p, offsetMeters(START, 40, 0)) - 40) < 0.5, 'off the curve');
  // A lost signal can't grow it without limit
  for (let i = 0; i < 1000; i++) trail.frame(offsetMeters(START, 50 + i * 5, 0));
  assert.ok(trail.frame(offsetMeters(START, 6000, 0))!.length <= LIVE_TRAIL.maxTracePoints + 2);
});

test('the live head never reaches recorded or saved drive data', async () => {
  // Raw fixes recorded during a drive with the live head running alongside
  const { recorded } = liveDrive(15);
  const copy = recorded.map((p) => ({ ...p }));
  assert.deepEqual(recorded, copy, 'recorded points untouched');
  // Through CloudSync: the saved journey's points are exactly the raw fixes kept
  const server = new FakeServer();
  const clock = { t: Date.now() - 60_000 };
  const app = makeSync(server, new MemoryStore(), clock);
  await app.start();
  await app.startDrive(null);
  const trail = new LiveTrailHead();
  const sm = new LocationSmoother();
  const fixes: LatLng[] = [];
  for (let s = 0; s < 20; s++) {
    clock.t += 1000;
    const raw = offsetMeters(START, 0, s * 15);
    fixes.push(raw);
    app.addFix({ ...raw, speedMs: 15, accuracyM: 5, timestamp: clock.t });
    sm.addFix({ ...raw, speed: 15, course: 0, accuracy: 5, time: clock.t }, clock.t);
    trail.recordedPoint(raw);
    for (let f = 0; f < 60; f++) trail.frame(sm.sample(clock.t + f * 16)!);
  }
  const rec = app.activeRecord!;
  for (const p of rec.points) {
    assert.ok(fixes.some((f) => Math.abs(f.latitude - p.latitude) < 1e-12 && Math.abs(f.longitude - p.longitude) < 1e-12), 'a saved point that was never a GPS fix');
  }
  const journey = await app.endDrive();
  assert.ok(journey);
  assert.equal(server.points.get(server.journeys[0]!.id), rec.points.length, 'only raw points uploaded');
  // Ending (or pausing) the drive clears the head entirely
  trail.reset();
  assert.equal(trail.frame(START), null);
});

test('the Drive screen keeps its marker mounted and positions it by native command', () => {
  const src = readFileSync(toPath(new URL('../app/(tabs)/(drive)/index.tsx', import.meta.url)), 'utf8');
  // Mounted on the first fix, not on drive state
  const mount = src.match(/\{([^{}]*)&&\s*\(\s*<UserMarker/);
  assert.ok(mount, 'UserMarker render not found');
  assert.equal(mount![1]!.trim(), 'userLocation');
  // No longer an AnimatedRegion pushed with setNativeProps (React reverted it
  // on every trail update during a drive)
  assert.ok(!/MarkerAnimated|AnimatedRegion\(/.test(src.replace(/\/\/.*$/gm, '')));
  assert.ok(/markerRef\.current\?\.setCoordinates\(position\)/.test(src));
  // The live head is drawn from the same per-frame position as the marker
  assert.ok(/liveTrail\.update\(\s*position,/.test(src));
  // The marker comes first among the map's children; annotation views sit
  // above every overlay in MapKit, so the trail can't cover it
  const children = src.slice(src.indexOf('<MapView'), src.indexOf('</MapView>'));
  assert.ok(children.indexOf('<UserMarker') < children.indexOf('<Polyline'));
  assert.ok(children.indexOf('<UserMarker') < children.indexOf('<LiveTrailHeadLines'));
});

// ─── Tilting the map while following ────────────────────────────────────────

import { classifyFollowGesture, FOLLOW_GESTURE } from '@/lib/followController';

// The camera as MapKit might report it, either way it might report a tilted
// camera's altitude: as eye height, or as the distance itself
const reported = (pitch: number, opts: { center?: LatLng; heading?: number; distance?: number; altitudeIsDistance?: boolean } = {}) => {
  const distance = opts.distance ?? NAV_CAMERA.distanceM;
  return {
    center: opts.center ?? START,
    heading: opts.heading ?? 30,
    pitch,
    altitude: opts.altitudeIsDistance ? distance : altitudeForDistance(distance, pitch),
  };
};

test('a tilt is told apart from panning, rotating and pinching', () => {
  for (const altitudeIsDistance of [false, true]) {
    const start = reported(60, { altitudeIsDistance });
    // Tilting only, either way, by a little or a lot
    for (const p of [50, 45, 70, 30]) {
      assert.equal(classifyFollowGesture(start, reported(p, { altitudeIsDistance })), 'pitch', `tilt to ${p}°`);
    }
    // Sensor-level noise isn't a gesture
    assert.equal(classifyFollowGesture(start, reported(60.2, { altitudeIsDistance, heading: 31 })), 'none');
    // Panning away
    assert.equal(classifyFollowGesture(start, reported(60, { altitudeIsDistance, center: offsetMeters(START, 60, 0) })), 'explore');
    // Rotating the map
    assert.equal(classifyFollowGesture(start, reported(60, { altitudeIsDistance, heading: 45 })), 'explore');
    // Pinch-zooming in or out (current design: leaves follow mode)
    assert.equal(classifyFollowGesture(start, reported(60, { altitudeIsDistance, distance: 1300 })), 'explore');
    assert.equal(classifyFollowGesture(start, reported(60, { altitudeIsDistance, distance: 450 })), 'explore');
    // Tilting while panning is still exploring
    assert.equal(classifyFollowGesture(start, reported(50, { altitudeIsDistance, center: offsetMeters(START, 0, 80) })), 'explore');
  }
});

test('a tilt while following keeps following at the new tilt, at the same distance', () => {
  const { ctl, map } = settledFollowing();
  ctl.setUserPitch(50);
  assert.equal(ctl.followPitch, 50);
  let prev: { pitch: number } | null = null;
  for (let i = 0; i < 120; i++) {
    const f = followFrame(ctl, map, navTarget(offsetMeters(START, 0, i * 0.3), (i * 2) % 360))!;
    assert.equal(f.pose.pitch, 50, 'the chosen tilt is kept, with no ease back to 60°');
    assert.equal(f.pose.distance, NAV_CAMERA.distanceM);
    assert.equal(map.camera.altitude, altitudeForDistance(NAV_CAMERA.distanceM, 50));
    prev = f.pose;
  }
  assert.ok(prev);
  // Out-of-range picks are held to what the camera supports
  ctl.setUserPitch(89);
  assert.equal(ctl.followPitch, FOLLOW_GESTURE.maxPitchDeg);
});

test('repeated tilts never move the follow distance', () => {
  const { ctl, map } = settledFollowing();
  for (let i = 0; i < 300; i++) {
    ctl.setUserPitch(i % 2 ? 72 : 41);
    for (let f = 0; f < 3; f++) {
      const frame = followFrame(ctl, map, navTarget(START, (i * 7) % 360))!;
      assert.equal(frame.pose.distance, NAV_CAMERA.distanceM, `distance moved at tilt ${i}`);
    }
  }
  assert.equal(ctl.zoom.current.distance, NAV_CAMERA.distanceM);
});

test('Continue Following comes back at the tilt the user picked; flat views stay flat', () => {
  const { ctl, map } = settledFollowing();
  ctl.setUserPitch(48);
  // The user pans away (follow ends), then presses Continue Following
  ctl.leave();
  map.camera = { center: offsetMeters(START, 500, 200), heading: 0, pitch: 20, altitude: 3000 };
  ctl.enter(false);
  let last = null as null | { pitch: number; distance: number };
  for (let i = 0; i < 400; i++) last = followFrame(ctl, map, navTarget(START, 0))?.pose ?? last;
  assert.equal(last!.pitch, 48);
  assert.equal(last!.distance, NAV_CAMERA.distanceM);
  // North-up (or satellite) asks for a flat camera, which the chosen tilt doesn't override
  const flat = followFrame(ctl, map, { ...navTarget(START, 0), pitch: 0 })!;
  for (let i = 0; i < 200; i++) followFrame(ctl, map, { ...navTarget(START, 0), pitch: 0 });
  assert.equal(followFrame(ctl, map, { ...navTarget(START, 0), pitch: 0 })!.pose.pitch, 0);
  assert.ok(flat);
});

test('the Drive screen judges gestures by what they did, not by the pan callback alone', () => {
  const src = readFileSync(toPath(new URL('../app/(tabs)/(drive)/index.tsx', import.meta.url)), 'utf8');
  const body = (name: string) => {
    const i = src.indexOf(`const ${name} = useCallback(`);
    return src.slice(i, src.indexOf('\n  }, [', i));
  };
  // MapKit's tilt fires onPanDrag, so it can't leave follow mode by itself
  assert.ok(!/leave\(|setFollowMode\("free"\)/.test(body('handleMapPanDrag')));
  // A settling gesture defers to the camera reads instead of always leaving
  assert.ok(/gestureActive\(now\)\)\s*\{\s*readMapBearing\(\);\s*return;/.test(body('handleRegionChangeComplete')));
  // Exploring leaves follow mode; a tilt sets the follow pitch
  assert.ok(/followCamera\.judgeGesture\(start, cam\)/.test(src));
  assert.ok(/followCamera\.setUserPitch\(cam\.pitch\)/.test(src));
});

// ─── Background recording during a drive ───────────────────────────────────
import {
  ALWAYS_PROMPT_SHOWN_KEY, BackgroundDriveRecorder, DRIVE_SESSION_KEY, ensureBackgroundAccess,
  type BackgroundTracking, type LocationPermissions, type LocationUpdates,
} from '@/lib/backend/driveTracking';
import { RESUME_DRIVE_WITHIN_MS } from '@/lib/backend/cloudSync';
import { appendLiveFix, liveDriveFromRecord, newLiveDrive } from '@/lib/backend/liveDrive';
import type { ActiveDrive } from '@/lib/backend/model';

/** The platform's background location updates, as the OS would run them. */
class FakeUpdates implements LocationUpdates {
  running = false;
  starts = 0;
  stops = 0;
  answer: Exclude<BackgroundTracking, 'off'> | 'throw' = 'on';
  async start() {
    this.starts++;
    if (this.answer === 'throw') throw new Error('Background location has not been configured');
    if (this.answer === 'on') this.running = true;
    return this.answer;
  }
  async stop() { this.stops++; this.running = false; }
  async isRunning() { return this.running; }
}

function backgroundApp(store = new MemoryStore(), clock = { t: Date.now() - 60 * 60_000 }, updates = new FakeUpdates(), server = new FakeServer()) {
  const tracker = new BackgroundDriveRecorder({ store, updates, now: () => clock.t });
  let id = 0;
  const app = new CloudSync({
    ep: server.ep(), store, userId: 'u1', publishableKey: 'sb_publishable_x', newId: () => `id-${++id}-${Math.random()}`,
    timezone: () => 'UTC', now: () => clock.t, tracker,
    prepareFile: async () => ({ body: new Uint8Array([1]), size: 1, mimeType: 'image/jpeg' }),
  });
  // The live route the Drive screen draws (AppContext builds it the same way)
  const live = { drive: null as ActiveDrive | null };
  app.onDriveFix((fix) => { if (live.drive) live.drive = appendLiveFix(live.drive, fix); });
  return { app, tracker, updates, store, clock, server, live };
}

/** One fix a second along a road heading north at 15 m/s (54 km/h). */
function roadFix(clock: { t: number }, s: number): GpsFix {
  return { latitude: 51.5 + (s * 15) / 111_320, longitude: -0.1, speedMs: 15, accuracyM: 5, timestamp: clock.t };
}
const settle = () => new Promise((r) => setTimeout(r, 5));

test('starting a drive starts background updates for that drive; ending it stops them', async () => {
  const b = backgroundApp();
  await b.app.start();
  assert.equal(b.updates.running, false, 'nothing runs before a drive');
  await b.app.startDrive(null);
  await settle();
  assert.equal(b.updates.running, true);
  assert.equal(b.app.status.backgroundTracking, 'on');
  const session = JSON.parse((await b.store.getItem(DRIVE_SESSION_KEY))!);
  assert.deepEqual(session, { userId: 'u1', clientRef: b.app.activeRecord!.clientRef });
  for (let s = 0; s < 30; s++) { b.clock.t += 1000; b.app.addFix(roadFix(b.clock, s)); }
  await b.app.endDrive();
  assert.equal(b.updates.running, false, 'stopped when the drive ends');
  assert.equal(b.app.status.backgroundTracking, 'off');
  assert.equal(await b.store.getItem(DRIVE_SESSION_KEY), null, 'background session cleared');
  // A late batch from the OS after the end records nothing (and stops updates)
  b.clock.t += 1000;
  await b.tracker.deliver([roadFix(b.clock, 31)]);
  assert.equal(b.app.isDriving, false);
  assert.equal(b.server.journeys[0]!.status, 'completed');
});

test('discarding a drive, or one too short to save, also stops background updates', async () => {
  const b = backgroundApp();
  await b.app.start();
  await b.app.startDrive(null);
  await settle();
  await b.app.discardDrive();
  assert.equal(b.updates.running, false);
  await b.app.startDrive(null);
  await settle();
  b.clock.t += 3000;
  assert.equal(await b.app.endDrive(), null, 'too short');
  assert.equal(b.updates.running, false);
});

test('ending a drive while background updates are still starting leaves nothing running', async () => {
  const b = backgroundApp();
  await b.app.start();
  await b.app.startDrive(null); // start() of the updates is still in flight
  await b.app.discardDrive();
  await settle();
  assert.equal(b.updates.running, false);
});

test('background fixes enter the same recorder as the screen, with no gap in the route', async () => {
  const b = backgroundApp();
  await b.app.start();
  await b.app.startDrive(null);
  b.live.drive = newLiveDrive(b.clock.t);
  await settle();
  // 60 s on screen, then 5 minutes in another app, then back on screen.
  let s = 0;
  for (; s < 60; s++) { b.clock.t += 1000; b.app.addFix(roadFix(b.clock, s)); }
  for (; s < 360; s += 5) {
    // The OS batches background fixes every few seconds
    const batch = [];
    for (let k = 0; k < 5; k++) { b.clock.t += 1000; batch.push(roadFix(b.clock, s + k)); }
    await b.tracker.deliver(batch);
  }
  for (; s < 420; s++) { b.clock.t += 1000; b.app.addFix(roadFix(b.clock, s)); }
  const rec = b.app.activeRecord!;
  // Every stored point is within ~3 s / 45 m of the last: no straight-line jump
  for (let i = 1; i < rec.points.length; i++) {
    const gap = distanceM(rec.points[i - 1]!, rec.points[i]!);
    assert.ok(gap < 100, `point ${i} jumps ${gap.toFixed(0)} m`);
  }
  const expectedKm = (419 * 15) / 1000;
  assert.ok(Math.abs(rec.clientDistanceKm - expectedKm) < 0.1, `recorded ${rec.clientDistanceKm} km`);
  assert.equal(b.live.drive!.coordinates.length, 420, 'the live route has every fix, background ones included');
  assert.ok(Math.abs(b.live.drive!.estimatedDistance - expectedKm) < 0.05, `live ${b.live.drive!.estimatedDistance} km`);
  // Drive time is from timestamps, so it counts the time in the background too
  assert.equal(b.app.activeDriveMs(), 420_000);
});

test('the same fix from the screen and the background is counted once', async () => {
  const b = backgroundApp();
  await b.app.start();
  await b.app.startDrive(null);
  b.live.drive = newLiveDrive(b.clock.t);
  await settle();
  // On screen both location sources report every fix (background slightly later)
  for (let s = 0; s < 120; s++) {
    b.clock.t += 1000;
    const fix = roadFix(b.clock, s);
    b.app.addFix(fix);
    await b.tracker.deliver([{ ...fix }]);
    // A copy stamped a fraction of a second apart is the same fix too
    b.app.addFix({ ...fix, timestamp: fix.timestamp + 200 });
  }
  // A late background batch with fixes the screen already delivered
  await b.tracker.deliver([roadFix({ t: b.clock.t - 3000 }, 117), roadFix({ t: b.clock.t - 2000 }, 118)]);
  const rec = b.app.activeRecord!;
  const expectedKm = (119 * 15) / 1000;
  assert.ok(Math.abs(rec.clientDistanceKm - expectedKm) < 0.05, `recorded ${rec.clientDistanceKm} km, expected ${expectedKm}`);
  assert.equal(b.live.drive!.coordinates.length, 120);
  assert.ok(Math.abs(b.live.drive!.estimatedDistance - expectedKm) < 0.01);
  const times = rec.points.map((p) => p.recordedAt);
  assert.equal(new Set(times).size, times.length, 'no point stored twice');
  // ...and uploaded once
  await b.app.endDrive();
  assert.equal(b.server.points.get(b.server.journeys[0]!.id), rec.points.length);
});

test('a paused drive records no points from either source', async () => {
  const b = backgroundApp();
  await b.app.start();
  await b.app.startDrive(null);
  b.live.drive = newLiveDrive(b.clock.t);
  await settle();
  let s = 0;
  for (; s < 30; s++) { b.clock.t += 1000; b.app.addFix(roadFix(b.clock, s)); }
  const before = b.app.activeRecord!.points.length;
  const liveBefore = b.live.drive!.coordinates.length;
  b.app.setDrivePaused(true);
  assert.equal(b.updates.running, true, 'updates keep running while paused (resuming needs no restart)');
  for (; s < 90; s++) {
    b.clock.t += 1000;
    b.app.addFix(roadFix(b.clock, s));
    await b.tracker.deliver([roadFix(b.clock, s)]);
  }
  assert.equal(b.app.activeRecord!.points.length, before, 'nothing stored while paused');
  assert.equal(b.live.drive!.coordinates.length, liveBefore, 'nothing added to the route while paused');
  b.app.setDrivePaused(false);
  for (; s < 100; s++) { b.clock.t += 1000; await b.tracker.deliver([roadFix(b.clock, s)]); }
  assert.ok(b.app.activeRecord!.points.length > before, 'recording resumes');
  assert.equal(b.app.activeDriveMs(), 40_000, 'paused time not counted');
});

test('passenger mode records nothing from the background either', async () => {
  const b = backgroundApp();
  await b.app.start();
  await b.app.startDrive(null);
  await settle();
  b.app.setPassengerMode(true);
  for (let s = 0; s < 30; s++) { b.clock.t += 1000; await b.tracker.deliver([roadFix(b.clock, s)]); }
  assert.equal(b.app.activeRecord!.points.length, 0);
});

test('fixes recorded with the app relaunched in the background are kept, and the drive carries on once', async () => {
  const store = new MemoryStore();
  const clock = { t: Date.now() - 60 * 60_000 };
  const updates = new FakeUpdates();
  const server = new FakeServer();
  const first = backgroundApp(store, clock, updates, server);
  await first.app.start();
  await first.app.startDrive(null);
  await settle();
  let s = 0;
  for (; s < 60; s++) { clock.t += 1000; first.app.addFix(roadFix(clock, s)); }
  await first.app.saveActiveNow(); // the app went to the background
  const clientRef = first.app.activeRecord!.clientRef;
  // iOS ends the app; later it relaunches it in the background to deliver
  // locations.  No screens: a fresh recorder with no CloudSync.
  const headless = new BackgroundDriveRecorder({ store, updates, now: () => clock.t });
  for (; s < 300; s += 5) {
    const batch = [];
    for (let k = 0; k < 5; k++) { clock.t += 1000; batch.push(roadFix(clock, s + k)); }
    await headless.deliver(batch);
  }
  // The user opens the app (same process): the drive is picked up, not ended
  const tracker = headless;
  const app = new CloudSync({
    ep: server.ep(), store, userId: 'u1', publishableKey: 'sb_publishable_x', newId: () => `id-${Math.random()}`,
    timezone: () => 'UTC', now: () => clock.t, tracker,
    prepareFile: async () => ({ body: new Uint8Array([1]), size: 1, mimeType: 'image/jpeg' }),
  });
  await app.start();
  assert.equal(app.isDriving, true, 'still driving');
  assert.equal(app.activeRecord!.clientRef, clientRef, 'the same drive, not a new one');
  assert.equal(app.status.pendingJourneys, 0, 'not finished as an interrupted drive');
  assert.equal(app.status.backgroundTracking, 'on');
  const rec = app.activeRecord!;
  const lastPointS = Math.round((rec.points.at(-1)!.latitude - 51.5) * 111_320 / 15);
  assert.ok(lastPointS >= 295, `background fixes up to the relaunch are in the drive (last at ${lastPointS} s)`);
  for (let i = 1; i < rec.points.length; i++) assert.ok(distanceM(rec.points[i - 1]!, rec.points[i]!) < 100, 'no gap');
  // The screen rebuilds the live route from the stored points
  const live = liveDriveFromRecord(rec);
  assert.equal(live.coordinates.length, rec.points.length);
  assert.ok(Math.abs(live.estimatedDistance - (lastPointS * 15) / 1000) < 0.1);
  // Fixes the background delivered before the hand-over aren't counted again
  const kmBefore = rec.clientDistanceKm;
  app.addFix(roadFix({ t: clock.t - 2000 }, 298));
  assert.equal(rec.clientDistanceKm, kmBefore);
  for (; s < 330; s++) { clock.t += 1000; await tracker.deliver([roadFix(clock, s)]); }
  await app.endDrive();
  assert.equal(server.journeys.length, 1, 'one journey on the server');
  assert.equal(server.journeys[0]!.status, 'completed');
  assert.equal(updates.running, false);
});

test('a relaunch with no background updates running finishes the drive as before', async () => {
  const store = new MemoryStore();
  const clock = { t: Date.now() - 60 * 60_000 };
  const updates = new FakeUpdates();
  const server = new FakeServer();
  const first = backgroundApp(store, clock, updates, server);
  await first.app.start();
  await first.app.startDrive(null);
  await settle();
  for (let s = 0; s < 60; s++) { clock.t += 1000; first.app.addFix(roadFix(clock, s)); }
  await first.app.saveActiveNow();
  updates.running = false; // e.g. location access turned off, or the OS stopped them
  const again = backgroundApp(store, clock, updates, server);
  await again.app.start();
  assert.equal(again.app.isDriving, false);
  assert.equal(again.app.status.pendingJourneys, 1, 'saved as an interrupted drive');
  assert.equal(await store.getItem(DRIVE_SESSION_KEY), null);
});

test('a relaunch long after the drive went quiet finishes it and stops the updates', async () => {
  const store = new MemoryStore();
  const clock = { t: Date.now() - 3 * 60 * 60_000 };
  const updates = new FakeUpdates();
  const first = backgroundApp(store, clock, updates);
  await first.app.start();
  await first.app.startDrive(null);
  await settle();
  for (let s = 0; s < 60; s++) { clock.t += 1000; first.app.addFix(roadFix(clock, s)); }
  await first.app.saveActiveNow();
  // Force-quit: no fixes for an hour, then the app is opened
  clock.t += RESUME_DRIVE_WITHIN_MS + 60_000;
  const again = backgroundApp(store, clock, updates);
  await again.app.start();
  assert.equal(again.app.isDriving, false);
  assert.equal(again.app.status.pendingJourneys, 1);
  assert.equal(updates.running, false, 'no background tracking left running');
});

test('background updates found running with no drive in progress are stopped', async () => {
  const store = new MemoryStore();
  const updates = new FakeUpdates();
  updates.running = true; // left over from a crash
  const b = backgroundApp(store, undefined, updates);
  await b.app.start();
  assert.equal(updates.running, false);
  // ...and a stray background batch with no drive stops them too
  updates.running = true;
  await b.tracker.deliver([roadFix(b.clock, 0)]);
  assert.equal(updates.running, false);
});

test('without background access the drive still records on screen', async () => {
  for (const answer of ['denied', 'always-declined', 'always-off', 'unavailable', 'throw'] as const) {
    const updates = new FakeUpdates();
    updates.answer = answer;
    const b = backgroundApp(undefined, undefined, updates);
    await b.app.start();
    await b.app.startDrive(null);
    await settle();
    assert.equal(b.app.status.backgroundTracking, answer === 'throw' ? 'unavailable' : answer);
    assert.equal(b.updates.running, false, `${answer}: no background updates`);
    assert.equal(await b.store.getItem(DRIVE_SESSION_KEY), null);
    for (let s = 0; s < 30; s++) { b.clock.t += 1000; b.app.addFix(roadFix(b.clock, s)); }
    assert.ok(b.app.activeRecord!.points.length > 5, `${answer}: foreground recording unaffected`);
    assert.ok(await b.app.endDrive());
  }
});

test('the background task is defined at the app entry, before any screen loads', async () => {
  const { readFile } = await import('node:fs/promises');
  const root = fileURLToPath(new URL('..', import.meta.url));
  const pkg = JSON.parse(await readFile(`${root}/package.json`, 'utf8'));
  assert.equal(pkg.main, 'index.js');
  const entry = await readFile(`${root}/index.js`, 'utf8');
  const lines = entry.split('\n').filter((l) => l.startsWith('import '));
  assert.deepEqual(lines, ["import './lib/diagnostics';", "import './lib/driveBackgroundLocation';", "import 'expo-router/entry';"]);
  const task = await readFile(`${root}/lib/driveBackgroundLocation.ts`, 'utf8');
  assert.match(task, /^\s*TaskManager\.defineTask/m, 'defineTask at module scope');
  assert.match(task, /pausesUpdatesAutomatically: false/);
  // The background location mode is in the build, with the "Always" purpose strings
  const app = JSON.parse(await readFile(`${root}/app.json`, 'utf8'));
  const [, opts] = app.expo.plugins.find((p: unknown) => Array.isArray(p) && p[0] === 'expo-location');
  assert.equal(opts.isIosBackgroundLocationEnabled, true);
  assert.notEqual(opts.locationAlwaysAndWhenInUsePermission, false, 'the plugin must not delete the Always string');
  const appConfig = createRequire(import.meta.url)('../app.config.js') as (a: { config: object }) => { ios: { infoPlist: Record<string, string> } };
  const plist = appConfig({ config: { ios: { infoPlist: {} }, android: {}, plugins: [], extra: {} } }).ios.infoPlist;
  assert.match(plist.NSLocationAlwaysAndWhenInUseUsageDescription, /drive you've started/);
  assert.match(plist.NSLocationAlwaysUsageDescription, /drive you've started/);
  assert.ok(plist.NSLocationWhenInUseUsageDescription);
});

test('"Always" is asked for only through the shared helper', async () => {
  const { readdir, readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const root = fileURLToPath(new URL('..', import.meta.url));
  const offenders: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, e.name);
      if (e.isDirectory()) await walk(path);
      else if (/\.(ts|tsx|js)$/.test(e.name) && path !== join(root, 'lib/locationPermission.ts')
        && /\.requestBackgroundPermissionsAsync\(/.test(await readFile(path, 'utf8'))) offenders.push(path.slice(root.length));
    }
  };
  for (const dir of ['app', 'components', 'context', 'hooks', 'lib', 'constants']) await walk(join(root, dir));
  assert.deepEqual(offenders, [], 'use requestBackgroundLocation() from lib/locationPermission');
});

/** expo-location's permissions as iOS answers them. */
class FakePermissions implements LocationPermissions {
  foreground: 'undetermined' | 'granted' | 'denied' = 'granted';
  always = false;
  /** What the user picks if the "Always" prompt appears; null = iOS shows none (e.g. Allow Once) */
  pick: 'always' | 'keep-while-using' | null = 'keep-while-using';
  foregroundPrompts = 0;
  backgroundPrompts = 0;
  calls: string[] = [];
  async requestForeground() {
    this.calls.push('foreground');
    if (this.foreground === 'undetermined') { this.foregroundPrompts++; this.foreground = 'granted'; }
    return this.foreground === 'granted';
  }
  async hasBackground() { return this.always; }
  async requestBackground() {
    this.calls.push('background');
    if (this.pick === null) return { granted: false, promptShown: false };
    this.backgroundPrompts++;
    this.always = this.pick === 'always';
    this.pick = null; // iOS shows it once per install
    return { granted: this.always, promptShown: true };
  }
}

test('first drive: foreground is asked first, then "Always" once', async () => {
  const store = new MemoryStore();
  const p = new FakePermissions();
  p.foreground = 'undetermined';
  p.pick = 'always';
  assert.equal(await ensureBackgroundAccess(p, store), 'granted');
  assert.deepEqual(p.calls, ['foreground', 'background'], 'foreground before background');
  assert.equal(p.backgroundPrompts, 1);
  // Later drives: already Always, no prompt
  assert.equal(await ensureBackgroundAccess(p, store), 'granted');
  assert.equal(p.backgroundPrompts, 1);
});

test('declining "Always" asks once, then never again (Settings can still turn it on)', async () => {
  const store = new MemoryStore();
  const p = new FakePermissions();
  assert.equal(await ensureBackgroundAccess(p, store), 'always-declined');
  // Every later drive, even after a relaunch (expo-location forgets it asked): no request at all
  for (let i = 0; i < 5; i++) assert.equal(await ensureBackgroundAccess(p, store), 'always-off');
  assert.deepEqual(p.calls.filter((c) => c === 'background'), ['background'], 'requested once');
  // The user turns on Always in Settings
  p.always = true;
  assert.equal(await ensureBackgroundAccess(p, store), 'granted');
});

test('no foreground access: nothing asked for in the background', async () => {
  const p = new FakePermissions();
  p.foreground = 'denied';
  assert.equal(await ensureBackgroundAccess(p, new MemoryStore()), 'denied');
  assert.deepEqual(p.calls, ['foreground']);
});

test('"Allow Once": iOS shows no Always prompt, so it is asked again on a later drive', async () => {
  const store = new MemoryStore();
  const p = new FakePermissions();
  p.pick = null; // temporary access: iOS ignores the Always request
  assert.equal(await ensureBackgroundAccess(p, store), 'always-off');
  assert.equal(await store.getItem(ALWAYS_PROMPT_SHOWN_KEY), null);
  // Next launch the user picks "While Using the App": the first drive asks
  p.pick = 'always';
  assert.equal(await ensureBackgroundAccess(p, store), 'granted');
  assert.equal(p.backgroundPrompts, 1);
});

// ─── Mapbox Drive map ───────────────────────────────────────────────────────
// The same follow controller drives Mapbox, which states zoom (not altitude).
// A fake Mapbox map reports its camera back with a small error on every
// change, as a real map can mid-animation; nothing may feed it back.

import {
  mapboxSettings, mapboxStyleFor, mapboxFollowCamera, reportedPoseFromMapbox,
  trailFeatureCollection, clampMapboxZoom, MAPBOX_PUBLIC_STYLES, type MapboxCameraStop,
} from '@/lib/mapbox';

class FakeMapbox {
  camera = { center: [START.longitude, START.latitude], zoom: 15, heading: 0, pitch: 0 };
  reads = 0;
  writes: MapboxCameraStop[] = [];
  setCamera(c: MapboxCameraStop) {
    this.writes.push(c);
    // Reported back slightly off, which follow must never adopt
    this.camera = { center: c.centerCoordinate, zoom: c.zoomLevel - 0.013, heading: c.heading, pitch: c.pitch };
  }
  getCamera() { this.reads++; return reportedPoseFromMapbox(this.camera); }
}

function mapboxFrame(ctl: FollowCameraController, map: FakeMapbox, target: FollowFrameTarget) {
  const f = ctl.frame(target, 16, false);
  if (f.kind === 'needsSeed') {
    const token = ctl.beginSeed();
    if (token != null) ctl.completeSeed(token, map.getCamera(), target);
    return null;
  }
  if (f.kind === 'paused') return null;
  map.setCamera(mapboxFollowCamera(f.pose));
  return f;
}

test('Mapbox follow: heading changes move only the bearing; zoom and pitch hold exactly', () => {
  const ctl = new FollowCameraController(
    { zoom: NAV_CAMERA.mapboxZoom, distance: NAV_CAMERA.distanceM },
    { min: NAV_CAMERA.minDistanceM, max: NAV_CAMERA.maxDistanceM },
  );
  const map = new FakeMapbox();
  map.camera = { center: [START.longitude + 0.01, START.latitude], zoom: 11, heading: 200, pitch: 0 };
  ctl.enter(false);
  for (let i = 0; i < 400; i++) mapboxFrame(ctl, map, navTarget(START, 0)); // ease in from the user's map
  assert.equal(map.reads, 1, 'exactly one camera read on entering follow');
  const readsBefore = map.reads;
  for (let lap = 0; lap < 20; lap++) {
    for (const heading of [0, 45, 90, 180, 270, 359, 1, 120, 300]) {
      for (let i = 0; i < 30; i++) {
        const f = mapboxFrame(ctl, map, navTarget(START, heading))!;
        const sent = map.writes.at(-1)!;
        assert.equal(sent.zoomLevel, NAV_CAMERA.mapboxZoom, `zoom moved at ${heading}°`);
        assert.equal(sent.pitch, NAV_CAMERA.pitchDeg, `pitch moved at ${heading}°`);
        assert.equal(sent.heading, f.pose.heading);
        assert.equal(sent.animationDuration, 0);
      }
    }
  }
  assert.equal(map.reads, readsBefore, 'following must never read the map camera back');
  // Only a deliberate zoom pick changes it
  ctl.zoom.set({ zoom: clampMapboxZoom(ctl.zoom.current.zoom + 1) });
  for (let i = 0; i < 200; i++) mapboxFrame(ctl, map, navTarget(START, 90));
  assert.equal(map.writes.at(-1)!.zoomLevel, NAV_CAMERA.mapboxZoom + 1);
  assert.equal(clampMapboxZoom(99), 20);
  assert.equal(clampMapboxZoom(-4), 3);
});

test('Mapbox settings need a public token and a style URL; a secret token is never used', () => {
  const pk = 'pk.' + 'eyJ1' + 'x'.repeat(8) + '.sig';
  const style = 'mapbox://styles/derwent/abc123';
  assert.deepEqual(mapboxSettings(` ${pk} `, ` ${style} `), { token: pk, styleUrl: style });
  assert.equal(mapboxSettings(pk, null), null);
  assert.equal(mapboxSettings(null, style), null);
  assert.equal(mapboxSettings('sk.' + 'eyJ1' + 'x'.repeat(8) + '.sig', style), null);
  assert.equal(mapboxSettings(pk, 'mapbox://styles/only-account'), null);
  assert.equal(mapboxSettings(pk, style + '/draft')?.styleUrl, style + '/draft');
  assert.equal(mapboxSettings(pk, style + '/other'), null);
  assert.equal(mapboxSettings(pk, 'http://example.com/style.json'), null);
  assert.equal(mapboxStyleFor('standard', style), style);
  assert.equal(mapboxStyleFor('terrain', style), MAPBOX_PUBLIC_STYLES.outdoors);
  assert.equal(mapboxStyleFor('satellite', style), MAPBOX_PUBLIC_STYLES.satelliteStreets);
});

test('the recorded drive becomes one trail line, and nothing under two points', () => {
  assert.deepEqual(trailFeatureCollection(null).features, []);
  assert.deepEqual(trailFeatureCollection([START]).features, []);
  const b = offsetMeters(START, 100, 0);
  const fc = trailFeatureCollection([START, { latitude: Number.NaN, longitude: 0 }, b]);
  assert.equal(fc.features.length, 1);
  assert.deepEqual(fc.features[0]!.geometry.coordinates, [[START.longitude, START.latitude], [b.longitude, b.latitude]]);
});

test('the app build includes Mapbox and refuses a Mapbox secret token', () => {
  const appConfig = createRequire(import.meta.url)('../app.config.js') as (a: { config: object }) => { plugins: unknown[] };
  const base = { config: { ios: { infoPlist: {} }, android: {}, plugins: [], extra: {} } };
  const saved = { ...process.env };
  try {
    for (const k of Object.keys(process.env)) if (k.startsWith('EXPO_PUBLIC_')) delete process.env[k];
    Object.assign(process.env, {
      EXPO_PUBLIC_APP_ENV: 'staging',
      EXPO_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
      EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_' + 'abc',
      EXPO_PUBLIC_API_URL: 'https://api.example.invalid',
      EXPO_PUBLIC_MAPBOX_TOKEN: 'pk.' + 'eyJ1' + 'x'.repeat(8) + '.sig',
      EXPO_PUBLIC_MAPBOX_STYLE_URL: 'mapbox://styles/derwent/abc123',
    });
    assert.ok(appConfig(base).plugins.includes('@rnmapbox/maps'));
    process.env.EXPO_PUBLIC_MAPBOX_TOKEN = 'sk.' + 'eyJ1' + 'x'.repeat(8) + '.sig';
    assert.throws(() => appConfig(base), /EXPO_PUBLIC_MAPBOX_TOKEN holds a server secret/);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

test('on the Mapbox map (zoom, no altitude) a tilt still keeps following and a pinch still leaves', () => {
  const mb = (pitch: number, zoom = 16.6, center = START, heading = 30) => ({ center, heading, pitch, zoom });
  assert.equal(classifyFollowGesture(mb(60), mb(48)), 'pitch');
  assert.equal(classifyFollowGesture(mb(60), mb(72)), 'pitch');
  assert.equal(classifyFollowGesture(mb(60), mb(60, 17.4)), 'explore', 'pinch in');
  assert.equal(classifyFollowGesture(mb(60), mb(60, 15.9)), 'explore', 'pinch out');
  assert.equal(classifyFollowGesture(mb(60), mb(60, 16.6, offsetMeters(START, 40, 0))), 'explore', 'pan');
  assert.equal(classifyFollowGesture(mb(60), mb(60, 16.6, START, 50)), 'explore', 'rotate');
  assert.equal(classifyFollowGesture(mb(60), mb(60.1, 16.65)), 'none');
});

// ─── Live trail on the Mapbox Drive map ─────────────────────────────────────
// The Drive screen on Mapbox, wired as index.tsx wires it: CloudSync accepts
// fixes into the live route (AppContext's onDriveFix → appendLiveFix); the
// route's newest point is where the live head starts (the driveTrail effect);
// each frame the smoothed position goes to the arrow (setMarker) and to
// liveTrail.update, whose draws reach MapboxDriveMap's head source as
// trailFeatureCollection(head).

import type { TrailFeatureCollection } from '@/lib/mapbox';

const lngLat = (p: LatLng): [number, number] => [p.longitude, p.latitude];
const headLine = (shape: TrailFeatureCollection) => shape.features[0]?.geometry.coordinates ?? null;

class FakeMapboxDriveMap {
  puck: LatLng | null = null;
  head: TrailFeatureCollection = trailFeatureCollection(null);
  draws: { t: number; puck: LatLng | null; shape: TrailFeatureCollection }[] = [];
  setMarker(position: LatLng) { this.puck = position; }
  drawHead(head: LatLng[] | null, t: number) {
    this.head = trailFeatureCollection(head);
    this.draws.push({ t, puck: this.puck, shape: this.head });
  }
}

async function mapboxDriveScreen() {
  const server = new FakeServer();
  const clock = { t: Date.now() - 60 * 60_000 };
  const app = makeSync(server, new MemoryStore(), clock);
  await app.start();
  const map = new FakeMapboxDriveMap();
  const liveTrail = new LiveTrailHead();
  const sm = new LocationSmoother();
  const s = {
    app, server, clock, map, liveTrail, sm,
    driving: false, paused: false,
    drive: null as ActiveDrive | null,
    fixes: [] as LatLng[],
    async start() {
      await app.startDrive(null);
      s.drive = newLiveDrive(clock.t);
      s.driving = true;
      liveTrail.reset();
      map.drawHead(null, clock.t);
    },
    pause() {
      s.paused = true;
      app.setDrivePaused(true);
      liveTrail.reset();
      map.drawHead(null, clock.t);
    },
    resume() {
      s.paused = false;
      app.setDrivePaused(false);
    },
    async end() {
      s.driving = false;
      s.drive = null;
      liveTrail.reset();
      map.drawHead(null, clock.t);
      return app.endDrive();
    },
    /** A GPS fix: the screen's (smoothed for the puck, and recorded), or one only background tracking delivered */
    fix(raw: LatLng, speed: number, course: number, from: 'screen' | 'background' = 'screen') {
      s.fixes.push(raw);
      const fix = { ...raw, speedMs: speed, headingDeg: course, accuracyM: 5, timestamp: clock.t };
      if (from === 'background') { app.addFix(fix); return; }
      sm.addFix({ ...raw, speed, course, accuracy: 5, time: clock.t }, clock.t);
      if (s.driving && !s.paused) app.addFix(fix);
    },
    frame() {
      const position = sm.sample(clock.t);
      if (position) map.setMarker(position);
      const u = liveTrail.update(position, s.driving && !s.paused, clock.t);
      if (u.kind === 'draw') map.drawHead(u.head, clock.t);
      return u;
    },
  };
  app.onDriveFix((fix) => {
    if (!s.drive) return;
    s.drive = appendLiveFix(s.drive, fix);
    if (!s.paused) liveTrail.followTrail(s.drive.coordinates);
  });
  return s;
}

/** Drives `seconds` along a gentle bend at 60 fps, one fix a second; `each` can deliver a fix differently */
function driveMapbox(s: Awaited<ReturnType<typeof mapboxDriveScreen>>, seconds: number, opts: {
  speed?: number; from?: (second: number) => 'screen' | 'background' | 'both';
  onFrame?: (u: ReturnType<typeof s.frame>) => void;
} = {}) {
  const speed = opts.speed ?? 15;
  let pos = s.sm.sample(s.clock.t) ?? START;
  let course = 40;
  for (let second = 0; second < seconds; second++) {
    pos = offsetMeters(pos, speed * Math.sin((course * Math.PI) / 180), speed * Math.cos((course * Math.PI) / 180));
    course = (course + 9) % 360;
    const from = opts.from?.(second) ?? 'screen';
    // Background tracking got this fix to CloudSync first: the screen's copy is a duplicate
    if (from === 'background' || from === 'both') s.fix(pos, speed, course, 'background');
    if (from !== 'background') s.fix(pos, speed, course);
    for (let f = 0; f < 60; f++) {
      const u = s.frame();
      opts.onFrame?.(u);
      s.clock.t += 1000 / 60;
    }
  }
}

test('Mapbox: the live trail reaches the puck every frame, from the trail\'s newest point', async () => {
  const s = await mapboxDriveScreen();
  s.fix(START, 0, 40);
  s.frame();
  await s.start();
  const speed = 15;
  let frames = 0, maxLag = 0, puckTravel = 0;
  let prevPuck: LatLng | null = null;
  let prevDraw: { t: number; end: [number, number] } | null = null;
  const gaps: number[] = [];
  driveMapbox(s, 20, {
    speed,
    // Background tracking delivers some fixes first, and some the screen never sees
    from: (sec) => (sec % 4 === 3 ? 'both' : sec % 7 === 5 ? 'background' : 'screen'),
    onFrame: (u) => {
      frames++;
      const trail = s.drive!.coordinates;
      if (prevPuck) puckTravel += distM(prevPuck, s.map.puck!);
      prevPuck = s.map.puck;
      const line = headLine(s.map.head);
      if (u.kind === 'draw' && u.head) {
        // Drawn this frame: the head ends exactly on the puck...
        assert.deepEqual(line!.at(-1), lngLat(s.map.puck!));
        // ...and starts exactly on the trail's newest point: no gap
        assert.deepEqual(line![0], lngLat(trail.at(-1)!));
        const end = line!.at(-1)!;
        if (prevDraw) {
          assert.ok(s.clock.t - prevDraw.t >= LIVE_TRAIL.redrawIntervalMs - 1e-6, 'redrawn faster than the interval');
          gaps.push(s.clock.t - prevDraw.t);
          const step = distM({ latitude: prevDraw.end[1], longitude: prevDraw.end[0] }, { latitude: end[1], longitude: end[0] });
          // The head's end moves exactly as the puck does: never further
          assert.ok(step <= puckTravel + 1e-6, `the head end moved ${step.toFixed(2)} m; the puck ${puckTravel.toFixed(2)} m`);
        }
        puckTravel = 0;
        prevDraw = { t: s.clock.t, end };
      }
      if (trail.length >= 2 && line) {
        // Between redraws it's at most a redraw interval behind the puck
        const end = line.at(-1)!;
        maxLag = Math.max(maxLag, distM({ latitude: end[1], longitude: end[0] }, s.map.puck!));
        // It always starts on the trail (its newest point, or the one before
        // for the moment between a fix and the next redraw): never a gap
        assert.ok(
          [trail.at(-1), trail.at(-2)].some((p) => p && line[0]![0] === p.longitude && line[0]![1] === p.latitude),
          'the head is detached from the trail',
        );
      }
    },
  });
  assert.ok(frames >= 1200);
  assert.ok(maxLag < speed * 0.05, `the head end trails the puck by ${maxLag.toFixed(2)} m`);
  // Continuous between fixes: ~30 redraws a second
  const avgGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  assert.ok(avgGap < 40, `redrawn only every ${avgGap.toFixed(0)} ms`);

  // Saved and uploaded points are raw fixes only: nothing from the head
  const rec = s.app.activeRecord!;
  const isFix = (p: { latitude: number; longitude: number }) => s.fixes.some((f) => f.latitude === p.latitude && f.longitude === p.longitude);
  for (const p of rec.points) assert.ok(isFix(p), 'a saved point that was never a GPS fix');
  for (const p of s.drive!.coordinates) assert.ok(isFix(p), 'a trail point that was never a GPS fix');
  const journey = await s.end();
  assert.ok(journey);
  assert.equal(s.server.points.get(s.server.journeys[0]!.id), rec.points.length, 'only raw points uploaded');
});

test('Mapbox: pause, resume, end and a new drive clear and restart the live trail', async () => {
  const s = await mapboxDriveScreen();
  s.fix(START, 0, 40);
  s.frame();
  await s.start();
  // Each redraw moves the head's end a small step: smooth, not a jump a fix
  const startedAt = s.clock.t;
  let prevEnd: number[] | null = null, maxStep = 0, draws = 0;
  driveMapbox(s, 4, {
    onFrame: (u) => {
      if (u.kind !== 'draw' || !u.head) return;
      const end = headLine(s.map.head)!.at(-1)!;
      // (from the second second: the puck first eases up to speed from rest)
      if (prevEnd && s.clock.t > startedAt + 1500) {
        maxStep = Math.max(maxStep, distM({ latitude: prevEnd[1]!, longitude: prevEnd[0]! }, { latitude: end[1]!, longitude: end[0]! }));
      }
      prevEnd = end;
      draws++;
    },
  });
  assert.ok(draws > 100, `only ${draws} redraws in 4 s`);
  assert.ok(maxStep < 15 * 0.05 * 1.6, `the head end jumped ${maxStep.toFixed(2)} m`);
  assert.equal(s.map.head.features.length, 1, 'a head while driving');

  // Pause: cleared at once, and nothing drawn or recorded while paused
  s.pause();
  assert.equal(s.map.head.features.length, 0, 'cleared on pause');
  const trailAtPause = s.drive!.coordinates.length;
  const drawsAtPause = s.map.draws.length;
  driveMapbox(s, 3);
  assert.equal(s.map.draws.length, drawsAtPause, 'drawn while paused');
  assert.equal(s.drive!.coordinates.length, trailAtPause, 'recorded while paused');

  // Resume: no head until a fix is recorded, then it starts from that fix
  // (never a line from where the drive was paused)
  s.resume();
  s.frame();
  assert.equal(s.map.head.features.length, 0);
  driveMapbox(s, 2);
  const firstAfterResume = s.drive!.coordinates[trailAtPause]!;
  assert.ok(firstAfterResume, 'recording resumed');
  const line = headLine(s.map.head)!;
  assert.deepEqual(line[0], lngLat(s.drive!.coordinates.at(-1)!));
  assert.deepEqual(line.at(-1), lngLat(s.map.draws.at(-1)!.puck!));

  // End: cleared, and stays clear
  await s.end();
  assert.equal(s.map.head.features.length, 0, 'cleared on end');
  const drawsAtEnd = s.map.draws.length;
  driveMapbox(s, 2);
  assert.equal(s.map.draws.length, drawsAtEnd, 'drawn after the drive ended');

  // A new drive: nothing carried over; the head starts at its own first point
  await s.start();
  for (let f = 0; f < 10; f++) { s.frame(); s.clock.t += 1000 / 60; }
  assert.equal(s.map.head.features.length, 0, 'a head from the last drive');
  driveMapbox(s, 2);
  assert.deepEqual(headLine(s.map.head)![0], lngLat(s.drive!.coordinates.at(-1)!));
  assert.equal(s.drive!.coordinates.length, 2);
});

test('the live head catches up with the puck where it comes to rest, then goes idle', () => {
  const trail = new LiveTrailHead();
  assert.equal(trail.followTrail([]), false);
  assert.equal(trail.followTrail([offsetMeters(START, 0, -20), START]), true);
  assert.equal(trail.followTrail([START]), false, 'same newest point: the trace is kept');
  let t = 0, last: LatLng | null = null, drawn: LatLng[] | null = null;
  for (let i = 1; i <= 50; i++) {
    last = offsetMeters(START, 0, i * 0.25);
    const u = trail.update(last, true, t);
    if (u.kind === 'draw') drawn = u.head;
    t += 1000 / 60;
  }
  // The puck stops just after a redraw, so the redraw to its resting place is
  // held back: until it's drawn the frame loop is told to keep running
  // ("wait", never "idle", or it could stop with the head short of the puck)
  assert.equal(trail.update(offsetMeters(START, 0, 13), true, t).kind, 'draw');
  t += 1000 / 60;
  last = offsetMeters(START, 0, 13.25);
  const kinds: string[] = [];
  for (let i = 0; i < 10; i++) {
    const u = trail.update(last, true, t);
    kinds.push(u.kind);
    if (u.kind === 'draw') drawn = u.head;
    else if (drawn!.at(-1)!.latitude !== last.latitude) assert.equal(u.kind, 'wait', 'idle while the head is short of the puck');
    t += 1000 / 60;
  }
  assert.equal(kinds[0], 'wait');
  assert.deepEqual(drawn!.at(-1), last, 'the head stopped short of the puck');
  assert.equal(kinds.at(-1), 'idle', 'the frame loop could never settle');
  assert.ok(!kinds.slice(kinds.indexOf('idle')).includes('wait'));
  // Not driving (paused, passenger, ended): cleared once, then idle
  assert.deepEqual(trail.update(last, false, t), { kind: 'draw', head: null });
  assert.deepEqual(trail.update(last, false, t + 100), { kind: 'idle' });
  // No recorded point yet: nothing to draw, and nothing owed
  const fresh = new LiveTrailHead();
  assert.deepEqual(fresh.update(START, true, 0), { kind: 'idle' });
  assert.deepEqual(fresh.update(START, true, 100), { kind: 'idle' });
});

test('the Mapbox Drive map draws the live head from the same position as its puck', () => {
  const read = (rel: string) => readFileSync(toPath(new URL(rel, import.meta.url)), 'utf8');
  const screen = read('../app/(tabs)/(drive)/index.tsx');
  const map = read('../components/MapboxDriveMap.tsx');
  // One head update per frame, for either map, from the very `position`
  // handed to the puck (and the Apple marker), after both
  const loop = screen.slice(screen.indexOf('const position = locationSmoother.sample(now);'));
  const puck = loop.indexOf('mapboxRef.current?.setMarker(position, drawnHeadingRef.current)');
  const marker = loop.indexOf('markerRef.current?.setCoordinates(position)');
  const update = loop.search(/liveTrail\.update\(\s*position,/);
  assert.ok(puck > 0 && marker > puck && update > marker, 'head not updated from the puck position');
  assert.equal(screen.match(/liveTrail\.update\(/g)?.length, 1);
  assert.ok(/liveTrailDrawRef\.current\?\.\(head\.head\)/.test(loop));
  // A redraw held back keeps the loop running until the head reaches the puck
  assert.ok(/head\.kind !== "wait"/.test(loop.slice(0, loop.indexOf('const settled'))) || /settled =[^;]*head\.kind !== "wait"/.test(loop));
  // Anchored on the trail as drawn, not on the screen's own fixes
  assert.ok(!/liveTrail\.recordedPoint\(/.test(screen));
  assert.ok(/liveTrail\.followTrail\(driveTrail\)/.test(screen));
  // Both maps get the same head: Mapbox through its trailHead prop
  const jsx = screen.search(/<MapboxDriveMap\s/); // the element, not the Handle type
  const mapbox = screen.slice(jsx, screen.indexOf('/>', jsx));
  assert.ok(/trailHead=\{subscribeLiveTrail\}/.test(mapbox));
  assert.ok(/trail=\{driveTrail\}/.test(mapbox));
  assert.ok(/<LiveTrailHeadLines\s+subscribe=\{subscribeLiveTrail\}/.test(screen));
  // Pause, passenger mode and drive start/end clear it
  for (const where of ['function handlePause()', 'isPassengerModeRef.current = isPassengerMode;', 'isDrivingRef.current = isDriving;']) {
    const body = screen.slice(screen.indexOf(where), screen.indexOf(where) + 400);
    assert.ok(/liveTrail\.reset\(\);\s*liveTrailDrawRef\.current\?\.\(null\);/.test(body), `not cleared at ${where}`);
  }
  // The map: its own head source, beneath the recorded trail and the puck,
  // styled like the trail, and built with the trail's own feature function
  const head = map.indexOf('<TrailHeadLayers');
  assert.ok(head > 0 && head < map.indexOf('id="derwent-drive-trail"') && head < map.search(/<MarkerFeeder\s/));
  assert.ok(/trailFeatureCollection\(head\)/.test(map));
  assert.ok(/id="derwent-drive-trail-head"/.test(map));
  const layers = map.slice(map.indexOf('const TrailHeadLayers'), map.indexOf('const MapboxDriveMap'));
  assert.ok(/lineColor: TRAIL_GLOW,\s*lineWidth: 12/.test(layers) && /lineColor: color,\s*lineWidth: 4/.test(layers));
});

// ─── Leaving follow mode stays left ─────────────────────────────────────────
// The Drive screen's follow wiring (index.tsx) on either map: the camera read
// that judges a gesture, the frame loop's follow block, the compass and GPS
// course feeding the heading filter, and Continue Following.  Once the user
// has moved the map, nothing but Continue Following may move the camera.

import type { ReportedPose } from '@/lib/locationSmoothing';

type MapChange = { east?: number; north?: number; rotate?: number; tilt?: number; zoom?: number };
const flush = () => new Promise((r) => setImmediate(r));

function followSim(provider: 'mapbox' | 'apple', opts: { reads?: boolean } = {}) {
  const clock = { t: 1_000_000 };
  const mb = new FakeMapbox();
  const mk = new FakeMapKit();
  const followZoom = provider === 'mapbox' ? NAV_CAMERA.mapboxZoom : NAV_CAMERA.androidZoom;
  const ctl = new FollowCameraController(
    { zoom: followZoom, distance: NAV_CAMERA.distanceM },
    { min: NAV_CAMERA.minDistanceM, max: NAV_CAMERA.maxDistanceM },
  );
  const zoomTarget = ctl.zoom;
  const heading = new HeadingFilter();
  const s = {
    clock, ctl, heading,
    mode: 'following' as 'following' | 'free',
    position: START,
    drawnHeading: 0,
    mapHeading: 0,
    // What the user sees of the arrow: Mapbox's puck gets the heading and
    // turns it against the map itself; Apple's arrow is turned on screen
    puckHeading: null as number | null,
    markerRotation: 0,
    gestureStart: null as ReportedPose | null,
    writes: () => (provider === 'mapbox' ? mb.writes.length : mk.writes),
    camera: () => structuredClone(provider === 'mapbox' ? mb.camera : mk.camera),
    report: (): ReportedPose => (provider === 'mapbox' ? reportedPoseFromMapbox(mb.camera) : mk.getCamera()),
    target: () => navTarget(s.position, s.drawnHeading),
    leaveFollow() {
      if (s.mode !== 'following') return;
      s.mode = 'free';
      ctl.leave();
    },
    judge(cam: ReportedPose) {
      if (!s.gestureStart) { s.gestureStart = cam; return; }
      const verdict = ctl.judgeGesture(s.gestureStart, cam);
      if (verdict === 'explore') s.leaveFollow();
      else if (verdict === 'pitch' && cam.pitch != null) ctl.setUserPitch(cam.pitch);
    },
    reader: null as unknown as LatestReader<ReportedPose>,
    frame() {
      s.drawnHeading = heading.step(16);
      s.puckHeading = s.drawnHeading;
      if (s.mode === 'following') {
        const target = s.target();
        const f = ctl.frame(target, 16, zoomTarget.gestureActive(clock.t));
        if (f.kind === 'left' || f.kind === 'free') s.leaveFollow();
        else if (f.kind === 'needsSeed') {
          const token = ctl.beginSeed();
          if (token != null) ctl.completeSeed(token, s.report(), target);
        } else if (f.kind === 'camera') {
          s.mapHeading = f.pose.heading;
          if (provider === 'mapbox') mb.setCamera(mapboxFollowCamera(f.pose));
          else mk.setCamera(buildFollowCamera(f.pose.center, f.pose.heading, f.pose.pitch, f.pose, 'ios'));
        }
      }
      s.markerRotation = markerScreenRotation(s.drawnHeading, s.mapHeading);
      clock.t += 16;
    },
    frames(n: number) { for (let i = 0; i < n; i++) s.frame(); },
    // ── The user's fingers on the map ──
    touchStart() {
      zoomTarget.touchStart(clock.t);
      if (s.mode === 'following') { s.gestureStart = null; ctl.beginGesture(); s.reader.request(); }
    },
    /** The user's gesture moves the camera; the map reports it (onPanDrag / Mapbox isGestureActive) */
    userMoves(c: MapChange) {
      if (provider === 'mapbox') {
        const centre = offsetMeters({ latitude: mb.camera.center[1]!, longitude: mb.camera.center[0]! }, c.east ?? 0, c.north ?? 0);
        mb.camera = {
          center: [centre.longitude, centre.latitude],
          zoom: mb.camera.zoom + (c.zoom ?? 0),
          heading: (mb.camera.heading + (c.rotate ?? 0) + 360) % 360,
          pitch: c.tilt ?? mb.camera.pitch,
        };
      } else {
        mk.camera = {
          center: offsetMeters(mk.camera.center, c.east ?? 0, c.north ?? 0),
          heading: (mk.camera.heading + (c.rotate ?? 0) + 360) % 360,
          pitch: c.tilt ?? mk.camera.pitch,
          // A tilt keeps the camera's distance from the centre (so its eye
          // height changes); a pinch scales it
          altitude: altitudeForDistance(
            (distanceForAltitude(mk.camera.altitude, mk.camera.pitch)) * 2 ** -(c.zoom ?? 0),
            c.tilt ?? mk.camera.pitch,
          ),
        };
      }
      const fresh = !zoomTarget.gestureActive(clock.t);
      zoomTarget.gestureMoved(clock.t);
      if (s.mode === 'following') {
        if (fresh) { s.gestureStart = null; ctl.beginGesture(); }
        ctl.gestureMoved();
        s.reader.request();
      }
      s.regionChange();
    },
    /** The map's camera changed (Apple onRegionChange, Mapbox onCameraChange) */
    regionChange() {
      const following = s.mode === 'following';
      const gesture = zoomTarget.gestureActive(clock.t);
      if (following && gesture) ctl.gestureMoved();
      if (!following || gesture) s.reader.request();
    },
    touchEnd() { zoomTarget.touchEnd(clock.t); },
    /** A whole gesture.  framesDuring: whether the frame loop happened to be running */
    async gesture(steps: MapChange[], framesDuring = true) {
      s.touchStart();
      await flush();
      for (const step of steps) {
        s.userMoves(step);
        await flush();
        if (framesDuring) s.frames(3); else clock.t += 48;
      }
      s.touchEnd();
      await flush();
      // The map settles; the loop may be asleep (nothing to animate)
      if (framesDuring) s.frames(Math.ceil(GESTURE_SETTLE_MS / 16) + 10);
      else clock.t += GESTURE_SETTLE_MS + 100;
    },
    // ── Heading sources (each wakes the frame loop) ──
    compass(deg: number) { heading.update(deg, 'compass'); },
    gpsFix(position: LatLng, course: number) { s.position = position; heading.update(course, 'course'); },
    // ── The Continue Following button ──
    continueFollowing() {
      zoomTarget.clearGesture();
      zoomTarget.set({ zoom: followZoom, distance: NAV_CAMERA.distanceM });
      const was = s.mode === 'following';
      s.mode = 'following';
      ctl.enter(was, undefined, s.target());
    },
  };
  s.reader = new LatestReader(
    () => (opts.reads === false ? Promise.reject(new Error('no map')) : Promise.resolve(s.report())),
    (cam) => {
      const following = s.mode === 'following';
      const gesture = zoomTarget.gestureActive(clock.t);
      if (following && !gesture) return;
      if (cam.heading != null) s.mapHeading = cam.heading;
      if (following) s.judge(cam);
    },
  );
  // Settled following at the navigation camera
  s.frames(400);
  assert.equal(s.mode, 'following');
  return s;
}

const headingNear = (a: number | null, b: number, tol = 1.5) => a != null && Math.abs(angleDelta(a, b)) < tol;

for (const provider of ['mapbox', 'apple'] as const) {
  for (const framesDuring of [true, false]) {
    test(`${provider}: after panning away (${framesDuring ? 'loop running' : 'loop asleep'}), turning the phone never brings the camera back`, async () => {
      const s = followSim(provider);
      await s.gesture([{ east: 40 }, { east: 90 }, { east: 160, north: 60 }], framesDuring);
      assert.equal(s.mode, 'free', 'panning leaves follow mode');
      assert.equal(s.ctl.isFollowing, false);
      const camera = s.camera();
      const writes = s.writes();
      const mapBearing = s.mapHeading;
      // The phone turns, repeatedly, through every direction
      for (const h of [10, 55, 120, 200, 300, 15, 90, 270, 180, 359, 45, 225]) {
        s.compass(h);
        s.frames(90);
        // The marker still turns with the phone, against the map as the user left it
        assert.ok(headingNear(s.puckHeading, h), `marker at ${s.puckHeading}°, phone at ${h}°`);
        assert.equal(s.markerRotation, markerScreenRotation(s.drawnHeading, mapBearing));
        // The camera doesn't move: position, bearing, zoom and pitch exactly as left
        assert.deepEqual(s.camera(), camera, `camera moved at ${h}°`);
        assert.equal(s.writes(), writes, `camera written at ${h}°`);
        assert.equal(s.mode, 'free', `follow mode came back at ${h}°`);
      }
    });
  }

  test(`${provider}: GPS course changes while exploring don't restore follow mode; only Continue Following does`, async () => {
    const s = followSim(provider);
    await s.gesture([{ rotate: 20 }, { rotate: 45 }]);
    assert.equal(s.mode, 'free', 'rotating leaves follow mode');
    const camera = s.camera();
    const writes = s.writes();
    // Driving on: a fix a second, the course swinging through a junction
    let pos = START;
    for (const course of [0, 20, 60, 90, 90, 140, 200, 260, 300, 330, 10, 40]) {
      pos = offsetMeters(pos, 15 * Math.sin((course * Math.PI) / 180), 15 * Math.cos((course * Math.PI) / 180));
      s.gpsFix(pos, course);
      s.frames(150);
      assert.ok(headingNear(s.puckHeading, course, 3), `marker at ${s.puckHeading}°, course ${course}°`);
      assert.deepEqual(s.camera(), camera, `camera moved at course ${course}°`);
      assert.equal(s.writes(), writes);
      assert.equal(s.mode, 'free');
    }
    // A tap on the map (no movement) doesn't bring it back either
    await s.gesture([]);
    s.compass(80);
    s.frames(60);
    assert.equal(s.mode, 'free');
    assert.deepEqual(s.camera(), camera);
    // Continue Following: the camera eases back to the navigation view
    s.continueFollowing();
    s.frames(400);
    assert.equal(s.mode, 'following');
    assert.ok(s.writes() > writes, 'Continue Following must move the camera');
    const report = s.report();
    assert.ok(headingNear(report.heading ?? null, s.drawnHeading, 0.5), 'heading-up again');
    assert.equal(report.pitch, NAV_CAMERA.pitchDeg);
    if (provider === 'mapbox') assert.ok(Math.abs(report.zoom! - NAV_CAMERA.mapboxZoom) < 0.02, 'nav zoom again');
    const ahead = distM(report.center!, s.position);
    assert.ok(ahead < NAV_CAMERA.lookAhead.maxM + 1, `centred ${ahead.toFixed(0)} m from the vehicle`);
  });

  test(`${provider}: a tilt still keeps following; pinching and rotating still leave`, async () => {
    const s = followSim(provider);
    await s.gesture([{ tilt: 52 }, { tilt: 47 }]);
    assert.equal(s.mode, 'following', 'a tilt must not leave follow mode');
    assert.equal(s.ctl.followPitch, 47);
    s.compass(140);
    s.frames(200);
    assert.equal(s.report().pitch, 47, 'follows at the chosen tilt');
    assert.ok(headingNear(s.report().heading ?? null, s.drawnHeading, 0.5), 'and still turns with the heading');
    await s.gesture([{ zoom: 0.6 }, { zoom: 1.2 }]);
    assert.equal(s.mode, 'free', 'a pinch leaves follow mode');
    s.continueFollowing();
    s.frames(300);
    await s.gesture([{ rotate: 15 }, { rotate: 30 }]);
    assert.equal(s.mode, 'free', 'a rotation leaves follow mode');
  });
}

test('a gesture no camera read could judge leaves follow mode rather than snapping back', async () => {
  // The Build 15 bug: on Mapbox the gesture judge read only the Apple map, so
  // every read failed, follow mode never ended, and the next heading change
  // eased the camera back.  Even with no reads, a moving gesture now ends it.
  for (const framesDuring of [true, false]) {
    const s = followSim('mapbox', { reads: false });
    await s.gesture([{ east: 50 }, { east: 120 }], framesDuring);
    s.compass(200);
    s.frames(120);
    assert.equal(s.mode, 'free', `follow resumed (loop ${framesDuring ? 'running' : 'asleep'})`);
    const camera = s.camera();
    s.compass(20);
    s.frames(120);
    assert.deepEqual(s.camera(), camera);
  }
  // A plain tap, which moves nothing, keeps following
  const s = followSim('mapbox', { reads: false });
  await s.gesture([]);
  s.compass(90);
  s.frames(200);
  assert.equal(s.mode, 'following');
});

test('the follow controller writes no camera once left, whatever the target, until enter()', () => {
  const { ctl, map } = settledFollowing();
  ctl.leave();
  assert.equal(ctl.isFollowing, false);
  const writes = map.writes;
  for (let i = 0; i < 500; i++) {
    const f = ctl.frame(navTarget(offsetMeters(START, i, -i), (i * 37) % 360), 16, i % 7 === 0);
    assert.equal(f.kind, 'free');
  }
  // Retargeting (a heading-mode switch) and stray gesture notes change nothing
  ctl.retarget(navTarget(START, 90));
  ctl.gestureMoved();
  assert.equal(ctl.frame(navTarget(START, 90), 16, false).kind, 'free');
  assert.equal(map.writes, writes);
  // Only enter() follows again
  ctl.enter(false);
  assert.equal(ctl.isFollowing, true);
  for (let i = 0; i < 400; i++) followFrame(ctl, map, navTarget(START, 90));
  assert.ok(map.writes > writes);
  // A tap while following (touched, nothing moved) carries on following
  ctl.beginGesture();
  assert.equal(ctl.frame(navTarget(START, 90), 16, true).kind, 'paused');
  assert.equal(ctl.frame(navTarget(START, 90), 16, false).kind, 'camera');
  // A moving gesture that no read judged ends it, once, at the gesture's end
  ctl.beginGesture();
  ctl.gestureMoved();
  assert.equal(ctl.frame(navTarget(START, 90), 16, true).kind, 'paused');
  assert.equal(ctl.frame(navTarget(START, 90), 16, false).kind, 'left');
  assert.equal(ctl.isFollowing, false);
  assert.equal(ctl.frame(navTarget(START, 90), 16, false).kind, 'free');
});

test('the Drive screen moves the camera only while following; heading only turns the marker', () => {
  const src = readFileSync(toPath(new URL('../app/(tabs)/(drive)/index.tsx', import.meta.url)), 'utf8');
  const code = src.replace(/\/\/.*$/gm, '');
  // Gestures are judged from whichever map is in use (not Apple's alone)
  assert.ok(/new LatestReader\(readMapCamera,/.test(code));
  // Every follow camera write sits inside the follow-mode guard
  const guard = code.indexOf('followModeRef.current === "following" &&\n        hasMap()');
  assert.ok(guard > 0, 'follow guard not found');
  const block = code.slice(guard, code.indexOf('syncArrowRotation();', guard));
  for (const write of ['setFollowCamera(', 'setCamera(\n              buildFollowCamera(']) {
    // The route preview's overview is the one other writer (Mapbox only),
    // and it stops the moment follow mode is on: never both at once
    const others = write === 'setFollowCamera(' ? 1 : 0;
    assert.equal(code.split(write).length - 1, 1 + others, `${write} written elsewhere`);
    assert.ok(block.includes(write), `${write} outside the follow guard`);
  }
  // Both overviews (a preview, and navigation's whole-route view) go through one animator
  const overview = code.slice(code.indexOf('const animateOverview = useCallback'), code.indexOf('const fitRoutePreview = useCallback'));
  assert.ok(/setFollowCamera\(/.test(overview), 'the overview writes through the follow camera path');
  assert.ok(/followModeRef\.current === "following" \|\|[\s\S]*\)\s*return;[\s\S]*setFollowCamera\(/.test(overview), 'the overview must stop while following');
  assert.equal(code.match(/animateOverview\(\s*overviewPose\(/g)?.length, 2, 'the preview and navigation overviews');
  // A finished gesture the controller says left follow mode ends it on screen too
  assert.ok(/frame\.kind === "left" \|\| frame\.kind === "free"\)\s*\{\s*leaveFollowRef\.current\(\);/.test(code));
  // The map reporting a gesture is noted with the controller (Apple onPanDrag, Mapbox onUserGesture)
  const pan = code.slice(code.indexOf('const handleMapPanDrag'), code.indexOf('const handleMapTouchStart'));
  assert.ok(/followCamera\.gestureMoved\(\)/.test(pan));
  assert.ok(/onUserGesture=\{handleMapPanDrag\}/.test(code) && /onPanDrag=\{handleMapPanDrag\}/.test(code));
  // Follow mode is entered in one place, from three explicit actions only
  assert.equal(code.match(/setFollowMode\("following"\)/g)?.length, 1);
  assert.equal(code.match(/followModeRef\.current = "following"/g)?.length, 1);
  assert.equal(code.match(/startFollowing\(true/g)?.length, 5);
  for (const caller of ['if (isDriving) {', 'const handleResumeFollowing', 'const handleLocateButton', 'if (s.phase === "idle") {', 'if (!guiding) {']) {
    const i = code.indexOf(caller);
    assert.ok(i > 0 && /startFollowing\(true/.test(code.slice(i, i + 900)), `${caller} doesn't start following`);
  }
  // The compass and GPS heading paths only feed the heading filter
  const strip = (from: string, to: string) => src.slice(src.indexOf(from), src.indexOf(to, src.indexOf(from))).replace(/\/\/.*$/gm, '');
  const compass = strip('Location.watchHeadingAsync', 'headingSubRef.current = sub');
  const gps = strip('const processPosition = useCallback', '// ── Location watcher lifecycle');
  assert.ok(compass.length > 200 && gps.length > 1000 && gps.length < 12000);
  for (const [name, body] of [['compass', compass], ['GPS', gps]] as const) {
    assert.ok(/headingFilter\.update\(/.test(body), `${name} doesn't update the heading`);
    assert.ok(!/startFollowing|setFollowMode|followModeRef\.current =|followCamera\.(enter|retarget)|setCamera|setFollowCamera|animateCamera/.test(body), `${name} touches follow mode or the camera`);
  }
});

// ─── The arrow holds still on screen while following heading-up ────────────
// The arrow's on-screen turn is the drawn heading less the bearing the map
// shows.  While following heading-up, the frame loop writes the camera's
// bearing from that same drawn heading and turns the arrow against it in the
// same frame, so the two can't drift apart: the map turns, the arrow doesn't.

/** Frames with the compass turning toward `to`, reporting what each frame showed */
function turnFrames(s: ReturnType<typeof followSim>, to: number, frames: number) {
  s.compass(to);
  const out: { bearing: number; drawn: number; arrow: number }[] = [];
  for (let i = 0; i < frames; i++) {
    s.frame();
    out.push({ bearing: s.report().heading!, drawn: s.drawnHeading, arrow: s.markerRotation });
  }
  return out;
}

for (const provider of ['mapbox', 'apple'] as const) {
  test(`${provider}: following heading-up, the arrow stays locked on screen as the map turns`, () => {
    const s = followSim(provider);
    let turned = 0, prevBearing: number | null = null, lagIfPrevBearing = 0;
    for (const h of [40, 95, 180, 170, 260, 300, 20, 120]) {
      for (const f of turnFrames(s, h, 45)) {
        // Screen-locked: the arrow's own turn on screen is nil, every frame
        assert.ok(Math.abs(angleDelta(0, f.arrow)) < 1e-9, `arrow turned ${f.arrow}° on screen while the map turned`);
        // ...because it's turned against this frame's camera bearing, which
        // is this frame's drawn heading (no frame of lag between them)
        assert.ok(Math.abs(angleDelta(f.bearing, f.drawn)) < 1e-9, 'camera bearing and drawn heading out of step');
        assert.equal(f.arrow, markerScreenRotation(f.drawn, f.bearing));
        if (prevBearing != null) {
          turned += Math.abs(angleDelta(prevBearing, f.bearing));
          // Turned against last frame's bearing instead, it would chase the map
          lagIfPrevBearing = Math.max(lagIfPrevBearing, Math.abs(markerScreenRotation(f.drawn, prevBearing)));
        }
        prevBearing = f.bearing;
      }
    }
    assert.ok(turned > 400, `the map only turned ${turned.toFixed(0)}°`);
    assert.ok(lagIfPrevBearing > 1, 'the sweep should be fast enough to show a frame of lag');
    // Still eased, not snapped: the camera bearing moves a step at a time
    assert.equal(s.mode, 'following');
  });

  test(`${provider}: 359° → 0° keeps the arrow still and turns the map the short way`, () => {
    const s = followSim(provider);
    turnFrames(s, 355, 300);
    for (const h of [5, 358, 2, 350, 10, 0]) {
      let prev: number | null = null;
      for (const f of turnFrames(s, h, 120)) {
        assert.ok(Math.abs(angleDelta(0, f.arrow)) < 1e-9, `arrow turned ${f.arrow}° crossing north`);
        if (prev != null) assert.ok(Math.abs(angleDelta(prev, f.bearing)) < 3, `map spun the long way: ${prev}° → ${f.bearing}°`);
        prev = f.bearing;
      }
      assert.ok(headingNear(prev, h, 0.5), `map at ${prev}°, heading ${h}°`);
    }
  });

  test(`${provider}: exploring, the arrow turns against the map bearing the user left`, async () => {
    const s = followSim(provider);
    turnFrames(s, 0, 200);
    await s.gesture([{ rotate: 35 }, { rotate: 35 }]);
    assert.equal(s.mode, 'free');
    const bearing = s.report().heading!;
    assert.ok(headingNear(bearing, 70, 0.01));
    for (const h of [10, 90, 200, 359, 1, 270]) {
      for (const f of turnFrames(s, h, 90)) {
        assert.equal(f.bearing, bearing, 'the map turned while exploring');
        assert.equal(f.arrow, markerScreenRotation(f.drawn, bearing));
      }
      // Pointing the phone where the map's "up" is shows the arrow upright
      assert.ok(headingNear(s.markerRotation, angleDelta(bearing, h), 1));
    }
    // Continue Following: the arrow eases back to upright as the map catches up
    s.continueFollowing();
    turnFrames(s, 270, 400);
    assert.ok(Math.abs(angleDelta(0, s.markerRotation)) < 1e-9);
  });
}

test('the Drive screen turns one arrow, on either map, against the bearing written that frame', () => {
  const src = readFileSync(toPath(new URL('../app/(tabs)/(drive)/index.tsx', import.meta.url)), 'utf8');
  const map = readFileSync(toPath(new URL('../components/MapboxDriveMap.tsx', import.meta.url)), 'utf8');
  const code = src.replace(/\/\/.*$/gm, '');
  const mapCode = map.replace(/\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
  // Mapbox's own puck (which re-animates each heading over 0.3 s and each
  // position over 1.1 s) is gone; on Mapbox the arrow lies flat on the map
  // (see the flat-arrow tests); the screen-space arrow is Apple Maps' only
  assert.ok(!/LocationPuck|CustomLocationProvider|puckBearing/.test(mapCode));
  assert.ok(!/<MarkerView/.test(mapCode));
  assert.ok(!/marker=\{/.test(code) && /<LocationArrow\s+rotation=\{rotationValue\}/.test(code));
  // The frame loop: camera bearing recorded as written, then the arrow turned
  // against it, for both maps (no provider guard around it)
  const loop = code.slice(code.indexOf('frameLoopRef.current = () => {'), code.indexOf('const settled ='));
  const written = loop.indexOf('mapHeadingRef.current = pose.heading;');
  const mapbox = loop.indexOf('mapboxRef.current?.setFollowCamera(pose)');
  const apple = loop.indexOf('mapRef.current?.setCamera(');
  const turn = loop.lastIndexOf('syncArrowRotation();');
  assert.ok(written > 0 && mapbox > written && apple > written && turn > mapbox && turn > apple);
  assert.ok(!/USING_MAPBOX\)\s*syncArrowRotation/.test(loop));
  assert.equal(loop.match(/syncArrowRotation\(\)/g)?.length, 1);
  // The turn itself: drawn heading less that bearing, nothing smoothed after
  const sync = code.slice(code.indexOf('const syncArrowRotation = useCallback'), code.indexOf('}, [arrowRotation, arrowPerspective]);'));
  assert.ok(/markerScreenRotation\(drawnHeadingRef\.current, mapHeadingRef\.current\)/.test(sync));
  assert.ok(!/Animated\.(timing|spring|decay)\(\s*(arrowRotation|arrowPerspective)/.test(code), 'the arrow must not be animated after the camera');
  assert.ok(!/arrowRotation\.setValue/.test(code.replace(sync, '')), 'the arrow turned somewhere else');
  // Exploring, Mapbox camera changes keep the arrow's map bearing current
  assert.ok(/onCameraChange=\{handleRegionChange\}/.test(code));
});

// ─── Keyboard avoidance on forms ────────────────────────────────────────────
// Every text field sits in a keyboard-aware container: the scroll view (or
// bottom sheet) moves only when the keyboard would cover the focused field,
// only as far as it needs, and back when the keyboard closes
// (react-native-keyboard-controller's KeyboardAwareScrollView).  The chat
// composer, pinned to the bottom, rides above the keyboard instead.  Fields at
// the top of a screen, which the keyboard can't reach, are listed with why.

import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const MOBILE = toPath(new URL('..', import.meta.url));
const KEYBOARD_CONTAINERS = ['KeyboardAwareScrollViewCompat', 'KeyboardAwareSheet', 'KeyboardAvoidingView'];
// Fields the keyboard can't reach: each sits at the top of its screen
const TOP_OF_SCREEN_FIELDS: Record<string, string[]> = {
  'app/(tabs)/(drive)/explore.tsx': ['Search places and events'],
  'app/(tabs)/community.tsx': ['Search Social'],
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? sourceFiles(p) : p.endsWith('.tsx') ? [p] : [];
  });
}

/** [start, end) of each element with this tag name (nesting-aware) */
function elementSpans(src: string, tag: string): [number, number][] {
  const spans: [number, number][] = [];
  const re = new RegExp(`<(/?)${tag}(?=[\\s>/])`, 'g');
  const stack: number[] = [];
  for (let m; (m = re.exec(src)); ) {
    if (m[1]) { const start = stack.pop(); if (start != null) spans.push([start, m.index]); continue; }
    // Self-closing: <Tag ... />
    const close = src.indexOf('>', m.index);
    if (src[close - 1] === '/') continue;
    stack.push(m.index);
  }
  return spans;
}

test('every form field is in a keyboard-aware container (or out of the keyboard\'s reach)', () => {
  const files = [...sourceFiles(join(MOBILE, 'app')), ...sourceFiles(join(MOBILE, 'components'))];
  let fields = 0;
  const uncovered: string[] = [];
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    const rel = relative(MOBILE, file);
    const spans = KEYBOARD_CONTAINERS.flatMap((t) => elementSpans(src, t));
    // JSX only (not a type such as useRef<TextInput>)
    for (const m of src.matchAll(/(?<![\w.])<TextInput(?=[\s/>])/g)) {
      fields++;
      const at = m.index!;
      if (spans.some(([a, b]) => a < at && at < b)) continue;
      const tag = src.slice(at, src.indexOf('/>', at));
      if ((TOP_OF_SCREEN_FIELDS[rel] ?? []).some((label) => tag.includes(label))) continue;
      uncovered.push(`${rel}:${src.slice(0, at).split('\n').length}`);
    }
  }
  assert.ok(fields >= 40, `only ${fields} fields found`);
  assert.deepEqual(uncovered, [], 'fields the keyboard can cover');
});

test('keyboard avoidance is measured, never a fixed shift', () => {
  const compat = readFileSync(join(MOBILE, 'components/KeyboardAwareScrollViewCompat.tsx'), 'utf8');
  const sheet = readFileSync(join(MOBILE, 'components/KeyboardAwareSheet.tsx'), 'utf8');
  const root = readFileSync(join(MOBILE, 'app/_layout.tsx'), 'utf8');
  // One app-wide gap above the keyboard, on the library's measured scroll
  const gap = readFileSync(join(MOBILE, 'lib/keyboardGap.ts'), 'utf8');
  assert.ok(/export const KEYBOARD_FIELD_GAP = (\d+);/.test(gap));
  assert.ok(Number(gap.match(/KEYBOARD_FIELD_GAP = (\d+)/)![1]) >= 12);
  assert.ok(/import \{ KEYBOARD_FIELD_GAP \} from "@\/lib\/keyboardGap"/.test(compat));
  assert.ok(/bottomOffset = KEYBOARD_FIELD_GAP/.test(compat) && /<KeyboardAwareScrollView\b[\s\S]*bottomOffset=\{bottomOffset\}/.test(compat));
  // Bottom sheets ride on the keyboard by its measured height (see the sheet tests below)
  assert.ok(/<KeyboardAvoidingView[\s\S]*keyboardVerticalOffset=\{-insets\.bottom\}/.test(sheet));
  // The library's provider wraps the whole app
  assert.ok(/<KeyboardProvider>[\s\S]*<RootLayoutNav \/>[\s\S]*<\/KeyboardProvider>/.test(root));
  // No screen shifts itself on every keyboard open, or by a fixed offset
  for (const file of [...sourceFiles(join(MOBILE, 'app')), ...sourceFiles(join(MOBILE, 'components'))]) {
    const src = readFileSync(file, 'utf8');
    const rel = relative(MOBILE, file);
    assert.ok(!/Keyboard\.addListener\(\s*['"]keyboard(Did|Will)Show/.test(src), `${rel} moves the screen on every keyboard open`);
    // An offset is 0 or a measured safe-area inset, never a number picked by hand
    for (const m of src.matchAll(/keyboardVerticalOffset=\{([^}]*)\}/g)) {
      assert.ok(/^(0|-?insets\.(bottom|top))$/.test(m[1]!.trim()), `${rel} shifts by a fixed ${m[1]}`);
    }
  }
  // The chat composer is the one pinned field that rides the keyboard
  const avoiding = sourceFiles(join(MOBILE, 'app')).filter((f) => /<KeyboardAvoidingView\b/.test(readFileSync(f, 'utf8'))).map((f) => relative(MOBILE, f)).sort();
  assert.deepEqual(avoiding, ['app/conversation/[id].tsx', 'app/search.tsx']);
});

// ─── Friends: two drivers, one server ───────────────────────────────────────
// A fake server with the real API's rules (one pending request per pair, a
// request back accepts the first, only the recipient accepts), shared by two
// apps' CloudSync.  Any call can be made to fail or to answer late: a late
// list answers with the state as it was when it was asked.

type FriendCall = 'listFriends' | 'listFriendRequests' | 'getStats' | 'sendFriendRequest' | 'acceptFriendRequest' | 'declineFriendRequest' | 'removeFriend';

class FriendsWorld {
  users = new Map<string, { id: string; name: string; code: string }>();
  requests: { id: string; from: string; to: string; status: 'pending' | 'accepted' | 'declined' | 'cancelled' }[] = [];
  friendships = new Set<string>();
  calls: string[] = [];
  fail = new Set<string>();
  hold = new Map<string, Promise<void>>();
  private n = 0;

  addUser(id: string, name: string, code: string) { this.users.set(id, { id, name, code }); }
  card(id: string) { const u = this.users.get(id)!; return { id, username: null, displayName: u.name, avatarUrl: null, level: 1 }; }
  areFriends(a: string, b: string) { return this.friendships.has(`${a}|${b}`) && this.friendships.has(`${b}|${a}`); }
  pending(a: string, b: string) { return this.requests.filter((r) => r.status === 'pending' && ((r.from === a && r.to === b) || (r.from === b && r.to === a))); }

  ep(me: string): Endpoints {
    const world = this;
    const answer = async <T>(call: FriendCall, compute: () => T): Promise<T> => {
      world.calls.push(`${me}:${call}`);
      const snapshot = compute();
      await world.hold.get(`${me}:${call}`);
      if (world.fail.has(`${me}:${call}`)) throw new NetworkError();
      return snapshot;
    };
    const act = async <T>(call: FriendCall, run: () => T): Promise<T> => {
      world.calls.push(`${me}:${call}`);
      await world.hold.get(`${me}:${call}`);
      if (world.fail.has(`${me}:${call}`)) throw new NetworkError();
      return run();
    };
    const befriend = (a: string, b: string) => { world.friendships.add(`${a}|${b}`); world.friendships.add(`${b}|${a}`); };
    const handlers: Partial<Record<keyof Endpoints, unknown>> = {
      getMe: async () => ({ id: me, username: null, displayName: world.users.get(me)!.name, bio: '', avatarUrl: null, friendCode: world.users.get(me)!.code, xp: 0, level: 1, xpIntoLevel: 0, xpToNextLevel: 1000, totalDistanceKm: 0, totalJourneys: 0, createdAt: '', settings: null }),
      listNotifications: async () => ({ items: [], unreadCount: 0 }),
      listFriends: () => answer('listFriends', () => [...world.users.keys()].filter((id) => world.friendships.has(`${me}|${id}`)).map((id) => ({ ...world.card(id), since: '' }))),
      listFriendRequests: () => answer('listFriendRequests', () => {
        const mine = world.requests.filter((r) => r.status === 'pending' && (r.from === me || r.to === me));
        const row = (r: typeof mine[number]) => ({ id: r.id, createdAt: '', user: world.card(r.from === me ? r.to : r.from) });
        return { incoming: mine.filter((r) => r.to === me).map(row), outgoing: mine.filter((r) => r.from === me).map(row) };
      }),
      getStats: () => answer('getStats', () => ({ friends: [...world.friendships].filter((f) => f.startsWith(`${me}|`)).length, vehicles: 0, journeys: 0, totalDistanceKm: 0 })),
      sendFriendRequest: (code: string) => act('sendFriendRequest', () => {
        const target = [...world.users.values()].find((u) => u.code === code);
        if (!target) throw new ApiError(404, 'user_not_found', 'No driver has that friend code.');
        if (target.id === me) throw new ApiError(400, 'cannot_add_self', "That's your own friend code.");
        if (world.areFriends(me, target.id)) throw new ApiError(409, 'already_friends', "You're already friends.");
        const pending = world.pending(me, target.id)[0];
        if (pending?.from === target.id) {
          pending.status = 'accepted';
          befriend(me, target.id);
          return { id: pending.id, status: 'accepted' as const };
        }
        if (pending) throw new ApiError(409, 'request_pending', 'A friend request is already pending.');
        const r = { id: `fr${++world.n}`, from: me, to: target.id, status: 'pending' as const };
        world.requests.push(r);
        return { id: r.id, status: 'pending' as const };
      }),
      acceptFriendRequest: (id: string) => act('acceptFriendRequest', () => {
        const r = world.requests.find((x) => x.id === id && x.to === me && x.status === 'pending');
        if (!r) throw new ApiError(404, 'not_found', 'Not found.');
        r.status = 'accepted';
        befriend(me, r.from);
      }),
      declineFriendRequest: (id: string) => act('declineFriendRequest', () => {
        const r = world.requests.find((x) => x.id === id && x.to === me && x.status === 'pending');
        if (!r) throw new ApiError(404, 'not_found', 'Not found.');
        r.status = 'declined';
      }),
      removeFriend: (other: string) => act('removeFriend', () => {
        if (!world.areFriends(me, other)) throw new ApiError(404, 'not_found', 'Not found.');
        world.friendships.delete(`${me}|${other}`);
        world.friendships.delete(`${other}|${me}`);
      }),
    };
    return new Proxy(handlers, { get: (h, name) => (h as Record<string | symbol, unknown>)[name] ?? (async () => []) }) as unknown as Endpoints;
  }

  async app(me: string) {
    const app = new CloudSync({
      ep: this.ep(me), store: new MemoryStore(), userId: me, publishableKey: 'sb_publishable_x', newId: () => Math.random().toString(36).slice(2),
      timezone: () => 'UTC', friendsRetryMs: 5,
      prepareFile: async () => ({ body: new Uint8Array([1]), size: 1, mimeType: 'image/jpeg' }),
    });
    await app.start();
    return app;
  }

  count(prefix: string) { return this.calls.filter((c) => c === prefix).length; }
}

async function twoDrivers() {
  const world = new FriendsWorld();
  world.addUser('alice', 'Alice Hart', 'ALICE234');
  world.addUser('bob', 'Bob Lane', 'BOBLANE5');
  return { world, alice: await world.app('alice'), bob: await world.app('bob') };
}
/** What each app shows in the Friends tab */
const friendsShown = (app: CloudSync) => app.data.friends.map((f) => f.name).sort();
const incomingShown = (app: CloudSync) => app.data.friendRequests.filter((r) => r.isIncoming && r.status === 'pending').map((r) => r.fromName);

test('friends: Alice sends by code, Bob sees it, accepts, and both are friends', async () => {
  const { world, alice, bob } = await twoDrivers();
  assert.equal(await alice.sendFriendRequest(' boblane5 '), 'pending');
  await alice.whenFriendsSettled();
  assert.deepEqual(incomingShown(alice), [], "the sender's own request isn't an incoming one");
  await bob.refresh();
  assert.deepEqual(incomingShown(bob), ['Alice Hart']);
  const request = bob.data.friendRequests[0]!;
  await bob.acceptFriendRequest(request.id);
  // Shown at once, before the lists reload
  assert.deepEqual(friendsShown(bob), ['Alice Hart']);
  assert.deepEqual(incomingShown(bob), []);
  await bob.whenFriendsSettled();
  await alice.refresh();
  assert.deepEqual(friendsShown(alice), ['Bob Lane']);
  assert.deepEqual(friendsShown(bob), ['Alice Hart']);
  assert.ok(world.areFriends('alice', 'bob'));
  assert.equal(world.pending('alice', 'bob').length, 0);
  assert.equal(bob.data.profileStats.friends, 1);
});

test('friends: asking each other at the same moment ends in one friendship, no error on either side', async () => {
  const { world, alice, bob } = await twoDrivers();
  const results = await Promise.all([alice.sendFriendRequest('BOBLANE5'), bob.sendFriendRequest('ALICE234')]);
  assert.deepEqual([...results].sort(), ['accepted', 'pending']);
  await Promise.all([alice.whenFriendsSettled(), bob.whenFriendsSettled()]);
  await Promise.all([alice.refresh(), bob.refresh()]);
  assert.deepEqual(friendsShown(alice), ['Bob Lane']);
  assert.deepEqual(friendsShown(bob), ['Alice Hart']);
  assert.deepEqual([incomingShown(alice), incomingShown(bob)], [[], []]);
  assert.equal(world.pending('alice', 'bob').length, 0);
  assert.equal(world.requests.length, 1, 'one request, accepted by the other ask');
});

test('friends: a double-tapped Send makes one request; sending again while it waits is not an error', async () => {
  const { world, alice } = await twoDrivers();
  const taps = await Promise.all([alice.sendFriendRequest('BOBLANE5'), alice.sendFriendRequest('BOBLANE5')]);
  assert.deepEqual(taps, ['pending', 'pending']);
  assert.equal(world.count('alice:sendFriendRequest'), 1, 'one request reached the server');
  // A later send to the same driver (another device, a lost reply) stands as sent
  assert.equal(await alice.sendFriendRequest('BOBLANE5'), 'pending');
  assert.equal(world.requests.length, 1);
  await assert.rejects(alice.sendFriendRequest('ZZZZZZZZ'), /No driver has that friend code/);
  await assert.rejects(alice.sendFriendRequest('ALICE234'), /your own friend code/);
});

test('friends: a double-tapped Accept (or Accept then Decline) answers once, without an error', async () => {
  const { world, alice, bob } = await twoDrivers();
  await alice.sendFriendRequest('BOBLANE5');
  await bob.refresh();
  const id = bob.data.friendRequests[0]!.id;
  await Promise.all([bob.acceptFriendRequest(id), bob.acceptFriendRequest(id), bob.declineFriendRequest(id)]);
  assert.equal(world.count('bob:acceptFriendRequest'), 1);
  assert.equal(world.count('bob:declineFriendRequest'), 0);
  assert.deepEqual(friendsShown(bob), ['Alice Hart']);
  assert.ok(world.areFriends('alice', 'bob'));
  // A request that's gone (cancelled, or answered elsewhere) comes off the list with a clear message
  await assert.rejects(bob.acceptFriendRequest(id), /no longer pending/);
  // Remove: twice at once is one call; already removed counts as removed
  await bob.whenFriendsSettled();
  await Promise.all([bob.removeFriend('alice'), bob.removeFriend('alice')]);
  assert.equal(world.count('bob:removeFriend'), 1);
  assert.deepEqual(friendsShown(bob), []);
  await alice.removeFriend('bob');
  assert.deepEqual(friendsShown(alice), []);
});

test('friends: an action that succeeded is shown as done even if the refresh after it fails', async () => {
  const { world, alice, bob } = await twoDrivers();
  // Send: the request reached the server; the lists can't be reloaded
  world.fail.add('alice:getStats');
  world.fail.add('alice:listFriendRequests');
  assert.equal(await alice.sendFriendRequest('BOBLANE5'), 'pending');
  world.fail.clear();
  await alice.whenFriendsSettled();
  assert.equal(alice.data.friendRequests.filter((r) => !r.isIncoming).length, 1, 'the retry caught up');

  // Accept: done on the server, but every reload fails for a while
  await bob.refresh();
  const id = bob.data.friendRequests[0]!.id;
  for (const call of ['listFriends', 'listFriendRequests', 'getStats']) world.fail.add(`bob:${call}`);
  await bob.acceptFriendRequest(id);
  assert.deepEqual(friendsShown(bob), ['Alice Hart'], 'the new friend shows straight away');
  assert.deepEqual(incomingShown(bob), [], 'the request is gone');
  // The first reload fails; the retry after it succeeds
  await new Promise((r) => setTimeout(r, 1));
  world.fail.clear();
  await bob.whenFriendsSettled();
  assert.deepEqual(friendsShown(bob), ['Alice Hart']);
  assert.equal(bob.data.profileStats.friends, 1);
  assert.ok(world.calls.filter((c) => c === 'bob:listFriends').length >= 2, 'retried');
});

test('friends: a refresh started before an action never puts the older state back', async () => {
  const { world, alice, bob } = await twoDrivers();
  await alice.sendFriendRequest('BOBLANE5');
  await bob.refresh();
  const id = bob.data.friendRequests[0]!.id;

  // The app comes to the foreground: a full sync asks for the lists (answered late)
  let release!: () => void;
  world.hold.set('bob:listFriends', new Promise<void>((r) => { release = r; }));
  const sync = bob.refresh();
  await new Promise((r) => setTimeout(r, 1));
  world.hold.clear();
  await bob.acceptFriendRequest(id);
  // Every state the screen is given from here on, not just the last one
  const shown: string[] = [];
  const unsubscribe = bob.subscribe(() => shown.push(`${friendsShown(bob).join(',')}|${incomingShown(bob).join(',')}`));
  await bob.whenFriendsSettled();
  release();
  await sync;
  unsubscribe();
  assert.deepEqual(friendsShown(bob), ['Alice Hart'], 'the old (empty) friends list was applied over the accept');
  assert.deepEqual(incomingShown(bob), [], 'the accepted request came back');
  assert.ok(shown.length > 0 && shown.every((s) => s === 'Alice Hart|'), `the older state flashed back: ${[...new Set(shown)].join(' / ')}`);

  // The same for a friends-only reload started before a remove
  let release2!: () => void;
  world.hold.set('bob:listFriends', new Promise<void>((r) => { release2 = r; }));
  const reload = bob.refreshFriends();
  await new Promise((r) => setTimeout(r, 1));
  world.hold.clear();
  await bob.removeFriend('alice');
  await bob.whenFriendsSettled();
  release2();
  await reload;
  assert.deepEqual(friendsShown(bob), [], 'the removed friend came back');
  assert.ok(!world.areFriends('alice', 'bob'));
});

test('the friends list has no path to a missing screen (no message button until messaging exists)', () => {
  const src = readFileSync(toPath(new URL('../app/(tabs)/community.tsx', import.meta.url)), 'utf8');
  const code = src.replace(/\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
  assert.ok(!/startConversation/.test(code), 'messaging is started from the Social screen');
  assert.ok(!/\/conversation/.test(code), 'the Social screen links to a conversation');
  // The friend card itself navigates nowhere
  const row = code.slice(code.indexOf('function FriendRow'), code.indexOf('function GroupCard'));
  assert.ok(row.length > 200 && !/router\.|<Link\b|href=/.test(row));
  // Every friend action button is disabled while it's in flight
  for (const action of ['acceptFriendRequest(req.id)', 'declineFriendRequest(req.id)', 'removeFriend(f.id)']) {
    assert.ok(new RegExp(`runFriendAction\\([^)]*\\)?[^;]*${action.replace(/[.()]/g, '\\$&')}`).test(code), `${action} isn't guarded`);
  }
  assert.equal(code.match(/disabled=\{!!friendBusy\[(req|item)\.id\]\}/g)?.length, 3);
  assert.ok(/disabled=\{sendingRequest\}/.test(code) && /if \(sendingRef\.current\) return;/.test(code));
});


// ─── Bottom sheets with fields (Add Friend, edit profile, delete account) ───

import { releaseDismisses, sheetDragOffset, sheetKeyboardLift, SHEET_DISMISS } from '@/lib/sheetDismiss';

test('a sheet follows the finger down, resists going up, and closes when let go far or fast enough', () => {
  assert.equal(sheetDragOffset(90), 90, 'follows the finger down');
  assert.ok(sheetDragOffset(-100) > -20, 'resists being pulled up');
  // Letting go: far enough or fast enough closes; a short slow drag snaps back
  const sheet = 420;
  assert.equal(releaseDismisses(40, 0.1, sheet), false);
  assert.equal(releaseDismisses(SHEET_DISMISS.dismissDistance, 0.1, sheet), true);
  assert.equal(releaseDismisses(30, 1.2, sheet), true, 'a flick');
  assert.equal(releaseDismisses(-50, 2, sheet), false, 'a flick upwards');
  assert.equal(releaseDismisses(70, 0.1, 200), true, 'a short sheet needs a shorter drag');
});

test('with the keyboard open, the field and the button under it sit above the keyboard; closed, the sheet is back', () => {
  // The Add Friend sheet as laid out (community.tsx modalContent): its bottom
  // padding keeps the home indicator clear; Send Request sits on that padding,
  // the friend code field a little above it
  for (const [phone, screen, keyboard, inset, statusBar] of [['iPhone 15', 852, 336, 34, 59], ['iPhone SE', 667, 260, 0, 20], ['iPhone 15 Pro Max', 932, 346, 34, 59]] as const) {
    const sheetPadding = Math.max(inset, 16) + 16;
    // Its styles, top to bottom: padding, handle, title, label, field, label,
    // your code, note, Send Request, bottom padding
    const fieldBottomInSheet = 24 + (4 + 20) + (25 + 20) + (12 + 16 + 6) + 46;
    const buttonBottomInSheet = fieldBottomInSheet + (16 + 16 + 6) + 50 + (4 + 15 + 12) + (20 + 47);
    const sheetHeight = buttonBottomInSheet + sheetPadding;
    const sheetTop = (lift: number) => screen - lift - sheetHeight;
    // Keyboard open: the sheet rises by the keyboard less the inset it already keeps clear
    const lift = sheetKeyboardLift(keyboard, inset);
    const keyboardTop = screen - keyboard;
    const buttonBottom = sheetTop(lift) + buttonBottomInSheet;
    const fieldBottom = sheetTop(lift) + fieldBottomInSheet;
    assert.ok(keyboardTop - buttonBottom >= 16, `${phone}: Send Request ${keyboardTop - buttonBottom} pt above the keyboard`);
    assert.ok(fieldBottom < buttonBottom, `${phone}: the field is above the button`);
    assert.ok(sheetTop(lift) + 24 >= statusBar, `${phone}: the sheet's content runs under the status bar (top at ${sheetTop(lift)})`);
    // Exactly enough: the gap is the sheet's own padding less the home indicator area
    assert.equal(keyboardTop - buttonBottom, sheetPadding - inset);
    // Keyboard closed: back where it was
    assert.equal(sheetKeyboardLift(0, inset), 0);
    assert.equal(screen - (sheetTop(0) + buttonBottomInSheet), sheetPadding);
  }
});

test('sheets with fields: no keyboard-aware ScrollView inside their Modal, and every way out closes them', () => {
  const read = (rel: string) => readFileSync(toPath(new URL(rel, import.meta.url)), 'utf8');
  const sheet = read('../components/KeyboardAwareSheet.tsx');
  const code = sheet.replace(/\/\/.*$/gm, '');
  // The crash: react-native-keyboard-controller's ScrollView in the Modal.
  // The sheet uses React Native's own KeyboardAvoidingView instead.
  assert.ok(!/react-native-keyboard-controller|KeyboardAwareScrollView/.test(code));
  assert.ok(/KeyboardAvoidingView,[\s\S]*from "react-native"/.test(code));
  // Its own Modal, closed by: the system (onRequestClose), a tap on the backdrop,
  // the accessibility escape gesture, and a swipe down
  assert.ok(/<Modal[\s\S]*visible=\{shown\}[\s\S]*onRequestClose=\{close\}/.test(code));
  assert.ok(/<AnimatedPressable[\s\S]*onPress=\{close\}/.test(code));
  assert.ok(/onAccessibilityEscape=\{close\}/.test(code));
  assert.ok(/releaseDismisses\(/.test(code) && /sheetDragStep\(/.test(code));
  // Every close slides away (keyboard put away first), then tells the screen
  assert.ok(/const close = useCallback\(\(\) => dismiss\(0\)/.test(code));
  assert.ok(/closing\.current = true;\s*Keyboard\.dismiss\(\);/.test(code));
  assert.ok(/leave\(velocity, \(\) => \{\s*setShown\(false\);\s*onCloseRef\.current\(\);/.test(code));

  // Every sheet that uses it: no Modal of its own around it, and nothing
  // keyboard-aware (a ScrollView from the library) inside it
  for (const rel of ['../app/(tabs)/community.tsx', '../app/(tabs)/profile.tsx', '../app/settings.tsx']) {
    const src = read(rel);
    for (const m of src.matchAll(/<KeyboardAwareSheet\b/g)) {
      const body = src.slice(m.index!, src.indexOf('</KeyboardAwareSheet>', m.index!));
      assert.ok(/visible=\{\w+\}/.test(body) && /onClose=\{/.test(body), `${rel}: sheet without visible/onClose`);
      assert.ok(!/KeyboardAwareScrollView|<Modal\b/.test(body), `${rel}: a ScrollView or Modal nested in the sheet`);
      const before = src.slice(Math.max(0, m.index! - 200), m.index!);
      assert.ok(!/<Modal[^>]*>\s*$/.test(before), `${rel}: the sheet is wrapped in another Modal`);
    }
  }
});

test('Add Friend opens from every entry point, closes any way, and reopens empty', () => {
  const src = readFileSync(toPath(new URL('../app/(tabs)/community.tsx', import.meta.url)), 'utf8');
  const code = src.replace(/\/\/.*$/gm, '');
  // Its sheet is shown by showAddFriend, and closing it goes through one function
  assert.ok(/<KeyboardAwareSheet\s+visible=\{showAddFriend\}\s+onClose=\{closeAddFriend\}/.test(code));
  // which clears what was typed, so reopening starts empty
  assert.ok(/const closeAddFriend = \(\) => \{\s*setShowAddFriend\(false\);\s*setFriendSearch\(""\);\s*\};/.test(code));
  // Sent: closed the same way; not sent: stays open with the code kept for a retry
  const send = code.slice(code.indexOf('const result = await sendFriendRequest(code);'), code.indexOf('setSendingRequest(false);'));
  assert.ok(/closeAddFriend\(\);/.test(send));
  assert.ok(!/setShowAddFriend\(false\)|setFriendSearch\(""\)/.test(send.slice(send.indexOf('catch'))));
  // Opened from the header (overview and Friends tabs) and the empty friends list
  assert.equal(code.match(/setShowAddFriend\(true\)/g)?.length, 3);
  // Phase 1 guards are still on Send Request
  assert.ok(/disabled=\{sendingRequest\}/.test(code) && /if \(sendingRef\.current\) return;/.test(code));
});

test('a sheet\'s dimmed backdrop stays full-screen and still; only the panel rides on the keyboard', () => {
  const src = readFileSync(toPath(new URL('../components/KeyboardAwareSheet.tsx', import.meta.url)), 'utf8');
  const code = src.replace(/\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
  const tree = code.slice(code.indexOf('<Modal'), code.indexOf('</Modal>'));
  const kav = tree.slice(tree.indexOf('<KeyboardAvoidingView'), tree.indexOf('</KeyboardAvoidingView>'));
  // The backdrop: a full-screen layer of its own, outside the keyboard handling
  const backdrop = tree.slice(tree.indexOf('<AnimatedPressable'), tree.indexOf('/>', tree.indexOf('<AnimatedPressable')));
  assert.ok(/StyleSheet\.absoluteFill/.test(backdrop) && /backgroundColor: backdropColor/.test(backdrop), 'the backdrop is not the full-screen layer');
  assert.ok(tree.indexOf('<AnimatedPressable') < tree.indexOf('<KeyboardAvoidingView'), 'the backdrop must sit behind the sheet');
  assert.ok(!/backdropColor|Pressable/.test(kav), 'the backdrop moves with the keyboard');
  // Nothing else is tinted: the Modal's root view carries no colour
  const root = tree.slice(tree.indexOf('<GestureHandlerRootView'), tree.indexOf('>', tree.indexOf('<GestureHandlerRootView')));
  assert.ok(root.length > 10, 'no gesture root inside the Modal');
  assert.ok(!/backgroundColor/.test(root), 'the root view is tinted (and the sheet sits inside it)');
  // The keyboard handling wraps only the panel, docked to the screen's bottom edge
  assert.ok(/style=\{\[\s*styles\.sheetDock,/.test(kav));
  // A long sheet's dock reaches up to below the status bar, but stays transparent
  // to touches, so a tap above the panel still lands on the backdrop
  assert.ok(/scrollable && \{\s*top: insets\.top \+ SHEET_DISMISS\.topGap,/.test(kav));
  assert.ok(/pointerEvents="box-none"/.test(kav));
  assert.ok(/sheetDock: \{ position: "absolute", left: 0, right: 0, bottom: 0 \}/.test(code));
  assert.ok(/<Animated\.View[\s\S]*\{children\}[\s\S]*<\/Animated\.View>/.test(kav), 'the panel is inside the keyboard handling');
  // Lift, dismissal and escape unchanged
  assert.ok(/keyboardVerticalOffset=\{-insets\.bottom\}/.test(kav));
  assert.ok(/onPress=\{close\}/.test(backdrop) && /onAccessibilityEscape=\{close\}/.test(kav) && /<GestureDetector gesture=\{pan\}>/.test(kav));
  // Its opacity follows the sheet (so it fades as the sheet is dragged away), not a separate animation
  assert.ok(/opacity: backdropOpacity/.test(backdrop) && /const backdropOpacity = translateY\.interpolate\(/.test(code));
});


// ─── Every sheet with fields: one shared sheet ──────────────────────────────

import { revealScrollOffset } from '@/lib/sheetDismiss';

test("a long sheet's fields scroll into view above the keyboard", () => {
  // Already fully visible (with the gap): nothing moves
  assert.equal(revealScrollOffset(100, 150, 0, 400, 24), null);
  // The keyboard shortened the view and the field is now below it: just far enough
  assert.equal(revealScrollOffset(300, 350, 0, 300, 24), 74);
  // Above the visible part: back up to it
  assert.equal(revealScrollOffset(40, 90, 200, 300, 24), 16);
  // A field taller than the view shows its top (where the caret starts)
  assert.equal(revealScrollOffset(500, 1000, 0, 300, 24), 476);
});

test('no sheet with fields is a one-off Modal: every one is the shared sheet, and none can trap the user', () => {
  const read = (rel: string) => readFileSync(join(MOBILE, rel), 'utf8');
  // Any Modal in the app that has a text field in it is a one-off sheet
  for (const file of sourceFiles(join(MOBILE, 'app'))) {
    const src = readFileSync(file, 'utf8');
    for (const [a, b] of elementSpans(src, 'Modal')) {
      assert.ok(!/<TextInput\b/.test(src.slice(a, b)), `${relative(MOBILE, file)}: a Modal with fields (use KeyboardAwareSheet)`);
    }
  }
  // The four that were trapping (or crash-prone) are on it, as long sheets
  const sheets = [
    ['app/(tabs)/community.tsx', 'showCreateGroup', 'closeCreateGroup'],
    ['app/(tabs)/community.tsx', 'showCreateConvoy', 'closeCreateConvoy'],
    ['app/(tabs)/community.tsx', 'showCreateEvent', 'closeCreateEvent'],
    ['components/places/SavePlaceSheet.tsx', 'visible', 'onClose'],
  ] as const;
  for (const [rel, show, close] of sheets) {
    const src = read(rel).replace(/\/\/.*$/gm, '');
    const at = src.search(new RegExp(`<KeyboardAwareSheet\\s+visible=\\{${show}\\}\\s+onClose=\\{${close}\\}`));
    assert.ok(at > 0, `${rel}: ${show} isn't a KeyboardAwareSheet closing through ${close}`);
    const body = src.slice(at, src.indexOf('</KeyboardAwareSheet>', at));
    const head = body.slice(0, body.indexOf('>'));
    assert.ok(/backdropColor=/.test(head) && /scrollable/.test(head), `${rel}: ${show} has no backdrop or isn't scrollable`);
    // Its fields scroll inside the panel; nothing from the keyboard library, no nested Modal
    assert.ok(/<SheetScrollView\b/.test(body) && /<TextInput\b/.test(body.slice(body.indexOf('<SheetScrollView'))));
    assert.ok(!/KeyboardAwareScrollView|<Modal\b/.test(body), `${rel}: ${show} nests a ScrollView or Modal`);
  }
  for (const rel of ['app/(tabs)/community.tsx', 'app/search.tsx', 'components/places/SavePlaceSheet.tsx']) {
    assert.ok(!/KeyboardAwareScrollViewCompat|\bModal,/.test(read(rel)), `${rel} still uses the old pattern`);
  }
});

test('Create Group, Convoy and Event close without creating, reset their forms, reopen blank, and still create', () => {
  const src = readFileSync(join(MOBILE, 'app/(tabs)/community.tsx'), 'utf8').replace(/\/\/.*$/gm, '');
  for (const [kind, add, required] of [['Group', 'addGroup', 'newGroup.name'], ['Convoy', 'addConvoy', 'newConvoy.name'], ['Event', 'addEvent', 'newEvent.name']] as const) {
    const blank = `BLANK_${kind.toUpperCase()}`;
    // One blank form, for the first opening and every reset
    assert.ok(new RegExp(`const ${blank} = \\{`).test(src) && new RegExp(`useState\\(${blank}\\)`).test(src), `${kind}: no shared blank form`);
    // Dismissing (backdrop, swipe, escape all call onClose) closes and clears it
    assert.ok(new RegExp(`const closeCreate${kind} = \\(\\) => \\{\\s*setShowCreate${kind}\\(false\\);\\s*setNew${kind}\\(${blank}\\);\\s*\\};`).test(src), `${kind}: closing doesn't reset`);
    // Opening shows the (blank) form again
    assert.ok(new RegExp(`setShowCreate${kind}\\(true\\)`).test(src));
    // Submitting: still validated first (an invalid form stays open with what was typed),
    // then created, then closed through the same reset
    const handler = src.slice(src.indexOf(`function handleCreate${kind}()`), src.indexOf('\n  }\n', src.indexOf(`function handleCreate${kind}()`)));
    const check = handler.indexOf(`!${required}.trim()`), create = handler.indexOf(`${add}({`), done = handler.indexOf(`closeCreate${kind}();`);
    assert.ok(check > 0 && create > check && done > create, `${kind}: validate → create → close order broken`);
    assert.ok(/return;/.test(handler.slice(check, create)), `${kind}: an invalid form doesn't stop`);
    // The drag handle stays outside the scrolling fields, so it always drags the sheet
    const sheet = src.slice(src.indexOf(`visible={showCreate${kind}}`), src.indexOf('</KeyboardAwareSheet>', src.indexOf(`visible={showCreate${kind}}`)));
    assert.ok(sheet.indexOf('styles.modalHandle') < sheet.indexOf('<SheetScrollView'), `${kind}: the handle scrolls away`);
    assert.ok(new RegExp(`onPress=\\{handleCreate${kind}\\}`).test(sheet), `${kind}: submit not wired`);
  }
  // Save Place: reset on every opening, Cancel and a successful save close it
  const save = readFileSync(join(MOBILE, 'components/places/SavePlaceSheet.tsx'), 'utf8');
  assert.ok(/if \(visible\) \{\s*setKind\(defaultKind\);\s*setName\(""\);\s*setDescription\(""\);/.test(save));
  assert.ok(/await onSave\([\s\S]*?onClose\(\);/.test(save) && /onPress=\{onClose\}[\s\S]*?Cancel/.test(save));
});

test('a long sheet: scrolls only when its fields overflow, and keeps the focused field in view', () => {
  const code = readFileSync(join(MOBILE, 'components/KeyboardAwareSheet.tsx'), 'utf8').replace(/\/\/.*$/gm, '');
  const view = code.slice(code.indexOf('export function SheetScrollView'));
  assert.ok(/scrollEnabled=\{overflows\}/.test(view), 'scrolls (and steals drags from the sheet) even when everything fits');
  // The keyboard shortening the view brings the focused field back into it
  assert.ok(/if \(shrank\) revealFocused\(\)/.test(view) && /revealScrollOffset\(/.test(view));
  assert.ok(/import \{ KEYBOARD_FIELD_GAP \} from "@\/lib\/keyboardGap"/.test(code));
  // The panel shrinks to fit rather than running off the top
  assert.ok(/scrollable && styles\.shrink/.test(code) && /shrink: \{ flexShrink: 1 \}/.test(code));
  const community = readFileSync(join(MOBILE, 'app/(tabs)/community.tsx'), 'utf8');
  assert.ok(/modalScrollable: \{ flexShrink: 1 \}/.test(community));
  assert.ok(/flexShrink: 1,/.test(readFileSync(join(MOBILE, 'components/places/SavePlaceSheet.tsx'), 'utf8')));
});

// ─── Dragging a sheet like an iOS bottom sheet ──────────────────────────────

import { backdropOpacity, dismissDuration, sheetDragStep, SHEET_MOTION } from '@/lib/sheetDismiss';

/**
 * A drag as the sheet runs it: each gesture frame (finger travel since
 * touch-down, and whether the scrolling fields are at their top) goes through
 * sheetDragStep; letting go decides between closing and springing back.
 */
function dragSheet(frames: { dy: number; atTop?: boolean }[], opts: { inContent?: boolean; start?: number; velocity?: number; sheetHeight?: number } = {}) {
  let handoffAt: number | null = null;
  let offset = opts.start ?? 0;
  const drawn: (number | null)[] = [];
  for (const f of frames) {
    const step = sheetDragStep(f.dy, opts.inContent ?? false, f.atTop ?? true, handoffAt, opts.start ?? 0);
    handoffAt = step.handoffAt;
    drawn.push(step.offset);
    if (step.offset !== null) offset = step.offset;
  }
  const closes = releaseDismisses(offset, opts.velocity ?? 0, opts.sheetHeight ?? 420);
  return { drawn, offset, closes };
}

test('a dragged sheet follows the finger exactly, from wherever it was', () => {
  const { drawn } = dragSheet([{ dy: 10 }, { dy: 40 }, { dy: 95 }, { dy: 60 }]);
  assert.deepEqual(drawn, [10, 40, 95, 60], 'the sheet is where the finger is');
  // Caught mid-animation (still rising, 30 pt below rest): it carries on from there
  assert.deepEqual(dragSheet([{ dy: 10 }, { dy: 25 }], { start: 30 }).drawn, [40, 55]);
  // Pushed up past its resting place it gives a little, not one for one
  const up = dragSheet([{ dy: -60 }]).drawn[0]!;
  assert.ok(up < 0 && up > -60 * 0.2, `moved ${up} for a 60 pt push up`);
});

test('let go: a short slow drag springs back; far enough, or a downward flick, carries it off', () => {
  // A short, slow drag: back into place
  assert.equal(dragSheet([{ dy: 20 }, { dy: 45 }], { velocity: 0.2 }).closes, false);
  // Far enough (30% of the sheet, at most 120 pt): closes
  assert.equal(dragSheet([{ dy: 60 }, { dy: 130 }], { velocity: 0.1 }).closes, true);
  assert.equal(dragSheet([{ dy: 70 }], { velocity: 0, sheetHeight: 200 }).closes, true, 'a short sheet needs a shorter drag');
  // A flick: closes even when short
  assert.equal(dragSheet([{ dy: 25 }], { velocity: SHEET_DISMISS.dismissVelocity + 0.1 }).closes, true);
  // Dragged down then pushed back up and let go there: stays
  assert.equal(dragSheet([{ dy: 150 }, { dy: 20 }], { velocity: -0.5 }).closes, false);
  // Leaving: a flick carries on at its own speed (faster flick, quicker exit),
  // within bounds; otherwise the opening in reverse, at its full duration
  assert.equal(dismissDuration(300, 0), SHEET_MOTION.closeMs);
  assert.ok(dismissDuration(300, 3) < dismissDuration(300, 1.5));
  assert.ok(dismissDuration(300, 50) >= SHEET_MOTION.minFlingMs, 'never just vanishes');
  assert.ok(dismissDuration(1000, 1.3) <= SHEET_MOTION.closeMs);
  // The backdrop dims with the sheet: full at rest, gone below the screen
  assert.equal(backdropOpacity(0, 400), 1);
  assert.equal(backdropOpacity(200, 400), 0.5);
  assert.equal(backdropOpacity(400, 400), 0);
  assert.equal(backdropOpacity(-20, 400), 1);
});

test('a long sheet: a drag in its fields scrolls them, and only at their top does it take the sheet', () => {
  // Fields scrolled down: a downward drag scrolls them back up; the sheet stays put
  // until they reach their top (here after 40 pt), then follows the finger from there
  const frames = [
    { dy: 15, atTop: false },
    { dy: 40, atTop: true },
    { dy: 70, atTop: true },
    { dy: 160, atTop: true },
  ];
  const r = dragSheet(frames, { inContent: true });
  assert.deepEqual(r.drawn, [null, 0, 30, 120], 'the sheet moved before the fields reached their top, or jumped');
  assert.equal(r.closes, true);
  // Pushed back up past where it took over: the sheet sits at rest and the fields scroll again
  const back = dragSheet([{ dy: 10, atTop: true }, { dy: 60, atTop: true }, { dy: 5, atTop: true }, { dy: -40, atTop: false }], { inContent: true });
  assert.deepEqual(back.drawn, [0, 50, 0, null]);
  assert.equal(back.closes, false);
  // Fields that don't scroll count as at their top: the sheet follows straight away
  assert.deepEqual(dragSheet([{ dy: 10 }, { dy: 50 }], { inContent: true }).drawn, [0, 40]);
  // Scrolling the fields (never at the top) never moves the sheet
  assert.deepEqual(dragSheet([{ dy: -30, atTop: false }, { dy: 30, atTop: false }], { inContent: true }).drawn, [null, null]);
  // The handle (or anything outside the fields) drags the sheet whatever the fields are doing
  assert.deepEqual(dragSheet([{ dy: 30, atTop: false }], { inContent: false }).drawn, [30]);
});

test('the shared sheet opens from below, is dragged with the finger, and slides away to close', () => {
  const code = readFileSync(join(MOBILE, 'components/KeyboardAwareSheet.tsx'), 'utf8').replace(/\/\/.*$/gm, '');
  // It animates itself: no Modal slide; opens hidden below the screen, then
  // (once laid out) springs up from just below the edge to rest
  assert.ok(/animationType="none"/.test(code));
  assert.ok(/new Animated\.Value\(screenHeight\)/.test(code));
  assert.ok(/if \(opening\.current\) \{\s*opening\.current = false;\s*translateY\.setValue\(h\);\s*Animated\.spring\(translateY, \{\s*toValue: 0,\s*\.\.\.SHEET_MOTION\.spring,/.test(code), 'does not rise from below');
  // Closing reverses it: down to just below the edge, at the flick's speed or eased in
  assert.ok(/const offscreen = \(\) => sheetHeightRef\.current \|\| screenHeight;/.test(code));
  assert.ok(/Animated\.timing\(translateY, \{\s*toValue: to,\s*duration: dismissDuration\(/.test(code));
  assert.ok(/Easing\.in\(Easing\.cubic\)/.test(code));
  // The drag: Gesture Handler's pan, side by side with the fields' scrolling,
  // vertical only, and only once moved (a tap stays a tap)
  assert.ok(!/PanResponder/.test(code));
  assert.ok(/Gesture\.Pan\(\)\s*\.runOnJS\(true\)/.test(code));
  assert.ok(/\.activeOffsetY\(\[/.test(code) && /\.failOffsetX\(\[/.test(code));
  assert.ok(/\.simultaneousWithExternalGesture\(scrollGesture\)/.test(code));
  assert.ok(/translateY\.setValue\(step\.offset\)/.test(code), 'the sheet does not follow the finger');
  assert.ok(/if \(releaseDismisses\(offset, perMs, sheetHeightRef\.current\)\) \{\s*dismiss\(perMs\);\s*\} else \{\s*settle\(e\.velocityY\);/.test(code));
  // Spring velocity in points per second (Animated.spring's unit), the rules per millisecond
  assert.ok(/const perMs = e\.velocityY \/ 1000;/.test(code));
  // Taking hold mid-animation starts from where the sheet actually is
  assert.ok(/\.onStart\(\(\) => \{\s*translateY\.stopAnimation\(\);\s*drag\.current\.start = position\.current;/.test(code));
  // A screen that mounts with its sheet closed doesn't animate (or put the keyboard away)
  assert.ok(/\} else if \(shownRef\.current && !closing\.current\) \{/.test(code));
  // Gestures inside a Modal need their own gesture root
  assert.ok(/<Modal[\s\S]*<GestureHandlerRootView[\s\S]*<\/GestureHandlerRootView>\s*<\/Modal>/.test(code));
  // The fields' scroll view: its native scrolling is the gesture the drag runs beside,
  // it doesn't bounce at the top (a pull there moves the sheet), and it tells the drag
  // where it is and whether it's at its top
  const view = code.slice(code.indexOf('export function SheetScrollView'));
  assert.ok(/<GestureDetector gesture=\{sheet\.scrollGesture\}>/.test(view));
  assert.ok(/bounces=\{false\}/.test(view));
  assert.ok(/atTop: \(\) => !overflowsRef\.current \|\| scrollY\.current <= 0/.test(view));
  assert.ok(/if \(d\.inContent && step\.offset > 0\) scroll\.current\?\.holdAtTop\(\)/.test(code), 'the fields scroll while the sheet is dragged');
  // Only a touch that lands in the fields waits for them to reach their top;
  // the handle (above them) drags the sheet straight away
  assert.ok(/d\.inContent = scroll\.current != null && e\.y >= scroll\.current\.top;/.test(code), 'the handle does not drag the sheet directly');
  // The backdrop fades as the sheet goes down: full at rest, clear a sheet's height down
  assert.ok(/translateY\.interpolate\(\{\s*inputRange: \[0, Math\.max\(sheetHeight, 1\)\],\s*outputRange: \[1, 0\],\s*extrapolate: "clamp",/.test(code), 'the backdrop does not fade with the sheet');
});

// ─── Presence ───────────────────────────────────────────────────────────────
import { friendStatus, showsActivityStatus, toFriend } from '@/lib/backend/mappers';
import { PRESENCE_HEARTBEAT_MS, PresenceReporter, type PresenceUpdate } from '@/lib/backend/presence';
import type { ServerFriend } from '@/lib/backend/endpoints';

const card = (presence?: ServerFriend['presence']): ServerFriend => ({
  id: 'f1', username: null, displayName: 'Sam Driver', avatarUrl: null, level: 3, since: '2026-10-01T00:00:00Z',
  ...(presence === undefined ? {} : { presence }),
});

test('friends show the status the server reports, not a hard-coded Offline', () => {
  const seen = '2026-10-06T10:00:00.000Z';
  const online = toFriend(card({ status: 'online', lastSeenAt: seen }));
  assert.equal(online.status, 'online');
  assert.equal(online.presence, 'online');
  assert.equal(online.lastSeenAt, seen);
  assert.equal(toFriend(card({ status: 'driving', lastSeenAt: seen })).status, 'driving');
  const offline = toFriend(card({ status: 'offline', lastSeenAt: seen }));
  assert.equal(offline.status, 'offline');
  assert.equal(offline.lastSeenAt, seen, 'last active kept for "Last active…"');
  assert.equal(toFriend(card({ status: 'offline', lastSeenAt: null })).lastSeenAt, null);
});

test('Away shows as offline for now, keeping the real status and last active time', () => {
  const away = toFriend(card({ status: 'away', lastSeenAt: '2026-10-06T10:00:00.000Z' }));
  assert.equal(away.status, 'offline');
  assert.equal(away.presence, 'away');
  assert.equal(away.lastSeenAt, '2026-10-06T10:00:00.000Z');
});

test('hidden or missing presence is safe: offline, nothing else known', () => {
  for (const f of [toFriend(card(null)), toFriend(card(undefined))]) {
    assert.equal(f.status, 'offline');
    assert.equal(f.presence, null);
    assert.equal(f.lastSeenAt, null);
  }
  assert.equal(friendStatus({ status: 'bogus' as never, lastSeenAt: null }), 'offline', 'unknown values never crash');
});

test('the Show Activity Status setting maps from the server, defaulting on', () => {
  assert.equal(showsActivityStatus({ showActivityStatus: true }), true);
  assert.equal(showsActivityStatus({ showActivityStatus: false }), false);
  assert.equal(showsActivityStatus({}), true, 'an older server without the setting: on, its default');
});

/** A reporter with a fake clock, interval and API. */
function presenceRig(opts: { fail?: (u: PresenceUpdate) => unknown } = {}) {
  const sent: PresenceUpdate[] = [];
  const clock = { t: 1_000_000 };
  const intervals = new Map<number, () => void>();
  let nextId = 1;
  const reporter = new PresenceReporter({
    send: async (u) => { sent.push(u); const e = opts.fail?.(u); if (e) throw e; return {}; },
    now: () => clock.t,
    setInterval: (fn) => { const id = nextId++; intervals.set(id, fn); return id; },
    clearInterval: (id) => { intervals.delete(id as number); },
  });
  const tick = async () => { clock.t += PRESENCE_HEARTBEAT_MS; for (const fn of [...intervals.values()]) fn(); await settle(); };
  return { reporter, sent, clock, intervals, tick };
}

test('presence: reports at once on start, then every minute on screen, with one timer', async () => {
  const r = presenceRig();
  r.reporter.start('foreground', { driving: false, journeyId: null });
  await settle();
  assert.deepEqual(r.sent, [{ appState: 'foreground', driving: false }]);
  r.reporter.start('foreground', { driving: false, journeyId: null }); // started twice: still one timer
  r.reporter.setAppState('foreground'); // no change: nothing sent
  assert.equal(r.intervals.size, 1);
  await r.tick(); await r.tick();
  assert.equal(r.sent.length, 3, 'heartbeat every 60 s');
  assert.ok(r.sent.every((u) => u.appState === 'foreground'));
});

test('presence: background is reported at once and stops the heartbeat; returning resumes it', async () => {
  const r = presenceRig();
  r.reporter.start('foreground', { driving: false, journeyId: null });
  await settle();
  r.reporter.setAppState('background');
  await settle();
  assert.deepEqual(r.sent.at(-1), { appState: 'background', driving: false });
  assert.equal(r.intervals.size, 0, 'no heartbeat in the background when not driving');
  await r.tick();
  assert.equal(r.sent.length, 2);
  r.reporter.setAppState('foreground');
  await settle();
  assert.deepEqual(r.sent.at(-1), { appState: 'foreground', driving: false });
  assert.equal(r.intervals.size, 1);
});

test('presence: driving with its journey; backgrounding keeps driving; drive fixes keep it fresh', async () => {
  const r = presenceRig();
  r.reporter.start('foreground', { driving: false, journeyId: null });
  r.reporter.setDrive({ driving: true, journeyId: null }); // started offline: no server journey yet
  await settle();
  assert.deepEqual(r.sent.at(-1), { appState: 'foreground', driving: true });
  r.reporter.setDrive({ driving: true, journeyId: 'j1' });
  await settle();
  assert.deepEqual(r.sent.at(-1), { appState: 'foreground', driving: true, journeyId: 'j1' });
  r.reporter.setAppState('background');
  await settle();
  assert.deepEqual(r.sent.at(-1), { appState: 'background', driving: true, journeyId: 'j1' }, 'backgrounding never clears driving');
  // Phone locked: background fixes refresh presence, at most once a minute
  const before = r.sent.length;
  for (let i = 0; i < 30; i++) { r.clock.t += 5_000; r.reporter.noteDriveActivity(); await settle(); }
  assert.equal(r.sent.length - before, 2, '150 s of fixes: 2 heartbeats, not 30');
  r.reporter.setDrive({ driving: false, journeyId: 'j1' });
  await settle();
  assert.deepEqual(r.sent.at(-1), { appState: 'background', driving: false }, 'journey cleared when the drive ends');
  const after = r.sent.length;
  r.reporter.noteDriveActivity();
  await settle();
  assert.equal(r.sent.length, after, 'no drive heartbeats once not driving');
});

test('presence: failures are swallowed; a journey the server no longer accepts is dropped', async () => {
  const r = presenceRig({ fail: (u) => (u.journeyId === 'gone' ? new ApiError(400, 'invalid_journey', 'x') : u.appState === 'background' ? new NetworkError() : null) });
  r.reporter.start('foreground', { driving: true, journeyId: 'gone' });
  await settle(); await settle();
  assert.deepEqual(r.sent.slice(-1), [{ appState: 'foreground', driving: true, journeyId: null }], 'resent without the journey');
  r.reporter.setAppState('background'); // offline: rejected, nothing thrown
  await settle();
  r.reporter.setAppState('foreground');
  await settle();
  assert.deepEqual(r.sent.at(-1), { appState: 'foreground', driving: true }, 'carries on afterwards');
});

test('presence: sign-out reports signed_out, stops everything, and never blocks on failure', async () => {
  const r = presenceRig();
  r.reporter.start('foreground', { driving: true, journeyId: 'j1' });
  await settle();
  await r.reporter.signOut();
  assert.deepEqual(r.sent.at(-1), { appState: 'signed_out' });
  assert.equal(r.intervals.size, 0);
  assert.equal(r.reporter.isRunning, false);
  const count = r.sent.length;
  r.reporter.setAppState('background'); r.reporter.noteDriveActivity(); await r.tick();
  assert.equal(r.sent.length, count, 'nothing sent after sign-out');
  // Network down: sign-out still completes, quickly
  const down = presenceRig({ fail: () => new NetworkError() });
  down.reporter.start('foreground', { driving: false, journeyId: null });
  const t = Date.now();
  await down.reporter.signOut();
  assert.ok(Date.now() - t < 1000);
  await new PresenceReporter({ send: async () => ({}) }).signOut(); // never started: no request, no throw
});

test('CloudSync reports drive start, server journey, end, discard and recovery to presence', async () => {
  const b = backgroundApp();
  const events: Array<{ driving: boolean; journeyId: string | null }> = [];
  let activity = 0;
  b.app.onDriveChange((d) => events.push(d));
  b.app.onDriveActivity(() => { activity++; });
  await b.app.start();
  assert.deepEqual(events, [], 'nothing to report with no drive');
  await b.app.startDrive(null);
  await settle();
  const serverId = b.server.journeys[0]!.id;
  assert.deepEqual(events, [{ driving: true, journeyId: null }, { driving: true, journeyId: serverId }]);
  assert.deepEqual(b.app.driveState, { driving: true, journeyId: serverId });
  for (let s = 0; s < 30; s++) { b.clock.t += 1000; await b.tracker.deliver([roadFix(b.clock, s)]); }
  b.app.setDrivePaused(true);
  b.clock.t += 1000; await b.tracker.deliver([roadFix(b.clock, 31)]);
  assert.equal(activity, 31, 'every drive fix, background and paused included, counts as activity');
  b.app.setDrivePaused(false);
  await b.app.endDrive();
  assert.deepEqual(events.at(-1), { driving: false, journeyId: null });
  await b.app.startDrive(null);
  await settle();
  await b.app.discardDrive();
  assert.deepEqual(events.at(-1), { driving: false, journeyId: null }, 'discarding clears driving');

  // Relaunch with a drive still recording in the background: Driving again
  const store = new MemoryStore();
  const clock = { t: Date.now() - 60 * 60_000 };
  const updates = new FakeUpdates();
  const first = backgroundApp(store, clock, updates);
  await first.app.start();
  await first.app.startDrive(null);
  await settle();
  for (let s = 0; s < 30; s++) { clock.t += 1000; first.app.addFix(roadFix(clock, s)); }
  await first.app.saveActiveNow();
  const again = backgroundApp(store, clock, updates);
  const seen: boolean[] = [];
  again.app.onDriveChange((d) => seen.push(d.driving));
  await again.app.start();
  assert.deepEqual(seen, [true], 'recovered drive reported as driving');
  assert.equal(again.app.driveState.driving, true);
});

// ─── Presence: a friend sees the drive (real-device regression) ─────────────
// On two devices the driver reported Driving but the friend's list kept
// showing Online: Community had no way to reload friends (no pull-to-refresh,
// nothing on focus), so it showed whatever was loaded at app start.
import type { PresenceLogEntry } from '@/lib/backend/presence';

/** The presence API as the server implements it (0016), for two users. */
class PresenceServer {
  clock = { t: Date.now() };
  rows = new Map<string, { appState: string; driving: boolean; journeyId: string | null; lastSeen: number }>();
  status(id: string): 'online' | 'away' | 'offline' | 'driving' {
    const r = this.rows.get(id);
    if (!r || r.appState === 'signed_out') return 'offline';
    const age = this.clock.t - r.lastSeen;
    if (r.driving && age <= 3 * 60_000) return 'driving';
    if (age > 10 * 60_000) return 'offline';
    return r.appState === 'foreground' && age <= 2 * 60_000 ? 'online' : 'away';
  }
  ep(me: string, friend: string): Endpoints {
    const self = this;
    let journeys = 0;
    return new Proxy({}, {
      get: (_t, k) => {
        if (k === 'then') return undefined;
        if (k === 'updatePresence') return async (u: PresenceUpdate) => {
          const prev = self.rows.get(me);
          const driving = u.appState === 'signed_out' ? false : u.driving ?? prev?.driving ?? false;
          self.rows.set(me, { appState: u.appState, driving, journeyId: driving ? u.journeyId ?? prev?.journeyId ?? null : null, lastSeen: self.clock.t });
          return {};
        };
        if (k === 'listFriends') return async () => [{
          id: friend, username: null, displayName: friend, avatarUrl: null, level: 1, since: '2026-10-01T00:00:00Z',
          presence: { status: self.status(friend), lastSeenAt: self.rows.has(friend) ? new Date(self.rows.get(friend)!.lastSeen).toISOString() : null },
        }];
        if (k === 'startJourney') return async (b: { clientRef: string }) => ({ id: `${me}-journey-${++journeys}`, status: 'active', ...b });
        if (k === 'addRoutePoints') return async () => ({ status: 'active' });
        if (k === 'getStats') return async () => ({ friends: 1, vehicles: 0, journeys: 0, totalDistanceKm: 0 });
        if (k === 'listFriendRequests') return async () => ({ incoming: [], outgoing: [] });
        return async () => [];
      },
    }) as Endpoints;
  }
}

/** A phone: CloudSync plus the presence reporter, wired as lib/presenceClient does. */
async function presencePhone(server: PresenceServer, me: string, friend: string) {
  const store = new MemoryStore();
  const ep = server.ep(me, friend);
  const cloud = new CloudSync({
    ep, store, userId: me, publishableKey: 'k', newId: () => `${me}-${Math.random()}`, timezone: () => 'UTC',
    now: () => server.clock.t, tracker: new BackgroundDriveRecorder({ store, updates: new FakeUpdates() }),
    prepareFile: async () => ({ body: new Uint8Array([1]), size: 1, mimeType: 'image/jpeg' }),
  });
  await cloud.start();
  const log: PresenceLogEntry[] = [];
  const reporter = new PresenceReporter({ send: (u) => ep.updatePresence(u), log: (e) => log.push(e), now: () => server.clock.t });
  cloud.onDriveChange((d) => reporter.setDrive(d));
  cloud.onDriveActivity(() => reporter.noteDriveActivity());
  reporter.start('foreground', cloud.driveState);
  await settle();
  return { cloud, reporter, log };
}

const friendShown = (phone: { cloud: CloudSync }) => phone.cloud.data.friends[0]?.status;

test('a friend sees Online, then Driving when the drive starts, then Online when it ends', async () => {
  const server = new PresenceServer();
  const driver = await presencePhone(server, 'A', 'B');
  const viewer = await presencePhone(server, 'B', 'A');
  // What the Community screen does on focus and on pull-to-refresh
  const refresh = () => viewer.cloud.refreshFriends();

  await refresh();
  assert.equal(friendShown(viewer), 'online');

  await driver.cloud.startDrive(null);
  await settle(); await settle();
  assert.equal(server.rows.get('A')?.driving, true, 'drive start reached the server');
  assert.ok(server.rows.get('A')?.journeyId, 'with its server journey');
  assert.ok(driver.log.some((e) => e.reason === 'drive-change' && e.update.driving === true && e.outcome === 'ok'));
  assert.equal(friendShown(viewer), 'online', 'without a refresh the friend still sees the old status');
  await refresh();
  assert.equal(friendShown(viewer), 'driving', 'a refresh shows Driving');

  // A minute later the routine heartbeat keeps it Driving
  server.clock.t += PRESENCE_HEARTBEAT_MS;
  driver.reporter['report']('heartbeat');
  await settle();
  await refresh();
  assert.equal(friendShown(viewer), 'driving');

  server.clock.t += 15_000;
  await driver.cloud.endDrive();
  await settle();
  await refresh();
  assert.equal(friendShown(viewer), 'online', 'Driving disappears when the drive ends');
  driver.reporter.stop(); viewer.reporter.stop();
});

test('a drive start during a heartbeat still reaches the server, and is logged as the reason', async () => {
  let release!: () => void;
  const sent: PresenceUpdate[] = [];
  const log: PresenceLogEntry[] = [];
  let hold = true;
  const reporter = new PresenceReporter({
    send: async (u) => { sent.push(u); if (hold) { hold = false; await new Promise<void>((r) => { release = r; }); } return {}; },
    log: (e) => log.push(e),
    setInterval: () => 1, clearInterval: () => {},
  });
  reporter.start('foreground', { driving: false, journeyId: null }); // startup request is held open
  reporter.setDrive({ driving: true, journeyId: null });             // drive starts meanwhile
  release();
  await settle(); await settle();
  assert.deepEqual(sent.at(-1), { appState: 'foreground', driving: true });
  assert.deepEqual(log.map((e) => `${e.reason}:${e.update.driving}:${e.outcome}`), ['startup:false:ok', 'drive-change:true:ok']);
  reporter.stop();
});

test('the Community screen reloads friends on focus and on pull-to-refresh', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(fileURLToPath(new URL('../app/(tabs)/community.tsx', import.meta.url)), 'utf8');
  assert.match(src, /useFocusEffect\(\s*useCallback\(\(\) => \{\s*void refreshProfileStats\(\);/, 'reloads on focus');
  assert.match(src, /<RefreshControl refreshing=\{pulling\} onRefresh=\{pullToRefresh\}/, 'pull-to-refresh');
  assert.equal((src.match(/refreshControl=\{friendsRefresh\}/g) ?? []).length, 2, 'on the overview and friends tabs');
});

// ─── Phase 3: live friend presence (Realtime inbox) ────────────────────────
import { decayPresence, parsePresenceEvent, type PresenceEvent } from '@/lib/backend/presence';
import { FEED_RETRY_MS, PresenceFeed, type InboxStatus } from '@/lib/backend/presenceFeed';

test('inbox payloads are validated; anything unexpected is ignored', () => {
  assert.deepEqual(parsePresenceEvent({ type: 'presence', userId: 'u', status: 'driving', lastSeenAt: '2026-10-07T10:00:00.000Z' }),
    { type: 'presence', userId: 'u', status: 'driving', lastSeenAt: '2026-10-07T10:00:00.000Z' });
  assert.deepEqual(parsePresenceEvent({ type: 'hidden', userId: 'u' }), { type: 'hidden', userId: 'u' });
  assert.deepEqual(parsePresenceEvent({ type: 'unfriended', userId: 'u' }), { type: 'unfriended', userId: 'u' });
  for (const bad of [null, 'x', {}, { type: 'presence', userId: 'u', status: 'flying' }, { type: 'presence', status: 'online' }, { type: 'probe', userId: 'u' }]) {
    assert.equal(parsePresenceEvent(bad), null);
  }
});

test('statuses age out on screen when a friend goes quiet (server rules, timed from receipt)', () => {
  const t = 1_000_000, m = 60_000;
  assert.equal(decayPresence('online', t, t + 119_000), 'online');
  assert.equal(decayPresence('online', t, t + 3 * m), 'away');
  assert.equal(decayPresence('driving', t, t + 170_000), 'driving');
  assert.equal(decayPresence('driving', t, t + 4 * m), 'away');
  assert.equal(decayPresence('away', t, t + 9 * m), 'away');
  assert.equal(decayPresence('driving', t, t + 11 * m), 'offline');
  assert.equal(decayPresence('offline', t, t), 'offline');
  assert.equal(decayPresence(null, t, t + 99 * m), null, 'hidden stays hidden');
});

/** A fake Supabase inbox channel: records joins, can push messages and statuses. */
function inboxRig(opts: { snapshot?: () => Promise<void>; openFails?: number } = {}) {
  const timers = new Map<number, { fn: () => void; ms: number; repeat: boolean }>();
  let id = 0;
  const channels: Array<{ token: string; open: boolean; push: (p: unknown) => void; status: (s: InboxStatus) => void }> = [];
  let token = 'token-1';
  let openFails = opts.openFails ?? 0;
  const applied: PresenceEvent[] = [];
  let snapshots = 0;
  let decays = 0;
  const feed = new PresenceFeed({
    open: async ({ onEvent, onStatus }) => {
      if (openFails > 0) { openFails--; throw new Error('network'); }
      const ch = { token, open: true, push: onEvent, status: onStatus };
      channels.push(ch);
      return { close: () => { ch.open = false; } };
    },
    snapshot: async () => { snapshots++; await opts.snapshot?.(); },
    apply: (e) => applied.push(e),
    decay: () => { decays++; },
    setTimeout: (fn, ms) => { timers.set(++id, { fn, ms, repeat: false }); return id; },
    clearTimeout: (h) => { timers.delete(h as number); },
    setInterval: (fn, ms) => { timers.set(++id, { fn, ms, repeat: true }); return id; },
    clearInterval: (h) => { timers.delete(h as number); },
  });
  const fireRetry = async () => {
    for (const [k, t] of [...timers]) if (!t.repeat) { timers.delete(k); t.fn(); }
    await settle();
  };
  return {
    feed, channels, applied, timers, fireRetry,
    openChannels: () => channels.filter((c) => c.open),
    current: () => channels.filter((c) => c.open).at(-1)!,
    refreshToken: (t: string) => { token = t; },
    get snapshots() { return snapshots; }, get decays() { return decays; },
  };
}

test('live presence: one inbox on screen, none in the background, never duplicated', async () => {
  const r = inboxRig();
  r.feed.setActive(true);
  r.feed.setActive(true); // repeated foreground events
  await settle();
  assert.equal(r.channels.length, 1, 'joined once');
  r.feed.setActive(false);
  assert.equal(r.openChannels().length, 0, 'left in the background');
  assert.equal([...r.timers.values()].filter((t) => t.repeat).length, 0, 'no timers in the background');
  for (let i = 0; i < 5; i++) { r.feed.setActive(true); r.feed.setActive(false); }
  r.feed.setActive(true);
  await settle();
  assert.equal(r.openChannels().length, 1, 'many foreground/background flips: still exactly one open');
  r.feed.stop();
  assert.equal(r.openChannels().length, 0);
  r.feed.setActive(true);
  await settle();
  assert.equal(r.openChannels().length, 0, 'never rejoins after stop (sign-out)');
});

test('live presence: a snapshot after joining, updates held until it lands, then applied live', async () => {
  let finish!: () => void;
  const r = inboxRig({ snapshot: () => new Promise<void>((res) => { finish = res; }) });
  r.feed.setActive(true);
  await settle();
  assert.equal(r.snapshots, 0, 'no snapshot before the join is confirmed');
  r.current().status('subscribed');
  assert.equal(r.snapshots, 1, 'snapshot right after joining (catches up on anything missed)');
  r.current().push({ type: 'presence', userId: 'a', status: 'driving', lastSeenAt: null });
  assert.equal(r.applied.length, 0, 'held while the snapshot loads');
  finish();
  await settle();
  assert.deepEqual(r.applied.map((e) => e.type === 'presence' && e.status), ['driving'], 'applied after it, so it is not overwritten');
  r.current().push({ type: 'presence', userId: 'a', status: 'online', lastSeenAt: null });
  r.current().push({ nonsense: true });
  assert.deepEqual(r.applied.map((e) => e.type === 'presence' && e.status), ['driving', 'online'], 'then applied as they arrive');
});

test('live presence: an expired token or dropped socket rejoins with a fresh token', async () => {
  const r = inboxRig();
  r.feed.setActive(true);
  await settle();
  r.current().status('subscribed');
  await settle();
  assert.equal(r.feed.isConnected, true);
  // The token expired while connected: Realtime drops the channel
  r.refreshToken('token-2');
  r.current().status('error');
  assert.equal(r.feed.isConnected, false);
  assert.equal(r.openChannels().length, 0, 'the broken channel is closed, not left hanging');
  assert.equal([...r.timers.values()].find((t) => !t.repeat)?.ms, FEED_RETRY_MS[0]);
  await r.fireRetry();
  assert.equal(r.current().token, 'token-2', 'rejoined with the refreshed token');
  r.current().status('subscribed');
  await settle();
  assert.equal(r.feed.isConnected, true);
  assert.equal(r.snapshots, 2, 'and caught up again');
  // Repeated failures back off; going to the background cancels the retry
  r.current().status('closed');
  await r.fireRetry();
  r.channels.at(-1)!.status('error');
  assert.equal([...r.timers.values()].find((t) => !t.repeat)?.ms, FEED_RETRY_MS[1]);
  r.feed.setActive(false);
  assert.equal([...r.timers.values()].length, 0, 'no retry or timers in the background');
});

test('live presence: a failed join retries; a join that finishes after leaving is closed', async () => {
  const r = inboxRig({ openFails: 2 });
  r.feed.setActive(true);
  await settle();
  assert.equal(r.channels.length, 0);
  await r.fireRetry(); // fails again
  await r.fireRetry();
  assert.equal(r.openChannels().length, 1, 'connected on the third try');
  // Slow join: background before it completes
  let release!: () => void;
  const late: { closed: boolean } = { closed: false };
  const slow = new PresenceFeed({
    open: () => new Promise((res) => { release = () => res({ close: () => { late.closed = true; } }); }),
    snapshot: async () => {}, apply: () => {}, decay: () => {},
    setInterval: () => 1, clearInterval: () => {}, setTimeout: () => 1, clearTimeout: () => {},
  });
  slow.setActive(true);
  slow.setActive(false);
  release();
  await settle();
  assert.equal(late.closed, true, 'not kept open after leaving');
});

test('live updates merge into the same friend list as the snapshot; they age out when quiet', async () => {
  const server = new PresenceServer();
  const viewer = await presencePhone(server, 'B', 'A');
  await viewer.cloud.refreshFriends();
  assert.equal(viewer.cloud.data.friends[0]!.status, 'offline', 'A has not opened the app yet');
  const ev = (e: PresenceEvent) => viewer.cloud.applyPresenceEvent(e);
  ev({ type: 'presence', userId: 'A', status: 'online', lastSeenAt: '2026-10-07T10:00:00.000Z' });
  assert.equal(viewer.cloud.data.friends[0]!.status, 'online');
  assert.equal(viewer.cloud.data.friends[0]!.lastSeenAt, '2026-10-07T10:00:00.000Z');
  ev({ type: 'presence', userId: 'A', status: 'driving', lastSeenAt: null });
  assert.equal(viewer.cloud.data.friends[0]!.status, 'driving');
  // A's phone dies mid-drive: no more messages
  server.clock.t += 4 * 60_000;
  viewer.cloud.decayFriendPresence();
  assert.equal(viewer.cloud.data.friends[0]!.presence, 'driving', 'last thing received');
  assert.equal(viewer.cloud.data.friends[0]!.status, 'offline', 'shown as no longer driving (Away shows as offline)');
  ev({ type: 'presence', userId: 'A', status: 'online', lastSeenAt: null });
  assert.equal(viewer.cloud.data.friends[0]!.status, 'online');
  ev({ type: 'hidden', userId: 'A' });
  assert.deepEqual(
    { status: viewer.cloud.data.friends[0]!.status, presence: viewer.cloud.data.friends[0]!.presence, lastSeenAt: viewer.cloud.data.friends[0]!.lastSeenAt },
    { status: 'offline', presence: null, lastSeenAt: null }, 'hidden: nothing about A remains');
  ev({ type: 'presence', userId: 'stranger', status: 'online', lastSeenAt: null });
  assert.equal(viewer.cloud.data.friends.length, 1, 'updates for someone not in the list are ignored');
  ev({ type: 'unfriended', userId: 'A' });
  assert.equal(viewer.cloud.data.friends.length, 0, 'an ex-friend leaves the list at once');
  viewer.reporter.stop();
});

test('two phones: B sees A go Online → Driving → Online → Away → hidden → back → signed out, with no refresh', async () => {
  // The fan-out the database does (0017), for these two friends: each of A's
  // presence writes reaches B's inbox while B's app is open.
  const server = new PresenceServer();
  const inboxB: Array<(p: unknown) => void> = [];
  let hidden = false;
  const publish = () => {
    const r = server.rows.get('A');
    if (!r) return;
    const payload = hidden ? { type: 'hidden', userId: 'A' } : { type: 'presence', userId: 'A', status: server.status('A'), lastSeenAt: new Date(r.lastSeen).toISOString() };
    for (const fn of inboxB) fn(payload);
  };
  const viewer = await presencePhone(server, 'B', 'A');
  const feed = new PresenceFeed({
    open: async ({ onEvent, onStatus }) => { inboxB.push(onEvent); queueMicrotask(() => onStatus('subscribed')); return { close: () => { inboxB.length = 0; } }; },
    snapshot: () => viewer.cloud.refreshFriends(),
    apply: (e) => viewer.cloud.applyPresenceEvent(e),
    decay: () => viewer.cloud.decayFriendPresence(),
    setInterval: () => 1, clearInterval: () => {},
  });
  feed.setActive(true);
  await settle(); await settle();
  const shown = () => viewer.cloud.data.friends[0]?.status;
  const driverEp = server.ep('A', 'B');
  const send = async (u: PresenceUpdate) => { await driverEp.updatePresence(u); publish(); await settle(); };

  await send({ appState: 'foreground', driving: false });
  assert.equal(shown(), 'online', '1. A opens Derwent → Online');
  await send({ appState: 'foreground', driving: true });
  assert.equal(shown(), 'driving', '2. A starts a drive → Driving');
  await send({ appState: 'foreground', driving: false });
  assert.equal(shown(), 'online', '3. A ends the drive → Online');
  await send({ appState: 'background', driving: false });
  assert.equal(shown(), 'offline', '4. A backgrounds → Away (shown as offline)');
  assert.equal(viewer.cloud.data.friends[0]!.presence, 'away');
  hidden = true; publish(); await settle();
  assert.equal(viewer.cloud.data.friends[0]!.presence, null, '5. A hides activity → removed');
  hidden = false;
  await send({ appState: 'foreground', driving: false });
  assert.equal(shown(), 'online', 'shown again once A turns it back on');
  await send({ appState: 'signed_out' });
  assert.equal(viewer.cloud.data.friends[0]!.presence, 'offline', 'A signs out → Offline');
  feed.stop();
  viewer.reporter.stop();
});

// ─── Private live location (Phase 4A) ───────────────────────────────────────
import {
  DRIVE_MIN_INTERVAL_MS, FAILURE_BACKOFF_MS, LiveLocationPublisher, LiveLocationStore, REFUSED_BACKOFF_MS,
  USING_INTERVAL_MS, USING_MIN_INTERVAL_MS, parseLiveLocationEvent, toUpdate, type LiveLocationUpdate,
} from '@/lib/backend/liveLocation';

const LIVE = {
  type: 'live_location', userId: 'A', latitude: 54.5, longitude: -2.9, headingDeg: 90, speedKmh: 48, accuracyM: 5,
  driving: true, recordedAt: '2026-10-07T10:00:00.000Z', expiresAt: '2026-10-07T10:03:00.000Z',
};

test('live location: inbox payloads are validated; anything malformed is ignored', () => {
  assert.deepEqual(parseLiveLocationEvent(LIVE), LIVE);
  assert.deepEqual(parseLiveLocationEvent({ type: 'live_location_hidden', userId: 'A' }), { type: 'live_location_hidden', userId: 'A' });
  assert.deepEqual(parseLiveLocationEvent({ ...LIVE, headingDeg: null, speedKmh: null, accuracyM: null }),
    { ...LIVE, headingDeg: null, speedKmh: null, accuracyM: null }, 'unknown speed and heading are fine');
  for (const bad of [null, 'x', {}, { type: 'live_location' }, { ...LIVE, userId: '' }, { ...LIVE, latitude: 91 },
    { ...LIVE, longitude: '1' }, { ...LIVE, latitude: Number.NaN }, { ...LIVE, speedKmh: -3 }, { ...LIVE, headingDeg: 400 },
    { ...LIVE, expiresAt: LIVE.recordedAt }, { ...LIVE, recordedAt: 'yesterday' }, { type: 'live_location_hidden' },
    { type: 'presence', userId: 'A', status: 'online' }]) {
    assert.equal(parseLiveLocationEvent(bad), null, JSON.stringify(bad));
  }
  // A presence payload is not mistaken for a live one, nor the other way round.
  assert.equal(parsePresenceEvent(LIVE), null);
});

/** A store on a fake clock with fake timers. */
function liveStoreRig() {
  const clock = { t: 1_000_000 };
  const timers = new Map<number, { fn: () => void; at: number }>();
  let id = 0;
  const store = new LiveLocationStore({
    now: () => clock.t,
    setTimeout: (fn, ms) => { timers.set(++id, { fn, at: clock.t + ms }); return id; },
    clearTimeout: (h) => { timers.delete(h as number); },
  });
  const advance = (ms: number) => {
    clock.t += ms;
    for (const [k, tm] of [...timers]) if (tm.at <= clock.t) { timers.delete(k); tm.fn(); }
  };
  return { store, clock, advance, timers };
}

test('live location: shared positions come from the snapshot and the inbox, and go when revoked or expired', () => {
  const { store, advance, timers } = liveStoreRig();
  let changes = 0;
  store.subscribe(() => { changes++; });
  store.replaceAll([LIVE, { ...LIVE, userId: 'C' }, { bogus: true }]);
  assert.deepEqual(store.list.map((l) => l.userId).sort(), ['A', 'C'], 'snapshot, malformed entries dropped');
  assert.equal(store.list, store.list, 'a stable array between changes');
  store.replaceAll([LIVE]);
  assert.deepEqual(store.list.map((l) => l.userId), ['A'], 'anyone missing from a new snapshot is dropped');

  const newer = { ...LIVE, latitude: 54.6, recordedAt: '2026-10-07T10:00:10.000Z', expiresAt: '2026-10-07T10:03:10.000Z' };
  store.apply(parseLiveLocationEvent(newer)!);
  assert.equal(store.get('A')!.latitude, 54.6);
  store.apply(parseLiveLocationEvent(LIVE)!);
  assert.equal(store.get('A')!.latitude, 54.6, 'an older update arriving late does not replace a newer one');

  store.apply({ type: 'live_location_hidden', userId: 'A' });
  assert.equal(store.get('A'), null, 'revoked: gone at once');
  assert.equal(store.list.length, 0);
  assert.equal(timers.size, 0, 'no timer left with nothing to expire');

  // Expiry is timed from receipt (3 minutes here), whatever the phone clocks say
  store.apply(parseLiveLocationEvent(LIVE)!);
  advance(179_000);
  assert.equal(store.list.length, 1);
  advance(2_000);
  assert.equal(store.list.length, 0, 'dropped as it expires, without waiting for a server message');
  // A position claiming a very long life is held 10 minutes at most
  store.apply(parseLiveLocationEvent({ ...LIVE, expiresAt: '2026-10-08T10:00:00.000Z' })!);
  advance(10 * 60_000 + 100);
  assert.equal(store.get('A'), null);
  store.apply(parseLiveLocationEvent(LIVE)!);
  store.clear();
  assert.equal(store.list.length, 0, 'clear drops everything (background, sign-out)');
  assert.ok(changes > 5);
});

test('live location: the inbox feed routes live updates, holds them during the snapshot, and drops them in the background', async () => {
  const store = new LiveLocationStore({ setTimeout: () => 0, clearTimeout: () => {} });
  const channels: Array<{ push: (p: unknown) => void; status: (s: InboxStatus) => void }> = [];
  let finish!: () => void;
  let snapshotResult: unknown[] = [];
  let lastIsCurrent: (() => boolean) | null = null;
  const presence: PresenceEvent[] = [];
  const feed = new PresenceFeed({
    open: async ({ onEvent, onStatus }) => { channels.push({ push: onEvent, status: onStatus }); return { close: () => {} }; },
    snapshot: async (isCurrent) => {
      lastIsCurrent = isCurrent;
      await new Promise<void>((res) => { finish = res; });
      if (isCurrent()) store.replaceAll(snapshotResult);
    },
    apply: (e) => {
      if (e.type === 'live_location' || e.type === 'live_location_hidden') store.apply(e);
      else presence.push(e);
    },
    decay: () => store.prune(),
    onLeave: () => store.clear(),
    setInterval: () => 1, clearInterval: () => {}, setTimeout: () => 1, clearTimeout: () => {},
  });
  feed.setActive(true);
  await settle();
  channels.at(-1)!.status('subscribed');
  const later = { ...LIVE, recordedAt: '2026-10-07T10:00:20.000Z', expiresAt: '2026-10-07T10:03:20.000Z', latitude: 54.7 };
  channels.at(-1)!.push(later);
  assert.equal(store.list.length, 0, 'held while the snapshot loads');
  snapshotResult = [LIVE];
  finish();
  await settle();
  assert.equal(store.get('A')!.latitude, 54.7, 'the live update wins over the older snapshot');
  channels.at(-1)!.push({ type: 'presence', userId: 'A', status: 'driving', lastSeenAt: null });
  assert.equal(presence.length, 1, 'presence still reaches the friend list');

  // A removes B: B's cached position disappears at once
  channels.at(-1)!.push({ type: 'live_location_hidden', userId: 'A' });
  assert.equal(store.get('A'), null);

  // Back in the background: everything shared is dropped (nothing can revoke it there)
  channels.at(-1)!.push(LIVE);
  assert.equal(store.list.length, 1);
  feed.setActive(false);
  assert.equal(store.list.length, 0, 'dropped on leaving the screen');

  // A snapshot that finishes after the app left must not bring positions back
  feed.setActive(true);
  await settle();
  channels.at(-1)!.status('subscribed');
  snapshotResult = [LIVE];
  feed.setActive(false);
  assert.equal(lastIsCurrent!(), false);
  finish();
  await settle();
  assert.equal(store.list.length, 0, 'a late snapshot is not applied in the background');
  feed.stop();
});

/** A publisher on a fake clock with a scripted server. */
function publisherRig(mode: 'off' | 'while_driving' | 'while_using', opts: { onScreen?: boolean; driving?: boolean } = {}) {
  const clock = { t: 5_000_000 };
  const sent: LiveLocationUpdate[] = [];
  let removed = 0;
  let sharingOff = 0;
  let respond: (u: LiveLocationUpdate) => Promise<unknown> = async () => ({});
  const publisher = new LiveLocationPublisher({
    now: () => clock.t,
    send: (u) => { sent.push(u); return respond(u); },
    remove: async () => { removed++; },
    onSharingOff: () => { sharingOff++; },
  });
  publisher.start({ mode, onScreen: opts.onScreen ?? true, driving: opts.driving ?? false });
  // A fix moving north by `metres` from the last one, taken now
  let lat = 54.5;
  const fix = (metres = 0, extra: Partial<GpsFix> = {}): GpsFix => {
    lat += metres / 111_195;
    return { latitude: lat, longitude: -2.9, speedMs: 13, headingDeg: 10, accuracyM: 5, timestamp: clock.t, ...extra };
  };
  return {
    publisher, clock, sent, fix,
    get removed() { return removed; }, get sharingOff() { return sharingOff; },
    respondWith: (fn: (u: LiveLocationUpdate) => Promise<unknown>) => { respond = fn; },
  };
}

test('live location publishing: nothing while sharing is off; no position outside a drive when sharing while driving', async () => {
  const off = publisherRig('off', { driving: true });
  off.publisher.noteDriveFix(off.fix());
  off.publisher.noteForegroundFix(off.fix());
  assert.equal(off.sent.length, 0, 'off: nothing is sent, ever');

  const r = publisherRig('while_driving');
  r.publisher.noteForegroundFix(r.fix());
  r.publisher.noteDriveFix(r.fix());
  assert.equal(r.sent.length, 0, 'not driving: nothing');
  r.publisher.setDriving(true);
  r.publisher.noteForegroundFix(r.fix());
  assert.equal(r.sent.length, 0, 'the foreground stream is never used during a drive (the drive pipeline is)');
  r.publisher.noteDriveFix(r.fix());
  await settle();
  assert.equal(r.sent.length, 1, 'the first drive fix is sent');
});

test('live location publishing: during a drive about every 10 s, sooner after 50 m, never more than every 5 s', async () => {
  const r = publisherRig('while_driving', { driving: true });
  r.publisher.noteDriveFix(r.fix());
  await settle();
  r.clock.t += 3_000;
  r.publisher.noteDriveFix(r.fix(80));
  await settle();
  assert.equal(r.sent.length, 1, 'under 5 s: not even after 80 m');
  r.clock.t += DRIVE_MIN_INTERVAL_MS - 3_000;
  r.publisher.noteDriveFix(r.fix(10));
  await settle();
  assert.equal(r.sent.length, 2, '5 s and 90 m from the last sent: sent');
  r.clock.t += 6_000;
  r.publisher.noteDriveFix(r.fix(5));
  await settle();
  assert.equal(r.sent.length, 2, '6 s and 5 m: not yet');
  r.clock.t += 4_000;
  r.publisher.noteDriveFix(r.fix(5));
  await settle();
  assert.equal(r.sent.length, 3, '10 s: sent even when barely moving');
  // Drive fixes in the background (phone locked) still publish
  r.publisher.setOnScreen(false);
  r.clock.t += 10_000;
  r.publisher.noteDriveFix(r.fix(5));
  await settle();
  assert.equal(r.sent.length, 4, 'locked phone during a drive: still shared');
  assert.equal(r.removed, 0);
  // The drive ends: the position is withdrawn at once
  r.publisher.setDriving(false);
  assert.equal(r.removed, 1, 'drive ended: removed');
  r.clock.t += 60_000;
  r.publisher.noteDriveFix(r.fix(500));
  await settle();
  assert.equal(r.sent.length, 4);
});

test('live location publishing: while using, on screen only, about once a minute', async () => {
  const r = publisherRig('while_using');
  r.publisher.noteForegroundFix(r.fix());
  await settle();
  assert.equal(r.sent.length, 1);
  r.clock.t += USING_MIN_INTERVAL_MS - 1_000;
  r.publisher.noteForegroundFix(r.fix(500));
  await settle();
  assert.equal(r.sent.length, 1, 'never within 30 s');
  r.clock.t += 2_000;
  r.publisher.noteForegroundFix(r.fix(10));
  await settle();
  assert.equal(r.sent.length, 2, 'after 30 s, having moved over 100 m: sent');
  r.clock.t += 40_000;
  r.publisher.noteForegroundFix(r.fix(10));
  await settle();
  assert.equal(r.sent.length, 2, 'standing nearly still: waits for the minute');
  r.clock.t += USING_INTERVAL_MS - 40_000;
  r.publisher.noteForegroundFix(r.fix(0));
  await settle();
  assert.equal(r.sent.length, 3, 'a minute: refreshed so it does not expire');

  // Leaving the screen (not driving) withdraws it and stops sharing
  r.publisher.setOnScreen(false);
  assert.equal(r.removed, 1, 'removed on leaving the app');
  r.clock.t += 120_000;
  r.publisher.noteForegroundFix(r.fix(500));
  await settle();
  assert.equal(r.sent.length, 3, 'nothing from the background outside a drive');
  // While using means on screen: a drive in the background shares nothing
  r.publisher.setDriving(true);
  r.publisher.noteDriveFix(r.fix(10));
  await settle();
  assert.equal(r.sent.length, 3, 'a background drive is not "using"');
});

test('live location publishing: bad, stale or invalid fixes are not shared; unknown values are dropped', async () => {
  const now = 5_000_000;
  assert.equal(toUpdate({ latitude: 54, longitude: -2, speedMs: 10, accuracyM: 500, timestamp: now }, now), null, 'poor accuracy');
  assert.equal(toUpdate({ latitude: 54, longitude: -2, speedMs: 10, accuracyM: 5, timestamp: now - 120_000 }, now), null, 'stale');
  assert.equal(toUpdate({ latitude: Number.NaN, longitude: -2, speedMs: 10, timestamp: now }, now), null, 'not a number');
  assert.equal(toUpdate({ latitude: 95, longitude: -2, speedMs: 10, timestamp: now }, now), null, 'out of range');
  const u = toUpdate({ latitude: 54, longitude: -2, speedMs: -1, headingDeg: -1, accuracyM: 5, timestamp: now + 5_000 }, now)!;
  assert.equal(u.speedMps, null, 'iOS reports -1 for unknown speed');
  assert.equal(u.headingDeg, null, 'and for unknown heading');
  assert.equal(u.capturedAt, new Date(now).toISOString(), 'never claims a fix from the future');
  assert.equal(toUpdate({ latitude: 54, longitude: -2, speedMs: 0, headingDeg: 370, timestamp: now }, now)!.headingDeg, 10);
  assert.deepEqual(Object.keys(u).sort(), ['accuracyM', 'capturedAt', 'headingDeg', 'latitude', 'longitude', 'speedMps'],
    'only the position and its quality; the server decides who sees it, when, and whether driving');

  const r = publisherRig('while_driving', { driving: true });
  r.publisher.noteDriveFix(r.fix(0, { accuracyM: 300 }));
  r.publisher.noteDriveFix(r.fix(0, { timestamp: r.clock.t - 90_000 }));
  await settle();
  assert.equal(r.sent.length, 0);
});

test('live location publishing: the server has the last word; failures never escape', async () => {
  // Turned off elsewhere: stop at once
  const off = publisherRig('while_using');
  off.respondWith(async () => { throw new ApiError(409, 'sharing_off', 'off'); });
  off.publisher.noteForegroundFix(off.fix());
  await settle();
  assert.equal(off.sharingOff, 1, 'told the app');
  assert.equal(off.publisher.sharingMode, 'off');
  off.clock.t += 120_000;
  off.publisher.noteForegroundFix(off.fix(200));
  await settle();
  assert.equal(off.sent.length, 1, 'nothing more is sent');

  // Presence hasn't caught up with the drive yet: wait, then try again
  const early = publisherRig('while_driving', { driving: true });
  early.respondWith(async () => { throw new ApiError(409, 'not_driving', 'not yet'); });
  early.publisher.noteDriveFix(early.fix());
  await settle();
  early.respondWith(async () => ({}));
  early.clock.t += REFUSED_BACKOFF_MS - 1_000;
  early.publisher.noteDriveFix(early.fix(100));
  await settle();
  assert.equal(early.sent.length, 1, 'backs off after a refusal');
  early.clock.t += 2_000;
  early.publisher.noteDriveFix(early.fix(100));
  await settle();
  assert.equal(early.sent.length, 2, 'then tries again');

  // Network or server failures are swallowed, with a back-off
  const flaky = publisherRig('while_driving', { driving: true });
  flaky.respondWith(async () => { throw new NetworkError(); });
  flaky.publisher.noteDriveFix(flaky.fix());
  await settle();
  flaky.clock.t += FAILURE_BACKOFF_MS - 1_000;
  flaky.publisher.noteDriveFix(flaky.fix(100));
  await settle();
  assert.equal(flaky.sent.length, 1, 'no hammering while the server is unreachable');
  flaky.clock.t += 2_000;
  flaky.respondWith(async () => ({}));
  flaky.publisher.noteDriveFix(flaky.fix(100));
  await settle();
  assert.equal(flaky.sent.length, 2);
});

test('live location publishing: one request at a time, the newest fix next; stopping removes the position', async () => {
  const r = publisherRig('while_driving', { driving: true });
  let release!: () => void;
  r.respondWith(() => new Promise((res) => { release = () => res({}); }));
  r.publisher.noteDriveFix(r.fix());
  r.clock.t += 6_000;
  r.publisher.noteDriveFix(r.fix(60));
  r.clock.t += 6_000;
  const newest = r.fix(60);
  r.publisher.noteDriveFix(newest);
  assert.equal(r.sent.length, 1, 'one in flight');
  r.respondWith(async () => ({}));
  release();
  await settle();
  assert.equal(r.sent.length, 2, 'then the newest waiting fix');
  assert.equal(r.sent[1]!.latitude, newest.latitude);
  await r.publisher.stop();
  assert.equal(r.removed, 1, 'sign-out removes the position');
  r.publisher.noteDriveFix(r.fix(500));
  await settle();
  assert.equal(r.sent.length, 2, 'and nothing is sent after stopping');
  const never = publisherRig('while_driving');
  await never.publisher.stop();
  assert.equal(never.removed, 0, 'nothing to remove if nothing was shared');
});

test('live location: a snapshot position is kept only for what is left of its life; a late update after a removal is ignored', () => {
  const { store, advance } = liveStoreRig();
  // Recorded almost 3 minutes ago: 10 s left by the server's clock
  store.replaceAll([{ ...LIVE, expiresInMs: 10_000 }]);
  advance(9_000);
  assert.equal(store.list.length, 1);
  advance(2_000);
  assert.equal(store.list.length, 0, 'dropped when the server says it expires, not 3 minutes after loading');

  // Removed at 10:00:05; an update sent at 10:00:04 arrives afterwards
  store.apply(parseLiveLocationEvent({ ...LIVE, sentAt: '2026-10-07T10:00:01.000000Z' })!);
  store.apply(parseLiveLocationEvent({ type: 'live_location_hidden', userId: 'A', sentAt: '2026-10-07T10:00:05.000000Z' })!);
  store.apply(parseLiveLocationEvent({ ...LIVE, sentAt: '2026-10-07T10:00:04.000000Z' })!);
  assert.equal(store.get('A'), null, 'not shown again by an update that was overtaken');
  store.apply(parseLiveLocationEvent({ ...LIVE, sentAt: '2026-10-07T10:01:00.000000Z' })!);
  assert.ok(store.get('A'), 'a later share (granted again) is shown');
});

test('live location: a dropped inbox connection drops shared positions until the next snapshot', async () => {
  const store = new LiveLocationStore({ setTimeout: () => 0, clearTimeout: () => {} });
  const channels: Array<{ push: (p: unknown) => void; status: (s: InboxStatus) => void }> = [];
  const feed = new PresenceFeed({
    open: async ({ onEvent, onStatus }) => { channels.push({ push: onEvent, status: onStatus }); return { close: () => {} }; },
    snapshot: async () => {},
    apply: (e) => { if (e.type === 'live_location' || e.type === 'live_location_hidden') store.apply(e); },
    decay: () => {},
    onLeave: () => store.clear(),
    setInterval: () => 1, clearInterval: () => {}, setTimeout: () => 1, clearTimeout: () => {},
  });
  feed.setActive(true);
  await settle();
  channels.at(-1)!.status('subscribed');
  await settle();
  channels.at(-1)!.push(LIVE);
  assert.equal(store.list.length, 1);
  channels.at(-1)!.status('error');
  assert.equal(store.list.length, 0, 'a removal could be missed while disconnected: nothing kept');
  feed.stop();
});

// Strict WHEN semantics: While Using = foreground only; While Driving = the drive.
test('live location modes: While Using shares only on screen, even mid-drive; recording is untouched', async () => {
  const r = publisherRig('while_using');
  // 1. While Using + foreground → shared
  r.publisher.noteForegroundFix(r.fix());
  await settle();
  assert.equal(r.sent.length, 1, '1. foreground: shared');
  // 2. While Using + foreground drive → shared (from the drive's fixes)
  r.publisher.setDriving(true);
  r.clock.t += 10_000;
  r.publisher.noteDriveFix(r.fix(60));
  await settle();
  assert.equal(r.sent.length, 2, '2. foreground drive: shared');
  // 3. Background during that drive → withdrawn at once, nothing more sent
  r.publisher.setOnScreen(false);
  assert.equal(r.removed, 1, '3. backgrounded mid-drive: removed immediately');
  for (let i = 0; i < 5; i++) {
    r.clock.t += 10_000;
    r.publisher.noteDriveFix(r.fix(100));
  }
  await settle();
  assert.equal(r.sent.length, 2, '3. and nothing is published while in the background');
  // 5. Back on screen: sharing resumes with the next fix
  r.publisher.setOnScreen(true);
  r.clock.t += 1_000;
  r.publisher.noteDriveFix(r.fix(10));
  await settle();
  assert.equal(r.sent.length, 3, '5. foreground again: resumes with the next fix');
});

test('live location modes: While Driving shares through the drive, screen or not, and stops when it ends', async () => {
  const r = publisherRig('while_driving');
  r.publisher.noteForegroundFix(r.fix());
  await settle();
  assert.equal(r.sent.length, 0, 'no drive: nothing');
  // 6. While Driving + foreground drive → shared
  r.publisher.setDriving(true);
  r.publisher.noteDriveFix(r.fix());
  await settle();
  assert.equal(r.sent.length, 1, '6. foreground drive: shared');
  // 7. Background / locked → still shared, nothing removed
  r.publisher.setOnScreen(false);
  assert.equal(r.removed, 0, '7. backgrounded: not removed');
  r.clock.t += 10_000;
  r.publisher.noteDriveFix(r.fix(60));
  await settle();
  assert.equal(r.sent.length, 2, '7. locked phone: still published');
  // 8. Drive ends → removed
  r.publisher.setDriving(false);
  assert.equal(r.removed, 1, '8. drive ended: removed');
});

test('live location modes: drive recording is the same whatever the sharing mode or screen state', async () => {
  // 4. The recorder keeps every fix; sharing only listens to it.
  const recordWith = async (mode: 'off' | 'while_using' | 'while_driving') => {
    const clock = { t: Date.now() };
    const cloud = makeSync(new FakeServer(), new MemoryStore(), clock);
    await cloud.start();
    const sent: LiveLocationUpdate[] = [];
    const publisher = new LiveLocationPublisher({ send: async (u) => { sent.push(u); }, remove: async () => {}, now: () => clock.t });
    publisher.start({ mode, onScreen: true, driving: false });
    cloud.onDriveChange((d) => publisher.setDriving(d.driving));
    cloud.onDriveFix((f) => publisher.noteDriveFix(f));
    await cloud.startDrive(null);
    publisher.setOnScreen(false); // phone locked mid-drive
    const t0 = clock.t;
    let kept = 0;
    for (let i = 0; i < 60; i++) {
      clock.t = t0 + i * 1000;
      if (cloud.addFix({ latitude: 54.5 + i * 0.0003, longitude: -2.9, speedMs: 13, headingDeg: 0, accuracyM: 5, timestamp: clock.t })) kept++;
    }
    await settle();
    const points = cloud.activeRecord?.points.length ?? 0;
    cloud.dispose();
    return { kept, points, shared: sent.length };
  };
  const off = await recordWith('off');
  const using = await recordWith('while_using');
  const driving = await recordWith('while_driving');
  assert.ok(off.points > 0, 'the drive records');
  assert.deepEqual([using.kept, using.points], [off.kept, off.points], '4. While Using in the background: recording unchanged');
  assert.deepEqual([driving.kept, driving.points], [off.kept, off.points], 'While Driving: recording unchanged');
  assert.equal(using.shared, 0, 'While Using in the background shares nothing');
  assert.ok(driving.shared > 0, 'While Driving shares from the same fixes');
});

// ─── Speed units ─────────────────────────────────────────────────────────────
//
// GPS reports m/s.  The app turns that into km/h once, as each fix arrives
// (msToKmh), and keeps km/h everywhere after: the live drive, recorded
// points, saved journeys and the server.  Only the screen shows mph, through
// convertSpeed / speedUnit / formatSpeed in lib/units.

import {
  KMH_PER_MS, KM_PER_MILE, MPH_REGIONS, convertSpeed, formatSpeed, kmhToMph, localeRegion,
  msToKmh, msToMph, resolveUnitSystem, speedUnit,
} from '@/lib/units';
import { toPoint } from '@/lib/backend/journeyRecorder';
import { existsSync } from 'node:fs';

const near = (actual: number, expected: number, within: number, what: string) =>
  assert.ok(Math.abs(actual - expected) <= within, `${what}: ${actual} is not ≈ ${expected}`);

test('GPS speeds (m/s) convert to the right mph and km/h', () => {
  assert.equal(KMH_PER_MS, 3.6);
  assert.equal(KM_PER_MILE, 1.609344);
  assert.equal(msToMph(0), 0);
  assert.equal(msToKmh(0), 0);
  near(msToMph(10), 22.37, 0.005, '10 m/s in mph');
  near(msToMph(30), 67.11, 0.005, '30 m/s in mph');
  near(msToMph(49.17), 110, 0.05, '49.17 m/s in mph');
  near(msToKmh(49.17), 177, 0.05, '49.17 m/s in km/h');
  near(kmhToMph(100), 62.14, 0.005, '100 km/h in mph');
  near(kmhToMph(177.0), 110, 0.05, '177 km/h in mph');
  // No speed, or iOS's -1 for "invalid", is standing still, never negative
  assert.equal(msToKmh(null), 0);
  assert.equal(msToKmh(undefined), 0);
  assert.equal(msToKmh(-1), 0);
  assert.equal(msToMph(-1), 0);
});

test('110 mph shows as 110 mph (or 177 km/h), never as ~177 mph', () => {
  const kmh = msToKmh(49.17); // the GPS reading at 110 mph
  assert.equal(formatSpeed(kmh, 'imperial'), '110 mph');
  assert.equal(formatSpeed(kmh, 'metric'), '177 km/h');
  assert.equal(Math.round(convertSpeed(kmh, 'imperial')), 110);
  assert.equal(Math.round(convertSpeed(kmh, 'metric')), 177);
  // The number and its label come from the same unit system
  for (const system of ['imperial', 'metric'] as const) {
    const [value, label] = formatSpeed(kmh, system).split(' ');
    assert.equal(label, speedUnit(system));
    assert.equal(Number(value), Math.round(convertSpeed(kmh, system)));
  }
  assert.equal(speedUnit('imperial'), 'mph');
  assert.equal(speedUnit('metric'), 'km/h');
  // The ~1.609× mistake (km/h shown as mph, or m/s converted twice) can't happen
  assert.notEqual(formatSpeed(kmh, 'imperial'), '177 mph');
  assert.ok(!/^17\d mph$/.test(formatSpeed(kmh, 'imperial')));
});

test('live speed and saved drive stats convert a fix the same way', () => {
  const fix: GpsFix = { latitude: 51.5, longitude: -0.12, speedMs: 49.17, headingDeg: 90, accuracyM: 5, altitudeM: 20, timestamp: Date.parse('2026-10-01T10:00:00Z') };
  // Live: the Drive screen's speedometer and top speed
  const live = appendLiveFix(newLiveDrive(fix.timestamp), fix);
  // Saved: the recorded point uploaded to the server, and the drive's top speed
  const rec = newJourneyRecord({ clientRef: 'speed-units', startedAt: new Date(fix.timestamp), timezone: 'Europe/London', vehicleId: null, vehicleSnapshot: null });
  assert.ok(recordFix(rec, fix));
  near(live.currentSpeed, 177, 0.05, 'live speed (km/h)');
  assert.equal(live.topSpeed, live.currentSpeed);
  assert.equal(rec.points[0]!.speedKmh, live.currentSpeed);
  assert.equal(rec.topSpeedKmh, live.topSpeed);
  assert.equal(toPoint(fix).speedKmh, live.currentSpeed);
  // ...and both show the same thing
  assert.equal(formatSpeed(live.topSpeed, 'imperial'), '110 mph');
  assert.equal(formatSpeed(rec.topSpeedKmh, 'imperial'), '110 mph');
  assert.equal(formatSpeed(liveDriveFromRecord(rec).topSpeed, 'imperial'), '110 mph');
  // An invalid reading (-1) is 0 in both, not -3.6
  const stopped = { ...fix, speedMs: -1, timestamp: fix.timestamp + 1000 };
  assert.equal(appendLiveFix(live, stopped).currentSpeed, 0);
  assert.equal(toPoint(stopped).speedKmh, 0);
});

test('"Automatic" units follow the phone region: mph in the UK and US, km/h elsewhere', () => {
  for (const region of ['GB', 'US', 'IM', 'JE', 'GG', 'PR', 'gb', 'us']) {
    assert.equal(resolveUnitSystem('auto', region), 'imperial', region);
  }
  for (const region of ['FR', 'DE', 'IE', 'CA', 'AU', 'NZ', 'IN', 'ES']) {
    assert.equal(resolveUnitSystem('auto', region), 'metric', region);
  }
  assert.ok(MPH_REGIONS.has('GB') && MPH_REGIONS.has('US') && !MPH_REGIONS.has('IE'));
  // A choice in Settings always wins over the region
  assert.equal(resolveUnitSystem('metric', 'GB'), 'metric');
  assert.equal(resolveUnitSystem('imperial', 'FR'), 'imperial');
  // Without a region, the locale tag's region is used (any separator, with
  // or without a script, ignoring extensions)
  assert.equal(localeRegion('en-GB'), 'GB');
  assert.equal(localeRegion('en_GB'), 'GB');
  assert.equal(localeRegion('en-US'), 'US');
  assert.equal(localeRegion('en_US@rg=gbzzzz'), 'US');
  assert.equal(localeRegion('zh-Hans-CN'), 'CN');
  assert.equal(localeRegion('en-US-u-ca-gregory'), 'US');
  assert.equal(localeRegion('en'), null);
  assert.equal(localeRegion('es-419'), null);
  assert.equal(localeRegion(''), null);
});

test('speeds change unit in one place, and the app passes the phone region to "Automatic"', () => {
  const sources = (dir: string): string[] =>
    readdirSync(join(MOBILE, dir), { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? sources(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : []);
  const files = ['app', 'components', 'context', 'lib', 'hooks'].filter((d) => existsSync(join(MOBILE, d))).flatMap(sources);
  assert.ok(files.length > 50);
  for (const file of files) {
    if (file === join('lib', 'units.ts')) continue;
    const code = readFileSync(join(MOBILE, file), 'utf8').replace(/\/\/.*$/gm, '');
    assert.ok(!/\b3\.6\b|0\.62137|1\.6093|2\.2369|1609\.3/.test(code), `${file} converts a speed or distance itself`);
  }
  // The speedometer's number and its label use the same unit system
  const overlay = readFileSync(join(MOBILE, 'components/ActiveDriveOverlay.tsx'), 'utf8');
  assert.ok(/const displaySpd = convertSpeed\(Math\.max\(0, speedKmh\), resolvedUnitSystem\);\s*const unit = speedUnit\(resolvedUnitSystem\);/.test(overlay));
  assert.ok(/<Text style=\{styles\.speedoValue\}>\{Math\.round\(displaySpd\)\}<\/Text>\s*<Text style=\{styles\.speedoUnit\}>\{unit\}<\/Text>/.test(overlay));
  assert.ok(!/function convertSpeed/.test(overlay), 'the overlay has its own speed conversion');
  const ctx = readFileSync(join(MOBILE, 'context/AppContext.tsx'), 'utf8');
  assert.ok(/const deviceRegion = useLocales\(\)\[0\]\?\.regionCode \?\? null;/.test(ctx));
  assert.ok(/resolvedUnitSystem: resolveUnitSystem\(data\.unitSystem, deviceRegion\)/.test(ctx));
  // The server keeps km/h: it stores the app's speedKmh as is, top speed is its highest
  const server = readFileSync(join(MOBILE, '../api-server/src/routes/journeys.ts'), 'utf8');
  assert.ok(/speed_kmh: Math\.min\(p\.num\("speedKmh"/.test(server));
  assert.ok(/if \(p\.speed_kmh > topSpeedKmh\) topSpeedKmh = p\.speed_kmh;/.test(server));
});

// ─── Crash recovery: a drive is never lost ───────────────────────────────────
//
// A drive lives on the device as "active" while recorded and moves to
// "pending" when finished, until the server has it.  These tests kill the app
// at every step of that move, make storage fail the ways a phone's can, and
// leave journeys behind on the server, and check the drive always survives.

import { DiagnosticsJournal, JOURNAL_KEY, fatalErrorRecord } from '@/lib/backend/journal';
import { dedupeDrives, lastActivityMs, newJourneyRecord as newRecord, type JourneyRecord } from '@/lib/backend/journeyRecorder';
import { ORPHAN_IDLE_MS, ORPHAN_CHECK_EVERY_MS } from '@/lib/backend/cloudSync';
import { HELD_FIXES_MAX } from '@/lib/backend/driveTracking';

const ACTIVE_KEY = userKey('u1', 'journey/active');
const PENDING_KEY = userKey('u1', 'journey/pending');

/** Storage that fails the ways a phone's can: reads or writes of chosen keys, or every write once the app is "killed". */
class FlakyStore extends MemoryStore {
  failReads: string[] = [];
  failWrites: string[] = [];
  /** Writes allowed before the app is killed; every later write fails. */
  writesLeft = Infinity;
  failedWrites = 0;
  async getItem(key: string) {
    if (this.failReads.some((k) => key.endsWith(k))) throw new Error(`read failed: ${key}`);
    return super.getItem(key);
  }
  async setItem(key: string, value: string) { this.write(key); return super.setItem(key, value); }
  async removeItem(key: string) { this.write(key); return super.removeItem(key); }
  private write(key: string) {
    if (this.failWrites.some((k) => key.endsWith(k))) { this.failedWrites++; throw new Error(`write failed: ${key}`); }
    if (this.writesLeft <= 0) { this.failedWrites++; throw new Error('the app was killed'); }
    this.writesLeft--;
  }
}

function recoveryApp(store: MemoryStore, clock: { t: number }, updates = new FakeUpdates(), server = new FakeServer(),
  journal = new DiagnosticsJournal({ store: new MemoryStore(), now: () => clock.t })) {
  const tracker = new BackgroundDriveRecorder({ store, updates, now: () => clock.t, journal });
  let n = 0;
  const app = new CloudSync({
    ep: server.ep(), store, userId: 'u1', publishableKey: 'sb_publishable_x', newId: () => `drive-${++n}-${Math.random().toString(36).slice(2)}`,
    timezone: () => 'UTC', now: () => clock.t, tracker, journal,
    prepareFile: async () => ({ body: new Uint8Array([1]), size: 1, mimeType: 'image/jpeg' }),
  });
  return { app, tracker, updates, server, store, clock, journal };
}
type RecoveryApp = ReturnType<typeof recoveryApp>;

/** A winding A-road at 27 m/s (about 60 mph): it bends, so a point is kept every 3 s. */
function aRoadFix(s: number, t: number, accuracyM = 5): GpsFix {
  return {
    latitude: 53.23 + (s * 27 * Math.cos(s / 300)) / 111_320, longitude: -0.54 + (s * 27 * Math.sin(s / 300)) / 66_000,
    speedMs: 27, headingDeg: 0, accuracyM, altitudeM: 20, timestamp: t,
  };
}

/**
 * Drives seconds fromS+1 … fromS+seconds the way the app is fed: the
 * background task delivers fixes in batches of five, and while the phone is
 * unlocked (five minutes in every ten) the screen's watcher delivers each fix
 * too.  Optionally offline, paused, or with vague fixes for a while.
 */
async function longDrive(b: RecoveryApp, fromS: number, seconds: number, opts: {
  offline?: [number, number]; pause?: [number, number]; accuracyM?: (s: number) => number;
} = {}) {
  let batch: GpsFix[] = [];
  for (let s = fromS + 1; s <= fromS + seconds; s++) {
    b.clock.t += 1000;
    b.server.offline = !!opts.offline && s >= opts.offline[0] && s < opts.offline[1];
    if (opts.pause?.[0] === s) b.app.setDrivePaused(true);
    if (opts.pause?.[1] === s) b.app.setDrivePaused(false);
    const fix = aRoadFix(s, b.clock.t, opts.accuracyM?.(s));
    batch.push(fix);
    if (batch.length === 5) { await b.tracker.deliver(batch); batch = []; }
    if (s % 600 < 300) b.app.addFix(fix);
    if (s % 60 === 0) await settle();
  }
  if (batch.length) await b.tracker.deliver(batch);
  b.server.offline = false;
  await settle();
}

const savedActive = async (store: MemoryStore) => JSON.parse((await store.getItem(ACTIVE_KEY))!) as JourneyRecord;
const events = async (b: RecoveryApp) => (await b.journal.read()).map((e) => e.event);

test('a 2 h 10 min drive (locked and unlocked, offline for 15 min, paused) uploads every recorded point and finishes once', async () => {
  const b = recoveryApp(new MemoryStore(), { t: Date.parse('2026-10-05T13:00:00Z') });
  await b.app.start();
  await b.app.startDrive(null);
  await settle();
  await longDrive(b, 0, 130 * 60, { offline: [1800, 2700], pause: [4000, 4300] });
  const recorded = b.app.activeRecord!.points.length;
  assert.ok(recorded > 2400, `${recorded} points`);
  assert.ok(await b.app.endDrive());
  await b.app.sync();
  assert.equal(b.server.journeys.length, 1);
  assert.equal(b.server.journeys[0]!.status, 'completed');
  assert.equal(b.server.pointTimes.get(b.server.journeys[0]!.id)!.size, recorded, 'every recorded point reached the server');
  assert.equal(b.app.status.pendingJourneys, 0);
  assert.equal(await b.store.getItem(ACTIVE_KEY), null);
  assert.equal(b.app.unsettled, false);
});

for (const [gapMin, running, expected] of [
  [2, true, 'carried on'], [40, true, 'finished'], [40, false, 'finished'], [6 * 60, true, 'finished'],
] as const) {
  test(`a crash 1 h 38 min into a drive, reopened ${gapMin} min later with updates ${running ? 'still running' : 'gone'}: ${expected} with every saved point`, async () => {
    const store = new MemoryStore();
    const clock = { t: Date.parse('2026-10-05T13:00:00Z') };
    const updates = new FakeUpdates();
    const server = new FakeServer();
    const first = recoveryApp(store, clock, updates, server);
    await first.app.start();
    await first.app.startDrive(null);
    await settle();
    await longDrive(first, 0, 98 * 60);
    const saved = await savedActive(store);
    assert.ok(saved.points.length > 1900);
    first.app.dispose(); // the crash: only what was saved survives
    clock.t += gapMin * 60_000;
    updates.running = running;
    const again = recoveryApp(store, clock, updates, server, first.journal);
    await again.app.start();
    if (expected === 'carried on') {
      assert.equal(again.app.isDriving, true);
      assert.equal(again.app.activeRecord!.clientRef, saved.clientRef);
      assert.equal(again.app.activeRecord!.points.length, saved.points.length);
      assert.ok(again.app.activeDriveMs()! > 98 * 60_000, 'counted from its start: never "too short"');
      assert.ok(await again.app.endDrive());
    } else {
      assert.equal(again.app.isDriving, false);
      assert.equal(again.app.status.pendingJourneys, 1);
      assert.equal(updates.running, false, 'background updates stopped (last)');
      const finish = (await first.journal.read()).find((e) => e.event === 'recovery_finish')!;
      assert.equal(finish.kept, true);
      assert.ok((finish.drivenS as number) >= 97 * 60, `finished at its last activity (${finish.drivenS} s)`);
    }
    await again.app.sync();
    assert.equal(server.journeys.length, 1, 'one journey, finished once');
    assert.equal(server.journeys[0]!.status, 'completed');
    assert.ok(server.pointTimes.get(server.journeys[0]!.id)!.size >= saved.points.length);
    assert.equal(again.app.status.pendingJourneys, 0);
    assert.equal(server.deletedJourneys.length, 0);
    again.app.dispose();
  });
}

test('killed at any write while recovering an interrupted 45 min drive, the drive is never lost: the next launch finishes it once', async () => {
  let crashPoints = 0;
  for (let k = 0; ; k++) {
    const store = new FlakyStore();
    const clock = { t: Date.parse('2026-10-05T13:00:00Z') };
    const updates = new FakeUpdates();
    const server = new FakeServer();
    const first = recoveryApp(store, clock, updates, server);
    await first.app.start();
    await first.app.startDrive(null);
    await settle();
    await longDrive(first, 0, 45 * 60);
    const saved = await savedActive(store);
    first.app.dispose();
    // Reopened 40 min later: recovery finishes the drive... and the app is
    // killed after its k-th write (every write after that fails)
    clock.t += 40 * 60_000;
    store.writesLeft = k;
    const second = recoveryApp(store, clock, updates, server);
    await second.app.start();
    second.app.dispose();
    const killedDuringRecovery = store.failedWrites > 0;
    if (killedDuringRecovery) crashPoints++;
    // The next launch, with storage working
    store.writesLeft = Infinity;
    const third = recoveryApp(store, clock, updates, server);
    await third.app.start();
    await third.app.sync();
    assert.equal(server.journeys.length, 1, `k=${k}: one journey`);
    assert.equal(server.journeys[0]!.status, 'completed', `k=${k}: finished`);
    assert.ok(server.pointTimes.get(server.journeys[0]!.id)!.size >= saved.points.length, `k=${k}: every saved point`);
    assert.equal(third.app.status.pendingJourneys, 0, `k=${k}: nothing left waiting`);
    assert.equal(await store.getItem(ACTIVE_KEY), null, `k=${k}: nothing left in "active"`);
    assert.equal(third.app.data.journeys.length, 1, `k=${k}: shown once`);
    third.app.dispose();
    if (!killedDuringRecovery) break;
  }
  assert.ok(crashPoints >= 3, `killed at ${crashPoints} different writes (pending saved, active cleared, session cleared...)`);
});

test('killed after saving the finished drive to pending but before clearing "active": both copies merge into one', async () => {
  const store = new FlakyStore();
  const clock = { t: Date.parse('2026-10-05T13:00:00Z') };
  const updates = new FakeUpdates();
  const server = new FakeServer();
  const first = recoveryApp(store, clock, updates, server);
  await first.app.start();
  await first.app.startDrive(null);
  await settle();
  await longDrive(first, 0, 20 * 60);
  first.app.dispose();
  clock.t += 40 * 60_000;
  store.failWrites = ['journey/active']; // clearing "active" fails, as if killed right there
  const second = recoveryApp(store, clock, updates, server);
  await second.app.start();
  second.app.dispose();
  assert.ok(await store.getItem(ACTIVE_KEY), 'still in "active"');
  assert.equal((JSON.parse((await store.getItem(PENDING_KEY))!) as JourneyRecord[]).length, 1, '...and in pending');
  assert.equal(updates.running, true, 'updates not stopped before the drive was safe');
  store.failWrites = [];
  const third = recoveryApp(store, clock, updates, server);
  await third.app.start();
  assert.equal(third.app.status.pendingJourneys, 1, 'one drive, not two');
  await third.app.sync();
  assert.equal(server.journeys.length, 1);
  assert.equal(server.journeys[0]!.status, 'completed');
  assert.equal(await store.getItem(ACTIVE_KEY), null);
  assert.equal(updates.running, false);
  third.app.dispose();
  // dedupeDrives keeps the fuller copy and what either knew about its upload
  const a = { ...newRecord({ clientRef: 'x', startedAt: new Date(0), timezone: 'UTC', vehicleId: null, vehicleSnapshot: null }), serverId: 's1' };
  const fuller = { ...a, serverId: null, points: [{ recordedAt: new Date(1000).toISOString(), latitude: 0, longitude: 0, speedKmh: 0, headingDeg: null, accuracyM: 5, altitudeM: null }] };
  const merged = dedupeDrives([a, fuller]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0]!.points.length, 1);
  assert.equal(merged[0]!.serverId, 's1');
});

test('a saved drive that can\'t be read is never taken for "no drive": tracking goes on, nothing overwrites it, and it carries on once readable', async () => {
  const store = new FlakyStore();
  const clock = { t: Date.parse('2026-10-05T13:00:00Z') };
  const updates = new FakeUpdates();
  const server = new FakeServer();
  const first = recoveryApp(store, clock, updates, server);
  await first.app.start();
  await first.app.startDrive(null);
  await settle();
  await longDrive(first, 0, 20 * 60);
  const raw = await store.getItem(ACTIVE_KEY);
  const clientRef = (await savedActive(store)).clientRef;
  first.app.dispose();
  clock.t += 60_000;
  store.failReads = ['journey/active'];
  const again = recoveryApp(store, clock, updates, server, first.journal);
  await again.app.start();
  assert.equal(again.app.isDriving, false, 'nothing decided yet');
  assert.equal(again.app.unsettled, true);
  assert.equal(updates.running, true, 'background tracking not stopped');
  // Fixes keep coming, from the background and the screen: held, not dropped
  for (let s = 1261; s <= 1320; s++) {
    clock.t += 1000;
    again.app.addFix(aRoadFix(s, clock.t));
    if (s % 5 === 0) await again.tracker.deliver([aRoadFix(s, clock.t)]);
  }
  // A new drive can't take its place
  await assert.rejects(again.app.startDrive(null), /couldn't be read/);
  assert.equal(again.app.isDriving, false);
  store.failReads = [];
  assert.equal(await store.getItem(ACTIVE_KEY), raw, 'left exactly as it was');
  // Readable again: picked up where it was, held fixes included
  await again.app.settleNow();
  assert.equal(again.app.isDriving, true);
  assert.equal(again.app.activeRecord!.clientRef, clientRef);
  assert.ok(lastActivityMs(again.app.activeRecord!) >= clock.t - 1000, 'the held fixes were recorded');
  assert.equal(again.app.unsettled, false);
  const ev = await events(again);
  assert.ok(ev.includes('storage_read_failed') && ev.includes('storage_read_recovered') && ev.includes('recovery_resume'), ev.join(','));
  assert.ok(await again.app.endDrive());
  await again.app.sync();
  assert.equal(server.journeys[0]!.status, 'completed');
  again.app.dispose();
});

test('a corrupt saved drive is copied aside byte for byte, its server journey is kept, and the server copy is reported later (not changed)', async () => {
  const store = new MemoryStore();
  const clock = { t: Date.parse('2026-10-05T13:00:00Z') };
  const updates = new FakeUpdates();
  const server = new FakeServer();
  const first = recoveryApp(store, clock, updates, server);
  await first.app.start();
  await first.app.startDrive(null);
  await settle();
  await longDrive(first, 0, 30 * 60);
  first.app.dispose();
  const corrupt = (await store.getItem(ACTIVE_KEY))!.slice(0, -37);
  await store.setItem(ACTIVE_KEY, corrupt);
  clock.t += 40 * 60_000;
  updates.running = false;
  const again = recoveryApp(store, clock, updates, server, first.journal);
  await again.app.start();
  const quarantined = JSON.parse((await store.getItem(userKey('u1', 'journey/quarantine')))!) as string[];
  assert.equal(quarantined.length, 1);
  assert.equal(await store.getItem(quarantined[0]!), corrupt, 'kept byte for byte');
  assert.ok((await events(again)).includes('storage_quarantined'));
  assert.equal(server.deletedJourneys.length, 0);
  assert.equal(server.journeys[0]!.status, 'active', 'the server copy is untouched');
  // New drives aren't blocked by it
  await again.app.startDrive(null);
  assert.equal(again.app.isDriving, true);
  await again.app.discardDrive();
  // Hours later, the server copy (uploaded every 30 s while driving) is
  // reported as a lost drive: identified, but left exactly as it is
  const lostId = server.journeys[0]!.id;
  const before = JSON.stringify(server.journeys);
  clock.t += ORPHAN_IDLE_MS;
  await again.app.sync();
  assert.deepEqual(again.app.orphanJourneys.map((o) => [o.serverId, o.outcome]), [[lostId, 'candidate']]);
  assert.ok(again.app.orphanJourneys[0]!.pointCount > 500);
  assert.equal(JSON.stringify(server.journeys), before, 'not finished, changed or deleted');
  assert.ok((await events(again)).includes('orphan_found'));
  again.app.dispose();
});

test('finished drives that can\'t be read are never overwritten: new drives wait beside them and both upload once readable', async () => {
  const store = new FlakyStore();
  const clock = { t: Date.parse('2026-10-05T13:00:00Z') };
  const updates = new FakeUpdates();
  const server = new FakeServer();
  server.offline = true;
  const first = recoveryApp(store, clock, updates, server);
  await first.app.start();
  await first.app.startDrive(null);
  await settle();
  first.server.offline = true;
  for (let s = 1; s <= 600; s++) { clock.t += 1000; first.app.addFix(aRoadFix(s, clock.t)); }
  await first.app.endDrive(); // offline: waits on the phone
  first.app.dispose();
  const pendingRaw = await store.getItem(PENDING_KEY);
  assert.equal((JSON.parse(pendingRaw!) as JourneyRecord[]).length, 1);
  store.failReads = ['journey/pending'];
  const again = recoveryApp(store, clock, updates, server, first.journal);
  await again.app.start();
  assert.equal(again.app.unsettled, true);
  // A new drive is allowed (it doesn't touch the list)...
  await again.app.startDrive(null);
  for (let s = 1; s <= 120; s++) { clock.t += 1000; again.app.addFix(aRoadFix(5000 + s, clock.t)); }
  await again.app.endDrive();
  // ...but finishing it can't replace the unreadable list: it stays in "active" meanwhile
  store.failReads = [];
  assert.equal(await store.getItem(PENDING_KEY), pendingRaw, 'the unreadable list was never overwritten');
  assert.ok(await store.getItem(ACTIVE_KEY), 'the new drive is still safe in "active"');
  await again.app.settleNow();
  assert.equal((JSON.parse((await store.getItem(PENDING_KEY))!) as JourneyRecord[]).length, 2, 'both drives');
  assert.equal(await store.getItem(ACTIVE_KEY), null);
  server.offline = false;
  await again.app.sync();
  assert.equal(server.journeys.filter((j) => j.status === 'completed').length, 2);
  // A corrupt list is copied aside before anything replaces it
  await store.setItem(PENDING_KEY, '[{"clientRef":');
  const third = recoveryApp(store, clock, updates, server);
  await third.app.start();
  const quarantined = JSON.parse((await store.getItem(userKey('u1', 'journey/quarantine')))!) as string[];
  assert.equal(await store.getItem(quarantined.at(-1)!), '[{"clientRef":');
  assert.equal(third.app.unsettled, false);
  again.app.dispose();
  third.app.dispose();
});

test('the background task never stops recording because the drive or its session couldn\'t be read: it holds the fixes and records them later', async () => {
  for (const unreadable of ['background-session', 'journey/active']) {
    const store = new FlakyStore();
    const clock = { t: Date.parse('2026-10-05T13:00:00Z') };
    const updates = new FakeUpdates();
    const first = recoveryApp(store, clock, updates);
    await first.app.start();
    await first.app.startDrive(null);
    await settle();
    await longDrive(first, 0, 5 * 60);
    await first.app.saveActiveNow();
    first.app.dispose(); // iOS ended the app; it relaunches it in the background
    const journal = new DiagnosticsJournal({ store: new MemoryStore(), now: () => clock.t });
    const headless = new BackgroundDriveRecorder({ store, updates, now: () => clock.t, journal });
    store.failReads = [unreadable];
    const heldFrom = clock.t;
    for (let s = 301; s <= 360; s += 5) {
      const batch = [];
      for (let k = 0; k < 5; k++) { clock.t += 1000; batch.push(aRoadFix(s + k, clock.t)); }
      await headless.deliver(batch);
    }
    assert.equal(updates.running, true, `${unreadable}: updates not stopped`);
    assert.ok((await journal.read()).some((e) => e.event === 'background_fixes_held'), unreadable);
    store.failReads = [];
    for (let s = 361; s <= 400; s += 5) {
      const batch = [];
      for (let k = 0; k < 5; k++) { clock.t += 1000; batch.push(aRoadFix(s + k, clock.t)); }
      await headless.deliver(batch);
    }
    await headless.attach('u1', () => {}); // hands over: saves what it recorded
    const rec = await savedActive(store);
    const held = rec.points.filter((p) => Date.parse(p.recordedAt) > heldFrom && Date.parse(p.recordedAt) <= heldFrom + 60_000);
    assert.ok(held.length >= 15, `${unreadable}: fixes from while it couldn't be read are in the drive (${held.length})`);
    assert.ok(Date.parse(rec.lastFixAt!) >= clock.t - 1000);
    assert.equal(updates.running, true);
  }
  assert.ok(HELD_FIXES_MAX >= 7200, 'about two hours of fixes can be held');
});

test('server journeys left "active" with no drive on the phone are reported, never finished, changed or deleted', async () => {
  const clock = { t: Date.parse('2026-10-08T12:00:00Z') };
  const server = new FakeServer();
  const iso = (ms: number) => new Date(ms).toISOString();
  const seed = (id: string, clientRef: string, startedAt: number, times: number[], status = 'active') => {
    server.journeys.push({ id, clientRef, status, startedAt: iso(startedAt), name: 'Active Journey', route: null } as unknown as ServerJourney);
    server.pointTimes.set(id, new Set(times.map(iso)));
  };
  const twoDaysAgo = clock.t - 2 * 24 * 3600_000;
  const every3s = (from: number, seconds: number) => Array.from({ length: Math.floor(seconds / 3) }, (_, i) => from + i * 3000);
  const lostTimes = every3s(twoDaysAgo, 100 * 60);
  seed('lost', 'lost-ref', twoDaysAgo, lostTimes); // 1 h 40 min, two days ago: the Lincoln case
  seed('recent', 'other-phone', clock.t - 60 * 60_000, every3s(clock.t - 60 * 60_000, 30 * 60)); // quiet for 30 min
  seed('tiny', 'tiny-ref', twoDaysAgo, [twoDaysAgo + 1000]);
  seed('none', 'none-ref', twoDaysAgo, []);
  seed('short', 'short-ref', twoDaysAgo, [twoDaysAgo, twoDaysAgo + 4000]);
  seed('done', 'done-ref', twoDaysAgo, every3s(twoDaysAgo, 600), 'completed');
  seed('mine', 'mine-ref', twoDaysAgo, every3s(twoDaysAgo, 600));
  // 'mine' is still on this phone: a finished drive the server rejected, kept for the user
  const store = new MemoryStore();
  const mine = { ...newRecord({ clientRef: 'mine-ref', startedAt: new Date(twoDaysAgo), timezone: 'UTC', vehicleId: null, vehicleSnapshot: null }),
    serverId: 'mine', endedAt: iso(twoDaysAgo + 600_000), rejected: true };
  await store.setItem(PENDING_KEY, JSON.stringify([mine]));
  const before = JSON.stringify({ journeys: server.journeys, points: [...server.pointTimes].map(([k, v]) => [k, [...v]]) });
  const b = recoveryApp(store, clock, undefined, server);
  await b.app.start();
  server.calls = [];
  const found = await b.app.findOrphanJourneys();
  const outcome = Object.fromEntries(found.map((o) => [o.serverId, o.outcome]));
  assert.deepEqual(outcome, { lost: 'candidate', recent: 'recent', tiny: 'too-few-points', none: 'too-few-points', short: 'too-few-points' });
  // Enough to identify the lost drive safely
  assert.deepEqual(found.find((o) => o.serverId === 'lost'), {
    serverId: 'lost', clientRef: 'lost-ref', name: 'Active Journey', startedAt: iso(twoDaysAgo),
    firstPointAt: iso(lostTimes[0]!), lastPointAt: iso(lostTimes.at(-1)!), pointCount: 2000,
    spanS: Math.round((lostTimes.at(-1)! - lostTimes[0]!) / 1000), quietH: 46.3, outcome: 'candidate', // quiet since its last point
  });
  assert.deepEqual(b.app.orphanJourneys, found, 'kept for the app to show');
  // Report only: nothing on the server changed, and only reads were sent
  assert.deepEqual([...new Set(server.calls)].sort(), ['getJourneyPoints', 'listActiveJourneys']);
  assert.equal(JSON.stringify({ journeys: server.journeys, points: [...server.pointTimes].map(([k, v]) => [k, [...v]]) }), before);
  assert.equal(server.deletedJourneys.length, 0);
  // Each one is in the journal with what identifies it (times and ids only)
  const entries = await b.journal.read();
  const lostEntry = entries.find((e) => e.event === 'orphan_found' && e.serverId === 'lost')!;
  assert.equal(lostEntry.outcome, 'candidate');
  assert.equal(lostEntry.clientRef, 'lost-ref');
  assert.equal(lostEntry.lastPointAt, iso(lostTimes.at(-1)!));
  assert.equal(lostEntry.pointCount, 2000);
  assert.equal(entries.filter((e) => e.event === 'orphan_found').length, 5);
  assert.deepEqual(entries.filter((e) => e.event === 'orphan_check').map((e) => [e.found, e.candidates]), [[5, 1]]);
  assert.ok(!entries.some((e) => e.event === 'orphan_finalized'));
  // Checked at most hourly; a later check doesn't repeat them in the journal, and still changes nothing
  assert.deepEqual(await b.app.findOrphanJourneys(), []);
  clock.t += ORPHAN_CHECK_EVERY_MS;
  server.calls = [];
  await b.app.sync();
  assert.ok(!server.calls.some((c) => /^(complete|delete|update|start)Journey$|^addRoutePoints$/.test(c)), server.calls.join(','));
  assert.equal((await b.journal.read()).filter((e) => e.event === 'orphan_found').length, 5);
  assert.equal(server.journeys.find((j) => j.id === 'lost')!.status, 'active');
  assert.ok(!b.app.data.journeys.some((j) => j.id === 'lost'), 'not shown as a drive: nothing was finished');
  b.app.dispose();
});

test('drives this phone is recording or still uploading are never reported as orphans', async () => {
  const clock = { t: Date.parse('2026-10-08T06:00:00Z') };
  const server = new FakeServer();
  const b = recoveryApp(new MemoryStore(), clock, undefined, server);
  await b.app.start();
  // A finished drive still waiting to finish uploading (offline when it ended)
  await b.app.startDrive(null);
  await settle();
  await longDrive(b, 0, 10 * 60);
  const waiting = b.app.activeRecord!.clientRef;
  server.offline = true;
  await b.app.endDrive();
  server.offline = false;
  assert.equal(b.app.status.pendingJourneys, 1);
  // A long drive in progress, then parked for 4 h with recording on (no new points)
  await b.app.startDrive(null);
  await settle();
  await longDrive(b, 10_000, 20 * 60);
  const driving = b.app.activeRecord!.clientRef;
  clock.t += 4 * 3600_000;
  // A real orphan alongside them, as a control
  const old = clock.t - 24 * 3600_000;
  server.journeys.push({ id: 'orphan', clientRef: 'orphan-ref', status: 'active', startedAt: new Date(old).toISOString(), name: 'Active Journey', route: null } as unknown as ServerJourney);
  server.pointTimes.set('orphan', new Set([old, old + 600_000].map((t) => new Date(t).toISOString())));
  // Both of this phone's journeys are active on the server and quiet for hours
  const mine = server.journeys.filter((j) => j.clientRef === waiting || j.clientRef === driving);
  assert.equal(mine.length, 2);
  assert.ok(mine.every((j) => j.status === 'active'));
  const found = await b.app.findOrphanJourneys();
  assert.deepEqual(found.map((o) => [o.serverId, o.outcome]), [['orphan', 'candidate']], 'only the real orphan');
  assert.equal(b.app.isDriving, true);
  b.app.dispose();
});

test('the orphan check leaves journeys alone while a saved drive is unreadable, or when a change to them is queued', async () => {
  const clock = { t: Date.parse('2026-10-08T12:00:00Z') };
  const server = new FakeServer();
  const old = clock.t - 24 * 3600_000;
  server.journeys.push({ id: 'old', clientRef: 'old-ref', status: 'active', startedAt: new Date(old).toISOString(), name: 'Active Journey', route: null } as unknown as ServerJourney);
  server.pointTimes.set('old', new Set([old, old + 60_000].map((t) => new Date(t).toISOString())));
  // An unreadable drive on the phone might be that journey: nothing is touched
  const store = new FlakyStore();
  await store.setItem(ACTIVE_KEY, JSON.stringify(newRecord({ clientRef: 'old-ref', startedAt: new Date(old), timezone: 'UTC', vehicleId: null, vehicleSnapshot: null })));
  store.failReads = ['journey/active'];
  const b = recoveryApp(store, clock, undefined, server);
  await b.app.start();
  assert.deepEqual(await b.app.findOrphanJourneys(), []);
  assert.equal(server.journeys[0]!.status, 'active');
  b.app.dispose();
  // A delete queued for it (the user removed it while it couldn't be sent): not finished behind their back
  const ep = server.ep();
  ep.deleteJourney = async () => { throw new NetworkError(); };
  const c = new CloudSync({
    ep, store: new MemoryStore(), userId: 'u1', publishableKey: 'x', newId: () => 'n', timezone: () => 'UTC', now: () => clock.t,
    prepareFile: async () => ({ body: new Uint8Array([1]), size: 1, mimeType: 'image/jpeg' }),
  });
  await c.start();
  await c.deleteJourney('old');
  const found = await c.findOrphanJourneys();
  assert.deepEqual(found.map((o) => o.outcome), ['change-queued']);
  assert.equal(server.journeys[0]!.status, 'active');
  c.dispose();
});

test('a long drive is never discarded as "too short" after a crash, even when its last fixes weren\'t kept as points', async () => {
  for (const [label, vagueFromS, minutes] of [
    ['the last 20 min too vague to keep (urban canyon)', 40 * 60, 60],
    ['no fix ever precise enough to keep', 0, 30],
  ] as const) {
    const store = new MemoryStore();
    const clock = { t: Date.parse('2026-10-05T13:00:00Z') };
    const updates = new FakeUpdates();
    const server = new FakeServer();
    const first = recoveryApp(store, clock, updates, server);
    await first.app.start();
    await first.app.startDrive(null);
    await settle();
    await longDrive(first, 0, minutes * 60, { accuracyM: (s) => (s > vagueFromS ? 150 : 5) });
    await first.app.saveActiveNow();
    first.app.dispose();
    clock.t += 40 * 60_000;
    updates.running = false;
    const again = recoveryApp(store, clock, updates, server, first.journal);
    await again.app.start();
    assert.equal(again.app.status.pendingJourneys, 1, `${label}: kept`);
    const finish = (await first.journal.read()).find((e) => e.event === 'recovery_finish')!;
    assert.ok((finish.drivenS as number) >= minutes * 60 - 70, `${label}: finished at its last fix (${finish.drivenS} s)`);
    assert.equal(server.deletedJourneys.length, 0);
    await again.app.sync();
    assert.equal(server.journeys[0]!.status, 'completed', label);
    again.app.dispose();
  }
  // The End Drive button checks the drive's own timestamps, not the on-screen timer
  const screen = readFileSync(join(MOBILE, 'app/(tabs)/(drive)/index.tsx'), 'utf8');
  assert.ok(/const drivenMs = activeDriveMs\(\) \?\? driveSecondsRef\.current \* 1000;\s*if \(!isLongEnoughToSave\(drivenMs\)\)/.test(screen));
  // ...and recovery never deletes a server journey
  const sync = readFileSync(join(MOBILE, 'lib/backend/cloudSync.ts'), 'utf8');
  const recovery = sync.slice(sync.indexOf('private async recoverActive'), sync.indexOf('private async persistPending'));
  assert.ok(!/journey\.delete|deleteJourney/.test(recovery), 'no deletion during recovery');
});

test('the diagnostics journal: kept on the device, capped, never with a location, never failing', async () => {
  const store = new MemoryStore();
  let t = Date.parse('2026-10-08T09:00:00Z');
  const j = new DiagnosticsJournal({ store, now: () => t, max: 5 });
  j.log('launch', { appState: 'background' });
  j.log('drive_start', { clientRef: 'abc', latitude: 53.2, longitude: -0.5, lat: 1, lng: 2, points: 3, route: 'x', coordinates: 'y', pointCount: 3 });
  await j.flush();
  const [launch, drive] = await j.read();
  assert.deepEqual(launch, { t: '2026-10-08T09:00:00.000Z', event: 'launch', appState: 'background' });
  assert.deepEqual(drive, { t: '2026-10-08T09:00:00.000Z', event: 'drive_start', clientRef: 'abc', pointCount: 3 });
  for (let i = 0; i < 10; i++) { t += 1000; j.log('tick', { i }); }
  await j.flush();
  const kept = await j.read();
  assert.equal(kept.length, 5);
  assert.equal(kept.at(-1)!.i, 9);
  // Saved: a later launch reads it back, then adds to it
  const later = new DiagnosticsJournal({ store, now: () => t, max: 5 });
  later.log('launch', { appState: 'active' });
  await later.flush();
  assert.deepEqual((await later.read()).map((e) => e.event), ['tick', 'tick', 'tick', 'tick', 'launch']);
  assert.match(await later.text(), /^2026-10-08T09:00:10\.000Z launch appState="active"$/m);
  // Storage failing never makes logging fail
  const broken = new DiagnosticsJournal({ store: { getItem: async () => { throw new Error('x'); }, setItem: async () => { throw new Error('x'); }, removeItem: async () => {} } });
  broken.log('anything', { a: 1 });
  await broken.flush();
  assert.equal((await broken.read()).length, 1);
  assert.ok(JOURNAL_KEY.startsWith('@driveos/'));
  // A fatal error is saved small enough to write synchronously as the app dies
  const err = new TypeError('Cannot read property x of undefined');
  err.stack = 'a'.repeat(5000);
  const fatal = fatalErrorRecord(err, Date.parse('2026-10-08T09:00:00Z'), 'background');
  assert.equal(fatal.message, 'TypeError: Cannot read property x of undefined');
  assert.equal(fatal.stack!.length, 1200);
  assert.equal(fatal.appState, 'background');
  assert.ok(JSON.stringify(fatal).length < 2048);
});

test('a drive, a crash and its recovery are all journaled, with no route or position anywhere in it', async () => {
  const store = new FlakyStore();
  const clock = { t: Date.parse('2026-10-05T13:00:00Z') };
  const updates = new FakeUpdates();
  const server = new FakeServer();
  const first = recoveryApp(store, clock, updates, server);
  await first.app.start();
  await first.app.startDrive(null);
  await settle();
  await longDrive(first, 0, 10 * 60);
  const clientRef = first.app.activeRecord!.clientRef;
  first.app.dispose();
  clock.t += 40 * 60_000;
  updates.running = false;
  store.failWrites = ['journey/pending'];
  const again = recoveryApp(store, clock, updates, server, first.journal);
  await again.app.start();
  store.failWrites = [];
  await again.app.sync();
  const entries = await first.journal.read();
  const ev = entries.map((e) => e.event);
  for (const e of ['sync_start', 'drive_start', 'tracking_start', 'drive_server_id', 'sync_started', 'storage_write_failed', 'recovery_finish', 'tracking_stop', 'recovery_settled']) {
    assert.ok(ev.includes(e), `${e} missing from ${ev.join(',')}`);
  }
  assert.ok(entries.some((e) => e.event === 'drive_start' && e.clientRef === clientRef), 'the drive is identified by its clientRef');
  assert.ok(entries.every((e) => /^\d{4}-\d\d-\d\dT/.test(e.t)), 'every entry timestamped');
  const all = JSON.stringify(entries) + (await first.journal.text());
  assert.ok(!/latitude|longitude|"lat"|"lng"/.test(all), 'no position fields');
  assert.ok(!/53\.2\d|-0\.5\d|0\.54\d/.test(all), 'no coordinates');
  again.app.dispose();
});

test('the journal is wired in: launch noted first, fatal JS errors saved synchronously, recorders given it', () => {
  const diag = readFileSync(join(MOBILE, 'lib/diagnostics.ts'), 'utf8');
  assert.match(diag, /journal\.log\('launch', \{ appState: AppState\.currentState/);
  assert.match(diag, /setGlobalHandler\(\(error, isFatal\) => \{\s*if \(isFatal\) \{\s*try \{\s*SecureStore\.setItem\(LAST_FATAL_KEY/);
  assert.match(diag, /previous\(error, isFatal\);/);
  assert.match(diag, /journal\.log\('fatal_js_error'/);
  assert.match(readFileSync(join(MOBILE, 'lib/driveBackgroundLocation.ts'), 'utf8'), /new BackgroundDriveRecorder\(\{ store: deviceStorage, updates, journal \}\)/);
  assert.match(readFileSync(join(MOBILE, 'context/AppContext.tsx'), 'utf8'), /tracker: driveTracker, journal,/);
});

// ─── Crash fix: camera writes and background visual work ─────────────────────
//
// The device logs: every crash was a watchdog kill in the background, with
// the main thread running a queue of Mapbox camera commands (one a frame,
// each a promise) and memory in the gigabytes.  The follow camera now goes
// through a LatestPoseWriter (one write in flight, newest pose only) into the
// Camera's props, and nothing visual runs while the app isn't on screen.

import { CAMERA_WRITES, LatestPoseWriter, sameFollowPose } from '@/lib/cameraWriter';
import { VisualGate } from '@/lib/visualGate';
import { LIVE_ROUTE, LiveDriveFeed, appendLiveFixes } from '@/lib/backend/liveDrive';
import { TRAIL_DISPLAY, displayTrail } from '@/lib/mapbox';
import type { FollowCameraPose } from '@/lib/locationSmoothing';

/** Timers on a fake clock */
class FakeTimers {
  t = 0;
  private queue: { at: number; fn: () => void; id: number }[] = [];
  private n = 0;
  get pending() { return this.queue.length; }
  set = (fn: () => void, ms: number) => { const id = ++this.n; this.queue.push({ at: this.t + ms, fn, id }); return id; };
  clear = (id: unknown) => { this.queue = this.queue.filter((q) => q.id !== id); };
  advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      this.queue.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = this.queue[0];
      if (!next || next.at > end) break;
      this.queue.shift();
      this.t = next.at;
      next.fn();
    }
    this.t = end;
  }
}

/** A native camera that takes `delayMs` to apply each write (or never, with Infinity), counting what's outstanding */
function slowCamera(timers: FakeTimers, delayMs: () => number) {
  const cam = { outstanding: 0, maxOutstanding: 0, applied: [] as FollowCameraPose[], writes: 0 };
  const writer = new LatestPoseWriter<FollowCameraPose>({
    write: (pose, applied) => {
      cam.writes++;
      cam.outstanding++;
      cam.maxOutstanding = Math.max(cam.maxOutstanding, cam.outstanding);
      const d = delayMs();
      if (Number.isFinite(d)) timers.set(() => { cam.outstanding--; cam.applied.push(pose); applied(); }, d);
    },
    same: sameFollowPose, now: () => timers.t, setTimer: timers.set, clearTimer: timers.clear,
  });
  return { cam, writer };
}

const poseAt = (i: number): FollowCameraPose => ({
  center: { latitude: 53.23 + i * 1e-6, longitude: -0.54 }, heading: (i * 0.2) % 360, pitch: 55, distance: 400, zoom: 17,
});

test('10,000 camera poses while the native camera is slow: one write in flight, only the newest waiting, nothing piling up', () => {
  const timers = new FakeTimers();
  const { cam, writer } = slowCamera(timers, () => 50); // 50 ms a write: far slower than the poses arrive
  let maxWaiting = 0;
  let maxTimers = 0;
  for (let i = 0; i < 10_000; i++) {
    writer.submit(poseAt(i)); // a pose every millisecond
    const st = writer.stats;
    assert.ok(st.inFlight <= 1);
    maxWaiting = Math.max(maxWaiting, st.waiting);
    maxTimers = Math.max(maxTimers, timers.pending);
    timers.advance(1);
  }
  timers.advance(200);
  const st = writer.stats;
  assert.equal(cam.maxOutstanding, 1, 'never more than one write outstanding at the native camera');
  assert.equal(st.maxInFlight, 1);
  assert.equal(maxWaiting, 1, 'at most one pose waiting');
  assert.ok(maxTimers <= 3, `timers stay bounded (${maxTimers})`);
  assert.ok(cam.writes <= 10_000 / 50 + 2, `writes follow the camera's pace, not the poses' (${cam.writes})`);
  assert.ok(st.replaced > 9_000, 'waiting poses replaced, never queued');
  // Each write after the first is the newest pose there was when the previous one landed
  assert.deepEqual(cam.applied.at(-1), poseAt(9_999), 'the last pose is the one that ends up on the map');
  for (let k = 1; k < cam.applied.length; k++) {
    const i = Math.round((cam.applied[k]!.center.latitude - 53.23) / 1e-6);
    const prev = Math.round((cam.applied[k - 1]!.center.latitude - 53.23) / 1e-6);
    assert.ok(i - prev >= 40 || k === cam.applied.length - 1, 'intermediate poses were skipped, not replayed');
  }
  assert.equal(st.inFlight, 0);
  assert.equal(st.waiting, 0, 'nothing left behind once idle');
});

test('a camera write that never reports back is given up on: the camera can\'t freeze, and nothing piles up', () => {
  const timers = new FakeTimers();
  const { cam, writer } = slowCamera(timers, () => Infinity);
  for (let i = 0; i < 10_000; i++) { writer.submit(poseAt(i)); timers.advance(1); }
  assert.ok(writer.stats.timedOut >= 9 && writer.stats.timedOut <= 11, `${writer.stats.timedOut}`);
  assert.ok(cam.writes <= 11, `about one write a second (${cam.writes})`);
  assert.ok(writer.stats.inFlight <= 1 && writer.stats.waiting <= 1);
  assert.equal(CAMERA_WRITES.timeoutMs, 1000);
});

test('camera writes: unchanged poses aren\'t written, the rate is capped, and pausing drops what waits (no replay)', () => {
  const timers = new FakeTimers();
  const { cam, writer } = slowCamera(timers, () => 0); // a camera that applies at once
  writer.submit(poseAt(1));
  for (let i = 0; i < 100; i++) { writer.submit(poseAt(1)); timers.advance(1); }
  assert.equal(cam.writes, 1, 'the same pose again is not written');
  assert.equal(writer.stats.skipped, 100);
  // ...unless the map was moved by something else (a gesture): then it's written once more
  writer.invalidate();
  writer.submit(poseAt(1));
  timers.advance(CAMERA_WRITES.minIntervalMs);
  assert.equal(cam.writes, 2);
  // Poses every millisecond: written at most once per minIntervalMs
  const before = cam.writes;
  for (let i = 2; i < 1002; i++) { writer.submit(poseAt(i)); timers.advance(1); }
  const rate = cam.writes - before;
  assert.ok(rate <= Math.ceil(1000 / CAMERA_WRITES.minIntervalMs) + 1, `${rate} writes in a second`);
  // Paused (the app left the screen): nothing written, nothing kept
  writer.pause();
  const atPause = cam.writes;
  for (let i = 0; i < 5000; i++) { writer.submit(poseAt(5000 + i)); timers.advance(1); }
  assert.equal(cam.writes, atPause, 'no camera writes while paused');
  assert.equal(writer.stats.waiting, 0);
  assert.equal(timers.pending, 0, 'no timers left running while paused');
  // Back: the next pose is written, and only it
  writer.resume();
  timers.advance(100);
  assert.equal(cam.writes, atPause, 'nothing replayed on resume');
  writer.submit(poseAt(99_999));
  timers.advance(20);
  assert.equal(cam.writes, atPause + 1);
  assert.deepEqual(cam.applied.at(-1), poseAt(99_999));
});

test('the visual gate: background means no visual work, and a background launch never creates the map', () => {
  // Launched by iOS in the background to deliver locations
  const bg = new VisualGate('background');
  assert.deepEqual(bg.current, { live: false, mounted: false });
  const seen: string[] = [];
  bg.subscribe((n, p) => seen.push(`${p.live}->${n.live}/${n.mounted}`));
  bg.update('background');
  assert.deepEqual(seen, [], 'still nothing');
  bg.update('active'); // the user opens the app
  assert.deepEqual(bg.current, { live: true, mounted: true });
  bg.update('inactive'); // Control Centre, a call, the app switcher
  assert.deepEqual(bg.current, { live: false, mounted: true });
  bg.update('background');
  assert.deepEqual(bg.current, { live: false, mounted: true }, 'the map stays created, only paused');
  bg.update('active');
  assert.deepEqual(seen, ['false->true/true', 'true->false/true', 'false->true/true']);
  // A normal launch (inactive, then active) creates the map straight away
  const fg = new VisualGate('inactive');
  assert.deepEqual(fg.current, { live: false, mounted: true });
  assert.deepEqual(new VisualGate('active').current, { live: true, mounted: true });
});

test('the live route while the app is off screen: held, not re-rendered per fix, and caught up in one update', () => {
  const published: (ActiveDrive | null)[] = [];
  const feed = new LiveDriveFeed((d) => published.push(d), true);
  feed.set(newLiveDrive(0));
  const fix = (s: number): GpsFix => ({ latitude: 53.23 + s * 27 / 111_320, longitude: -0.54, speedMs: 27, accuracyM: 5, timestamp: s * 1000 });
  for (let s = 1; s <= 60; s++) feed.addFix(fix(s));
  assert.equal(published.length, 61, 'on screen: each fix published');
  feed.setVisible(false);
  for (let s = 61; s <= 3660; s++) feed.addFix(fix(s)); // an hour in the background
  assert.equal(published.length, 61, 'off screen: nothing published (no re-renders)');
  assert.ok(feed.heldCount < LIVE_ROUTE.maxHeldFixes, `held fixes stay bounded (${feed.heldCount})`);
  feed.setVisible(true);
  assert.equal(published.length, 62, 'back on screen: one update');
  const route = published.at(-1)!.coordinates;
  assert.equal(route.length, 3660, 'the whole drive is in it');
  assert.deepEqual(route.at(-1), { latitude: fix(3660).latitude, longitude: fix(3660).longitude }, 'ending at the newest fix');
  feed.setVisible(true);
  assert.equal(published.length, 62, 'nothing replayed');
});

test('the live route stays bounded: a parked car adds no points, and a very long drive is thinned', () => {
  const start = newLiveDrive(0);
  // Parked for an hour: GPS wanders within a metre
  const jitter = Array.from({ length: 3600 }, (_, i): GpsFix => ({
    latitude: 53.23 + (Math.sin(i) * 0.5) / 111_320, longitude: -0.54 + (Math.cos(i) * 0.5) / 66_000, speedMs: 0, accuracyM: 5, timestamp: i * 1000,
  }));
  const parked = appendLiveFixes(start, jitter);
  assert.ok(parked.coordinates.length <= 2, `${parked.coordinates.length} points for a parked hour`);
  assert.deepEqual(parked.coordinates.at(-1), { latitude: jitter.at(-1)!.latitude, longitude: jitter.at(-1)!.longitude }, 'still ends at the newest fix');
  // Twelve hours on the move, a fix a second
  const moving = Array.from({ length: 12 * 3600 }, (_, s): GpsFix => ({
    latitude: 53.23 + (s * 27) / 111_320, longitude: -0.54, speedMs: s % 2 ? 20 : 30, accuracyM: 5, timestamp: s * 1000,
  }));
  let d = start;
  for (let i = 0; i < moving.length; i += 600) d = appendLiveFixes(d, moving.slice(i, i + 600));
  assert.ok(d.coordinates.length <= LIVE_ROUTE.maxPoints, `${d.coordinates.length} points`);
  assert.ok(d.speedSamples.length <= LIVE_ROUTE.maxSpeedSamples);
  assert.ok(Math.abs(d.speedSamples.reduce((a, b) => a + b, 0) / d.speedSamples.length - 90) < 1, 'average speed kept');
  assert.deepEqual(d.coordinates.at(-1), { latitude: moving.at(-1)!.latitude, longitude: moving.at(-1)!.longitude });
  // And what's drawn is bounded too
  const drawn = displayTrail(d.coordinates)!;
  assert.equal(drawn.length, TRAIL_DISPLAY.maxPoints);
  assert.deepEqual(drawn.slice(-TRAIL_DISPLAY.recentPoints), d.coordinates.slice(-TRAIL_DISPLAY.recentPoints), 'the recent stretch exactly');
  assert.deepEqual(drawn[0], d.coordinates[0]);
  const short = parked.coordinates;
  assert.equal(displayTrail(short), short, 'short routes untouched');
});

test('2 h 10 min drive, switching between screen and background: recording continues, visual work stops off screen, everything stays bounded', async () => {
  const store = new MemoryStore();
  const clock = { t: Date.parse('2026-10-09T17:00:00Z') };
  const timers = new FakeTimers();
  const updates = new FakeUpdates();
  const server = new FakeServer();
  const b = recoveryApp(store, clock, updates, server);
  await b.app.start();
  // AppContext's wiring: the live route through a feed, visible only when active
  const published: (ActiveDrive | null)[] = [];
  const feed = new LiveDriveFeed((d) => published.push(d), true);
  b.app.onDriveFix((fix) => feed.addFix(fix));
  await b.app.startDrive(null);
  feed.set(newLiveDrive(clock.t));
  await settle();
  // The Drive screen's visual side: gate, frame loop, camera writer, arrow, live head
  const gate = new VisualGate('active');
  const { cam, writer } = slowCamera(timers, () => 5 + Math.random() * 35); // a camera taking 5–40 ms a write
  const liveTrail = new LiveTrailHead();
  let markerSets = 0;
  let headDraws = 0;
  let writesOffScreen = 0;
  let maxPayload = 0;
  let publishesOffScreen = 0;
  gate.subscribe((n) => {
    feed.setVisible(n.live);
    if (n.live) writer.resume(); else writer.pause();
  });
  const frame = (s: number, ms: number) => {
    // wakeFrameLoop / the frame loop: nothing while not live
    if (!gate.current.live) { return; }
    const position = { latitude: 53.23 + (s * 27) / 111_320 + ms * 27e-3 / 111_320, longitude: -0.54 };
    markerSets++;
    const u = liveTrail.update(position, true, clock.t + ms);
    if (u.kind === 'draw') headDraws++;
    writer.submit({ center: position, heading: 10, pitch: 55, distance: 400, zoom: 17 });
  };
  let batch: GpsFix[] = [];
  for (let s = 1; s <= 130 * 60; s++) {
    // On screen for 10 minutes, then 10 minutes locked / in another app
    const onScreen = Math.floor(s / 600) % 2 === 0;
    if (onScreen !== gate.current.live) gate.update(onScreen ? 'active' : 'background');
    const beforeWrites = cam.writes;
    const beforePublishes = published.length;
    const fix: GpsFix = { latitude: 53.23 + (s * 27) / 111_320, longitude: -0.54 + Math.sin(s / 200) * 1e-3, speedMs: 27, accuracyM: 5, timestamp: clock.t + 1000 };
    batch.push(fix);
    if (batch.length === 5) { await b.tracker.deliver(batch); batch = []; }
    if (onScreen) b.app.addFix(fix);
    if (onScreen && published.length > beforePublishes) {
      // The screen's driveTrail effect: the live head starts from the route's newest point
      const route = published.at(-1)!.coordinates;
      liveTrail.followTrail(route);
      maxPayload = Math.max(maxPayload, JSON.stringify(trailFeatureCollection(displayTrail(route))).length);
    }
    // 60 frames in this second
    for (let f = 0; f < 60; f++) { frame(s, f * 16); timers.advance(16); clock.t += 16; }
    clock.t += 1000 - 960;
    timers.advance(40);
    if (!onScreen) {
      writesOffScreen += cam.writes - beforeWrites;
      publishesOffScreen += published.length - beforePublishes;
    }
    if (s % 60 === 0) await settle();
  }
  await settle();
  const rec = b.app.activeRecord!;
  const live = feed.current!;
  const report = {
    recordedPoints: rec.points.length, liveRoutePoints: live.coordinates.length, cameraWrites: cam.writes,
    cameraMaxOutstanding: cam.maxOutstanding, writerWaitingMax: 1, writesOffScreen, publishesOffScreen,
    maxTrailPayloadKB: Math.round(maxPayload / 1024), heldInFeed: feed.heldCount,
    cloudHeldFixes: (b.app as unknown as { heldFixes: unknown[] }).heldFixes.length,
    trackerHeld: (b.tracker as unknown as { held: unknown[] }).held.length,
    liveHeadTrace: (liveTrail as unknown as { trace: unknown[] }).trace.length,
    journalEntries: (await b.journal.read()).length, markerSets, headDraws,
  };
  console.log('2h10 drive bounds', JSON.stringify(report));
  // Recording carried on throughout, on screen or not
  assert.ok(rec.points.length > 2400, `${rec.points.length} recorded points`);
  assert.ok(Date.parse(rec.points.at(-1)!.recordedAt) >= clock.t - 10_000, 'recorded up to the end');
  // Nothing visual while off screen
  assert.equal(writesOffScreen, 0, 'no camera writes off screen');
  assert.equal(publishesOffScreen, 0, 'no route re-renders off screen');
  // Bounded
  assert.equal(cam.maxOutstanding, 1);
  assert.ok(writer.stats.waiting <= 1);
  assert.ok(live.coordinates.length <= LIVE_ROUTE.maxPoints);
  assert.ok(maxPayload < 200 * 1024, `trail payload ${maxPayload} bytes`);
  assert.ok(report.cloudHeldFixes === 0 && report.trackerHeld === 0);
  assert.ok(report.liveHeadTrace <= LIVE_TRAIL.maxTracePoints);
  assert.ok(report.journalEntries <= 400);
  // Camera writes were at a visual rate while on screen: ~65 on-screen minutes at most ~60 a second
  assert.ok(cam.writes <= 65 * 60 * 61, `${cam.writes} camera writes`);
  b.app.dispose();
});

test('back on screen after a background spell: the route arrives in one update and the camera resumes with no burst', () => {
  const timers = new FakeTimers();
  const { cam, writer } = slowCamera(timers, () => 10);
  const gate = new VisualGate('active');
  const published: (ActiveDrive | null)[] = [];
  const feed = new LiveDriveFeed((d) => published.push(d), true);
  feed.set(newLiveDrive(0));
  gate.subscribe((n) => { feed.setVisible(n.live); if (n.live) writer.resume(); else writer.pause(); });
  for (let i = 0; i < 100; i++) { writer.submit(poseAt(i)); timers.advance(16); }
  const writesBefore = cam.writes;
  gate.update('background');
  // 20 minutes away: the frame loop is stopped (nothing submitted); fixes keep arriving
  for (let s = 0; s < 1200; s++) {
    feed.addFix({ latitude: 53.23 + s * 1e-4, longitude: -0.54, speedMs: 20, accuracyM: 5, timestamp: s * 1000 });
    timers.advance(1000);
  }
  assert.equal(cam.writes, writesBefore, 'nothing written while away');
  const publishedBefore = published.length;
  gate.update('active');
  assert.equal(published.length, publishedBefore + 1, 'the route catches up in one update');
  assert.equal(published.at(-1)!.coordinates.length, 1200);
  // The first frames back: one write at a time, at the frame rate, no backlog to work through
  for (let i = 0; i < 60; i++) { writer.submit(poseAt(10_000 + i)); timers.advance(16); }
  assert.ok(cam.writes - writesBefore <= 61, `${cam.writes - writesBefore} writes in the first second back`);
  assert.equal(cam.maxOutstanding, 1);
});

test('the crash fixes are wired in: no per-frame Mapbox command, nothing visual off screen, background launches build no map', () => {
  const map = readFileSync(join(MOBILE, 'components/MapboxDriveMap.tsx'), 'utf8');
  const screen = readFileSync(join(MOBILE, 'app/(tabs)/(drive)/index.tsx'), 'utf8');
  const ctx = readFileSync(join(MOBILE, 'context/AppContext.tsx'), 'utf8');
  // Mapbox: the follow camera goes through the writer into the Camera's props, never setCamera
  assert.ok(!/setCamera\(mapboxFollowCamera/.test(map), 'no promise-returning camera command per frame');
  assert.match(map, /setFollowCamera\(pose\) \{\s*cameraWriter\.submit\(pose\);/);
  assert.match(map, /<Camera ref=\{cameraRef\} defaultSettings=\{defaultSettings\} \{\.\.\.stop\} \/>/);
  assert.match(map, /useLayoutEffect\(\(\) => \{\s*const applied = appliedRef\.current;/);
  assert.match(map, /if \(live\) cameraWriter\.resume\(\);\s*else cameraWriter\.pause\(\);/);
  assert.match(map, /if \(liveRef\.current\) markerRef\.current\?\.set\(pose\);/);
  assert.match(map, /trailFeatureCollection\(displayTrail\(trail\)\)/);
  // The Drive screen: the frame loop and everything it drives only while live
  assert.match(screen, /if \(frameIdRef\.current != null \|\| !visualsLiveRef\.current\) return;/);
  assert.match(screen, /frameLoopRef\.current = \(\) => \{\s*frameIdRef\.current = null;[^]*?if \(!visualsLiveRef\.current\) return;/);
  assert.match(screen, /if \(prev\.live && !next\.live\) \{\s*if \(frameIdRef\.current != null\) cancelAnimationFrame\(frameIdRef\.current\);\s*frameIdRef\.current = null;\s*mapboxRef\.current\?\.setVisualsLive\(false\);/);
  assert.match(screen, /followCamera\.enter\(false, \{\}, followTargetFor\(position\)\)/, 'back on screen: the camera starts at the current target');
  assert.match(screen, /if \(isDriving && !isPaused && visuals\.live\) \{\s*driveTimerRef\.current = setInterval\(tick, 1000\);/);
  assert.match(screen, /Platform\.OS !== "web" && !visuals\.mounted \? \(/, 'no map until the app has been on screen');
  // AppContext: the live route is held off screen; recording is untouched
  assert.match(ctx, /cloud\.onDriveFix\(\(fix\) => \{ latestFixRef\.current = fix; liveFeed\.addFix\(fix\); \}\)/);
  assert.match(ctx, /liveFeed\.setVisible\(state === 'active'\);/);
  assert.match(ctx, /new LiveDriveFeed\(setCurrentDrive, AppState\.currentState === 'active'\)/);
});

test('a background relaunch by iOS: no map, no frame loop, no camera writes, and the background fixes are still recorded', async () => {
  const store = new MemoryStore();
  const clock = { t: Date.parse('2026-10-09T17:00:00Z') };
  const updates = new FakeUpdates();
  const server = new FakeServer();
  // A drive in progress when iOS ended the app
  const first = recoveryApp(store, clock, updates, server);
  await first.app.start();
  await first.app.startDrive(null);
  await settle();
  await longDrive(first, 0, 10 * 60);
  first.app.dispose();
  // iOS relaunches it in the background to deliver locations
  clock.t += 60_000;
  const gate = new VisualGate('background');
  const timers = new FakeTimers();
  const { cam, writer } = slowCamera(timers, () => 10);
  const published: (ActiveDrive | null)[] = [];
  const feed = new LiveDriveFeed((d) => published.push(d), false);
  const again = recoveryApp(store, clock, updates, server, first.journal);
  again.app.onDriveFix((fix) => feed.addFix(fix));
  await again.app.start();
  feed.update((prev) => (again.app.activeRecord ? prev ?? liveDriveFromRecord(again.app.activeRecord) : null));
  let frames = 0;
  const wake = () => { if (gate.current.live) { frames++; writer.submit(poseAt(frames)); } };
  const pointsBefore = again.app.activeRecord!.points.length;
  for (let s = 601; s <= 900; s += 5) {
    const batch = [];
    for (let k = 0; k < 5; k++) { clock.t += 1000; batch.push(aRoadFix(s + k, clock.t)); }
    await again.tracker.deliver(batch);
    wake(); // the screen's trail effect would wake the frame loop
    timers.advance(5000);
  }
  assert.equal(gate.current.mounted, false, 'the map is never created');
  assert.equal(frames, 0, 'no frame loop');
  assert.equal(cam.writes, 0, 'no camera writes');
  assert.equal(published.length, 1, 'only the drive picked up, no per-fix re-renders');
  assert.ok(again.app.activeRecord!.points.length > pointsBefore + 80, 'background fixes recorded');
  assert.equal(again.app.isDriving, true);
  // The user opens the app: the map is created and visuals start, from now
  gate.update('active');
  feed.setVisible(true);
  assert.equal(gate.current.mounted, true);
  wake();
  timers.advance(20);
  assert.equal(cam.writes, 1);
  assert.equal(published.length, 2, 'the route caught up in one update');
  again.app.dispose();
});

// ─── Diagnostics: viewing, sharing and clearing the journal ──────────────────

import { buildDiagnosticsReport, redactDiagnostics, type DiagnosticsState } from '@/lib/backend/diagnosticsReport';

const diagApp = { name: 'Derwent', version: '1.0.0', build: '22', bundleId: 'uk.co.starscale.drive.staging', platform: 'ios', osVersion: '27.0' };

test('the diagnostics report: version, build, time, drive state, orphan candidates and the journal', async () => {
  const journal = new DiagnosticsJournal({ store: new MemoryStore(), now: () => Date.parse('2026-10-09T08:00:00Z') });
  journal.log('launch', { appState: 'background', platform: 'ios' });
  journal.log('recovery_finish', { clientRef: 'drive-7', serverId: 'srv-7', reason: 'quiet', pointCount: 1960, drivenS: 5880, kept: true });
  const state: DiagnosticsState = {
    driveInProgress: null, pendingDrives: 1, unsettled: false,
    orphans: [{ serverId: 'lost', clientRef: 'lost-ref', name: 'Active Journey', startedAt: '2026-10-06T19:30:00.000Z',
      firstPointAt: '2026-10-06T19:30:00.000Z', lastPointAt: '2026-10-06T21:09:57.000Z', pointCount: 2000, spanS: 5997, quietH: 46.3, outcome: 'candidate' }],
  };
  const report = buildDiagnosticsReport({ app: diagApp, generatedAt: new Date('2026-10-09T08:05:00Z'), state, entries: await journal.read() });
  const lines = report.split('\n');
  assert.equal(lines[0], 'Derwent diagnostics');
  assert.equal(lines[1], 'Generated: 2026-10-09T08:05:00.000Z');
  assert.equal(lines[2], 'App: Derwent 1.0.0 (build 22) uk.co.starscale.drive.staging');
  assert.equal(lines[3], 'Device: ios 27.0');
  assert.match(report, /Drives waiting to upload: 1/);
  assert.match(report, /^ {2}candidate serverId=lost clientRef=lost-ref name="Active Journey" started=2026-10-06T19:30:00\.000Z firstPoint=2026-10-06T19:30:00\.000Z lastPoint=2026-10-06T21:09:57\.000Z points=2000 spanS=5997 quietH=46\.3$/m);
  assert.match(report, /Journal \(2 entries, oldest first\)/);
  assert.match(report, /^2026-10-09T08:00:00\.000Z recovery_finish clientRef="drive-7" serverId="srv-7" reason="quiet" pointCount=1960 drivenS=5880 kept=true$/m);
  // Before any orphan check, and with none found
  assert.match(buildDiagnosticsReport({ app: diagApp, generatedAt: new Date(), state: { ...state, orphans: null }, entries: [] }), /Not checked yet this session/);
  assert.match(buildDiagnosticsReport({ app: diagApp, generatedAt: new Date(), state: { ...state, orphans: [] }, entries: [] }), /None found\./);
});

test('the diagnostics report never carries coordinates, tokens, keys, passwords or email addresses', async () => {
  const journal = new DiagnosticsJournal({ store: new MemoryStore(), now: () => 0 });
  // Things that must never get through, even inside an error message
  journal.log('storage_write_failed', {
    error: 'failed at 53.2312345,-0.5412345 for dan@example.com with Bearer abc.def.ghi password=hunter2 token: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig',
    // Assembled at run time so the repository's secret scan doesn't flag this fake key
    key: ['sb', 'secret', 'ABCDEFGH12345678'].join('_'),
  });
  // Fields named like a location or sign-in data are dropped (the journal drops location fields itself)
  const entries = [...await journal.read(), { t: '2026-10-09T08:00:00.000Z', event: 'odd', email: 'a@b.co', access_token: 'x', password: 'y', latitude: 53.2312345, route: 'r', ok: 1 }];
  const report = buildDiagnosticsReport({ app: diagApp, generatedAt: new Date(0), state: { driveInProgress: null, pendingDrives: 0, unsettled: false, orphans: null }, entries });
  for (const leak of ['53.2312345', '0.5412345', 'dan@example.com', 'a@b.co', 'hunter2', 'eyJhbGciOi', 'abc.def.ghi', 'sb_secret_ABCDEFGH', 'access_token=', 'latitude=', 'route=']) {
    assert.ok(!report.includes(leak), `report contains ${leak}`);
  }
  assert.match(report, /\[number\],\[number\]/);
  assert.match(report, /\[email\]/);
  assert.match(report, /password=\[redacted\]/);
  assert.match(report, /odd ok=1$/m);
  // Ordinary figures are untouched
  assert.equal(redactDiagnostics('quietH=46.3 spanS=5997 t=2026-10-09T08:00:00.000Z'), 'quietH=46.3 spanS=5997 t=2026-10-09T08:00:00.000Z');
});

test('clearing diagnostics empties the journal on the device and notes when it was cleared', async () => {
  const store = new MemoryStore();
  const journal = new DiagnosticsJournal({ store, now: () => Date.parse('2026-10-09T09:00:00Z') });
  for (let i = 0; i < 50; i++) journal.log('tick', { i });
  await journal.flush();
  await journal.clear();
  assert.deepEqual((await journal.read()).map((e) => e.event), ['journal_cleared']);
  const reopened = new DiagnosticsJournal({ store });
  assert.deepEqual((await reopened.read()).map((e) => e.event), ['journal_cleared'], 'cleared on the device too');
  // Logging carries on afterwards
  journal.log('launch', { appState: 'active' });
  await journal.flush();
  assert.deepEqual((await new DiagnosticsJournal({ store }).read()).map((e) => e.event), ['journal_cleared', 'launch']);
  // Even if saving fails right then, the old journal is gone from the device
  const full = new MemoryStore();
  const before = new DiagnosticsJournal({ store: full });
  for (let i = 0; i < 20; i++) before.log('old', { i });
  await before.flush();
  const failingWrites = { getItem: (k: string) => full.getItem(k), setItem: async () => { throw new Error('disk full'); }, removeItem: (k: string) => full.removeItem(k) };
  await new DiagnosticsJournal({ store: failingWrites }).clear();
  assert.deepEqual(await new DiagnosticsJournal({ store: full }).read(), [], 'no old entries left on the device');
});

test('a real drive, crash and orphan check produce a report with the candidate and no route in it', async () => {
  const clock = { t: Date.parse('2026-10-08T12:00:00Z') };
  const server = new FakeServer();
  const old = clock.t - 2 * 24 * 3600_000;
  server.journeys.push({ id: 'lost', clientRef: 'lost-ref', status: 'active', startedAt: new Date(old).toISOString(), name: 'Active Journey', route: null } as unknown as ServerJourney);
  server.pointTimes.set('lost', new Set(Array.from({ length: 2000 }, (_, i) => new Date(old + i * 3000).toISOString())));
  const b = recoveryApp(new MemoryStore(), clock, undefined, server);
  await b.app.start();
  await b.app.startDrive(null);
  await settle();
  await longDrive(b, 0, 10 * 60);
  await b.app.endDrive();
  await b.app.sync(); // uploads the drive; the orphan check reports 'lost'
  const state: DiagnosticsState = {
    driveInProgress: b.app.activeRecord?.clientRef ?? null, pendingDrives: b.app.status.pendingJourneys, unsettled: b.app.unsettled,
    orphans: b.app.orphanCheckedAt != null ? b.app.orphanJourneys : null,
  };
  const report = buildDiagnosticsReport({ app: diagApp, generatedAt: new Date(clock.t), state, entries: await b.journal.read() });
  assert.match(report, /candidate serverId=lost clientRef=lost-ref/);
  assert.match(report, /drive_start clientRef=/);
  assert.match(report, /orphan_found .*serverId="lost".*outcome="candidate"/);
  assert.ok(!/53\.2\d|-0\.5\d|0\.54\d/.test(report), 'no coordinates from the drive');
  b.app.dispose();
});

test('the Diagnostics option: Settings → Help & Support, with view, share sheet and a confirmed clear', () => {
  const settings = readFileSync(join(MOBILE, 'app/settings.tsx'), 'utf8');
  const screen = readFileSync(join(MOBILE, 'app/diagnostics.tsx'), 'utf8');
  const layout = readFileSync(join(MOBILE, 'app/_layout.tsx'), 'utf8');
  const help = settings.slice(settings.indexOf('section === "help"'), settings.indexOf('section === "legal"'));
  assert.match(help, /<Text style=\{s\.title\}>Diagnostics<\/Text>/);
  assert.match(help, /router\.push\("\/diagnostics"\)/);
  assert.match(help, /View & Share Diagnostics/);
  assert.match(layout, /<Stack\.Screen name="diagnostics"/);
  // Viewing: the report, as selectable text
  assert.match(screen, /buildDiagnosticsReport\(\{\s*app: appInfo\(\),\s*generatedAt: new Date\(\),\s*state: diagnosticsState\(\),\s*entries,/);
  assert.match(screen, /<Text style=\{s\.report\} selectable>/);
  // Sharing: the native share sheet, nothing else
  assert.match(screen, /Share\.share\(\{ message: report, title: `\$\{APP_NAME\} diagnostics` \}\)/);
  // Clearing: only after confirming
  assert.match(screen, /Alert\.alert\(\s*"Clear diagnostics\?",[^]*style: "destructive",\s*onPress: \(\) => \{\s*void journal\.clear\(\)\.then\(refresh\);/);
  // The installed binary's build number
  assert.match(screen, /Constants\.platform\?\.ios\?\.buildNumber/);
  // No crash/analytics SDK
  const pkg = readFileSync(join(MOBILE, 'package.json'), 'utf8');
  assert.ok(!/sentry|bugsnag|crashlytics|firebase|amplitude|mixpanel|segment/i.test(pkg));
});

// ─── Phase 4B: friends' live positions on the Drive map ─────────────────────
import {
  FriendSelection, MIN_HEADING_SPEED_KMH, STALE_AFTER_MS, buildMarkerModels, formatSpeed as formatFriendSpeed, sameMarker,
  shouldTween, statusLine, tweenPoint, updatedAgo, usableHeading, type SharerIdentity,
} from '@/lib/liveMap';

const MAP_NOW = Date.parse('2026-10-08T10:00:30.000Z');
const ana = (over: Record<string, unknown> = {}) => ({
  type: 'live_location', userId: 'ana', latitude: 54.5, longitude: -2.9, headingDeg: 90, speedKmh: 67.6, accuracyM: 5,
  driving: true, recordedAt: '2026-10-08T10:00:26.000Z', expiresAt: '2026-10-08T10:03:26.000Z', ...over,
});
const WHO = new Map<string, SharerIdentity>([['ana', { name: 'Ana Driver', initials: 'AD', avatarUrl: null }]]);
/** The map's view of a store: exactly what the layer renders. */
const markersOf = (store: LiveLocationStore, now = MAP_NOW) => buildMarkerModels(store.list, WHO, now);
const mapStore = () => new LiveLocationStore({ now: () => MAP_NOW, setTimeout: () => 0, clearTimeout: () => {} });

test('friend map: an authorised shared position produces exactly one marker; revoked or expired ones produce none', () => {
  const store = mapStore();
  assert.deepEqual(markersOf(store), [], 'nothing shared: no markers');
  store.apply(parseLiveLocationEvent(ana())!);
  const [m, ...rest] = markersOf(store);
  assert.equal(rest.length, 0);
  assert.equal(m!.userId, 'ana');
  assert.equal(m!.name, 'Ana Driver');
  assert.deepEqual([m!.latitude, m!.longitude], [54.5, -2.9]);
  // Duplicate and repeated updates never make a second marker
  store.apply(parseLiveLocationEvent(ana({ latitude: 54.51, recordedAt: '2026-10-08T10:00:28.000Z', expiresAt: '2026-10-08T10:03:28.000Z' }))!);
  store.apply(parseLiveLocationEvent(ana({ latitude: 54.51, recordedAt: '2026-10-08T10:00:28.000Z', expiresAt: '2026-10-08T10:03:28.000Z' }))!);
  assert.equal(markersOf(store).length, 1, 'one marker per person');
  assert.equal(markersOf(store)[0]!.latitude, 54.51, 'moved to the newest position');
  assert.equal(buildMarkerModels([...store.list, ...store.list], WHO, MAP_NOW).length, 1, 'even if a list repeats someone');
  // Revoked (live_location_hidden): gone at once
  store.apply({ type: 'live_location_hidden', userId: 'ana' });
  assert.deepEqual(markersOf(store), [], 'revoked: marker removed');
  // Expired: gone when the store drops it (no server message needed)
  const clock = { t: MAP_NOW };
  const timed = new LiveLocationStore({ now: () => clock.t, setTimeout: () => 0, clearTimeout: () => {} });
  timed.apply(parseLiveLocationEvent(ana())!);
  clock.t += 3 * 60_000 + 1;
  timed.prune();
  assert.deepEqual(markersOf(timed, clock.t), [], 'expired: marker removed');
  // Sharing stopped / block / unfriend all arrive as a removal or a snapshot without them
  timed.replaceAll([ana()]);
  timed.replaceAll([]);
  assert.deepEqual(markersOf(timed), [], 'a snapshot without them removes the marker');
});

test('friend map: only shared positions are drawn — never other friends, Convoy members or anyone else', () => {
  const store = mapStore();
  const everyone = new Map<string, SharerIdentity>([
    ['ana', { name: 'Ana', initials: 'A' }], ['ben', { name: 'Ben (friend, not sharing)', initials: 'B' }],
    ['cat', { name: 'Cat (Convoy, not sharing)', initials: 'C' }],
  ]);
  store.apply(parseLiveLocationEvent(ana())!);
  assert.deepEqual(buildMarkerModels(store.list, everyone, MAP_NOW).map((m) => m.userId), ['ana'],
    'knowing someone gives them no marker; only a shared position does');
  // Someone sharing through a Convoy whose name isn't known yet is still only what was shared
  store.apply(parseLiveLocationEvent(ana({ userId: 'dee' }))!);
  const dee = buildMarkerModels(store.list, WHO, MAP_NOW).find((m) => m.userId === 'dee')!;
  assert.equal(dee.name, 'Convoy member', 'no lookup by id: a neutral label until the Convoy roster loads');
  // Malformed entries are skipped, not drawn somewhere wrong
  assert.equal(buildMarkerModels([{ ...ana(), latitude: Number.NaN } as never], WHO, MAP_NOW).length, 0);
});

test('friend map: stationary vs driving, heading only when it means something', () => {
  const store = mapStore();
  store.apply(parseLiveLocationEvent(ana({ driving: false, headingDeg: 90, speedKmh: 0 }))!);
  let m = markersOf(store)[0]!;
  assert.equal(m.mode, 'stationary');
  assert.equal(m.headingDeg, null, 'a stationary marker is never rotated');
  store.apply(parseLiveLocationEvent(ana({ recordedAt: '2026-10-08T10:00:27.000Z', expiresAt: '2026-10-08T10:03:27.000Z' }))!);
  m = markersOf(store)[0]!;
  assert.equal(m.mode, 'driving');
  assert.equal(m.headingDeg, 90, 'driving and moving: rotated to the reported heading');
  assert.equal(usableHeading({ driving: true, headingDeg: null, speedKmh: 50 }), null, 'missing heading: no rotation (car badge instead)');
  assert.equal(usableHeading({ driving: true, headingDeg: -1, speedKmh: 50 }), null, 'invalid heading');
  assert.equal(usableHeading({ driving: true, headingDeg: Number.NaN, speedKmh: 50 }), null);
  assert.equal(usableHeading({ driving: true, headingDeg: 400, speedKmh: 50 }), 40, 'normalised into 0–360');
  assert.equal(usableHeading({ driving: true, headingDeg: 180, speedKmh: MIN_HEADING_SPEED_KMH - 1 }), null,
    'crawling or stopped mid-drive: the GPS course is noise, not shown');
  assert.equal(usableHeading({ driving: true, headingDeg: 180, speedKmh: null }), 180, 'unknown speed: trust the heading');
});

test('friend map: speed in mph (or km/h when chosen); unknown speed is omitted, never shown as 0', () => {
  assert.equal(formatFriendSpeed(67.6, 'imperial'), '42 mph');
  assert.equal(formatFriendSpeed(67.6, 'metric'), '68 km/h');
  assert.equal(formatFriendSpeed(null, 'imperial'), null);
  assert.equal(formatFriendSpeed(-1, 'imperial'), null);
  assert.equal(formatFriendSpeed(0, 'imperial'), '0 mph', 'a reported 0 is a real standstill');
  assert.equal(statusLine({ mode: 'driving', speedKmh: 67.6 }, 'imperial'), 'Driving · 42 mph');
  assert.equal(statusLine({ mode: 'driving', speedKmh: null }, 'imperial'), 'Driving', 'speed unavailable: omitted');
  assert.equal(statusLine({ mode: 'stationary', speedKmh: 0 }, 'imperial'), 'Stationary');
  assert.equal(updatedAgo(MAP_NOW - 4_000, MAP_NOW), 'Updated 4s ago');
  assert.equal(updatedAgo(MAP_NOW - 130_000, MAP_NOW), 'Updated 2 min ago');
  assert.equal(updatedAgo(MAP_NOW + 2_000, MAP_NOW), 'Updated 0s ago', 'a phone clock slightly behind never shows the future');
  // Faded once old, still drawn until it expires
  const store = mapStore();
  store.apply(parseLiveLocationEvent(ana())!);
  assert.equal(markersOf(store)[0]!.stale, false);
  assert.equal(markersOf(store, Date.parse('2026-10-08T10:00:26.000Z') + STALE_AFTER_MS + 1)[0]!.stale, true);
});

test('friend map: tapping a marker selects that friend; markers glide between updates without snapping', () => {
  const sel = new FriendSelection();
  let changes = 0;
  sel.subscribe(() => { changes++; });
  const store = mapStore();
  store.apply(parseLiveLocationEvent(ana())!);
  store.apply(parseLiveLocationEvent(ana({ userId: 'dee' }))!);
  const tapped = markersOf(store).find((m) => m.userId === 'dee')!;
  sel.select(tapped.userId);
  assert.equal(sel.current, 'dee', 'the card shows the tapped friend');
  sel.select('dee');
  assert.equal(changes, 1, 'tapping again changes nothing');
  sel.select(null);
  assert.equal(sel.current, null);
  // Movement
  const a = { latitude: 54.5, longitude: -2.9 };
  const b = { latitude: 54.5009, longitude: -2.9 }; // ~100 m
  assert.equal(shouldTween(null, b), false, 'first placement: at once');
  assert.equal(shouldTween(a, b), true, 'a normal update: glided');
  assert.equal(shouldTween(a, { latitude: 54.6, longitude: -2.9 }), false, 'a big jump: placed at once');
  assert.deepEqual(tweenPoint(a, b, 0), a);
  assert.deepEqual(tweenPoint(a, b, 1), b);
  const mid = tweenPoint(a, b, 0.5);
  assert.ok(mid.latitude > a.latitude && mid.latitude < b.latitude);
  // An unchanged marker isn't redrawn when the list is rebuilt
  const [m1] = markersOf(store);
  const [m2] = markersOf(store);
  assert.notEqual(m1, m2);
  assert.ok(sameMarker(m1!, m2!), 'same position and look: memoised, not redrawn');
});

test('friend map: live updates never touch drive recording', async () => {
  const clock = { t: Date.now() };
  const cloud = makeSync(new FakeServer(), new MemoryStore(), clock);
  await cloud.start();
  await cloud.startDrive(null);
  for (let i = 0; i < 20; i++) {
    clock.t += 1000;
    cloud.addFix({ latitude: 54.5 + i * 0.0003, longitude: -2.9, speedMs: 13, headingDeg: 0, accuracyM: 5, timestamp: clock.t });
  }
  const before = JSON.stringify({ points: cloud.activeRecord!.points, drive: cloud.driveState });
  const store = mapStore();
  for (let i = 0; i < 50; i++) {
    store.apply(parseLiveLocationEvent(ana({ userId: `f${i % 20}`, latitude: 54 + i / 1000 }))!);
    markersOf(store);
  }
  store.apply({ type: 'live_location_hidden', userId: 'f1' });
  store.clear();
  assert.equal(JSON.stringify({ points: cloud.activeRecord!.points, drive: cloud.driveState }), before,
    'the recorder, its points and the drive state are unchanged');
  cloud.dispose();
});

test('friend map: 20 sharers build quickly and stay one marker each', () => {
  const store = mapStore();
  const t0 = performance.now();
  for (let round = 0; round < 30; round++) {
    for (let i = 0; i < 20; i++) {
      const sec = String(26 + round).padStart(2, '0');
      store.apply(parseLiveLocationEvent(ana({
        userId: `f${i}`, latitude: 54 + i / 100 + round / 10_000,
        recordedAt: `2026-10-08T10:00:${sec}.000Z`, expiresAt: `2026-10-08T10:03:${sec}.000Z`,
      }))!);
    }
    assert.equal(markersOf(store).length, 20);
  }
  const ms = performance.now() - t0;
  assert.ok(ms < 250, `600 updates and 30 rebuilds of 20 markers took ${ms.toFixed(1)} ms`);
});

// ─── Mapbox location arrow: flat on the map; never the native puck ─────────
//
// On Mapbox the Derwent arrow is a symbol layer pitched and turned with the
// map (the first Mapbox build's flat look, with its artwork), not a
// screen-upright view annotation (which looked stood up on the tilted map).
// Mapbox's location component is never switched on: its puck shows the
// default blue puck until a custom image has loaded.
import { LOCATION_ARROW_SYMBOL, locationArrowFeature } from '@/lib/mapbox';

test('the Mapbox arrow lies flat on the map and turns with it', () => {
  assert.equal(LOCATION_ARROW_SYMBOL.iconPitchAlignment, 'map');
  assert.equal(LOCATION_ARROW_SYMBOL.iconRotationAlignment, 'map');
  assert.deepEqual(LOCATION_ARROW_SYMBOL.iconRotate, ['get', 'heading']);
  assert.equal(LOCATION_ARROW_SYMBOL.iconAllowOverlap, true);
  assert.equal(LOCATION_ARROW_SYMBOL.iconIgnorePlacement, true);
  // Heading from north, as the feature's own property; position as [lng, lat]
  const f = locationArrowFeature({ latitude: 53.2, longitude: -0.54 }, 87.5);
  assert.deepEqual(f.features[0]!.geometry.coordinates, [-0.54, 53.2]);
  assert.equal(f.features[0]!.properties.heading, 87.5);
  assert.equal(locationArrowFeature({ latitude: 1, longitude: 2 }, -90).features[0]!.properties.heading, 270);
  assert.equal(locationArrowFeature({ latitude: 1, longitude: 2 }, 725).features[0]!.properties.heading, 5);
  assert.equal(locationArrowFeature({ latitude: 1, longitude: 2 }, NaN).features[0]!.properties.heading, 0);
  // No position: nothing drawn (never a placeholder spot)
  assert.equal(locationArrowFeature(null, 10).features.length, 0);
  assert.equal(locationArrowFeature({ latitude: NaN, longitude: 2 }, 10).features.length, 0);
});

test('the Mapbox Drive map draws the arrow as flat symbol layers from the drawn heading', () => {
  const read = (rel: string) => readFileSync(toPath(new URL(rel, import.meta.url)), 'utf8');
  const strip = (t: string) => t.replace(/\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
  const map = strip(read('../components/MapboxDriveMap.tsx'));
  const screen = strip(read('../app/(tabs)/(drive)/index.tsx'));
  // The first Mapbox build's artwork, registered with the map
  assert.match(map, /<Images images=\{ARROW_IMAGES\} \/>/);
  assert.match(map, /"derwent-location-arrow": require\("@\/assets\/images\/map\/puck-arrow\.png"\)/);
  assert.match(map, /"derwent-location-arrow-shadow": require\("@\/assets\/images\/map\/puck-shadow\.png"\)/);
  // Shadow then arrow, both with the flat style, from the arrow's own source
  const feeder = map.slice(map.indexOf('const MarkerFeeder'), map.indexOf('const FollowCamera'));
  assert.match(feeder, /locationArrowFeature\(pose\.position, pose\.heading\)/);
  const source = feeder.search(/<ShapeSource id="derwent-location-arrow"/);
  const shadow = feeder.search(/<SymbolLayer\s+id="derwent-location-arrow-shadow"/);
  const arrow = feeder.search(/<SymbolLayer\s+id="derwent-location-arrow"\s/);
  assert.ok(source >= 0 && shadow > source);
  assert.ok(shadow > 0 && arrow > shadow);
  assert.equal(feeder.match(/\.\.\.LOCATION_ARROW_SYMBOL/g)?.length, 2);
  // Mounted after the trail and its head, so it draws above both
  const body = map.slice(map.search(/<MapView\s+ref=/));
  assert.ok(body.indexOf('<MarkerFeeder') > body.indexOf('id="derwent-drive-trail"'));
  assert.ok(body.indexOf('<MarkerFeeder') > body.indexOf('<TrailHeadLayers'));
  // Turned by the heading the frame loop draws (from north), not against the
  // camera: re-sent when either the position or the heading moves
  assert.match(screen, /moved \|\| mapboxArrowHeadingRef\.current !== drawnHeadingRef\.current/);
  assert.match(screen, /mapboxRef\.current\?\.setMarker\(position, drawnHeadingRef\.current\)/);
  assert.match(screen, /mapboxRef\.current\?\.setMarker\(coord, drawnHeadingRef\.current\)/);
  // No screen-space perspective faking on Mapbox: the tilted LocationArrow is
  // only inside the Apple Maps marker
  assert.equal(screen.match(/<LocationArrow\b/g)?.length, 1);
  assert.ok(screen.indexOf('<LocationArrow') > screen.indexOf('const UserMarker'));
  assert.ok(screen.indexOf('<LocationArrow') < screen.indexOf('const LiveTrailHeadLines'));
});

test('nothing on the Drive screen can show a native location puck', () => {
  const read = (rel: string) => readFileSync(toPath(new URL(rel, import.meta.url)), 'utf8');
  const strip = (t: string) => t.replace(/\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  // Every app file that uses Mapbox
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(join(MOBILE, dir))) {
      const rel = join(dir, name);
      if (statSync(join(MOBILE, rel)).isDirectory()) walk(rel);
      else if (/\.(tsx?|jsx?)$/.test(name)) files.push(rel);
    }
  };
  for (const dir of ['app', 'components', 'lib', 'hooks', 'context']) walk(dir);
  const mapboxFiles = files.filter((f) => readFileSync(join(MOBILE, f), 'utf8').includes('@rnmapbox/maps'));
  assert.ok(mapboxFiles.some((f) => f.endsWith('MapboxDriveMap.tsx')));
  for (const f of mapboxFiles) {
    const code = strip(readFileSync(join(MOBILE, f), 'utf8'));
    // Mapbox's location component: the puck (blue by default), the user
    // location layer, the heading indicator, a location provider, the
    // viewport's follow-puck state, and camera tracking of the user
    assert.ok(
      !/\b(LocationPuck|UserLocation|NativeUserLocation|CustomLocationProvider|HeadingIndicator|Viewport|followUserLocation|followUserMode|puckBearing|showUserLocation|showUserHeading)\b/.test(code),
      `${f} could switch on Mapbox's location puck`,
    );
  }
  // The Apple Maps fallback: its own blue dot off, no user tracking
  const screen = strip(read('../app/(tabs)/(drive)/index.tsx'));
  assert.equal(screen.match(/showsUserLocation=\{false\}/g)?.length, 1);
  assert.ok(!/showsUserLocation(?!=\{false\})|followsUserLocation|showsMyLocationButton|userTrackingMode/.test(screen));
  // And nowhere else in the app
  for (const f of files) {
    if (f.endsWith(join('(drive)', 'index.tsx'))) continue;
    assert.ok(!/showsUserLocation|followsUserLocation/.test(strip(readFileSync(join(MOBILE, f), 'utf8'))), `${f} shows a location dot`);
  }
});

// ─── Drive Complete ──────────────────────────────────────────────────────────

import { routeBounds } from '@/lib/mapbox';

test('the completed route is fitted by its own bounds; a drive that never moved still gets an area', () => {
  assert.equal(routeBounds([]), null);
  assert.equal(routeBounds(null), null);
  const b = routeBounds([
    { latitude: 54.6, longitude: -3.2 },
    { latitude: 54.5, longitude: -3.0 },
    { latitude: Number.NaN, longitude: 0 },
  ])!;
  assert.deepEqual(b, { ne: [-3.0, 54.6], sw: [-3.2, 54.5] });
  const still = routeBounds([{ latitude: 54.6, longitude: -3.2 }])!;
  assert.ok(still.ne[0] > still.sw[0] && still.ne[1] > still.sw[1]);
  assert.ok(Math.abs(still.ne[1] - still.sw[1] - 0.002) < 1e-9);
});

test('Drive Complete: real data, one visibility of three, Save sends it, Discard confirms first', () => {
  const read = (rel: string) => readFileSync(toPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
  const screen = read('app/drive-summary.tsx');
  const view = read('components/driveComplete/DriveCompleteView.tsx');
  const picker = read('components/driveComplete/VisibilityPicker.tsx');
  const card = read('components/driveComplete/RouteMapCard.tsx');
  // The drive is saved once, when the screen opens, as before
  assert.equal(screen.match(/await endDrive\(\)/g)?.length, 1);
  // The journey's own visibility values, and nothing else
  assert.deepEqual([...picker.matchAll(/value: "(\w+)"/g)].map((m) => m[1]), ['private', 'friends', 'public']);
  assert.ok(/accessibilityRole="radiogroup"/.test(picker) && /accessibilityRole="radio"/.test(picker));
  // Save sends the choice with the journey; Discard deletes only after a confirmation
  assert.ok(/updateJourney\(journey\.id, \{ privacy: visibility \}\)/.test(screen));
  const discard = screen.slice(screen.indexOf('function handleDiscard'));
  assert.ok(discard.indexOf('confirmDiscard(') < discard.indexOf('deleteJourney('), 'deletes only inside the confirmation');
  assert.ok(/style: 'destructive', onPress: onConfirm/.test(screen));
  // Exactly the four stats, from the drive (no sample figures)
  assert.deepEqual([...view.matchAll(/label: '([^']+)'/g)].map((m) => m[1]), ['Distance', 'Duration', 'Avg. Speed', 'Max Speed']);
  assert.ok(!/42\.7|1h 18m|32 mph|78 mph/.test(view + screen));
  // The route is the recorded one, on the existing Mapbox setup (no second map library)
  assert.ok(/routeCoordinates/.test(screen) && /DRIVE_MAPBOX/.test(card));
  assert.ok(!/react-native-maps/.test(card + read('components/driveComplete/RouteMapMapbox.tsx')));
});

import { dayStreak, firstNameOf, levelProgress } from '@/lib/driveRewards';

test('Drive Complete rewards: level progress from the profile, day streak from drives, real first name only', () => {
  // 11,580 XP: 580 into level 12, 420 to go
  assert.deepEqual(levelProgress(11580, 420), { fraction: 0.58, xp: 11580, nextLevelXp: 12000 });
  assert.equal(levelProgress(0, 1000).fraction, 0);

  const now = new Date(2026, 9, 9, 18, 0);
  const at = (d: number, h = 9) => new Date(2026, 9, d, h, 0).toISOString();
  assert.equal(dayStreak([at(9), at(8), at(8, 20), at(7), at(5)], now), 3, 'today, yesterday and the day before');
  assert.equal(dayStreak([at(8), at(7)], now), 2, 'still alive before today\'s first drive');
  assert.equal(dayStreak([at(6)], now), 0);
  assert.equal(dayStreak([null, undefined, 'not a date'], now), 0);

  assert.equal(firstNameOf({ id: 'u1', name: '  Alex  Morgan ' }), 'Alex');
  assert.equal(firstNameOf({ name: 'Driver' }), undefined, 'the placeholder profile before the account loads');
  assert.equal(firstNameOf({ id: 'u1', name: '' }), undefined);
  assert.equal(firstNameOf(null), undefined);
  // Never a hard-coded name in the screen
  const read = (rel: string) => readFileSync(toPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
  assert.ok(!/Daniel/.test(read('app/drive-summary.tsx') + read('components/driveComplete/DriveCompleteView.tsx')));
});

// ─── Navigation Phase 2A: route previews ────────────────────────────────────
// Routes are fetched only when the user asks; they live in memory only; the
// overview camera fits them into the clear part of the screen.

import { routesFromServer, routeRequestBody, type Destination as NavDestination, type RouteOrigin } from '@/lib/navigation/model';
import { RoutePreviewStore, PREVIEW, type PreviewError } from '@/lib/navigation/previewStore';
import { routesBounds, overviewPose, screenPoint, interpolatePose, OVERVIEW } from '@/lib/navigation/geometry';
import { formatDuration, formatRouteDistance, formatClock, arrivalTime, formatVia } from '@/lib/navigation/format';
import type { ServerRoutes } from '@/lib/backend/endpoints';

const NAV_ORIGIN: RouteOrigin = { coordinate: { latitude: 54.6001, longitude: -3.1345 }, headingDeg: null };
const NAV_DEST: NavDestination = {
  id: 'place-1', name: 'Ambleside', subtitle: 'Saved place', source: 'saved',
  coordinate: { latitude: 54.4287, longitude: -2.9612 },
};
const navLine = (n: number, dLng = 0) => Array.from({ length: n }, (_, i) => ({
  lat: 54.6001 - (i / (n - 1)) * 0.1714, lng: -3.1345 + (i / (n - 1)) * 0.1733 + dLng * Math.sin((i / (n - 1)) * Math.PI),
}));
function serverRoutes(count = 2): ServerRoutes {
  return {
    provider: 'mapbox', providerResponseId: 'resp',
    routes: Array.from({ length: count }, (_, i) => ({
      index: i, geometry: encodePolyline(navLine(20, i * 0.02), 6), distanceM: 24_500 + i * 1500, durationS: 1980 + i * 120,
      typicalDurationS: 1800, summary: i ? 'B5289' : 'A591',
      legs: [{
        distanceM: 24_500, durationS: 1980, summary: 'A591', congestion: [1], maxspeedKmh: [48],
        steps: [{
          maneuver: { type: 'depart', modifier: null, exit: null, bearingBefore: 0, bearingAfter: 180, location: { lat: 54.6001, lng: -3.1345 }, instruction: 'Head south' },
          startDistanceM: 0, distanceM: 24_500, durationS: 1980, roadName: 'Lake Road', roadRef: 'A591', signposts: null,
          junctionRef: null, drivingSide: 'left', banner: null, voice: [],
        }],
      }],
    })),
  };
}

/** A store with a controllable fetch, clock and timers */
function previewHarness() {
  const pending: Array<{ body: unknown; resolve: (r: ServerRoutes) => void; reject: (e: unknown) => void }> = [];
  const clock = { t: 1_000_000 };
  const timers: Array<{ at: number; fn: () => void; id: number }> = [];
  let timerId = 0;
  const store = new RoutePreviewStore({
    fetchRoutes: (body) => new Promise((resolve, reject) => pending.push({ body, resolve, reject })),
    describe: (err): PreviewError => ({ code: (err as { code?: string }).code ?? 'network', message: String((err as Error).message) }),
    now: () => clock.t,
    setTimer: (fn, ms) => { const id = ++timerId; timers.push({ at: clock.t + ms, fn, id }); return id; },
    clearTimer: (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); },
  });
  const advance = (ms: number) => {
    clock.t += ms;
    for (const t of timers.filter((x) => x.at <= clock.t)) { timers.splice(timers.indexOf(t), 1); t.fn(); }
  };
  const phases: string[] = [];
  store.subscribe(() => phases.push(store.phase));
  return { store, pending, clock, advance, phases };
}
const navSettle = () => new Promise((r) => setTimeout(r, 0));

test('route previews: the API response becomes drawable routes (polyline6 decoded, alternatives kept)', () => {
  const routes = routesFromServer(serverRoutes(3), 'r1');
  assert.equal(routes.length, 3);
  assert.deepEqual(routes.map((r) => r.routeId), ['r1:0', 'r1:1', 'r1:2']);
  assert.equal(routes[0]!.geometry.length, 20);
  assert.ok(Math.abs(routes[0]!.geometry[0]!.latitude - 54.6001) < 1e-6, 'precision 6');
  assert.ok(Math.abs(routes[0]!.geometry[19]!.longitude - -2.9612) < 1e-6);
  assert.equal(routes[1]!.summary, 'B5289');
  assert.deepEqual(routes[0]!.legs[0]!.steps[0]!.maneuver.location, { latitude: 54.6001, longitude: -3.1345 });
  // A route with no line can't be drawn: dropped
  const broken = serverRoutes(2);
  broken.routes[1]!.geometry = '';
  assert.equal(routesFromServer(broken, 'r2').length, 1);
  // The request carries only the two points (and the heading when known)
  assert.deepEqual(routeRequestBody({ ...NAV_ORIGIN, headingDeg: 182 }, NAV_DEST), {
    origin: { lat: 54.6001, lng: -3.1345, headingDeg: 182 }, destination: { lat: 54.4287, lng: -2.9612 },
  });
});

test('route previews: open → routing → preview; select an alternative; cancel; failures are typed', async () => {
  const { store, pending, phases } = previewHarness();
  assert.equal(store.phase, 'idle');
  void store.open(NAV_DEST, NAV_ORIGIN);
  assert.equal(store.phase, 'routing');
  assert.equal(pending.length, 1);
  pending[0]!.resolve(serverRoutes(2));
  await navSettle();
  const s = store.state;
  assert.equal(s.phase, 'preview');
  if (s.phase !== 'preview') return;
  assert.equal(s.routes.length, 2);
  assert.equal(s.selectedIndex, 0);
  assert.equal(s.stale, null);
  store.select(1);
  assert.equal(store.selected!.index, 1);
  store.select(7); // no such route
  assert.equal(store.selected!.index, 1);
  store.cancel();
  assert.equal(store.phase, 'idle');
  assert.deepEqual(phases, ['routing', 'preview', 'preview', 'idle']);
  // A failure is shown with its reason
  void store.open(NAV_DEST, NAV_ORIGIN);
  pending[1]!.reject(Object.assign(new Error('No driving route was found to that place.'), { code: 'route_not_found' }));
  await navSettle();
  const f = store.state;
  assert.equal(f.phase, 'previewFailed');
  if (f.phase === 'previewFailed') assert.equal(f.error.code, 'route_not_found');
  // An empty answer is a failure too, never an empty preview
  void store.open(NAV_DEST, NAV_ORIGIN);
  pending[2]!.resolve({ provider: 'mapbox', providerResponseId: null, routes: [] });
  await navSettle();
  assert.equal(store.phase, 'previewFailed');
});

test('route previews: a stale response never replaces a newer request or reopens a cancelled preview', async () => {
  const { store, pending } = previewHarness();
  void store.open(NAV_DEST, NAV_ORIGIN);
  const other = { ...NAV_DEST, id: 'place-2', name: 'Keswick' };
  void store.open(other, NAV_ORIGIN);
  pending[1]!.resolve(serverRoutes(1));
  await navSettle();
  pending[0]!.resolve(serverRoutes(3)); // the older request answers last
  await navSettle();
  const s = store.state;
  assert.equal(s.phase, 'preview');
  if (s.phase === 'preview') {
    assert.equal(s.destination.id, 'place-2');
    assert.equal(s.routes.length, 1);
  }
  // Cancelled while routing: the answer is dropped
  void store.open(NAV_DEST, NAV_ORIGIN);
  store.cancel();
  pending[2]!.resolve(serverRoutes(2));
  await navSettle();
  assert.equal(store.phase, 'idle');
  // Cancelled while an update is in flight: dropped too
  void store.open(NAV_DEST, NAV_ORIGIN);
  pending[3]!.resolve(serverRoutes(2));
  await navSettle();
  void store.update(NAV_ORIGIN);
  store.cancel();
  pending[4]!.reject(new Error('offline'));
  await navSettle();
  assert.equal(store.phase, 'idle');
});

test('route previews: never re-fetched on their own; out of date after 10 min or 300 m, updated only when the user asks', async () => {
  const { store, pending, advance } = previewHarness();
  void store.open(NAV_DEST, NAV_ORIGIN);
  pending[0]!.resolve(serverRoutes(2));
  await navSettle();
  assert.equal(store.requests, 1);
  // Moving about inside 300 m: still current
  store.noteFix({ latitude: 54.6001 - 0.002, longitude: -3.1345 });
  assert.equal(store.state.phase === 'preview' && store.state.stale, null);
  // 300 m away: marked out of date, nothing fetched
  store.noteFix({ latitude: 54.6001 - 0.003, longitude: -3.1345 });
  assert.equal(store.state.phase === 'preview' && store.state.stale, 'moved');
  // Hours pass with fixes arriving and timers firing: still one request
  for (let i = 0; i < 120; i++) {
    advance(60_000);
    store.noteFix({ latitude: 54.5 + i * 1e-3, longitude: -3.1 });
  }
  assert.equal(store.requests, 1);
  assert.equal(pending.length, 1);
  // Update Route: the user asks; the old routes stay on screen until the new ones land
  void store.update({ coordinate: { latitude: 54.59, longitude: -3.13 }, headingDeg: 170 });
  assert.equal(store.requests, 2);
  const during = store.state;
  assert.ok(during.phase === 'preview' && during.refreshing && during.routes.length === 2);
  pending[1]!.resolve(serverRoutes(1));
  await navSettle();
  const after = store.state;
  assert.ok(after.phase === 'preview' && !after.refreshing && after.stale === null && after.routes.length === 1);
  assert.deepEqual((pending[1]!.body as { origin: unknown }).origin, { lat: 54.59, lng: -3.13, headingDeg: 170 });
  // The age alone marks it out of date (a timer, not a request)
  advance(PREVIEW.staleAfterMs);
  assert.equal(store.state.phase === 'preview' && store.state.stale, 'age');
  assert.equal(store.requests, 2);
  // An update that fails keeps the routes, with the reason
  void store.update(NAV_ORIGIN);
  pending[2]!.reject(Object.assign(new Error('Routing is busy right now.'), { code: 'routing_busy' }));
  await navSettle();
  const failed = store.state;
  assert.ok(failed.phase === 'preview' && failed.routes.length === 1 && failed.updateError?.code === 'routing_busy' && !failed.refreshing);
  // Retry from a failed preview is a new request (the user's)
  store.cancel();
  void store.open(NAV_DEST, NAV_ORIGIN);
  pending[3]!.reject(new Error('offline'));
  await navSettle();
  assert.equal(store.phase, 'previewFailed');
  void store.update(NAV_ORIGIN);
  assert.equal(store.phase, 'routing');
  assert.equal(store.requests, 5);
});

test('route previews: the overview camera fits every route into the clear part of the screen', () => {
  const routes = routesFromServer(serverRoutes(3), 'r1');
  const bounds = routesBounds(routes, [NAV_DEST.coordinate])!;
  const viewport = { width: 393, height: 852 };
  const insets = { top: 140, bottom: 330, left: 32, right: 32 };
  const pose = overviewPose(bounds, viewport, insets);
  assert.equal(pose.pitch, 0);
  assert.equal(pose.heading, 0);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const r of routes) for (const p of r.geometry) {
    const s = screenPoint(pose, viewport, p);
    minX = Math.min(minX, s.x); maxX = Math.max(maxX, s.x); minY = Math.min(minY, s.y); maxY = Math.max(maxY, s.y);
  }
  const eps = 0.5;
  assert.ok(minX >= insets.left - eps && maxX <= viewport.width - insets.right + eps, `x ${minX}..${maxX}`);
  assert.ok(minY >= insets.top - eps && maxY <= viewport.height - insets.bottom + eps, `y ${minY}..${maxY}`);
  // As large as possible: one side fills the clear area
  const fillX = (maxX - minX) / (viewport.width - insets.left - insets.right);
  const fillY = (maxY - minY) / (viewport.height - insets.top - insets.bottom);
  assert.ok(Math.max(fillX, fillY) > 0.98, `fills ${fillX} × ${fillY}`);
  // Centred in the clear area, not the screen
  assert.ok(Math.abs((minY + maxY) / 2 - (insets.top + (viewport.height - insets.bottom)) / 2) < 1);
  // A tiny route doesn't zoom in further than street level; nothing breaks on a point
  const tiny = overviewPose({ north: 54.6, south: 54.6, east: -3.1, west: -3.1 }, viewport, insets);
  assert.equal(tiny.zoom, OVERVIEW.maxZoom);
  assert.ok(Number.isFinite(tiny.center.latitude));
  assert.equal(routesBounds([]), null);
});

test('route previews: the move to the overview eases between the two cameras, turning the short way', () => {
  const a = { center: { latitude: 54.6, longitude: -3.13 }, heading: 350, pitch: 60, distance: 0, zoom: 16 };
  const b = { center: { latitude: 54.5, longitude: -3.05 }, heading: 10, pitch: 0, distance: 0, zoom: 10 };
  assert.deepEqual(interpolatePose(a, b, 0).zoom, 16);
  const end = interpolatePose(a, b, 1);
  assert.ok(Math.abs(end.center.latitude - 54.5) < 1e-9 && Math.abs(end.center.longitude - -3.05) < 1e-9);
  assert.equal(end.pitch, 0);
  const mid = interpolatePose(a, b, 0.5);
  assert.ok(Math.abs(mid.heading - 0) < 1e-9 || Math.abs(mid.heading - 360) < 1e-9, `heading ${mid.heading}`);
  assert.equal(mid.zoom, 13);
});

test('route previews read in UK units: hours and minutes, yards then miles, 24-hour arrival, via roads', () => {
  assert.equal(formatDuration(30), '1 min');
  assert.equal(formatDuration(1980), '33 min');
  assert.equal(formatDuration(3900), '1 hr 5 min');
  assert.equal(formatDuration(7200), '2 hr');
  assert.equal(formatRouteDistance(300, 'imperial'), '328 yd');
  assert.equal(formatRouteDistance(8_000, 'imperial'), '5.0 mi');
  assert.equal(formatRouteDistance(24_500, 'imperial'), '15 mi');
  assert.equal(formatRouteDistance(8_000, 'metric'), '8.0 km');
  assert.equal(formatClock(arrivalTime(new Date(2026, 9, 9, 13, 50).getTime(), 1980)), '14:23');
  assert.equal(formatVia('A591, M6'), 'via A591, M6');
  assert.equal(formatVia(' '), null);
});

import { routePreviewFeatures, tappedRouteIndex } from '@/lib/navigation/routeLayers';

test('route previews: the map draws the selected route bold, the others tappable, and the place', async () => {
  const store = new RoutePreviewStore({
    fetchRoutes: async () => serverRoutes(3),
    describe: (e) => ({ code: 'x', message: String(e) }),
    now: () => 0,
    setTimer: () => 1,
    clearTimer: () => {},
  });
  // Idle: nothing drawn (the layers stay mounted, empty)
  const idle = routePreviewFeatures(store.state);
  assert.equal(idle.selected.features.length + idle.alternatives.features.length + idle.destination.features.length, 0);
  const opened = store.open(NAV_DEST, NAV_ORIGIN);
  // Finding routes: only the place
  const routing = routePreviewFeatures(store.state);
  assert.equal(routing.selected.features.length, 0);
  assert.deepEqual(routing.destination.features[0]!.geometry.coordinates, [NAV_DEST.coordinate.longitude, NAV_DEST.coordinate.latitude]);
  await opened;
  const shown = routePreviewFeatures(store.state);
  assert.deepEqual(shown.selected.features.map((f) => f.properties.index), [0]);
  assert.deepEqual(shown.alternatives.features.map((f) => f.properties.index), [1, 2]);
  // GeoJSON order: longitude first
  const first = shown.selected.features[0]!.geometry.coordinates[0]!;
  assert.ok(Math.abs(first[0] - -3.1345) < 1e-5 && Math.abs(first[1] - 54.6001) < 1e-5);
  // Tapping an alternative selects it; the old one becomes an alternative
  const tapped = tappedRouteIndex(shown.alternatives.features.slice(1));
  assert.equal(tapped, 2);
  store.select(tapped!);
  const after = routePreviewFeatures(store.state);
  assert.deepEqual(after.selected.features.map((f) => f.properties.index), [2]);
  assert.deepEqual(after.alternatives.features.map((f) => f.properties.index), [0, 1]);
  // A tap that names no route changes nothing
  assert.equal(tappedRouteIndex([{ properties: {} }, { properties: null }]), null);
  assert.equal(tappedRouteIndex(undefined), null);
  assert.equal(store.requests, 1, 'drawing and choosing never fetches');
  store.cancel();
  assert.equal(routePreviewFeatures(store.state).destination.features.length, 0);
});

test('route previews: no camera commands, puck or viewport; the Drive screen reads only the phase', () => {
  const read = (rel: string) => readFileSync(toPath(new URL(rel, import.meta.url)), 'utf8');
  const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
  const files = [
    '../lib/navigation/model.ts', '../lib/navigation/geometry.ts', '../lib/navigation/format.ts',
    '../lib/navigation/previewStore.ts', '../lib/navigation/routeLayers.ts',
    '../context/NavigationContext.tsx', '../components/navigation/RoutePreviewPanel.tsx', '../hooks/useRouteToPlace.ts',
  ];
  const map = strip(read('../components/MapboxDriveMap.tsx'));
  const routeLayers = map.slice(map.indexOf('const RouteLayers = memo('), map.indexOf('});', map.indexOf('const RouteLayers = memo(')));
  const banned = /\bsetCamera\(|fitBounds|flyTo|moveTo\(|zoomTo\(|\bViewport\b|LocationPuck|UserLocation|followUserLocation|followUserMode|puckBearing|showUserLocation|showUserHeading|<Camera\b/;
  for (const f of files) assert.ok(!banned.test(strip(read(f))), `${f} drives the camera or a puck`);
  assert.ok(routeLayers.length > 0 && !banned.test(routeLayers), 'the route layers only draw');
  // Route layers sit beneath the live trail head, the trail and the arrow
  const at = (s: string) => map.indexOf(s);
  assert.ok(at('<RouteLayers store={routePreview} />') > at('<Images images={ARROW_IMAGES} />'));
  assert.ok(at('<RouteLayers store={routePreview} />') < at('<TrailHeadLayers'));
  assert.ok(at('<RouteLayers store={routePreview} />') < at('id="derwent-drive-trail"'));
  assert.ok(at('<RouteLayers store={routePreview} />') < map.lastIndexOf('<MarkerFeeder'));

  // The Drive screen: the phase only, never the whole preview state
  const drive = strip(read('../app/(tabs)/(drive)/index.tsx'));
  assert.ok(/useRoutePreviewPhase\(\)/.test(drive));
  assert.ok(!/useRoutePreview\(\)/.test(drive), 'the Drive screen must not re-render on every preview change');
  assert.ok(!/useSyncExternalStore/.test(drive));
  // The overview goes through the follow camera path, and closing returns to follow
  const animate = drive.slice(drive.indexOf('const animateOverview = useCallback'), drive.indexOf('const fitRoutePreview = useCallback'));
  const fit = drive.slice(drive.indexOf('const fitRoutePreview = useCallback'), drive.indexOf('const fitRoutePreviewRef'));
  assert.ok(/mapboxRef\.current\?\.setFollowCamera\(/.test(animate) && /animateOverview\(\s*overviewPose\(/.test(fit));
  assert.ok(/visualsLiveRef\.current/.test(animate) && /visualsLiveRef\.current/.test(fit), 'no camera writes off screen');
  const follow = drive.slice(drive.indexOf('if (s.phase === "idle") {'), drive.indexOf('return;', drive.indexOf('if (s.phase === "idle") {')));
  assert.ok(/startFollowing\(true\)/.test(follow));
  // The panel replaces the drive actions in the screen: not a modal or sheet
  assert.ok(/previewing \? |\{previewing && \(/.test(drive) && /<RoutePreviewPanel/.test(drive));
  const panel = strip(read('../components/navigation/RoutePreviewPanel.tsx'));
  assert.ok(!/<Modal\b|KeyboardAwareSheet|BottomSheet|router\.push/.test(panel));
  // A drive starting closes the preview
  assert.ok(/if \(isDriving && routePreviewStore\.phase !== "idle"\)\s*routePreviewStore\.cancel\(\)/.test(drive));
});

test('route previews: fetched only when the user asks, kept in memory only, with the road-safety notice', () => {
  const read = (rel: string) => readFileSync(toPath(new URL(rel, import.meta.url)), 'utf8');
  const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const store = strip(read('../lib/navigation/previewStore.ts'));
  // One provider call, from fetch(); fetch() only from open() and update()
  assert.equal(store.match(/deps\.fetchRoutes\(/g)?.length, 1);
  assert.equal(store.match(/this\.fetch\(/g)?.length, 2);
  const open = store.slice(store.indexOf('open(destination'), store.indexOf('update(origin'));
  const update = store.slice(store.indexOf('update(origin'), store.indexOf('select(index'));
  assert.ok(/this\.fetch\(/.test(open) && /this\.fetch\(/.test(update));
  // Nothing scheduled fetches: the only timer marks the preview out of date
  assert.ok(!/setInterval/.test(store));
  const timer = store.slice(store.indexOf('private startAgeTimer'), store.indexOf('private stopAgeTimer'));
  assert.ok(!/this\.fetch\(|fetchRoutes|this\.open\(|this\.update\(/.test(timer));
  const noteFix = store.slice(store.indexOf('noteFix(position'), store.indexOf('get selected'));
  assert.ok(!/this\.fetch\(|fetchRoutes|this\.open\(|this\.update\(/.test(noteFix));
  // Routes in memory only: no storage, no logging
  for (const f of ['../lib/navigation/previewStore.ts', '../lib/navigation/model.ts', '../components/navigation/RoutePreviewPanel.tsx', '../hooks/useRouteToPlace.ts']) {
    const src = strip(read(f));
    assert.ok(!/AsyncStorage|SecureStore|MemoryStore|storage|FileSystem|console\./.test(src), `${f} stores or logs routes`);
  }
  // The context stores two things on the device, never routes: recent
  // destinations (Phase 2B) and the voice preference (Phase 4)
  const ctx = strip(read('../context/NavigationContext.tsx'));
  assert.ok(!/AsyncStorage|SecureStore|FileSystem|console\./.test(ctx));
  assert.deepEqual(ctx.match(/deviceStorage/g)?.length, 3, 'deviceStorage: one import, two uses (recents, voice preference)');
  assert.ok(/new RecentDestinations\(deviceStorage, userId\)/.test(ctx));
  assert.ok(/new VoicePreferences\(deviceStorage, userId\)/.test(ctx));
  // The disclosure Mapbox asks directions apps to show, on the preview itself
  const panel = read('../components/navigation/RoutePreviewPanel.tsx');
  assert.ok(panel.includes('"Directions are a guide. Always follow road signs, signals and local traffic laws."'));
  assert.ok(/\{ROAD_SAFETY_NOTICE\}/.test(panel));
  // The entry points: saved places and Beauty Spots preview; typed searches still open the maps app
  const search = strip(read('../app/search.tsx'));
  const explore = strip(read('../app/(tabs)/(drive)/explore.tsx'));
  assert.ok(/go\(placeDestination\(p\)\)/.test(search) && /go\(spotDestination\(n\)\)/.test(search) && /void routeToPlace\(destination\)/.test(search));
  assert.ok(/openDirections\(query\)/.test(search));
  assert.ok(/routeToPlace\(/.test(explore) && !/openDirections/.test(explore));
  const hook = strip(read('../hooks/useRouteToPlace.ts'));
  const fallback = hook.slice(hook.indexOf('if (!canPreviewRoutes(isDriving)) {'), hook.indexOf('try {'));
  assert.ok(/await openDirections\(destination\.coordinate\)/.test(fallback), 'without Mapbox, or while driving, the maps app as before');
  // ...except a Search Box result, which is never handed to another map (Mapbox's terms)
  assert.ok(/if \(destination\.source === "search"\) \{[\s\S]*?return;\s*\}\s*await openDirections/.test(fallback));
});

test('route previews are only offered on the Mapbox map with no drive recording', () => {
  const src = readFileSync(toPath(new URL('../context/NavigationContext.tsx', import.meta.url)), 'utf8');
  assert.ok(/return DRIVE_MAPBOX != null && !isDriving;/.test(src));
});

// ─── Navigation Phase 2B: destination search and saving places ──────────────
// Mapbox Search Box from the phone, in sessions; coordinates parsed locally;
// recent destinations on the device; any storable destination saved as a
// place. Search Box results are temporary use only: never stored.

import { DestinationSearch, SEARCH, SearchSession, destinationFromRetrieve, resultsFromSuggest, suggestUrl, retrieveUrl, type SearchResult } from '@/lib/navigation/search';
import { parseCoordinates, coordinateDestination, formatCoordinates } from '@/lib/navigation/coordinates';
import { RecentDestinations, RECENTS, recentsKey } from '@/lib/navigation/recents';
import { findSavedMatch, saveability, placeFieldsFor } from '@/lib/navigation/places';
import { localMatches, matchesQuery, placeToDestination } from '@/lib/navigation/localResults';
import { canStoreDestination } from '@/lib/navigation/model';

const SUGGEST_BODY = {
  suggestions: [
    { name: 'Booths', mapbox_id: 'poi.111', feature_type: 'poi', full_address: 'Lake Road, Keswick, CA12 5DQ, United Kingdom', place_formatted: 'Keswick, England', poi_category: ['supermarket'], distance: 1234, maki: 'grocery', context: { country: { name: 'United Kingdom' } }, external_ids: { foursquare: 'x' }, metadata: { phone: '01234' } },
    { name: 'CA12 5DQ', mapbox_id: 'postcode.222', feature_type: 'postcode', place_formatted: 'Keswick, England, United Kingdom' },
    { name: 'Petrol stations', mapbox_id: 'category.petrol', feature_type: 'category' },
    { name: 'Keswick', mapbox_id: 'place.333', feature_type: 'place', place_formatted: 'Cumbria, England, United Kingdom' },
    { name: '', mapbox_id: 'poi.bad', feature_type: 'poi' },
  ],
  attribution: '© Mapbox', response_id: 'resp-1',
};
const RETRIEVE_BODY = {
  type: 'FeatureCollection',
  features: [{
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [-3.1345, 54.6001] },
    properties: {
      name: 'Booths', mapbox_id: 'poi.111', feature_type: 'poi', full_address: 'Lake Road, Keswick, CA12 5DQ, United Kingdom',
      coordinates: { latitude: 54.6001, longitude: -3.1345, routable_points: [{ name: 'default', latitude: 54.6003, longitude: -3.1341 }] },
      metadata: { phone: '01234', website: 'https://example.com' }, external_ids: { foursquare: 'x' },
    },
  }],
};

/** A DestinationSearch with a fake Mapbox, a hand-driven clock and timers */
function searchHarness(opts: { token?: string | null; respond?: (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }> } = {}) {
  const clock = { t: 1_000_000 };
  const timers: Array<{ fn: () => void; at: number; id: number }> = [];
  let tid = 0, tokens = 0;
  const calls: Array<{ url: string; signal: AbortSignal }> = [];
  const respond = opts.respond ?? (async (url: string) => ({
    ok: true, status: 200,
    json: async () => (url.includes('/retrieve/') ? RETRIEVE_BODY : SUGGEST_BODY),
  }));
  const search = new DestinationSearch({
    token: opts.token === undefined ? 'pk.test-public-token' : opts.token,
    fetch: (url, init) => { calls.push({ url, signal: init.signal }); return respond(url); },
    newSessionToken: () => `session-${++tokens}`,
    now: () => clock.t,
    setTimer: (fn, ms) => { const id = ++tid; timers.push({ fn, at: clock.t + ms, id }); return id; },
    clearTimer: (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); },
  });
  const advance = async (ms: number) => {
    clock.t += ms;
    for (;;) {
      const due = timers.filter((t) => t.at <= clock.t).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      timers.splice(timers.indexOf(due), 1);
      due.fn();
    }
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  };
  const param = (url: string, k: string) => new URL(url).searchParams.get(k);
  return { search, calls, advance, clock, param, suggests: () => calls.filter((c) => c.url.includes('/suggest')) };
}

test('search: Search Box requests are UK-first, English, near the phone, and carry a session token', () => {
  const url = suggestUrl('booths keswick', { token: 'pk.abc', session: 'sess-1', proximity: { latitude: 54.60012, longitude: -3.13456 } });
  const u = new URL(url);
  assert.equal(u.origin + u.pathname, 'https://api.mapbox.com/search/searchbox/v1/suggest');
  assert.equal(u.searchParams.get('q'), 'booths keswick');
  assert.equal(u.searchParams.get('country'), 'GB');
  assert.equal(u.searchParams.get('language'), 'en');
  assert.equal(u.searchParams.get('proximity'), '-3.1346,54.6001', 'longitude first, as Mapbox expects');
  assert.equal(u.searchParams.get('session_token'), 'sess-1');
  assert.equal(u.searchParams.get('limit'), String(SEARCH.limit));
  assert.equal(u.searchParams.get('access_token'), 'pk.abc');
  // No position known: Mapbox's own default (IP) rather than a made-up point
  assert.equal(new URL(suggestUrl('york', { token: 'pk.abc', session: 's', proximity: null })).searchParams.get('proximity'), null);
  const r = new URL(retrieveUrl('poi.1/x', { token: 'pk.abc', session: 'sess-1' }));
  assert.equal(r.pathname, '/search/searchbox/v1/retrieve/poi.1%2Fx');
  assert.equal(r.searchParams.get('session_token'), 'sess-1');
});

test('search: typing is debounced, short queries and repeats are never sent', async () => {
  const h = searchHarness();
  for (const q of ['k', 'ke', 'kes', 'kesw', 'keswi', 'keswick']) { h.search.setQuery(q); await h.advance(50); }
  assert.equal(h.suggests().length, 0, 'nothing sent while typing');
  assert.equal(h.search.state.status, 'loading');
  await h.advance(SEARCH.debounceMs);
  assert.equal(h.suggests().length, 1);
  assert.equal(h.param(h.suggests()[0]!.url, 'q'), 'keswick');
  assert.equal(h.search.state.status, 'ready');
  // The same query again (or with different spacing/case): no new request
  h.search.setQuery('Keswick ');
  await h.advance(1000);
  assert.equal(h.suggests().length, 1);
  assert.equal(h.search.state.status, 'ready');
  // Under three characters: nothing sent, nothing shown
  h.search.setQuery('ke');
  await h.advance(1000);
  assert.equal(h.suggests().length, 1);
  assert.equal(h.search.state.status, 'idle');
});

test('search: a newer query cancels the request in flight; its late answer is ignored', async () => {
  const pending: Array<(v: { ok: boolean; status: number; json(): Promise<unknown> }) => void> = [];
  const h = searchHarness({ respond: () => new Promise((resolve) => pending.push(resolve)) });
  h.search.setQuery('kendal');
  await h.advance(SEARCH.debounceMs);
  h.search.setQuery('keswick');
  await h.advance(SEARCH.debounceMs);
  assert.equal(h.suggests().length, 2);
  assert.equal(h.suggests()[0]!.signal.aborted, true, 'the stale request was cancelled');
  assert.equal(h.suggests()[1]!.signal.aborted, false);
  // The newer answer arrives, then the stale one: only the newer is shown
  pending[1]!({ ok: true, status: 200, json: async () => ({ suggestions: [{ name: 'Keswick', mapbox_id: 'place.k', feature_type: 'place' }] }) });
  await h.advance(0);
  pending[0]!({ ok: true, status: 200, json: async () => ({ suggestions: [{ name: 'Kendal', mapbox_id: 'place.d', feature_type: 'place' }] }) });
  await h.advance(0);
  assert.deepEqual(h.search.state.results.map((r) => r.name), ['Keswick']);
  // Closing the search cancels whatever is left and keeps nothing
  h.search.setQuery('penrith');
  await h.advance(SEARCH.debounceMs);
  h.search.close();
  assert.equal(h.suggests()[2]!.signal.aborted, true);
  assert.equal(h.search.state.status, 'idle');
  assert.equal(h.search.state.results.length, 0);
});

test('search: one session token per search, reused for suggestions and retrieve, then rotated', async () => {
  const h = searchHarness();
  h.search.setQuery('booths');
  await h.advance(SEARCH.debounceMs);
  h.search.setQuery('booths keswick');
  await h.advance(SEARCH.debounceMs);
  const [a, b] = h.suggests().map((c) => h.param(c.url, 'session_token'));
  assert.equal(a, 'session-1');
  assert.equal(b, 'session-1', 'the same session while typing');
  const pick = h.search.state.results[0]!;
  await h.search.select(pick);
  const retrieve = h.calls.find((c) => c.url.includes('/retrieve/'))!;
  assert.equal(h.param(retrieve.url, 'session_token'), 'session-1', 'retrieve closes the same session');
  assert.equal(h.search.session.active, null, 'the token is dropped once a result is retrieved');
  // The next search is a new session
  h.search.setQuery('kendal');
  await h.advance(SEARCH.debounceMs);
  assert.equal(h.param(h.suggests().at(-1)!.url, 'session_token'), 'session-2');
  // Closing ends it; reopening starts another
  h.search.close();
  assert.equal(h.search.session.active, null);
  h.search.setQuery('penrith');
  await h.advance(SEARCH.debounceMs);
  assert.equal(h.param(h.suggests().at(-1)!.url, 'session_token'), 'session-3');
  // Idle past Mapbox's window: a new token rather than a stale one
  h.clock.t += SEARCH.sessionIdleMs + 1;
  h.search.setQuery('ambleside');
  await h.advance(SEARCH.debounceMs);
  assert.equal(h.param(h.suggests().at(-1)!.url, 'session_token'), 'session-4');
  // And never more than 50 suggestions on one token
  let n = 0;
  const session = new SearchSession(() => `t${++n}`, () => 0);
  const used = Array.from({ length: SEARCH.maxSuggestPerSession + 1 }, () => session.use('suggest'));
  assert.equal(new Set(used.slice(0, SEARCH.maxSuggestPerSession)).size, 1);
  assert.equal(used.at(-1), 't2');
});

test('search: provider answers become Derwent results with only the fields the app uses', () => {
  const results = resultsFromSuggest(SUGGEST_BODY);
  // Category searches and nameless entries aren't places; the rest are kept
  assert.deepEqual(results.map((r) => r.name), ['Booths', 'CA12 5DQ', 'Keswick']);
  assert.deepEqual(results.map((r) => r.kind), ['poi', 'postcode', 'place']);
  const booths = results[0]!;
  assert.deepEqual(Object.keys(booths).sort(), ['category', 'distanceM', 'id', 'kind', 'name', 'providerRef', 'source', 'subtitle']);
  assert.equal(booths.subtitle, 'Lake Road, Keswick, CA12 5DQ, United Kingdom');
  assert.equal(booths.category, 'Supermarket');
  assert.equal(booths.distanceM, 1234);
  assert.equal(booths.source, 'search');
  assert.ok(!JSON.stringify(results).includes('01234') && !JSON.stringify(results).includes('foursquare'), 'provider metadata is dropped');
  // Retrieve: the routable point (where a car can get to), only the destination fields
  const d = destinationFromRetrieve(RETRIEVE_BODY, booths);
  assert.deepEqual(d, {
    id: 'search:poi.111', name: 'Booths', subtitle: 'Lake Road, Keswick, CA12 5DQ, United Kingdom',
    coordinate: { latitude: 54.6003, longitude: -3.1341 }, source: 'search',
  });
  // No routable point: the place itself; no position at all: a clear error
  const plain = { features: [{ geometry: { coordinates: [-2.9612, 54.4287] }, properties: { name: 'Ambleside' } }] };
  assert.deepEqual(destinationFromRetrieve(plain, booths).coordinate, { latitude: 54.4287, longitude: -2.9612 });
  assert.throws(() => destinationFromRetrieve({ features: [] }, booths), /Couldn't find where/);
  assert.deepEqual(resultsFromSuggest(null), []);
  assert.deepEqual(resultsFromSuggest({ suggestions: 'nope' }), []);
});

test('search: choosing a result opens the same route preview as a saved place', async () => {
  const h = searchHarness();
  h.search.setQuery('booths');
  await h.advance(SEARCH.debounceMs);
  const destination = await h.search.select(h.search.state.results[0]!);
  const p = previewHarness();
  void p.store.open(destination, NAV_ORIGIN);
  assert.equal(p.store.phase, 'routing');
  assert.deepEqual(p.pending[0]!.body, {
    origin: { lat: NAV_ORIGIN.coordinate.latitude, lng: NAV_ORIGIN.coordinate.longitude, headingDeg: null },
    destination: { lat: 54.6003, lng: -3.1341 },
  });
  // And a saved place goes through exactly the same store and request
  const saved = placeToDestination({ id: 'p1', kind: 'favourite_road', name: 'Honister', address: '', coordinate: { latitude: 54.51, longitude: -3.2 } });
  void p.store.open(saved, NAV_ORIGIN);
  assert.equal(p.store.phase, 'routing');
  assert.deepEqual((p.pending[1]!.body as { destination: unknown }).destination, { lat: 54.51, lng: -3.2 });
  assert.equal(saved.id, 'place:p1');
  assert.equal(saved.source, 'saved');
});

test('search: offline, the remote half says so and the user\'s own places still match', async () => {
  const h = searchHarness({ respond: async () => { throw new TypeError('Network request failed'); } });
  h.search.setQuery('honister');
  await h.advance(SEARCH.debounceMs);
  assert.equal(h.search.state.status, 'offline');
  assert.match(h.search.state.message!, /offline/i);
  const local = localMatches('honister', {
    places: [{ id: 'p1', kind: 'favourite_road', name: 'Honister Pass', coordinate: { latitude: 54.51, longitude: -3.2 } }],
    recents: [coordinateDestination({ latitude: 54.5, longitude: -3.1 })],
    nearby: [],
  });
  assert.deepEqual(local.map((m) => m.destination.name), ['Honister Pass']);
  // Errors from Mapbox are typed for the user; none of them retry by themselves
  for (const [status, expect] of [[429, 'error'], [401, 'unavailable'], [500, 'error']] as const) {
    const e = searchHarness({ respond: async () => ({ ok: false, status, json: async () => ({}) }) });
    e.search.setQuery('honister');
    await e.advance(SEARCH.debounceMs);
    assert.equal(e.search.state.status, expect, `HTTP ${status}`);
    await e.advance(60_000);
    assert.equal(e.suggests().length, 1, `HTTP ${status}: no automatic retry`);
    e.search.retry();
    await e.advance(SEARCH.debounceMs);
    assert.equal(e.suggests().length, 2, 'Retry asks again');
  }
  // Without a token (no Mapbox map, or a drive recording) nothing is ever sent
  const off = searchHarness({ token: null });
  off.search.setQuery('honister pass');
  await off.advance(1000);
  assert.equal(off.calls.length, 0);
  assert.equal(off.search.state.status, 'unavailable');
});

test('coordinates: typed or pasted positions are parsed on the phone; Mapbox is never asked', async () => {
  assert.deepEqual(parseCoordinates('53.1234, -1.2345'), { latitude: 53.1234, longitude: -1.2345 });
  assert.deepEqual(parseCoordinates('53.1234 -1.2345'), { latitude: 53.1234, longitude: -1.2345 });
  assert.deepEqual(parseCoordinates('  53.1234,-1.2345 '), { latitude: 53.1234, longitude: -1.2345 });
  assert.deepEqual(parseCoordinates('-33.8688, 151.2093'), { latitude: -33.8688, longitude: 151.2093 });
  for (const bad of ['91.0, 0.5', '45.5, 181.0', '12 34', 'CA12 5DQ', '10 Downing Street', '53.1', '53.1, -1.2, 4', '', 'abc, def']) {
    assert.equal(parseCoordinates(bad), null, bad);
  }
  const d = coordinateDestination({ latitude: 53.1234, longitude: -1.2345 });
  assert.equal(d.name, 'Dropped Pin');
  assert.equal(d.subtitle, '53.12340, -1.23450');
  assert.equal(d.source, 'coordinates');
  assert.equal(formatCoordinates(d.coordinate), '53.12340, -1.23450');
  const h = searchHarness();
  h.search.setQuery('53.1234, -1.2345');
  await h.advance(5000);
  assert.equal(h.calls.length, 0, 'no Search Box request for coordinates');
  assert.deepEqual(h.search.state.coordinates, { latitude: 53.1234, longitude: -1.2345 });
});

test('recent destinations: newest first, bounded, per user, never Search Box results, cleared at sign-out', async () => {
  const store = new MemoryStore();
  let t = 0;
  const recents = new RecentDestinations(store, 'u1', () => ++t);
  const at = (i: number) => coordinateDestination({ latitude: 54 + i * 0.01, longitude: -3 });
  for (let i = 0; i < RECENTS.max + 3; i++) await recents.record(at(i));
  assert.equal(recents.items.length, RECENTS.max);
  assert.equal(recents.items[0]!.coordinate.latitude, 54 + (RECENTS.max + 2) * 0.01);
  // Going somewhere again moves it to the top (no duplicate)
  await recents.record(at(5));
  assert.equal(recents.items[0]!.id, at(5).id);
  assert.equal(recents.items.filter((r) => r.id === at(5).id).length, 1);
  // Only the destination itself is kept
  const stored = JSON.parse(store.data.get(recentsKey('u1'))!);
  assert.deepEqual(Object.keys(stored[0]).sort(), ['coordinate', 'id', 'name', 'source', 'subtitle', 'usedAt']);
  // A Search Box result is never written (temporary use only)
  const before = store.data.get(recentsKey('u1'));
  await recents.record({ id: 'search:poi.1', name: 'Booths', subtitle: 'Keswick', coordinate: { latitude: 54.6, longitude: -3.1 }, source: 'search' });
  assert.equal(store.data.get(recentsKey('u1')), before);
  assert.ok(!recents.items.some((r) => r.source === 'search'));
  // Per user: another account on the phone sees none of them
  const other = new RecentDestinations(store, 'u2');
  await other.load();
  assert.equal(other.items.length, 0);
  // Reloaded from the device
  const again = new RecentDestinations(store, 'u1');
  await again.load();
  assert.equal(again.items.length, RECENTS.max);
  // A tampered entry from search is dropped on load
  await store.setItem(recentsKey('u3'), JSON.stringify([{ ...at(1), usedAt: 1 }, { id: 'search:x', name: 'x', subtitle: null, coordinate: { latitude: 1, longitude: 1 }, source: 'search', usedAt: 2 }]));
  const tampered = new RecentDestinations(store, 'u3');
  await tampered.load();
  assert.deepEqual(tampered.items.map((r) => r.source), ['coordinates']);
  await recents.clear();
  assert.equal(recents.items.length, 0);
  assert.equal(store.data.has(recentsKey('u1')), false);
  // Sign-out (CloudSync.wipeLocal) removes them with the rest of the user's device data
  await again.record(at(1));
  const server = new FakeServer();
  const app = makeSync(server, store, { t: Date.now() });
  await app.start();
  assert.equal(store.data.has(recentsKey('u1')), true);
  await app.wipeLocal();
  assert.equal(store.data.has(recentsKey('u1')), false, 'recents cleared at sign-out');
  assert.equal(recentsKey('u1'), userKey('u1', RECENTS.name));
});

test('saving a place: any storable destination, with its address; duplicates are recognised', async () => {
  const places = [
    { id: 'a', name: 'Honister Pass', address: '', coordinate: { latitude: 54.5100, longitude: -3.2000 } },
    { id: 'b', name: 'Home', address: '1 Lake Road, Keswick', coordinate: { latitude: 54.6000, longitude: -3.1300 } },
  ];
  const pin = coordinateDestination({ latitude: 54.7, longitude: -3.0 }, 'pin');
  // Same spot (a few metres), whatever it's called
  assert.equal(findSavedMatch(places, coordinateDestination({ latitude: 54.51005, longitude: -3.20005 }))?.id, 'a');
  // Same name nearby: the same place
  assert.equal(findSavedMatch(places, { ...pin, name: 'honister pass', coordinate: { latitude: 54.5108, longitude: -3.2 } })?.id, 'a');
  // Same address nearby
  assert.equal(findSavedMatch(places, { ...pin, name: 'Dropped Pin', subtitle: '1 Lake Road, Keswick', coordinate: { latitude: 54.6008, longitude: -3.13 } })?.id, 'b');
  // A different place a street away is not merged, nor a same-named one far off
  assert.equal(findSavedMatch(places, coordinateDestination({ latitude: 54.5110, longitude: -3.2 })), null);
  assert.equal(findSavedMatch(places, { ...pin, name: 'Honister Pass', coordinate: { latitude: 54.6, longitude: -3.0 } }), null);
  // The saved place itself
  assert.equal(findSavedMatch(places, placeToDestination({ ...places[1]!, kind: 'home' }))?.id, 'b');
  assert.deepEqual(saveability(places, pin), { kind: 'can_save' });
  assert.deepEqual(saveability(places, placeToDestination({ ...places[0]!, kind: 'favourite_road' })), { kind: 'saved', placeId: 'a' });
  // A Search Box result can't be saved (temporary use only), even if the app asked
  const searched = { id: 'search:poi.1', name: 'Booths', subtitle: 'Lake Road', coordinate: { latitude: 54.7, longitude: -3.0 }, source: 'search' as const };
  assert.equal(canStoreDestination(searched), false);
  assert.deepEqual(saveability([], searched), { kind: 'not_storable' });
  assert.throws(() => placeFieldsFor(searched, 'Booths'), /cannot be saved/);
  // Saved where it is (not where the phone is), with the user's name and its address
  const fields = placeFieldsFor({ ...pin, subtitle: '54.70000, -3.00000' }, '  Lay-by on the A591 ');
  assert.deepEqual(fields, { name: 'Lay-by on the A591', coordinate: { latitude: 54.7, longitude: -3.0 }, address: '54.70000, -3.00000' });
  const server = new FakeServer();
  const app = makeSync(server, new MemoryStore(), { t: Date.now() });
  await app.start();
  await app.addPlace({ kind: 'poi', ...fields });
  await app.outbox.flush();
  const created = server.locations.at(-1)!;
  assert.deepEqual([created.name, created.lat, created.lng, created.address, created.kind], ['Lay-by on the A591', 54.7, -3.0, '54.70000, -3.00000', 'poi']);
  // Existing saves (where I am) are unchanged: no address unless one is given
  await app.addPlace({ kind: 'favourite_road', name: 'Here', coordinate: { latitude: 1, longitude: 1 } });
  await app.outbox.flush();
  assert.equal(server.locations.at(-1)!.address, '');
});

test('local matches: word starts, names before addresses, recents and shared spots, no repeats', () => {
  assert.ok(matchesQuery('Lake Road, Keswick', 'lake rd') === false);
  assert.ok(matchesQuery('Lake Road, Keswick', 'lake ro'));
  assert.ok(matchesQuery('Honister Pass', 'pass hon'));
  assert.ok(!matchesQuery('Honister Pass', 'ass'));
  const m = localMatches('kes', {
    places: [
      { id: 'w', kind: 'work', name: 'Office', address: 'Main Street, Keswick', coordinate: { latitude: 1, longitude: 1 } },
      { id: 'k', kind: 'favourite_road', name: 'Keswick loop', coordinate: { latitude: 2, longitude: 2 } },
    ],
    recents: [{ ...coordinateDestination({ latitude: 3, longitude: 3 }), name: 'Keswick car park' }],
    nearby: [{ id: 's', name: 'Kesh viewpoint', coordinate: { latitude: 4, longitude: 4 }, isOwn: false }, { id: 'k', name: 'Keswick loop', coordinate: { latitude: 2, longitude: 2 }, isOwn: true }],
  });
  assert.deepEqual(m.map((x) => x.destination.name), ['Keswick loop', 'Office', 'Keswick car park', 'Kesh viewpoint']);
  assert.deepEqual(m.map((x) => x.icon), ['saved', 'work', 'recent', 'spot']);
  assert.deepEqual(localMatches('  ', { places: [], recents: [], nearby: [] }), []);
});

test('Phase 2B wiring: search off the Drive screen, results never stored, the one preview flow reused', () => {
  const read = (rel: string) => readFileSync(toPath(new URL(rel, import.meta.url)), 'utf8');
  const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  // The Drive screen knows nothing of search (keystrokes never re-render it)
  const drive = strip(read('../app/(tabs)/(drive)/index.tsx'));
  assert.ok(!/useDestinationSearch|DestinationSearch|searchbox|useRecentDestinations/.test(drive));
  // A long press drops a pin into the same preview, never touching the camera itself
  const press = drive.slice(drive.indexOf('const handleMapLongPress'), drive.indexOf('const handleOpenRouteInMaps'));
  assert.ok(/openRoutePreview\(coordinateDestination\(coordinate, "pin"\)\)/.test(press));
  assert.ok(/isDrivingRef\.current/.test(press) && !/setFollowCamera|startFollowing|setCamera/.test(press));
  const map = strip(read('../components/MapboxDriveMap.tsx'));
  const lp = map.slice(map.indexOf('const handleLongPress'), map.indexOf('[onLongPress]'));
  assert.ok(lp.length > 0 && !/camera|Camera/.test(lp));
  // Search lives in its own module; the screen opens results through the Phase 2A hook
  const search = strip(read('../app/search.tsx'));
  assert.ok(/useDestinationSearch\(isDriving\)/.test(search));
  assert.ok(/const destination = await search\.select\(r\);\s*await routeToPlace\(destination\);/.test(search));
  assert.ok(!/fetch\(|api\.mapbox\.com|AsyncStorage|deviceStorage|writeJson/.test(search), 'the screen neither calls Mapbox nor stores anything itself');
  // Only one preview panel; it offers saving for storable destinations only
  const panel = strip(read('../components/navigation/RoutePreviewPanel.tsx'));
  assert.ok(/const save = saveability\(places, destination\)/.test(panel) && /save\.kind === "can_save"/.test(panel));
  const sheet = strip(read('../components/places/SavePlaceSheet.tsx'));
  assert.ok(/placeFieldsFor\(destination, finalName\)/.test(sheet), 'a chosen place is saved through placeFieldsFor (which refuses search results)');
  // Search only where a result can be shown on the Mapbox map, and with the public token
  const ctx = strip(read('../context/NavigationContext.tsx'));
  assert.ok(/const remote = canPreviewRoutes\(isDriving\);/.test(ctx) && /token: remote \? DRIVE_MAPBOX\?\.token \?\? null : null/.test(ctx));
  assert.ok(/return \(\) => search\.close\(\);/.test(ctx), 'the session ends with the screen');
  // The search module stores nothing and logs nothing
  const lib = strip(read('../lib/navigation/search.ts'));
  assert.ok(!/storage|Storage|writeJson|console\./.test(lib));
});

// ─── Navigation Phase 3: foreground turn-by-turn guidance ───────────────────
// Route progress from GPS fixes, step matching, roundabouts, off-route
// detection, manual reroute, arrival, GPS loss, the session state machine,
// camera policy, UK formatting, recording isolation and privacy.

import {
  prepareRoute, progressAt, RouteTracker, PROGRESS, segmentAt, UnusableRouteError, pointAt, remainingLine, REMAINING_LINE,
  type GpsFix,
} from '@/lib/navigation/routeProgress';
import { OffRouteDetector, OFF_ROUTE, awayThresholdM } from '@/lib/navigation/offRoute';
import { NavigationSession, NAVIGATION, REROUTE, type NavigationState } from '@/lib/navigation/session';
import { maneuverFor, maneuversFor, ordinal, roadLabel } from '@/lib/navigation/maneuver';
import { guidanceZoom, GUIDANCE_CAMERA } from '@/lib/navigation/guidanceCamera';
import { formatGuidanceDistance } from '@/lib/navigation/format';
import { startFromPreview, canNavigate, recordingForStart, type NavigationRecorder } from '@/lib/navigation/startNavigation';
import type { NavRoute as Nav3Route, RouteStep as Nav3Step } from '@/lib/navigation/model';

// Metres east/north of a point in the Lake District, as lat/lng
const N3_BASE = { latitude: 54.6, longitude: -3.13 };
const N3_M = 6_371_000 * Math.PI / 180;
const at3 = (x: number, y: number) => ({
  latitude: N3_BASE.latitude + y / N3_M,
  longitude: N3_BASE.longitude + x / (N3_M * Math.cos(N3_BASE.latitude * Math.PI / 180)),
});
/** Points every `step` m along straight lines between the corners (x, y in metres) */
function polyline3(corners: Array<[number, number]>, step = 10): Array<[number, number]> {
  const out: Array<[number, number]> = [corners[0]!];
  for (let i = 1; i < corners.length; i++) {
    const [x0, y0] = corners[i - 1]!;
    const [x1, y1] = corners[i]!;
    const n = Math.max(1, Math.round(Math.hypot(x1 - x0, y1 - y0) / step));
    for (let j = 1; j <= n; j++) out.push([x0 + ((x1 - x0) * j) / n, y0 + ((y1 - y0) * j) / n]);
  }
  return out;
}
interface StepSpec { at: number; type: string; modifier?: string | null; exit?: number | null; name?: string | null; ref?: string | null; instruction?: string }
/** A route through metric points with steps starting at the given point indexes */
function route3(pts: Array<[number, number]>, specs: StepSpec[], id = 't:0'): Nav3Route {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1]! + Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]));
  const total = cum[cum.length - 1]!;
  const steps: Nav3Step[] = specs.map((s, k) => {
    const end = k + 1 < specs.length ? cum[specs[k + 1]!.at]! : total;
    const distanceM = s.type === 'arrive' ? 0 : end - cum[s.at]!;
    return {
      maneuver: { type: s.type, modifier: s.modifier ?? null, exit: s.exit ?? null, bearingBefore: null, bearingAfter: null, location: at3(...pts[s.at]!), instruction: s.instruction ?? null },
      startDistanceM: cum[s.at]!, distanceM, durationS: distanceM / 13.4,
      roadName: s.name ?? null, roadRef: s.ref ?? null, signposts: null, junctionRef: null, drivingSide: 'left',
      banner: { primary: specs[k + 1]?.name ?? 'Destination', secondary: null },
      voice: [{ distanceBeforeM: 400, text: `In a quarter of a mile, step ${k + 1}` }, { distanceBeforeM: 60, text: `Now step ${k + 1}` }],
    };
  });
  return {
    routeId: id, index: 0, geometry: pts.map(([x, y]) => at3(x, y)), distanceM: total, durationS: total / 13.4,
    typicalDurationS: null, summary: 'A591', legs: [{ distanceM: total, durationS: total / 13.4, summary: 'A591', steps, congestion: null, maxspeedKmh: null }],
  };
}
/** Deterministic noise */
function rng3(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
const fix3 = (x: number, y: number, t: number, o: Partial<GpsFix> = {}): GpsFix => ({ ...at3(x, y), accuracyM: 8, speedMs: 13, headingDeg: null, time: t, ...o });
const bearing3 = (dx: number, dy: number) => ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;

// North 1 km, left (west) 600 m, right (north) 400 m, arrive
const L_PTS = polyline3([[0, 0], [0, 1000], [-600, 1000], [-600, 1400]]);
const L_TURN1 = 100, L_TURN2 = 160;
const L_ROUTE = () => route3(L_PTS, [
  { at: 0, type: 'depart', name: 'Lake Road', ref: 'A591', instruction: 'Head north on Lake Road (A591)' },
  { at: L_TURN1, type: 'turn', modifier: 'left', name: 'Chestnut Hill', instruction: 'Turn left onto Chestnut Hill' },
  { at: L_TURN2, type: 'turn', modifier: 'right', name: 'Brow Top', instruction: 'Turn right onto Brow Top' },
  { at: L_PTS.length - 1, type: 'arrive', instruction: 'You have arrived at your destination' },
]);
/** Fixes driving along metric points at `speed` m/s, one a second, with lateral noise */
function drive3(pts: Array<[number, number]>, opts: { speed?: number; noise?: number; seed?: number; t0?: number; from?: number; to?: number } = {}): GpsFix[] {
  const speed = opts.speed ?? 13;
  const rand = rng3(opts.seed ?? 7);
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1]! + Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]));
  const out: GpsFix[] = [];
  let i = 0;
  for (let d = opts.from ?? 0, t = opts.t0 ?? 1_000_000; d <= (opts.to ?? cum[cum.length - 1]!); d += speed, t += 1000) {
    while (i < pts.length - 2 && cum[i + 1]! < d) i++;
    const [x0, y0] = pts[i]!, [x1, y1] = pts[i + 1]!;
    const len = cum[i + 1]! - cum[i]!;
    const u = len > 0 ? (d - cum[i]!) / len : 0;
    const nx = -(y1 - y0) / (len || 1), ny = (x1 - x0) / (len || 1);
    const noise = ((rand() - 0.5) * 2) * (opts.noise ?? 4);
    out.push(fix3(x0 + (x1 - x0) * u + nx * noise, y0 + (y1 - y0) * u + ny * noise, t, { speedMs: speed, headingDeg: bearing3(x1 - x0, y1 - y0) }));
  }
  return out;
}

test('guidance: a route is prepared once: steps placed on the line, durations summed, no line or steps refused', () => {
  const p = prepareRoute(L_ROUTE());
  assert.equal(p.steps.length, 4);
  assert.ok(Math.abs(p.total - 2000) < 1, `total ${p.total}`);
  assert.ok(Math.abs(p.stepStart[1]! - 1000) < 1 && Math.abs(p.stepStart[2]! - 1600) < 1);
  assert.equal(p.stepStart[3], p.total, 'arrive is the end of the line');
  assert.ok(Math.abs(p.durationAfter[0]! - (600 + 400) / 13.4) < 0.01);
  assert.equal(segmentAt(p, 1005), 100);
  const bad = L_ROUTE();
  bad.legs[0]!.steps = bad.legs[0]!.steps.slice(0, 1);
  assert.throws(() => prepareRoute(bad), UnusableRouteError);
  assert.throws(() => prepareRoute({ ...L_ROUTE(), geometry: [at3(0, 0)] }), UnusableRouteError);
  assert.equal(canNavigate(L_ROUTE()), true);
  assert.equal(canNavigate(bad), false);
});

test('guidance: driving the route, steps advance in order and the distance to each turn counts down', () => {
  const tracker = new RouteTracker(prepareRoute(L_ROUTE()));
  const seen: Array<{ step: number; next: number; dist: number }> = [];
  for (const f of drive3(L_PTS, { noise: 5 })) {
    const m = tracker.match(f)!;
    const pr = tracker.commit(f, m);
    seen.push({ step: pr.stepIndex, next: pr.next.stepIndex, dist: pr.distanceToNextM });
  }
  // Monotonic steps 0 → 1 → 2, never back
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i]!.step >= seen[i - 1]!.step, `step went back at ${i}`);
  assert.deepEqual([...new Set(seen.map((s) => s.step))], [0, 1, 2]);
  // Within each step the distance to the next manoeuvre only falls (progress never runs backwards)
  for (let i = 1; i < seen.length; i++) {
    if (seen[i]!.step === seen[i - 1]!.step) assert.ok(seen[i]!.dist <= seen[i - 1]!.dist + 0.001, `distance rose at ${i}`);
  }
  // Approaching the first turn it is the next manoeuvre, at the right distance
  const t = new RouteTracker(prepareRoute(L_ROUTE()));
  const pr = t.commit(fix3(0, 700, 1), t.match(fix3(0, 700, 1))!);
  assert.equal(pr.next.kind, 'turn');
  assert.equal(pr.next.direction, 'left');
  assert.equal(pr.next.instruction, 'Turn left onto Chestnut Hill');
  assert.ok(Math.abs(pr.distanceToNextM - 300) < 2, `${pr.distanceToNextM}`);
  assert.equal(pr.currentRoad, 'A591 Lake Road');
  assert.ok(Math.abs(pr.distanceRemainingM - 1300) < 2);
  assert.ok(Math.abs(pr.durationRemainingS - 1300 / 13.4) < 1);
  // The scan stays local: a few dozen segments, never the whole line
  assert.ok(tracker.lastScan < 40, `scanned ${tracker.lastScan}`);
});

test('guidance: going straight on past a turn never advances to the next instruction', () => {
  const tracker = new RouteTracker(prepareRoute(L_ROUTE()));
  // Up to the junction, then carry on north past it
  const fixes = [...drive3(polyline3([[0, 0], [0, 1300]]), { noise: 3 })];
  let last = null as ReturnType<RouteTracker['commit']> | null;
  for (const f of fixes) {
    const m = tracker.match(f)!;
    if (m.lateralM <= awayThresholdM(f.accuracyM)) last = tracker.commit(f, m);
    else tracker.noteFix(f);
  }
  assert.equal(last!.stepIndex, 0, 'still on the first step');
  assert.equal(last!.next.direction, 'left', 'the missed turn is still the instruction');
  assert.ok(last!.distanceToNextM < 5);
});

test('guidance: a hairpin with the return leg alongside stays on the leg the car is driving', () => {
  // North 500 m, a hairpin, then south 25 m to the east
  const pts = polyline3([[0, 0], [0, 500], [25, 500], [25, 0]]);
  const r = route3(pts, [{ at: 0, type: 'depart' }, { at: 50, type: 'turn', modifier: 'sharp right' }, { at: 53, type: 'turn', modifier: 'sharp right' }, { at: pts.length - 1, type: 'arrive' }]);
  const tracker = new RouteTracker(prepareRoute(r));
  const runs = drive3(pts, { noise: 6, seed: 3 });
  for (const f of runs) tracker.commit(f, tracker.match(f)!);
  // A fresh tracker whose first fix is on the southbound leg, heading south: matched there, not northbound
  const fresh = new RouteTracker(prepareRoute(r));
  const f = fix3(20, 250, 1, { headingDeg: 180 });
  const m = fresh.match(f)!;
  assert.ok(m.along > 500, `matched at ${m.along} (northbound would be ~250)`);
  // Driving south on it, noise toward the other leg doesn't flip it
  let along = fresh.commit(f, m).along;
  for (let i = 1; i < 10; i++) {
    const g = fix3(i % 2 ? 12 : 22, 250 - i * 13, 1 + i * 1000, { headingDeg: 180 });
    const pr = fresh.commit(g, fresh.match(g)!);
    assert.ok(pr.along >= along && pr.along > 500, `step ${i}: ${pr.along}`);
    along = pr.along;
  }
});

test('guidance: one wild fix or a little backwards noise never moves progress back', () => {
  const tracker = new RouteTracker(prepareRoute(L_ROUTE()));
  let pr = tracker.commit(fix3(0, 500, 1000), tracker.match(fix3(0, 500, 1000))!);
  const at = pr.along;
  // 15 m backwards along the road: held
  pr = tracker.commit(fix3(0, 485, 2000), tracker.match(fix3(0, 485, 2000))!);
  assert.equal(pr.along, at);
  // One fix 80 m to the side: far from the line, not committed by the session (too far), so nothing moves
  const wild = tracker.match(fix3(80, 510, 3000))!;
  assert.ok(wild.lateralM > awayThresholdM(8));
  // A jump far back is believed only after repeated fixes
  const back = (t: number) => tracker.commit(fix3(0, 300, t), tracker.match(fix3(0, 300, t))!);
  assert.equal(back(4000).along, at);
  assert.equal(back(5000).along, at);
  assert.ok(Math.abs(back(6000).along - 300) < 2, 'three in a row: accepted');
});

// A roundabout, as UK drivers meet it: north to it, clockwise round from the
// south point past the west to the north (2nd exit, straight on), then north.
function roundabout3(exitAt: 'N' | 'E' = 'N') {
  const r = 15;
  const approach = polyline3([[0, -300], [0, -r]]);
  const arc: Array<[number, number]> = [];
  // Clockwise from the south point: angle (from north, clockwise) 180 → 270 → 360(0) [→ 90 for E]
  const end = exitAt === 'N' ? 360 : 450;
  for (let a = 180 + 15; a <= end; a += 15) arc.push([r * Math.sin((a * Math.PI) / 180), r * Math.cos((a * Math.PI) / 180)]);
  const exitLine = exitAt === 'N' ? polyline3([[0, r], [0, 400]]).slice(1) : polyline3([[r, 0], [400, 0]]).slice(1);
  const pts = [...approach, ...arc, ...exitLine];
  const entry = approach.length - 1;
  return {
    pts, entry, exitIndex: approach.length + arc.length - 1,
    route: route3(pts, [
      { at: 0, type: 'depart', name: 'Station Road' },
      { at: entry, type: 'roundabout', modifier: exitAt === 'N' ? 'straight' : 'right', exit: exitAt === 'N' ? 2 : 3, name: 'A591', instruction: `At the roundabout, take the ${exitAt === 'N' ? '2nd' : '3rd'} exit onto the A591` },
      { at: pts.length - 1, type: 'arrive' },
    ]),
  };
}

test('guidance: UK roundabouts: the exit number comes from the data, and is held until the exit', () => {
  const { route, pts, exitIndex } = roundabout3('N');
  const p = prepareRoute(route);
  const m = p.maneuvers[1]!;
  assert.equal(m.kind, 'roundabout');
  assert.equal(m.exit, 2, 'structured exit, not parsed from text');
  assert.equal(m.direction, 'straight');
  assert.equal(m.drivingSide, 'left');
  // The exit is found where the clockwise circulation ends (the north point)
  let cum = 0;
  for (let i = 1; i <= exitIndex; i++) cum += Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]);
  assert.ok(Math.abs(p.holdUntil[1]! - cum) < 8, `exit at ${p.holdUntil[1]} vs ${cum}`);
  // On the roundabout, before the exit: still "take the 2nd exit", distance to the exit
  const mid = progressAt(p, p.stepStart[1]! + 10);
  assert.equal(mid.onRoundabout, true);
  assert.equal(mid.next.kind, 'roundabout');
  assert.equal(mid.next.exit, 2);
  assert.ok(mid.distanceToNextM > 0 && mid.distanceToNextM < 40);
  // Past the exit: the next instruction
  const after = progressAt(p, p.holdUntil[1]! + 5);
  assert.equal(after.onRoundabout, false);
  assert.equal(after.next.kind, 'arrive');
  // A 3rd exit goes further round
  const third = prepareRoute(roundabout3('E').route);
  assert.equal(third.maneuvers[1]!.exit, 3);
  assert.ok(third.holdUntil[1]! - third.stepStart[1]! > p.holdUntil[1]! - p.stepStart[1]!);
  // Driving round with GPS cutting the corner never flags off-route
  const session = nav3Session();
  session.s.start({ route, destination: N3_DEST });
  for (const f of drive3(pts, { speed: 8, noise: 8, seed: 11 })) session.s.noteFix(f);
  assert.notEqual(session.phases.includes('offRoute'), true);
  assert.equal(session.s.phase, 'arrived');
});

test('guidance: mini roundabouts and closely spaced manoeuvres show "then"', () => {
  const pts = polyline3([[0, 0], [0, 600], [0, 700], [-300, 700]]);
  const r = route3(pts, [
    { at: 0, type: 'depart' },
    { at: 60, type: 'roundabout turn', modifier: 'straight', name: 'Main Street', instruction: 'At the roundabout, go straight on' },
    { at: 70, type: 'turn', modifier: 'left', name: 'Mill Lane' },
    { at: pts.length - 1, type: 'arrive' },
  ]);
  const p = prepareRoute(r);
  assert.equal(p.maneuvers[1]!.kind, 'miniRoundabout');
  assert.equal(p.maneuvers[1]!.exit, null);
  // A mini roundabout has no circulation to hold
  assert.equal(p.holdUntil[1], p.stepStart[1]);
  const pr = progressAt(p, 400);
  assert.equal(pr.next.kind, 'miniRoundabout');
  assert.equal(pr.then?.kind, 'turn', 'the left turn 100 m after it shows as "then"');
  assert.equal(pr.then?.direction, 'left');
  assert.equal(progressAt(p, 50).then?.kind, 'turn');
});

const N3_DEST = { id: 'place:p1', name: 'Brow Top', subtitle: 'Saved place', coordinate: at3(-600, 1400), source: 'saved' as const };
/** A route as the API sends it */
function serverRoutes3(...routes: Nav3Route[]): ServerRoutes {
  return {
    provider: 'mapbox', providerResponseId: null,
    routes: routes.map((r, index) => ({
      index, geometry: encodePolyline(r.geometry.map((p) => ({ lat: p.latitude, lng: p.longitude })), 6),
      distanceM: r.distanceM, durationS: r.durationS, typicalDurationS: null, summary: r.summary,
      legs: r.legs.map((l) => ({ ...l, steps: l.steps.map((s) => ({ ...s, maneuver: { ...s.maneuver, location: { lat: s.maneuver.location.latitude, lng: s.maneuver.location.longitude } } })) })),
    })),
  };
}
/** A NavigationSession on a hand-driven clock, with a fake route server and an in-memory journal */
function nav3Session(opts: { fetch?: (body: unknown) => Promise<ServerRoutes>; journal?: DiagnosticsJournal } = {}) {
  const clock = { t: 1_000_000 };
  const timers: Array<{ fn: () => void; at: number; id: number }> = [];
  let tid = 0;
  const bodies: unknown[] = [];
  const s = new NavigationSession({
    fetchRoutes: (body) => { bodies.push(body); return opts.fetch ? opts.fetch(body) : Promise.resolve(serverRoutes3(L_ROUTE())); },
    describe: (e) => ({ code: (e as { code?: string }).code ?? 'network', message: (e as Error).message ?? 'failed' }),
    now: () => clock.t,
    setTimer: (fn, ms) => { const id = ++tid; timers.push({ fn, at: clock.t + ms, id }); return id; },
    clearTimer: (id) => { const i = timers.findIndex((x) => x.id === id); if (i >= 0) timers.splice(i, 1); },
    journal: opts.journal,
  });
  const phases: string[] = [];
  const states: NavigationState[] = [];
  s.subscribe(() => { states.push(s.state); if (phases[phases.length - 1] !== s.phase) phases.push(s.phase); });
  const runTimers = () => {
    for (;;) {
      const due = timers.filter((x) => x.at <= clock.t).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      timers.splice(timers.indexOf(due), 1);
      due.fn();
    }
  };
  const feed = (fixes: GpsFix[]) => { for (const f of fixes) { clock.t = f.time; runTimers(); s.noteFix(f); } };
  const advance = (ms: number) => { clock.t += ms; runTimers(); };
  return { s, clock, phases, states, bodies, feed, advance };
}
const active3 = (st: NavigationState) => (st.phase === 'starting' || st.phase === 'navigating' || st.phase === 'offRoute' || st.phase === 'rerouting' ? st : null);

test('guidance session: start → navigating on the first fix → arrived → Done; End at any time', () => {
  const h = nav3Session();
  void h.s.start({ route: L_ROUTE(), destination: N3_DEST });
  assert.equal(h.s.phase, 'starting');
  assert.equal(active3(h.s.state)!.starting, 'locating');
  assert.equal(active3(h.s.state)!.progress, null);
  h.feed(drive3(L_PTS, { noise: 4, to: 50 }));
  assert.equal(h.s.phase, 'navigating');
  assert.equal(active3(h.s.state)!.progress!.next.instruction, 'Turn left onto Chestnut Hill');
  h.feed(drive3(L_PTS, { noise: 4, from: 60, t0: 1_100_000 }));
  assert.equal(h.s.phase, 'arrived');
  assert.deepEqual(h.phases, ['starting', 'navigating', 'arrived']);
  assert.equal(h.s.map.route, null, 'nothing left to draw but the destination');
  h.s.end('arrived');
  assert.equal(h.s.phase, 'idle');
  // End part way: idle at once, later fixes do nothing
  const e = nav3Session();
  void e.s.start({ route: L_ROUTE(), destination: N3_DEST });
  e.feed(drive3(L_PTS, { to: 300 }));
  e.s.end('user');
  assert.equal(e.s.phase, 'idle');
  e.feed(drive3(L_PTS, { from: 310, t0: 2_000_000 }));
  assert.equal(e.s.phase, 'idle');
  assert.equal(e.s.map.route, null);
});

/** A route server whose answers the test gives out, one request at a time */
function routeServer3() {
  const pending: Array<{ resolve: (v: ServerRoutes) => void; reject: (e: unknown) => void }> = [];
  return {
    pending,
    fetch: () => new Promise<ServerRoutes>((resolve, reject) => { pending.push({ resolve, reject }); }),
    answer(v: ServerRoutes) { pending.shift()!.resolve(v); },
    fail(code: string) { pending.shift()!.reject(Object.assign(new Error(code), { code })); },
  };
}
/** Lets answered requests land */
const settle3 = () => new Promise<void>((r) => setImmediate(r));
/** A new route from just past the missed left turn: north, then west and back south to the destination */
const FRESH3 = () => route3(polyline3([[0, 1050], [0, 1500], [-600, 1500], [-600, 1400]]), [
  { at: 0, type: 'depart' }, { at: 45, type: 'turn', modifier: 'left' }, { at: 105, type: 'turn', modifier: 'left' }, { at: 115, type: 'arrive' },
], 'n:0');

test('guidance session: off route needs repeated, accurate, travelling fixes; one bad point never does it', async () => {
  const srv = routeServer3();
  const h = nav3Session({ fetch: srv.fetch });
  void h.s.start({ route: L_ROUTE(), destination: N3_DEST });
  h.feed(drive3(L_PTS, { to: 600 }));
  assert.equal(h.s.phase, 'navigating');
  const t = h.clock.t;
  // One wild point 90 m off, then back on the road: still navigating
  h.feed([fix3(90, 620, t + 1000, { headingDeg: 0 })]);
  h.feed(drive3(L_PTS, { from: 630, to: 700, t0: t + 2000 }));
  assert.equal(h.s.phase, 'navigating');
  // Poor GPS (accuracy 80 m) far off for 20 s: suppressed, not off route
  const t2 = h.clock.t;
  h.feed(Array.from({ length: 20 }, (_, i) => fix3(120, 710 + i * 2, t2 + 1000 * (i + 1), { accuracyM: 80, headingDeg: 0 })));
  assert.notEqual(h.s.phase, 'offRoute');
  assert.equal(active3(h.s.state)!.gps, 'weak');
  assert.equal(h.bodies.length, 0, 'noise never asks for a route');
  // Missing the left turn and carrying on north: off route within a few
  // seconds of leaving it, and a new route is on its way by itself
  const t3 = h.clock.t;
  h.feed(drive3(polyline3([[0, 720], [0, 1400]]), { t0: t3 + 1000, noise: 3 }));
  assert.ok(h.phases.includes('offRoute'));
  assert.equal(h.s.phase, 'rerouting');
  assert.equal(h.bodies.length, 1);
  const offAt = h.states.findIndex((st) => st.phase === 'offRoute');
  assert.ok(offAt > 0);
  // Back onto the route before the answer: that answer is dropped, the route stays
  const route = active3(h.s.state)!.route;
  h.feed(drive3(L_PTS, { from: 1100, to: 1300, t0: h.clock.t + 1000 }));
  srv.answer(serverRoutes3(FRESH3()));
  await settle3();
  assert.equal(h.s.phase, 'navigating');
  assert.equal(active3(h.s.state)!.route, route, 'back on the route: the old route is still the one');
  assert.equal(h.bodies.length, 1);
});

test('off-route detector: thresholds, confirmation, accuracy suppression, wrong way, back on', () => {
  const d = new OffRouteDetector();
  const base = { latitude: 54.6, longitude: -3.13, accuracyM: 8, speedMs: 13, headingDiff: 5, nearManeuver: false };
  const at = (i: number, o: Partial<typeof base & { lateralM: number }> = {}) => ({ ...base, lateralM: 10, time: i * 1000, ...o, latitude: 54.6 + i * 0.00012 });
  assert.equal(d.update(at(1, { lateralM: 60 })), 'on', 'one point is never enough');
  assert.equal(d.update(at(2, { lateralM: 60 })), 'on');
  assert.equal(d.update(at(3, { lateralM: 10 })), 'on', 'a good point clears suspicion');
  for (let i = 4; i <= 9; i++) d.update(at(i, { lateralM: 60 }));
  assert.equal(d.state, 'on', 'five seconds is not yet enough');
  d.update(at(10, { lateralM: 60 }));
  assert.equal(d.state, 'off', 'six seconds, travelling, away: off route');
  assert.equal(d.update(at(11, { lateralM: 10 })), 'off', 'one close point is not back yet');
  assert.equal(d.update(at(12, { lateralM: 10 })), 'on', 'two are');
  // Poor accuracy counts for nothing
  const p = new OffRouteDetector();
  for (let i = 1; i <= 20; i++) p.update(at(i, { lateralM: 90, accuracyM: 70 }));
  assert.equal(p.state, 'on');
  // Threshold grows with inaccuracy: 40 m away at 30 m accuracy is within the noise
  assert.equal(awayThresholdM(30), 55);
  assert.equal(awayThresholdM(5), OFF_ROUTE.minThresholdM);
  // Clearly gone: two fixes 200 m away is enough
  const f = new OffRouteDetector();
  f.update(at(1, { lateralM: 200 }));
  assert.equal(f.update(at(2, { lateralM: 200 })), 'off');
  // Wrong way along the route, moving, away from junctions
  const w = new OffRouteDetector();
  for (let i = 1; i <= 4; i++) w.update(at(i, { headingDiff: 175 }));
  assert.equal(w.state, 'off');
  // ...but not near a manoeuvre (roundabouts, junctions)
  const r = new OffRouteDetector();
  for (let i = 1; i <= 10; i++) r.update(at(i, { headingDiff: 175, nearManeuver: true }));
  assert.equal(r.state, 'on');
  // A gap in fixes (GPS lost) starts judging over
  const g = new OffRouteDetector();
  g.update(at(1, { lateralM: 60 }));
  g.update(at(2, { lateralM: 60 }));
  g.update({ ...at(30, { lateralM: 60 }) });
  assert.equal(g.state, 'on');
});

/** Missing the left turn and driving on north, one fix a second (noise-free) */
const offNorth3 = (t0: number, toY = 1400, speed = 13) => drive3(polyline3([[0, 720], [0, toY]]), { t0, noise: 0, speed });
/** Feeds fixes one at a time; when each route request was made (clock ms) */
function feedWatching3(h: ReturnType<typeof nav3Session>, fixes: GpsFix[], until?: () => boolean) {
  const at: number[] = [];
  for (const f of fixes) {
    const before = h.bodies.length;
    h.feed([f]);
    if (h.bodies.length > before) at.push(h.clock.t);
    if (until?.()) break;
  }
  return at;
}

test('auto reroute: once confirmed off route, exactly one request, from the car (position, heading, speed, accuracy); the new route replaces the old', async () => {
  const srv = routeServer3();
  const h = nav3Session({ fetch: srv.fetch });
  void h.s.start({ route: L_ROUTE(), destination: N3_DEST });
  h.feed(drive3(L_PTS, { to: 700 }));
  const oldRoute = active3(h.s.state)!.route;
  const off = offNorth3(h.clock.t + 1000);
  const reqAt = feedWatching3(h, off);
  assert.equal(reqAt.length, 1, 'one request, however many off-route fixes follow');
  const sentFix = off.find((f) => f.time === reqAt[0])!;
  assert.ok(off.indexOf(sentFix) >= OFF_ROUTE.confirmFixes, 'never on the first fix away from the route');
  assert.ok(h.phases.indexOf('offRoute') < h.phases.indexOf('rerouting'), "You're off route, then Updating route");
  // From the fix that confirmed it: where the car is, the way it's heading, its speed and accuracy
  const body = h.bodies[0] as { origin: { lat: number; lng: number; headingDeg: number | null; speedMs?: number; accuracyM?: number }; destination: unknown };
  assert.equal(body.origin.lat, sentFix.latitude);
  assert.equal(body.origin.lng, sentFix.longitude);
  assert.equal(body.origin.headingDeg, sentFix.headingDeg, 'north');
  assert.equal(body.origin.speedMs, 13);
  assert.equal(body.origin.accuracyM, 8);
  assert.deepEqual(body.destination, { lat: N3_DEST.coordinate.latitude, lng: N3_DEST.coordinate.longitude });
  // Meanwhile the old route stays on screen
  assert.equal(h.s.phase, 'rerouting');
  assert.equal(active3(h.s.state)!.route, oldRoute);
  const fresh = FRESH3();
  srv.answer(serverRoutes3(fresh));
  await settle3();
  const st = active3(h.s.state)!;
  assert.equal(h.s.phase, 'navigating');
  assert.notEqual(st.route, oldRoute);
  assert.equal(st.route.geometry.length, fresh.geometry.length);
  assert.ok(st.progress, 'the car is found on the new route straight away');
  assert.equal(st.updateFailed, false);
  assert.equal(h.s.map.route, st.route, 'the map draws the new route');
  // The new route's own line is what's drawn now (from where the car is on it)
  assert.ok(h.s.map.remaining!.length <= prepareRoute(st.route).n);
});

test('auto reroute: a cooldown after each new route; off again soon after waits for it', async () => {
  const srv = routeServer3();
  const h = nav3Session({ fetch: srv.fetch });
  void h.s.start({ route: L_ROUTE(), destination: N3_DEST });
  h.feed(drive3(L_PTS, { to: 700 }));
  const off = offNorth3(h.clock.t + 1000);
  feedWatching3(h, off, () => h.bodies.length === 1);
  srv.answer(serverRoutes3(FRESH3()));
  await settle3();
  const doneAt = h.clock.t;
  assert.equal(h.s.phase, 'navigating');
  // Straight away off the new route as well (east, into a side road): off route again within the cooldown
  const y = (off.find((f) => f.time === doneAt)!.latitude - N3_BASE.latitude) * N3_M;
  const again = drive3(polyline3([[0, y], [800, y]]), { t0: h.clock.t + 1000, noise: 0 });
  let offWhileCooling = false;
  const reqAt = feedWatching3(h, again, () => {
    if (h.s.phase === 'offRoute' && h.clock.t - doneAt < REROUTE.cooldownMs) offWhileCooling = true;
    return h.bodies.length === 2;
  });
  assert.ok(offWhileCooling, 'off route again inside the cooldown: no request yet');
  assert.equal(reqAt.length, 1);
  assert.ok(reqAt[0]! - doneAt >= REROUTE.cooldownMs, `asked ${reqAt[0]! - doneAt} ms after the last new route`);
  assert.ok(reqAt[0]! - doneAt < REROUTE.cooldownMs + 2000, 'and soon after it ends');
});

test('auto reroute: a failure keeps the old route ("Route update unavailable"); waits grow; Try Again after repeated failures; a cap per ten minutes', async () => {
  const srv = routeServer3();
  const h = nav3Session({ fetch: srv.fetch });
  void h.s.start({ route: L_ROUTE(), destination: N3_DEST });
  h.feed(drive3(L_PTS, { to: 700 }));
  const oldRoute = active3(h.s.state)!.route;
  // A long way off the route: 13 m/s north for 12 minutes
  const off = offNorth3(h.clock.t + 1000, 720 + 13 * 720);
  let i = 0;
  const next = () => {
    const before = h.bodies.length;
    while (i < off.length && h.bodies.length === before) h.feed([off[i++]!]);
    assert.ok(h.bodies.length > before, 'another request came');
    return h.clock.t;
  };
  const times = [next()];
  srv.fail('offline');
  await settle3();
  let st = active3(h.s.state)!;
  assert.equal(h.s.phase, 'offRoute');
  assert.equal(st.route, oldRoute, 'the old route stays');
  assert.equal(st.updateFailed, true);
  assert.equal(st.notice, 'Route update unavailable');
  assert.equal(st.canRetry, false, 'no button after one failure');
  // 10 s, then 20 s, then 40 s...
  times.push(next());
  srv.fail('offline');
  await settle3();
  times.push(next());
  srv.fail('offline');
  await settle3();
  st = active3(h.s.state)!;
  assert.equal(st.canRetry, true, 'Try Again only after repeated failures');
  const gaps = times.slice(1).map((t, k) => t - times[k]!);
  assert.ok(gaps[0]! >= 10_000 && gaps[0]! < 12_000, `first wait ${gaps[0]}`);
  assert.ok(gaps[1]! >= 20_000 && gaps[1]! < 22_000, `second wait ${gaps[1]}`);
  // Try Again: one request now, however often it's tapped
  const retry = h.s.retryReroute();
  void h.s.retryReroute();
  assert.equal(h.bodies.length, 4);
  srv.fail('rate_limited');
  await retry;
  // The API's own limit: the longest wait
  times.push(h.clock.t);
  times.push(next());
  assert.ok(times[4]! - times[3]! >= REROUTE.maxBackoffMs, 'after rate_limited, a minute');
  srv.fail('offline');
  await settle3();
  times.push(next());
  srv.fail('offline');
  await settle3();
  times.push(next());
  srv.fail('offline');
  await settle3();
  // Six automatic requests in ten minutes at most (the retry was the user's)
  const auto = times.filter((_, k) => k !== 3);
  assert.equal(auto.length, 6);
  const before = h.bodies.length;
  while (i < off.length && h.bodies.length === before) h.feed([off[i++]!]);
  assert.ok(h.bodies.length > before, 'a seventh, once ten minutes have passed');
  assert.ok(h.clock.t - auto[0]! >= REROUTE.windowMs, `the seventh came ${h.clock.t - auto[0]!} ms after the first`);
  assert.equal(active3(h.s.state)!.route, oldRoute, 'every failure kept the old route');
  // Back on the route: the failure no longer shows
  srv.fail('offline');
  await settle3();
  h.feed(drive3(L_PTS, { from: 1100, to: 1300, t0: h.clock.t + 1000 }));
  st = active3(h.s.state)!;
  assert.equal(h.s.phase, 'navigating');
  assert.equal(st.updateFailed, false);
  assert.equal(st.notice, null);
  assert.equal(st.canRetry, false);
});

test('auto reroute: stale answers are dropped; never while off screen; slow cars send no heading', async () => {
  // Ended while a request is in flight: its answer does nothing
  const srv = routeServer3();
  const h = nav3Session({ fetch: srv.fetch });
  void h.s.start({ route: L_ROUTE(), destination: N3_DEST });
  h.feed(drive3(L_PTS, { to: 700 }));
  // Off screen (the app in the background): off route, but no request
  h.s.setForeground(false);
  const off = offNorth3(h.clock.t + 1000);
  feedWatching3(h, off.slice(0, 40));
  assert.equal(h.s.phase, 'offRoute');
  assert.equal(h.bodies.length, 0, 'nothing requested off screen');
  h.s.setForeground(true);
  feedWatching3(h, off.slice(40, 42));
  assert.equal(h.bodies.length, 1, 'back on screen and still off route: one request');
  h.s.end('user');
  srv.answer(serverRoutes3(FRESH3()));
  await settle3();
  assert.equal(h.s.phase, 'idle');
  assert.equal(h.s.map.route, null);
  // Replaced by a new navigation meanwhile: the old answer is not the new one's route
  const r = nav3Session({ fetch: srv.fetch });
  void r.s.start({ route: L_ROUTE(), destination: N3_DEST });
  r.feed(drive3(L_PTS, { to: 700 }));
  feedWatching3(r, offNorth3(r.clock.t + 1000), () => r.bodies.length === 1);
  const second = L_ROUTE();
  void r.s.start({ route: second, destination: N3_DEST });
  srv.answer(serverRoutes3(FRESH3()));
  await settle3();
  assert.equal(active3(r.s.state)!.route, second);
  // Below about 10 km/h the GPS course is noise: no heading constraint
  const slow = nav3Session({ fetch: srv.fetch });
  void slow.s.start({ route: L_ROUTE(), destination: N3_DEST });
  slow.feed(drive3(L_PTS, { to: 700 }));
  feedWatching3(slow, offNorth3(slow.clock.t + 1000, 1400, 2.5), () => slow.bodies.length === 1);
  const o = (slow.bodies[0] as { origin: { headingDeg: number | null; speedMs?: number } }).origin;
  assert.equal(o.headingDeg, null);
  assert.equal(o.speedMs, 2.5);
});

test('guidance session: arrival is conservative: close, accurate, and confirmed', () => {
  const h = nav3Session();
  void h.s.start({ route: L_ROUTE(), destination: N3_DEST });
  h.feed(drive3(L_PTS, { to: 1900 }));
  assert.equal(h.s.phase, 'navigating', '100 m short: not arrived');
  const along = active3(h.s.state)!.progress!.along;
  // A poor fix (60 m accuracy) right at the end: GPS is weak, nothing moves, no arrival
  h.feed([fix3(-600, 1400, h.clock.t + 1000, { accuracyM: 60, headingDeg: 0 })]);
  assert.equal(h.s.phase, 'navigating');
  assert.equal(active3(h.s.state)!.gps, 'weak');
  assert.equal(active3(h.s.state)!.progress!.along, along);
  // Slowing down to the end: arrives only once close, slow, and confirmed
  const slowDown: Array<[number, number]> = [[1310, 8], [1330, 6], [1345, 4], [1360, 2.5]];
  for (const [y, v] of slowDown) h.feed([fix3(-600, y, h.clock.t + 1000, { speedMs: v, headingDeg: 0 })]);
  assert.equal(h.s.phase, 'navigating', 'one slow fix 40 m short is not enough');
  h.feed([fix3(-600, 1361, h.clock.t + 1000, { speedMs: 0.5, headingDeg: 0 })]);
  assert.equal(h.s.phase, 'arrived');
  const st = h.s.state as Extract<NavigationState, { phase: 'arrived' }>;
  assert.equal(st.destination, N3_DEST);
});

test('guidance session: GPS lost shows, nothing advances blind, and it recovers by itself', () => {
  const h = nav3Session();
  void h.s.start({ route: L_ROUTE(), destination: N3_DEST });
  h.feed(drive3(L_PTS, { to: 400 }));
  const before = active3(h.s.state)!.progress!.along;
  h.advance(NAVIGATION.gpsLostMs + 1);
  assert.equal(active3(h.s.state)!.gps, 'lost');
  assert.equal(h.s.phase, 'navigating', 'losing GPS is not leaving the route');
  assert.equal(active3(h.s.state)!.progress!.along, before, 'no step advanced without fixes');
  h.advance(60_000);
  assert.equal(h.s.phase, 'navigating');
  // Back after a minute, 800 m further on: found again (wider search after a gap)
  h.feed([fix3(0, 1200 - 400, h.clock.t + 1000, { headingDeg: 0 })]);
  assert.equal(active3(h.s.state)!.gps, 'ok');
  assert.ok(active3(h.s.state)!.progress!.along > 750);
});

test('guidance session: a new start replaces the old session; an unusable route is an error, not a crash', () => {
  const h = nav3Session();
  void h.s.start({ route: L_ROUTE(), destination: N3_DEST });
  h.feed(drive3(L_PTS, { to: 300 }));
  const first = (h.s.state as { sessionId: number }).sessionId;
  // A route 5 km away: the last fix isn't on it, so it waits to find the car
  const elsewhere = route3(polyline3([[5000, 5000], [5000, 6000], [5600, 6000]]), [{ at: 0, type: 'depart' }, { at: 100, type: 'turn', modifier: 'right' }, { at: 160, type: 'arrive' }]);
  void h.s.start({ route: elsewhere, destination: { ...N3_DEST, id: 'coord:1', source: 'coordinates' } });
  assert.equal(h.s.phase, 'starting');
  assert.ok((h.s.state as { sessionId: number }).sessionId > first);
  const bad = L_ROUTE();
  bad.legs[0]!.steps = bad.legs[0]!.steps.slice(0, 1);
  void h.s.start({ route: bad, destination: N3_DEST });
  assert.equal(h.s.phase, 'error');
  assert.match((h.s.state as { message: string }).message, /turn-by-turn/);
  h.s.end('user');
  assert.equal(h.s.phase, 'idle');
});

test('manoeuvres: Mapbox steps become a small model: banner and voice from the step before, exit from the data', () => {
  const base = L_ROUTE().legs[0]!.steps;
  const steps: Nav3Step[] = [
    { ...base[0]!, banner: { primary: 'Chestnut Hill', secondary: 'Keswick' }, voice: [{ distanceBeforeM: 50, text: 'Bear left' }, { distanceBeforeM: 800, text: 'In half a mile, bear left' }] },
    { ...base[1]!, maneuver: { ...base[1]!.maneuver, type: 'turn', modifier: 'slight left', instruction: 'Bear left onto Chestnut Hill' }, roadName: 'Chestnut Hill', roadRef: 'B5289', junctionRef: '36', signposts: 'Keswick' },
    // The text says 5th, the data says 2nd: the data wins (never parsed from words)
    { ...base[2]!, maneuver: { ...base[2]!.maneuver, type: 'roundabout', modifier: 'straight', exit: 2, instruction: 'At the roundabout, take the 5th exit' } },
    { ...base[3]!, maneuver: { ...base[3]!.maneuver, type: 'exit roundabout', modifier: 'right', exit: 2, instruction: null }, roadName: 'A591', roadRef: null },
    { ...base[3]!, maneuver: { ...base[3]!.maneuver, type: 'on ramp', modifier: 'slight right', instruction: null }, roadName: null, roadRef: 'M6' },
    { ...base[3]!, maneuver: { ...base[3]!.maneuver, type: 'continue', modifier: 'uturn', instruction: null }, drivingSide: 'right' },
    { ...base[3]!, maneuver: { ...base[3]!.maneuver, type: 'roundabout turn', modifier: 'left', exit: 1, instruction: null }, roadName: 'Mill Lane' },
    base[3]!,
  ];
  const m = maneuversFor(steps);
  assert.equal(m[0]!.kind, 'depart');
  assert.equal(m[1]!.kind, 'turn');
  assert.equal(m[1]!.direction, 'slightLeft');
  assert.equal(m[1]!.instruction, 'Bear left onto Chestnut Hill', "Mapbox's own en-GB words");
  assert.equal(m[1]!.primaryText, 'Chestnut Hill', 'the banner comes from the step before');
  assert.equal(m[1]!.secondaryText, 'Keswick');
  assert.deepEqual(m[1]!.voice.map((v) => v.distanceBeforeM), [800, 50], 'voice prompts kept for Phase 5, farthest first');
  assert.equal(m[1]!.junctionRef, '36');
  assert.equal(m[1]!.lanes, null, 'no lane data from the API yet: kept as null, never invented');
  assert.equal(roadLabel(steps[1]!), 'B5289 Chestnut Hill');
  assert.equal(m[2]!.kind, 'roundabout');
  assert.equal(m[2]!.exit, 2);
  assert.equal(m[3]!.kind, 'roundaboutExit');
  assert.equal(m[3]!.instruction, 'Exit the roundabout onto A591', 'composed only when Mapbox gave none');
  assert.equal(m[4]!.kind, 'onRamp');
  assert.equal(m[4]!.instruction, 'Take the slip road onto M6');
  assert.equal(m[5]!.kind, 'uturn');
  assert.equal(m[5]!.drivingSide, 'right');
  assert.equal(m[6]!.kind, 'miniRoundabout');
  assert.equal(m[6]!.instruction, 'At the roundabout, take the 1st exit onto Mill Lane');
  assert.equal(m[7]!.kind, 'arrive');
  assert.deepEqual([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101, 111].map(ordinal), ['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '23rd', '101st', '111th']);
  assert.equal(maneuverFor(steps, 1).stepIndex, 1);
});

test('guidance distances read the UK way: yards under a tenth of a mile, then miles; never feet', () => {
  assert.equal(formatGuidanceDistance(5, 'imperial'), '10 yd');
  assert.equal(formatGuidanceDistance(100, 'imperial'), '110 yd');
  assert.equal(formatGuidanceDistance(274, 'imperial'), '0.2 mi');
  assert.equal(formatGuidanceDistance(150, 'imperial'), '160 yd');
  assert.equal(formatGuidanceDistance(161, 'imperial'), '0.1 mi');
  assert.equal(formatGuidanceDistance(483, 'imperial'), '0.3 mi');
  assert.equal(formatGuidanceDistance(26_400, 'imperial'), '16 mi');
  assert.equal(formatGuidanceDistance(14_000, 'imperial'), '8.7 mi');
  assert.equal(formatGuidanceDistance(450, 'metric'), '450 m');
  assert.equal(formatGuidanceDistance(1234, 'metric'), '1.2 km');
  for (const m of [3, 30, 120, 160, 900, 5000]) assert.ok(!/ft|feet/.test(formatGuidanceDistance(m, 'imperial')));
  // Arrival time: the clock time, 24-hour
  assert.equal(formatClock(arrivalTime(new Date(2026, 9, 9, 23, 50).getTime(), 1500)), '00:15');
  assert.equal(formatDuration(1980), '33 min');
});

test('guidance camera: zoom by speed band with hysteresis, closer for a turn in town, never pumping', () => {
  const t0 = 1_000_000;
  let z = guidanceZoom(null, { speedKmh: 30, distanceToNextM: 900, nextKind: 'turn', now: t0 });
  assert.equal(z.zoom, GUIDANCE_CAMERA.bands[0]!.zoom);
  // Hovering around the band edge never flips it
  for (let i = 1; i <= 10; i++) z = guidanceZoom(z, { speedKmh: i % 2 ? 58 : 52, distanceToNextM: 900, nextKind: 'turn', now: t0 + i * 10_000 });
  assert.equal(z.band, 0);
  // Clearly faster: the next band, but not before minIntervalMs since the last change
  z = guidanceZoom(z, { speedKmh: 75, distanceToNextM: 2000, nextKind: 'turn', now: t0 + 120_000 });
  assert.equal(z.band, 1);
  const changed = z.changedAt;
  const motorway = guidanceZoom(z, { speedKmh: 110, distanceToNextM: 5000, nextKind: 'offRamp', now: changed + 1000 });
  assert.equal(motorway.zoom, z.zoom, 'held: changed less than 4 s ago');
  const later = guidanceZoom(z, { speedKmh: 110, distanceToNextM: 5000, nextKind: 'offRamp', now: changed + GUIDANCE_CAMERA.minIntervalMs + 1 });
  assert.equal(later.zoom, GUIDANCE_CAMERA.bands[2]!.zoom);
  // A turn ahead in town zooms in at once (never held back)
  const town = guidanceZoom(null, { speedKmh: 40, distanceToNextM: 1000, nextKind: 'turn', now: t0 });
  const approach = guidanceZoom(town, { speedKmh: 40, distanceToNextM: 150, nextKind: 'turn', now: t0 + 500 });
  assert.equal(approach.approaching, true);
  assert.ok(approach.zoom > town.zoom);
  // Not for arriving, not at motorway speed
  assert.equal(guidanceZoom(null, { speedKmh: 40, distanceToNextM: 100, nextKind: 'arrive', now: t0 }).approaching, false);
  assert.equal(guidanceZoom(null, { speedKmh: 110, distanceToNextM: 100, nextKind: 'offRamp', now: t0 }).approaching, false);
});

test('Start Navigation: every kind of destination becomes the same session, from the same preview', async () => {
  const sources = [
    { id: 'place:1', name: 'Home', subtitle: 'Saved place', source: 'saved' as const },
    { id: 'spot:2', name: 'Ashness Bridge', subtitle: 'Beauty Spot', source: 'spot' as const },
    { id: 'search:poi.9', name: 'Booths', subtitle: 'Lake Road, Keswick', source: 'search' as const },
    { id: 'coord:54.70000,-3.00000', name: 'Dropped Pin', subtitle: '54.70000, -3.00000', source: 'pin' as const },
    { id: 'coord:54.71000,-3.01000', name: 'Dropped Pin', subtitle: '54.71000, -3.01000', source: 'coordinates' as const },
  ];
  for (const src of sources) {
    const dest = { ...src, coordinate: at3(-600, 1400) };
    const preview = new RoutePreviewStore({
      fetchRoutes: async () => serverRoutes3(L_ROUTE()),
      describe: (e) => ({ code: 'x', message: String(e) }),
      now: () => 1_000_000, setTimer: () => 1, clearTimer: () => {},
    });
    await preview.open(dest, { coordinate: at3(0, 0), headingDeg: null });
    assert.equal(preview.phase, 'preview', src.source);
    const h = nav3Session();
    const started = await startFromPreview(preview, h.s, async () => ({ coordinate: at3(0, 0), headingDeg: null }));
    assert.equal(started, true, src.source);
    assert.equal(preview.phase, 'idle', 'the preview closes');
    assert.equal(h.s.phase, 'starting');
    assert.equal(h.bodies.length, 0, 'a current preview starts without another request');
    assert.equal((h.s.state as { destination: { id: string } }).destination.id, dest.id);
    h.feed(drive3(L_PTS, { to: 100 }));
    assert.equal(h.s.phase, 'navigating', src.source);
  }
});

test('Start Navigation with an out-of-date preview asks for one fresh route, and falls back to the old one', async () => {
  const preview = new RoutePreviewStore({
    fetchRoutes: async () => serverRoutes3(L_ROUTE()),
    describe: (e) => ({ code: 'x', message: String(e) }),
    now: () => 1_000_000, setTimer: () => 1, clearTimer: () => {},
  });
  await preview.open(N3_DEST, { coordinate: at3(0, 0), headingDeg: null });
  preview.noteFix(at3(0, 500), 1_000_500);
  assert.ok((preview.state as { stale: string | null }).stale);
  const h = nav3Session();
  await startFromPreview(preview, h.s, async () => ({ coordinate: at3(0, 500), headingDeg: 0 }));
  assert.equal(h.bodies.length, 1, 'one request, from where the car is now');
  assert.deepEqual((h.bodies[0] as { origin: { lat: number } }).origin.lat, at3(0, 500).latitude);
  assert.equal(h.s.phase, 'starting');
  // Failing: the earlier route, with a notice
  const p2 = new RoutePreviewStore({
    fetchRoutes: async () => serverRoutes3(L_ROUTE()),
    describe: (e) => ({ code: 'x', message: String(e) }),
    now: () => 1_000_000, setTimer: () => 1, clearTimer: () => {},
  });
  await p2.open(N3_DEST, { coordinate: at3(0, 0), headingDeg: null });
  p2.noteFix(at3(0, 500), 1_000_500);
  const failing = nav3Session({ fetch: async () => { throw new Error('offline'); } });
  await startFromPreview(p2, failing.s, async () => ({ coordinate: at3(0, 500), headingDeg: 0 }));
  assert.equal(failing.s.phase, 'starting');
  assert.match((failing.s.state as { notice: string }).notice, /earlier one/);
  assert.equal(failing.bodies.length, 1);
});

test('guidance privacy: nothing is stored; the diagnostics journal has events, never places, roads or positions', async () => {
  const store = new MemoryStore();
  const journal = new DiagnosticsJournal({ store, now: () => 0 });
  let fail = true;
  const h = nav3Session({
    journal,
    fetch: async () => { if (fail) { fail = false; throw Object.assign(new Error('offline'), { code: 'offline' }); } return serverRoutes3(L_ROUTE()); },
  });
  const searched = { id: 'search:poi.77', name: 'Secret Café', subtitle: '12 Hidden Lane, Keswick', coordinate: at3(-600, 1400), source: 'search' as const };
  void h.s.start({ route: L_ROUTE(), destination: searched });
  // Round the first turn (a step change), then off the route heading north
  h.feed(drive3(L_PTS, { to: 1300 }));
  h.feed(drive3(polyline3([[-300, 1000], [-300, 1400]]), { t0: h.clock.t + 1000 }));
  assert.ok(h.phases.includes('offRoute'));
  // The automatic update fails (offline); Try Again gets one
  await settle3();
  assert.equal(h.bodies.length, 1);
  await h.s.retryReroute();
  assert.equal(h.bodies.length, 2);
  h.advance(NAVIGATION.gpsLostMs + 1);
  h.s.end('user');
  await journal.flush();
  const entries = await journal.read();
  const events = entries.map((e) => e.event);
  for (const e of ['nav_started', 'nav_step', 'nav_off_route', 'nav_reroute', 'nav_gps', 'nav_ended']) assert.ok(events.includes(e), `${e} logged`);
  const text = JSON.stringify(entries) + [...store.data.values()].join('');
  for (const secret of ['Secret Café', 'Hidden Lane', 'Keswick', 'Chestnut Hill', 'Lake Road', 'A591', String(searched.coordinate.latitude).slice(0, 7), '54.6', '-3.1']) {
    assert.ok(!text.includes(secret), `the journal holds "${secret}"`);
  }
  // The only thing written to the device is the journal
  assert.deepEqual([...store.data.keys()], ['@driveos/diagnostics/journal']);
  // And the navigation modules have no storage of their own
  const read = (rel: string) => readFileSync(toPath(new URL(rel, import.meta.url)), 'utf8').replace(/\/\/.*$/gm, '');
  for (const f of ['session.ts', 'routeProgress.ts', 'offRoute.ts', 'maneuver.ts', 'guidanceCamera.ts', 'startNavigation.ts']) {
    assert.ok(!/AsyncStorage|SecureStore|writeJson|setItem|deviceStorage|console\./.test(read(`../lib/navigation/${f}`)), f);
  }
});

test('guidance and recording: navigation uses the one existing recorder, only through Start Drive and End Drive', () => {
  const read = (rel: string) => readFileSync(toPath(new URL(rel, import.meta.url)), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  // No navigation module reaches into recording internals or sharing
  for (const f of ['lib/navigation/session.ts', 'lib/navigation/routeProgress.ts', 'lib/navigation/offRoute.ts', 'lib/navigation/startNavigation.ts', 'components/navigation/GuidanceBar.tsx', 'components/navigation/GuidanceBanner.tsx']) {
    const src = read(`../${f}`);
    assert.ok(!/journeyRecorder|cloudSync|updateDriveCoordinate|endDrive|discardDrive|liveLocation|presence|startDrive/.test(src), `${f} reaches into recording or sharing`);
  }
  // Start Navigation's recorder is the app's own Start Drive, nothing else
  const ctx = read('../context/NavigationContext.tsx');
  const recorder = ctx.slice(ctx.indexOf('export function useStartNavigation()'), ctx.indexOf('export function useRetryReroute()'));
  assert.ok(/startRecording: \(\) => app\.current\.startDrive\(\)/.test(recorder));
  assert.ok(/canRecord: \(\) => !app\.current\.isPassengerMode/.test(recorder));
  assert.ok(!/cloud|endDrive|discardDrive|liveLocation|presence/.test(recorder));
  const bar = read('../components/navigation/GuidanceBar.tsx');
  assert.ok(/onRecord/.test(bar) && /onFinishDrive/.test(bar), 'the bar asks the screen to record or finish');
  const drive = read('../app/(tabs)/(drive)/index.tsx');
  // Recording still gets the raw fix, exactly as before
  assert.ok(/updateDriveCoordinate\(\{\s*latitude: lat,\s*longitude: lon,/.test(drive));
  // Navigation finishes a drive only through the screen's usual End Drive (saved, Drive Complete)
  const nav = drive.slice(drive.indexOf('const navOwnsDrive = () =>'), drive.indexOf('function handlePause()'));
  assert.ok(nav.length > 0);
  assert.ok(!/endDrive\(|discardDrive|router\.push/.test(nav.replace(/handleEndDrive\(|endDriveRef\.current\(/g, '')), 'no second completion path');
  assert.equal((drive.match(/navSession\.end\(/g) ?? []).length, 3, 'End-and-finish, the panel End Drive, arriving');
  assert.equal((nav.match(/navSession\.end\(/g) ?? []).length, 3);
  assert.ok(/st\.recording !== "navigation"\) return;\s*navSession\.end\("arrived"\);\s*endDriveRef\.current\(\);/.test(nav), 'arriving finishes only a drive navigation started');
  assert.ok(/if \(was && !isDriving\) navSession\.recordingEnded\(\);/.test(nav));
  assert.ok(/onEndDrive=\{handlePanelEndDrive\}/.test(drive));
  assert.ok(/onFinishDrive=\{handleFinishNavigationDrive\}/.test(drive));
  // Recording by hand while navigating, where there's none alongside
  assert.ok(/onRecord=\{handleStartDrive\}/.test(drive));
  const drivingEffect = drive.slice(drive.indexOf('if (isDriving && routePreviewStore.phase !== "idle")'), drive.indexOf('if (isDriving && routePreviewStore.phase !== "idle")') + 200);
  assert.ok(!/navSession/.test(drivingEffect));
  // The session copies each fix and never changes it
  const h = nav3Session();
  void h.s.start({ route: L_ROUTE(), destination: N3_DEST });
  const fixes = drive3(L_PTS, { to: 200 }).map((f) => Object.freeze(f));
  const before = JSON.stringify(fixes);
  h.feed(fixes);
  assert.equal(JSON.stringify(fixes), before);
  assert.equal(h.s.phase, 'navigating');
});

test('guidance camera wiring: the follow camera writes, guidance only sets its zoom; off screen, panning and recenter behave', () => {
  const read = (rel: string) => readFileSync(toPath(new URL(rel, import.meta.url)), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const drive = read('../app/(tabs)/(drive)/index.tsx');
  const effect = drive.slice(drive.indexOf('let wasGuiding = navSession.guiding;'), drive.indexOf('const showNavigationOverview'));
  assert.ok(effect.length > 0);
  // No camera writes of its own: the follow camera's zoom target, retarget, and the frame loop
  assert.ok(!/setFollowCamera|setCamera|easeToZoom|animateCamera/.test(effect));
  assert.ok(/zoomTarget\.set\(\{ zoom: next\.zoom \}\)/.test(effect) && /wakeFrameLoop\(\)/.test(effect));
  // The user has moved the map: guidance carries on, the camera is left alone
  assert.ok(/if \(followModeRef\.current !== "following"\) return;/.test(effect));
  // Heading-up while guiding, and the guidance zoom on Recenter
  assert.ok(/guidingRef\.current \|\| headingModeRef\.current === "heading-up"/.test(drive));
  assert.ok(/guidingRef\.current && guidanceZoomRef\.current\s*\?\s*guidanceZoomRef\.current\.zoom\s*:\s*FOLLOW_ZOOM/.test(drive));
  assert.ok(/onRecenter=\{handleResumeFollowing\}/.test(drive));
  const resume = drive.slice(drive.indexOf('const handleResumeFollowing'), drive.indexOf('const handleResumeFollowing') + 300);
  assert.ok(/startFollowing\(true\)/.test(resume));
  // Off screen the frame loop never starts (and with it every follow write)
  assert.ok(/if \(frameIdRef\.current != null \|\| !visualsLiveRef\.current\) return;/.test(drive));
  assert.ok(/navSession\.setForeground\(next\.live\)/.test(drive));
  // The Drive screen reads navigation's phase only
  assert.ok(/useNavigationPhase\(\)/.test(drive) && !/useNavigationState\(\)/.test(drive));
  // The screen stays on while guiding (foreground only: an auto-lock would pause it), not after
  assert.ok(/\{navigating && navPhase !== "arrived" && navPhase !== "error" && \(\s*<GuidanceKeepAwake \/>/.test(drive));
  // Long-press can't start something new mid-navigation
  assert.ok(/navSession\.phase !== "idle"\) return;/.test(drive));
  // The map's route layer reads the session's map view (route changes only), never each fix
  const map = read('../components/MapboxDriveMap.tsx');
  const layer = map.slice(map.indexOf('const NavigationRouteLayers = memo('), map.indexOf('const MapboxDriveMap = forwardRef'));
  assert.ok(/\(\) => session\.map,/.test(layer) && !/session\.state/.test(layer));
  assert.ok(!/Camera|setFollowCamera|LocationPuck|followUserLocation/.test(layer));
  assert.ok(map.indexOf('<NavigationRouteLayers session={navigation} />') < map.lastIndexOf('<MarkerFeeder'));
});

test('guidance performance: a long route, thousands of fixes, local scans only', () => {
  // ~60 km of road with a bend every 2 km: 6000 points
  const corners: Array<[number, number]> = [];
  for (let i = 0; i <= 30; i++) corners.push([(i % 2) * 300, i * 2000]);
  const pts = polyline3(corners, 10);
  assert.ok(pts.length > 5000);
  const specs: StepSpec[] = [{ at: 0, type: 'depart' }];
  for (let i = 1; i < 30; i++) specs.push({ at: Math.round((i * pts.length) / 30), type: 'turn', modifier: i % 2 ? 'slight right' : 'slight left' });
  specs.push({ at: pts.length - 1, type: 'arrive' });
  const route = route3(pts, specs);
  const t0 = performance.now();
  const p = prepareRoute(route);
  const prepMs = performance.now() - t0;
  const tracker = new RouteTracker(p);
  const fixes = drive3(pts, { speed: 25, noise: 6 });
  let maxScan = 0;
  const t1 = performance.now();
  for (const f of fixes) {
    const m = tracker.match(f)!;
    tracker.commit(f, m);
    maxScan = Math.max(maxScan, tracker.lastScan);
  }
  const perFixMs = (performance.now() - t1) / fixes.length;
  assert.ok(prepMs < 300, `prepare took ${prepMs.toFixed(1)} ms`);
  assert.ok(perFixMs < 1, `${perFixMs.toFixed(3)} ms per fix`);
  // Only the first fix looks along the whole route; every other one stays local
  assert.ok(maxScan <= p.n, 'first fix');
  const scans: number[] = [];
  const t2 = new RouteTracker(p);
  for (const f of fixes.slice(0, 500)) { t2.commit(f, t2.match(f)!); scans.push(t2.lastScan); }
  assert.ok(Math.max(...scans.slice(1)) < 120, `local scan ${Math.max(...scans.slice(1))} segments`);
  assert.equal(tracker.progress!.stepIndex, specs.length - 2);
});

// ─── Navigation Phase 3.1: route consumption, auto recording ───────────────

/** Length (m) of a drawn line of [longitude, latitude] points */
function lineLength3(line: readonly (readonly [number, number])[]): number {
  let d = 0;
  for (let i = 1; i < line.length; i++) {
    d += distanceM({ latitude: line[i - 1]![1], longitude: line[i - 1]![0] }, { latitude: line[i]![1], longitude: line[i]![0] });
  }
  return d;
}

test('route line: only the part still to drive is drawn, from just behind the car; the route itself is never changed', () => {
  const route = L_ROUTE();
  const geometry = JSON.stringify(route.geometry);
  const p = prepareRoute(route);
  const h = nav3Session();
  void h.s.start({ route, destination: N3_DEST });
  assert.equal(h.s.map.remaining!.length, p.n, 'before the first fix: all of it');
  let prev = h.s.map.remaining;
  let lastStart = -1;
  let redraws = 0;
  const fixes = drive3(L_PTS, { to: 1900, noise: 4 });
  for (const f of fixes) {
    h.feed([f]);
    const line = h.s.map.remaining!;
    if (line === prev) continue;
    prev = line;
    redraws++;
    const start = p.total - lineLength3(line);
    const along = active3(h.s.state)!.progress!.along;
    assert.ok(start >= lastStart - 0.5, 'never grows back');
    assert.ok(start <= along + 0.5, 'never starts ahead of the car');
    assert.ok(along - start <= REMAINING_LINE.behindM + REMAINING_LINE.redrawEveryM + 1, `starts ${(along - start).toFixed(1)} m behind`);
    assert.deepEqual(line[line.length - 1], p.coords[p.n - 1], 'and still ends at the destination');
    lastStart = start;
  }
  assert.ok(lastStart > 1850, `the travelled line is gone (${lastStart.toFixed(0)} m of 2000)`);
  assert.ok(redraws < fixes.length, `${redraws} redraws for ${fixes.length} fixes`);
  assert.ok(redraws <= Math.ceil(1900 / REMAINING_LINE.redrawEveryM) + 2);
  // The route itself is untouched: same object, same points
  assert.equal(JSON.stringify(route.geometry), geometry);
  assert.equal(active3(h.s.state)!.route, route);
  assert.equal(h.s.map.route, route);
  // Stopped (no progress): no redraw
  const still = h.s.map.remaining;
  const last = fixes[fixes.length - 1]!;
  h.feed([{ ...last, time: h.clock.t + 1000, speedMs: 0 }]);
  assert.equal(h.s.map.remaining, still);
  // Arrived: nothing left to draw
  h.feed(drive3(L_PTS, { from: 1910, t0: h.clock.t + 1000 }));
  assert.equal(h.s.phase, 'arrived');
  assert.equal(h.s.map.route, null);
  assert.equal(h.s.map.remaining, null);
  // remainingLine itself
  assert.equal(remainingLine(p, 0), p.coords, 'at the start: the prepared points, no copy');
  const mid = remainingLine(p, 1000);
  const from = pointAt(p, 1000 - REMAINING_LINE.behindM);
  assert.deepEqual(mid[0], [from.longitude, from.latitude]);
  assert.equal(mid[1], p.coords[segmentAt(p, 1000 - REMAINING_LINE.behindM) + 1], "then the route's own points");
  assert.ok(Math.abs(lineLength3(mid) - (p.total - 995)) < 0.5);
  assert.equal(remainingLine(p, p.total + 50).length, 2);
  assert.equal(p.coords.length, p.n, 'the prepared points are never changed');
});

test('route line: after a reroute the new route is drawn whole, then consumed the same way', async () => {
  const srv = routeServer3();
  const h = nav3Session({ fetch: srv.fetch });
  void h.s.start({ route: L_ROUTE(), destination: N3_DEST });
  h.feed(drive3(L_PTS, { to: 700 }));
  const consumed = h.s.map.remaining!.length;
  assert.ok(consumed < prepareRoute(L_ROUTE()).n);
  feedWatching3(h, offNorth3(h.clock.t + 1000), () => h.bodies.length === 1);
  // While updating, the old route's remainder stays
  assert.equal(h.s.map.route, active3(h.s.state)!.route);
  srv.answer(serverRoutes3(FRESH3()));
  await settle3();
  const fresh = prepareRoute(active3(h.s.state)!.route);
  const line = h.s.map.remaining!;
  assert.deepEqual(line[line.length - 1], fresh.coords[fresh.n - 1], "the new route's line");
  assert.ok(lineLength3(line) <= fresh.total + 0.5);
});

test('route line performance: a 6,000-point route is trimmed cheaply, and redrawn only as the car moves on', () => {
  const corners: Array<[number, number]> = [];
  for (let i = 0; i <= 30; i++) corners.push([(i % 2) * 300, i * 2000]);
  const pts = polyline3(corners, 10);
  assert.ok(pts.length > 6000, `${pts.length} points`);
  const specs: StepSpec[] = [{ at: 0, type: 'depart' }];
  for (let i = 1; i < 30; i++) specs.push({ at: Math.round((i * pts.length) / 30), type: 'turn', modifier: i % 2 ? 'slight right' : 'slight left' });
  specs.push({ at: pts.length - 1, type: 'arrive' });
  const route = route3(pts, specs);
  const p = prepareRoute(route);
  // The trim itself
  const t0 = performance.now();
  for (let k = 0; k < 1000; k++) remainingLine(p, (k * 61.3) % p.total);
  const trimMs = (performance.now() - t0) / 1000;
  assert.ok(trimMs < 0.5, `${trimMs.toFixed(3)} ms per trim`);
  // A whole drive: every fix, with the map view kept up to date
  const h = nav3Session();
  void h.s.start({ route, destination: N3_DEST });
  let redraws = 0;
  let last = h.s.map.remaining;
  h.s.subscribe(() => { if (h.s.map.remaining !== last) { redraws++; last = h.s.map.remaining; } });
  const fixes = drive3(pts, { speed: 25, noise: 6 }).slice(0, 2000);
  const t1 = performance.now();
  h.feed(fixes);
  const perFixMs = (performance.now() - t1) / fixes.length;
  assert.ok(perFixMs < 1.5, `${perFixMs.toFixed(3)} ms per fix`);
  const driven = active3(h.s.state)!.progress!.along;
  assert.ok(redraws <= fixes.length, 'at most once per fix, never per frame');
  assert.ok(redraws <= driven / REMAINING_LINE.redrawEveryM + 2, `${redraws} redraws over ${driven.toFixed(0)} m`);
  assert.equal(JSON.stringify(route.geometry.slice(0, 3)), JSON.stringify(pts.slice(0, 3).map(([x, y]) => at3(x, y))), 'route untouched');
  assert.equal(route.geometry.length, pts.length);
});

/** The app's recorder, as Start Navigation sees it */
function fakeRecorder3(o: { recording?: boolean; passenger?: boolean } = {}) {
  const r = { recording: o.recording ?? false, passenger: o.passenger ?? false, starts: 0 };
  const recorder: NavigationRecorder = {
    isRecording: () => r.recording,
    canRecord: () => !r.passenger,
    startRecording: () => { r.starts++; r.recording = true; },
  };
  return { r, recorder };
}
async function preview3(route: Nav3Route = L_ROUTE()) {
  const preview = new RoutePreviewStore({
    fetchRoutes: async () => serverRoutes3(route),
    describe: (e) => ({ code: 'x', message: String(e) }),
    now: () => 1_000_000, setTimer: () => 1, clearTimer: () => {},
  });
  await preview.open(N3_DEST, { coordinate: at3(0, 0), headingDeg: null });
  return preview;
}
const here3 = async () => ({ coordinate: at3(0, 0), headingDeg: null });
const recordingOf3 = (st: NavigationState) => (st.phase === 'idle' ? null : st.recording);

test('auto recording: Start Navigation records one drive with the existing recorder; a drive already recording is attached to, never duplicated', async () => {
  // Nothing recording: one drive, owned by navigation
  const a = fakeRecorder3();
  const h = nav3Session();
  assert.equal(await startFromPreview(await preview3(), h.s, here3, a.recorder), true);
  assert.equal(a.r.starts, 1, 'one drive');
  assert.equal(recordingOf3(h.s.state), 'navigation');
  // Starting another navigation while that drive records: no second drive,
  // and it's still navigation's drive (finished on arriving)
  assert.equal(await startFromPreview(await preview3(), h.s, here3, a.recorder), true);
  assert.equal(a.r.starts, 1);
  assert.equal(recordingOf3(h.s.state), 'navigation');
  // A drive the user started: attached to, not started again
  const b = fakeRecorder3({ recording: true });
  const h2 = nav3Session();
  await startFromPreview(await preview3(), h2.s, here3, b.recorder);
  assert.equal(b.r.starts, 0);
  assert.equal(recordingOf3(h2.s.state), 'existing');
  // Passenger Mode records nothing, here as everywhere
  const c = fakeRecorder3({ passenger: true });
  const h3 = nav3Session();
  await startFromPreview(await preview3(), h3.s, here3, c.recorder);
  assert.equal(c.r.starts, 0);
  assert.equal(recordingOf3(h3.s.state), 'none');
  // A route that can't be followed starts no drive
  const d = fakeRecorder3();
  const h4 = nav3Session();
  await startFromPreview(await preview3({ ...L_ROUTE(), geometry: [at3(0, 0), at3(0, 0)] }), h4.s, here3, d.recorder);
  assert.equal(h4.s.phase, 'error');
  assert.equal(d.r.starts, 0);
  assert.equal(recordingOf3(h4.s.state), 'none');
  // No recorder at all: as before
  const h5 = nav3Session();
  await startFromPreview(await preview3(), h5.s, here3);
  assert.equal(recordingOf3(h5.s.state), 'none');
  assert.equal(recordingForStart(null), 'none');
  assert.equal(recordingForStart(fakeRecorder3().recorder), 'navigation');
  assert.equal(recordingForStart(fakeRecorder3({ recording: true, passenger: true }).recorder), 'existing');
  assert.equal(recordingForStart(fakeRecorder3({ recording: true }).recorder, 'existing'), 'existing');
  assert.equal(recordingForStart(fakeRecorder3({ recording: true }).recorder, 'navigation'), 'navigation');
});

test('auto recording: ownership lasts to arrival (finish the drive) or not (leave it); the session itself never stops a drive', () => {
  for (const recording of ['navigation', 'existing', 'none'] as const) {
    const h = nav3Session();
    void h.s.start({ route: L_ROUTE(), destination: N3_DEST, recording });
    h.feed(drive3(L_PTS));
    assert.equal(h.s.phase, 'arrived');
    assert.equal(recordingOf3(h.s.state), recording, 'the Drive screen reads this on arriving');
  }
  // The drive finished from the drive panel (or failed to start): navigation carries on without one
  const h = nav3Session();
  void h.s.start({ route: L_ROUTE(), destination: N3_DEST, recording: 'navigation' });
  h.feed(drive3(L_PTS, { to: 500 }));
  h.s.recordingEnded();
  assert.equal(h.s.phase, 'navigating');
  assert.equal(recordingOf3(h.s.state), 'none');
  // A fresh-route start keeps what happened to the recording meanwhile
  const r = nav3Session({ fetch: () => new Promise(() => {}) });
  void r.s.start({ route: L_ROUTE(), destination: N3_DEST, refreshFrom: { coordinate: at3(0, 0), headingDeg: null }, recording: 'navigation' });
  assert.equal(recordingOf3(r.s.state), 'navigation');
  // The session has no recorder: ending navigation can't stop or delete a drive
  const src = readFileSync(toPath(new URL('../lib/navigation/session.ts', import.meta.url)), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.ok(!/startDrive|endDrive|discardDrive|deleteJourney|recorder/i.test(src));
});

test('navigation UI: passive off-route states, End asks before finishing a drive navigation started, Record only with none alongside', () => {
  const read = (rel: string) => readFileSync(toPath(new URL(rel, import.meta.url)), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const banner = read('../components/navigation/GuidanceBanner.tsx');
  assert.ok(!/Update Route/.test(banner), 'no Update Route button');
  for (const text of ["You're off route", 'Updating route…', 'Route update unavailable']) assert.ok(banner.includes(text), text);
  assert.ok(/!updating && state\.canRetry \?/.test(banner), 'Try again only after repeated failures');
  assert.ok(!/useRerouteNavigation|currentOrigin/.test(banner));
  const bar = read('../components/navigation/GuidanceBar.tsx');
  assert.ok(bar.includes('"End navigation and finish drive", onPress: onFinishDrive'));
  assert.ok(bar.includes('{ text: "Continue navigation", style: "cancel" }'));
  assert.ok(/if \(ownsDrive && onFinishDrive\) \{[\s\S]*?return;\s*\}\s*end\("user"\);/.test(bar), 'otherwise End ends navigation only');
  assert.ok(/ownsDrive=\{state\.recording === "navigation"\} onFinishDrive=\{onFinishDrive\}/.test(bar));
  assert.ok(/<EndButton ownsDrive=\{false\} \/>/.test(bar), 'the bar shows only without a recording');
  assert.ok(/state\.recording === "none" \? \(\s*<GlassButton\s*accessibilityLabel="Record this drive"/.test(bar));
  // The map draws the remaining line, not the whole route
  const map = read('../components/MapboxDriveMap.tsx');
  const layer = map.slice(map.indexOf('const NavigationRouteLayers = memo('), map.indexOf('const MapboxDriveMap = forwardRef'));
  assert.ok(/view\.remaining \?\?/.test(layer) && /\[view\.route, view\.remaining\]/.test(layer));
});

// ─── Navigation Phase 4: foreground voice guidance ──────────────────────────
// Mapbox's own prompts, spoken from route progress at Mapbox's distances,
// once each; rerouting, off route, arrival, foreground only, settings.

import { VoiceGuidance, VOICE, promptKind, type Speaker } from '@/lib/navigation/voice';
import { VoicePreferences, voicePrefsKey } from '@/lib/navigation/voicePrefs';

/** The L route with Mapbox-like prompts: depart, advance, preparation, immediate; arrival */
function voiceRoute3(id = 'v:0'): Nav3Route {
  const r = L_ROUTE();
  r.routeId = id;
  const steps = r.legs[0]!.steps;
  steps[0]!.voice = [
    { distanceBeforeM: 1000, text: 'Head north on Lake Road, then in 1000 yards, turn left onto Chestnut Hill' },
    { distanceBeforeM: 800, text: 'In half a mile, turn left onto Chestnut Hill' },
    { distanceBeforeM: 400, text: 'In a quarter of a mile, turn left onto Chestnut Hill' },
    { distanceBeforeM: 60, text: 'Turn left onto Chestnut Hill' },
  ];
  steps[1]!.voice = [
    { distanceBeforeM: 600, text: 'Continue for 600 yards, then turn right onto Brow Top' },
    { distanceBeforeM: 300, text: 'In 300 yards, turn right onto Brow Top' },
    { distanceBeforeM: 50, text: 'Turn right onto Brow Top' },
  ];
  steps[2]!.voice = [
    { distanceBeforeM: 400, text: 'In a quarter of a mile, you will arrive at your destination' },
    { distanceBeforeM: 30, text: 'You have arrived at your destination' },
  ];
  return r;
}
const OLD_TEXTS3 = voiceRoute3().legs[0]!.steps.flatMap((st) => st.voice.map((v) => v.text));
/** A new route from just past the missed turn, with its own prompts */
function freshVoice3(): Nav3Route {
  const r = FRESH3();
  r.legs[0]!.steps.forEach((st, k) => { st.voice = [{ distanceBeforeM: 2000, text: `NEW depart ${k}` }, { distanceBeforeM: 300, text: `NEW prepare ${k}` }, { distanceBeforeM: 40, text: `NEW now ${k}` }]; });
  return r;
}
/** A navigation session with voice guidance on a fake speaker */
function voice3(opts: { fetch?: (body: unknown) => Promise<ServerRoutes> } = {}) {
  const h = nav3Session(opts);
  const said: Array<{ text: string; along: number | null; t: number }> = [];
  const logs: Array<Record<string, unknown>> = [];
  let stops = 0;
  const speaker: Speaker = {
    speak: (text) => {
      const st = h.s.state;
      said.push({ text, along: active3(st)?.progress?.along ?? null, t: h.clock.t });
    },
    stop: () => { stops++; },
  };
  const v = new VoiceGuidance({ session: h.s, speaker, now: () => h.clock.t, journal: { log: (event, data) => logs.push({ event, ...data }) } });
  v.attach();
  return { ...h, v, said, logs, texts: () => said.map((x) => x.text), stops: () => stops };
}
/** One fix every `step` m along the L route, noise-free */
const walk3 = (from: number, to: number, t0: number, step = 10) => drive3(L_PTS, { from, to, t0, speed: step, noise: 0 });

test('voice: Mapbox prompts fire from route progress at their distances: depart, advance, preparation, immediate, arrival', () => {
  const h = voice3();
  void h.s.start({ route: voiceRoute3(), destination: N3_DEST });
  assert.equal(h.said.length, 0, 'nothing before the car is on the route');
  h.feed(walk3(0, 1995, 1_000_000));
  h.feed(walk3(1996, 2000, h.clock.t + 1000, 2));
  assert.equal(h.s.phase, 'arrived');
  assert.deepEqual(h.texts(), [
    'Head north on Lake Road, then in 1000 yards, turn left onto Chestnut Hill',
    'In half a mile, turn left onto Chestnut Hill',
    'In a quarter of a mile, turn left onto Chestnut Hill',
    'Turn left onto Chestnut Hill',
    'Continue for 600 yards, then turn right onto Brow Top',
    'In 300 yards, turn right onto Brow Top',
    'Turn right onto Brow Top',
    'In a quarter of a mile, you will arrive at your destination',
    'You have arrived at your destination',
  ]);
  // Each at its threshold (within one fix of it), never early
  const turnAt = [1000, 1000, 1000, 1000, 1600, 1600, 1600, 2000];
  const before = [1000, 800, 400, 60, 600, 300, 50, 400];
  for (let k = 1; k < 8; k++) {
    const due = turnAt[k]! - before[k]!;
    const along = h.said[k]!.along!;
    assert.ok(along >= due - 0.5 && along < due + 12, `${h.said[k]!.text}: said at ${along.toFixed(0)} m, due at ${due} m`);
  }
  // The kinds the diagnostics use
  assert.equal(promptKind(0, 4), 'advance');
  assert.equal(promptKind(2, 4), 'preparation');
  assert.equal(promptKind(3, 4), 'immediate');
  assert.equal(promptKind(0, 2), 'preparation');
  assert.equal(promptKind(0, 1), 'immediate');
  // Arrival is spoken once, even with more updates and Done; Done doesn't cut it off
  const stops = h.stops();
  h.advance(30_000);
  h.s.end('arrived');
  assert.equal(h.texts().filter((t) => /arrived/.test(t)).length, 1);
  assert.equal(h.stops(), stops, 'navigation handing over to Drive Complete leaves the arrival to finish');
});

test('voice: GPS jitter and going slightly backwards never replay a prompt', () => {
  const h = voice3();
  void h.s.start({ route: voiceRoute3(), destination: N3_DEST });
  h.feed(walk3(0, 590, 1_000_000));
  const t = h.clock.t;
  // Wobbling across the 400 m prompt's threshold (600 m along), forwards and back
  const wobble = [595, 603, 598, 606, 597, 611, 602, 615, 605, 620];
  h.feed(wobble.map((d, i) => fix3(0 + (i % 2 ? 4 : -4), d, t + 1000 * (i + 1), { headingDeg: 0, speedMs: 5 })));
  // Noisy driving on to the turn
  h.feed(drive3(L_PTS, { from: 625, to: 990, t0: h.clock.t + 1000, noise: 8, seed: 3 }));
  const texts = h.texts();
  assert.equal(new Set(texts).size, texts.length, `repeated: ${texts.join(' | ')}`);
  assert.equal(texts.filter((x) => x === 'In a quarter of a mile, turn left onto Chestnut Hill').length, 1);
  // Even a bigger step back (confirmed by the tracker) says nothing again
  const n = h.said.length;
  h.feed(drive3(L_PTS, { from: 900, to: 960, t0: h.clock.t + 1000, noise: 0 }));
  h.feed(drive3(L_PTS, { from: 850, to: 900, t0: h.clock.t + 1000, noise: 0 }));
  const again = h.texts().slice(n);
  assert.ok(again.every((x) => !texts.includes(x)), `replayed: ${again.join(' | ')}`);
});

test('voice: rerouting cancels the old route, says "Updating route" once, and speaks only the new route', async () => {
  const srv = routeServer3();
  const h = voice3({ fetch: srv.fetch });
  void h.s.start({ route: voiceRoute3(), destination: N3_DEST });
  h.feed(walk3(0, 700, 1_000_000));
  const stopsBefore = h.stops();
  feedWatching3(h, offNorth3(h.clock.t + 1000), () => h.bodies.length === 1);
  assert.ok(h.stops() > stopsBefore, 'queued speech for the old route is cancelled');
  assert.equal(h.texts().filter((x) => x === VOICE.updating).length, 1);
  // More off-route fixes while the request is out: not said again
  feedWatching3(h, offNorth3(h.clock.t + 1000).slice(30, 40));
  assert.equal(h.texts().filter((x) => x === VOICE.updating).length, 1);
  const cut = h.said.length;
  srv.answer(serverRoutes3(freshVoice3()));
  await settle3();
  assert.equal(h.s.phase, 'navigating');
  const after = h.texts().slice(cut);
  assert.ok(after.length >= 1, 'the new route speaks straight away');
  assert.ok(after.every((x) => x.startsWith('NEW')), `after the reroute: ${after.join(' | ')}`);
  // Driving the new route: its prompts, never the old ones
  h.feed(drive3(polyline3([[0, 1250], [0, 1500], [-600, 1500]]), { t0: h.clock.t + 1000, noise: 0 }));
  const later = h.texts().slice(cut);
  assert.ok(later.every((x) => !OLD_TEXTS3.includes(x)), `old route spoken: ${later.join(' | ')}`);
  assert.ok(later.includes('NEW now 1'), 'the new route\'s turn');
  assert.ok(h.logs.some((l) => l.event === 'nav_voice' && l.reason === 'off_route'));
});

test('voice: off route again within a minute is not announced again', async () => {
  const srv = routeServer3();
  const h = voice3({ fetch: srv.fetch });
  void h.s.start({ route: voiceRoute3(), destination: N3_DEST });
  h.feed(walk3(0, 700, 1_000_000));
  const off = offNorth3(h.clock.t + 1000);
  feedWatching3(h, off, () => h.bodies.length === 1);
  srv.answer(serverRoutes3(freshVoice3()));
  await settle3();
  const firstAt = h.said.find((x) => x.text === VOICE.updating)!.t;
  // Straight off the new route too (east, into a side road)
  const y = (off.find((f) => f.time === h.clock.t)!.latitude - N3_BASE.latitude) * N3_M;
  h.feed(drive3(polyline3([[0, y], [500, y]]), { t0: h.clock.t + 1000, noise: 0 }).slice(0, 20));
  assert.ok(h.phases.lastIndexOf('offRoute') > h.phases.indexOf('navigating'));
  assert.ok(h.clock.t - firstAt < VOICE.offRouteGapMs);
  assert.equal(h.texts().filter((x) => x === VOICE.updating).length, 1, 'once a minute at most');
});

test('voice: foreground only: leaving stops speech, nothing is said away, coming back replays nothing', () => {
  const h = voice3();
  void h.s.start({ route: voiceRoute3(), destination: N3_DEST });
  h.feed(walk3(0, 150, 1_000_000));
  const stops = h.stops();
  h.v.setForeground(false);
  assert.equal(h.stops(), stops + 1, 'leaving the foreground stops speech');
  assert.ok(h.logs.some((l) => l.event === 'nav_voice' && l.action === 'cancelled' && l.reason === 'background'));
  const n = h.said.length;
  // Away: past the 800 m and 400 m prompts
  h.feed(walk3(160, 700, h.clock.t + 1000));
  assert.equal(h.said.length, n, 'nothing spoken in the background');
  h.v.setForeground(true);
  assert.equal(h.said.length, n, 'coming back replays nothing');
  h.feed(walk3(710, 950, h.clock.t + 1000));
  assert.deepEqual(h.texts().slice(n), ['Turn left onto Chestnut Hill'], 'only what is still ahead');
});

test('voice: mute stops at once and says nothing; unmute speaks what is still ahead; Alerts only', () => {
  const h = voice3();
  void h.s.start({ route: voiceRoute3(), destination: N3_DEST });
  h.feed(walk3(0, 150, 1_000_000));
  const stops = h.stops();
  h.v.setMode('off');
  assert.equal(h.stops(), stops + 1, 'muting cancels what is queued');
  const n = h.said.length;
  h.feed(walk3(160, 700, h.clock.t + 1000));
  assert.equal(h.said.length, n, 'muted: nothing');
  h.v.setMode('normal');
  assert.equal(h.said.length, n, 'unmuting replays nothing');
  h.feed(walk3(710, 1300, h.clock.t + 1000));
  assert.deepEqual(h.texts().slice(n), ['Turn left onto Chestnut Hill', 'Continue for 600 yards, then turn right onto Brow Top', 'In 300 yards, turn right onto Brow Top']);
  assert.ok(h.logs.some((l) => l.state === 'disabled') && h.logs.some((l) => l.state === 'enabled'));
  // Alerts only: just the prompt at each manoeuvre
  const a = voice3();
  a.v.setMode('alerts');
  void a.s.start({ route: voiceRoute3(), destination: N3_DEST });
  a.feed(walk3(0, 1995, 1_000_000));
  a.feed(walk3(1996, 2000, a.clock.t + 1000, 2));
  assert.deepEqual(a.texts(), ['Turn left onto Chestnut Hill', 'Turn right onto Brow Top', 'You have arrived at your destination']);
});

test('voice: arrival without a Mapbox arrival prompt says "You have arrived", once; End stops speech', () => {
  const h = voice3();
  const r = voiceRoute3();
  r.legs[0]!.steps[2]!.voice = [];
  void h.s.start({ route: r, destination: N3_DEST });
  h.feed(walk3(0, 1995, 1_000_000));
  h.feed(walk3(1996, 2000, h.clock.t + 1000, 2));
  assert.equal(h.texts().filter((x) => x === VOICE.arrived).length, 1);
  assert.equal(h.texts()[h.said.length - 1], VOICE.arrived);
  // Ending part way stops speech
  const e = voice3();
  void e.s.start({ route: voiceRoute3(), destination: N3_DEST });
  e.feed(walk3(0, 300, 1_000_000));
  const stops = e.stops();
  e.s.end('user');
  assert.equal(e.stops(), stops + 1);
  e.feed(walk3(310, 900, e.clock.t + 1000));
  assert.equal(e.texts().length, 2, 'nothing after End');
});

test('voice preference: Normal by default, kept per user on this device, mute remembers the last choice', async () => {
  const store = new MemoryStore();
  const a = new VoicePreferences(store, 'u1');
  await a.load();
  assert.equal(a.mode, 'normal');
  await a.setMode('alerts');
  const b = new VoicePreferences(store, 'u1');
  await b.load();
  assert.equal(b.mode, 'alerts', 'persisted');
  await b.toggleMute();
  assert.equal(b.mode, 'off');
  const c = new VoicePreferences(store, 'u1');
  await c.load();
  assert.equal(c.mode, 'off');
  await c.toggleMute();
  assert.equal(c.mode, 'alerts', 'unmute: back to the last spoken choice');
  // Another user on the same phone has their own
  const other = new VoicePreferences(store, 'u2');
  await other.load();
  assert.equal(other.mode, 'normal');
  // Nonsense stored: the default
  await store.setItem(voicePrefsKey('u3'), '{"mode":"loud"}');
  const d = new VoicePreferences(store, 'u3');
  await d.load();
  assert.equal(d.mode, 'normal');
  // Cleared with the user's other device data at sign-out
  const sync = readFileSync(toPath(new URL('../lib/backend/cloudSync.ts', import.meta.url)), 'utf8');
  assert.ok(sync.includes("userKey(this.deps.userId, 'nav/voice/v1')"));
  assert.equal(voicePrefsKey('u1'), userKey('u1', 'nav/voice/v1'));
});

test('voice: diagnostics have steps, kinds and reasons, never the words, roads, destination or position', async () => {
  const srv = routeServer3();
  const h = voice3({ fetch: srv.fetch });
  void h.s.start({ route: voiceRoute3(), destination: { ...N3_DEST, name: 'Secret Café' } });
  h.feed(walk3(0, 700, 1_000_000));
  feedWatching3(h, offNorth3(h.clock.t + 1000), () => h.bodies.length === 1);
  srv.answer(serverRoutes3(freshVoice3()));
  await settle3();
  h.v.setForeground(false);
  h.v.noteSpeechError('speech_error');
  const spoken = h.logs.filter((l) => l.event === 'nav_voice' && l.action === 'spoken');
  assert.ok(h.logs.some((l) => (l as Record<string, unknown>).step === 1 && (l as Record<string, unknown>).kind === 'advance'));
  assert.ok(h.logs.some((l) => l.reason === 'off_route'));
  assert.ok(h.logs.some((l) => l.reason === 'background'));
  assert.ok(h.logs.some((l) => l.code === 'speech_error'));
  assert.ok(spoken.length > 3);
  const text = JSON.stringify(h.logs);
  for (const secret of ['Chestnut', 'Lake Road', 'Brow Top', 'Secret Café', 'NEW', 'yards', 'Updating route', '54.6', '-3.1']) {
    assert.ok(!text.includes(secret), `the voice log holds "${secret}"`);
  }
});

test('voice is a reader only: navigation, rerouting, progress and recording behave the same with it', async () => {
  const run = async (withVoice: boolean) => {
    const srv = routeServer3();
    const h = withVoice ? voice3({ fetch: srv.fetch }) : nav3Session({ fetch: srv.fetch });
    void h.s.start({ route: voiceRoute3(), destination: N3_DEST, recording: 'navigation' });
    h.feed(walk3(0, 700, 1_000_000));
    feedWatching3(h, offNorth3(h.clock.t + 1000), () => h.bodies.length === 1);
    srv.answer(serverRoutes3(freshVoice3()));
    await settle3();
    h.feed(drive3(polyline3([[0, 1250], [0, 1500], [-600, 1500], [-600, 1400]]), { t0: h.clock.t + 1000, noise: 0 }));
    return { phases: h.phases, bodies: JSON.stringify(h.bodies), states: h.states.map((st) => `${st.phase}:${active3(st)?.progress?.along.toFixed(2) ?? '-'}:${st.phase === 'idle' ? '' : st.recording}`) };
  };
  const a = await run(false);
  const b = await run(true);
  assert.deepEqual(b.phases, a.phases);
  assert.equal(b.bodies, a.bodies);
  assert.deepEqual(b.states, a.states);
  // Nothing in voice reaches recording, sharing, presence or the camera; navigation doesn't know about voice
  const read = (rel: string) => readFileSync(toPath(new URL(rel, import.meta.url)), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  for (const f of ['lib/navigation/voice.ts', 'lib/navigation/voicePrefs.ts', 'lib/navigation/speech.ts']) {
    const src = read(`../${f}`);
    assert.ok(!/startDrive|endDrive|cloudSync|journeyRecorder|liveLocation|presence|setCamera|Camera|reroute\(|noteFix\(|\.end\(/.test(src), f);
  }
  assert.ok(!/voice/i.test(read('../lib/navigation/session.ts').replace(/voice[A-Za-z]*:/g, '')), 'the session has no voice in it');
  const drive = read('../app/(tabs)/(drive)/index.tsx');
  assert.ok(!/Voice|Speech|speech/.test(drive), 'the Drive screen is untouched by voice');
});

test('voice native impact: expo-speech only, own iOS speech session, British English, no background audio', () => {
  const read = (rel: string) => readFileSync(toPath(new URL(rel, import.meta.url)), 'utf8');
  const speech = read('../lib/navigation/speech.ts');
  assert.ok(/useApplicationAudioSession: false/.test(speech), "iOS's own ducking speech session, not the app's");
  assert.ok(/language: 'en-GB'/.test(speech));
  assert.ok(/requireOptionalNativeModule\('ExpoSpeech'\) \?/.test(speech), 'a binary without the module stays quiet, never crashes');
  const pkg = JSON.parse(read('../package.json')) as { dependencies: Record<string, string> };
  assert.equal(pkg.dependencies['expo-speech'], '~57.0.3');
  assert.ok(!pkg.dependencies['expo-av'] && !pkg.dependencies['expo-audio'], 'no app audio session library');
  for (const f of ['../app.json', '../app.config.js']) {
    const src = read(f);
    assert.ok(!/["']audio["']/.test(src), `${f}: no background audio mode`);
    assert.ok(!/expo-speech|AVAudioSession|NSMicrophone/.test(src), `${f}: no speech plugin or audio config`);
  }
  // Foreground only, in the context: anything but "active" is quiet
  const ctx = read('../context/NavigationContext.tsx');
  assert.ok(/AppState\.addEventListener\('change', \(state\) => voice\.setForeground\(state === 'active'\)\)/.test(ctx));
});

// ─── iOS build number: one source of truth (app.json ios.buildNumber) ───────
// `expo prebuild` writes ios.buildNumber into Info.plist (CFBundleVersion);
// without it, "1". app.config.js also writes it into the Xcode project's
// CURRENT_PROJECT_VERSION, so a local Archive needs no hand edits.

test('the iOS build number comes from app.json, is a whole number, and reaches Xcode too', () => {
  const req = createRequire(import.meta.url);
  const app = JSON.parse(readFileSync(toPath(new URL('../app.json', import.meta.url)), 'utf8')) as { expo: { version: string; ios: { buildNumber?: string } } };
  assert.match(String(app.expo.ios.buildNumber), /^[1-9]\d*$/, 'app.json ios.buildNumber');
  const appConfig = req('../app.config.js') as (a: { config: object }) => { ios: { buildNumber: string }; version: string; mods?: { ios?: { xcodeproj?: unknown } } };
  const cfg = appConfig({ config: app.expo });
  assert.equal(cfg.ios.buildNumber, app.expo.ios.buildNumber);
  assert.equal(typeof cfg.mods?.ios?.xcodeproj, 'function', 'the Xcode version plugin is applied');
  for (const bad of ['', '0', '24.1', 'abc', '-3']) {
    assert.throws(() => appConfig({ config: { ...app.expo, ios: { ...app.expo.ios, buildNumber: bad } } }), /ios\.buildNumber must be a whole number/, String(bad));
  }
  const src = readFileSync(toPath(new URL('../app.config.js', import.meta.url)), 'utf8');
  assert.ok(/settings\.CURRENT_PROJECT_VERSION = cfg\.ios\?\.buildNumber \?\? '1';/.test(src));
  assert.ok(/settings\.MARKETING_VERSION = cfg\.version;/.test(src));
});
