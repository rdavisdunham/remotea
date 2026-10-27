/**
 * How a session's process is started.
 *
 * Every session runs the user's login shell. With a command (`remote:host claude`)
 * it runs `$SHELL -l -i -c <cmd>`: interactive as well as login, because
 * Ubuntu's ~/.bashrc returns early for non-interactive shells and that is
 * where nvm (and therefore `claude`, `codex`) gets onto PATH.
 *
 * The server itself runs under systemd with a minimal environment; the login
 * shell rebuilds the user's real one. Variables that would make a child
 * report to the wrong multiplexer (herdr's, or a wmux pane's when the server
 * was started from one) are stripped.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import type { IPty } from 'node-pty';

export interface PtyLike {
  readonly pid: number;
  onData(cb: (data: string) => void): { dispose(): void };
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): { dispose(): void };
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  pause(): void;
  resume(): void;
}

export interface SpawnRequest {
  sessionId: string;
  cmd?: string;
  cwd?: string;
  env?: Record<string, string>;
  cols: number;
  rows: number;
}

export type SpawnFn = (req: SpawnRequest) => PtyLike;

const STRIPPED_ENV_PREFIXES = ['HERDR_', 'WMUX_', 'REMOTEA_'];
const STRIPPED_ENV = new Set(['INVOCATION_ID', 'JOURNAL_STREAM', 'SYSTEMD_EXEC_PID', 'NOTIFY_SOCKET', 'TMUX', 'TMUX_PANE']);

let cachedShell: string | null = null;

/** The user's login shell from the passwd database, falling back to $SHELL, then bash. */
export function loginShell(): string {
  if (cachedShell) return cachedShell;
  let shell = '';
  try {
    const entry = execFileSync('getent', ['passwd', os.userInfo().username], { encoding: 'utf8' }).trim();
    shell = entry.split(':')[6] ?? '';
  } catch {
    /* no getent */
  }
  if (!shell || !fs.existsSync(shell)) shell = process.env.SHELL || '/bin/bash';
  cachedShell = shell;
  return shell;
}

/**
 * Resolve the directory a session starts in. Windows paths from a remotea
 * app (`C:\Users\x\proj`) map to their /mnt/<drive> mount when it exists;
 * `~` expands; anything missing falls back to $HOME.
 */
export function resolveSessionCwd(cwd: string | undefined, home = os.homedir()): string {
  if (!cwd) return home;
  let p = cwd.trim();
  const win = /^([A-Za-z]):[\\/](.*)$/.exec(p);
  if (win) p = `/mnt/${win[1].toLowerCase()}/${win[2].replace(/\\/g, '/')}`;
  else if (p === '~') p = home;
  else if (p.startsWith('~/')) p = path.join(home, p.slice(2));
  if (!path.isAbsolute(p)) return home;
  try {
    if (fs.statSync(p).isDirectory()) return p;
  } catch {
    /* missing */
  }
  return home;
}

export function buildEnv(sessionId: string, extra: Record<string, string> | undefined, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined || STRIPPED_ENV.has(k)) continue;
    if (STRIPPED_ENV_PREFIXES.some((p) => k.startsWith(p))) continue;
    env[k] = v;
  }
  for (const [k, v] of Object.entries(extra ?? {})) env[k] = v;
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  env.TERM_PROGRAM = 'remotea';
  if (!env.LANG) env.LANG = 'C.UTF-8';
  env.REMOTEA_SESSION = sessionId;
  return env;
}

export function shellArgs(cmd: string | undefined): string[] {
  return cmd ? ['-l', '-i', '-c', cmd] : ['-l'];
}

export const spawnPty: SpawnFn = (req) => {
  // Loaded lazily so unit tests that inject a fake spawn never need the native module.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pty = require('node-pty') as typeof import('node-pty');
  const proc: IPty = pty.spawn(loginShell(), shellArgs(req.cmd), {
    name: 'xterm-256color',
    cols: req.cols,
    rows: req.rows,
    cwd: resolveSessionCwd(req.cwd),
    env: buildEnv(req.sessionId, req.env),
    encoding: 'utf8',
  });
  return proc;
};
