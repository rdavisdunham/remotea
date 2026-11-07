/**
 * `pr.merge` and `pr.update_branch` (Eridani's "Merge from Eridani", jarvis docs/MERGE_FROM_ERIDANI_PLAN.md): the
 * run drawer's Merge and Update branch buttons, done with the `gh` this host is logged in to. Eridani holds no
 * GitHub credential; like `ci.status` it asks the host, in the branch's worktree (or the target's repository once
 * the worktree is gone).
 *
 * `pr.merge` {branch, head_sha}: merges only the commit Eridani saw CI pass on.
 *   1. `gh pr view <branch>`: already MERGED → executed (`already: true`, a retry is safe); CLOSED → refused
 *      `not_open`; a head other than `head_sha` → refused `head_moved`.
 *   2. `gh pr merge <number> --merge --match-head-commit <head_sha>` (never --delete-branch: the repository's own
 *      setting removes the remote branch, and the worktree is the run's to clean up).
 *   3. `gh pr view` again: MERGED → executed with the merge commit; otherwise refused with why GitHub would not
 *      (`behind` its base, `conflicts`, `head_moved`, `blocked` by a rule or a failing required check, `draft`,
 *      `permission`), `gh`'s own words in `message`.
 *
 * `pr.update_branch` {branch, head_sha}: GitHub's "Update branch" (base merged into the head, on GitHub's side):
 *   `gh api -X PUT repos/{owner}/{repo}/pulls/<n>/update-branch -f expected_head_sha=<head_sha>` (gh 2.45 has no
 *   `gh pr update-branch`). GitHub answers 202 and makes the merge commit shortly after: the host waits a few
 *   seconds for the new head and, when the worktree is clean and still on the old head, fast-forwards it so the
 *   agent's next push is not refused. Refused `head_moved`, `conflicts`, `permission`, `not_open`.
 *
 * Refusals are `rejected` with the reason as `detail` and `{reason, message, pr}` as the result. Branch and sha are
 * validated before they reach an argv; nothing Eridani sends becomes an option.
 */
import { branchOk, CiStatusError, execGh, firstLine, viewPr, type CiPr, type Exec } from './ci-status';

const SHA_OK = /^[0-9a-f]{40}$/;
export const UPDATE_WAITS = 5;
export const UPDATE_WAIT_MS = 2_000;

export type PrRefusal = 'behind' | 'conflicts' | 'head_moved' | 'blocked' | 'draft' | 'not_open' | 'no_pr' | 'permission';

export interface PrOutcome {
  state: 'executed' | 'rejected';
  detail?: string;
  result: Record<string, unknown>;
}

export class PrActionError extends CiStatusError {}

export function shaOk(sha: unknown): sha is string {
  return typeof sha === 'string' && SHA_OK.test(sha);
}

const PERMISSION = /\b(403|permission|not authorized|Resource not accessible|must have (?:push|write|admin))/i;

/** Why GitHub would not merge, from the pull request as it is now and gh's words. */
export function whyNot(pr: CiPr | null, expected: string, message: string): PrRefusal {
  if (!pr) return 'no_pr';
  if (pr.state !== 'OPEN') return 'not_open';
  if (pr.head_sha && pr.head_sha !== expected) return 'head_moved';
  if (PERMISSION.test(message)) return 'permission';
  if (pr.draft || pr.merge_state === 'DRAFT') return 'draft';
  if (pr.mergeable === 'CONFLICTING' || pr.merge_state === 'DIRTY' || /conflict/i.test(message)) return 'conflicts';
  if (pr.merge_state === 'BEHIND' || /not up to date|out of date|behind/i.test(message)) return 'behind';
  if (/head (?:branch|commit|sha).*(?:modified|match|changed)|match-head-commit/i.test(message)) return 'head_moved';
  return 'blocked';
}

function refused(reason: PrRefusal, message: string, pr: CiPr | null): PrOutcome {
  return { state: 'rejected', detail: reason, result: { reason, message: message.slice(0, 300), pr } };
}

function input(branch: unknown, sha: unknown): void {
  if (!branchOk(branch)) throw new PrActionError('bad branch');
  if (!shaOk(sha)) throw new PrActionError('bad head_sha');
}

export async function prMerge(o: { cwd: string; branch: string; headSha: string; exec?: Exec; gh?: string }): Promise<PrOutcome> {
  const exec = o.exec ?? execGh;
  const gh = o.gh ?? 'gh';
  input(o.branch, o.headSha);
  const before = await viewPr(exec, gh, o.branch, o.cwd);
  if (before?.state === 'MERGED') return { state: 'executed', result: { merged: true, already: true, pr: before } };
  if (!before || before.state !== 'OPEN' || before.head_sha !== o.headSha) return refused(whyNot(before, o.headSha, ''), '', before);

  const res = await exec(gh, ['pr', 'merge', String(before.number), '--merge', '--match-head-commit', o.headSha], o.cwd);
  if (res.missing) throw new PrActionError('gh is not installed on this host (or not on the service PATH)');
  const message = firstLine(res.stderr || res.stdout);
  // Read it back either way: a merge whose answer was lost, or one GitHub refused, both show on the pull request.
  const after = await viewPr(exec, gh, String(before.number), o.cwd).catch(() => null);
  if (after?.state === 'MERGED') {
    const commit = await exec(gh, ['pr', 'view', String(before.number), '--json', 'mergeCommit', '--jq', '.mergeCommit.oid'], o.cwd);
    const sha = commit.code === 0 ? commit.stdout.trim() : '';
    return { state: 'executed', result: { merged: true, already: false, pr: after, merge_commit: shaOk(sha) ? sha : null } };
  }
  if (res.code === 0 && !after) return { state: 'executed', result: { merged: true, already: false, pr: before, merge_commit: null } };
  return refused(whyNot(after ?? before, o.headSha, message), message || `gh pr merge: exit ${res.code}`, after ?? before);
}

export async function prUpdateBranch(o: {
  cwd: string; branch: string; headSha: string; exec?: Exec; gh?: string; worktree?: string | null;
  sleep?: (ms: number) => Promise<void>;
}): Promise<PrOutcome> {
  const exec = o.exec ?? execGh;
  const gh = o.gh ?? 'gh';
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  input(o.branch, o.headSha);
  const pr = await viewPr(exec, gh, o.branch, o.cwd);
  if (!pr || pr.state !== 'OPEN' || pr.head_sha !== o.headSha) return refused(whyNot(pr, o.headSha, ''), '', pr);

  const res = await exec(gh, ['api', '-X', 'PUT', `repos/{owner}/{repo}/pulls/${pr.number}/update-branch`, '-f', `expected_head_sha=${o.headSha}`], o.cwd);
  if (res.missing) throw new PrActionError('gh is not installed on this host (or not on the service PATH)');
  if (res.code !== 0) {
    const message = firstLine(res.stderr || res.stdout);
    let reason: PrRefusal = 'blocked';
    if (PERMISSION.test(message)) reason = 'permission';
    else if (/expected head sha|head ref/i.test(message)) reason = 'head_moved';
    else if (/conflict/i.test(message)) reason = 'conflicts';
    return refused(reason, message || `update-branch: exit ${res.code}`, pr);
  }

  // GitHub makes the merge commit asynchronously: wait briefly for the new head, then bring the worktree along.
  let head: string | null = null;
  for (let i = 0; i < UPDATE_WAITS && !head; i++) {
    await sleep(UPDATE_WAIT_MS);
    const now = await viewPr(exec, gh, String(pr.number), o.cwd).catch(() => null);
    if (now && now.head_sha && now.head_sha !== o.headSha) head = now.head_sha;
  }
  const synced = head && o.worktree ? await fastForward(exec, o.worktree, o.branch, o.headSha, head) : false;
  return { state: 'executed', result: { updated: true, pr_number: pr.number, base: pr.base, new_head_sha: head, worktree_synced: synced } };
}

/** Fast-forward the run's worktree to the updated head: only when it is clean and still on the old head. */
async function fastForward(exec: Exec, cwd: string, branch: string, oldHead: string, newHead: string): Promise<boolean> {
  const head = await exec('git', ['rev-parse', 'HEAD'], cwd);
  if (head.code !== 0 || head.stdout.trim() !== oldHead) return false;
  const status = await exec('git', ['status', '--porcelain', '--untracked-files=no'], cwd);
  if (status.code !== 0 || status.stdout.trim()) return false;
  const fetch = await exec('git', ['fetch', '--quiet', 'origin', `refs/heads/${branch}`], cwd);
  if (fetch.code !== 0) return false;
  const merge = await exec('git', ['merge', '--ff-only', '--quiet', newHead], cwd);
  return merge.code === 0;
}
