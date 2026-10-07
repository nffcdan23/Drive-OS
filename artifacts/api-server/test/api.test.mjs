// End-to-end tests of the API against a real, migrated database.
//
//   TEST_DATABASE_URL  a database built from supabase/migrations (locally,
//                      with the Supabase stub; see supabase/tests/local/run.sh)
//
// The built server (dist/index.mjs) is started as a child process. Supabase
// Storage and Auth admin are replaced by a small fake HTTP server that
// records calls, and access tokens are signed with a test HS256 secret, so
// no real Supabase project is involved. Users are created by inserting into
// auth.users, which fires the real sign-up trigger.
//
// Run: node --test artifacts/api-server/test/api.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(new URL("../../../lib/db/package.json", import.meta.url));
const pg = require("pg");

const DB_URL = process.env.TEST_DATABASE_URL;
if (!DB_URL) throw new Error("TEST_DATABASE_URL is not set");

const JWT_SECRET = "test-secret-for-local-integration-tests-only";
const SECRET_KEY = "sb_secret_test_only";
const API_PORT = 18000 + Math.floor(Math.random() * 1000);
let supabaseUrl = "";
let server;
let fake;
const db = new pg.Pool({ connectionString: DB_URL, max: 3 });
const calls = []; // requests received by the fake Supabase
let serverOutput = ""; // everything the API logged
const responses = []; // every response body the API returned

// ─── Stub DVLA Vehicle Enquiry Service ──────────────────────────────────────
// Answers by registration so each DVLA outcome can be exercised end to end.
const DVLA_KEY = "test-dvla-key-never-leaves-the-server";
const dvlaCalls = []; // { registration, apiKey }
let dvla;
let dvlaUrl = "";
const DVLA_VEHICLE = {
  make: "VOLKSWAGEN", colour: "BLUE", fuelType: "PETROL", yearOfManufacture: 2018, engineCapacity: 1984,
  taxStatus: "Taxed", taxDueDate: "2027-01-01", motStatus: "Valid", motExpiryDate: "2027-02-01",
  dateOfLastV5CIssued: "2020-01-01", co2Emissions: 150,
};

function startStubDvla() {
  return new Promise((resolve) => {
    dvla = createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const reg = JSON.parse(raw || "{}").registrationNumber;
      dvlaCalls.push({ registration: reg, apiKey: req.headers["x-api-key"] });
      const send = (status, body, headers = {}) => {
        res.writeHead(status, { "content-type": "application/json", ...headers });
        res.end(typeof body === "string" ? body : JSON.stringify(body));
      };
      if (req.headers["x-api-key"] !== DVLA_KEY) return send(403, { message: "Forbidden" });
      switch (reg) {
        case "NF19ABC": return send(404, { errors: [{ status: "404", title: "Vehicle Not Found" }] });
        case "BR19ABC": return send(400, { errors: [{ status: "400", title: "Bad Request" }] });
        case "SE19ABC": return send(500, { errors: [{ status: "500" }] });
        case "BJ19ABC": return send(200, "{not json");
        case "BG19ABC": return send(200, JSON.stringify({ ...DVLA_VEHICLE, registrationNumber: reg, padding: "x".repeat(100_000) }));
        case "WT19ABC": return send(200, { ...DVLA_VEHICLE, registrationNumber: reg, yearOfManufacture: "2018" });
        case "MM19ABC": return send(200, { ...DVLA_VEHICLE, registrationNumber: "ZZ99ZZZ" });
        case "TO19ABC": return; // never answers
        case "RL19ABC": return send(429, { message: "Too Many Requests" }, { "retry-after": "1" });
        case "KY19ABC": return send(403, { message: "Forbidden" });
        case "ED19ABC": return send(200, { ...DVLA_VEHICLE, registrationNumber: reg, fuelType: "ELECTRIC DIESEL" });
        case "GB19ABC": return send(200, { ...DVLA_VEHICLE, registrationNumber: reg, fuelType: "GAS BI-FUEL" });
        case "EV19ABC": return send(200, { ...DVLA_VEHICLE, registrationNumber: reg, fuelType: "ELECTRICITY", engineCapacity: 0 });
        default: return send(200, { ...DVLA_VEHICLE, registrationNumber: reg });
      }
    });
    dvla.listen(0, "127.0.0.1", () => {
      dvlaUrl = `http://127.0.0.1:${dvla.address().port}/vehicle-enquiry/v1/vehicles`;
      resolve();
    });
  });
}

/** Starts another API process (for configuration tests); resolves once it is up or has exited. */
async function startExtraApi(env) {
  const port = API_PORT + 1000 + Math.floor(Math.random() * 1000);
  const entry = fileURLToPath(new URL("../dist/index.mjs", import.meta.url));
  let out = "";
  const child = spawn(process.execPath, [entry], {
    env: {
      PATH: process.env.PATH, PORT: String(port), DATABASE_URL: DB_URL, SUPABASE_URL: supabaseUrl,
      SUPABASE_SECRET_KEY: SECRET_KEY, SUPABASE_JWT_SECRET: JWT_SECRET, STORAGE_WORKER: "off", LOG_LEVEL: "warn", ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { out += d; });
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) break;
    try { if ((await fetch(`http://127.0.0.1:${port}/api/healthz`)).ok) break; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return { child, port, output: () => out };
}

// ─── Fake Supabase (Storage + Auth admin) ───────────────────────────────────

function startFakeSupabase() {
  return new Promise((resolve) => {
    fake = createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = raw ? JSON.parse(raw) : null;
      const url = new URL(req.url, "http://fake");
      calls.push({ method: req.method, path: url.pathname, body, apikey: req.headers.apikey, auth: req.headers.authorization });
      const send = (status, json) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(json)); };
      if (req.headers.apikey !== SECRET_KEY) return send(401, { error: "bad key" });

      let m;
      if (req.method === "POST" && (m = url.pathname.match(/^\/storage\/v1\/object\/upload\/sign\/(.+)$/))) {
        return send(200, { url: `/object/upload/sign/${m[1]}?token=upload-token`, token: "upload-token" });
      }
      if (req.method === "POST" && (m = url.pathname.match(/^\/storage\/v1\/object\/sign\/(.+)$/))) {
        return send(200, { signedURL: `/object/sign/${m[1]}?token=download-token&ttl=${body?.expiresIn}` });
      }
      if (req.method === "DELETE" && (m = url.pathname.match(/^\/storage\/v1\/object\/([^/]+)$/))) {
        return send(200, (body?.prefixes ?? []).map((name) => ({ name, bucket_id: m[1] })));
      }
      if (req.method === "DELETE" && (m = url.pathname.match(/^\/auth\/v1\/admin\/users\/([0-9a-f-]+)$/))) {
        await db.query("delete from auth.users where id = $1", [m[1]]);
        return send(200, {});
      }
      send(404, { error: "not found" });
    });
    fake.listen(0, "127.0.0.1", () => {
      supabaseUrl = `http://127.0.0.1:${fake.address().port}`;
      resolve();
    });
  });
}

// ─── Helpers ────────────────────────────────────────────────────────────────

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");

function sign(claims, { secret = JWT_SECRET, header = { alg: "HS256", typ: "JWT" } } = {}) {
  const h = b64(header);
  const p = b64(claims);
  const s = createHmac("sha256", secret).update(`${h}.${p}`).digest("base64url");
  return `${h}.${p}.${s}`;
}

function tokenFor(sub, extra = {}) {
  const now = Math.floor(Date.now() / 1000);
  return sign({ sub, iss: `${supabaseUrl}/auth/v1`, aud: "authenticated", role: "authenticated", exp: now + 3600, iat: now, ...extra });
}

async function newUser(name = "Driver") {
  const id = randomUUID();
  await db.query("insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)", [id, `${id}@test.local`, { display_name: name }]);
  return { id, name, token: tokenFor(id) };
}

async function call(user, method, path, body, { token, rawBody } = {}) {
  const headers = { "content-type": "application/json" };
  const t = token ?? user?.token;
  if (t) headers.authorization = `Bearer ${t}`;
  const res = await fetch(`http://127.0.0.1:${API_PORT}/api${path}`, {
    method, headers, body: rawBody ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  const text = await res.text();
  responses.push(text);
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json, headers: res.headers };
}

const get = (u, p) => call(u, "GET", p);
const post = (u, p, b) => call(u, "POST", p, b ?? {});
const patch = (u, p, b) => call(u, "PATCH", p, b);
const del = (u, p, b) => call(u, "DELETE", p, b);
const expect = (r, status, what) => assert.equal(r.status, status, `${what}: expected ${status}, got ${r.status} ${JSON.stringify(r.body)}`);
const future = (minutes) => new Date(Date.now() + minutes * 60_000).toISOString();

async function putObject(bucket, name, size, mimetype) {
  await db.query("insert into storage.objects (bucket_id, name, metadata) values ($1, $2, $3)", [bucket, name, { size, mimetype }]);
}

// ─── Lifecycle ──────────────────────────────────────────────────────────────

before(async () => {
  await startFakeSupabase();
  await startStubDvla();
  const entry = fileURLToPath(new URL("../dist/index.mjs", import.meta.url));
  server = spawn(process.execPath, ["--enable-source-maps", entry], {
    env: {
      PATH: process.env.PATH, NODE_ENV: "test", PORT: String(API_PORT), DATABASE_URL: DB_URL,
      SUPABASE_URL: supabaseUrl, SUPABASE_SECRET_KEY: SECRET_KEY, SUPABASE_JWT_SECRET: JWT_SECRET,
      STORAGE_WORKER_INTERVAL_MS: "300", LIVE_LOCATION_CLEANUP_INTERVAL_MS: "300", LOG_LEVEL: "warn",
      DVLA_API_KEY: DVLA_KEY, DVLA_VES_URL: dvlaUrl, DVLA_TIMEOUT_MS: "300",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (d) => { serverOutput += d; });
  server.stderr.on("data", (d) => { serverOutput += d; });
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${API_PORT}/api/healthz`);
      if (r.ok) return;
    } catch { /* not up yet */ }
    if (server.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`API did not start:\n${serverOutput}`);
});

after(async () => {
  server?.kill("SIGTERM");
  fake?.close();
  dvla?.closeAllConnections?.();
  dvla?.close();
  await db.end();
});

// ─── Health, errors, authentication ─────────────────────────────────────────

test("health and readiness", async () => {
  expect(await get(null, "/healthz"), 200, "healthz");
  const ready = await get(null, "/readyz");
  expect(ready, 200, "readyz");
});

test("errors are JSON without internals", async () => {
  const u = await newUser();
  const nf = await get(u, "/nope");
  expect(nf, 404, "unknown route");
  assert.equal(nf.body.error, "not_found");
  const bad = await call(u, "PATCH", "/me", undefined, { rawBody: "{not json" });
  expect(bad, 400, "malformed JSON");
  assert.equal(bad.body.error, "invalid_json");
  assert.ok(!JSON.stringify(bad.body).includes("at "), "no stack trace");
  const badId = await get(u, "/vehicles/not-a-uuid");
  expect(badId, 404, "malformed id");
});

test("only valid Supabase user tokens are accepted", async () => {
  const u = await newUser();
  const now = Math.floor(Date.now() / 1000);
  const base = { sub: u.id, iss: `${supabaseUrl}/auth/v1`, aud: "authenticated", role: "authenticated", exp: now + 600 };
  expect(await get(null, "/me"), 401, "no token");
  expect(await call(null, "GET", "/me", undefined, { token: u.id }), 401, "device id as token");
  expect(await call(null, "GET", "/me", undefined, { token: sign(base, { secret: "wrong" }) }), 401, "bad signature");
  expect(await call(null, "GET", "/me", undefined, { token: sign({ ...base, exp: now - 120 }) }), 401, "expired");
  expect(await call(null, "GET", "/me", undefined, { token: sign({ ...base, iss: "https://evil.example/auth/v1" }) }), 401, "wrong issuer");
  expect(await call(null, "GET", "/me", undefined, { token: sign({ ...base, aud: "other" }) }), 401, "wrong audience");
  expect(await call(null, "GET", "/me", undefined, { token: sign({ ...base, role: "service_role" }) }), 401, "service role token");
  expect(await call(null, "GET", "/me", undefined, { token: sign({ ...base, is_anonymous: true }) }), 401, "anonymous");
  expect(await call(null, "GET", "/me", undefined, { token: sign(base, { header: { alg: "none" } }) }), 401, "alg none");
  expect(await call(null, "GET", "/me", undefined, { token: tokenFor(randomUUID()) }), 403, "no profile");
  const me = await get(u, "/me");
  expect(me, 200, "valid token");
  assert.equal(me.body.id, u.id);
});

// ─── Profile ────────────────────────────────────────────────────────────────

test("profile: editable fields only; XP is server-side", async () => {
  const u = await newUser("Alex");
  const r = await patch(u, "/me", { displayName: "Alex R", xp: 999999, level: 99, totalDistanceKm: 5000 });
  expect(r, 200, "patch me");
  assert.equal(r.body.displayName, "Alex R");
  assert.equal(r.body.xp, 0);
  assert.equal(r.body.level, 1);
  expect(await patch(u, "/me/settings", { profileVisibility: "friends" }), 200, "settings");
});

test("profile visibility and blocks on /users/:id", async () => {
  const a = await newUser("A");
  const b = await newUser("B");
  await patch(a, "/me/settings", { profileVisibility: "private" });
  const view = await get(b, `/users/${a.id}`);
  expect(view, 200, "public card");
  assert.equal(view.body.bio, null, "details hidden");
  expect(await post(a, "/blocks", { userId: b.id }), 204, "block");
  expect(await get(b, `/users/${a.id}`), 404, "blocked user cannot see profile");
});

// ─── Vehicles ───────────────────────────────────────────────────────────────

test("vehicles: ownership, activation, idempotency", async () => {
  const u = await newUser();
  const other = await newUser();
  const v1 = await post(u, "/vehicles", { nickname: "Daily", clientRef: "v1" });
  expect(v1, 201, "create");
  assert.equal(v1.body.isActive, true, "first vehicle active");
  expect(await post(u, "/vehicles", { nickname: "Daily", clientRef: "v1" }), 200, "idempotent retry");
  const v2 = await post(u, "/vehicles", { nickname: "Weekend" });
  assert.equal(v2.body.isActive, false);
  expect(await post(u, `/vehicles/${v2.body.id}/activate`), 200, "activate");
  const list = (await get(u, "/vehicles")).body;
  assert.equal(list.length, 2);
  assert.equal(list.filter((v) => v.isActive).length, 1, "exactly one active");
  expect(await patch(other, `/vehicles/${v1.body.id}`, { nickname: "Mine now" }), 404, "other user cannot edit");
  expect(await del(other, `/vehicles/${v1.body.id}`), 404, "other user cannot delete");
  expect(await patch(u, `/vehicles/${v1.body.id}`, { ownerId: other.id, nickname: "Still mine" }), 200, "ownerId ignored");
  expect(await get(u, `/vehicles/${v1.body.id}`), 200, "still owned");
});

// ─── Journeys ───────────────────────────────────────────────────────────────

// A time zone where `iso` is not between 03:00 and 07:00 local time, so the
// Early Bird achievement never depends on when the tests run.
function zoneAvoidingEarlyBird(iso) {
  for (const tz of ["Europe/London", "Asia/Tokyo", "America/New_York"]) {
    const h = Number(new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", hourCycle: "h23" }).format(new Date(iso)));
    if (h < 3 || h >= 7) return tz;
  }
  throw new Error("no suitable time zone");
}

function track(start, count, stepDeg = 0.009) {
  const t0 = new Date(start).getTime();
  return Array.from({ length: count }, (_, i) => ({
    recordedAt: new Date(t0 + (i + 1) * 60_000).toISOString(),
    latitude: 51.5 + i * stepDeg, longitude: -0.1, speedKmh: 60, accuracyM: 5, altitudeM: 50,
  }));
}

test("journeys: server-side distance, XP, privacy of the route", async () => {
  const u = await newUser();
  const other = await newUser();
  const startedAt = new Date(Date.now() - 30 * 60_000).toISOString();
  const j = await post(u, "/journeys", { startedAt, timezone: zoneAvoidingEarlyBird(startedAt), clientRef: "j1" });
  expect(j, 201, "start");
  const id = j.body.id;

  const pts = track(startedAt, 11); // 10 steps of ~1 km
  expect(await post(u, `/journeys/${id}/route-points`, { points: track(startedAt, 1001, 0.00001).map((p, i) => ({ ...p, recordedAt: new Date(Date.parse(startedAt) + i * 1000).toISOString() })) }), 400, "batch over 1000");
  const first = await post(u, `/journeys/${id}/route-points`, { points: pts });
  expect(first, 200, "points");
  assert.equal(first.body.saved, 11);
  assert.equal((await post(u, `/journeys/${id}/route-points`, { points: pts })).body.saved, 0, "duplicates ignored");
  expect(await post(other, `/journeys/${id}/route-points`, { points: pts }), 404, "other user cannot add points");

  const done = await post(u, `/journeys/${id}/complete`, { distanceKm: 4000, name: "Test run" });
  expect(done, 200, "complete");
  assert.ok(done.body.distanceKm > 9.5 && done.body.distanceKm < 10.5, `server distance ${done.body.distanceKm}`);
  assert.equal(done.body.xpEarned, 100, "10 XP per km");
  assert.deepEqual(done.body.unlockedAchievements, ["first_drive"]);
  const again = await post(u, `/journeys/${id}/complete`, {});
  expect(again, 200, "idempotent completion");
  const me = (await get(u, "/me")).body;
  assert.equal(me.xp, 200, "100 drive XP + 100 First Drive, counted once");
  assert.equal(me.totalJourneys, 1);

  expect(await get(other, `/journeys/${id}`), 404, "private journey hidden");
  expect(await patch(u, `/journeys/${id}`, { visibility: "public" }), 200, "make public");
  const seen = await get(other, `/journeys/${id}`);
  expect(seen, 200, "public journey visible");
  assert.ok(seen.body.publicRoutePolyline, "trimmed route shared");
  assert.equal(seen.body.route, undefined, "full route not shared");
  expect(await get(other, `/journeys/${id}/points`), 404, "raw points owner-only");
  expect(await get(u, `/journeys/${id}/points`), 200, "owner sees points");

  const notes = (await get(u, "/notifications")).body;
  assert.ok(notes.items.some((n) => n.type === "achievement_unlocked"), "achievement notification");
});

test("journeys: unverifiable distances earn the minimum", async () => {
  const u = await newUser();
  const startedAt = new Date(Date.now() - 60 * 60_000).toISOString();
  const j = await post(u, "/journeys", { startedAt });
  const done = await post(u, `/journeys/${j.body.id}/complete`, { distanceKm: 3000 });
  expect(done, 200, "complete");
  assert.ok(done.body.distanceKm <= 350, "capped by elapsed time");
  assert.ok(done.body.xpEarned <= 50, "unverified XP capped");
});

// ─── Friends and blocks ─────────────────────────────────────────────────────

test("friend requests: only the recipient can accept; blocks end everything", async () => {
  const a = await newUser("A");
  const b = await newUser("B");
  const c = await newUser("C");
  const code = (await get(b, "/me")).body.friendCode;

  const sent = await post(a, "/friend-requests", { friendCode: code });
  expect(sent, 201, "send");
  expect(await post(a, "/friend-requests", { friendCode: code }), 409, "duplicate pending");
  expect(await post(a, `/friend-requests/${sent.body.id}/accept`), 404, "sender cannot accept");
  expect(await post(c, `/friend-requests/${sent.body.id}/accept`), 404, "third party cannot accept");
  expect(await post(a, "/friend-requests", { friendCode: (await get(a, "/me")).body.friendCode }), 400, "self");
  expect(await post(a, "/friend-requests", { friendCode: "ZZZZZZZZ" }), 404, "unknown code");

  const incoming = (await get(b, "/friend-requests")).body.incoming;
  assert.equal(incoming.length, 1);
  assert.ok((await get(b, "/notifications")).body.items.some((n) => n.type === "friend_request"));
  expect(await post(b, `/friend-requests/${sent.body.id}/accept`), 200, "recipient accepts");
  assert.equal((await get(a, "/friends")).body.length, 1);
  assert.equal((await get(b, "/friends")).body.length, 1, "friendship both ways");
  assert.ok((await get(a, "/notifications")).body.items.some((n) => n.type === "friend_accepted"));
  expect(await post(a, "/friend-requests", { userId: b.id }), 409, "already friends");

  await patch(c, "/me/settings", { allowFriendRequests: "nobody" });
  expect(await post(a, "/friend-requests", { userId: c.id }), 403, "not accepting");

  expect(await post(b, "/blocks", { userId: a.id }), 204, "block");
  assert.equal((await get(a, "/friends")).body.length, 0, "friendship removed");
  expect(await post(a, "/friend-requests", { friendCode: code }), 404, "blocked looks unknown");
  expect(await del(b, `/blocks/${a.id}`), 204, "unblock");
});

test("friend requests: two drivers asking each other at the same moment become friends", async () => {
  const outcomes = new Map();
  for (let i = 0; i < 25; i++) {
    const a = await newUser(`Mutual A${i}`);
    const b = await newUser(`Mutual B${i}`);
    const [codeA, codeB] = [(await get(a, "/me")).body.friendCode, (await get(b, "/me")).body.friendCode];
    const [ra, rb] = await Promise.all([
      post(a, "/friend-requests", { friendCode: codeB }),
      post(b, "/friend-requests", { friendCode: codeA }),
    ]);
    const key = [`${ra.status}:${ra.body.status}`, `${rb.status}:${rb.body.status}`].sort().join(" + ");
    outcomes.set(key, (outcomes.get(key) ?? 0) + 1);
    // Never a "request already pending" for either of them: one asks, the other's ask accepts it
    assert.equal(key, "200:accepted + 201:pending", `pair ${i}: ${JSON.stringify([ra.body, rb.body])}`);
    // Exactly one friendship (both directions) and no pending request left behind
    const rows = await db.query(
      `select (select count(*)::int from public.friendships where (user_id = $1 and friend_id = $2) or (user_id = $2 and friend_id = $1)) as friendships,
              (select count(*)::int from public.friend_requests where status = 'pending' and ((from_user_id = $1 and to_user_id = $2) or (from_user_id = $2 and to_user_id = $1))) as pending,
              (select count(*)::int from public.friend_requests where (from_user_id = $1 and to_user_id = $2) or (from_user_id = $2 and to_user_id = $1)) as requests`,
      [a.id, b.id]);
    assert.deepEqual(rows.rows[0], { friendships: 2, pending: 0, requests: 1 });
    assert.equal((await get(a, "/friends")).body.length, 1);
    assert.equal((await get(b, "/friends")).body.length, 1);
    assert.deepEqual((await get(a, "/friend-requests")).body, { incoming: [], outgoing: [] });
    assert.deepEqual((await get(b, "/friend-requests")).body, { incoming: [], outgoing: [] });
  }
  // Asking twice yourself is still one request (the second is told it's pending)
  const c = await newUser("Twice C");
  const d = await newUser("Twice D");
  const twice = await Promise.all([post(c, "/friend-requests", { userId: d.id }), post(c, "/friend-requests", { userId: d.id })]);
  assert.deepEqual(twice.map((r) => r.status).sort(), [201, 409]);
  assert.equal(twice.find((r) => r.status === 409).body.error, "request_pending");
});

// ─── Presence ───────────────────────────────────────────────────────────────

const put = (u, p, b) => call(u, "PUT", p, b);
async function befriend(a, b) {
  const sent = await post(a, "/friend-requests", { friendCode: (await get(b, "/me")).body.friendCode });
  expect(sent, 201, "friend request");
  expect(await post(b, `/friend-requests/${sent.body.id}/accept`), 200, "accept");
}
const presenceOf = async (viewer, friendId) => (await get(viewer, "/friends")).body.find((f) => f.id === friendId)?.presence;
const ageHeartbeat = (userId, interval) =>
  db.query(`update public.user_presence set last_seen_at = now() - $2::interval where user_id = $1`, [userId, interval]);

test("presence: owner updates it; friends see online / away / offline / driving and last active", async () => {
  const a = await newUser("A");
  const b = await newUser("B");
  await befriend(a, b);

  // Never reported: offline with no last-active time
  assert.deepEqual(await presenceOf(b, a.id), { status: "offline", lastSeenAt: null });
  expect(await get(a, "/me/presence"), 200, "own presence before any heartbeat");
  assert.equal((await get(a, "/me/presence")).body.status, "offline");

  // Foreground heartbeat: online, stamped with the server clock
  const hb = await put(a, "/me/presence", { appState: "foreground" });
  expect(hb, 200, "heartbeat");
  assert.equal(hb.body.status, "online");
  assert.ok(Math.abs(Date.parse(hb.body.lastSeenAt) - Date.now()) < 60_000);
  assert.equal((await presenceOf(b, a.id)).status, "online");

  // Backgrounded: away at once
  await put(a, "/me/presence", { appState: "background" });
  assert.equal((await presenceOf(b, a.id)).status, "away");

  // Stale heartbeat resolves to offline with no further write; last active kept
  await put(a, "/me/presence", { appState: "foreground" });
  await ageHeartbeat(a.id, "11 minutes");
  const stale = await presenceOf(b, a.id);
  assert.equal(stale.status, "offline");
  assert.ok(stale.lastSeenAt, "last active time is shown when offline");
  await ageHeartbeat(a.id, "5 minutes");
  assert.equal((await presenceOf(b, a.id)).status, "away", "2–10 minutes: away");

  // Driving: with its journey, priority over online, still driving with the phone locked
  const j = await post(a, "/journeys", { clientRef: randomUUID() });
  expect(j, 201, "start journey");
  const drive = await put(a, "/me/presence", { appState: "foreground", driving: true, journeyId: j.body.id });
  expect(drive, 200, "start driving");
  assert.equal(drive.body.status, "driving");
  assert.equal(drive.body.journeyId, j.body.id);
  await put(a, "/me/presence", { appState: "background" }); // driving and journey unchanged when omitted
  assert.equal((await presenceOf(b, a.id)).status, "driving");
  assert.equal((await get(a, "/me/presence")).body.journeyId, j.body.id);

  // A drive that stops reporting doesn't stay "driving"
  await ageHeartbeat(a.id, "4 minutes");
  assert.equal((await presenceOf(b, a.id)).status, "away");
  await ageHeartbeat(a.id, "3 hours");
  assert.equal((await presenceOf(b, a.id)).status, "offline");

  // Completing the journey on the server ends "driving" even if the app never said so
  await put(a, "/me/presence", { appState: "foreground" });
  expect(await post(a, `/journeys/${j.body.id}/complete`, { distanceKm: 0 }), 200, "complete");
  const after = (await get(a, "/me/presence")).body;
  assert.equal(after.driving, false);
  assert.equal(after.journeyId, null);
  assert.equal(after.status, "online");

  // Leaving driving explicitly
  await put(a, "/me/presence", { appState: "foreground", driving: true });
  assert.equal((await put(a, "/me/presence", { appState: "foreground", driving: false })).body.status, "online");

  // Sign-out: offline straight away, driving cleared
  await put(a, "/me/presence", { appState: "foreground", driving: true });
  const out = await put(a, "/me/presence", { appState: "signed_out" });
  assert.equal(out.body.status, "offline");
  assert.equal(out.body.driving, false);
  assert.equal((await presenceOf(b, a.id)).status, "offline");
});

test("presence: a drive started without a journey id stays Driving through later heartbeats", async () => {
  const a = await newUser("A");
  const b = await newUser("B");
  await befriend(a, b);
  expect(await put(a, "/me/presence", { appState: "foreground" }), 200, "heartbeat");
  assert.equal((await presenceOf(b, a.id)).status, "online");
  const start = await put(a, "/me/presence", { appState: "foreground", driving: true });
  expect(start, 200, "drive start without a journey id");
  assert.equal(start.body.status, "driving", "Driving at once");
  // A routine heartbeat that omits driving keeps it
  expect(await put(a, "/me/presence", { appState: "foreground" }), 200, "heartbeat omitting driving");
  assert.equal((await presenceOf(b, a.id)).status, "driving", "the friend still sees Driving");
  // The app's own heartbeat repeats it explicitly
  expect(await put(a, "/me/presence", { appState: "foreground", driving: true }), 200, "heartbeat while driving");
  assert.equal((await presenceOf(b, a.id)).status, "driving");
});

test("presence: changes are pushed to friends' Realtime inboxes, and only theirs", async () => {
  const a = await newUser("A");
  const b = await newUser("B");
  const stranger = await newUser("Stranger");
  await befriend(a, b);
  // B and the stranger have the app open (their own heartbeats)
  await put(b, "/me/presence", { appState: "foreground" });
  await put(stranger, "/me/presence", { appState: "foreground" });
  const inbox = async (u) => (await db.query(
    `select payload from realtime.messages where topic = $1 and event = 'presence' order by inserted_at, id`, [`inbox:${u.id}`])).rows
    .map((r) => r.payload).filter((p) => p.userId === a.id).map((p) => `${p.type}:${p.status ?? "-"}`);

  await put(a, "/me/presence", { appState: "foreground" });
  await put(a, "/me/presence", { appState: "foreground", driving: true });
  await put(a, "/me/presence", { appState: "foreground", driving: false });
  await put(a, "/me/presence", { appState: "background" });
  assert.deepEqual(await inbox(b), ["presence:online", "presence:driving", "presence:online", "presence:away"]);
  assert.deepEqual(await inbox(stranger), [], "a stranger's inbox gets nothing");
  const last = (await db.query(`select payload from realtime.messages where topic = $1 order by inserted_at desc, id desc limit 1`, [`inbox:${b.id}`])).rows[0].payload;
  assert.deepEqual(Object.keys(last).sort(), ["lastSeenAt", "status", "type", "userId"], "only what the friend list shows");

  await patch(a, "/me/settings", { showActivityStatus: false });
  await put(a, "/me/presence", { appState: "foreground" });
  assert.deepEqual((await inbox(b)).slice(4), ["hidden:-"], "hidden at once, then nothing while hidden");
  await patch(a, "/me/settings", { showActivityStatus: true });
  await put(a, "/me/presence", { appState: "signed_out" });
  assert.deepEqual((await inbox(b)).slice(5), ["presence:online", "presence:offline"], "back on, then signed out");

  expect(await post(a, "/blocks", { userId: b.id }), 204, "block");
  assert.deepEqual((await inbox(b)).slice(7), ["unfriended:-"], "a block removes A from B's list at once");
  await put(a, "/me/presence", { appState: "foreground" });
  assert.deepEqual((await inbox(b)).slice(8), [], "and nothing more reaches B");
  await del(a, `/blocks/${b.id}`);
});

test("presence: only friends who are allowed can see it", async () => {
  const a = await newUser("A");
  const friend = await newUser("Friend");
  const stranger = await newUser("Stranger");
  const blocked = await newUser("Blocked");
  await befriend(a, friend);
  await befriend(a, blocked);
  await put(a, "/me/presence", { appState: "foreground" });

  assert.equal((await presenceOf(friend, a.id)).status, "online", "friend sees it");
  assert.equal((await get(stranger, "/friends")).body.length, 0, "a stranger has no friend entry to read");
  expect(await get(stranger, `/users/${a.id}`), 200, "public profile");
  assert.equal((await get(stranger, `/users/${a.id}`)).body.presence, undefined, "no presence on other people's profiles");

  // Turning activity status off hides it from friends (presence: null), not from yourself
  const off = await patch(a, "/me/settings", { showActivityStatus: false });
  expect(off, 200, "settings");
  assert.equal(off.body.settings.showActivityStatus, false);
  const hidden = (await get(friend, "/friends")).body.find((f) => f.id === a.id);
  assert.ok(hidden, "still listed as a friend");
  assert.equal(hidden.presence, null, "presence hidden");
  assert.equal((await get(a, "/me/presence")).body.status, "online", "the owner still sees their own");
  await patch(a, "/me/settings", { showActivityStatus: true });
  assert.equal((await presenceOf(friend, a.id)).status, "online");

  // A block ends the friendship and with it any presence
  expect(await post(a, "/blocks", { userId: blocked.id }), 204, "block");
  assert.equal((await get(blocked, "/friends")).body.length, 0);
  // Even a friendship row left behind would not reveal it: the database rule refuses
  await db.query("insert into public.friendships (user_id, friend_id) values ($1, $2), ($2, $1)", [a.id, blocked.id]);
  assert.equal(await presenceOf(blocked, a.id), null, "blocked: presence null even with a friendship row");
  await db.query("delete from public.friendships where user_id in ($1, $2) and friend_id in ($1, $2)", [a.id, blocked.id]);
});

test("presence: input is validated; journeys must be your own drive in progress", async () => {
  const a = await newUser("A");
  const b = await newUser("B");
  expect(await put(a, "/me/presence", {}), 400, "appState required");
  expect(await put(a, "/me/presence", { appState: "asleep" }), 400, "unknown state");
  expect(await put(a, "/me/presence", { appState: "foreground", driving: "yes" }), 400, "driving must be boolean");
  expect(await put(a, "/me/presence", { appState: "foreground", journeyId: randomUUID() }), 400, "journey only while driving");
  const theirs = await post(b, "/journeys", { clientRef: randomUUID() });
  expect(await put(a, "/me/presence", { appState: "foreground", driving: true, journeyId: theirs.body.id }), 400,
    "someone else's journey");
  expect(await put(a, "/me/presence", { appState: "foreground", driving: true, journeyId: randomUUID() }), 400, "unknown journey");
  expect(await put(null, "/me/presence", { appState: "foreground" }), 401, "signed in only");
  // Driving with no server journey yet (drive started offline) is fine
  expect(await put(a, "/me/presence", { appState: "foreground", driving: true }), 200, "driving without a journey id");
});

// ─── Live location ──────────────────────────────────────────────────────────

// A position nobody else uses, so it can be searched for in the logs.
const HERE = { latitude: 54.321987, longitude: -2.876543 };
const liveInbox = async (viewer, owner) => (await db.query(
  `select payload from realtime.messages where topic = $1 and event = 'live_location' order by inserted_at, id`, [`inbox:${viewer.id}`])).rows
  .map((r) => r.payload).filter((p) => p.userId === owner.id).map((p) => p.type);
const sharedWith = async (viewer) => (await get(viewer, "/live-locations")).body.map((l) => l.userId);
const share = (u, body) => patch(u, "/me/location-sharing", body);
const appOpen = (u, extra = {}) => put(u, "/me/presence", { appState: "foreground", ...extra });

test("live location: off by default; WHEN and WHO are enforced by the server", async () => {
  const a = await newUser("Sharer");
  const f = await newUser("Chosen friend");
  const g = await newUser("Other friend");
  const stranger = await newUser("Stranger");
  await befriend(a, f);
  await befriend(a, g);
  for (const u of [a, f, g, stranger]) await appOpen(u);

  const initial = (await get(a, "/me/location-sharing")).body;
  assert.equal(initial.mode, "off");
  assert.equal(initial.friendAudience, "none");
  assert.equal(initial.sharingWithCount, 0);
  assert.deepEqual(initial.friends.map((x) => x.selected), [false, false]);
  const off = await put(a, "/me/live-location", HERE);
  expect(off, 409, "nothing is stored while sharing is off");
  assert.equal(off.body.error, "sharing_off");
  assert.equal((await db.query("select count(*)::int n from public.live_locations where user_id = $1", [a.id])).rows[0].n, 0);

  // While driving only
  const on = await share(a, { mode: "while_driving", friendAudience: "selected" });
  expect(on, 200, "turn on");
  assert.equal(on.body.sharingWithCount, 0, "no one chosen yet");
  expect(await put(a, `/me/location-sharing/friends/${f.id}`), 200, "choose a friend");
  assert.equal((await get(a, "/me/location-sharing")).body.sharingWithCount, 1);
  const notDriving = await put(a, "/me/live-location", HERE);
  expect(notDriving, 409, "not driving");
  assert.equal(notDriving.body.error, "not_driving");

  await appOpen(a, { driving: true });
  const sent = await put(a, "/me/live-location", { ...HERE, accuracyM: 6, speedMps: 13.4, headingDeg: 271.26, capturedAt: new Date().toISOString() });
  expect(sent, 200, "publish while driving");
  assert.equal(sent.body.driving, true, "driving comes from presence");
  const ttl = Date.parse(sent.body.expiresAt) - Date.now();
  assert.ok(ttl > 150_000 && ttl <= 181_000, "expires in about 3 minutes");

  const seen = (await get(f, "/live-locations")).body;
  assert.equal(seen.length, 1);
  assert.deepEqual(Object.keys(seen[0]).sort(),
    ["accuracyM", "driving", "expiresAt", "expiresInMs", "headingDeg", "latitude", "longitude", "recordedAt", "speedKmh", "userId"]);
  assert.ok(seen[0].expiresInMs > 150_000 && seen[0].expiresInMs <= 180_000, "remaining lifetime by the server's clock");
  assert.equal(seen[0].latitude, 54.32199, "rounded to 5 decimal places");
  assert.equal(seen[0].longitude, -2.87654);
  assert.equal(seen[0].speedKmh, 48.2);
  assert.equal(seen[0].headingDeg, 271.3);
  assert.deepEqual(await sharedWith(g), [], "a friend who was not chosen sees nothing");
  assert.deepEqual(await sharedWith(stranger), [], "a stranger sees nothing");
  assert.deepEqual(await liveInbox(f, a), ["live_location"], "the chosen friend gets it live");
  assert.deepEqual(await liveInbox(g, a), []);
  assert.deepEqual(await liveInbox(stranger, a), []);
  const msg = (await db.query(`select payload from realtime.messages where topic = $1 and event = 'live_location' order by inserted_at desc limit 1`, [`inbox:${f.id}`])).rows[0].payload;
  assert.deepEqual(Object.keys(msg).sort(),
    ["accuracyM", "driving", "expiresAt", "headingDeg", "latitude", "longitude", "recordedAt", "sentAt", "speedKmh", "type", "userId"], "a minimal payload");

  // Removing the friend: gone at once, live and from the snapshot
  expect(await del(a, `/me/location-sharing/friends/${f.id}`), 200, "remove the friend");
  assert.deepEqual(await sharedWith(f), []);
  assert.deepEqual(await liveInbox(f, a), ["live_location", "live_location_hidden"]);

  // All friends
  expect(await share(a, { friendAudience: "all" }), 200, "all friends");
  assert.deepEqual((await sharedWith(f)).length + (await sharedWith(g)).length, 2);
  assert.deepEqual(await sharedWith(stranger), []);

  // The drive ends: the server removes the position (sharing while driving)
  await appOpen(a, { driving: false });
  assert.deepEqual(await sharedWith(g), [], "gone when the drive ends");
  assert.equal((await liveInbox(g, a)).at(-1), "live_location_hidden");

  // While using: on screen counts, the background does not
  expect(await share(a, { mode: "while_using" }), 200, "while using");
  const using = await put(a, "/me/live-location", HERE);
  expect(using, 200, "publish on screen");
  assert.equal(using.body.driving, false);
  assert.deepEqual(await sharedWith(g), [a.id]);
  await put(a, "/me/presence", { appState: "background" });
  assert.deepEqual(await sharedWith(g), [], "removed when the app goes to the background");
  expect(await put(a, "/me/live-location", HERE), 409, "and refused from the background");
  await appOpen(a);
  expect(await put(a, "/me/live-location", HERE), 200, "on screen again");

  // A stale heartbeat (crashed app) doesn't count as using
  await ageHeartbeat(a.id, "5 minutes");
  expect(await put(a, "/me/live-location", HERE), 409, "stale presence");
  await appOpen(a);

  // Stop showing it now
  expect(await del(a, "/me/live-location"), 204, "delete own position");
  assert.deepEqual(await sharedWith(g), []);

  // Turning sharing off: position deleted, everyone told
  expect(await put(a, "/me/live-location", HERE), 200, "publish");
  expect(await share(a, { mode: "off" }), 200, "off");
  assert.equal((await db.query("select count(*)::int n from public.live_locations where user_id = $1", [a.id])).rows[0].n, 0);
  assert.equal((await liveInbox(f, a)).at(-1), "live_location_hidden");
  assert.equal((await liveInbox(g, a)).at(-1), "live_location_hidden");
});

test("live location: unfriending and blocking end access; signing out removes the position", async () => {
  const a = await newUser("Sharer");
  const f = await newUser("Friend");
  const b = await newUser("Blocker");
  await befriend(a, f);
  await befriend(a, b);
  for (const u of [a, f, b]) await appOpen(u);
  await share(a, { mode: "while_using", friendAudience: "selected" });
  await put(a, `/me/location-sharing/friends/${f.id}`);
  await put(a, `/me/location-sharing/friends/${b.id}`);
  expect(await put(a, "/me/live-location", HERE), 200, "publish");
  assert.deepEqual(await sharedWith(f), [a.id]);
  assert.deepEqual(await sharedWith(b), [a.id]);

  expect(await del(f, `/friends/${a.id}`), 204, "the friend unfriends");
  assert.deepEqual(await sharedWith(f), [], "an ex-friend loses access");
  assert.equal((await liveInbox(f, a)).at(-1), "live_location_hidden");
  await befriend(a, f);
  assert.deepEqual(await sharedWith(f), [], "becoming friends again doesn't restore the choice");
  expect(await put(a, `/me/location-sharing/friends/${f.id}`), 200, "chosen again");

  expect(await post(b, "/blocks", { userId: a.id }), 204, "block");
  assert.deepEqual(await sharedWith(b), [], "a block ends it");
  assert.equal((await liveInbox(b, a)).at(-1), "live_location_hidden");
  expect(await put(a, `/me/location-sharing/friends/${b.id}`), 404, "a blocked person can't be chosen");

  await put(a, "/me/presence", { appState: "signed_out" });
  assert.deepEqual(await sharedWith(f), [], "signing out removes it");
  assert.equal((await liveInbox(f, a)).at(-1), "live_location_hidden");
});

test("live location: Convoys share only when turned on, only private code-only ones, only with current members", async () => {
  const a = await newUser("Leader");
  const m = await newUser("Member");
  const p = await newUser("Public joiner");
  const club = await newUser("Club member");
  for (const u of [a, m, p, club]) await appOpen(u);

  const trip = (await post(a, "/convoys", { name: "Scotland Trip", visibility: "private", startsAt: future(60) })).body.id;
  const code = (await post(a, `/convoys/${trip}/code`)).body.code;
  expect(await post(m, "/convoys/join", { code }), 200, "member joins by code");
  const open = (await post(a, "/convoys", { name: "Open run", visibility: "public", startsAt: future(60) })).body.id;
  expect(await post(p, `/convoys/${open}/join`), 200, "anyone joins the public one");
  const g = await post(club, "/groups", { name: "Club", membershipMethod: "open" });
  expect(g, 201, "Community");
  expect(await post(a, `/groups/${g.body.id}/join`), 200, "the sharer is in the Community");
  const clubRun = await post(club, "/convoys", { name: "Club run", visibility: "private", startsAt: future(60), groupId: g.body.id });
  expect(clubRun, 201, "Community Convoy");
  const clubCode = (await post(club, `/convoys/${clubRun.body.id}/code`)).body.code;
  expect(await post(a, "/convoys/join", { code: clubCode }), 200, "the sharer joins the Community Convoy");

  await share(a, { mode: "while_using", friendAudience: "all" });
  expect(await put(a, "/me/live-location", HERE), 200, "publish");
  assert.deepEqual(await sharedWith(m), [], "being in a Convoy shares nothing by itself");
  assert.deepEqual(await sharedWith(club), [], "nor does a Community");

  const state = (await get(a, "/me/location-sharing")).body;
  const byName = Object.fromEntries(state.convoys.map((c) => [c.name, c]));
  assert.equal(byName["Scotland Trip"].eligible, true);
  assert.equal(byName["Open run"].eligible, false, "public Convoys can't be chosen");
  assert.equal(byName["Club run"].eligible, false, "nor Community ones");
  const refused = await put(a, `/me/location-sharing/convoys/${open}`);
  expect(refused, 409, "public Convoy refused");
  assert.equal(refused.body.error, "convoy_not_eligible");
  expect(await put(a, `/me/location-sharing/convoys/${clubRun.body.id}`), 409, "Community Convoy refused");
  expect(await put(m, `/me/location-sharing/convoys/${open}`), 404, "a Convoy you're not in");

  const on = await put(a, `/me/location-sharing/convoys/${trip}`);
  expect(on, 200, "share with the trip");
  assert.equal(on.body.sharingWithCount, 1);
  assert.deepEqual(await sharedWith(m), [a.id], "its member sees it");
  assert.equal((await liveInbox(m, a)).at(-1), "live_location", "and gets it live");
  assert.deepEqual(await sharedWith(p), []);
  assert.deepEqual(await sharedWith(club), []);
  assert.deepEqual(await liveInbox(p, a), []);
  assert.deepEqual(await liveInbox(club, a), []);

  expect(await post(m, `/convoys/${trip}/leave`), 204, "the member leaves");
  assert.deepEqual(await sharedWith(m), [], "leaving ends it");
  assert.equal((await liveInbox(m, a)).at(-1), "live_location_hidden");
  expect(await post(m, "/convoys/join", { code }), 200, "rejoins");
  assert.deepEqual(await sharedWith(m), [a.id]);
  expect(await del(a, `/convoys/${trip}/participants/${m.id}`), 204, "the leader removes them");
  assert.deepEqual(await sharedWith(m), [], "removal ends it");
  assert.equal((await liveInbox(m, a)).at(-1), "live_location_hidden");
  expect(await post(m, "/convoys/join", { code }), 200, "rejoins");
  expect(await del(a, `/me/location-sharing/convoys/${trip}`), 200, "turn the Convoy off");
  assert.deepEqual(await sharedWith(m), []);
  assert.equal((await liveInbox(m, a)).at(-1), "live_location_hidden");

  // Members share back only if they choose to
  await share(m, { mode: "while_using" });
  expect(await put(m, "/me/live-location", HERE), 200, "member publishes");
  assert.deepEqual(await sharedWith(a), [], "turning sharing on doesn't share with a Convoy");
});

test("live location: input is validated; no arbitrary lookups; nothing in the logs", async () => {
  const a = await newUser("A");
  const b = await newUser("B");
  await befriend(a, b);
  await appOpen(a);
  await share(a, { mode: "while_using", friendAudience: "all" });
  for (const bad of [{}, { latitude: 91, longitude: 0 }, { latitude: 0, longitude: -181 }, { latitude: "1", longitude: 0 },
    { ...HERE, accuracyM: -1 }, { ...HERE, speedMps: "fast" }, { ...HERE, capturedAt: "yesterday" }]) {
    expect(await put(a, "/me/live-location", bad), 400, `rejects ${JSON.stringify(bad)}`);
  }
  const stale = await put(a, "/me/live-location", { ...HERE, capturedAt: new Date(Date.now() - 5 * 60_000).toISOString() });
  expect(stale, 409, "an old fix is not live");
  assert.equal(stale.body.error, "stale_fix");
  // Unknown (negative) and impossible values are dropped, not stored
  expect(await put(a, "/me/live-location", { ...HERE, speedMps: -1, headingDeg: -1 }), 200, "unknown speed and heading");
  let l = (await get(b, "/live-locations")).body[0];
  assert.equal(l.speedKmh, null);
  assert.equal(l.headingDeg, null);
  expect(await put(a, "/me/live-location", { ...HERE, speedMps: 500, headingDeg: 720 }), 200, "impossible speed");
  l = (await get(b, "/live-locations")).body[0];
  assert.equal(l.speedKmh, null);
  assert.equal(l.headingDeg, 0);
  expect(await put(a, "/me/live-location", { ...HERE, speedMps: 0.2, headingDeg: 90 }), 200, "standing still");
  assert.equal((await get(b, "/live-locations")).body[0].headingDeg, null, "no heading when stationary");

  expect(await share(a, { mode: "always" }), 400, "always-on sharing isn't available");
  expect(await share(a, { mode: "everyone" }), 400);
  expect(await share(a, { friendAudience: "public" }), 400, "there is no public audience");
  expect(await put(a, `/me/location-sharing/friends/${randomUUID()}`), 404, "only friends can be chosen");
  expect(await put(a, `/me/location-sharing/friends/${a.id}`), 404, "not yourself");
  expect(await get(b, `/users/${a.id}/live-location`), 404, "there is no per-user lookup");
  expect(await get(null, "/live-locations"), 401, "signed in only");
  expect(await put(null, "/me/live-location", HERE), 401, "signed in only");

  // Expired: unreadable at once, removed by the clean-up
  await db.query("update public.live_locations set recorded_at = now() - interval '4 minutes', expires_at = now() - interval '1 minute' where user_id = $1", [a.id]);
  assert.deepEqual(await sharedWith(b), [], "an expired position is not shared");

  // Rate limit
  const many = await Promise.all(Array.from({ length: 32 }, () => put(a, "/me/live-location", HERE)));
  assert.ok(many.some((r) => r.status === 429), "publishing is rate-limited");

  await new Promise((r) => setTimeout(r, 200));
  for (const v of ["54.32", "-2.87"]) assert.ok(!serverOutput.includes(v), `coordinates are never logged (${v})`);
});


test("live location: a Convoy opened up loses its grants; making it private again shares nothing", async () => {
  const a = await newUser("Leader");
  const m = await newUser("Member");
  const x = await newUser("Joined while public");
  for (const u of [a, m, x]) await appOpen(u);
  const trip = (await post(a, "/convoys", { name: "Trip", visibility: "private", startsAt: future(60) })).body.id;
  const code = (await post(a, `/convoys/${trip}/code`)).body.code;
  await post(m, "/convoys/join", { code });
  await share(a, { mode: "while_using" });
  expect(await put(a, `/me/location-sharing/convoys/${trip}`), 200, "share with the trip");
  expect(await put(a, "/me/live-location", HERE), 200, "publish");
  assert.deepEqual(await sharedWith(m), [a.id]);

  expect(await patch(a, `/convoys/${trip}`, { visibility: "public" }), 200, "opened up");
  assert.deepEqual(await sharedWith(m), [], "a public Convoy grants nothing");
  assert.equal((await liveInbox(m, a)).at(-1), "live_location_hidden");
  expect(await post(x, `/convoys/${trip}/join`), 200, "someone joins without a code");
  expect(await patch(a, `/convoys/${trip}`, { visibility: "private" }), 200, "private again");
  assert.deepEqual(await sharedWith(x), [], "whoever joined while it was open sees nothing");
  assert.deepEqual(await sharedWith(m), [], "nor does anyone else until it is turned on again");
  assert.equal((await get(a, "/me/location-sharing")).body.convoys.find((c) => c.id === trip).shared, false, "the switch shows off");
});

test("live location: expired positions and delivered messages are cleaned up", async () => {
  const a = await newUser("A");
  const b = await newUser("B");
  await befriend(a, b);
  await appOpen(a);
  await appOpen(b);
  await share(a, { mode: "while_using", friendAudience: "all" });
  expect(await put(a, "/me/live-location", HERE), 200, "publish");
  assert.deepEqual(await liveInbox(b, a), ["live_location"]);
  // Expired (and so already unreadable): the clean-up deletes it and tells viewers
  await db.query("update public.live_locations set recorded_at = now() - interval '4 minutes', expires_at = now() - interval '1 second' where user_id = $1", [a.id]);
  let gone = false;
  for (let i = 0; i < 40 && !gone; i++) {
    await new Promise((r) => setTimeout(r, 100));
    gone = (await db.query("select count(*)::int n from public.live_locations where user_id = $1", [a.id])).rows[0].n === 0;
  }
  assert.ok(gone, "expired row deleted");
  assert.equal((await liveInbox(b, a)).at(-1), "live_location_hidden", "viewers told to drop it");
  // Delivered messages with positions do not stay in realtime.messages
  await db.query("update realtime.messages set inserted_at = now() - interval '2 minutes' where topic = $1 and event = 'live_location'", [`inbox:${b.id}`]);
  let purged = false;
  for (let i = 0; i < 40 && !purged; i++) {
    await new Promise((r) => setTimeout(r, 100));
    purged = (await liveInbox(b, a)).length === 0;
  }
  assert.ok(purged, "no trail of positions is kept in realtime.messages");
});

// ─── Convoys ────────────────────────────────────────────────────────────────

test("convoys: private visibility, join codes, capacity under concurrency", async () => {
  const leader = await newUser("Leader");
  const stranger = await newUser("Stranger");
  const c = await post(leader, "/convoys", { name: "Night run", visibility: "private", startsAt: future(60), maxParticipants: 3 });
  expect(c, 201, "create");
  assert.equal(c.body.myRole, "leader");
  assert.equal(c.body.leaderName, "Leader", "leader's display name included");
  const id = c.body.id;

  expect(await get(stranger, `/convoys/${id}`), 404, "private convoy hidden");
  expect(await post(stranger, `/convoys/${id}/join`), 404, "cannot join private without code");
  expect(await get(stranger, `/convoys/${id}/code`), 404, "code is leader-only");
  assert.ok(!(await get(stranger, "/convoys")).body.some((x) => x.id === id), "not listed");

  const code = (await post(leader, `/convoys/${id}/code`)).body.code;
  assert.match(code, /^[A-Z0-9]{8}$/);
  expect(await post(stranger, "/convoys/join", { code: "WRONG123" }), 404, "wrong code");

  const joiners = await Promise.all([1, 2, 3, 4, 5].map((i) => newUser(`J${i}`)));
  const results = await Promise.all(joiners.map((u) => post(u, "/convoys/join", { code: code.toLowerCase() })));
  assert.equal(results.filter((r) => r.status === 200).length, 2, "exactly two seats");
  assert.equal(results.filter((r) => r.status === 409 && r.body.error === "convoy_full").length, 3);
  const detail = await get(leader, `/convoys/${id}`);
  assert.equal(detail.body.participants.length, 3);

  const member = joiners[results.findIndex((r) => r.status === 200)];
  expect(await patch(member, `/convoys/${id}`, { name: "Hijack" }), 404, "only leader edits");
  expect(await post(leader, `/convoys/${id}/leave`), 409, "leader cannot leave");
  expect(await patch(leader, `/convoys/${id}`, { status: "active" }), 200, "start");
  const done = await patch(leader, `/convoys/${id}`, { status: "completed" });
  expect(done, 200, "complete");
  assert.equal((await get(leader, "/me")).body.xp, 200, "Convoy Leader XP");
  expect(await post(stranger, "/convoys/join", { code }), 409, "finished convoy");
});

test("convoys: friends-only visibility", async () => {
  const a = await newUser();
  const b = await newUser();
  const c = await post(a, "/convoys", { name: "Friends", visibility: "friends", startsAt: future(30) });
  expect(await post(b, `/convoys/${c.body.id}/join`), 404, "not a friend");
  const req = await post(a, "/friend-requests", { userId: b.id });
  await post(b, `/friend-requests/${req.body.id}/accept`);
  expect(await post(b, `/convoys/${c.body.id}/join`), 200, "friend can join");
});

// ─── Groups ─────────────────────────────────────────────────────────────────

test("groups: membership methods, approvals, admin rights", async () => {
  const owner = await newUser("Owner");
  const u = await newUser("U");
  const g = await post(owner, "/groups", { name: "Club", membershipMethod: "request" });
  expect(g, 201, "create");
  const id = g.body.id;
  const j = await post(u, `/groups/${id}/join`);
  expect(j, 200, "request");
  assert.equal(j.body.myStatus, "pending");
  expect(await post(u, `/groups/${id}/join`), 409, "already requested");
  expect(await patch(u, `/groups/${id}`, { name: "Mine" }), 404, "non-member cannot edit");
  expect(await post(owner, `/groups/${id}/members/${u.id}/approve`), 200, "approve");
  assert.equal((await get(u, `/groups/${id}`)).body.myStatus, "active");
  expect(await patch(u, `/groups/${id}`, { name: "Mine" }), 403, "member cannot edit");
  expect(await del(u, `/groups/${id}/members/${owner.id}`), 403, "member cannot remove owner");

  const priv = await post(owner, "/groups", { name: "Secret", isPublic: false, membershipMethod: "invite" });
  const x = await newUser();
  expect(await get(x, `/groups/${priv.body.id}`), 404, "private group hidden");
  expect(await post(x, `/groups/${priv.body.id}/join`), 404, "cannot join hidden group");
  const code = (await post(owner, `/groups/${priv.body.id}/code`)).body.code;
  expect(await post(x, "/groups/join", { code }), 200, "join by code");
  expect(await get(x, `/groups/${priv.body.id}/code`), 403, "members cannot read the code");

  const inv = await post(owner, "/groups", { name: "Invite", membershipMethod: "invite" });
  expect(await post(x, `/groups/${inv.body.id}/join`), 403, "invite-only");
});

// ─── Events ─────────────────────────────────────────────────────────────────

test("events: capacity under concurrency, private invitations", async () => {
  const org = await newUser("Org");
  const e = await post(org, "/events", { name: "Meet", startsAt: future(120), capacity: 2, eventType: "static_car_meet" });
  expect(e, 201, "create");
  assert.equal(e.body.organiserName, "Org", "organiser's display name included");
  const people = await Promise.all([1, 2, 3, 4, 5].map((i) => newUser(`P${i}`)));
  const rs = await Promise.all(people.map((p) => call(p, "PUT", `/events/${e.body.id}/rsvp`, { status: "going" })));
  assert.equal(rs.filter((r) => r.status === 200).length, 2, "capacity respected");
  assert.equal(rs.filter((r) => r.status === 409).length, 3);
  const turnedAway = people[rs.findIndex((r) => r.status === 409)];
  expect(await call(turnedAway, "PUT", `/events/${e.body.id}/rsvp`, { status: "interested" }), 200, "interested is unlimited");
  expect(await patch(org, `/events/${e.body.id}`, { capacity: 1 }), 409, "capacity below attendance");

  const p = await post(org, "/events", { name: "Private", visibility: "private", startsAt: future(60) });
  const guest = people[0];
  expect(await get(guest, `/events/${p.body.id}`), 404, "private event hidden");
  expect(await post(org, `/events/${p.body.id}/invites`, { userId: guest.id }), 400, "only friends/group");
  const fr = await post(org, "/friend-requests", { userId: guest.id });
  await post(guest, `/friend-requests/${fr.body.id}/accept`);
  expect(await post(org, `/events/${p.body.id}/invites`, { userId: guest.id }), 201, "invite friend");
  expect(await get(guest, `/events/${p.body.id}`), 200, "invited guest can see");
  expect(await patch(guest, `/events/${p.body.id}`, { name: "x" }), 404, "only organiser edits");
});

// ─── Saved locations ────────────────────────────────────────────────────────

test("locations: home is private; public spots are discoverable", async () => {
  const u = await newUser();
  const other = await newUser();
  await patch(u, "/me/settings", { defaultLocationVisibility: "public" });
  expect(await post(u, "/locations", { kind: "home", name: "Home", lat: 51.5, lng: -0.12, visibility: "public" }), 400, "public home refused");
  const home2 = await post(u, "/locations", { kind: "home", name: "Home 2", lat: 51.5, lng: -0.12 });
  expect(home2, 201, "home");
  assert.equal(home2.body.visibility, "private", "home is private despite a public default");
  expect(await patch(u, `/locations/${home2.body.id}`, { visibility: "friends" }), 404, "home cannot be shared later");
  expect(await get(other, `/locations/${home2.body.id}`), 404, "private location hidden");
  const spot = await post(u, "/locations", { kind: "beauty_spot", name: "View", lat: 51.51, lng: -0.12, visibility: "public" });
  const near = await get(other, "/locations/nearby?lat=51.5&lng=-0.12&radius=5000");
  expect(near, 200, "nearby");
  assert.ok(near.body.some((s) => s.id === spot.body.id), "public spot found");
  assert.ok(!near.body.some((s) => s.id === home2.body.id), "private not found");
});

// ─── Uploads ────────────────────────────────────────────────────────────────

test("uploads: signed URLs, size/type checks, private documents", async () => {
  const u = await newUser();
  const other = await newUser();
  const v = (await post(u, "/vehicles", { nickname: "Car" })).body;

  expect(await post(other, "/uploads", { kind: "vehicle-photo", parentId: v.id, sizeBytes: 1000, mimeType: "image/jpeg" }), 404, "not your vehicle");
  expect(await post(u, "/uploads", { kind: "vehicle-photo", parentId: v.id, sizeBytes: 6 * 1024 * 1024, mimeType: "image/jpeg" }), 400, "too large");
  expect(await post(u, "/uploads", { kind: "vehicle-photo", parentId: v.id, sizeBytes: 1000, mimeType: "image/gif" }), 400, "bad type");

  const up = await post(u, "/uploads", { kind: "vehicle-photo", parentId: v.id, sizeBytes: 1000, mimeType: "image/jpeg" });
  expect(up, 201, "upload url");
  assert.ok(up.body.path.startsWith(`${u.id}/${v.id}/`), "server-chosen path in own folder");
  assert.ok(up.body.uploadUrl.startsWith(supabaseUrl), "signed upload URL");
  const signCall = calls.find((c) => c.path.includes("/upload/sign/"));
  assert.equal(signCall.apikey, SECRET_KEY);
  assert.equal(signCall.auth, undefined, "sb_ keys are not sent as bearer tokens");

  expect(await post(u, `/uploads/${up.body.id}/confirm`), 400, "not uploaded yet");
  await putObject("vehicle-photos", up.body.path, 9 * 1024 * 1024, "image/jpeg");
  expect(await post(u, `/uploads/${up.body.id}/confirm`), 400, "real size too large");
  await db.query("update storage.objects set metadata = $1 where name = $2", [{ size: 1000, mimetype: "image/jpeg" }, up.body.path]);
  expect(await post(other, `/uploads/${up.body.id}/confirm`), 404, "other user cannot confirm");
  expect(await post(u, `/uploads/${up.body.id}/confirm`), 200, "confirmed");
  const cover = await patch(u, `/vehicles/${v.id}`, { coverPhotoId: up.body.id });
  expect(cover, 200, "set cover photo");
  assert.ok(cover.body.coverPhotoUrl?.includes("ttl=3600"), "vehicle carries a 1-hour signed cover URL");
  assert.ok((await get(u, "/vehicles")).body[0].coverPhotoUrl, "listed vehicles carry the cover URL");
  expect(await patch(other, `/vehicles/${v.id}`, { coverPhotoId: up.body.id }), 404, "other user cannot set cover");

  const doc = await post(u, "/uploads", { kind: "vehicle-document", parentId: v.id, sizeBytes: 2000, mimeType: "application/pdf", docType: "insurance" });
  expect(doc, 201, "document upload url");
  await putObject("vehicle-documents", doc.body.path, 2000, "application/pdf");
  expect(await post(u, `/uploads/${doc.body.id}/confirm`), 200, "document confirmed");
  expect(await get(other, `/documents/${doc.body.id}/url`), 404, "documents are owner-only");
  const url = await get(u, `/documents/${doc.body.id}/url`);
  expect(url, 200, "owner document url");
  assert.ok(url.body.url.includes("ttl=60"), "60-second document link");

  const avatar = await post(u, "/uploads", { kind: "avatar", sizeBytes: 500, mimeType: "image/png" });
  await putObject("avatars", avatar.body.path, 500, "image/png");
  expect(await post(other, "/uploads/image/confirm", { kind: "avatar", path: avatar.body.path }), 403, "cannot take another's avatar");
  expect(await post(u, "/uploads/image/confirm", { kind: "avatar", path: avatar.body.path }), 200, "avatar set");
});

// ─── Reports ────────────────────────────────────────────────────────────────

test("reports: only for content you can see", async () => {
  const u = await newUser();
  const other = await newUser();
  const hidden = await post(other, "/locations", { kind: "favourite_road", name: "Secret road", lat: 52, lng: -1, visibility: "private" });
  expect(await post(u, "/reports", { targetType: "location", targetId: hidden.body.id, reason: "spam" }), 404, "invisible target");
  const spot = await post(other, "/locations", { kind: "beauty_spot", name: "Spot", lat: 52, lng: -1, visibility: "public" });
  expect(await post(u, "/reports", { targetType: "location", targetId: spot.body.id, reason: "spam" }), 201, "report");
  expect(await post(u, "/reports", { targetType: "location", targetId: spot.body.id, reason: "spam" }), 200, "duplicate accepted quietly");
});

// ─── Account deletion and Storage clean-up ──────────────────────────────────

test("account deletion removes data and queues files for the worker", async () => {
  const u = await newUser();
  const v = (await post(u, "/vehicles", { nickname: "Gone" })).body;
  const up = await post(u, "/uploads", { kind: "vehicle-photo", parentId: v.id, sizeBytes: 1000, mimeType: "image/jpeg" });
  await putObject("vehicle-photos", up.body.path, 1000, "image/jpeg");
  await post(u, `/uploads/${up.body.id}/confirm`);

  expect(await del(u, "/me", {}), 400, "confirmation required");
  expect(await del(u, "/me", { confirm: "DELETE" }), 204, "deleted");
  assert.ok(calls.some((c) => c.method === "DELETE" && c.path === `/auth/v1/admin/users/${u.id}`), "Auth user deleted");
  expect(await get(u, "/me"), 403, "token no longer usable");
  const left = await db.query("select count(*)::int as n from public.vehicles where owner_id = $1", [u.id]);
  assert.equal(left.rows[0].n, 0, "data cascaded");

  // The worker drains the queue through the Storage API.
  for (let i = 0; i < 50; i++) {
    const q = await db.query("select count(*)::int as n from private.storage_delete_queue where path = $1", [up.body.path]);
    if (q.rows[0].n === 0) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  const q = await db.query("select count(*)::int as n from private.storage_delete_queue where path = $1", [up.body.path]);
  assert.equal(q.rows[0].n, 0, "queue drained");
  assert.ok(calls.some((c) => c.method === "DELETE" && c.path === "/storage/v1/object/vehicle-photos" && c.body.prefixes.includes(up.body.path)), "file removed via Storage API");
});

// ─── Registration lookup (DVLA VES, via the local stub) ─────────────────────

const lookup = (u, registration) => post(u, "/vehicles/lookup", registration === undefined ? {} : { registration });
const dvlaCallCount = () => dvlaCalls.length;

test("vehicles: registrations are stored upper case without spaces; foreign plates keep hyphens", async () => {
  const u = await newUser();
  const uk = await post(u, "/vehicles", { nickname: "UK", registration: " ab12 cde " });
  expect(uk, 201, "create");
  assert.equal(uk.body.registration, "AB12CDE");
  const foreign = await post(u, "/vehicles", { nickname: "German", registration: "b-mw 1234" });
  assert.equal(foreign.body.registration, "B-MW1234");
  expect(await post(u, "/vehicles", { nickname: "Long", registration: "ABCDE FGHIJK" }), 400, "over 10 characters");
});

test("lookup: returns suggestions only; the key goes to DVLA and nowhere else; nothing is stored", async () => {
  const u = await newUser();
  expect(await call(null, "POST", "/vehicles/lookup", { registration: "AB12CDE" }), 401, "sign-in required");

  const before = dvlaCallCount();
  const r = await lookup(u, "ab12 cde");
  expect(r, 200, "lookup");
  assert.deepEqual(r.body.vehicle, { make: "VOLKSWAGEN", colour: "BLUE", fuelType: "PETROL", yearOfManufacture: 2018, engineCapacityCc: 1984 });
  assert.deepEqual(r.body.suggested, { make: "Volkswagen", colour: "Blue", fuelType: "petrol", year: 2018, engine: "2.0L" });
  assert.equal(r.body.registration, "AB12CDE");
  assert.equal(r.body.displayRegistration, "AB12 CDE");
  assert.equal(r.body.source, "dvla");
  assert.ok(!Number.isNaN(Date.parse(r.body.checkedAt)));
  assert.deepEqual(Object.keys(r.body).sort(), ["checkedAt", "displayRegistration", "registration", "source", "suggested", "vehicle"]);
  for (const hidden of ["Taxed", "Valid", "2020-01-01", "co2", DVLA_KEY]) {
    assert.ok(!JSON.stringify(r.body).includes(hidden), `response must not include ${hidden}`);
  }
  assert.equal(dvlaCallCount(), before + 1);
  assert.equal(dvlaCalls.at(-1).apiKey, DVLA_KEY, "key sent to DVLA");
  assert.equal(dvlaCalls.at(-1).registration, "AB12CDE", "normalised before sending");

  expect(await lookup(u, "AB12CDE"), 200, "cached");
  assert.equal(dvlaCallCount(), before + 1, "served from the cache");
  const rows = await db.query("select count(*)::int as n from public.vehicles where owner_id = $1", [u.id]);
  assert.equal(rows.rows[0].n, 0, "a lookup creates nothing");
});

test("lookup: fuel types are mapped, including hybrids, LPG and electric", async () => {
  const u = await newUser();
  assert.equal((await lookup(u, "ED19ABC")).body.suggested.fuelType, "hybrid", "ELECTRIC DIESEL");
  assert.equal((await lookup(u, "GB19ABC")).body.suggested.fuelType, "other", "GAS BI-FUEL");
  const ev = (await lookup(u, "EV19ABC")).body.suggested;
  assert.equal(ev.fuelType, "electric", "ELECTRICITY");
  assert.equal(ev.engine, null, "no engine size for an EV");
});

test("lookup: anything that isn't a UK registration never reaches DVLA", async () => {
  const u = await newUser();
  const before = dvlaCallCount();
  for (const bad of ["", "   ", "B-MW 1234", "ABCDEFGH", "AB12CD€", "123456", "x".repeat(40)]) {
    const r = await lookup(u, bad);
    expect(r, 400, JSON.stringify(bad));
    assert.equal(r.body.error, "invalid_registration");
  }
  expect(await lookup(u, undefined), 400, "missing");
  expect(await call(u, "POST", "/vehicles/lookup", { registration: 12345 }), 400, "not a string");
  assert.equal(dvlaCallCount(), before);
});

test("lookup: each DVLA failure becomes a stable error code", async () => {
  const cases = [
    ["NF19ABC", 404, "vehicle_not_found"],
    ["BR19ABC", 400, "invalid_registration"],
    ["SE19ABC", 503, "lookup_unavailable"],
    ["BJ19ABC", 502, "lookup_bad_response"],
    ["BG19ABC", 502, "lookup_bad_response"],
    ["OK19ABC", 200, null], // a success in between keeps the failure breaker closed
    ["WT19ABC", 502, "lookup_bad_response"],
    ["MM19ABC", 502, "lookup_bad_response"],
    ["TO19ABC", 504, "lookup_timeout"],
  ];
  for (const [reg, status, code] of cases) {
    const u = await newUser();
    const r = await lookup(u, reg);
    expect(r, status, reg);
    if (code) {
      assert.equal(r.body.error, code, reg);
      assert.equal(typeof r.body.message, "string");
      assert.ok(!/errors|Forbidden|Bad Request|padding/.test(JSON.stringify(r.body)), `${reg}: DVLA's own response is never passed on`);
    }
  }
});

test("lookup: 10 a minute per user", async () => {
  const u = await newUser();
  await lookup(u, "AB12CDE"); // cached from earlier; no DVLA call
  const before = dvlaCallCount();
  for (let i = 0; i < 9; i++) expect(await lookup(u, "AB12CDE"), 200, `lookup ${i + 2}`);
  const limited = await lookup(u, "AB12CDE");
  expect(limited, 429, "11th lookup");
  assert.equal(limited.body.error, "rate_limited");
  assert.ok(Number(limited.headers.get("retry-after")) > 0);
  assert.equal(dvlaCallCount(), before, "cache hits only");
  expect(await lookup(await newUser(), "AB12CDE"), 200, "other users unaffected");
});

test("lookup: without a key the server says so and never calls DVLA", async () => {
  const extra = await startExtraApi({ NODE_ENV: "test" });
  try {
    const u = await newUser();
    const before = dvlaCallCount();
    const res = await fetch(`http://127.0.0.1:${extra.port}/api/vehicles/lookup`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${u.token}` },
      body: JSON.stringify({ registration: "AB12CDE" }),
    });
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error, "lookup_not_configured");
    assert.equal(dvlaCallCount(), before);
  } finally {
    extra.child.kill("SIGTERM");
  }
});

test("lookup: the server refuses to start with a non-DVLA URL (the key can't be sent elsewhere)", async () => {
  for (const [env, url] of [["production", "https://evil.example/vehicle-enquiry/v1/vehicles"], ["production", dvlaUrl]]) {
    const extra = await startExtraApi({ NODE_ENV: env, DVLA_API_KEY: DVLA_KEY, DVLA_VES_URL: url });
    for (let i = 0; i < 50 && extra.child.exitCode === null; i++) await new Promise((r) => setTimeout(r, 100));
    const exited = extra.child.exitCode;
    extra.child.kill("SIGTERM");
    assert.notEqual(exited, null, `${url}: the server must not start`);
    assert.notEqual(exited, 0);
    assert.match(extra.output(), /DVLA_VES_URL must be/);
    assert.ok(!extra.output().includes(DVLA_KEY), "the key is not printed");
  }
});

// These leave the lookup paused, so they run last.
test("lookup: DVLA throttling and a rejected key pause further calls", async () => {
  const busy = await lookup(await newUser(), "RL19ABC");
  expect(busy, 503, "DVLA 429");
  assert.equal(busy.body.error, "lookup_busy");
  assert.equal(busy.headers.get("retry-after"), "1");
  let before = dvlaCallCount();
  const waiting = await lookup(await newUser(), "PA19ABC");
  assert.equal(waiting.body.error, "lookup_busy", "paused");
  assert.equal(dvlaCallCount(), before, "no DVLA call while paused");
  await new Promise((r) => setTimeout(r, 1100));
  expect(await lookup(await newUser(), "PA19ABC"), 200, "resumes after Retry-After");

  const rejected = await lookup(await newUser(), "KY19ABC");
  expect(rejected, 503, "DVLA 403");
  assert.equal(rejected.body.error, "lookup_unavailable");
  before = dvlaCallCount();
  expect(await lookup(await newUser(), "PB19ABC"), 503, "paused after the key was rejected");
  assert.equal(dvlaCallCount(), before);
  // The log is written asynchronously; give it a moment.
  for (let i = 0; i < 40 && !/DVLA rejected the API key/.test(serverOutput); i++) await new Promise((r) => setTimeout(r, 50));
  assert.match(serverOutput, /DVLA rejected the API key/);
});

test("the DVLA key and looked-up registrations never appear in responses or logs", async () => {
  await new Promise((r) => setTimeout(r, 300)); // let the last log lines arrive
  assert.ok(responses.length > 50 && serverOutput.length > 0);
  for (const secret of [DVLA_KEY]) {
    assert.ok(!responses.some((r) => r.includes(secret)), "no response contains the key");
    assert.ok(!serverOutput.includes(secret), "the log does not contain the key");
  }
  for (const reg of ["AB12CDE", "SE19ABC", "BJ19ABC", "TO19ABC", "KY19ABC", "RL19ABC"]) {
    assert.ok(!serverOutput.includes(reg), `the log does not contain ${reg}`);
  }
});
