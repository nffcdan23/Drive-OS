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
        return j;
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
  assert.deepEqual(parseAuthCallback('driveos-staging://auth/callback?type=recovery&code=abc-123'),
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

test('the app identity is a placeholder and never sets a bundle id by itself', () => {
  const { identity } = createRequire(import.meta.url)('../app.identity.js');
  const staging = identity('staging', {});
  assert.equal(staging.bundleId, null, 'no bundle id without APP_BUNDLE_ID');
  assert.equal(staging.usingPlaceholders, true);
  assert.equal(staging.scheme, 'driveos-staging');
  const chosen = identity('production', { APP_DISPLAY_NAME: 'Name', APP_SCHEME: 'name', APP_BUNDLE_ID: 'com.example.name' });
  assert.deepEqual([chosen.appName, chosen.scheme, chosen.bundleId, chosen.usingPlaceholders], ['Name', 'name', 'com.example.name', false]);
  assert.equal(identity('staging', { APP_BUNDLE_ID: 'com.example.name' }).bundleId, 'com.example.name.staging');
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
