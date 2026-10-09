// Unit tests for the Mapbox Directions client (no network: fetch is faked).
// Run: node --experimental-transform-types --no-warnings --test test/navigation.unit.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  DIRECTIONS_PARAMS, DirectionsClient, DirectionsConfigError, MAPBOX_API_ORIGIN, RoutingError,
  directionsUrl, parseDirectionsResponse, readDirectionsConfig, type DirectionsConfig, type RouteRequest,
} from "../src/lib/mapboxDirections.ts";
import { encodePolyline } from "../src/lib/geo.ts";

// Assembled at run time so no token-shaped literal sits in the repository
const TOKEN = ["sk", "test-directions-token-0123456789abcdef"].join(".");
const cfg = (over: Partial<DirectionsConfig> = {}): DirectionsConfig => ({ token: TOKEN, origin: MAPBOX_API_ORIGIN, ...over });

// Keswick to Ambleside (synthetic route; not Mapbox data)
const REQ: RouteRequest = {
  origin: { lat: 54.600123, lng: -3.134567, headingDeg: 181.6 },
  destination: { lat: 54.428765, lng: -2.961234 },
};
const LINE = [
  { lat: 54.600123, lng: -3.134567 }, { lat: 54.55, lng: -3.08 }, { lat: 54.5, lng: -3.02 }, { lat: 54.428765, lng: -2.961234 },
];

function step(over: Record<string, unknown> = {}) {
  return {
    distance: 1000, duration: 60, name: "Lake Road", ref: "A591", destinations: "A591: Ambleside", exits: "", driving_side: "left",
    maneuver: { type: "roundabout", modifier: "left", exit: 2, bearing_before: 175, bearing_after: 190, location: [-3.08, 54.55], instruction: "At the roundabout, take the 2nd exit onto the A591." },
    bannerInstructions: [{ primary: { text: "A591" }, secondary: { text: "Ambleside" } }],
    voiceInstructions: [{ distanceAlongGeometry: 400, announcement: "In 400 yards, at the roundabout, take the 2nd exit.", ssmlAnnouncement: "<speak>…</speak>" }],
    ...over,
  };
}
function route(over: Record<string, unknown> = {}) {
  return {
    geometry: encodePolyline(LINE, 6), distance: 24500.4, duration: 1980.2, duration_typical: 1800, weight: 2000,
    legs: [{
      distance: 24500.4, duration: 1980.2, summary: "A591",
      steps: [step(), step({ distance: 23500.4, duration: 1920.2, maneuver: { type: "arrive", location: [-2.961234, 54.428765] } })],
      annotation: {
        congestion: ["low", "heavy", "unknown"],
        maxspeed: [{ speed: 30, unit: "mph" }, { unknown: true }, { speed: 100, unit: "km/h" }],
      },
    }],
    ...over,
  };
}
const OK = { code: "Ok", uuid: "resp-123", routes: [route(), route({ distance: 26000, duration: 2100 })] };

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

function client(answer: (url: string, init: RequestInit) => Response | Promise<Response>, over: Partial<DirectionsConfig> = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const logs: Array<{ level: string; obj: object; msg: string }> = [];
  const clock = { t: 1_000_000 };
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return answer(url, init);
  }) as unknown as typeof fetch;
  const c = new DirectionsClient(cfg(over), {
    fetch: fetchFn, now: () => clock.t,
    log: { warn: (obj, msg) => logs.push({ level: "warn", obj, msg }), error: (obj, msg) => logs.push({ level: "error", obj, msg }) },
  });
  return { c, calls, logs, clock };
}

async function rejectsWith(p: Promise<unknown>, code: string, status?: number) {
  await assert.rejects(p, (err: unknown) => {
    assert.ok(err instanceof RoutingError, `expected RoutingError, got ${String(err)}`);
    assert.equal(err.code, code);
    if (status !== undefined) assert.equal(err.status, status);
    return true;
  });
}

/** Nothing logged may carry a coordinate, the token or a URL */
function assertLogsClean(logs: Array<{ obj: object; msg: string }>) {
  const text = JSON.stringify(logs);
  for (const secret of [TOKEN, "54.6", "-3.13", "54.42", "-2.96", "api.mapbox.com", "directions/v5"]) {
    assert.ok(!text.includes(secret), `logs mention ${secret}: ${text}`);
  }
}

// ─── Configuration: the token is server-only and goes only to Mapbox ────────

test("config: token optional, validated; the host can only be Mapbox outside the test suite", () => {
  assert.deepEqual(readDirectionsConfig({}), { token: null, origin: MAPBOX_API_ORIGIN });
  assert.equal(readDirectionsConfig({ MAPBOX_DIRECTIONS_TOKEN: ` ${TOKEN} \n` }).token, TOKEN);
  assert.throws(() => readDirectionsConfig({ MAPBOX_DIRECTIONS_TOKEN: "not a token" }), DirectionsConfigError);
  assert.throws(() => readDirectionsConfig({ MAPBOX_DIRECTIONS_TOKEN: "pk.short" }), DirectionsConfigError);
  // The test stub: loopback HTTP, only with NODE_ENV=test
  assert.equal(readDirectionsConfig({ NODE_ENV: "test", MAPBOX_DIRECTIONS_URL: "http://127.0.0.1:4321/" }).origin, "http://127.0.0.1:4321");
  for (const [env, url] of [
    ["production", "http://127.0.0.1:4321/"],
    ["test", "https://evil.example.com/"],
    ["test", "http://example.com/"],
    ["test", "http://127.0.0.1:4321/directions"],
  ] as const) {
    assert.throws(() => readDirectionsConfig({ NODE_ENV: env, MAPBOX_DIRECTIONS_URL: url }), DirectionsConfigError, `${env} ${url}`);
  }
});

test("request: driving-traffic, UK English, British imperial voice units, alternatives, full polyline6 overview", () => {
  const url = new URL(directionsUrl(REQ, TOKEN));
  assert.equal(url.origin, "https://api.mapbox.com");
  assert.equal(url.pathname, "/directions/v5/mapbox/driving-traffic/-3.134567,54.600123;-2.961234,54.428765.json");
  const p = url.searchParams;
  assert.equal(p.get("language"), "en-GB");
  assert.equal(p.get("voice_units"), "british_imperial");
  assert.equal(p.get("alternatives"), "true");
  assert.equal(p.get("steps"), "true");
  assert.equal(p.get("banner_instructions"), "true");
  assert.equal(p.get("voice_instructions"), "true");
  assert.equal(p.get("geometries"), "polyline6");
  assert.equal(p.get("overview"), "full");
  assert.equal(p.get("annotations"), "duration,distance,congestion,maxspeed");
  assert.equal(p.get("bearings"), "182,45;", "leaves in the direction the car points");
  assert.equal(p.get("access_token"), TOKEN);
  assert.deepEqual(Object.keys(DIRECTIONS_PARAMS).sort(), [...new Set([...p.keys()])].filter((k) => k !== "bearings" && k !== "access_token").sort());
  // No heading (or a nonsense one): no bearing constraint
  assert.equal(new URL(directionsUrl({ ...REQ, origin: { ...REQ.origin, headingDeg: null } }, TOKEN)).searchParams.get("bearings"), null);
});

test("parse: routes become Derwent's format (alternatives, steps, UK details, annotations)", () => {
  const r = parseDirectionsResponse(OK);
  assert.equal(r.provider, "mapbox");
  assert.equal(r.providerResponseId, "resp-123");
  assert.equal(r.routes.length, 2);
  const [main, alt] = r.routes;
  assert.equal(main!.index, 0);
  assert.equal(alt!.index, 1);
  assert.equal(main!.geometry, encodePolyline(LINE, 6));
  assert.equal(main!.distanceM, 24500.4);
  assert.equal(main!.durationS, 1980.2);
  assert.equal(main!.typicalDurationS, 1800);
  assert.equal(main!.summary, "A591");
  const s = main!.legs[0]!.steps[0]!;
  assert.deepEqual(s.maneuver, {
    type: "roundabout", modifier: "left", exit: 2, bearingBefore: 175, bearingAfter: 190,
    location: { lat: 54.55, lng: -3.08 }, instruction: "At the roundabout, take the 2nd exit onto the A591.",
  });
  assert.equal(s.roadRef, "A591");
  assert.equal(s.signposts, "A591: Ambleside");
  assert.equal(s.junctionRef, null);
  assert.equal(s.drivingSide, "left");
  assert.deepEqual(s.banner, { primary: "A591", secondary: "Ambleside" });
  assert.deepEqual(s.voice, [{ distanceBeforeM: 400, text: "In 400 yards, at the roundabout, take the 2nd exit." }]);
  assert.equal(main!.legs[0]!.steps[1]!.startDistanceM, 1000);
  assert.deepEqual(main!.legs[0]!.congestion, [1, 3, 0]);
  assert.deepEqual(main!.legs[0]!.maxspeedKmh, [48, null, 100]);
  // At most three routes, however many come back
  assert.equal(parseDirectionsResponse({ ...OK, routes: [route(), route(), route(), route()] }).routes.length, 3);
  // Optional detail missing or malformed is dropped, not fatal
  const sparse = parseDirectionsResponse({ code: "Ok", routes: [route({ legs: [{ distance: 1, duration: 1, steps: [{ distance: 1, duration: 1, maneuver: { location: [0, 0] }, bannerInstructions: "x", voiceInstructions: [null, { announcement: 3 }] }] }] })] });
  const sp = sparse.routes[0]!.legs[0]!.steps[0]!;
  assert.equal(sp.banner, null);
  assert.deepEqual(sp.voice, []);
  assert.equal(sparse.routes[0]!.legs[0]!.congestion, null);
});

test("parse: no route, no road nearby and impossible requests are typed; garbage is a bad response", () => {
  assert.throws(() => parseDirectionsResponse({ code: "NoRoute", routes: [] }), (e: unknown) => e instanceof RoutingError && e.code === "route_not_found");
  assert.throws(() => parseDirectionsResponse({ code: "NoSegment" }), (e: unknown) => e instanceof RoutingError && e.code === "route_no_road");
  assert.throws(() => parseDirectionsResponse({ code: "InvalidInput", message: "Route exceeds maximum distance limitation" }), (e: unknown) => e instanceof RoutingError && e.code === "route_not_found");
  assert.throws(() => parseDirectionsResponse({ code: "Ok", routes: [] }), (e: unknown) => e instanceof RoutingError && e.code === "route_not_found");
  for (const bad of [null, [], "x", { code: "Weird" }, { code: "Ok", routes: [{ legs: [] }] }, { code: "Ok", routes: [route({ geometry: 5 })] }, { code: "Ok", routes: [route({ distance: -1 })] }]) {
    assert.throws(() => parseDirectionsResponse(bad), (e: unknown) => !(e instanceof RoutingError));
  }
});

// ─── Client ─────────────────────────────────────────────────────────────────

test("client: one GET to Mapbox's API host only, never following a redirect, 8 s timeout", async () => {
  const { c, calls, logs } = client(() => json(200, OK));
  const r = await c.routes(REQ);
  assert.equal(r.routes.length, 2);
  assert.equal(calls.length, 1);
  assert.ok(calls[0]!.url.startsWith("https://api.mapbox.com/directions/v5/mapbox/driving-traffic/"));
  assert.equal(calls[0]!.init.method, "GET");
  assert.equal(calls[0]!.init.redirect, "error");
  assert.ok(calls[0]!.init.signal instanceof AbortSignal);
  assert.equal(calls[0]!.init.body, undefined);
  assert.deepEqual(logs, []);
  // The response is Derwent's format: Mapbox's own fields (and the token) never pass through
  const text = JSON.stringify(r);
  for (const leaked of [TOKEN, "ssmlAnnouncement", "bannerInstructions", "weight", "\"code\""]) assert.ok(!text.includes(leaked), leaked);
});

test("client: not configured answers navigation_unavailable without calling Mapbox", async () => {
  const { c, calls } = client(() => json(200, OK), { token: null });
  assert.equal(c.configured, false);
  await rejectsWith(c.routes(REQ), "navigation_unavailable", 503);
  assert.equal(calls.length, 0);
});

test("client: provider failures become typed errors; logs carry status codes only", async () => {
  {
    const { c, calls, logs, clock } = client(() => json(429, { message: "Too many" }, { "retry-after": "12" }));
    await assert.rejects(c.routes(REQ), (e: unknown) => e instanceof RoutingError && e.code === "routing_busy" && e.retryAfterSec === 12);
    // Paused: no call while Mapbox asked us to wait
    await rejectsWith(c.routes(REQ), "routing_busy", 503);
    assert.equal(calls.length, 1);
    clock.t += 13_000;
    await rejectsWith(c.routes(REQ), "routing_busy");
    assert.equal(calls.length, 2);
    assertLogsClean(logs);
  }
  {
    const { c, calls, logs } = client(() => json(401, { message: "Not Authorized - Invalid Token" }));
    await rejectsWith(c.routes(REQ), "routing_unavailable", 503);
    await rejectsWith(c.routes(REQ), "routing_unavailable", 503);
    assert.equal(calls.length, 1, "a rejected token pauses calls");
    assert.equal(logs[0]!.level, "error");
    assertLogsClean(logs);
  }
  for (const [answer, code] of [
    [() => json(500, { message: "oops" }), "routing_unavailable"],
    [() => json(200, "{not json"), "routing_bad_response"],
    [() => json(200, { code: "Ok", routes: [{ geometry: "" }] }), "routing_bad_response"],
    [() => json(200, { code: "NoRoute", routes: [] }), "route_not_found"],
    [() => json(422, { code: "InvalidInput", message: "too far" }), "route_not_found"],
    [() => json(200, { code: "NoSegment" }), "route_no_road"],
    [() => new Response("x".repeat(10), { status: 200, headers: { "content-length": String(64 * 1024 * 1024) } }), "routing_bad_response"],
    [() => { throw Object.assign(new Error("timed out"), { name: "TimeoutError" }); }, "routing_timeout"],
    [() => { throw new TypeError(`fetch failed for ${directionsUrl(REQ, TOKEN)}`); }, "routing_unavailable"],
  ] as const) {
    const { c, logs } = client(answer as () => Response);
    await rejectsWith(c.routes(REQ), code);
    assertLogsClean(logs);
  }
});

test("source: the client and route never log bodies, never cache, never touch the database", () => {
  const lib = readFileSync(new URL("../src/lib/mapboxDirections.ts", import.meta.url), "utf8");
  const route = readFileSync(new URL("../src/routes/navigation.ts", import.meta.url), "utf8");
  const code = (t: string) => t.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  for (const [name, text] of [["lib", code(lib)], ["route", code(route)]] as const) {
    assert.ok(!/@workspace\/db|\bdb\.|asUser|\.insert\(|\.update\(/.test(text), `${name} touches the database`);
    assert.ok(!/new Map|cache\s*[=:]|setItem|writeFile/.test(text), `${name} keeps responses`);
    assert.ok(!/log(ger)?\.\w+\([^)]*(req\.body|request|origin|destination|url|token)/i.test(text), `${name} logs request data`);
  }
  // The route reads its coordinates from the body only, never the URL
  assert.ok(!/req\.(query|params)/.test(code(route)));
  assert.match(route, /requireUser/);
  assert.match(route, /rateLimit\(\{ name: "route", windowMs: 60_000, max: 10 \}\)/);
});
