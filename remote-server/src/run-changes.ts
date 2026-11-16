/**
 * What a run changed (`run.changes` on the Eridani link): the files and the patch of the run's worktree against the
 * point where its branch left the base, read with `git` (no shell). Eridani's judge reads it as evidence, so that
 * a verdict rests on the work and not on the agent's account of it.
 *
 *   1. `git rev-parse HEAD` → `head`
 *   2. the base: `origin/<base>` when the clone has it, else the local `<base>`; `git merge-base HEAD <ref>` → `base_sha`
 *   3. `git diff --numstat -M <base_sha>` → `files` (the working tree against the base, so uncommitted edits count)
 *   4. `git status --porcelain` → `untracked` (new files not yet added: they are in no diff) and `uncommitted`
 *      (edits to tracked files that are not committed; untracked files alone do not set it)
 *   5. `git diff -M <base_sha>` without lock files → `patch`, secrets redacted, cut at `maxChars`
 *
 * Read-only. A missing git, a folder that is no repository, or an unknown base is a failure with the reason.
 */
import { redact } from './collector/redact';
import type { Exec } from './ci-status';

export const DEFAULT_PATCH_CHARS = 60_000;
export const MAX_PATCH_CHARS = 200_000;
export const MAX_FILES = 300;
export const MAX_UNTRACKED = 100;
const PATH_CHARS = 400;
/** Generated lock files: listed in `files`, left out of `patch` (they crowd out the real change). */
export const LOCK_FILES = ['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'uv.lock', 'poetry.lock', 'Cargo.lock', 'Gemfile.lock', 'composer.lock', 'go.sum'];

export interface ChangedFile {
  path: string;
  /** Lines added and removed; null for a binary file. */
  added: number | null;
  removed: number | null;
}
export interface RunChanges {
  head: string;
  base_ref: string;
  base_sha: string;
  /** At most MAX_FILES; `files_total` is the real count. */
  files: ChangedFile[];
  files_total: number;
  /** New files git does not track yet (paths, at most MAX_UNTRACKED): they are in neither `files` nor `patch`. */
  untracked: string[];
  untracked_total: number;
  /**
   * Tracked files have edits that are not committed. Untracked files do not count: running the code leaves some
   * behind (caches, compiled files), and they are named in `untracked` for the reader to weigh.
   */
  uncommitted: boolean;
  patch: string;
  patch_truncated: boolean;
  /** The patch's length before the cut. */
  patch_chars: number;
}

export class RunChangesError extends Error {}

const firstLine = (text: string): string => redact(text.trim().split('\n')[0] ?? '').slice(0, 200);
const git = (args: string[]): string[] => ['-c', 'core.quotepath=off', ...args];

/** `git diff --numstat` lines → files. */
export function parseNumstat(out: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  for (const line of out.split('\n')) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
    if (!m) continue;
    files.push({ path: m[3].slice(0, PATH_CHARS), added: m[1] === '-' ? null : Number(m[1]), removed: m[2] === '-' ? null : Number(m[2]) });
  }
  return files;
}

export async function runChanges(o: { cwd: string; base: string; maxChars?: number; exec: Exec }): Promise<RunChanges> {
  const run = (args: string[]) => o.exec('git', git(args), o.cwd);
  const must = async (args: string[], what: string): Promise<string> => {
    const r = await run(args);
    if (r.missing) throw new RunChangesError('git is not installed on this host (or not on the service PATH)');
    if (r.code !== 0) throw new RunChangesError(`${what}: ${firstLine(r.stderr) || `exit ${r.code}`}`);
    return r.stdout;
  };
  const head = (await must(['rev-parse', 'HEAD'], 'git rev-parse HEAD')).trim();
  let baseRef = `origin/${o.base}`;
  let found = await run(['rev-parse', '--verify', '--quiet', `${baseRef}^{commit}`]);
  if (found.code !== 0) {
    baseRef = o.base;
    found = await run(['rev-parse', '--verify', '--quiet', `${baseRef}^{commit}`]);
    if (found.code !== 0) throw new RunChangesError(`no base branch ${o.base} in this clone`);
  }
  const merge = await run(['merge-base', 'HEAD', baseRef]);
  const baseSha = (merge.code === 0 ? merge.stdout : found.stdout).trim();

  const all = parseNumstat(await must(['diff', '--numstat', '-M', baseSha], 'git diff --numstat'));
  const status = (await must(['status', '--porcelain'], 'git status')).split('\n').filter(Boolean);
  const untracked = status.filter((l) => l.startsWith('?? ')).map((l) => l.slice(3, 3 + PATH_CHARS));

  const cap = Math.min(Math.max(o.maxChars ?? DEFAULT_PATCH_CHARS, 1_000), MAX_PATCH_CHARS);
  const diff = await run(['diff', '-M', '--no-color', '--no-ext-diff', baseSha, '--', '.',
    ...LOCK_FILES.flatMap((f) => [`:(exclude,top)${f}`, `:(exclude,top,glob)**/${f}`])]);
  // A patch too large for the buffer still arrives cut short: what there is is used, and marked truncated.
  if (diff.code !== 0 && !diff.stdout) throw new RunChangesError(`git diff: ${firstLine(diff.stderr) || `exit ${diff.code}`}`);
  const full = redact(diff.stdout);
  return {
    head, base_ref: baseRef, base_sha: baseSha,
    files: all.slice(0, MAX_FILES), files_total: all.length,
    untracked: untracked.slice(0, MAX_UNTRACKED), untracked_total: untracked.length,
    uncommitted: status.some((l) => !l.startsWith('?? ')),
    patch: full.slice(0, cap), patch_truncated: full.length > cap || diff.code !== 0, patch_chars: full.length,
  };
}
