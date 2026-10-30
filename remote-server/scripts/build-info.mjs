#!/usr/bin/env node
/**
 * Runs after tsc in `npm run build`: records which commit the build came from
 * in dist/build-info.json (read by src/build-info.ts). Never fails the build:
 * without git the sha is "unknown".
 *
 *   node scripts/build-info.mjs [<out file>]
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const out = path.resolve(process.argv[2] ?? path.join(root, 'dist', 'build-info.json'));

function git(args) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 }).trim();
  } catch {
    return null;
  }
}

const head = git(['rev-parse', 'HEAD']);
const sha = head && /^[0-9a-f]{40}$/.test(head) ? head : 'unknown';
// Tracked changes anywhere in the repository (the server also compiles ../src/shared and ships resources/cli).
const status = sha === 'unknown' ? null : git(['status', '--porcelain', '--untracked-files=no']);
const info = { name: 'remotea-server', sha, dirty: status === null ? null : status.length > 0, built_at: new Date().toISOString() };
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(info, null, 2) + '\n');
process.stdout.write(`build-info: ${sha}${info.dirty ? ' (dirty)' : ''}\n`);
