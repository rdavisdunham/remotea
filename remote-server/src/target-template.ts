/**
 * Target templates (S-Q3, Eridani task 7f5a5c5f). A target in eridani.json
 * defines, once: the repository, the harness launch, dependency preparation,
 * the verification environment, migrations and resource limits
 * (eridani-targets.ts). Two things here:
 *
 *   templateStatus  the whole template checked before hello advertises the
 *                   target. A `fail` (the repository is missing or not a git
 *                   checkout, the worktree root cannot be created, the base
 *                   is neither a local nor an origin branch nor a tag, no
 *                   harness is enabled, a prepare step's program or folder
 *                   does not resolve, less free disk than `limits.minFreeMiB`)
 *                   makes it not ready: hello sends `harnesses: []` and the
 *                   reasons (`template`), doctor reports them, and dispatch
 *                   refuses a spawn there. A `warn` (a verify entry that is
 *                   not ready, a migrations folder missing from the
 *                   checkout) is reported and does not block: Eridani
 *                   already gates verification per run on `verify_status`.
 *
 *   runPrepare      the target's `prepare` steps in a managed worktree before
 *                   the agent starts: in a new worktree, and again in a reused
 *                   one whose last preparation failed, never finished, or ran
 *                   different steps. Fixed argv, no shell, the minimal verify
 *                   environment (verifyEnv), each step under its own timeout
 *                   (the process tree is killed), stopping at the first
 *                   failure. Every step's output goes to
 *                   `<worktree git dir>/remotea-prepare.log` (outside the
 *                   working tree, removed with the worktree); the outcome
 *                   keeps the last PREPARE_TAIL_CHARS characters on failure.
 *
 * Nothing here prints argv or env into what reaches Eridani; the log file on
 * the host has the command lines.
 */
import { spawn as nodeSpawn, spawnSync, type ChildProcess, type SpawnOptions } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { ERIDANI_LIMITS, type HelloTarget, type HelloTemplate, type HelloVerifyStatus, type TemplateProblem } from '../../src/shared/eridani-link-protocol';
import type { PrepareFacts } from '../../src/shared/remote-host-protocol';
import type { ExecutionTarget, PrepareSpec } from './eridani-targets';
import { verifyStatus } from './launch-caps';
import { killTree, verifyEnv } from './verify-runner';
import { within } from './worktrees';

export const PREPARE_LOG = 'remotea-prepare.log';
export const PREPARE_STATE = 'remotea-prepare.json';
export const PREPARE_TAIL_CHARS = 2_000;
/** The log stops growing here (a verbose `npm ci` can print a lot); the tail still follows the output. */
const PREPARE_LOG_MAX_BYTES = 8 * 1024 * 1024;
const MiB = 1024 * 1024;

const clip = (s: string) => (s.length > ERIDANI_LIMITS.reasonChars ? `${s.slice(0, ERIDANI_LIMITS.reasonChars - 1)}…` : s);

/** Free space where `p` lives (its nearest existing folder); null when it cannot be read. */
export function statfs(p: string): { free: number; total: number } | null {
  try {
    const s = fs.statfsSync(p);
    return { free: s.bavail * s.bsize, total: s.blocks * s.bsize };
  } catch {
    return null;
  }
}

/** The nearest folder that exists at or above `p` (a worktree root not created yet lives on its parent's disk). */
export function existingAncestor(p: string): string {
  let cur = path.resolve(p);
  while (!fs.existsSync(cur)) {
    const up = path.dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return cur;
}

/** `git <args>` in `cwd`, read-only and bounded: the exit code (null: it did not run) and stdout. */
export type GitSync = (args: string[], cwd: string) => { code: number | null; stdout: string };

const gitSync: GitSync = (args, cwd) => {
  const r = spawnSync('git', args, {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' },
    encoding: 'utf8',
    timeout: 5_000,
    windowsHide: true,
  });
  return { code: r.error ? null : r.status, stdout: r.stdout ?? '' };
};

export interface TemplateCheckOptions {
  /** The service's environment (verifyEnv's `from`). */
  env?: NodeJS.ProcessEnv;
  /** Tests: git. */
  git?: GitSync;
  /** Tests: free space. */
  statfs?: (p: string) => { free: number } | null;
  /** The verify entries' readiness already computed (helloTargets), so it is not checked twice. */
  verifyStatus?: HelloVerifyStatus[];
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function writable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** The whole template, checked the way a spawn would use it (see the file comment). */
export function templateStatus(t: ExecutionTarget, o: TemplateCheckOptions = {}): HelloTemplate {
  const problems: TemplateProblem[] = [];
  const fail = (check: string, reason: string) => problems.push({ check, level: 'fail', reason: clip(reason) });
  const warn = (check: string, reason: string) => problems.push({ check, level: 'warn', reason: clip(reason) });

  // The repository: everything else is read from it.
  let repoOk = false;
  if (!isDir(t.repo)) fail('repo', 'the repository folder does not exist');
  else if (!fs.existsSync(path.join(t.repo, '.git'))) fail('repo', 'the repository folder is not a git checkout');
  else repoOk = true;

  // The worktree root: a writable folder, or one that can be created.
  if (fs.existsSync(t.worktreeRoot)) {
    if (!isDir(t.worktreeRoot)) fail('worktree_root', 'the worktree root exists and is not a folder');
    else if (!writable(t.worktreeRoot)) fail('worktree_root', 'the worktree root is not writable by the server user');
  } else {
    const up = existingAncestor(t.worktreeRoot);
    if (!isDir(up) || !writable(up)) fail('worktree_root', 'the worktree root does not exist and cannot be created (its parent is not writable)');
  }

  // The base: what worktrees.ts resolveBase would accept for the target's own base.
  if (repoOk) {
    const want = [`refs/heads/${t.base}`, `refs/remotes/origin/${t.base}`, `refs/tags/${t.base}`];
    const r = (o.git ?? gitSync)(['for-each-ref', '--format=%(refname)', ...want], t.repo);
    if (r.code !== 0) warn('base', 'cannot read the repository\'s refs (git failed)');
    else if (!r.stdout.split('\n').some((l) => want.includes(l.trim()))) fail('base', `the base ${t.base} is not a branch, origin branch or tag of the repository`);
  }

  // The launch: at least one harness (whether its launcher answers is `launch` in hello).
  if (!t.launch.claude && !t.launch.codex) fail('launch', 'no harness is enabled (launch names neither claude nor codex)');

  // Dependency preparation: each step's program and folder resolve, as for a verify entry.
  if (repoOk) {
    for (const p of t.prepare ?? []) {
      const st = verifyStatus(t.repo, { ...p }, { env: o.env });
      if (!st.ready) fail(`prepare.${p.id}`, `prepare step ${p.id}: ${st.reason ?? 'not ready'}`);
    }
  }

  // Verification: reported, not blocking (Eridani gates verification per run).
  const vs = o.verifyStatus ?? (repoOk ? t.verify.map((v) => verifyStatus(t.repo, v, { env: o.env })) : []);
  for (const v of vs) if (!v.ready) warn(`verify.${v.id}`, `verify ${v.id}: ${v.reason ?? 'not ready'}`);

  // Migrations: Eridani reserves numbers from this folder on the base.
  if (repoOk && t.migrations && !isDir(path.join(t.repo, t.migrations.dir))) warn('migrations', `migrations.dir ${t.migrations.dir} is not a folder in the repository checkout`);

  // Resource limits: enough disk where the worktrees live.
  const min = t.limits?.minFreeMiB;
  if (min) {
    const s = (o.statfs ?? statfs)(existingAncestor(t.worktreeRoot));
    if (!s) warn('limits.disk', 'free space where the worktrees live cannot be read');
    else if (s.free < min * MiB) fail('limits.disk', `${Math.floor(s.free / MiB)} MiB free where the worktrees live, under limits.minFreeMiB ${min}`);
  }

  const ordered = [...problems.filter((p) => p.level === 'fail'), ...problems.filter((p) => p.level === 'warn')];
  return { ready: !ordered.some((p) => p.level === 'fail'), ...(ordered.length ? { problems: ordered } : {}) };
}

/** The `fail` reasons of a template, one line. */
export function notReadyReason(t: HelloTemplate): string {
  return clip((t.problems ?? []).filter((p) => p.level === 'fail').map((p) => p.reason).join('; ') || 'not ready');
}

/**
 * Hello targets with their template (S-Q3): `template`, the prepare step ids,
 * and `harnesses` emptied for a target that is not ready.
 */
export function withTemplate(hello: HelloTarget[], targets: ExecutionTarget[], o: Omit<TemplateCheckOptions, 'verifyStatus'> = {}): HelloTarget[] {
  return hello.map((h) => {
    const t = targets.find((x) => x.id === h.id);
    if (!t) return h;
    const template = templateStatus(t, { ...o, ...(h.verify_status ? { verifyStatus: h.verify_status } : {}) });
    return {
      ...h,
      ...(template.ready ? {} : { harnesses: [] }),
      ...(t.prepare?.length ? { prepare: t.prepare.map((p) => p.id) } : {}),
      template,
    };
  });
}

// ── Dependency preparation ────────────────────────────────────────────────────

/** The worktree's own git folder (`.git` is a file `gitdir: …` in a linked worktree); null when there is none. */
export function worktreeGitDir(worktree: string): string | null {
  const dotGit = path.join(worktree, '.git');
  try {
    const st = fs.statSync(dotGit);
    if (st.isDirectory()) return dotGit;
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(dotGit, 'utf8'));
    if (!m) return null;
    const dir = path.resolve(worktree, m[1]);
    return isDir(dir) ? dir : null;
  } catch {
    return null;
  }
}

/** What identifies a template's preparation: a change to the steps makes a reused worktree prepare again. */
export function prepareHash(steps: PrepareSpec[]): string {
  return crypto.createHash('sha256').update(JSON.stringify(steps.map((s) => [s.id, s.argv, s.cwd ?? '', s.env ?? {}]))).digest('hex').slice(0, 16);
}

interface PrepareState {
  hash: string;
  ok: boolean;
  at: number;
}

function readState(file: string | null): PrepareState | null {
  if (!file) return null;
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8')) as PrepareState;
    return typeof s.hash === 'string' && typeof s.ok === 'boolean' ? s : null;
  } catch {
    return null;
  }
}

function writeState(file: string | null, s: PrepareState): void {
  if (!file) return;
  try {
    fs.writeFileSync(file, JSON.stringify(s) + '\n', { mode: 0o600 });
  } catch {
    /* the next spawn prepares again: the safe side */
  }
}

export interface PrepareRunOptions {
  /** Run even when an earlier preparation of the same steps succeeded (a new worktree). */
  force?: boolean;
  /** The service's environment (verifyEnv's `from`). */
  env?: NodeJS.ProcessEnv;
  /** Tests: a timeout per step instead of the step's own. */
  timeoutMs?: number;
  killGraceMs?: number;
  spawn?: (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess;
  now?: () => number;
}

/** Keeps the last `max` characters. */
function tailer(max: number) {
  let buf = '';
  return {
    push(s: string) {
      buf += s;
      if (buf.length > max * 2) buf = buf.slice(-max);
    },
    text: () => buf.slice(-max),
  };
}

/** Run the target's prepare steps in `worktree` (see the file comment). null: the target declares none. */
export async function runPrepare(target: ExecutionTarget, worktree: string, o: PrepareRunOptions = {}): Promise<PrepareFacts | null> {
  const steps = target.prepare ?? [];
  if (!steps.length) return null;
  const now = o.now ?? Date.now;
  const from = o.env ?? process.env;
  const gitDir = worktreeGitDir(worktree);
  const stateFile = gitDir ? path.join(gitDir, PREPARE_STATE) : null;
  const logFile = gitDir ? path.join(gitDir, PREPARE_LOG) : null;
  const hash = prepareHash(steps);
  const prev = readState(stateFile);
  if (!o.force && prev?.ok && prev.hash === hash) return { ran: false, ok: true, steps: [], ...(logFile ? { log: logFile } : {}) };
  // Not ok until every step finished: a crash or a restart in the middle prepares again next time.
  writeState(stateFile, { hash, ok: false, at: now() });

  let fd: number | null = null;
  let logged = 0;
  if (logFile) {
    try {
      fd = fs.openSync(logFile, 'w', 0o600);
    } catch {
      fd = null;
    }
  }
  const log = (s: string) => {
    if (fd === null || logged >= PREPARE_LOG_MAX_BYTES) return;
    const b = Buffer.from(s, 'utf8');
    try {
      fs.writeSync(fd, b);
      logged += b.length;
      if (logged >= PREPARE_LOG_MAX_BYTES) fs.writeSync(fd, `\n# log capped at ${PREPARE_LOG_MAX_BYTES / MiB} MiB\n`);
    } catch {
      /* the outcome still has the tail */
    }
  };
  log(`# remotea: dependency preparation for target ${target.id} in ${worktree}, ${new Date(now()).toISOString()}\n`);

  const tail = tailer(PREPARE_TAIL_CHARS);
  const done: PrepareFacts['steps'] = [];
  let reason: string | undefined;
  try {
    for (const step of steps) {
      const cwd = step.cwd ? path.resolve(worktree, step.cwd) : worktree;
      let realCwd: string;
      try {
        realCwd = fs.realpathSync(cwd);
        if (!within(fs.realpathSync(worktree), realCwd) || !isDir(realCwd)) throw new Error('outside');
      } catch {
        reason = `step ${step.id}: its cwd ${step.cwd ?? '.'} is not a folder in the worktree`;
        done.push({ id: step.id, exit_code: null, duration_ms: 0, error: 'no such folder in the worktree' });
        log(`\n# ${reason}\n`);
        break;
      }
      log(`\n$ ${step.argv.join(' ')}${step.cwd ? `    (in ${step.cwd})` : ''}\n`);
      const started = now();
      const r = await runStep(step, realCwd, verifyEnv({ ...step }, from), o, (s) => {
        tail.push(s);
        log(s);
      });
      const duration_ms = now() - started;
      done.push({ id: step.id, exit_code: r.code, duration_ms, ...(r.timedOut ? { timed_out: true } : {}), ...(r.error ? { error: clip(r.error) } : {}) });
      log(`\n# ${step.id}: ${r.timedOut ? 'timed out' : r.error ? `could not start (${r.error})` : `exit ${r.code}`} after ${Math.round(duration_ms / 1000)} s\n`);
      if (r.timedOut) reason = `step ${step.id} timed out after ${step.timeout} s`;
      else if (r.error) reason = `step ${step.id} could not start: ${r.error}`;
      else if (r.code !== 0) reason = `step ${step.id} exited ${r.code}`;
      if (reason) break;
    }
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* closed */
      }
    }
  }
  const ok = !reason;
  writeState(stateFile, { hash, ok, at: now() });
  return {
    ran: true,
    ok,
    steps: done,
    ...(reason ? { reason: clip(reason) } : {}),
    ...(logFile ? { log: logFile } : {}),
    ...(!ok && tail.text() ? { tail: tail.text() } : {}),
  };
}

function runStep(step: PrepareSpec, cwd: string, env: Record<string, string>, o: PrepareRunOptions, out: (s: string) => void): Promise<{ code: number | null; timedOut: boolean; error?: string }> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = (o.spawn ?? nodeSpawn)(step.argv[0], step.argv.slice(1), { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], shell: false, windowsHide: true });
    } catch (err) {
      resolve({ code: null, timedOut: false, error: (err as Error).message });
      return;
    }
    let timedOut = false;
    let error: string | undefined;
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', out);
    child.stderr?.on('data', out);
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid, o.killGraceMs ?? 2_000);
    }, o.timeoutMs ?? step.timeout * 1000);
    timer.unref?.();
    child.on('error', (err) => {
      error = err.message;
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: error ? null : code, timedOut, ...(error ? { error } : {}) });
    });
  });
}
