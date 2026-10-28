/**
 * Runs one configured verification (C04, C09): runner only. Stage C runs it on
 * an explicit `verify` command; automatic verify after turns is stage D.
 *
 *   - only a `verify.id` from the run's execution target: fixed argv, no
 *     shell, cwd inside the worktree, the target's timeout;
 *   - the workspace fingerprint is taken BEFORE the run: `<HEAD>:<sha256>` of
 *     the status, the diff against HEAD and every untracked file's content, so
 *     a result can be tied to exactly the tree it tested;
 *   - output is bounded (the last ERIDANI_LIMITS.verifyTailChars characters of
 *     stdout and stderr, interleaved as they arrived);
 *   - on timeout or cancel the whole process tree is killed (signalTree:
 *     SIGTERM, then SIGKILL after a grace), never just the direct child.
 */
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { ERIDANI_LIMITS } from '../../src/shared/eridani-link-protocol';
import type { VerifySpec } from './eridani-targets';
import { runGit, within, type GitRunner } from './worktrees';
import { descendants, isSignalablePid, signalTree } from './proc';

export interface VerifyOutcome {
  workspace_fingerprint: string;
  exit_code: number | null;
  tail: string;
  truncated: boolean;
  duration_ms: number;
  timed_out: boolean;
  canceled: boolean;
  error?: string;
}

export interface VerifyRunOptions {
  spec: VerifySpec;
  worktree: string;
  signal?: AbortSignal;
  /** Override the spec's timeout (tests). */
  timeoutMs?: number;
  killGraceMs?: number;
  tailChars?: number;
  git?: GitRunner;
  spawn?: (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
}

const MAX_UNTRACKED_FILES = 2000;
const MAX_UNTRACKED_BYTES = 4 * 1024 * 1024;

/** `<HEAD sha or "none">:<sha256 hex of the dirty tree>`. */
export async function workspaceFingerprint(dir: string, git: GitRunner = runGit): Promise<string> {
  const head = await git(['rev-parse', '--verify', '--quiet', 'HEAD'], dir, { readOnly: true });
  const status = await git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], dir, { readOnly: true });
  const diff = await git(['diff', 'HEAD', '--binary', '--no-ext-diff', '--no-textconv'], dir, { readOnly: true });
  const h = crypto.createHash('sha256');
  h.update(status.stdout);
  h.update('\0diff\0');
  h.update(diff.stdout);
  // Untracked files' contents: a status line does not change when they do.
  const untracked = status.stdout.split('\0').filter((e) => e.startsWith('?? ')).map((e) => e.slice(3)).sort().slice(0, MAX_UNTRACKED_FILES);
  for (const rel of untracked) {
    const p = path.join(dir, rel);
    h.update(`\0${rel}\0`);
    try {
      const st = fs.lstatSync(p);
      if (st.isFile() && st.size <= MAX_UNTRACKED_BYTES) h.update(fs.readFileSync(p));
      else h.update(`${st.size}:${st.mtimeMs}`);
    } catch {
      h.update('missing');
    }
  }
  return `${head.code === 0 ? head.stdout.trim() : 'none'}:${h.digest('hex')}`;
}

/** Keep the last `max` characters of what a process printed. */
class Tail {
  private buf = '';
  cut = false;
  constructor(private readonly max: number) {}
  push(s: string): void {
    this.buf += s;
    if (this.buf.length > this.max * 2) {
      this.buf = this.buf.slice(-this.max);
      this.cut = true;
    }
  }
  text(): string {
    if (this.buf.length > this.max) {
      this.cut = true;
      return this.buf.slice(-this.max);
    }
    return this.buf;
  }
}

/** Kill a process and everything under it: SIGTERM now, SIGKILL after the grace. */
function killTree(pid: number | undefined, graceMs: number): void {
  if (!pid || !isSignalablePid(pid)) return;
  const tree = [pid, ...descendants(pid)];
  signalTree(pid, 'SIGTERM');
  const t = setTimeout(() => {
    for (const p of tree) {
      if (!isSignalablePid(p)) continue;
      try {
        process.kill(p, 'SIGKILL');
      } catch {
        /* gone */
      }
    }
  }, graceMs);
  t.unref?.();
}

export async function runVerify(o: VerifyRunOptions): Promise<VerifyOutcome> {
  const now = o.now ?? Date.now;
  const tail = new Tail(o.tailChars ?? ERIDANI_LIMITS.verifyTailChars);
  const fail = (fingerprint: string, error: string): VerifyOutcome => ({ workspace_fingerprint: fingerprint, exit_code: null, tail: '', truncated: false, duration_ms: 0, timed_out: false, canceled: false, error });
  if (!fs.existsSync(o.worktree)) return fail('none:', 'the worktree is missing');
  const cwd = o.spec.cwd ? path.resolve(o.worktree, o.spec.cwd) : o.worktree;
  if (!within(o.worktree, cwd)) return fail('none:', 'cwd escapes the worktree');
  let fingerprint: string;
  try {
    fingerprint = await workspaceFingerprint(o.worktree, o.git);
  } catch (err) {
    fingerprint = `none:${(err as Error).message.slice(0, 40)}`;
  }
  if (!fs.existsSync(cwd)) return fail(fingerprint, `no such folder ${o.spec.cwd}`);
  if (o.signal?.aborted) return { ...fail(fingerprint, 'canceled'), canceled: true };

  const started = now();
  const timeoutMs = o.timeoutMs ?? o.spec.timeout * 1000;
  const grace = o.killGraceMs ?? 2_000;
  return new Promise<VerifyOutcome>((resolve) => {
    let child: ChildProcess;
    try {
      child = (o.spawn ?? nodeSpawn)(o.spec.argv[0], o.spec.argv.slice(1), {
        cwd,
        env: { ...(o.env ?? process.env), CI: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
      });
    } catch (err) {
      resolve(fail(fingerprint, (err as Error).message));
      return;
    }
    let timedOut = false;
    let canceled = false;
    let spawnError: string | undefined;
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (d: string) => tail.push(d));
    child.stderr?.on('data', (d: string) => tail.push(d));
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid, grace);
    }, timeoutMs);
    timer.unref?.();
    const onAbort = () => {
      canceled = true;
      killTree(child.pid, grace);
    };
    o.signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (err) => {
      spawnError = err.message;
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      o.signal?.removeEventListener('abort', onAbort);
      const text = tail.text();
      resolve({
        workspace_fingerprint: fingerprint,
        exit_code: spawnError ? null : code ?? (signal ? 128 + (({ SIGTERM: 15, SIGKILL: 9, SIGINT: 2, SIGHUP: 1 } as Record<string, number>)[signal] ?? 0) : null),
        tail: text,
        truncated: tail.cut,
        duration_ms: now() - started,
        timed_out: timedOut,
        canceled,
        ...(spawnError ? { error: spawnError.slice(0, ERIDANI_LIMITS.reasonChars) } : {}),
      });
    });
  });
}
