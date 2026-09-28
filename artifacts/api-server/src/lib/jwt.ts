import { createHmac, createPublicKey, timingSafeEqual, verify as verifySignature, type KeyObject } from "node:crypto";
import { config } from "../config";
import { logger } from "./logger";

/**
 * Verifies Supabase Auth access tokens without third-party libraries.
 *
 *  - ES256 / RS256: tokens signed with the project's asymmetric signing keys
 *    are checked against the public keys at
 *    {SUPABASE_URL}/auth/v1/.well-known/jwks.json (cached; refreshed when an
 *    unknown key id appears, at most once a minute).
 *  - HS256: only accepted when SUPABASE_JWT_SECRET is configured (legacy
 *    projects and the local test suite).
 *
 * Claims checked: issuer, audience "authenticated", role "authenticated",
 * expiry / not-before (30 s leeway), a UUID subject, and not anonymous.
 */
export interface VerifiedToken {
  sub: string;
  email: string | null;
  claims: Record<string, unknown>;
}

export class TokenError extends Error {}

const ISSUER = `${config.supabaseUrl}/auth/v1`;
const JWKS_URL = `${config.supabaseUrl}/auth/v1/.well-known/jwks.json`;
const LEEWAY_S = 30;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let keys = new Map<string, { key: KeyObject; alg: string }>();
let lastFetch = 0;
let inflight: Promise<void> | null = null;

async function refreshKeys(force: boolean): Promise<void> {
  if (!force && Date.now() - lastFetch < 10 * 60_000 && keys.size) return;
  if (Date.now() - lastFetch < 60_000 && keys.size) return; // rate-limit refreshes
  inflight ??= (async () => {
    try {
      const res = await fetch(JWKS_URL, { signal: AbortSignal.timeout(5_000) });
      if (!res.ok) throw new Error(`JWKS HTTP ${res.status}`);
      const body = (await res.json()) as { keys?: Array<Record<string, unknown>> };
      const next = new Map<string, { key: KeyObject; alg: string }>();
      for (const jwk of body.keys ?? []) {
        if (typeof jwk.kid !== "string") continue;
        try {
          const alg = typeof jwk.alg === "string" ? jwk.alg : jwk.kty === "EC" ? "ES256" : "RS256";
          next.set(jwk.kid, { key: createPublicKey({ key: jwk as never, format: "jwk" }), alg });
        } catch (err) {
          logger.warn({ kid: jwk.kid, err }, "Skipping unusable signing key");
        }
      }
      keys = next;
      lastFetch = Date.now();
    } finally {
      inflight = null;
    }
  })();
  await inflight;
}

const b64url = (s: string) => Buffer.from(s, "base64url");

export async function verifyAccessToken(token: string): Promise<VerifiedToken> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new TokenError("malformed token");
  const [h, p, s] = parts as [string, string, string];

  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  try {
    header = JSON.parse(b64url(h).toString("utf8"));
    payload = JSON.parse(b64url(p).toString("utf8"));
  } catch {
    throw new TokenError("malformed token");
  }

  const signed = Buffer.from(`${h}.${p}`);
  const signature = b64url(s);
  const alg = header.alg;

  if (alg === "HS256") {
    if (!config.jwtSecret) throw new TokenError("HS256 tokens are not accepted");
    const expected = createHmac("sha256", config.jwtSecret).update(signed).digest();
    if (expected.length !== signature.length || !timingSafeEqual(expected, signature)) {
      throw new TokenError("bad signature");
    }
  } else if (alg === "ES256" || alg === "RS256") {
    const kid = typeof header.kid === "string" ? header.kid : "";
    await refreshKeys(false);
    if (!keys.has(kid)) await refreshKeys(true);
    const entry = keys.get(kid);
    if (!entry || entry.alg !== alg) throw new TokenError("unknown signing key");
    const ok =
      alg === "ES256"
        ? verifySignature("sha256", signed, { key: entry.key, dsaEncoding: "ieee-p1363" }, signature)
        : verifySignature("sha256", signed, entry.key, signature);
    if (!ok) throw new TokenError("bad signature");
  } else {
    throw new TokenError("unsupported algorithm");
  }

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || payload.exp + LEEWAY_S < now) throw new TokenError("expired");
  if (typeof payload.nbf === "number" && payload.nbf - LEEWAY_S > now) throw new TokenError("not yet valid");
  if (payload.iss !== ISSUER) throw new TokenError("wrong issuer");
  const aud = payload.aud;
  if (!(aud === "authenticated" || (Array.isArray(aud) && aud.includes("authenticated")))) throw new TokenError("wrong audience");
  if (payload.role !== "authenticated") throw new TokenError("wrong role");
  if (payload.is_anonymous === true) throw new TokenError("anonymous sessions are not accepted");
  if (typeof payload.sub !== "string" || !UUID.test(payload.sub)) throw new TokenError("bad subject");

  return {
    sub: payload.sub.toLowerCase(),
    email: typeof payload.email === "string" ? payload.email : null,
    claims: payload,
  };
}
