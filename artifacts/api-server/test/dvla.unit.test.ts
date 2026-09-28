// Unit tests for the DVLA VES client (no network: fetch is faked).
// Run: node --experimental-transform-types --no-warnings --test test/dvla.unit.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DvlaClient, DvlaConfigError, LookupError, MAX_RESPONSE_BYTES, parseVesResponse, readDvlaConfig,
  suggestColour, suggestEngine, suggestFuelType, suggestMake, type DvlaConfig,
} from "../src/lib/dvla.ts";

const KEY = "test-dvla-key-0123456789";
const URL_ = "https://driver-vehicle-licensing.api.gov.uk/vehicle-enquiry/v1/vehicles";
const cfg = (over: Partial<DvlaConfig> = {}): DvlaConfig => ({ apiKey: KEY, url: URL_, timeoutMs: 8000, ...over });

const VEHICLE = {
  registrationNumber: "AB12CDE", make: "VOLKSWAGEN", colour: "BLUE", fuelType: "PETROL",
  yearOfManufacture: 2018, engineCapacity: 1984, taxStatus: "Taxed", motStatus: "Valid",
  dateOfLastV5CIssued: "2020-01-01",
};

type Call = { url: string; init: RequestInit };

/** A fake fetch answering from a function; records every call. */
function fakeFetch(answer: (body: { registrationNumber: string }, init: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return answer(JSON.parse(String(init.body)), init);
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

function client(answer: Parameters<typeof fakeFetch>[0], over: Partial<DvlaConfig> = {}) {
  const f = fakeFetch(answer);
  const clock = { t: 1_000_000 };
  const logs: Array<{ level: string; obj: object; msg: string }> = [];
  const c = new DvlaClient(cfg(over), {
    fetch: f.fn, now: () => clock.t,
    log: { warn: (obj, msg) => logs.push({ level: "warn", obj, msg }), error: (obj, msg) => logs.push({ level: "error", obj, msg }) },
  });
  return { c, calls: f.calls, clock, logs };
}

async function rejectsWith(p: Promise<unknown>, code: string, status?: number) {
  await assert.rejects(p, (err: unknown) => {
    assert.ok(err instanceof LookupError, `expected LookupError, got ${String(err)}`);
    assert.equal(err.code, code);
    if (status !== undefined) assert.equal(err.status, status);
    return true;
  });
}

// ─── Configuration: the key can only go to DVLA ─────────────────────────────

test("config: defaults to DVLA live; accepts DVLA UAT", () => {
  assert.equal(readDvlaConfig({}).url, URL_);
  assert.equal(readDvlaConfig({}).apiKey, null);
  const uat = "https://uat.driver-vehicle-licensing.api.gov.uk/vehicle-enquiry/v1/vehicles";
  assert.equal(readDvlaConfig({ DVLA_VES_URL: uat, DVLA_API_KEY: KEY }).url, uat);
});

test("config: refuses any URL that isn't DVLA's over HTTPS", () => {
  for (const bad of [
    "http://driver-vehicle-licensing.api.gov.uk/vehicle-enquiry/v1/vehicles",
    "https://driver-vehicle-licensing.api.gov.uk.evil.example/vehicle-enquiry/v1/vehicles",
    "https://evil.example/vehicle-enquiry/v1/vehicles",
    "https://driver-vehicle-licensing.api.gov.uk/other/path",
    "https://driver-vehicle-licensing.api.gov.uk:8443/vehicle-enquiry/v1/vehicles",
    "https://user:pass@driver-vehicle-licensing.api.gov.uk/vehicle-enquiry/v1/vehicles",
    "https://driver-vehicle-licensing.api.gov.uk/vehicle-enquiry/v1/vehicles?x=1",
    "http://127.0.0.1:9000/vehicle-enquiry/v1/vehicles", // a stub, outside tests
    "not a url",
  ]) {
    assert.throws(() => readDvlaConfig({ DVLA_VES_URL: bad, NODE_ENV: "production" }), DvlaConfigError, bad);
  }
});

test("config: a loopback stub is allowed only when NODE_ENV is test", () => {
  const stub = "http://127.0.0.1:9000/vehicle-enquiry/v1/vehicles";
  assert.equal(readDvlaConfig({ DVLA_VES_URL: stub, NODE_ENV: "test" }).url, stub);
  assert.throws(() => readDvlaConfig({ DVLA_VES_URL: stub, NODE_ENV: "development" }), DvlaConfigError);
  assert.throws(() => readDvlaConfig({ DVLA_VES_URL: "http://10.0.0.5/x", NODE_ENV: "test" }), DvlaConfigError);
});

test("config: a key with spaces or line breaks is refused; timeout is clamped", () => {
  assert.throws(() => readDvlaConfig({ DVLA_API_KEY: "abc def ghijk" }), DvlaConfigError);
  assert.throws(() => readDvlaConfig({ DVLA_API_KEY: "abcdefgh\nijk" }), DvlaConfigError);
  assert.equal(readDvlaConfig({ DVLA_API_KEY: `  ${KEY}\n` }).apiKey, KEY); // surrounding whitespace trimmed
  assert.equal(readDvlaConfig({ DVLA_TIMEOUT_MS: "5" }).timeoutMs, 100);
  assert.equal(readDvlaConfig({ DVLA_TIMEOUT_MS: "999999" }).timeoutMs, 15_000);
  assert.equal(readDvlaConfig({}).timeoutMs, 8_000);
});

// ─── Mapping DVLA values onto the form ──────────────────────────────────────

test("fuel types map onto the app's options", () => {
  const cases: Array<[string | null, string | null]> = [
    ["PETROL", "petrol"], ["DIESEL", "diesel"], ["HEAVY OIL", "diesel"],
    ["ELECTRICITY", "electric"], ["ELECTRIC", "electric"],
    ["HYBRID ELECTRIC", "hybrid"], ["ELECTRIC DIESEL", "hybrid"], ["ELECTRIC PETROL", "hybrid"],
    ["GAS BI-FUEL", "other"], ["GAS", "other"], ["PETROL/GAS", "other"], ["GAS/PETROL", "other"],
    ["GAS DIESEL", "other"], ["STEAM", "other"], ["FUEL CELLS", "other"], ["OTHER", "other"],
    ["something new", "other"], ["  petrol ", "petrol"], ["", null], [null, null],
  ];
  for (const [raw, want] of cases) assert.equal(suggestFuelType(raw), want, String(raw));
});

test("engine, make and colour suggestions", () => {
  assert.equal(suggestEngine(1598), "1.6L");
  assert.equal(suggestEngine(999), "1.0L");
  assert.equal(suggestEngine(0), null);
  assert.equal(suggestEngine(null), null);
  assert.equal(suggestMake("VOLKSWAGEN"), "Volkswagen");
  assert.equal(suggestMake("MERCEDES-BENZ"), "Mercedes-Benz");
  assert.equal(suggestMake("LAND ROVER"), "Land Rover");
  assert.equal(suggestMake("BMW"), "BMW");
  assert.equal(suggestMake("MINI"), "MINI");
  assert.equal(suggestMake(null), null);
  assert.equal(suggestColour("DARK BLUE"), "Dark Blue");
  assert.equal(suggestColour(null), null);
});

// ─── Strict response parsing ────────────────────────────────────────────────

test("VES responses are parsed strictly", () => {
  const v = parseVesResponse({ ...VEHICLE, colour: " BLUE\u0000 ", extraField: { anything: 1 } }, "AB12CDE");
  assert.deepEqual(v, { make: "VOLKSWAGEN", colour: "BLUE", fuelType: "PETROL", yearOfManufacture: 2018, engineCapacityCc: 1984 });
  assert.deepEqual(parseVesResponse({}, "AB12CDE"), { make: null, colour: null, fuelType: null, yearOfManufacture: null, engineCapacityCc: null });
  for (const bad of [
    null, [], "text", 42,
    { ...VEHICLE, registrationNumber: "ZZ99ZZZ" },  // not the vehicle asked for
    { ...VEHICLE, make: 7 },
    { ...VEHICLE, make: "X".repeat(101) },
    { ...VEHICLE, yearOfManufacture: "2018" },
    { ...VEHICLE, yearOfManufacture: 1066 },
    { ...VEHICLE, engineCapacity: 1.5 },
    { ...VEHICLE, engineCapacity: -1 },
  ]) {
    assert.throws(() => parseVesResponse(bad, "AB12CDE"), undefined, JSON.stringify(bad));
  }
});

// ─── Client behaviour ───────────────────────────────────────────────────────

test("a lookup sends the key only in x-api-key, never follows redirects, and returns only what we use", async () => {
  const { c, calls } = client(() => json(200, VEHICLE));
  const r = await c.lookup("ab12 cde");
  assert.equal(calls.length, 1);
  const init = calls[0]!.init;
  assert.equal(calls[0]!.url, URL_);
  assert.equal(init.method, "POST");
  assert.equal(init.redirect, "error");
  assert.equal((init.headers as Record<string, string>)["x-api-key"], KEY);
  assert.deepEqual(JSON.parse(String(init.body)), { registrationNumber: "AB12CDE" });
  assert.equal(r.registration, "AB12CDE");
  assert.equal(r.displayRegistration, "AB12 CDE");
  assert.equal(r.source, "dvla");
  assert.deepEqual(r.suggested, { make: "Volkswagen", colour: "Blue", fuelType: "petrol", year: 2018, engine: "2.0L" });
  const text = JSON.stringify(r);
  for (const hidden of ["Taxed", "Valid", "2020-01-01", KEY]) assert.ok(!text.includes(hidden), `result must not include ${hidden}`);
});

test("invalid registrations and a missing key never reach DVLA", async () => {
  const { c, calls } = client(() => json(200, VEHICLE));
  for (const bad of ["", "A", "ABCDEFGH", "AB12CD£", "ABCDEF", "123456", "B-MW 1234", "AB12-CDE", "x".repeat(30)]) {
    await rejectsWith(c.lookup(bad), "invalid_registration", 400);
  }
  const off = client(() => json(200, VEHICLE), { apiKey: null });
  await rejectsWith(off.c.lookup("AB12CDE"), "lookup_not_configured", 503);
  assert.equal(calls.length + off.calls.length, 0);
});

test("results are cached for 15 minutes; identical lookups at once share one call", async () => {
  const { c, calls, clock } = client(() => json(200, VEHICLE));
  const [a, b] = await Promise.all([c.lookup("AB12CDE"), c.lookup(" ab12cde ")]);
  assert.equal(calls.length, 1);
  assert.deepEqual(a, b);
  await c.lookup("AB12 CDE");
  assert.equal(calls.length, 1);
  clock.t += 15 * 60_000 + 1;
  await c.lookup("AB12CDE");
  assert.equal(calls.length, 2);
});

test("DVLA 404 → vehicle_not_found, remembered for 10 minutes", async () => {
  const { c, calls, clock } = client(() => json(404, { errors: [{ status: "404", title: "Vehicle Not Found" }] }));
  await rejectsWith(c.lookup("AB12CDE"), "vehicle_not_found", 404);
  await rejectsWith(c.lookup("AB12CDE"), "vehicle_not_found", 404);
  assert.equal(calls.length, 1);
  clock.t += 10 * 60_000 + 1;
  await rejectsWith(c.lookup("AB12CDE"), "vehicle_not_found", 404);
  assert.equal(calls.length, 2);
});

test("DVLA 400 → invalid_registration", async () => {
  const { c } = client(() => json(400, { errors: [{ status: "400" }] }));
  await rejectsWith(c.lookup("AB12CDE"), "invalid_registration", 400);
});

test("DVLA 429 → lookup_busy; further calls wait for DVLA's Retry-After", async () => {
  const { c, calls, clock } = client(() => json(429, {}, { "retry-after": "30" }));
  await assert.rejects(c.lookup("AB12CDE"), (e: LookupError) => e.code === "lookup_busy" && e.status === 503 && e.retryAfterSec === 30);
  await rejectsWith(c.lookup("XY12ABC"), "lookup_busy", 503);
  assert.equal(calls.length, 1, "no call while paused");
  clock.t += 30_001;
  await rejectsWith(c.lookup("XY12ABC"), "lookup_busy");
  assert.equal(calls.length, 2);
});

test("DVLA 403 (key rejected) → lookup_unavailable, a 5-minute pause and an error log without secrets", async () => {
  const { c, calls, clock, logs } = client(() => json(403, { message: "Forbidden" }));
  await rejectsWith(c.lookup("AB12CDE"), "lookup_unavailable", 503);
  await rejectsWith(c.lookup("AB12CDE"), "lookup_unavailable", 503);
  assert.equal(calls.length, 1);
  assert.ok(logs.some((l) => l.level === "error" && /rejected the API key/.test(l.msg)));
  clock.t += 5 * 60_000 + 1;
  await rejectsWith(c.lookup("AB12CDE"), "lookup_unavailable");
  assert.equal(calls.length, 2);
});

test("DVLA 5xx → lookup_unavailable; five failures in a row pause calls for 30 s", async () => {
  const { c, calls, clock } = client(() => json(500, {}));
  for (let i = 0; i < 5; i++) await rejectsWith(c.lookup(`AB1${i}CDE`), "lookup_unavailable", 503);
  assert.equal(calls.length, 5);
  await rejectsWith(c.lookup("AB19CDE"), "lookup_unavailable", 503);
  assert.equal(calls.length, 5, "paused");
  clock.t += 30_001;
  await rejectsWith(c.lookup("AB19CDE"), "lookup_unavailable");
  assert.equal(calls.length, 6);
});

test("a success resets the failure count", async () => {
  let fail = true;
  const { c, calls } = client(() => (fail ? json(503, {}) : json(200, { ...VEHICLE, registrationNumber: undefined })));
  for (let i = 0; i < 4; i++) await rejectsWith(c.lookup(`AB1${i}CDE`), "lookup_unavailable");
  fail = false;
  await c.lookup("AB15CDE");
  fail = true;
  for (let i = 6; i < 10; i++) await rejectsWith(c.lookup(`AB1${i}CDE`), "lookup_unavailable");
  assert.equal(calls.length, 9, "never paused: no five failures in a row");
});

test("network failure → lookup_unavailable; timeout → lookup_timeout", async () => {
  const net = client(() => { throw new TypeError("fetch failed"); });
  await rejectsWith(net.c.lookup("AB12CDE"), "lookup_unavailable", 503);

  // Never answers: only the abort signal ends it.
  const slow = new DvlaClient(cfg({ timeoutMs: 100 }), {
    fetch: ((_: string, init: RequestInit) => new Promise((_, reject) => {
      init.signal!.addEventListener("abort", () => reject(init.signal!.reason));
    })) as unknown as typeof fetch,
  });
  // AbortSignal.timeout doesn't hold the event loop open (a real socket would).
  const keepAlive = setInterval(() => {}, 20);
  try {
    await rejectsWith(slow.lookup("AB12CDE"), "lookup_timeout", 504);
  } finally {
    clearInterval(keepAlive);
  }
});

test("malformed, oversized or mismatched responses → lookup_bad_response", async () => {
  const bodies: Array<() => Response> = [
    () => new Response("{not json", { status: 200 }),
    () => json(200, ["not", "an", "object"]),
    () => json(200, { ...VEHICLE, yearOfManufacture: "old" }),
    () => json(200, { ...VEHICLE, registrationNumber: "ZZ99ZZZ" }),
    // Declared too large.
    () => new Response("{}", { status: 200, headers: { "content-length": String(MAX_RESPONSE_BYTES + 1) } }),
    // Streamed too large without a length.
    () => new Response(new ReadableStream({
      start(ctl) { for (let i = 0; i < 20; i++) ctl.enqueue(new Uint8Array(8 * 1024).fill(32)); ctl.close(); },
    }), { status: 200 }),
  ];
  for (const [i, body] of bodies.entries()) {
    const { c } = client(body);
    await rejectsWith(c.lookup("AB12CDE"), "lookup_bad_response", 502).catch((e) => { throw new Error(`case ${i}: ${e}`); });
  }
});

test("logs never contain the key or a registration", async () => {
  const outcomes = [() => json(500, {}), () => json(403, {}), () => json(429, {}), () => new Response("{", { status: 200 })];
  const all: string[] = [];
  for (const o of outcomes) {
    const { c, logs } = client(o);
    await c.lookup("AB12CDE").catch(() => {});
    all.push(JSON.stringify(logs));
  }
  const text = all.join("\n");
  assert.ok(text.length > 20, "something was logged");
  for (const secret of [KEY, "AB12CDE", "AB12 CDE"]) assert.ok(!text.includes(secret), `logs must not include ${secret}`);
});
