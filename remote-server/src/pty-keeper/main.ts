#!/usr/bin/env node
/**
 * The PTY keeper's entry point: `node pty-keeper/main.js --dir <config dir>
 * [--idle-ms <ms>]`. Started by the server (launch.ts), never by hand. See
 * keeper.ts and docs/remotea/upgrade.md.
 */
import fs from 'fs';
import path from 'path';
import type { IPty } from 'node-pty';
import { KeeperServer, type KeeperSpawn } from './keeper';
import { keeperPaths } from './protocol';
import { loadBuildInfo } from '../build-info';

const DEFAULT_IDLE_MS = 10 * 60_000;

function log(msg: string): void {
  process.stdout.write(`${new Date().toISOString()} pty-keeper ${process.pid}: ${msg}\n`);
}

export function keeperVersion(): string {
  let version = '0.0.0';
  for (const rel of ['../../../../package.json', '../../package.json']) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, rel), 'utf8')) as { name?: string; version?: string };
      if (pkg.name === 'remotea-server' && pkg.version) {
        version = pkg.version;
        break;
      }
    } catch {
      /* try the next layout */
    }
  }
  const sha = loadBuildInfo().sha;
  return sha === 'unknown' ? version : `${version}+${sha.slice(0, 12)}`;
}

const spawnNodePty: KeeperSpawn = (spec) => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pty = require('node-pty') as typeof import('node-pty');
  const proc: IPty = pty.spawn(spec.file, spec.args, { name: 'xterm-256color', cols: spec.cols, rows: spec.rows, cwd: spec.cwd, env: spec.env, encoding: 'utf8' });
  return proc;
};

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const dir = arg('--dir');
  if (!dir) throw new Error('usage: pty-keeper --dir <config dir> [--idle-ms <ms>]');
  const idle = Number(arg('--idle-ms'));
  const paths = keeperPaths(dir);
  let exiting = false;
  const keeper = new KeeperServer({
    sock: paths.sock,
    spawn: spawnNodePty,
    version: keeperVersion(),
    idleMs: Number.isFinite(idle) && idle > 0 ? idle : DEFAULT_IDLE_MS,
    log,
    onIdle: () => void exit(0, 'idle'),
  });
  const exit = async (code: number, why: string) => {
    if (exiting) return;
    exiting = true;
    log(`${why}: stopping`);
    await keeper.hangupAll();
    await keeper.close();
    try {
      if (fs.readFileSync(paths.pid, 'utf8').trim() === String(process.pid)) fs.rmSync(paths.pid, { force: true });
    } catch {
      /* gone */
    }
    process.exit(code);
  };
  try {
    await keeper.listen();
  } catch (err) {
    log((err as Error).message);
    process.exit(0); // another keeper owns this directory: nothing to do
  }
  fs.writeFileSync(paths.pid, `${process.pid}\n`, { mode: 0o600 });
  log(`listening on ${paths.sock} (version ${keeperVersion()})`);
  // Stopping the keeper (its unit, or a signal) is what ends the sessions for good.
  process.on('SIGTERM', () => void exit(0, 'SIGTERM'));
  process.on('SIGINT', () => void exit(0, 'SIGINT'));
  // Detached from any terminal; a stray hangup must not take every session with it.
  process.on('SIGHUP', () => log('SIGHUP ignored'));
  process.on('uncaughtException', (err) => log(`uncaught: ${err.stack ?? err.message}`));
}

if (require.main === module) {
  main().catch((err) => {
    log(`fatal: ${(err as Error).stack ?? err}`);
    process.exit(1);
  });
}
