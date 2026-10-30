/**
 * Isolation for automatic verification (S-N4). verify-runner.ts runs the
 * worktree's code (package.json scripts, conftest.py), which the agent edits.
 * Where bubblewrap works, that code runs in a sandbox:
 *
 *   - its own user, pid, ipc, uts and network namespaces (`--unshare-all`),
 *     killed with the server (`--die-with-parent`), its own session (no
 *     TIOCSTI into a terminal);
 *   - a root filesystem that holds only: /usr, /bin, /sbin, /lib*, /etc
 *     read-only; a private /tmp (tmpfs) with HOME=/tmp/home in it; /proc and
 *     a minimal /dev; the worktree read-write; read-only: the program's PATH
 *     folders, the toolchain of the node that runs remotea, the worktree's
 *     dependency folders that live elsewhere (a symlinked node_modules or
 *     .venv, a venv's base Python), the repository's git folder (a worktree's
 *     `.git` points into it) and the entry's own `mounts`. Everything else,
 *     $HOME's dotfiles and keys first, does not exist in there. The root
 *     itself is remounted read-only, so the only writable places are the
 *     worktree and /tmp (gone when the run ends);
 *   - no network (`--unshare-net`: only a private loopback) unless the entry
 *     says `network: true` (the host's network) or `network: "loopback"` with
 *     `ports` (only the host's 127.0.0.1 on those ports, forwarded through
 *     unix sockets: see `startLoopback`);
 *   - no core dumps; the timeout and the tree kill are verify-runner's.
 *
 * The trust choice is per verify entry (`isolation: "bwrap" | "none"`). Absent,
 * it is `bwrap` where bwrap works, else `none`, and hello and every
 * verify.result say the check was not isolated, and why.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import type { HelloVerifyStatus } from '../../src/shared/eridani-link-protocol';
import type { VerifySpec } from './eridani-targets';
import { within } from './worktrees';

export type IsolationMode = 'bwrap' | 'none';

/** What a run will get, decided before it starts. */
export interface IsolationPlan {
  isolation: IsolationMode;
  /** The command runs inside the sandbox. */
  isolated: boolean;
  /** Why not isolated (never a secret, never the argv). */
  reason?: string;
  /** The entry asked for bwrap and bwrap is unusable: the run is refused. */
  refuse?: string;
  /** The bwrap program, when isolated. */
  bwrap?: string;
}

/** HOME inside the sandbox: an empty folder in the private /tmp. */
export const SANDBOX_HOME = '/tmp/home';
/** Where the loopback forwarder's sockets appear inside the sandbox. */
const LOOPBACK_DIR = '/run/remotea-loopback';
const SYSTEM_DIRS = ['/usr', '/bin', '/sbin', '/lib', '/lib32', '/lib64', '/libx32', '/etc'];
const PROBE_TTL_MS = 10 * 60_000;
/** Cache folders inside a read-only node_modules that get a private tmpfs. */
const NODE_MODULES_SCRATCH = ['.vite-temp', '.vite', '.cache'];

function executable(p: string): boolean {
  try {
    if (!fs.statSync(p).isFile()) return false;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** `bwrap` on the service PATH (`from`), as an absolute path. */
export function findBwrap(from: NodeJS.ProcessEnv = process.env): string | null {
  for (const d of (from.PATH || '/usr/local/bin:/usr/bin:/bin').split(':')) {
    if (d && path.isAbsolute(d) && executable(path.join(d, 'bwrap'))) return path.join(d, 'bwrap');
  }
  return null;
}

const probes = new Map<string, { ok: boolean; reason?: string; at: number }>();

/** Tests: forget the probes. */
export function resetBwrapProbes(): void {
  probes.clear();
}

/**
 * Does bwrap actually make a sandbox here (user namespaces can be disabled)?
 * Probed once per binary, again after 10 minutes.
 */
export function probeBwrap(bin: string): { ok: boolean; reason?: string } {
  const hit = probes.get(bin);
  if (hit && Date.now() - hit.at < PROBE_TTL_MS) return hit;
  const r = spawnSync(bin, ['--unshare-all', '--die-with-parent', '--ro-bind', '/', '/', '--proc', '/proc', '--dev', '/dev', '--', 'true'], {
    env: { PATH: '/usr/bin:/bin' },
    stdio: ['ignore', 'ignore', 'pipe'],
    timeout: 10_000,
    encoding: 'utf8',
  });
  const ok = r.status === 0;
  const why = (r.error?.message ?? String(r.stderr ?? '').trim().split('\n')[0] ?? '').slice(0, 160);
  const out = { ok, ...(ok ? {} : { reason: `bwrap does not work on this host${why ? ` (${why})` : ''}` }), at: Date.now() };
  probes.set(bin, out);
  return out;
}

/**
 * The isolation a verify entry gets. `bwrap` (option): a path forces that
 * program, null forces "not available" (tests).
 */
export function planIsolation(spec: VerifySpec, from: NodeJS.ProcessEnv = process.env, bwrap?: string | null): IsolationPlan {
  if (spec.isolation === 'none') return { isolation: 'none', isolated: false, reason: 'the entry sets isolation "none"' };
  const bin = bwrap === undefined ? findBwrap(from) : bwrap;
  const probe = bin ? probeBwrap(bin) : { ok: false, reason: 'bwrap (bubblewrap) is not installed on the service PATH' };
  if (bin && probe.ok) return { isolation: 'bwrap', isolated: true, bwrap: bin };
  const reason = probe.reason ?? 'bwrap is not available';
  if (spec.isolation === 'bwrap') return { isolation: 'bwrap', isolated: false, reason, refuse: `isolation "bwrap" is required but ${reason}` };
  return { isolation: 'none', isolated: false, reason };
}

/**
 * hello's `verify_status` with each entry's isolation added (S-N4). An entry
 * that demands bwrap on a host without it is not ready: it would be refused.
 */
export function withIsolation(status: HelloVerifyStatus[], specs: VerifySpec[], from: NodeJS.ProcessEnv = process.env, bwrap?: string | null): HelloVerifyStatus[] {
  return status.map((s) => {
    const spec = specs.find((v) => v.id === s.id);
    if (!spec) return s;
    const plan = planIsolation(spec, from, bwrap);
    const out: HelloVerifyStatus = { ...s, ...isolationStatus(spec, from, bwrap) };
    if (plan.refuse && s.ready) return { ...out, ready: false, reason: plan.refuse.slice(0, 300) };
    return out;
  });
}

/** For hello's verify_status: what a run of this entry would get now (additive fields). */
export function isolationStatus(spec: VerifySpec, from: NodeJS.ProcessEnv = process.env, bwrap?: string | null): { isolated: boolean; isolation: IsolationMode; isolation_reason?: string } {
  const p = planIsolation(spec, from, bwrap);
  return { isolated: p.isolated, isolation: p.isolation, ...(p.isolated || !p.reason ? {} : { isolation_reason: p.reason }) };
}

function real(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

const underSystem = (p: string): boolean => SYSTEM_DIRS.some((d) => p === d || p.startsWith(d + '/'));

/** The base Python a venv points at (`home = …/bin` in pyvenv.cfg): its prefix. */
function venvHome(venv: string): string | null {
  try {
    const m = /^\s*home\s*=\s*(.+?)\s*$/m.exec(fs.readFileSync(path.join(venv, 'pyvenv.cfg'), 'utf8'));
    if (!m || !path.isAbsolute(m[1])) return null;
    const home = real(m[1]);
    if (!home) return null;
    return path.basename(home) === 'bin' ? path.dirname(home) : home;
  } catch {
    return null;
  }
}

/** A linked worktree's `.git` file names its git dir; that dir's `commondir` names the repository's. */
function gitDirs(worktree: string): string[] {
  try {
    const dotgit = path.join(worktree, '.git');
    if (!fs.lstatSync(dotgit).isFile()) return [];
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(dotgit, 'utf8'));
    if (!m) return [];
    const gitdir = path.resolve(worktree, m[1]);
    const out = [gitdir];
    try {
      out.push(path.resolve(gitdir, fs.readFileSync(path.join(gitdir, 'commondir'), 'utf8').trim()));
    } catch {
      /* not a linked worktree */
    }
    return out;
  } catch {
    return [];
  }
}

/** The prefix of the node that runs remotea (`…/v22/bin/node` → `…/v22`): npm scripts need it. */
function nodePrefix(): string | null {
  const exe = real(process.execPath);
  if (!exe) return null;
  const bin = path.dirname(exe);
  return path.basename(bin) === 'bin' ? path.dirname(bin) : bin;
}

export interface SandboxInput {
  spec: VerifySpec;
  /** realpath of the worktree and of the run's cwd. */
  worktree: string;
  cwd: string;
  /** The run's environment (its PATH decides which folders are mounted). */
  env: Record<string, string>;
  /** The service's environment, for `~/` in `mounts`. */
  from: NodeJS.ProcessEnv;
  /** The loopback forwarder's host folder, with `network: "loopback"`. */
  loopbackDir?: string;
}

/** The read-only paths beyond the system folders, realpath'd, deduplicated, never inside the worktree. */
export function sandboxMounts(i: SandboxInput): string[] {
  const want: string[] = [];
  const add = (p: string | null | undefined) => {
    if (!p) return;
    const r = real(p);
    if (r && r !== '/') want.push(r);
  };
  add(nodePrefix());
  for (const d of (i.env.PATH ?? '').split(':')) if (d && path.isAbsolute(d)) add(d);
  for (const base of new Set([i.worktree, i.cwd])) {
    for (const name of ['node_modules', '.venv', 'venv']) {
      const p = real(path.join(base, name));
      if (!p) continue;
      add(p);
      if (name !== 'node_modules') add(venvHome(p));
    }
  }
  for (const g of gitDirs(i.worktree)) add(g);
  const home = i.from.HOME;
  for (const m of i.spec.mounts ?? []) {
    if (m.startsWith('~/')) {
      if (home && path.isAbsolute(home)) add(path.join(home, m.slice(2)));
    } else add(m);
  }
  const keep = [...new Set(want)].filter((p) => !underSystem(p) && !within(i.worktree, p));
  // A folder already inside another mounted one adds nothing.
  return keep.filter((p) => !keep.some((q) => q !== p && within(q, p))).sort();
}

/** bwrap's arguments up to (not including) `--`. */
export function bwrapArgs(i: SandboxInput): string[] {
  const a = ['--unshare-all'];
  if (i.spec.network === true) a.push('--share-net');
  a.push('--die-with-parent', '--new-session');
  for (const d of SYSTEM_DIRS) {
    try {
      const st = fs.lstatSync(d);
      if (st.isSymbolicLink()) a.push('--symlink', fs.readlinkSync(d), d);
      else if (st.isDirectory()) a.push('--ro-bind', d, d);
    } catch {
      /* not on this host */
    }
  }
  a.push('--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--dir', SANDBOX_HOME);
  const ro = sandboxMounts(i);
  const binds: Array<{ p: string; kind: '--bind' | '--ro-bind' | '--tmpfs' }> = [...ro.map((p) => ({ p, kind: '--ro-bind' as const })), { p: i.worktree, kind: '--bind' }];
  // A node_modules shared from another checkout stays read-only, but tools write caches into it
  // (vite: `.vite-temp`, `.vite`): those folders, when they exist, get a throwaway tmpfs.
  for (const p of ro) {
    if (path.basename(p) !== 'node_modules') continue;
    for (const sub of NODE_MODULES_SCRATCH) {
      try {
        if (fs.lstatSync(path.join(p, sub)).isDirectory()) binds.push({ p: path.join(p, sub), kind: '--tmpfs' });
      } catch {
        /* none */
      }
    }
  }
  // Parents before children: a read-only folder that holds the worktree must not cover its read-write bind.
  binds.sort((x, y) => x.p.split('/').length - y.p.split('/').length);
  for (const b of binds) {
    if (b.kind === '--tmpfs') a.push('--tmpfs', b.p);
    else a.push(b.kind, b.p, b.p);
  }
  if (i.loopbackDir) a.push('--ro-bind', i.loopbackDir, LOOPBACK_DIR);
  a.push('--remount-ro', '/', '--chdir', i.cwd);
  return a;
}

/** Wraps the entry's argv inside the sandbox: no core dumps, then exec. */
export function innerArgv(argv: string[]): string[] {
  return ['/bin/sh', '-c', 'ulimit -c 0 2>/dev/null; exec "$@"', 'remotea-verify', ...argv];
}

/**
 * Runs inside the sandbox with `network: "loopback"`: listens on 127.0.0.1
 * (and ::1) at each port, forwards every connection to the host through
 * `<port>.sock` beside it, then runs the command and exits with its status.
 */
const FORWARDER = `'use strict';
const net = require('net');
const { spawn } = require('child_process');
const ports = process.argv[2].split(',').map(Number);
const cmd = process.argv.slice(process.argv.indexOf('--', 3) + 1);
const pipe = (c, p) => {
  const u = net.connect(__dirname + '/' + p + '.sock');
  c.pipe(u); u.pipe(c);
  c.on('error', () => u.destroy()); u.on('error', () => c.destroy());
};
let waiting = ports.length;
for (const p of ports) {
  const s = net.createServer((c) => pipe(c, p));
  s.on('error', (e) => { console.error('remotea loopback: cannot listen on 127.0.0.1:' + p + ': ' + e.message); process.exit(125); });
  s.listen(p, '127.0.0.1', () => { if (--waiting === 0) run(); });
  const s6 = net.createServer((c) => pipe(c, p));
  s6.on('error', () => {});
  s6.listen(p, '::1');
  s.unref(); s6.unref();
}
function run() {
  const ch = spawn(cmd[0], cmd.slice(1), { stdio: 'inherit' });
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => ch.kill(sig));
  ch.on('error', (e) => { console.error(e.message); process.exit(127); });
  ch.on('exit', (code, sig) => process.exit(code != null ? code : 128 + (require('os').constants.signals[sig] || 0)));
}
`;

export interface Loopback {
  /** Host folder: the forwarder and one socket per port. */
  dir: string;
  /** The argv prefix that runs the forwarder inside the sandbox (before the command). */
  prefix: string[];
  close(): void;
}

/**
 * `network: "loopback"`: one unix socket per allowed port, each forwarding to
 * the host's 127.0.0.1 at that port. The sandbox has no other way out.
 */
export async function startLoopback(ports: number[]): Promise<Loopback> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remotea-loopback-'));
  fs.chmodSync(dir, 0o700);
  fs.writeFileSync(path.join(dir, 'forward.js'), FORWARDER, { mode: 0o600 });
  const servers: net.Server[] = [];
  const conns = new Set<net.Socket>();
  const close = () => {
    for (const c of conns) c.destroy();
    for (const s of servers) s.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  try {
    for (const p of ports) {
      const s = net.createServer((c) => {
        const u = net.connect(p, '127.0.0.1');
        conns.add(c).add(u);
        c.pipe(u);
        u.pipe(c);
        const done = () => {
          c.destroy();
          u.destroy();
          conns.delete(c);
          conns.delete(u);
        };
        c.on('error', done).on('close', done);
        u.on('error', done).on('close', done);
      });
      servers.push(s);
      await new Promise<void>((resolve, reject) => {
        s.once('error', reject);
        s.listen(path.join(dir, `${p}.sock`), () => resolve());
      });
    }
  } catch (err) {
    close();
    throw err;
  }
  return { dir, prefix: [real(process.execPath) ?? process.execPath, `${LOOPBACK_DIR}/forward.js`, ports.join(','), '--'], close };
}
