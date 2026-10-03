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
  deletedJourneys: string[] = [];
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
        const l = { id: `l${++self.n}`, ownerId: 'u1', clientRef: f.clientRef, kind: f.kind, category: null, name: f.name, description: '', address: '', lat: f.lat, lng: f.lng, routePolyline: null, visibility: f.kind === 'home' ? 'private' : (f.visibility ?? 'private'), status: 'active', coverPhotoId: null, sourceJourneyId: null, createdAt: '', updatedAt: '' } as ServerLocation;
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
      addRoutePoints: async (id: string, pts: unknown[]) => { self.guard(); self.points.set(id, (self.points.get(id) ?? 0) + pts.length); return { saved: pts.length, status: 'active' }; },
      completeJourney: async (id: string, i: { endedAt: string; distanceKm: number; name?: string }) => {
        self.guard();
        const j = self.journeys.find((x) => x.id === id)!;
        Object.assign(j, { name: i.name ?? j.name, status: 'completed', endedAt: i.endedAt, distanceKm: i.distanceKm, durationSeconds: 60, avgSpeedKmh: 0, topSpeedKmh: 0, xpEarned: 50, timezone: 'UTC', notes: '', visibility: 'private', journeyType: 'personal', vehicleId: null, categoryId: null, convoyId: null, vehicleSnapshot: null, publicRoutePolyline: null });
        return j;
      },
    };
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

test('a short drive cut off by the app being killed is discarded on restart', async () => {
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
  assert.equal(server.journeys.length, 0);
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
  await restarted.start();
  await restarted.outbox.flush();
  assert.equal(restarted.status.pendingJourneys, 0);
  assert.equal(server.journeys.length, 0);
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
  assert.deepEqual(lines, ["import './lib/driveBackgroundLocation';", "import 'expo-router/entry';"]);
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
