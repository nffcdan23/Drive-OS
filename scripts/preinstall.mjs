// Runs before every install, on every platform, with no dependencies available.
//
// 1. Removes npm/yarn lockfiles so they cannot compete with pnpm-lock.yaml.
// 2. Refuses any package manager other than pnpm.
//
// Written in Node rather than shell because the previous `sh -c '...'` version
// could not run on Windows, where the default script shell is cmd.exe.
import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

for (const lockfile of ['package-lock.json', 'yarn.lock']) {
  rmSync(join(repoRoot, lockfile), { force: true });
}

const userAgent = process.env.npm_config_user_agent ?? '';
if (!userAgent.startsWith('pnpm/')) {
  console.error('Use pnpm instead');
  process.exit(1);
}
