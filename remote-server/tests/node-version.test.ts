/**
 * One minimum Node for the server, stated everywhere and enforced by install.sh:
 * package.json "engines", scripts/check-node.sh, .nvmrc, CI, the collector's
 * SQLITE_MIN_NODE and the README must agree, and install.sh must refuse an older
 * Node with a clear message before it builds anything.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { afterAll, describe, expect, it } from 'vitest';
import { SQLITE_MIN_NODE } from '../src/collector/codex-sqlite';

const SERVER = path.join(__dirname, '..');
const ROOT = path.join(SERVER, '..');
const CHECK = path.join(SERVER, 'scripts', 'check-node.sh');
const INSTALL = path.join(SERVER, 'scripts', 'install.sh');
const read = (p: string) => fs.readFileSync(p, 'utf8');
const made: string[] = [];
afterAll(() => {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true });
});

/**
 * A directory holding a fake `node` that reports `version` and, for `-e`, exits
 * with `sqliteExit` (the node:sqlite probe). Nothing else is on its PATH but the
 * few tools install.sh needs before its Node check, so even a broken check could
 * not get as far as building or touching a service.
 */
function fakeBin(version: string, sqliteExit = 0): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remotea-fake-node-'));
  made.push(dir);
  fs.writeFileSync(path.join(dir, 'node'), [
    '#!/bin/bash',
    'case "$1" in',
    `  --version) echo "v${version}" ;;`,
    `  -p) echo "${version}" ;;`,
    `  -e) exit ${sqliteExit} ;;`,
    '  *) exit 9 ;;',
    'esac',
    '',
  ].join('\n'), { mode: 0o755 });
  for (const tool of ['bash', 'dirname']) {
    const real = spawnSync('/bin/bash', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
    fs.symlinkSync(real, path.join(dir, tool));
  }
  return dir;
}

function check(nodeBin: string) {
  return spawnSync('/bin/bash', [CHECK, nodeBin], { encoding: 'utf8' });
}

describe('scripts/check-node.sh', () => {
  it.each(['20.18.1', '20.19.0', '22.5.0', '22.12.0', '21.7.3'])('refuses Node %s with what to do', (v) => {
    const r = check(path.join(fakeBin(v), 'node'));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`remotea-server needs Node >= ${SQLITE_MIN_NODE}`);
    expect(r.stderr).toContain(`is v${v}.`);
    expect(r.stderr).toContain("nvm install 22");
    expect(r.stderr).toContain('run install.sh again');
  });

  it.each(['22.13.0', '22.23.2', '24.1.0'])('accepts Node %s', (v) => {
    const r = check(path.join(fakeBin(v), 'node'));
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });

  it('refuses a new enough Node that cannot load node:sqlite', () => {
    const r = check(path.join(fakeBin('22.23.2', 1), 'node'));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('needs node:sqlite');
    expect(r.stderr).toContain('nvm install 22');
  });

  it('refuses when there is no node at all', () => {
    const r = spawnSync('/bin/bash', [CHECK, '/nonexistent/node'], { encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`needs Node >= ${SQLITE_MIN_NODE}`);
  });

  it('accepts the Node running these tests (CI runs them on .nvmrc)', () => {
    const r = check(process.execPath);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });
});

describe('install.sh', () => {
  it('stops on Node 20 before building, with the reason and the fix', () => {
    const bin = fakeBin('20.18.1');
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'remotea-install-home-'));
    made.push(home);
    const r = spawnSync('/bin/bash', [INSTALL, '--no-hooks'], {
      encoding: 'utf8',
      env: { PATH: bin, HOME: home, REMOTEA_CONFIG_DIR: path.join(home, 'cfg') },
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`remotea-server needs Node >= ${SQLITE_MIN_NODE}`);
    expect(r.stderr).toContain('Stopped before building');
    expect(r.stdout).not.toContain('Building remotea-server');
    expect(fs.readdirSync(home)).toEqual([]);
  });

  it('runs the preflight before anything else needs node', () => {
    const src = read(INSTALL);
    const preflight = src.indexOf('scripts/check-node.sh');
    expect(preflight).toBeGreaterThan(0);
    for (const later of ['npm ci', 'npm run build', 'systemctl --user']) expect(src.indexOf(later)).toBeGreaterThan(preflight);
  });
});

describe('the minimum Node is stated the same way everywhere', () => {
  const engines = JSON.parse(read(path.join(SERVER, 'package.json'))).engines.node as string;
  const minimum = engines.replace(/^>=/, '');
  const major = minimum.split('.')[0];

  it('package.json engines is a plain floor equal to the collector constant', () => {
    expect(engines).toMatch(/^>=\d+\.\d+\.\d+$/);
    expect(minimum).toBe(SQLITE_MIN_NODE);
    const lock = JSON.parse(read(path.join(SERVER, 'package-lock.json')));
    expect(lock.packages[''].engines.node).toBe(engines);
  });

  it('check-node.sh enforces the same floor', () => {
    expect(read(CHECK)).toMatch(new RegExp(`^MIN_NODE=${minimum.replace(/\./g, '\\.')}$`, 'm'));
  });

  it('.nvmrc names that major, and CI runs the server from .nvmrc', () => {
    expect(read(path.join(SERVER, '.nvmrc')).trim()).toBe(major);
    const ci = read(path.join(ROOT, '.github', 'workflows', 'ci.yml'));
    const server = ci.slice(ci.indexOf('  server:'), ci.indexOf('  app:'));
    expect(server).toContain('node-version-file: remote-server/.nvmrc');
    expect(server).not.toMatch(/node-version:\s/);
  });

  it('the README states it', () => {
    const [mj, mn] = minimum.split('.');
    expect(read(path.join(ROOT, 'README.md'))).toContain(`**Node ≥ ${mj}.${mn}**`);
  });
});
