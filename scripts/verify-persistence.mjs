/**
 * Persistence verification script.
 * Runs all 20 test scenarios against the local API server.
 * Uses a fresh device UUID so each run starts from zero.
 */
import { randomUUID } from 'crypto';

const API  = 'http://localhost:8080';
const DEVICE_ID = randomUUID();
const AUTH = { 'Authorization': `Bearer ${DEVICE_ID}`, 'Content-Type': 'application/json' };

let passed = 0;
let failed = 0;

function ok(label, value) {
  if (value) {
    console.log(`  ✓  ${label}`);
    passed++;
  } else {
    console.error(`  ✗  ${label}`);
    failed++;
  }
}

async function api(method, path, body) {
  const opts = { method, headers: AUTH };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const r = await fetch(`${API}${path}`, opts);
  const text = await r.text();
  try { return { status: r.status, body: JSON.parse(text) }; }
  catch { return { status: r.status, body: text }; }
}

async function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─────────────────────────────────────────────
console.log(`\nDevice ID: ${DEVICE_ID}\n`);

// ── TESTS 1-2: New session, empty account ──────────────────────────────
console.log('=== TESTS 1-2: New session / empty account ===');
const me0  = (await api('GET', '/api/users/me')).body;
const veh0 = (await api('GET', '/api/vehicles')).body;
const jrn0 = (await api('GET', '/api/journeys')).body;

ok('Account created (got user id)',            !!me0.id);
ok('XP starts at 0',                          me0.xp === 0);
ok('totalJourneys starts at 0',               me0.totalJourneys === 0);
ok('totalDistance starts at 0',               me0.totalDistance === 0);
ok('No vehicles',                             Array.isArray(veh0) && veh0.length === 0);
ok('No journeys',                             Array.isArray(jrn0) && jrn0.length === 0);
// Community (groups/convoys/friends) — routes exist but are community-scoped;
// we just verify the user stats are zero (community not expanded in this task).

// ── TEST 3: Add one vehicle ────────────────────────────────────────────
console.log('\n=== TEST 3: Add one vehicle ===');
const v = (await api('POST', '/api/vehicles', {
  nickname: 'Test Hatch', make: 'Honda', model: 'Civic',
  year: 2020, colour: 'Blue', fuelType: 'petrol', registration: 'TEST001',
})).body;
ok('Vehicle created with id',      !!v.id);
ok('Nickname stored correctly',    v.nickname === 'Test Hatch');
ok('Make stored correctly',        v.make === 'Honda');
const VEHICLE_ID = v.id;

// ── TESTS 4-5: Simulate restart — re-fetch from API ───────────────────
console.log('\n=== TESTS 4-5: Simulate app restart — vehicle persists ===');
// "Restart" = a fresh GET with the same device ID (same as what the app does on mount)
const veh1 = (await api('GET', '/api/vehicles')).body;
ok('Vehicles list non-empty after restart',   Array.isArray(veh1) && veh1.length === 1);
ok('Same vehicle id survives restart',        veh1[0]?.id === VEHICLE_ID);
ok('Nickname survives restart',               veh1[0]?.nickname === 'Test Hatch');

// ── TESTS 6-9: Short drive ────────────────────────────────────────────
console.log('\n=== TESTS 6-9: Record a short drive ===');
const j = (await api('POST', '/api/journeys', {
  name: 'Test Drive', startTimeIso: new Date().toISOString(),
  vehicleId: VEHICLE_ID,
})).body;
ok('Journey created (active)',   !!j.id && j.status === 'active');
const JOURNEY_ID = j.id;

// Batch 5 route points
const t0 = Date.now();
const pts = Array.from({ length: 5 }, (_, i) => ({
  latitude:  51.500 + i * 0.001,
  longitude: -0.100 + i * 0.001,
  speedKmh:  30 + i * 5,
  accuracyM: 5,
  recordedAt: new Date(t0 + i * 2000).toISOString(),
}));
const rp = (await api('POST', `/api/journeys/${JOURNEY_ID}/route-points`, { points: pts })).body;
ok('5 route points saved',   rp.saved === 5);

// Complete with custom name + stats
const endTime = new Date().toISOString();
const complete1 = await api('POST', `/api/journeys/${JOURNEY_ID}/complete`, {
  name: 'My Custom Drive',
  endTimeIso:      endTime,
  durationSeconds: 120,
  distanceKm:      2.5,
  avgSpeedKmh:     42,
  topSpeedKmh:     65,
  notes:           'Verification test drive',
});
ok('Complete returns 200',           complete1.status === 200);
ok('Status is completed',            complete1.body.status === 'completed');
ok('Custom name stored',             complete1.body.name === 'My Custom Drive');
ok('distanceKm stored',              complete1.body.distanceKm === 2.5);
ok('topSpeedKmh stored',             complete1.body.topSpeedKmh === 65);
const XP_EXPECTED = Math.min(500, Math.max(50, Math.round(2.5 * 10)));
ok(`XP earned = ${XP_EXPECTED}`,     complete1.body.xpEarned === XP_EXPECTED);

// ── TEST 10: Single record, points attached, stats correct, XP once ───
console.log('\n=== TEST 10: One journey, route points attached, stats/XP correct ===');
const jrn2 = (await api('GET', '/api/journeys')).body;
ok('Exactly one journey in list',    Array.isArray(jrn2) && jrn2.length === 1);
ok('Journey id matches',             jrn2[0]?.id === JOURNEY_ID);
ok('Journey status completed',       jrn2[0]?.status === 'completed');

const me1 = (await api('GET', '/api/users/me')).body;
ok('totalJourneys = 1',             me1.totalJourneys === 1);
ok('totalDistance = 2.5',           me1.totalDistance === 2.5);
ok(`xp = ${XP_EXPECTED}`,           me1.xp === XP_EXPECTED);

// ── TESTS 11-12: Restart — journey and route persist ─────────────────
console.log('\n=== TESTS 11-12: Simulate restart — journey & route survive ===');
const jrn3 = (await api('GET', '/api/journeys')).body;
ok('Journey list still has 1 entry', jrn3.length === 1);
ok('Name survives restart',          jrn3[0]?.name === 'My Custom Drive');
ok('distanceKm survives restart',    jrn3[0]?.distanceKm === 2.5);
ok('Status still completed',         jrn3[0]?.status === 'completed');

// ── TESTS 13-14: Duplicate completion — idempotency ───────────────────
console.log('\n=== TESTS 13-14: Submit journey completion twice — no duplicates ===');
const complete2 = await api('POST', `/api/journeys/${JOURNEY_ID}/complete`, {
  name: 'My Custom Drive',
  endTimeIso:      endTime,
  durationSeconds: 120,
  distanceKm:      2.5,
  avgSpeedKmh:     42,
  topSpeedKmh:     65,
});
ok('Second complete returns 200 (idempotent)',  complete2.status === 200);
ok('Status still completed after 2nd call',    complete2.body.status === 'completed');

const me2 = (await api('GET', '/api/users/me')).body;
ok('No extra journey in total (still 1)',  me2.totalJourneys === 1);
ok('No extra XP on second complete',       me2.xp === XP_EXPECTED);
ok('No extra distance on second complete', me2.totalDistance === 2.5);

const jrn4 = (await api('GET', '/api/journeys')).body;
ok('Still exactly one journey after duplicate call', jrn4.length === 1);

// Route points after second call — route-points endpoint should refuse writes to completed journey
const rp2 = (await api('POST', `/api/journeys/${JOURNEY_ID}/route-points`, { points: pts })).body;
ok('Route-point flush on completed journey returns saved:0', rp2.saved === 0);

// ── TESTS 15-17: Delete journey, restart, confirm gone ────────────────
console.log('\n=== TESTS 15-17: Delete journey, restart, confirm deleted ===');
const del1 = await api('DELETE', `/api/journeys/${JOURNEY_ID}`);
ok('DELETE journey returns 204',   del1.status === 204);

const jrn5 = (await api('GET', '/api/journeys')).body;
ok('Journey list empty after delete',   Array.isArray(jrn5) && jrn5.length === 0);

// Simulate restart
const jrn6 = (await api('GET', '/api/journeys')).body;
ok('Journey still gone after restart',  jrn6.length === 0);

// ── TESTS 18-20: Delete vehicle, restart, no crash ────────────────────
console.log('\n=== TESTS 18-20: Delete vehicle, restart, historical journeys intact ===');
const del2 = await api('DELETE', `/api/vehicles/${VEHICLE_ID}`);
ok('DELETE vehicle returns 204',   del2.status === 204);

const veh2 = (await api('GET', '/api/vehicles')).body;
ok('Vehicle list empty after delete',   Array.isArray(veh2) && veh2.length === 0);

// Simulate restart
const veh3 = (await api('GET', '/api/vehicles')).body;
ok('Vehicle still gone after restart',  veh3.length === 0);

// Journeys that referenced this vehicle should not error the /journeys list
// (we deleted the journey in tests 15-17, so nothing should reference it)
const jrn7 = await api('GET', '/api/journeys');
ok('GET /journeys does not error after vehicle delete', jrn7.status === 200);

// ── SUMMARY ────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
