/**
 * Is this build behind origin/main? (`build.main` in `remotea doctor`, one
 * line in `remotea status`, `server.mainRef` in `status --json`.)
 *
 * Merged work has sat undeployed because nothing compared the running build
 * with the remote: doctor and status only compare it with the build on disk.
 *
 * The only place that runs git for this check, and it only reads:
 *
 *   git ls-remote origin refs/heads/main        what origin says main is now
 *   git rev-list --left-right --count A...B     how far apart, when both are here
 *   git cat-file -e <sha>^{commit}              is the build's commit here at all
 *
 * Never fetch, pull or anything else that writes refs, objects or the working
 * tree. So when origin's commit is not in the local object store the answer
 * is "behind, by an unknown number": counting would need a fetch.
 *
 * The comparison is against the sha ls-remote answered, not the local
 * refs/remotes/origin/main, which is only as fresh as the last fetch.
 *
 * No message built here carries git's stderr or the remote URL (a URL can
 * hold a credential).
 */
import fs from 'fs';
import path from 'path';
import { defaultBuildInfoFile } from './build-info';
import { runGit, type GitRunner } from './worktrees';

export type MainRefState = 'level' | 'ahead' | 'behind' | 'unknown';

export interface MainRefStatus {
  state: MainRefState;
  /** The build compared (40 hex), null when the build has no commit. */
  sha: string | null;
  /** origin's refs/heads/main as ls-remote answered, null when it could not be asked. */
  remoteSha: string | null;
  /** Commits on origin/main the build lacks. null: not countable (origin's commit is not in the local object store). */
  behind: number | null;
  /** Commits in the build that origin/main lacks. */
  ahead: number | null;
  /** state 'unknown': why, one short clause. Otherwise null. */
  reason: string | null;
}

export const MAIN_REF = 'refs/heads/main';
export const LS_REMOTE_TIMEOUT_MS = 2500;
export const LOCAL_GIT_TIMEOUT_MS = 2000;
export const MAIN_REF_FIX = 'git pull, then cd remote-server && npm run build && remotea upgrade';

const SHA_RE = /^[0-9a-f]{40}$/;

const unknown = (sha: string | null, remoteSha: string | null, reason: string): MainRefStatus => ({ state: 'unknown', sha, remoteSha, behind: null, ahead: null, reason });

/** Compare a build's commit with origin's main. Never throws; never writes to the checkout. */
export async function checkMainRef(o: { sha: string; cwd: string | null; git?: GitRunner }): Promise<MainRefStatus> {
  if (!SHA_RE.test(o.sha)) return unknown(null, null, 'the build has no git commit');
  const sha = o.sha;
  if (o.cwd === null) return unknown(sha, null, 'not running from a built checkout');
  const cwd = o.cwd;
  const git = o.git ?? runGit;
  try {
    const ls = await git(['ls-remote', 'origin', MAIN_REF], cwd, { readOnly: true, timeoutMs: LS_REMOTE_TIMEOUT_MS });
    const remoteSha = ls.code === 0 ? /^([0-9a-f]{40})\s+refs\/heads\/main\s*$/m.exec(ls.stdout)?.[1] ?? null : null;
    if (!remoteSha) return unknown(sha, null, 'origin could not be asked (offline, no remote "origin", or not a git checkout)');
    if (remoteSha === sha) return { state: 'level', sha, remoteSha, behind: 0, ahead: 0, reason: null };

    const count = await git(['rev-list', '--left-right', '--count', `${sha}...${remoteSha}`], cwd, { readOnly: true, timeoutMs: LOCAL_GIT_TIMEOUT_MS });
    const m = count.code === 0 ? /^(\d+)\s+(\d+)\s*$/.exec(count.stdout.trim()) : null;
    if (m) {
      const ahead = Number(m[1]);
      const behind = Number(m[2]);
      return { state: behind > 0 ? 'behind' : 'ahead', sha, remoteSha, behind, ahead, reason: null };
    }

    // Not countable. When the build's commit is here, the one missing is origin's: commits this checkout never fetched.
    const have = await git(['cat-file', '-e', `${sha}^{commit}`], cwd, { readOnly: true, timeoutMs: LOCAL_GIT_TIMEOUT_MS });
    if (have.code === 0) return { state: 'behind', sha, remoteSha, behind: null, ahead: null, reason: null };
    return unknown(sha, remoteSha, "the build's commit is not in this checkout");
  } catch {
    return unknown(sha, null, 'origin could not be asked (offline, no remote "origin", or not a git checkout)');
  }
}

/**
 * The checkout this build came from: the folder that holds `dist/`, when
 * dist/build-info.json exists. null when run from sources (vitest), so
 * nothing there ever spawns git or reaches the network for this check.
 */
export function defaultCheckoutDir(): string | null {
  const file = defaultBuildInfoFile();
  return fs.existsSync(file) ? path.dirname(path.dirname(file)) : null;
}

const commits = (n: number) => `${n} commit${n === 1 ? '' : 's'}`;

/** The one sentence doctor and status both print. `subject`: `running <sha12>` or `the build on disk <sha12>`. */
export function describeMainRef(m: MainRefStatus, subject: string): { level: 'ok' | 'warn'; summary: string; fix?: string } {
  const s12 = (m.remoteSha ?? '').slice(0, 12);
  switch (m.state) {
    case 'behind':
      if (m.behind === null) return { level: 'warn', summary: `${subject} is behind origin/main (${s12}); how many commits is unknown until that commit is fetched`, fix: MAIN_REF_FIX };
      return { level: 'warn', summary: `${subject} is ${commits(m.behind)} behind origin/main (${s12})${m.ahead ? `, and ${m.ahead} ahead of it` : ''}`, fix: MAIN_REF_FIX };
    case 'level':
      return { level: 'ok', summary: `${subject} is level with origin/main` };
    case 'ahead':
      return { level: 'ok', summary: `${subject} is ${commits(m.ahead ?? 0)} ahead of origin/main` };
    default:
      return { level: 'ok', summary: `not compared with origin/main: ${m.reason ?? 'unknown'}` };
  }
}

/** The subject for describeMainRef: the running build when there is one, else the build on disk. */
export function mainRefSubject(running: { sha: string } | null | undefined, m: MainRefStatus): string {
  const sha12 = m.sha ? m.sha.slice(0, 12) : 'unknown';
  return running ? `running ${sha12}` : `the build on disk ${sha12}`;
}
