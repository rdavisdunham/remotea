import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { WorktreeManager, cleanupCommands } from '../src/worktrees';
import { runVerify, workspaceFingerprint } from '../src/verify-runner';
import type { ExecutionTarget } from '../src/eridani-targets';

const cleanups: Array<() => unknown> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });

function repo(): { root: string; repo: string; target: ExecutionTarget } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-')));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const r = path.join(root, 'repo');
  fs.mkdirSync(r);
  git(r, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(r, 'a.txt'), 'one\n');
  fs.writeFileSync(path.join(r, '.gitignore'), '.env\n');
  git(r, 'add', '.');
  git(r, 'commit', '-q', '-m', 'init');
  return { root, repo: r, target: { id: 't', repo: r, worktreeRoot: path.join(root, 'wts'), base: 'main', launch: { claude: {} }, verify: [] } };
}

describe('worktrees', () => {
  it('creates one worktree per branch from the base, records the base, and reuses it', async () => {
    const { root, target, repo: r } = repo();
    const m = new WorktreeManager({ dir: root });
    const a = await m.ensure(target, 'eri/task-1');
    expect(a).toMatchObject({ path: path.join(root, 'wts', 'eri--task-1'), branch: 'eri/task-1', base: 'main', created: true });
    expect(a.baseSha).toBe(git(r, 'rev-parse', 'main').trim());
    const b = await m.ensure(target, 'eri/task-1');
    expect(b).toMatchObject({ path: a.path, created: false, baseSha: a.baseSha });
    await expect(m.ensure(target, 'main')).rejects.toThrow(/base branch/);
    await expect(m.ensure(target, 'bad..name')).rejects.toThrow();
  });

  it('nominates only: unmerged, dirty and ignored work keeps a worktree; a clean merged one is a candidate', async () => {
    const { root, target } = repo();
    const m = new WorktreeManager({ dir: root });
    const dirty = await m.ensure(target, 'eri/dirty');
    fs.writeFileSync(path.join(dirty.path, '.env'), 'SECRET=1\n');
    fs.writeFileSync(path.join(dirty.path, 'new.txt'), 'x\n');
    const clean = await m.ensure(target, 'eri/clean');
    const ahead = await m.ensure(target, 'eri/ahead');
    fs.writeFileSync(path.join(ahead.path, 'b.txt'), 'b\n');
    git(ahead.path, 'add', '.');
    git(ahead.path, 'commit', '-q', '-m', 'work');
    const rows = await m.nominate([target], (p) => p === clean.path && false);
    const by = (p: string) => rows.find((r) => r.path === p)!;
    expect(by(dirty.path).candidate).toBe(false);
    expect(by(dirty.path).reasons.join(';')).toMatch(/untracked/);
    expect(by(dirty.path).reasons.join(';')).toMatch(/ignored file/);
    expect(by(ahead.path)).toMatchObject({ candidate: false, merged: false, ahead: 1 });
    expect(by(ahead.path).reasons.join(';')).toMatch(/no upstream/);
    expect(by(clean.path)).toMatchObject({ candidate: true, merged: true, reasons: [] });
    // Active sessions keep theirs.
    expect((await m.nominate([target], (p) => p === clean.path)).find((r) => r.path === clean.path)!.candidate).toBe(false);
    // Nothing was removed, and the commands offered start with a recovery ref.
    expect(fs.existsSync(clean.path)).toBe(true);
    expect(cleanupCommands(target.repo, by(clean.path))[0]).toMatch(/update-ref refs\/remotea\/recovery\/eri--clean /);
  });
});

describe('verify-runner', () => {
  it('runs the allowlisted argv without a shell in the worktree, with a bounded tail and a fingerprint', async () => {
    const { repo: r } = repo();
    const out = await runVerify({
      spec: { id: 'echo', argv: [process.execPath, '-e', 'for (let i = 0; i < 2000; i++) console.log("line " + i); process.exitCode = 3'], timeout: 30 },
      worktree: r,
      tailChars: 100,
    });
    expect(out.exit_code).toBe(3);
    expect(out.truncated).toBe(true);
    expect(out.tail.length).toBeLessThanOrEqual(100);
    expect(out.tail).toContain('line 1999');
    expect(out.workspace_fingerprint).toMatch(new RegExp(`^${git(r, 'rev-parse', 'HEAD').trim()}:[0-9a-f]{64}$`));
  });

  it('the fingerprint changes with tracked edits and untracked content, not with nothing', async () => {
    const { repo: r } = repo();
    const a = await workspaceFingerprint(r);
    expect(await workspaceFingerprint(r)).toBe(a);
    fs.writeFileSync(path.join(r, 'u.txt'), '1');
    const b = await workspaceFingerprint(r);
    expect(b).not.toBe(a);
    fs.writeFileSync(path.join(r, 'u.txt'), '2');
    expect(await workspaceFingerprint(r)).not.toBe(b);
  });

  it('a timeout kills the whole process tree', async () => {
    const { repo: r, root } = repo();
    const pidFile = path.join(root, 'child.pid');
    const script = `const { spawn } = require('child_process'); const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(c.pid)); setInterval(() => {}, 1000);`;
    const out = await runVerify({ spec: { id: 'hang', argv: [process.execPath, '-e', script], timeout: 30 }, worktree: r, timeoutMs: 1500, killGraceMs: 200 });
    expect(out.timed_out).toBe(true);
    const child = Number(fs.readFileSync(pidFile, 'utf8'));
    const alive = () => { try { process.kill(child, 0); return true; } catch { return false; } };
    const end = Date.now() + 3000;
    while (alive() && Date.now() < end) await new Promise((res) => setTimeout(res, 50));
    expect(alive()).toBe(false);
  });

  it('refuses a cwd outside the worktree', async () => {
    const { repo: r } = repo();
    const out = await runVerify({ spec: { id: 'x', argv: ['true'], cwd: '../..', timeout: 5 }, worktree: r });
    expect(out.error).toMatch(/escapes/);
  });
});
