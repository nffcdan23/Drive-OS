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
  const puck = loop.indexOf('mapboxRef.current?.setMarker(position)');
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
  const mapbox = screen.slice(screen.indexOf('<MapboxDriveMap'), screen.indexOf('/>', screen.indexOf('<MapboxDriveMap')));
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
    assert.equal(code.split(write).length - 1, 1, `${write} written elsewhere`);
    assert.ok(block.includes(write), `${write} outside the follow guard`);
  }
  // A finished gesture the controller says left follow mode ends it on screen too
  assert.ok(/frame\.kind === "left" \|\| frame\.kind === "free"\)\s*\{\s*leaveFollowRef\.current\(\);/.test(code));
  // The map reporting a gesture is noted with the controller (Apple onPanDrag, Mapbox onUserGesture)
  const pan = code.slice(code.indexOf('const handleMapPanDrag'), code.indexOf('const handleMapTouchStart'));
  assert.ok(/followCamera\.gestureMoved\(\)/.test(pan));
  assert.ok(/onUserGesture=\{handleMapPanDrag\}/.test(code) && /onPanDrag=\{handleMapPanDrag\}/.test(code));
  // Follow mode is entered in one place, from three explicit actions only
  assert.equal(code.match(/setFollowMode\("following"\)/g)?.length, 1);
  assert.equal(code.match(/followModeRef\.current = "following"/g)?.length, 1);
  assert.equal(code.match(/startFollowing\(true/g)?.length, 3);
  for (const caller of ['if (isDriving) {', 'const handleResumeFollowing', 'const handleLocateButton']) {
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
  // position over 1.1 s) is gone; Derwent's arrow is a view annotation
  assert.ok(!/LocationPuck|CustomLocationProvider|puckBearing/.test(mapCode));
  assert.ok(/<MarkerView[\s\S]*\{children\}[\s\S]*<\/MarkerView>/.test(mapCode));
  assert.ok(/marker=\{mapboxArrow\}/.test(code) && /<LocationArrow\s+rotation=\{arrowRotation\}/.test(code));
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
    ['app/search.tsx', 'visible', 'onClose'],
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
  for (const rel of ['app/(tabs)/community.tsx', 'app/search.tsx']) {
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
  const save = readFileSync(join(MOBILE, 'app/search.tsx'), 'utf8');
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
  assert.ok(/flexShrink: 1,/.test(readFileSync(join(MOBILE, 'app/search.tsx'), 'utf8')));
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

// ─── Phase 4B: friends' live positions on the Drive map ─────────────────────
import {
  FriendSelection, MIN_HEADING_SPEED_KMH, STALE_AFTER_MS, buildMarkerModels, formatSpeed, sameMarker,
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
  assert.equal(formatSpeed(67.6, 'imperial'), '42 mph');
  assert.equal(formatSpeed(67.6, 'metric'), '68 km/h');
  assert.equal(formatSpeed(null, 'imperial'), null);
  assert.equal(formatSpeed(-1, 'imperial'), null);
  assert.equal(formatSpeed(0, 'imperial'), '0 mph', 'a reported 0 is a real standstill');
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
