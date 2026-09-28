#!/usr/bin/env node
/**
 * Local development: `pnpm --filter @workspace/mobile start` (or `pnpm mobile`
 * from the repository root). Works the same on Windows, macOS and Linux.
 *
 * 1. Loads .env files exactly as Expo does (.env, .env.local, …) using
 *    Expo's own loader, so this check sees what the app will see.
 * 2. Stops with a clear message if a required public setting is missing or
 *    if a server secret was put in the app's settings.
 * 3. Runs `expo start`, passing any extra arguments through
 *    (e.g. `pnpm mobile --tunnel`, `--web`, `--ios`, `--android`, `--clear`).
 *
 * Only public values belong in the app's .env; see .env.example.
 */
const path = require('path');
const { spawn } = require('child_process');

const projectRoot = path.resolve(__dirname, '..');
const expoPackage = require.resolve('expo/package.json', { paths: [projectRoot] });
const { loadProjectEnv } = require(require.resolve('@expo/env', { paths: [expoPackage] }));

loadProjectEnv(projectRoot, { silent: true });

const REQUIRED = ['EXPO_PUBLIC_SUPABASE_URL', 'EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'EXPO_PUBLIC_API_URL'];

function fail(lines) {
  console.error(['', 'Cannot start the app:', ...lines.map((l) => `  ${l}`), ''].join('\n'));
  process.exit(1);
}

const missing = REQUIRED.filter((k) => !(process.env[k] || '').trim());
if (missing.length) {
  fail([
    `Missing ${missing.join(', ')}.`,
    `Copy artifacts/mobile/.env.example to artifacts/mobile/.env and fill in the staging values`,
    '(Supabase staging URL and publishable key, and the staging API URL). These are public values.',
  ]);
}

const key = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY.trim();
const looksServiceRole = (() => {
  const parts = key.split('.');
  if (parts.length !== 3) return false;
  try { return JSON.parse(Buffer.from(parts[1], 'base64url').toString()).role === 'service_role'; } catch { return false; }
})();
if (key.startsWith('sb_secret_') || looksServiceRole) {
  fail(['EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY is a server secret key. Use the publishable (sb_publishable_…) key.']);
}

for (const k of ['EXPO_PUBLIC_SUPABASE_URL', 'EXPO_PUBLIC_API_URL']) {
  try {
    const u = new URL(process.env[k]);
    if (!/^https?:$/.test(u.protocol)) throw new Error();
  } catch {
    fail([`${k} is not a valid http(s) URL: "${process.env[k]}"`]);
  }
}

const appEnv = process.env.EXPO_PUBLIC_APP_ENV || 'development';
const api = new URL(process.env.EXPO_PUBLIC_API_URL);
console.log(`App environment: ${appEnv}`);
console.log(`Supabase:        ${new URL(process.env.EXPO_PUBLIC_SUPABASE_URL).host}`);
console.log(`API:             ${api.origin}`);
if (['localhost', '127.0.0.1'].includes(api.hostname)) {
  console.log('Note: a phone cannot reach "localhost" on your computer. Use the staging API URL,');
  console.log("      or your computer's LAN address (e.g. http://192.168.1.20:3000), to test on a device.");
}
console.log('');

const cli = require.resolve('expo/bin/cli', { paths: [projectRoot] });
const child = spawn(process.execPath, [cli, 'start', ...process.argv.slice(2)], {
  cwd: projectRoot,
  stdio: 'inherit',
  env: process.env,
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', (code, signal) => process.exit(signal ? 1 : code ?? 0));
