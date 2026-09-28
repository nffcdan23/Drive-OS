/**
 * App-wide backend singletons: configuration, the Supabase auth client and
 * the API client. The values come from EXPO_PUBLIC_* variables, which are
 * public by design (they ship inside the app) — see eas.json and
 * docs in artifacts/mobile/README.md. Server secrets are refused.
 */
import '@/lib/polyfills'; // before the Supabase client is created
import { AppState } from 'react-native';
import * as Crypto from 'expo-crypto';
import { checkEnv, ConfigError, type BackendEnv } from '@/lib/backend/env';
import { accessTokenGetter, authServerProbe, createAuthClient, type SupabaseClient } from '@/lib/backend/auth';
import { ApiClient, type ConnectionState } from '@/lib/backend/http';
import { endpoints, type Endpoints } from '@/lib/backend/endpoints';
import { authStorage } from '@/lib/secureStorage';

// Each variable must be read with a literal name so Expo inlines it at build time.
function readConfig(): { env: BackendEnv | null; error: string | null } {
  try {
    return {
      env: checkEnv({
        appEnv: process.env.EXPO_PUBLIC_APP_ENV,
        supabaseUrl: process.env.EXPO_PUBLIC_SUPABASE_URL,
        supabasePublishableKey: process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
        apiUrl: process.env.EXPO_PUBLIC_API_URL,
      }),
      error: null,
    };
  } catch (err) {
    return { env: null, error: err instanceof ConfigError ? err.message : String(err) };
  }
}

const config = readConfig();
export const backendEnv = config.env;
/** Set when the build is misconfigured; the app shows it instead of starting. */
export const configError = config.error;

export const supabase: SupabaseClient | null = backendEnv
  ? createAuthClient({ url: backendEnv.supabaseUrl, publishableKey: backendEnv.supabasePublishableKey, storage: authStorage })
  : null;

// Refresh tokens only while the app is in the foreground (Supabase guidance for React Native).
if (supabase) {
  if (AppState.currentState === 'active') supabase.auth.startAutoRefresh();
  AppState.addEventListener('change', (state) => {
    if (state === 'active') supabase.auth.startAutoRefresh();
    else supabase.auth.stopAutoRefresh();
  });
}

type StatusListener = (state: ConnectionState, detail?: string) => void;
const statusListeners = new Set<StatusListener>();
export function onConnectionStatus(fn: StatusListener): () => void {
  statusListeners.add(fn);
  return () => statusListeners.delete(fn);
}

export const api: ApiClient | null = backendEnv && supabase
  ? new ApiClient({
      baseUrl: backendEnv.apiUrl,
      // Offline with an expired token: throws NetworkError (still signed in, can't refresh yet).
      getAccessToken: accessTokenGetter(supabase, authServerProbe(backendEnv.supabaseUrl, backendEnv.supabasePublishableKey)),
      refreshAccessToken: async () => (await supabase.auth.refreshSession()).data.session?.access_token ?? null,
      onStatus: (state, detail) => statusListeners.forEach((fn) => fn(state, detail)),
    })
  : null;

export const ep: Endpoints | null = api ? endpoints(api) : null;

export const newId = () => Crypto.randomUUID();
