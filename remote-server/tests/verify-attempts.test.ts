import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { Hub } from '../src/hub';
import { Registry } from '../src/registry';
import { Dispatch, surfFor } from '../src/dispatch';
import { QuestionBroker } from '../src/questions-claude';
import { VerifyAttempts, type VerifyResultFields } from '../src/verify-attempts';
import { runVerify, workspaceState } from '../src/verify-runner';
import type { CommandContext, CommandResult } from '../src/eridani-link';
import type { ExecutionTarget, VerifySpec } from '../src/eridani-targets';
import type { WorktreeManager } from '../src/worktrees';
import type { VerifyOutcome, VerifyRunOptions } from '../src/verify-runner';
import type { TurnFields } from '../src/turn-capture';
import type { SessionRecord, VerifyAttemptStatus } from '../../src/shared/remote-host-protocol';
import { commandShapeError, parseUpFrame, type CommandBody } from '../../src/shared/eridani-link-protocol';
import { fakeSpawner, ManualTimers } from './helpers';

const cleanups: Array<() => unknown> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

const flush = () => new Promise((r) => setTimeout(r, 0));
async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 2));
  }
}

/** A verify runner the test finishes by hand; an abort finishes it as canceled. */
function fakeRunner() {
  const calls: Array<{ o: VerifyRunOptions; finish: (over?: Partial<VerifyOutcome>) => void; aborted: () => boolean }> = [];
  const run = (o: VerifyRunOptions) =>
    new Promise<VerifyOutcome>((resolve) => {
      const base: VerifyOutcome = { workspace_fingerprint: 'head:tree', exit_code: 0, tail: 'ok\n', truncated: false, duration_ms: 5, timed_out: false, canceled: false, stale_workspace: false };
      const finish = (over: Partial<VerifyOutcome> = {}) => resolve({ ...base, ...over });
      o.signal?.addEventListener('abort', () => finish({ exit_code: 143, canceled: true }), { once: true });
      calls.push({ o, finish, aborted: () => !!o.signal?.aborted });
    });
  return { calls, run };
}

const SPEC: VerifySpec = { id: 'test', argv: ['npm', 'test'], timeout: 60 };

function binding(over: Partial<NonNullable<SessionRecord['eridani']>> = {}): NonNullable<SessionRecord['eridani']> {
  return {
    runId: 'run-1', generation: 1, attempt: 1, taskId: 't', target: 'proj', harness: 'claude', model: 'sonnet',
    worktree: '/wt/a', branch: 'eri/a', base: 'main', baseSha: null, spawnOp: 'op', verify: { verifyId: 'test', planRevision: 3 }, ...over,
  };
}

function unit(opts: { eridani?: SessionRecord['eridani'] } = {}) {
  const timers = new ManualTimers();
  const rec = { id: 'surf-1', eridani: 'eridani' in opts ? opts.eridani : binding() } as SessionRecord;
  const statuses: VerifyAttemptStatus[] = [];
  const emitted: VerifyResultFields[] = [];
  const runner = fakeRunner();
  let fp = 'head:tree';
  let n = 0;
  const a = new VerifyAttempts({
    session: (id) => (id === rec.id ? rec : undefined),
    setStatus: (_id, s) => statuses.push(s),
    spec: (_r, id) => (id === 'test' ? SPEC : undefined),
    run: runner.run,
    fingerprint: async () => fp,
    emit: (b) => emitted.push(b),
    timers,
    now: () => timers.now,
    log: () => {},
    debounceMs: 2000,
    mintId: () => `id-${++n}`,
  });
  return { a, rec, timers, statuses, emitted, runner, setFp: (v: string) => (fp = v) };
}

const turn = (seq: number, over: Partial<TurnFields> = {}): TurnFields => ({
  surf: 'surf-1', incarnation: 1, run_id: 'run-1', generation: 1, provider: 'claude', tool: 'claude_code', provider_session_id: 's',
  provider_turn_id: `p${seq}`, root: true, seq, text: 'done', truncated: false, missing: false, source: 'hook', ended_at: 0, ...over,
});

const vcmd = (over: Record<string, unknown> = {}) => ({
  t: 'verify' as const, op_id: 'op-v', digest: 'd', attempt_id: 'att-E', run_id: 'run-1', generation: 1, turn_seq: 1, plan_revision: 3, verify_id: 'test', ...over,
});

describe('verify attempts: automatic after turns', () => {
  it('waits 2 s after a root turn, then runs once with a local attempt id and the full tuple', async () => {
    const { a, timers, runner, emitted, statuses } = unit();
    a.onTurn(turn(1));
    expect(statuses.at(-1)).toMatchObject({ attemptId: 'local:id-1', state: 'pending', startedAt: null, turnSeq: 1, initiator: 'host' });
    timers.advance(1999);
    expect(runner.calls).toHaveLength(0);
    timers.advance(1);
    expect(runner.calls).toHaveLength(1);
    expect(statuses.at(-1)).toMatchObject({ state: 'running', startedAt: 2000 });
    runner.calls[0].finish();
    await until(() => emitted.length === 1);
    expect(emitted[0]).toMatchObject({
      t: 'verify.result', attempt_id: 'local:id-1', run_id: 'run-1', generation: 1, turn_seq: 1, plan_revision: 3, verify_id: 'test',
      initiator: 'host', exit_code: 0, stale_workspace: false, turn_fingerprint: 'head:tree',
    });
    expect(statuses.at(-1)).toMatchObject({ attemptId: 'local:id-1', state: 'passed' });
    expect(parseUpFrame({ v: 1, id: 'x', conn_epoch: 1, at: 1, ...emitted[0], op_id: 'o', digest: 'd' })).not.toBeNull();
  });

  it('a newer turn inside the debounce replaces the waiting attempt: one run, for the newer turn', async () => {
    const { a, timers, runner, statuses } = unit();
    a.onTurn(turn(1));
    timers.advance(1500);
    a.onTurn(turn(2));
    expect(statuses.some((s) => s.attemptId === 'local:id-1' && s.state === 'canceled')).toBe(true);
    timers.advance(1999);
    expect(runner.calls).toHaveLength(0);
    timers.advance(1);
    expect(runner.calls).toHaveLength(1);
    expect(a.attempt('surf-1')).toMatchObject({ id: 'local:id-2', tuple: { turn_seq: 2 } });
  });

  it('a newer turn cancels a running attempt (killed, reported canceled) and verifies the newer turn', async () => {
    const { a, timers, runner, emitted, statuses } = unit();
    a.onTurn(turn(1));
    timers.advance(2000);
    a.onTurn(turn(2));
    expect(runner.calls[0].aborted()).toBe(true);
    await until(() => emitted.length === 1);
    expect(emitted[0]).toMatchObject({ attempt_id: 'local:id-1', turn_seq: 1, canceled: true });
    // The canceled attempt finishing late does not overwrite the newer attempt's status.
    expect(statuses.at(-1)).toMatchObject({ attemptId: 'local:id-2', state: 'pending' });
    timers.advance(2000);
    expect(runner.calls).toHaveLength(2);
    runner.calls[1].finish({ exit_code: 1 });
    await until(() => emitted.length === 2);
    expect(emitted[1]).toMatchObject({ attempt_id: 'local:id-2', turn_seq: 2, exit_code: 1, canceled: false });
    expect(statuses.at(-1)).toMatchObject({ state: 'failed' });
  });

  it('runs nothing for an interim Stop, an older generation, a stopping run or a run without a verify config', () => {
    const t1 = unit();
    t1.a.onTurn(turn(1, { interim: true }));
    t1.a.onTurn(turn(2, { run_id: null }));
    t1.rec.eridani = binding({ generation: 2 });
    t1.a.onTurn(turn(3, { generation: 1 }));
    t1.rec.eridani = binding({ stopRequested: { at: 1, mode: 'interrupt', op: null } });
    t1.a.onTurn(turn(4));
    t1.rec.eridani = binding({ verify: undefined });
    t1.a.onTurn(turn(5));
    t1.rec.eridani = binding({ verify: { verifyId: 'nope', planRevision: 1 } });
    t1.a.onTurn(turn(6));
    t1.timers.advance(10_000);
    expect(t1.runner.calls).toHaveLength(0);
    expect(t1.statuses).toHaveLength(0);
  });

  it('cancel (stop / exit) kills a running attempt and drops a waiting one', async () => {
    const { a, timers, runner, emitted, statuses } = unit();
    a.onTurn(turn(1));
    a.cancel('surf-1', 'stop requested');
    timers.advance(5000);
    expect(runner.calls).toHaveLength(0);
    expect(statuses.at(-1)).toMatchObject({ state: 'canceled' });
    a.onTurn(turn(2));
    timers.advance(2000);
    a.cancel('surf-1', 'stop requested');
    await until(() => emitted.length === 1);
    expect(emitted[0]).toMatchObject({ turn_seq: 2, canceled: true });
    expect(statuses.at(-1)).toMatchObject({ attemptId: 'local:id-2', state: 'canceled' });
  });

  it('flags stale_workspace when the tree changed after the turn (runner compares the turn fingerprint)', async () => {
    const { a, timers, runner } = unit();
    a.onTurn(turn(1));
    timers.advance(2000);
    expect(await runner.calls[0].o.expectFingerprint).toBe('head:tree');
  });

  it('a restart turns a waiting or running attempt into interrupted', () => {
    const { a, statuses } = unit();
    const st = (state: VerifyAttemptStatus['state']) => ({ id: 's', verify: { attemptId: 'local:x', state, startedAt: 1, runId: 'r', generation: 1, turnSeq: 1, planRevision: 1, verifyId: 'test', initiator: 'host' } }) as SessionRecord;
    a.recover(st('running'));
    a.recover(st('passed'));
    expect(statuses).toEqual([expect.objectContaining({ attemptId: 'local:x', state: 'interrupted' })]);
  });
});

describe('verify attempts: Eridani commands share the machinery', () => {
  it('a command for the waiting host attempt starts it at once under Eridani\'s id', async () => {
    const { a, timers, runner, emitted } = unit();
    a.onTurn(turn(1));
    const p = a.command('surf-1', vcmd());
    expect(runner.calls).toHaveLength(1);
    runner.calls[0].finish();
    expect(await p).toMatchObject({ state: 'executed', result: { attempt_id: 'att-E', adopted: 'local:id-1' } });
    timers.advance(5000);
    expect(runner.calls).toHaveLength(1);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ attempt_id: 'att-E', initiator: 'eridani', adopted: 'local:id-1', turn_seq: 1, plan_revision: 3 });
  });

  it('a command for the running host attempt adopts it: one run, one result under Eridani\'s id', async () => {
    const { a, timers, runner, emitted, statuses } = unit();
    a.onTurn(turn(1));
    timers.advance(2000);
    const p = a.command('surf-1', vcmd());
    expect(statuses.at(-1)).toMatchObject({ attemptId: 'att-E', state: 'running', initiator: 'eridani' });
    runner.calls[0].finish();
    await p;
    expect(runner.calls).toHaveLength(1);
    expect(emitted.map((e) => e.attempt_id)).toEqual(['att-E']);
  });

  it('a finished host attempt for the same tuple is resent under Eridani\'s id while the tree is unchanged', async () => {
    const { a, timers, runner, emitted, setFp } = unit();
    a.onTurn(turn(1));
    timers.advance(2000);
    runner.calls[0].finish();
    await until(() => emitted.length === 1);
    await a.command('surf-1', vcmd());
    expect(runner.calls).toHaveLength(1);
    expect(emitted[1]).toMatchObject({ attempt_id: 'att-E', adopted: 'local:id-1', exit_code: 0 });
    setFp('head:other');
    const p = a.command('surf-1', vcmd({ attempt_id: 'att-F' }));
    await until(() => runner.calls.length === 2);
    runner.calls[1].finish();
    await p;
    expect(emitted[2]).toMatchObject({ attempt_id: 'att-F' });
    expect(emitted[2].adopted).toBeUndefined();
  });

  it('refuses a command for an older turn than the running attempt; a newer one replaces it', async () => {
    const { a, timers, runner, emitted } = unit();
    a.onTurn(turn(2));
    timers.advance(2000);
    expect(await a.command('surf-1', vcmd({ turn_seq: 1 }))).toMatchObject({ state: 'rejected', detail: expect.stringMatching(/superseded by turn 2/) });
    const p = a.command('surf-1', vcmd({ turn_seq: 3, attempt_id: 'att-3' }));
    await until(() => emitted.length === 1);
    expect(emitted[0]).toMatchObject({ attempt_id: 'local:id-1', canceled: true });
    await until(() => runner.calls.length === 2);
    runner.calls[1].finish();
    expect(await p).toMatchObject({ state: 'executed', result: { attempt_id: 'att-3' } });
  });
});

// ── Through dispatch and the hub ────────────────────────────────────────────

const TARGET: ExecutionTarget = {
  id: 'proj', repo: '/repo', worktreeRoot: '/wt', base: 'main', launch: { claude: {} }, verify: [SPEC],
};

function setup() {
  const registry = Registry.load({ file: null, bootId: 'boot-1' });
  const sp = fakeSpawner();
  const hub = new Hub({ registry, spawn: sp.spawn, bootId: 'boot-1', serverId: 'srv', hostname: 'box', timers: new ManualTimers(), probe: () => ({}) });
  const worktrees = {
    ensure: async (t: ExecutionTarget, branch: string, base: string) => ({ path: `${t.worktreeRoot}/${branch.replace(/\//g, '--')}`, branch, base, baseSha: 'abc', created: true }),
  } as unknown as WorktreeManager;
  const up: Array<Record<string, unknown>> = [];
  const questions = new QuestionBroker({ session: (id) => registry.session(id), canHold: () => false, emit: (b) => up.push(b as unknown as Record<string, unknown>), needsYou: () => {} });
  const timers = new ManualTimers();
  const runner = fakeRunner();
  const verified: VerifyResultFields[] = [];
  const turns: TurnFields[] = [];
  const dispatch = new Dispatch({
    hub, registry, dir: null, worktrees, targets: () => [TARGET], questions,
    emit: (b) => verified.push(b), linkReady: () => true, timers,
    timing: { queuePollMs: 5, pasteEnterMs: 1, steerDelayMs: 1 },
    verify: runner.run, fingerprint: async () => 'head:tree',
  });
  hub.setEridani(dispatch.hubHooks());
  hub.setSink({ status: () => {}, turn: (t) => turns.push(t), exit: () => {} });
  const h = dispatch.handlers();
  const run = async (cmd: Record<string, unknown>): Promise<CommandResult> => {
    const pre = dispatch.precheck(cmd as CommandBody);
    if (pre) return { state: 'rejected', detail: pre };
    const ctx: CommandContext = { begin: () => {} };
    return h[cmd.t as string](cmd as CommandBody, ctx);
  };
  const hook = (surf: string, params: Record<string, unknown>) => hub.relayRpc(surf, 'hook.event', { sessionId: 'sess-1', ...params });
  return { hub, registry, dispatch, run, hook, timers, runner, verified, turns };
}

const spawnCmd = (over: Record<string, unknown> = {}) => ({
  t: 'spawn', op_id: 'op-s', digest: 'd', run_id: 'run-1', generation: 1, attempt: 1, harness: 'claude', model: 'sonnet',
  target: { id: 'proj', branch: 'eri/t' }, prompt: 'go', verify: { verify_id: 'test', plan_revision: 2 }, expires_at: Date.now() + 60_000, ...over,
});

describe('dispatch: verification after turns', () => {
  it('the spawn\'s verify config makes every root turn verify; the result carries the turn\'s tuple', async () => {
    const { run, hook, timers, runner, verified, registry } = setup();
    expect(commandShapeError(spawnCmd())).toBeNull();
    expect(commandShapeError(spawnCmd({ verify: { verify_id: '../x', plan_revision: 1 } }))).toBe('bad verify');
    expect(await run(spawnCmd({ verify: { verify_id: 'lint', plan_revision: 1 } }))).toMatchObject({ state: 'rejected', detail: 'unknown verify id lint' });
    await run(spawnCmd());
    const surf = surfFor('run-1', 1, 1);
    expect(registry.session(surf)!.eridani).toMatchObject({ verify: { verifyId: 'test', planRevision: 2 }, acceptedInput: { generation: 1 } });
    hook(surf, { event: 'UserPromptSubmit', prompt: 'go', turnId: 'p1' });
    expect(registry.session(surf)!.eridani!.acceptedInput).toBeUndefined();
    hook(surf, { event: 'Stop', lastAssistantMessage: 'done', turnId: 'p1' });
    // A duplicate Stop for the same logical turn: no second turn, no second attempt.
    hook(surf, { event: 'Stop', lastAssistantMessage: 'done', turnId: 'p1' });
    timers.advance(2000);
    expect(runner.calls).toHaveLength(1);
    expect(registry.session(surf)!.verify).toMatchObject({ state: 'running', turnSeq: 1, initiator: 'host' });
    runner.calls[0].finish();
    await until(() => verified.length === 1);
    expect(verified[0]).toMatchObject({ attempt_id: expect.stringMatching(/^local:/), run_id: 'run-1', generation: 1, turn_seq: 1, plan_revision: 2, verify_id: 'test' });
    expect(registry.session(surf)!.verify).toMatchObject({ state: 'passed' });
  });

  it('a stop cancels the running attempt', async () => {
    const { run, hook, timers, runner, verified, registry } = setup();
    await run(spawnCmd());
    const surf = surfFor('run-1', 1, 1);
    hook(surf, { event: 'UserPromptSubmit', prompt: 'go', turnId: 'p1' });
    hook(surf, { event: 'Stop', lastAssistantMessage: 'done', turnId: 'p1' });
    timers.advance(2000);
    void run({ t: 'stop', op_id: 'op-stop', digest: 'd', surf, incarnation: registry.session(surf)!.incarnation, run_id: 'run-1', generation: 1, mode: 'kill' });
    await until(() => verified.length === 1);
    expect(runner.calls[0].aborted()).toBe(true);
    expect(verified[0]).toMatchObject({ canceled: true });
  });

  it('a verify command teaches a run without a config to verify after later turns', async () => {
    const { run, hook, timers, runner, verified, registry } = setup();
    await run(spawnCmd({ verify: undefined }));
    const surf = surfFor('run-1', 1, 1);
    expect(registry.session(surf)!.eridani!.verify).toBeUndefined();
    const p = run(vcmd({ turn_seq: 0, plan_revision: 4 }));
    await until(() => runner.calls.length === 1);
    runner.calls[0].finish();
    expect(await p).toMatchObject({ state: 'executed', result: { attempt_id: 'att-E' } });
    expect(registry.session(surf)!.eridani!.verify).toEqual({ verifyId: 'test', planRevision: 4 });
    hook(surf, { event: 'UserPromptSubmit', prompt: 'go', turnId: 'p1' });
    hook(surf, { event: 'Stop', lastAssistantMessage: 'done', turnId: 'p1' });
    timers.advance(2000);
    expect(runner.calls).toHaveLength(2);
    runner.calls[1].finish();
    await until(() => verified.length === 2);
    expect(verified[1]).toMatchObject({ plan_revision: 4, turn_seq: 1 });
  });

  it('runs.snapshot sets and clears the verify config', async () => {
    const { run, dispatch, registry } = setup();
    await run(spawnCmd({ verify: undefined }));
    const surf = surfFor('run-1', 1, 1);
    dispatch.applyRunsSnapshot([{ run_id: 'run-1', generation: 1, desired: 'continue', verify: { verify_id: 'test', plan_revision: 7 } }]);
    expect(registry.session(surf)!.eridani!.verify).toEqual({ verifyId: 'test', planRevision: 7 });
    dispatch.applyRunsSnapshot([{ run_id: 'run-1', generation: 1, desired: 'continue' }]);
    expect(registry.session(surf)!.eridani!.verify).toEqual({ verifyId: 'test', planRevision: 7 });
    dispatch.applyRunsSnapshot([{ run_id: 'run-1', generation: 1, desired: 'continue', verify: null }]);
    expect(registry.session(surf)!.eridani!.verify).toBeUndefined();
  });
});

describe('F07: turn → generation binding', () => {
  it('a queued input binds its turn to the generation it was accepted under, even if the run moves on before the prompt', async () => {
    const { run, hook, dispatch, registry, turns, timers, runner, verified } = setup();
    await run(spawnCmd());
    const surf = surfFor('run-1', 1, 1);
    hook(surf, { event: 'UserPromptSubmit', prompt: 'go', turnId: 'p1' });
    hook(surf, { event: 'Stop', lastAssistantMessage: 'one', turnId: 'p1' });
    timers.advance(2000);
    runner.calls[0].finish();
    await until(() => verified.length === 1);
    // Agent idle → the queued input of generation 1 is typed.
    const p = run({ t: 'input', op_id: 'op-in', digest: 'd', surf, incarnation: registry.session(surf)!.incarnation, run_id: 'run-1', generation: 1, text: 'more', mode: 'queue' });
    for (let i = 0; i < 20 && !registry.session(surf)!.eridani!.acceptedInput; i++) {
      timers.advance(5);
      await flush();
    }
    expect(await p).toMatchObject({ state: 'executed' });
    expect(registry.session(surf)!.eridani!.acceptedInput).toMatchObject({ generation: 1 });
    // Eridani replans before the agent took the prompt.
    dispatch.applyRunsSnapshot([{ run_id: 'run-1', generation: 2, desired: 'continue' }]);
    hook(surf, { event: 'UserPromptSubmit', prompt: 'more', turnId: 'p2' });
    hook(surf, { event: 'Stop', lastAssistantMessage: 'two', turnId: 'p2' });
    expect(turns.at(-1)).toMatchObject({ provider_turn_id: 'p2', generation: 1, seq: 2 });
    // A turn of an older generation is not verified (Eridani would discard it).
    timers.advance(2000);
    expect(runner.calls).toHaveLength(1);
    // A prompt typed in the terminal afterwards takes the current generation.
    hook(surf, { event: 'UserPromptSubmit', prompt: 'local', turnId: 'p3' });
    hook(surf, { event: 'Stop', lastAssistantMessage: 'three', turnId: 'p3' });
    expect(turns.at(-1)).toMatchObject({ provider_turn_id: 'p3', generation: 2, seq: 3 });
    timers.advance(2000);
    expect(runner.calls).toHaveLength(2);
    runner.calls[1].finish();
    await until(() => verified.length === 2);
    expect(verified[1]).toMatchObject({ generation: 2, turn_seq: 3 });
  });

  it('a steer persists the new generation as accepted before typing', async () => {
    const { run, registry } = setup();
    await run(spawnCmd());
    const surf = surfFor('run-1', 1, 1);
    const p = run({ t: 'input', op_id: 'op-steer', digest: 'd', surf, incarnation: registry.session(surf)!.incarnation, run_id: 'run-1', generation: 3, text: 'redo', mode: 'steer' });
    expect(registry.session(surf)!.eridani).toMatchObject({ generation: 3, acceptedInput: { generation: 3 } });
    void p;
  });
});

// ── The runner against a real repository ────────────────────────────────────

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });

function repo(): string {
  const r = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vrepo-')));
  cleanups.push(() => fs.rmSync(r, { recursive: true, force: true }));
  git(r, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(r, 'a.txt'), 'one\n');
  git(r, 'add', '.');
  git(r, 'commit', '-q', '-m', 'init');
  return r;
}

describe('verify-runner: fingerprint and stale_workspace', () => {
  it('the fingerprint names HEAD and the branch, and changes on a branch switch at the same commit', async () => {
    const r = repo();
    const a = await workspaceState(r);
    expect(a).toMatchObject({ head: git(r, 'rev-parse', 'HEAD').trim(), branch: 'main' });
    expect(a.fingerprint).toBe(`${a.head}:${a.tree}`);
    git(r, 'checkout', '-q', '-b', 'other');
    const b = await workspaceState(r);
    expect(b.head).toBe(a.head);
    expect(b.branch).toBe('other');
    expect(b.fingerprint).not.toBe(a.fingerprint);
    git(r, 'checkout', '-q', '--detach');
    expect((await workspaceState(r)).branch).toBeNull();
  });

  it('a result whose tree changed since the turn, or during the run, is stale_workspace', async () => {
    const r = repo();
    const fp = (await workspaceState(r)).fingerprint;
    const clean = await runVerify({ spec: { id: 'v', argv: ['true'], timeout: 10 }, worktree: r, expectFingerprint: fp });
    expect(clean).toMatchObject({ exit_code: 0, stale_workspace: false, workspace: { branch: 'main' } });
    const moved = await runVerify({ spec: { id: 'v', argv: ['true'], timeout: 10 }, worktree: r, expectFingerprint: 'deadbeef:00' });
    expect(moved.stale_workspace).toBe(true);
    const writes = await runVerify({ spec: { id: 'v', argv: ['sh', '-c', 'echo x > new.txt'], timeout: 10 }, worktree: r, expectFingerprint: fp });
    expect(writes).toMatchObject({ exit_code: 0, stale_workspace: true, workspace_fingerprint: fp });
  });

  it('a timeout kills the tree and reports timed_out; output is bounded to the tail', async () => {
    const r = repo();
    const started = Date.now();
    const out = await runVerify({ spec: { id: 'v', argv: ['sh', '-c', 'sleep 30 & sleep 30'], timeout: 30 }, worktree: r, timeoutMs: 150, killGraceMs: 100 });
    expect(out.timed_out).toBe(true);
    expect(Date.now() - started).toBeLessThan(5000);
    const big = await runVerify({ spec: { id: 'v', argv: ['sh', '-c', 'i=0; while [ $i -lt 2000 ]; do echo line-$i; i=$((i+1)); done'], timeout: 10 }, worktree: r, tailChars: 100 });
    expect(big.tail.length).toBeLessThanOrEqual(100);
    expect(big.truncated).toBe(true);
    expect(big.tail).toContain('line-1999');
  });
});
