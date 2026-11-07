/**
 * `pr.merge` and `pr.update_branch` (Eridani's Merge and Update branch): `gh` and `git` are mocked throughout (an
 * injected exec); nothing here talks to GitHub. Unit: merge only on the expected head, an already merged pull
 * request is a success, GitHub's refusals read back as reasons, update-branch's 202 then the worktree's
 * fast-forward. Shape: the commands' fence, branch, sha and target checks.
 */
import { describe, expect, it } from 'vitest';
import { commandShapeError } from '../../src/shared/eridani-link-protocol';
import type { Exec, ExecResult } from '../src/ci-status';
import { prMerge, prUpdateBranch, whyNot } from '../src/pr-actions';

const HEAD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);
const MERGE = 'c'.repeat(40);
const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: '' });
const pr = (over: Record<string, unknown> = {}) => ok(JSON.stringify({
  number: 151, url: 'https://github.com/o/r/pull/151', headRefOid: HEAD, state: 'OPEN', baseRefName: 'main', isDraft: false,
  mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', ...over,
}));

/** A fake gh/git: each key ("pr view", "pr merge", "api -X", "git rev-parse"…) answers from a queue (the last one repeats). */
function fakeExec(answers: Record<string, ExecResult[]>) {
  const calls: string[][] = [];
  const exec: Exec = async (file, args) => {
    calls.push([file, ...args]);
    const key = file === 'git' ? `git ${args[0]}` : `${args[0]} ${args[1]}`;
    const queue = answers[key];
    if (!queue?.length) return { code: 1, stdout: '', stderr: `unexpected ${key}` };
    return queue.length > 1 ? queue.shift()! : queue[0];
  };
  return { exec, calls };
}

describe('prMerge', () => {
  it('merges the expected head with a merge commit and reports it', async () => {
    const { exec, calls } = fakeExec({
      'pr view': [pr(), pr({ state: 'MERGED' }), ok(`${MERGE}\n`)],
      'pr merge': [ok('')],
    });
    const r = await prMerge({ cwd: '/w', branch: 'eri/task-1', headSha: HEAD, exec });
    expect(r).toMatchObject({ state: 'executed', result: { merged: true, already: false, merge_commit: MERGE, pr: { state: 'MERGED', base: 'main' } } });
    expect(calls).toContainEqual(['gh', 'pr', 'merge', '151', '--merge', '--match-head-commit', HEAD]);
    expect(calls.flat()).not.toContain('--delete-branch');
  });

  it('an already merged pull request is a success without merging again', async () => {
    const { exec, calls } = fakeExec({ 'pr view': [pr({ state: 'MERGED' })] });
    await expect(prMerge({ cwd: '/w', branch: 'eri/task-1', headSha: HEAD, exec })).resolves.toMatchObject({ state: 'executed', result: { merged: true, already: true } });
    expect(calls.some((c) => c[2] === 'merge')).toBe(false);
  });

  it('refuses before merging when the head moved, the pull request is closed, or there is none', async () => {
    const moved = fakeExec({ 'pr view': [pr({ headRefOid: NEW })] });
    await expect(prMerge({ cwd: '/w', branch: 'eri/x', headSha: HEAD, exec: moved.exec })).resolves.toMatchObject({ state: 'rejected', detail: 'head_moved' });
    expect(moved.calls.some((c) => c[2] === 'merge')).toBe(false);
    const closed = fakeExec({ 'pr view': [pr({ state: 'CLOSED' })] });
    await expect(prMerge({ cwd: '/w', branch: 'eri/x', headSha: HEAD, exec: closed.exec })).resolves.toMatchObject({ state: 'rejected', detail: 'not_open' });
    const none = fakeExec({ 'pr view': [{ code: 1, stdout: '', stderr: 'no pull requests found for branch "eri/x"' }] });
    await expect(prMerge({ cwd: '/w', branch: 'eri/x', headSha: HEAD, exec: none.exec })).resolves.toMatchObject({ state: 'rejected', detail: 'no_pr' });
  });

  it('reads why GitHub refused: behind its base, conflicts, a blocking rule, permission', async () => {
    const cases: Array<[Record<string, unknown>, string, string]> = [
      [{ mergeStateStatus: 'BEHIND' }, 'X Pull request o/r#151 is not mergeable: the head branch is not up to date with the base branch.', 'behind'],
      [{ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }, 'X Pull request o/r#151 is not mergeable: the merge commit cannot be cleanly created.', 'conflicts'],
      [{ mergeStateStatus: 'BLOCKED' }, 'X Pull request o/r#151 is not mergeable: the base branch policy prohibits the merge.', 'blocked'],
      [{ mergeStateStatus: 'CLEAN' }, 'GraphQL: rdavis does not have the correct permissions to execute `MergePullRequest` (403)', 'permission'],
    ];
    for (const [after, stderr, reason] of cases) {
      const { exec } = fakeExec({ 'pr view': [pr(), pr(after)], 'pr merge': [{ code: 1, stdout: '', stderr }] });
      const r = await prMerge({ cwd: '/w', branch: 'eri/x', headSha: HEAD, exec });
      expect(r).toMatchObject({ state: 'rejected', detail: reason, result: { reason, message: stderr.slice(0, 300) } });
    }
  });

  it('a merge GitHub made although gh failed (a lost answer) reads back as merged', async () => {
    const { exec } = fakeExec({ 'pr view': [pr(), pr({ state: 'MERGED' }), ok(MERGE)], 'pr merge': [{ code: 1, stdout: '', stderr: 'read: connection reset' }] });
    await expect(prMerge({ cwd: '/w', branch: 'eri/x', headSha: HEAD, exec })).resolves.toMatchObject({ state: 'executed', result: { merged: true, merge_commit: MERGE } });
  });

  it('refuses a bad branch or sha before running anything', async () => {
    const { exec, calls } = fakeExec({});
    await expect(prMerge({ cwd: '/w', branch: '--admin', headSha: HEAD, exec })).rejects.toThrow('bad branch');
    await expect(prMerge({ cwd: '/w', branch: 'eri/x', headSha: 'HEAD', exec })).rejects.toThrow('bad head_sha');
    expect(calls).toEqual([]);
  });

  it('whyNot prefers the pull request\'s own state over gh\'s words', () => {
    const base = { number: 1, url: '', head_sha: HEAD, state: 'OPEN', base: 'main', draft: false, mergeable: 'MERGEABLE', merge_state: 'CLEAN' };
    expect(whyNot({ ...base, draft: true }, HEAD, '')).toBe('draft');
    expect(whyNot({ ...base, head_sha: NEW }, HEAD, 'not up to date')).toBe('head_moved');
    expect(whyNot(base, HEAD, 'Head branch was modified. Review and try the merge again.')).toBe('head_moved');
  });
});

describe('prUpdateBranch', () => {
  const sleep = async () => {};

  it('asks GitHub to update, waits for the new head, fast-forwards the clean worktree', async () => {
    const { exec, calls } = fakeExec({
      'pr view': [pr(), pr(), pr({ headRefOid: NEW })],
      'api -X': [ok('{"message":"Updating pull request branch.","url":"https://github.com/o/r/pull/151"}')],
      'git rev-parse': [ok(`${HEAD}\n`)],
      'git status': [ok('')],
      'git fetch': [ok('')],
      'git merge': [ok('')],
    });
    const r = await prUpdateBranch({ cwd: '/w', branch: 'eri/task-1', headSha: HEAD, exec, worktree: '/w', sleep });
    expect(r).toEqual({ state: 'executed', result: { updated: true, pr_number: 151, base: 'main', new_head_sha: NEW, worktree_synced: true } });
    expect(calls).toContainEqual(['gh', 'api', '-X', 'PUT', 'repos/{owner}/{repo}/pulls/151/update-branch', '-f', `expected_head_sha=${HEAD}`]);
    expect(calls).toContainEqual(['git', 'fetch', '--quiet', 'origin', 'refs/heads/eri/task-1']);
    expect(calls).toContainEqual(['git', 'merge', '--ff-only', '--quiet', NEW]);
  });

  it('leaves a dirty worktree alone, and reports a head GitHub had not made yet as null', async () => {
    const dirty = fakeExec({
      'pr view': [pr(), pr({ headRefOid: NEW })], 'api -X': [ok('{}')],
      'git rev-parse': [ok(HEAD)], 'git status': [ok(' M src/a.ts\n')],
    });
    await expect(prUpdateBranch({ cwd: '/w', branch: 'eri/x', headSha: HEAD, exec: dirty.exec, worktree: '/w', sleep })).resolves.toMatchObject({ result: { new_head_sha: NEW, worktree_synced: false } });
    expect(dirty.calls.some((c) => c[1] === 'merge')).toBe(false);
    const slow = fakeExec({ 'pr view': [pr()], 'api -X': [ok('{}')] });
    await expect(prUpdateBranch({ cwd: '/w', branch: 'eri/x', headSha: HEAD, exec: slow.exec, worktree: '/w', sleep })).resolves.toMatchObject({ state: 'executed', result: { new_head_sha: null, worktree_synced: false } });
  });

  it('refuses a moved head, conflicts and a missing permission', async () => {
    const moved = fakeExec({ 'pr view': [pr({ headRefOid: NEW })] });
    await expect(prUpdateBranch({ cwd: '/w', branch: 'eri/x', headSha: HEAD, exec: moved.exec, sleep })).resolves.toMatchObject({ state: 'rejected', detail: 'head_moved' });
    const cases: Array<[string, string]> = [
      ['gh: expected head sha didn\'t match current head ref. (HTTP 422)', 'head_moved'],
      ['gh: merge conflict between base and head (HTTP 422)', 'conflicts'],
      ['gh: Resource not accessible by integration (HTTP 403)', 'permission'],
    ];
    for (const [stderr, reason] of cases) {
      const { exec } = fakeExec({ 'pr view': [pr()], 'api -X': [{ code: 1, stdout: '', stderr }] });
      await expect(prUpdateBranch({ cwd: '/w', branch: 'eri/x', headSha: HEAD, exec, sleep })).resolves.toMatchObject({ state: 'rejected', detail: reason });
    }
  });
});

describe('pr.merge / pr.update_branch command shape', () => {
  const cmd = (t: string, over: Record<string, unknown> = {}) => ({ t, op_id: 'op-1', run_id: 'run-1', generation: 1, branch: 'eri/task-1', head_sha: HEAD, target: 'jarvis', origin: 'human', expires_at: Date.now() + 60_000, ...over });
  it('accepts a well-formed click and refuses the rest', () => {
    for (const t of ['pr.merge', 'pr.update_branch']) {
      expect(commandShapeError(cmd(t))).toBeNull();
      expect(commandShapeError(cmd(t, { target: undefined, origin: undefined }))).toBeNull();
      expect(commandShapeError(cmd(t, { expires_at: undefined }))).toBe('expires_at required');
      expect(commandShapeError(cmd(t, { generation: 'x' }))).toBe('bad fence');
      expect(commandShapeError(cmd(t, { branch: '--admin' }))).toBe('bad branch');
      expect(commandShapeError(cmd(t, { head_sha: 'abc' }))).toBe('bad head_sha');
      expect(commandShapeError(cmd(t, { target: '../x' }))).toBe('bad target');
      expect(commandShapeError(cmd(t, { origin: 'robot' }))).toBe('bad input origin');
    }
  });
});
