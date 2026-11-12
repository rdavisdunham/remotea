/**
 * run.changes (run-changes.ts): what a run changed, read from a real git repository.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { commandShapeError, STAGE_F_CAPS } from '../../src/shared/eridani-link-protocol';
import { execGh } from '../src/ci-status';
import { parseNumstat, runChanges, RunChangesError } from '../src/run-changes';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const c of cleanups.splice(0)) c(); });

function repo(): { dir: string; git: (...args: string[]) => string; write: (file: string, text: string) => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remotea-changes-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' });
  const write = (file: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  };
  git('init', '-q', '-b', 'main');
  write('app.txt', 'one\ntwo\n');
  write('package-lock.json', '{}\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  git('checkout', '-q', '-b', 'task/1');
  return { dir, git, write };
}

describe('runChanges', () => {
  it('reports committed and uncommitted edits against the merge base, with untracked files named', async () => {
    const { dir, git, write } = repo();
    write('app.txt', 'one\nTWO\nthree\n');
    write('package-lock.json', '{"lock": true}\n');
    git('commit', '-q', '-am', 'work');
    // The base moved on after the branch left it: its change is not the run's.
    git('checkout', '-q', 'main');
    write('other.txt', 'elsewhere\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'main moves');
    git('checkout', '-q', 'task/1');
    write('app.txt', 'one\nTWO\nthree\nfour\n'); // not committed
    write('notes/new.md', 'fresh\n'); // not tracked

    const r = await runChanges({ cwd: dir, base: 'main', exec: execGh });
    expect(r.head).toBe(git('rev-parse', 'HEAD').trim());
    expect(r.base_ref).toBe('main'); // no origin in this clone
    expect(r.base_sha).toBe(git('merge-base', 'HEAD', 'main').trim());
    expect(r.files).toEqual([{ path: 'app.txt', added: 3, removed: 1 }, { path: 'package-lock.json', added: 1, removed: 1 }]);
    expect(r.files_total).toBe(2);
    expect(r.untracked).toEqual(['notes/']);
    expect(r.uncommitted).toBe(true);
    expect(r.patch).toContain('+four');
    expect(r.patch).toContain('+TWO');
    expect(r.patch).not.toContain('package-lock.json'); // listed in files, left out of the patch
    expect(r.patch).not.toContain('elsewhere');
    expect(r.patch_truncated).toBe(false);
    expect(r.patch_chars).toBe(r.patch.length);
  });

  it('cuts a long patch, redacts secrets, and says when nothing changed', async () => {
    const { dir, git, write } = repo();
    const clean = await runChanges({ cwd: dir, base: 'main', exec: execGh });
    expect(clean).toMatchObject({ files: [], files_total: 0, untracked: [], uncommitted: false, patch: '', patch_truncated: false });
    write('big.txt', `${'line of text\n'.repeat(400)}`);
    write('env.txt', 'token=ghp_0123456789abcdefghijklmnopqrstuvwxyzAB\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'big');
    const cut = await runChanges({ cwd: dir, base: 'main', maxChars: 1000, exec: execGh });
    expect(cut.patch).toHaveLength(1000);
    expect(cut.patch_truncated).toBe(true);
    expect(cut.patch_chars).toBeGreaterThan(1000);
    const whole = await runChanges({ cwd: dir, base: 'main', exec: execGh });
    expect(whole.patch).toContain('[redacted]');
    expect(whole.patch).not.toContain('ghp_0123456789');
  });

  it('fails with the reason for an unknown base or a folder that is no repository', async () => {
    const { dir } = repo();
    await expect(runChanges({ cwd: dir, base: 'nope', exec: execGh })).rejects.toThrow(new RunChangesError('no base branch nope in this clone'));
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'remotea-plain-'));
    cleanups.push(() => fs.rmSync(plain, { recursive: true, force: true }));
    await expect(runChanges({ cwd: plain, base: 'main', exec: execGh })).rejects.toThrow(/git rev-parse HEAD/);
    await expect(runChanges({ cwd: dir, base: 'main', exec: async () => ({ code: 1, stdout: '', stderr: '', missing: true }) })).rejects.toThrow(/git is not installed/);
  });

  it('parses numstat lines, binary files included', () => {
    expect(parseNumstat('3\t1\ta.ts\n-\t-\timg.png\n\n0\t0\told => new\n')).toEqual([
      { path: 'a.ts', added: 3, removed: 1 }, { path: 'img.png', added: null, removed: null }, { path: 'old => new', added: 0, removed: 0 }]);
  });
});

describe('run.changes command shape', () => {
  const cmd = (over: Record<string, unknown> = {}) => ({ t: 'run.changes', op_id: 'op-1', run_id: 'run-1', generation: 1, branch: 'task/1', expires_at: Date.now() + 60_000, ...over });
  it('is a stage F capability and validates its fields', () => {
    expect(STAGE_F_CAPS).toContain('run.changes');
    expect(commandShapeError(cmd())).toBeNull();
    expect(commandShapeError(cmd({ base: 'main', target: 'remotea', turn_seq: 2, max_chars: 60000 }))).toBeNull();
    expect(commandShapeError(cmd({ expires_at: undefined }))).toBe('expires_at required');
    expect(commandShapeError(cmd({ branch: '-x' }))).toBe('bad branch');
    expect(commandShapeError(cmd({ base: 'a..b' }))).toBe('bad base');
    expect(commandShapeError(cmd({ max_chars: 10 }))).toBe('bad max_chars');
    expect(commandShapeError(cmd({ target: '../x' }))).toBe('bad target');
  });
});
