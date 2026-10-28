/**
 * Managed git worktrees for Eridani runs (decision 9, F01).
 *
 *   - One worktree per branch, at `<worktreeRoot>/<branch with / as -->`,
 *     created from the base (`git worktree add -b <branch> <path> <base sha>`),
 *     or checked out when the branch already exists; reused by every later run
 *     on that branch, wherever git says it is checked out under the root.
 *   - The base revision is recorded (`eridani-worktrees.json` in the config dir
 *     and the run binding), so a report can say what the work diverged from.
 *   - Cleanup is NOMINATE-ONLY: `remotea eridani worktrees` lists every managed
 *     worktree with what removing it would lose (active use, divergence,
 *     unpushed commits, uncommitted, untracked and ignored files) and prints
 *     the manual commands, including a recovery ref. Nothing here deletes.
 *
 * Git runs with an argv (no shell), GIT_TERMINAL_PROMPT=0, and every branch
 * name has passed BRANCH_RE and `git check-ref-format --branch`. A branch
 * equal to the target's base is refused: agents never work on main.
 */
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { BRANCH_RE } from '../../src/shared/eridani-link-protocol';
import type { ExecutionTarget } from './eridani-targets';
import type { WorktreeReport } from '../../src/shared/eridani-link-protocol';
export type { WorktreeReport };

export const WORKTREES_FILE = 'eridani-worktrees.json';

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type GitRunner = (args: string[], cwd: string, opts?: { readOnly?: boolean; timeoutMs?: number }) => Promise<GitResult>;

export const runGit: GitRunner = (args, cwd, opts = {}) =>
  new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' };
    // A read must never take index.lock out from under the agent working there.
    if (opts.readOnly) env.GIT_OPTIONAL_LOCKS = '0';
    execFile('git', args, { cwd, env, timeout: opts.timeoutMs ?? 60_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });

export interface WorktreeEntry {
  path: string;
  head: string | null;
  branch: string | null;
  bare: boolean;
  detached: boolean;
  locked: boolean;
  prunable: boolean;
}

export function parseWorktreeList(porcelain: string): WorktreeEntry[] {
  const out: WorktreeEntry[] = [];
  let cur: WorktreeEntry | null = null;
  for (const line of porcelain.split('\n')) {
    if (line.startsWith('worktree ')) {
      cur = { path: line.slice(9), head: null, branch: null, bare: false, detached: false, locked: false, prunable: false };
      out.push(cur);
    } else if (!cur) continue;
    else if (line.startsWith('HEAD ')) cur.head = line.slice(5);
    else if (line.startsWith('branch ')) cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
    else if (line === 'bare') cur.bare = true;
    else if (line === 'detached') cur.detached = true;
    else if (line.startsWith('locked')) cur.locked = true;
    else if (line.startsWith('prunable')) cur.prunable = true;
  }
  return out;
}

/** The folder name for a branch: `user/eng-12-login` → `user--eng-12-login`. */
export function branchDir(branch: string): string {
  return branch.replace(/\//g, '--').replace(/[^A-Za-z0-9._-]/g, '-');
}

/** Is `child` inside `root` (or equal)? Both resolved; no `..` escape. */
export function within(root: string, child: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(child));
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

function realOr(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

export interface WorktreeRecord {
  target: string;
  branch: string;
  base: string;
  baseSha: string | null;
  createdAt: number;
}

export function readWorktreeRecords(dir: string | null): Record<string, WorktreeRecord> {
  if (!dir) return {};
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, WORKTREES_FILE), 'utf8')) as Record<string, WorktreeRecord>;
  } catch {
    return {};
  }
}

function writeWorktreeRecord(dir: string | null, wtPath: string, rec: WorktreeRecord): void {
  if (!dir) return;
  const all = readWorktreeRecords(dir);
  if (all[wtPath]) return; // the first creation is the base that counts
  all[wtPath] = rec;
  const file = path.join(dir, WORKTREES_FILE);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export interface EnsuredWorktree {
  path: string;
  branch: string;
  base: string;
  /** The commit the branch was created from; for a reused or pre-existing branch, the recorded one or the merge base. */
  baseSha: string | null;
  created: boolean;
}

export class WorktreeManager {
  /** Worktree operations on one repository run one at a time. */
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(private readonly opts: { dir: string | null; git?: GitRunner; now?: () => number }) {}

  private get git(): GitRunner {
    return this.opts.git ?? runGit;
  }

  private serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.locks.set(key, next.catch(() => undefined));
    return next;
  }

  async list(repo: string): Promise<WorktreeEntry[]> {
    const r = await this.git(['worktree', 'list', '--porcelain'], repo, { readOnly: true });
    if (r.code !== 0) throw new Error(`git worktree list failed in ${repo}: ${r.stderr.trim().slice(0, 200)}`);
    return parseWorktreeList(r.stdout);
  }

  private async revParse(repo: string, rev: string): Promise<string | null> {
    const r = await this.git(['rev-parse', '--verify', '--quiet', `${rev}^{commit}`], repo, { readOnly: true });
    return r.code === 0 ? r.stdout.trim() : null;
  }

  /** The worktree for `branch` on `target`: reused when it exists, created from `base` when not. */
  ensure(target: ExecutionTarget, branch: string, base = target.base): Promise<EnsuredWorktree> {
    return this.serial(target.repo, async () => {
      if (!BRANCH_RE.test(branch) || !BRANCH_RE.test(base)) throw new Error('invalid branch or base name');
      if (branch === base || branch === target.base) throw new Error(`refusing to run on the base branch ${branch}`);
      const fmt = await this.git(['check-ref-format', '--branch', branch], target.repo, { readOnly: true });
      if (fmt.code !== 0) throw new Error(`invalid branch name ${branch}`);
      const root = realOr(target.worktreeRoot);
      const records = readWorktreeRecords(this.opts.dir);

      const existing = (await this.list(target.repo)).find((w) => w.branch === branch);
      if (existing) {
        if (!within(root, realOr(existing.path))) throw new Error(`branch ${branch} is checked out at ${existing.path}, outside ${target.worktreeRoot}`);
        if (!fs.existsSync(existing.path)) throw new Error(`the worktree for ${branch} at ${existing.path} is missing (git worktree prune?)`);
        const rec = records[existing.path];
        const baseSha = rec?.baseSha ?? (await this.mergeBase(target.repo, base, branch));
        return { path: existing.path, branch, base: rec?.base ?? base, baseSha, created: false };
      }

      fs.mkdirSync(target.worktreeRoot, { recursive: true });
      const want = path.join(realOr(target.worktreeRoot), branchDir(branch));
      if (!within(root, want)) throw new Error('worktree path escapes the root');
      if (fs.existsSync(want)) throw new Error(`${want} exists and is not a worktree of ${target.repo}`);

      let baseSha: string | null;
      let args: string[];
      if (await this.revParse(target.repo, `refs/heads/${branch}`)) {
        baseSha = await this.mergeBase(target.repo, base, branch);
        args = ['worktree', 'add', want, branch];
      } else {
        baseSha = (await this.revParse(target.repo, base)) ?? (await this.revParse(target.repo, `origin/${base}`));
        if (!baseSha) throw new Error(`unknown base ${base} in ${target.repo}`);
        args = ['worktree', 'add', '-b', branch, want, baseSha];
      }
      const add = await this.git(args, target.repo, { timeoutMs: 5 * 60_000 });
      if (add.code !== 0) throw new Error(`git worktree add failed: ${add.stderr.trim().slice(0, 300)}`);
      if (!within(root, realOr(want))) throw new Error('worktree path escapes the root');
      writeWorktreeRecord(this.opts.dir, want, { target: target.id, branch, base, baseSha, createdAt: (this.opts.now ?? Date.now)() });
      return { path: want, branch, base, baseSha, created: true };
    });
  }

  private async mergeBase(repo: string, base: string, branch: string): Promise<string | null> {
    const r = await this.git(['merge-base', base, branch], repo, { readOnly: true });
    return r.code === 0 ? r.stdout.trim() || null : null;
  }

  /**
   * F01: what removing each managed worktree would lose. Never removes.
   * `active(path)` says whether a live session works there.
   */
  async nominate(targets: ExecutionTarget[], active: (p: string) => boolean): Promise<WorktreeReport[]> {
    const records = readWorktreeRecords(this.opts.dir);
    const out: WorktreeReport[] = [];
    for (const t of targets) {
      let entries: WorktreeEntry[];
      try {
        entries = await this.list(t.repo);
      } catch (err) {
        out.push({ target: t.id, path: t.repo, branch: null, base: t.base, head: null, active: false, ahead: null, behind: null, unpushed: null, upstream: null, merged: null, uncommitted: 0, untracked: 0, ignored: 0, candidate: false, reasons: [(err as Error).message] });
        continue;
      }
      const root = realOr(t.worktreeRoot);
      for (const w of entries) {
        if (w.bare || !within(root, realOr(w.path))) continue;
        out.push(await this.inspect(t, w, records[w.path], active(w.path)));
      }
    }
    return out;
  }

  private async inspect(t: ExecutionTarget, w: WorktreeEntry, rec: WorktreeRecord | undefined, active: boolean): Promise<WorktreeReport> {
    const base = rec?.base ?? t.base;
    const reasons: string[] = [];
    const row: WorktreeReport = { target: t.id, path: w.path, branch: w.branch, base, head: w.head, active, ahead: null, behind: null, unpushed: null, upstream: null, merged: null, uncommitted: 0, untracked: 0, ignored: 0, candidate: false, reasons };
    if (active) reasons.push('in use by a live session');
    if (w.locked) reasons.push('locked');
    if (!fs.existsSync(w.path)) {
      reasons.push('folder missing (git worktree prune)');
      return row;
    }
    const st = await this.git(['status', '--porcelain=v1', '--ignored', '--untracked-files=all'], w.path, { readOnly: true });
    if (st.code === 0) {
      for (const line of st.stdout.split('\n')) {
        if (!line) continue;
        if (line.startsWith('??')) row.untracked++;
        else if (line.startsWith('!!')) row.ignored++;
        else row.uncommitted++;
      }
    } else reasons.push('git status failed');
    if (row.uncommitted) reasons.push(`${row.uncommitted} uncommitted change(s)`);
    if (row.untracked) reasons.push(`${row.untracked} untracked file(s)`);
    if (row.ignored) reasons.push(`${row.ignored} ignored file(s) (e.g. .env) would be deleted`);
    if (w.branch) {
      const counts = await this.git(['rev-list', '--left-right', '--count', `${base}...${w.branch}`], t.repo, { readOnly: true });
      if (counts.code === 0) {
        const [behind, ahead] = counts.stdout.trim().split(/\s+/).map(Number);
        row.behind = behind;
        row.ahead = ahead;
      }
      const anc = await this.git(['merge-base', '--is-ancestor', w.branch, base], t.repo, { readOnly: true });
      row.merged = anc.code === 0;
      if (!row.merged) reasons.push(`not merged into ${base}${row.ahead ? ` (${row.ahead} commit(s) ahead)` : ''}`);
      const up = await this.git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', `${w.branch}@{upstream}`], t.repo, { readOnly: true });
      if (up.code === 0 && up.stdout.trim()) {
        row.upstream = up.stdout.trim();
        const un = await this.git(['rev-list', '--count', `${row.upstream}..${w.branch}`], t.repo, { readOnly: true });
        row.unpushed = un.code === 0 ? Number(un.stdout.trim()) : null;
        if (row.unpushed) reasons.push(`${row.unpushed} unpushed commit(s)`);
      } else if (!row.merged) reasons.push('no upstream: the commits exist only here');
    } else reasons.push('detached HEAD');
    row.candidate = reasons.length === 0;
    return row;
  }
}


/** The manual commands for one row: a recovery ref first, then the removal. */
export function cleanupCommands(repo: string, row: WorktreeReport): string[] {
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const cmds: string[] = [];
  if (row.head && row.branch) cmds.push(`git -C ${q(repo)} update-ref refs/remotea/recovery/${branchDir(row.branch)} ${row.head}`);
  cmds.push(`git -C ${q(repo)} worktree remove ${q(row.path)}`);
  return cmds;
}
