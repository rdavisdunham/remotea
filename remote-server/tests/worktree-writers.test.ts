/**
 * S-S4: one writer per worktree. A second spawn onto a branch a live session
 * already writes is refused (`worktree_busy`, with the writer) unless it says
 * `share: true`; a child task based on its parent's branch gets its own
 * worktree; the worktrees report names each worktree's writer.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { Hub } from '../src/hub';
import { Registry } from '../src/registry';
import { Dispatch, surfFor } from '../src/dispatch';
import { QuestionBroker } from '../src/questions-claude';
import { WorktreeManager, liveWriters, writersByPath } from '../src/worktrees';
import type { CommandContext, CommandResult } from '../src/eridani-link';
import type { ExecutionTarget } from '../src/eridani-targets';
import type { CommandBody } from '../../src/shared/eridani-link-protocol';
import { commandShapeError, WORKTREE_BUSY } from '../../src/shared/eridani-link-protocol';
import { fakeSpawner, ManualTimers } from './helpers';

const cleanups: Array<() => unknown> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });

function repo(): { root: string; target: ExecutionTarget } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wtw-')));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const r = path.join(root, 'repo');
  fs.mkdirSync(r);
  git(r, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(r, 'a.txt'), 'one\n');
  git(r, 'add', '.');
  git(r, 'commit', '-q', '-m', 'init');
  return { root, target: { id: 'proj', repo: r, worktreeRoot: path.join(root, 'wts'), base: 'main', launch: { claude: {}, codex: {} }, verify: [] } };
}

function setup() {
  const { root, target } = repo();
  const registry = Registry.load({ file: null, bootId: 'boot-1' });
  const hub = new Hub({ registry, spawn: fakeSpawner().spawn, bootId: 'boot-1', serverId: 'srv', hostname: 'box', timers: new ManualTimers(), probe: () => ({}) });
  const worktrees = new WorktreeManager({ dir: root });
  const questions = new QuestionBroker({ session: (id) => registry.session(id), canHold: () => true, emit: () => {}, needsYou: () => {} });
  const dispatch = new Dispatch({ hub, registry, dir: null, worktrees, targets: () => [target], questions, emit: () => {}, linkReady: () => true });
  hub.setEridani(dispatch.hubHooks());
  const h = dispatch.handlers();
  const run = async (cmd: Record<string, unknown>): Promise<CommandResult> => {
    const bad = commandShapeError(cmd);
    if (bad) return { state: 'rejected', detail: bad };
    const pre = dispatch.precheck(cmd as CommandBody);
    if (pre) return { state: 'rejected', detail: pre };
    const ctx: CommandContext = { begin: () => {} };
    return h[cmd.t as string](cmd as CommandBody, ctx);
  };
  return { root, target, registry, hub, worktrees, dispatch, run };
}

let op = 0;
const spawn = (over: Record<string, unknown> = {}) => ({
  t: 'spawn',
  op_id: `op-${++op}`,
  digest: 'd',
  run_id: 'run-1',
  generation: 1,
  attempt: 1,
  harness: 'claude',
  model: 'sonnet',
  target: { id: 'proj', branch: 'eri/task-1' },
  prompt: 'work',
  expires_at: Date.now() + 60_000,
  ...over,
});

const WRITER = { surf: surfFor('run-1', 1, 1), run_id: 'run-1' };

describe('worktree writer policy (S-S4)', () => {
  it('refuses a second spawn onto a branch with a live writer, with the typed outcome', async () => {
    const { run } = setup();
    expect((await run(spawn())).state).toBe('executed');
    expect(await run(spawn({ run_id: 'run-2' }))).toEqual({ state: 'rejected', detail: WORKTREE_BUSY, result: { branch: 'eri/task-1', writer: WRITER } });
    // Another attempt of the same run is refused too: two processes would edit one tree.
    expect((await run(spawn({ attempt: 2 }))).detail).toBe(WORKTREE_BUSY);
    // Replaying the first spawn is still "already started", not busy.
    expect(await run(spawn())).toMatchObject({ state: 'executed', detail: 'already started' });
  });

  it('a spawn in flight already claims the branch: two concurrent spawns never both start', async () => {
    const { run } = setup();
    const [a, b] = await Promise.all([run(spawn()), run(spawn({ run_id: 'run-2' }))]);
    expect(a.state).toBe('executed');
    expect(b).toEqual({ state: 'rejected', detail: WORKTREE_BUSY, result: { branch: 'eri/task-1', writer: WRITER } });
  });

  it('share: true starts in the same worktree; the first session stays the reported writer', async () => {
    const { run, registry } = setup();
    const first = await run(spawn());
    const shared = await run(spawn({ run_id: 'run-2', share: true }));
    expect(shared.state).toBe('executed');
    expect(shared.result!.worktree).toBe(first.result!.worktree);
    expect(liveWriters(registry.sessions()).map((w) => w.writer.run_id)).toEqual(['run-1', 'run-2']);
    expect(writersByPath(registry.sessions()).get(String(first.result!.worktree))).toEqual(WRITER);
    // share: false is the default policy.
    expect((await run(spawn({ run_id: 'run-3', share: false }))).detail).toBe(WORKTREE_BUSY);
    expect(commandShapeError(spawn({ share: 'yes' }))).toBe('bad share');
  });

  it('a child task based on its parent branch gets its own worktree while the parent writes', async () => {
    const { run } = setup();
    const parent = await run(spawn({ target: { id: 'proj', branch: 'eri/parent' } }));
    expect(parent.state).toBe('executed');
    const child = await run(spawn({ run_id: 'run-child', target: { id: 'proj', branch: 'eri/child', base: 'eri/parent' } }));
    expect(child.state).toBe('executed');
    expect(child.result).toMatchObject({ branch: 'eri/child', base: 'eri/parent' });
    expect(child.result!.worktree).not.toBe(parent.result!.worktree);
  });

  it('frees the branch once the writer has exited', async () => {
    const { run, hub } = setup();
    const first = await run(spawn());
    hub.updateRecord(String(first.result!.surf), { state: 'exited' });
    expect((await run(spawn({ run_id: 'run-2' }))).state).toBe('executed');
  });

  it("the worktrees report names each worktree's writer (null when none)", async () => {
    const { run, target, registry, worktrees } = setup();
    const busy = await run(spawn());
    await worktrees.ensure(target, 'eri/idle');
    const writers = writersByPath(registry.sessions());
    const rows = await worktrees.nominate([target], (p) => writers.has(p), (p) => writers.get(p) ?? null);
    const by = (b: string) => rows.find((r) => r.branch === b)!;
    expect(by('eri/task-1')).toMatchObject({ path: busy.result!.worktree, active: true, writer: WRITER });
    expect(by('eri/idle')).toMatchObject({ active: false, writer: null });
    // Without a writer lookup (older callers) the field is absent.
    expect((await worktrees.nominate([target], () => false)).every((r) => !('writer' in r))).toBe(true);
  });
});
