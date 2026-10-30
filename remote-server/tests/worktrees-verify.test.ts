import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { WorktreeManager, cleanupCommands, migrationHead } from '../src/worktrees';
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
    // No commits of its own: not "merged", just nothing to merge yet; still nothing to lose.
    expect(by(clean.path)).toMatchObject({ candidate: true, merged: null, merged_reason: 'no commits of its own yet', ahead: 0, reasons: [] });
    // Active sessions keep theirs.
    expect((await m.nominate([target], (p) => p === clean.path)).find((r) => r.path === clean.path)!.candidate).toBe(false);
    // Nothing was removed, and the commands offered start with a recovery ref.
    expect(fs.existsSync(clean.path)).toBe(true);
    expect(cleanupCommands(target.repo, by(clean.path))[0]).toMatch(/update-ref refs\/remotea\/recovery\/eri--clean /);
  });
});

/** A repo whose `origin` is a bare repository, plus a second clone that pushes to it. */
function withOrigin() {
  const r = repo();
  const bare = path.join(r.root, 'origin.git');
  git(r.root, 'init', '-q', '--bare', '-b', 'main', bare);
  git(r.repo, 'remote', 'add', 'origin', bare);
  git(r.repo, 'push', '-q', 'origin', 'main');
  const other = path.join(r.root, 'other');
  git(r.root, 'clone', '-q', bare, other);
  const pushUpstream = (file: string) => {
    fs.mkdirSync(path.dirname(path.join(other, file)), { recursive: true });
    fs.writeFileSync(path.join(other, file), `${file}\n`);
    git(other, 'add', '.');
    git(other, 'commit', '-q', '-m', file);
    git(other, 'push', '-q', 'origin', 'main');
    return git(other, 'rev-parse', 'HEAD').trim();
  };
  return { ...r, pushUpstream };
}

describe('worktrees: freshness', () => {
  it('fetches before basing: a new worktree starts from origin/main when local main is behind it', async () => {
    const { root, target, repo: r, pushUpstream } = withOrigin();
    const upstream = pushUpstream('b.txt');
    const m = new WorktreeManager({ dir: root });
    const a = await m.ensure(target, 'eri/fresh');
    expect(a).toMatchObject({ baseSha: upstream, baseRef: 'origin/main', fetch: { ok: true }, behind: 0, ahead: 0, created: true });
    expect(git(r, 'rev-parse', 'main').trim()).not.toBe(upstream); // local main untouched
  });

  it('keeps local main when it already contains origin/main (unpushed local commits)', async () => {
    const { root, target, repo: r } = withOrigin();
    fs.writeFileSync(path.join(r, 'local.txt'), 'x\n');
    git(r, 'add', '.');
    git(r, 'commit', '-q', '-m', 'local');
    const a = await new WorktreeManager({ dir: root }).ensure(target, 'eri/local');
    expect(a).toMatchObject({ baseSha: git(r, 'rev-parse', 'main').trim(), baseRef: 'main', fetch: { ok: true } });
  });

  it('falls back to local main when the fetch fails, and says so', async () => {
    const { root, target, repo: r } = repo(); // no origin remote
    const a = await new WorktreeManager({ dir: root }).ensure(target, 'eri/offline');
    expect(a.fetch?.ok).toBe(false);
    expect(a.fetch?.error).toBeTruthy();
    expect(a).toMatchObject({ baseSha: git(r, 'rev-parse', 'main').trim(), baseRef: 'main' });
  });

  it('does not fetch for a base other than the target\'s own', async () => {
    const { root, target } = withOrigin();
    const m = new WorktreeManager({ dir: root });
    await m.ensure(target, 'eri/parent');
    expect((await m.ensure(target, 'eri/child', 'eri/parent')).fetch).toBeNull();
  });

  it('a reused worktree is measured against the freshly fetched base', async () => {
    const { root, target, pushUpstream } = withOrigin();
    const m = new WorktreeManager({ dir: root });
    const first = await m.ensure(target, 'eri/reuse');
    pushUpstream('c.txt');
    pushUpstream('d.txt');
    const again = await m.ensure(target, 'eri/reuse');
    expect(again).toMatchObject({ path: first.path, created: false, baseSha: first.baseSha, baseRef: 'origin/main', behind: 2, ahead: 0 });
  });

  it('reports behind/merged against origin/main and the migration head on the fresh base', async () => {
    const { root, target, pushUpstream } = withOrigin();
    const t = { ...target, migrations: { dir: 'migrations/versions' } };
    const m = new WorktreeManager({ dir: root });
    const w = await m.ensure(t, 'eri/report');
    fs.writeFileSync(path.join(w.path, 'mine.txt'), 'x\n');
    git(w.path, 'add', '.');
    git(w.path, 'commit', '-q', '-m', 'mine');
    pushUpstream('migrations/versions/0007_a.py');
    pushUpstream('migrations/versions/0012_b.py');
    const rows = await m.nominate([t], () => false);
    expect(rows[0]).toMatchObject({ branch: 'eri/report', base_ref: 'origin/main', behind: 2, ahead: 1, merged: false });
    expect(await m.migrationHeads([t])).toEqual([{ target: 't', dir: 'migrations/versions', ref: 'origin/main', head: 12 }]);
    expect(await m.migrationHeads([target])).toEqual([]); // not configured: nothing reported
  });

  it('migrationHead takes the first capture group of the pattern', () => {
    expect(migrationHead(['0001_a.py', '0032_plan_review.py', '__init__.py', 'README'])).toBe(32);
    expect(migrationHead(['v3-x.sql', 'v10-y.sql'], '^v(\\d+)-')).toBe(10);
    expect(migrationHead([])).toBeNull();
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
