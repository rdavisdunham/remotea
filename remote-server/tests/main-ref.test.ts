/**
 * main-ref.ts: is the build behind origin/main?
 *
 * Fake git for every branch of the decision, then real git against a local
 * bare repository as `origin` (a file path: no network), where the check
 * must leave the clone exactly as it found it.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { LOCAL_GIT_TIMEOUT_MS, LS_REMOTE_TIMEOUT_MS, MAIN_REF_FIX, checkMainRef, defaultCheckoutDir, describeMainRef, mainRefSubject, type MainRefStatus } from '../src/main-ref';
import type { GitResult, GitRunner } from '../src/worktrees';

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const ALLOWED = new Set(['ls-remote', 'rev-list', 'cat-file']);
const SECRET_URL = 'https://user:hunter2@example.invalid/repo.git';

type Call = { args: string[]; cwd: string; opts?: { readOnly?: boolean; timeoutMs?: number } };

/** A git that answers per sub-command and records every call. Failures carry a URL in stderr, which must never surface. */
function fakeGit(answers: Partial<Record<string, Partial<GitResult>>>): { git: GitRunner; calls: Call[] } {
  const calls: Call[] = [];
  const git: GitRunner = async (args, cwd, opts) => {
    calls.push({ args, cwd, opts });
    const a = answers[args[0]];
    return { code: a?.code ?? 1, stdout: a?.stdout ?? '', stderr: a?.stderr ?? `fatal: unable to access '${SECRET_URL}'` };
  };
  return { git, calls };
}

const ls = (sha: string): Partial<GitResult> => ({ code: 0, stdout: `${sha}\trefs/heads/main\n` });

function expectReadOnly(calls: Call[]): void {
  for (const c of calls) {
    expect(ALLOWED.has(c.args[0])).toBe(true);
    expect(c.opts?.readOnly).toBe(true);
    expect(c.opts?.timeoutMs).toBe(c.args[0] === 'ls-remote' ? LS_REMOTE_TIMEOUT_MS : LOCAL_GIT_TIMEOUT_MS);
  }
}

function expectNoLeak(m: MainRefStatus): void {
  const text = JSON.stringify(m) + JSON.stringify(describeMainRef(m, 'running x'));
  expect(text).not.toContain('hunter2');
  expect(text).not.toContain('example.invalid');
  expect(text).not.toContain('fatal');
}

describe('main-ref: checkMainRef with a fake git', () => {
  it('runs no git for a build without a commit, or without a checkout', async () => {
    const { git, calls } = fakeGit({ 'ls-remote': ls(A) });
    expect(await checkMainRef({ sha: 'unknown', cwd: '/repo', git })).toEqual({ state: 'unknown', sha: null, remoteSha: null, behind: null, ahead: null, reason: 'the build has no git commit' });
    expect(await checkMainRef({ sha: A.slice(0, 12), cwd: '/repo', git })).toMatchObject({ state: 'unknown', reason: 'the build has no git commit' });
    expect(await checkMainRef({ sha: A, cwd: null, git })).toEqual({ state: 'unknown', sha: A, remoteSha: null, behind: null, ahead: null, reason: 'not running from a built checkout' });
    expect(calls).toEqual([]);
  });

  it('is unknown when origin cannot be asked: failure, no usable line, or a throwing runner', async () => {
    const reason = 'origin could not be asked (offline, no remote "origin", or not a git checkout)';
    const failed = fakeGit({});
    const m = await checkMainRef({ sha: A, cwd: '/repo', git: failed.git });
    expect(m).toEqual({ state: 'unknown', sha: A, remoteSha: null, behind: null, ahead: null, reason });
    expect(failed.calls.map((c) => c.args)).toEqual([['ls-remote', 'origin', 'refs/heads/main']]);
    expect(failed.calls[0].cwd).toBe('/repo');
    expectReadOnly(failed.calls);
    expectNoLeak(m);

    for (const stdout of ['', 'warning: something\n', `${B.slice(0, 39)}\trefs/heads/main\n`, `${B}\trefs/heads/other\n`]) {
      const g = fakeGit({ 'ls-remote': { code: 0, stdout } });
      expect(await checkMainRef({ sha: A, cwd: '/repo', git: g.git })).toMatchObject({ state: 'unknown', reason });
      expect(g.calls).toHaveLength(1);
    }

    const thrown = await checkMainRef({ sha: A, cwd: '/repo', git: async () => { throw new Error(`spawn failed ${SECRET_URL}`); } });
    expect(thrown).toMatchObject({ state: 'unknown', reason });
    expectNoLeak(thrown);
  });

  it('level: origin answers the build\'s own commit, and nothing else is asked', async () => {
    const { git, calls } = fakeGit({ 'ls-remote': ls(A) });
    expect(await checkMainRef({ sha: A, cwd: '/repo', git })).toEqual({ state: 'level', sha: A, remoteSha: A, behind: 0, ahead: 0, reason: null });
    expect(calls).toHaveLength(1);
    expectReadOnly(calls);
  });

  it('behind, diverged and ahead come from rev-list --left-right --count (left = ahead, right = behind)', async () => {
    const behind = fakeGit({ 'ls-remote': ls(B), 'rev-list': { code: 0, stdout: '0\t3\n' } });
    expect(await checkMainRef({ sha: A, cwd: '/repo', git: behind.git })).toEqual({ state: 'behind', sha: A, remoteSha: B, behind: 3, ahead: 0, reason: null });
    expect(behind.calls.map((c) => c.args)).toEqual([['ls-remote', 'origin', 'refs/heads/main'], ['rev-list', '--left-right', '--count', `${A}...${B}`]]);
    expectReadOnly(behind.calls);

    const diverged = fakeGit({ 'ls-remote': ls(B), 'rev-list': { code: 0, stdout: '2\t5\n' } });
    expect(await checkMainRef({ sha: A, cwd: '/repo', git: diverged.git })).toMatchObject({ state: 'behind', behind: 5, ahead: 2 });

    const ahead = fakeGit({ 'ls-remote': ls(B), 'rev-list': { code: 0, stdout: '4\t0\n' } });
    expect(await checkMainRef({ sha: A, cwd: '/repo', git: ahead.git })).toEqual({ state: 'ahead', sha: A, remoteSha: B, behind: 0, ahead: 4, reason: null });
    expectReadOnly(ahead.calls);
  });

  it('rev-list fails and the build\'s commit is here: behind, not counted', async () => {
    const { git, calls } = fakeGit({ 'ls-remote': ls(B), 'cat-file': { code: 0 } });
    const m = await checkMainRef({ sha: A, cwd: '/repo', git });
    expect(m).toEqual({ state: 'behind', sha: A, remoteSha: B, behind: null, ahead: null, reason: null });
    expect(calls.map((c) => c.args[0])).toEqual(['ls-remote', 'rev-list', 'cat-file']);
    expect(calls[2].args).toEqual(['cat-file', '-e', `${A}^{commit}`]);
    expectReadOnly(calls);
    expectNoLeak(m);
  });

  it('rev-list fails and the build\'s commit is not here: unknown', async () => {
    const { git, calls } = fakeGit({ 'ls-remote': ls(B) });
    const m = await checkMainRef({ sha: A, cwd: '/repo', git });
    expect(m).toEqual({ state: 'unknown', sha: A, remoteSha: B, behind: null, ahead: null, reason: "the build's commit is not in this checkout" });
    expect(calls.map((c) => c.args[0])).toEqual(['ls-remote', 'rev-list', 'cat-file']);
    expectReadOnly(calls);
    expectNoLeak(m);
  });

  it('from sources there is no built checkout', () => {
    expect(defaultCheckoutDir()).toBeNull();
  });
});

describe('main-ref: describeMainRef', () => {
  const base: MainRefStatus = { state: 'level', sha: A, remoteSha: B, behind: 0, ahead: 0, reason: null };
  const subject = `running ${A.slice(0, 12)}`;

  it('behind warns with the count, singular and plural, and the fix', () => {
    expect(describeMainRef({ ...base, state: 'behind', behind: 1 }, subject)).toEqual({ level: 'warn', summary: `${subject} is 1 commit behind origin/main (${B.slice(0, 12)})`, fix: MAIN_REF_FIX });
    expect(describeMainRef({ ...base, state: 'behind', behind: 2 }, subject).summary).toBe(`${subject} is 2 commits behind origin/main (${B.slice(0, 12)})`);
    expect(describeMainRef({ ...base, state: 'behind', behind: 2, ahead: 3 }, subject).summary).toBe(`${subject} is 2 commits behind origin/main (${B.slice(0, 12)}), and 3 ahead of it`);
    expect(MAIN_REF_FIX).toBe('git pull, then cd remote-server && npm run build && remotea upgrade');
  });

  it('behind without a count says so, and still warns with the fix', () => {
    expect(describeMainRef({ ...base, state: 'behind', behind: null, ahead: null }, subject)).toEqual({
      level: 'warn',
      summary: `${subject} is behind origin/main (${B.slice(0, 12)}); how many commits is unknown until that commit is fetched`,
      fix: MAIN_REF_FIX,
    });
  });

  it('level, ahead and unknown are ok and carry no fix', () => {
    expect(describeMainRef({ ...base, remoteSha: A }, subject)).toEqual({ level: 'ok', summary: `${subject} is level with origin/main` });
    expect(describeMainRef({ ...base, state: 'ahead', ahead: 1 }, subject)).toEqual({ level: 'ok', summary: `${subject} is 1 commit ahead of origin/main` });
    expect(describeMainRef({ ...base, state: 'ahead', ahead: 4 }, 'the build on disk abc')).toEqual({ level: 'ok', summary: 'the build on disk abc is 4 commits ahead of origin/main' });
    expect(describeMainRef({ state: 'unknown', sha: null, remoteSha: null, behind: null, ahead: null, reason: 'the build has no git commit' }, subject)).toEqual({ level: 'ok', summary: 'not compared with origin/main: the build has no git commit' });
  });

  it('the subject names the running build, else the one on disk', () => {
    expect(mainRefSubject({ sha: A }, base)).toBe(`running ${A.slice(0, 12)}`);
    expect(mainRefSubject(null, base)).toBe(`the build on disk ${A.slice(0, 12)}`);
    expect(mainRefSubject(null, { ...base, sha: null })).toBe('the build on disk unknown');
  });
});

describe('main-ref: real git against a local bare origin', () => {
  const g = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  const commit = (cwd: string, msg: string) => g(cwd, 'commit', '-q', '--allow-empty', '-m', msg);
  /** Everything the check could disturb: HEAD, the working tree and every ref. */
  const snapshot = (cwd: string) => ({ head: g(cwd, 'rev-parse', 'HEAD'), status: g(cwd, 'status', '--porcelain'), refs: g(cwd, 'for-each-ref') });

  /** origin (bare), a second clone that pushes to it, and the clone under test. */
  function setup(): { origin: string; pusher: string; clone: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remotea-mainref-'));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const origin = path.join(root, 'origin.git');
    const pusher = path.join(root, 'pusher');
    const clone = path.join(root, 'clone');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
    execFileSync('git', ['init', '-q', '-b', 'main', pusher]);
    g(pusher, 'remote', 'add', 'origin', origin);
    commit(pusher, 'init');
    g(pusher, 'push', '-q', 'origin', 'main');
    execFileSync('git', ['clone', '-q', origin, clone], { stdio: 'ignore' });
    return { origin, pusher, clone };
  }

  async function check(clone: string, sha: string): Promise<MainRefStatus> {
    const before = snapshot(clone);
    const m = await checkMainRef({ sha, cwd: clone });
    expect(snapshot(clone)).toEqual(before);
    return m;
  }

  it('level, then behind uncounted, then behind by 2 once fetched; the clone is never changed', async () => {
    const { pusher, clone } = setup();
    const built = g(clone, 'rev-parse', 'HEAD');
    expect(await check(clone, built)).toEqual({ state: 'level', sha: built, remoteSha: built, behind: 0, ahead: 0, reason: null });

    commit(pusher, 'one');
    commit(pusher, 'two');
    g(pusher, 'push', '-q', 'origin', 'main');
    const tip = g(pusher, 'rev-parse', 'HEAD');

    // origin moved and this clone never fetched: behind, but not countable without fetching.
    const uncounted = await check(clone, built);
    expect(uncounted).toEqual({ state: 'behind', sha: built, remoteSha: tip, behind: null, ahead: null, reason: null });
    expect(describeMainRef(uncounted, 'running x').summary).toContain('unknown until that commit is fetched');
    // The check did not bring origin's commit in.
    expect(() => g(clone, 'cat-file', '-e', `${tip}^{commit}`)).toThrow();

    // The operator fetches (the check never does): now it can count.
    g(clone, 'fetch', '-q', 'origin');
    expect(await check(clone, built)).toEqual({ state: 'behind', sha: built, remoteSha: tip, behind: 2, ahead: 0, reason: null });
    expect(g(clone, 'rev-parse', 'HEAD')).toBe(built);
  });

  it('ahead: the build has a commit origin lacks', async () => {
    const { clone } = setup();
    const base = g(clone, 'rev-parse', 'HEAD');
    commit(clone, 'local');
    const built = g(clone, 'rev-parse', 'HEAD');
    expect(await check(clone, built)).toEqual({ state: 'ahead', sha: built, remoteSha: base, behind: 0, ahead: 1, reason: null });
  });

  it('unknown without a remote, and for a commit this checkout does not have', async () => {
    const { pusher, clone } = setup();
    const lonely = fs.mkdtempSync(path.join(os.tmpdir(), 'remotea-mainref-lonely-'));
    cleanups.push(() => fs.rmSync(lonely, { recursive: true, force: true }));
    execFileSync('git', ['init', '-q', '-b', 'main', lonely]);
    commit(lonely, 'init');
    expect(await check(lonely, g(lonely, 'rev-parse', 'HEAD'))).toMatchObject({ state: 'unknown', remoteSha: null, reason: expect.stringContaining('origin could not be asked') });

    commit(pusher, 'more');
    g(pusher, 'push', '-q', 'origin', 'main');
    expect(await check(clone, A)).toMatchObject({ state: 'unknown', reason: "the build's commit is not in this checkout" });
  });
});
