/**
 * Web Crypto for React Native (Hermes has none).
 *
 * supabase-js uses crypto.getRandomValues and crypto.subtle.digest to make
 * the PKCE verifier and challenge for Google sign-in and email links.
 * Without them it silently falls back to Math.random and the "plain"
 * challenge method. This installs both from expo-crypto; on the web the
 * browser's own implementation is left untouched.
 *
 * Must be imported before the Supabase client is created.
 */
import * as ExpoCrypto from 'expo-crypto';

type Algo = string | { name: string };

const g = globalThis as unknown as { crypto?: Record<string, unknown> };
if (!g.crypto) g.crypto = {};
const c = g.crypto as {
  getRandomValues?: unknown;
  randomUUID?: unknown;
  subtle?: { digest?: unknown };
};

if (typeof c.getRandomValues !== 'function') {
  c.getRandomValues = <T extends ArrayBufferView>(array: T) =>
    ExpoCrypto.getRandomValues(array as unknown as Uint8Array) as unknown as T;
}
if (typeof c.randomUUID !== 'function') {
  c.randomUUID = () => ExpoCrypto.randomUUID();
}
if (!c.subtle || typeof c.subtle.digest !== 'function') {
  c.subtle = {
    ...(c.subtle ?? {}),
    digest: (algorithm: Algo, data: BufferSource) => {
      const name = (typeof algorithm === 'string' ? algorithm : algorithm.name).toUpperCase();
      const map: Record<string, ExpoCrypto.CryptoDigestAlgorithm> = {
        'SHA-1': ExpoCrypto.CryptoDigestAlgorithm.SHA1,
        'SHA-256': ExpoCrypto.CryptoDigestAlgorithm.SHA256,
        'SHA-384': ExpoCrypto.CryptoDigestAlgorithm.SHA384,
        'SHA-512': ExpoCrypto.CryptoDigestAlgorithm.SHA512,
      };
      const algo = map[name];
      if (!algo) return Promise.reject(new Error(`Unsupported digest ${name}`));
      return ExpoCrypto.digest(algo, data);
    },
  };
}
