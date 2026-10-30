/**
 * Runs one configured verification (C04, C09). The runner only: when an
 * attempt runs, and under which id, is verify-attempts.ts.
 *
 *   - only a `verify.id` from the run's execution target: fixed argv, no
 *     shell, cwd inside the worktree (after resolving symlinks), the
 *     target's timeout;
 *   - a minimal environment (stage F): PATH, HOME, LANG, CI=1, TERM=dumb and
 *     the verify entry's own `env`; never the server's environment;
 *   - isolated (S-N4): what runs is the worktree's code (package.json
 *     scripts, conftest.py), which the agent edits. Where bubblewrap works it
 *     runs in a sandbox (verify-sandbox.ts): a temporary HOME, the worktree
 *     the only writable folder besides a private /tmp, no network unless the
 *     entry allows it. The entry's `isolation: "none"` (or a host without
 *     bwrap) runs it as the server user, and the result says `isolated: false`;
 *   - the workspace fingerprint is taken BEFORE the run: `<HEAD>:<sha256>` of
 *     the branch, the status, the diff against HEAD and every untracked
 *     file's content, so a result can be tied to exactly the tree it tested.
 *     When it could not cover all of that (S-S2) it says so: `complete:
 *     false` and the reasons. It is taken again AFTER the run, and compared
 *     with the fingerprint the turn left (when the caller has one): any
 *     difference is `stale_workspace` (stage D). A test that writes files git
 *     does not ignore makes every result stale; that is the honest answer;
 *   - output is bounded (the last ERIDANI_LIMITS.verifyTailChars characters of
 *     stdout and stderr, interleaved as they arrived);
 *   - on timeout or cancel the whole process tree is killed (signalTree:
 *     SIGTERM, then SIGKILL after a grace), never just the direct child.
 */
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { ERIDANI_LIMITS, type WorkspaceFacts } from '../../src/shared/eridani-link-protocol';
import type { VerifySpec } from './eridani-targets';
import { runGit, within, type GitRunner } from './worktrees';
import { descendants, isSignalablePid, signalTree } from './proc';
import { bwrapArgs, innerArgv, planIsolation, SANDBOX_HOME, startLoopback, type IsolationMode, type Loopback } from './verify-sandbox';

export interface VerifyOutcome {
  workspace_fingerprint: string;
  exit_code: number | null;
  tail: string;
  truncated: boolean;
  duration_ms: number;
  timed_out: boolean;
  canceled: boolean;
  error?: string;
  workspace?: WorkspaceFacts;
  /** The tree changed between the turn and the run, or during the run. */
  stale_workspace: boolean;
  /** S-N4: the command ran inside the sandbox. */
  isolated?: boolean;
  /** S-N4: the isolation the entry gets: `bwrap` or `none`. */
  isolation?: IsolationMode;
  /** S-N4: why the run was not isolated. */
  isolation_reason?: string;
  /** S-S2: the fingerprint covers the whole workspace; false: `workspace_reasons` says what it missed. */
  workspace_complete?: boolean;
  workspace_reasons?: string[];
}

export interface VerifyRunOptions {
  spec: VerifySpec;
  worktree: string;
  signal?: AbortSignal;
  /** The fingerprint the turn left; a different one before the run is `stale_workspace`. */
  expectFingerprint?: string | null | Promise<string | null>;
  /** Override the spec's timeout (tests). */
  timeoutMs?: number;
  killGraceMs?: number;
  tailChars?: number;
  git?: GitRunner;
  spawn?: (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
  /** The bwrap program (tests): a path forces it, null forces "not available". Default: `bwrap` on the service PATH. */
  bwrap?: string | null;
}

/** The environment a verify run gets: a few basics from `from`, then the entry's own `env`. */
export function verifyEnv(spec: VerifySpec, from: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = { PATH: from.PATH || '/usr/local/bin:/usr/bin:/bin' };
  if (from.HOME) env.HOME = from.HOME;
  env.LANG = from.LANG || 'C.UTF-8';
  return { ...env, CI: '1', TERM: 'dumb', ...spec.env };
}

const MAX_UNTRACKED_FILES = 2000;
const MAX_UNTRACKED_BYTES = 4 * 1024 * 1024;

/** `<HEAD sha or "none">:<sha256 hex of the branch and the dirty tree>`. */
export async function workspaceFingerprint(dir: string, git: GitRunner = runGit): Promise<string> {
  return (await workspaceState(dir, git)).fingerprint;
}

/** The fingerprint, what it was taken from, and whether it covers everything (S-S2). */
export interface WorkspaceState extends WorkspaceFacts {
  fingerprint: string;
  /** False when part of the workspace is not in the hash exactly: a git command failed, untracked files were capped or hashed by metadata. */
  complete: boolean;
  /** One line per gap, e.g. "git status failed", "untracked files capped at 2000 (2345 found)". */
  reasons: string[];
}

/** The fingerprint and what it was taken from. */
export async function workspaceState(dir: string, git: GitRunner = runGit): Promise<WorkspaceState> {
  const reasons: string[] = [];
  const head = await git(['rev-parse', '--verify', '--quiet', 'HEAD'], dir, { readOnly: true });
  const ref = await git(['symbolic-ref', '--quiet', '--short', 'HEAD'], dir, { readOnly: true });
  const status = await git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], dir, { readOnly: true });
  if (status.code !== 0) reasons.push('git status failed');
  const diffArgs = ['--binary', '--no-ext-diff', '--no-textconv'];
  let diffOut: string;
  if (head.code === 0) {
    // A non-zero exit includes output over runGit's buffer: the diff is cut.
    const diff = await git(['diff', 'HEAD', ...diffArgs], dir, { readOnly: true });
    if (diff.code !== 0) reasons.push('git diff failed');
    diffOut = diff.stdout;
  } else {
    // No commit yet (`diff HEAD` cannot work): what is staged, then what is not.
    const staged = await git(['diff', '--cached', ...diffArgs], dir, { readOnly: true });
    const unstaged = await git(['diff', ...diffArgs], dir, { readOnly: true });
    if (staged.code !== 0 || unstaged.code !== 0) reasons.push('git diff failed');
    diffOut = `${staged.stdout}\0${unstaged.stdout}`;
  }
  const branch = ref.code === 0 && ref.stdout.trim() ? ref.stdout.trim() : null;
  const h = crypto.createHash('sha256');
  // A branch switch at the same commit is a different workspace.
  h.update(`branch\0${branch ?? ''}\0`);
  h.update(status.stdout);
  h.update('\0diff\0');
  h.update(diffOut);
  // Untracked files' contents: a status line does not change when they do.
  const untracked = status.stdout.split('\0').filter((e) => e.startsWith('?? ')).map((e) => e.slice(3)).sort();
  if (untracked.length > MAX_UNTRACKED_FILES) reasons.push(`untracked files capped at ${MAX_UNTRACKED_FILES} (${untracked.length} found)`);
  let big = 0;
  let notFile = 0;
  let unreadable = 0;
  for (const rel of untracked.slice(0, MAX_UNTRACKED_FILES)) {
    const p = path.join(dir, rel);
    h.update(`\0${rel}\0`);
    try {
      const st = fs.lstatSync(p);
      // A symlink is exactly its target's name.
      if (st.isSymbolicLink()) h.update(`link:${fs.readlinkSync(p)}`);
      else if (st.isFile() && st.size <= MAX_UNTRACKED_BYTES) h.update(fs.readFileSync(p));
      else {
        h.update(`${st.size}:${st.mtimeMs}`);
        if (st.isFile()) big++;
        else notFile++;
      }
    } catch {
      h.update('missing');
      unreadable++;
    }
  }
  const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
  if (big) reasons.push(`${n(big, 'untracked file', 'untracked files')} over 4 MiB hashed by size and mtime`);
  if (notFile) reasons.push(`${n(notFile, 'untracked entry', 'untracked entries')} not a regular file (e.g. a nested repository) hashed by size and mtime`);
  if (unreadable) reasons.push(`${n(unreadable, 'untracked file', 'untracked files')} could not be read`);
  const tree = h.digest('hex');
  const sha = head.code === 0 ? head.stdout.trim() : null;
  return { fingerprint: `${sha ?? 'none'}:${tree}`, head: sha, branch, tree, complete: reasons.length === 0, reasons };
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
  const from = o.env ?? process.env;
  const plan = planIsolation(o.spec, from, o.bwrap);
  // `isolated` only once the command really ran in the sandbox.
  const iso = (ran: boolean) => ({
    isolated: ran && plan.isolated,
    isolation: plan.isolation,
    ...(!plan.isolated && plan.reason ? { isolation_reason: plan.reason.slice(0, ERIDANI_LIMITS.reasonChars) } : {}),
  });
  let ws: { complete: boolean; reasons: string[] } = { complete: false, reasons: ['the workspace was not read'] };
  const fail = (fingerprint: string, error: string, workspace?: WorkspaceFacts, stale = false): VerifyOutcome => ({
    workspace_fingerprint: fingerprint, exit_code: null, tail: '', truncated: false, duration_ms: 0, timed_out: false, canceled: false, error,
    ...(workspace ? { workspace } : {}), stale_workspace: stale,
    ...iso(false), workspace_complete: ws.complete, workspace_reasons: ws.reasons,
  });
  if (!fs.existsSync(o.worktree)) return fail('none:', 'the worktree is missing');
  const cwd = o.spec.cwd ? path.resolve(o.worktree, o.spec.cwd) : o.worktree;
  if (!within(o.worktree, cwd)) return fail('none:', 'cwd escapes the worktree');
  // The lexical check is not enough: a symlinked folder in the worktree could point anywhere.
  if (fs.existsSync(cwd)) {
    try {
      if (!within(fs.realpathSync(o.worktree), fs.realpathSync(cwd))) return fail('none:', 'cwd escapes the worktree');
    } catch {
      return fail('none:', 'cannot resolve cwd');
    }
  }
  const state = async (): Promise<WorkspaceState | null> => {
    try {
      return await workspaceState(o.worktree, o.git);
    } catch {
      return null;
    }
  };
  const before = await state();
  ws = before ? { complete: before.complete, reasons: before.reasons } : { complete: false, reasons: ['the workspace could not be read'] };
  const fingerprint = before?.fingerprint ?? 'none:';
  const workspace = before ? { head: before.head, branch: before.branch, tree: before.tree } : undefined;
  let expected: string | null = null;
  try {
    expected = (await o.expectFingerprint) ?? null;
  } catch {
    expected = null;
  }
  const staleBefore = !!expected && !!before && expected !== before.fingerprint;
  if (!fs.existsSync(cwd)) return fail(fingerprint, `no such folder ${o.spec.cwd}`, workspace, staleBefore);
  if (o.signal?.aborted) return { ...fail(fingerprint, 'canceled', workspace, staleBefore), canceled: true };
  // The entry demands the sandbox and there is none: refuse rather than run it unsandboxed.
  if (plan.refuse) return fail(fingerprint, plan.refuse.slice(0, ERIDANI_LIMITS.reasonChars), workspace, staleBefore);

  const env = verifyEnv(o.spec, from);
  let cmd = o.spec.argv[0];
  let args = o.spec.argv.slice(1);
  let spawnCwd = cwd;
  let loopback: Loopback | null = null;
  if (plan.isolated && plan.bwrap) {
    let realWorktree: string;
    try {
      realWorktree = fs.realpathSync(o.worktree);
      spawnCwd = fs.realpathSync(cwd);
    } catch {
      return fail(fingerprint, 'cannot resolve cwd', workspace, staleBefore);
    }
    // A temporary HOME: the server user's dotfiles, keys and tokens are not in the sandbox at all.
    if (!o.spec.env?.HOME) env.HOME = SANDBOX_HOME;
    if (o.spec.network === 'loopback') {
      try {
        loopback = await startLoopback(o.spec.ports ?? []);
      } catch (err) {
        return fail(fingerprint, `cannot open the loopback ports: ${(err as Error).message}`.slice(0, ERIDANI_LIMITS.reasonChars), workspace, staleBefore);
      }
    }
    cmd = plan.bwrap;
    args = [
      ...bwrapArgs({ spec: o.spec, worktree: realWorktree, cwd: spawnCwd, env, from, ...(loopback ? { loopbackDir: loopback.dir } : {}) }),
      '--',
      ...(loopback?.prefix ?? []),
      ...innerArgv(o.spec.argv),
    ];
  }

  const started = now();
  const timeoutMs = o.timeoutMs ?? o.spec.timeout * 1000;
  const grace = o.killGraceMs ?? 2_000;
  const finished = await new Promise<Omit<VerifyOutcome, 'stale_workspace'>>((resolve) => {
    let child: ChildProcess;
    try {
      child = (o.spawn ?? nodeSpawn)(cmd, args, {
        cwd: spawnCwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
      });
    } catch (err) {
      resolve(fail(fingerprint, (err as Error).message, workspace));
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
        ...(workspace ? { workspace } : {}),
        ...iso(!spawnError),
        workspace_complete: ws.complete,
        workspace_reasons: ws.reasons,
      });
    });
  }).finally(() => loopback?.close());
  // Did the run itself (or someone beside it) change the tree?
  const after = before ? await state() : null;
  const staleAfter = !!before && !!after && after.fingerprint !== before.fingerprint;
  return { ...finished, stale_workspace: staleBefore || staleAfter };
}
