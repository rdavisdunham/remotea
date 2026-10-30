/**
 * Starting the PTY keeper (docs/remotea/upgrade.md).
 *
 * Under systemd (the server's INVOCATION_ID is set) the keeper becomes its
 * own transient user unit, outside remotea.service's cgroup, so stopping or
 * restarting the server (KillMode=control-group) does not reach it.
 * Otherwise it is a detached process in its own session. Either way a second
 * keeper for the same directory finds the socket answering and exits.
 */
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile, spawn } from 'child_process';
import { answers } from './keeper';
import { keeperPaths } from './protocol';

export type KeeperLaunch = 'systemd' | 'detached';

/** How a keeper is started from this process: REMOTEA_PTY_KEEPER_LAUNCH, else systemd when we run under it. */
export function launchMode(env: NodeJS.ProcessEnv = process.env): KeeperLaunch {
  const forced = env.REMOTEA_PTY_KEEPER_LAUNCH;
  if (forced === 'systemd' || forced === 'detached') return forced;
  return env.INVOCATION_ID ? 'systemd' : 'detached';
}

/** The transient unit's name: `remotea-pty` for the default config directory. */
export function keeperUnit(dir: string): string {
  const def = path.join(os.homedir(), '.config', 'remotea');
  if (path.resolve(dir) === def) return 'remotea-pty';
  return `remotea-pty-${crypto.createHash('sha256').update(path.resolve(dir)).digest('hex').slice(0, 8)}`;
}

/** The compiled entry point beside this file. */
export function keeperScript(): string {
  return path.join(__dirname, 'main.js');
}

export interface LaunchOptions {
  idleMs: number;
  mode?: KeeperLaunch;
  script?: string;
  node?: string;
  log?: (msg: string) => void;
  /** How long to wait for the socket to answer. */
  waitMs?: number;
}

const LOG_CAP = 5 * 1024 * 1024;

function systemdRun(args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('systemd-run', args, { timeout: 10_000, encoding: 'utf8' }, (err, _out, stderr) => {
      resolve(err ? (String(stderr || err.message).trim().split('\n')[0] || 'failed') : null);
    });
  });
}

function startDetached(dir: string, script: string, node: string, idleMs: number): void {
  const { log } = keeperPaths(dir);
  try {
    if (fs.statSync(log).size > LOG_CAP) fs.truncateSync(log, 0);
  } catch {
    /* none yet */
  }
  const fd = fs.openSync(log, 'a', 0o600);
  try {
    const child = spawn(node, [script, '--dir', dir, '--idle-ms', String(idleMs)], { detached: true, stdio: ['ignore', fd, fd], cwd: '/', env: process.env });
    child.unref();
  } finally {
    fs.closeSync(fd);
  }
}

async function waitFor(sock: string, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  for (;;) {
    if (await answers(sock, 500)) return true;
    if (Date.now() >= until) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * Make sure a keeper answers for `dir`, starting one when none does.
 * Resolves with how it was found or started; rejects when none answers in time.
 */
export async function ensureKeeper(dir: string, o: LaunchOptions): Promise<{ started: boolean; mode: KeeperLaunch | null; unit: string | null }> {
  const { sock } = keeperPaths(dir);
  if (await answers(sock)) return { started: false, mode: null, unit: null };
  const log = o.log ?? (() => {});
  const script = o.script ?? keeperScript();
  const node = o.node ?? process.execPath;
  let mode = o.mode ?? launchMode();
  let unit: string | null = null;
  if (mode === 'systemd') {
    unit = keeperUnit(dir);
    const err = await systemdRun(['--user', '--unit', unit, '--collect', '--quiet', '--description', 'remotea PTY keeper (holds the terminals across server restarts)', '--', node, script, '--dir', dir, '--idle-ms', String(o.idleMs)]);
    if (err) {
      log(`pty keeper: systemd-run failed (${err}); starting it detached, which a restart of remotea.service will end`);
      mode = 'detached';
      unit = null;
    }
  }
  if (mode === 'detached') startDetached(dir, script, node, o.idleMs);
  if (!(await waitFor(sock, o.waitMs ?? 10_000))) throw new Error(`the pty keeper did not come up on ${sock}`);
  log(`pty keeper started (${mode}${unit ? ` unit ${unit}` : ''})`);
  return { started: true, mode, unit };
}
