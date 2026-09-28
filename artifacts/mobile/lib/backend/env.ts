/**
 * Backend configuration for the app. Only public values belong here: the
 * Supabase project URL, its publishable (anon) key and the API URL. Server
 * secrets must never be bundled into the app — anything that looks like one
 * is refused at startup.
 */
export type AppEnv = 'development' | 'staging' | 'production';

export interface BackendEnv {
  appEnv: AppEnv;
  supabaseUrl: string;
  supabasePublishableKey: string;
  apiUrl: string;
}

export interface RawEnv {
  appEnv?: string;
  supabaseUrl?: string;
  supabasePublishableKey?: string;
  apiUrl?: string;
}

export class ConfigError extends Error {}

/** True for keys that must only ever live on a server. */
export function isServerSecret(key: string): boolean {
  if (key.startsWith('sb_secret_')) return true;
  const parts = key.split('.');
  if (parts.length === 3) {
    try {
      const json = decodeBase64Url(parts[1]!);
      const payload = JSON.parse(json) as { role?: string };
      return payload.role === 'service_role';
    } catch {
      return false;
    }
  }
  return false;
}

function decodeBase64Url(s: string): string {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=');
  return atob(b64); // available in Hermes and Node 18+
}

export function checkEnv(raw: RawEnv): BackendEnv {
  const appEnv = (raw.appEnv ?? 'development') as AppEnv;
  if (!['development', 'staging', 'production'].includes(appEnv)) {
    throw new ConfigError(`Unknown app environment "${raw.appEnv}"`);
  }
  const supabaseUrl = (raw.supabaseUrl ?? '').replace(/\/+$/, '');
  const supabasePublishableKey = raw.supabasePublishableKey ?? '';
  const apiUrl = (raw.apiUrl ?? '').replace(/\/+$/, '');
  const missing = [
    !supabaseUrl && 'EXPO_PUBLIC_SUPABASE_URL',
    !supabasePublishableKey && 'EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
    !apiUrl && 'EXPO_PUBLIC_API_URL',
  ].filter(Boolean);
  if (missing.length) throw new ConfigError(`Missing configuration: ${missing.join(', ')}`);
  if (isServerSecret(supabasePublishableKey)) {
    throw new ConfigError('EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY is a server secret. Use the publishable (anon) key.');
  }
  if (appEnv !== 'development' && (!supabaseUrl.startsWith('https://') || !apiUrl.startsWith('https://'))) {
    throw new ConfigError('Staging and production builds must use HTTPS URLs.');
  }
  return { appEnv, supabaseUrl, supabasePublishableKey, apiUrl };
}
