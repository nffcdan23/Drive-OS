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
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json };
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
  const entry = fileURLToPath(new URL("../dist/index.mjs", import.meta.url));
  let output = "";
  server = spawn(process.execPath, ["--enable-source-maps", entry], {
    env: {
      PATH: process.env.PATH, NODE_ENV: "test", PORT: String(API_PORT), DATABASE_URL: DB_URL,
      SUPABASE_URL: supabaseUrl, SUPABASE_SECRET_KEY: SECRET_KEY, SUPABASE_JWT_SECRET: JWT_SECRET,
      STORAGE_WORKER_INTERVAL_MS: "300", LOG_LEVEL: "warn",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (d) => { output += d; });
  server.stderr.on("data", (d) => { output += d; });
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${API_PORT}/api/healthz`);
      if (r.ok) return;
    } catch { /* not up yet */ }
    if (server.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`API did not start:\n${output}`);
});

after(async () => {
  server?.kill("SIGTERM");
  fake?.close();
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

// ─── Convoys ────────────────────────────────────────────────────────────────

test("convoys: private visibility, join codes, capacity under concurrency", async () => {
  const leader = await newUser("Leader");
  const stranger = await newUser("Stranger");
  const c = await post(leader, "/convoys", { name: "Night run", visibility: "private", startsAt: future(60), maxParticipants: 3 });
  expect(c, 201, "create");
  assert.equal(c.body.myRole, "leader");
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
