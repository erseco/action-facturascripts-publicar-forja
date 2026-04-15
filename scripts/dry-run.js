#!/usr/bin/env node
// Local harness for manual testing against the real forja.
// Reads .env from the package root. Never commit the .env file.
//
// Usage:
//   node scripts/dry-run.js <plugin-slug> <zip-path> <version> [--send]
//
// Without --send, the script logs in, fetches the CSRF token, and builds
// the multipart request but does not post it. With --send, the build is
// actually uploaded. Use --send sparingly since every send creates a real
// build row on the forja.

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CookieJar,
  createForjaClient,
  loginToForja,
  publishBuild,
  updateBuildStatus,
  normalizeVersionForForja,
} from '../lib.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, '..', '.env');
if (existsSync(envPath)) {
  const text = await readFile(envPath, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([A-Z_]+)=(.*)$/);
    if (match && process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2];
    }
  }
}

const [, , slugArg, zipArg, versionArg, ...flags] = process.argv;
if (!slugArg || !zipArg || !versionArg) {
  console.error(
    'usage: node scripts/dry-run.js <slug> <zip-path> <version> [--send] [--status=stable|beta|0]'
  );
  process.exit(64);
}
const send = flags.includes('--send');
const statusFlag = flags
  .find((f) => f.startsWith('--status='))
  ?.split('=')[1];

const username = process.env.FS_FORJA_USER;
const password = process.env.FS_FORJA_PASSWORD;
const baseUrl = process.env.FS_FORJA_URL || 'https://facturascripts.com';
if (!username || !password) {
  console.error('Missing FS_FORJA_USER or FS_FORJA_PASSWORD in env/.env');
  process.exit(65);
}

const jar = new CookieJar();
const client = createForjaClient({ baseUrl, jar });

console.log(`→ Logging into ${baseUrl} as ${username}…`);
await loginToForja(client, { username, password });
console.log(`  Session cookies: ${jar.names().join(', ') || '(none visible)'}`);

const normalized = normalizeVersionForForja(versionArg);
if (normalized !== versionArg) {
  console.log(`  Normalized version ${versionArg} → ${normalized}`);
}

console.log(`→ ${send ? 'Publishing' : 'Dry run of'} ${zipArg} as version ${normalized} to ${slugArg}…`);
const result = await publishBuild(client, {
  slug: slugArg,
  zipPath: zipArg,
  version: normalized,
  dryRun: !send,
});
console.log(JSON.stringify(result, null, 2));

if (send && statusFlag && result.buildId) {
  console.log(`→ Updating build ${result.buildId} status to "${statusFlag}"…`);
  const updated = await updateBuildStatus(client, {
    slug: slugArg,
    buildId: result.buildId,
    status: statusFlag,
  });
  console.log(JSON.stringify(updated, null, 2));
}
