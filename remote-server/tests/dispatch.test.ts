import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { Hub } from '../src/hub';
import { Registry } from '../src/registry';
import { Dispatch, launchCommand, resumeLine, surfFor } from '../src/dispatch';
import { QuestionBroker } from '../src/questions-claude';
import type { CommandContext, CommandResult } from '../src/eridani-link';
import type { ExecutionTarget } from '../src/eridani-targets';
import type { WorktreeManager } from '../src/worktrees';
import type { CommandBody } from '../../src/shared/eridani-link-protocol';
import { fakeSpawner, ManualTimers } from './helpers';

const cleanups: Array<() => unknown> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-'));
  cleanups.push(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 2));
  }
}

const TARGET: ExecutionTarget = {
  id: 'proj',
  repo: '/repo',
  worktreeRoot: '/wt',
  base: 'main',
  launch: { claude: {}, codex: { bin: '/opt/codex' } },
  verify: [{ id: 'test', argv: ['npm', 'test'], timeout: 60 }],
};

const FAST = { queuePollMs: 2, pasteEnterMs: 1, steerDelayMs: 1, ctrlCGapMs: 1, ctrlCRetryMs: 5, stopWaitMs: 60, killWaitMs: 60 };

function setup(opts: { registry?: Registry; dir?: string | null; linkReady?: boolean; bootId?: string } = {}) {
  const registry = opts.registry ?? Registry.load({ file: null, bootId: 'boot-1' });
  const sp = fakeSpawner();
  const hub = new Hub({ registry, spawn: sp.spawn, bootId: opts.bootId ?? 'boot-1', serverId: 'srv', hostname: 'box', timers: new ManualTimers(), probe: () => ({}) });
  const ensured: Array<{ branch: string; base: string }> = [];
  const worktrees = {
    ensure: async (t: ExecutionTarget, branch: string, base: string) => {
      ensured.push({ branch, base });
      return { path: `${t.worktreeRoot}/${branch.replace(/\//g, '--')}`, branch, base, baseSha: 'abc123', created: true };
    },
  } as unknown as WorktreeManager;
  const emitted: Array<Record<string, unknown>> = [];
  const questions = new QuestionBroker({
    session: (id) => registry.session(id),
    canHold: () => true,
    emit: (b) => emitted.push(b as unknown as Record<string, unknown>),
    needsYou: () => {},
  });
  let ready = opts.linkReady ?? true;
  const verified: Array<Record<string, unknown>> = [];
  const dispatch = new Dispatch({
    hub,
    registry,
    dir: opts.dir ?? null,
    worktrees,
    targets: () => [TARGET],
    questions,
    emit: (b) => verified.push(b as unknown as Record<string, unknown>),
    linkReady: () => ready,
    timing: FAST,
    verify: async () => ({ workspace_fingerprint: 'h:x', exit_code: 0, tail: 'ok', truncated: false, duration_ms: 3, timed_out: false, canceled: false }),
  });
  hub.setEridani(dispatch.hubHooks());
  const h = dispatch.handlers();
  const run = async (cmd: Record<string, unknown>): Promise<CommandResult & { began: boolean }> => {
    const pre = dispatch.precheck(cmd as CommandBody);
    if (pre) return { state: 'rejected', detail: pre, began: false };
    let began = false;
    const ctx: CommandContext = { begin: () => (began = true) };
    const res = await h[cmd.t as string](cmd as CommandBody, ctx);
    return { ...res, began };
  };
  return { hub, registry, sp, dispatch, run, ensured, emitted, verified, setReady: (v: boolean) => (ready = v) };
}

const spawnCmd = (over: Record<string, unknown> = {}) => ({
  t: 'spawn',
  op_id: 'op-spawn-1',
  digest: 'd',
  run_id: 'run-1',
  generation: 1,
  attempt: 1,
  harness: 'claude',
  model: 'sonnet',
  target: { id: 'proj', branch: 'eri/task-1' },
  task_id: 'task-1',
  prompt: 'Fix the bug; then say "done" & $(rm -rf /)',
  env: { ERIDANI_FOO: 'bar' },
  run_token: 'tok-123',
  expires_at: Date.now() + 60_000,
  ...over,
});

describe('dispatch: spawn', () => {
  it('starts the harness in the managed worktree with only ERIDANI_* env, and records the binding', async () => {
    const { run, sp, registry, ensured } = setup();
    const res = await run(spawnCmd());
    const surf = surfFor('run-1', 1, 1);
    expect(res).toMatchObject({ state: 'executed', began: true, result: { surf, incarnation: 1, worktree: '/wt/eri--task-1', branch: 'eri/task-1', base: 'main', base_sha: 'abc123' } });
    expect(ensured).toEqual([{ branch: 'eri/task-1', base: 'main' }]);
    const req = sp.last().req;
    expect(req.sessionId).toBe(surf);
    expect(req.cwd).toBe('/wt/eri--task-1');
    // The prompt never reaches the command line: it is one argv word from the environment.
    expect(req.cmd).toBe(`'claude' --model 'sonnet' --permission-mode auto "$ERIDANI_PROMPT"`);
    expect(req.cmd).not.toContain('rm -rf');
    expect(req.env).toMatchObject({ ERIDANI_PROMPT: spawnCmd().prompt, ERIDANI_FOO: 'bar', ERIDANI_RUN_TOKEN: 'tok-123', ERIDANI_RUN_ID: 'run-1', ERIDANI_GENERATION: '1', ERIDANI_TASK_ID: 'task-1' });
    const rec = registry.session(surf)!;
    expect(rec.eridani).toMatchObject({ runId: 'run-1', generation: 1, attempt: 1, taskId: 'task-1', target: 'proj', harness: 'claude', model: 'sonnet', branch: 'eri/task-1', spawnOp: 'op-spawn-1' });
    expect(JSON.stringify(rec)).not.toContain('tok-123');
    expect(JSON.stringify(rec)).not.toContain('rm -rf');
    expect(registry.groups().find((g) => g.id === rec.groupId)?.name).toBe('Eridani');
  });

  it('is idempotent per (run, generation, attempt): a second spawn starts nothing', async () => {
    const { run, sp } = setup();
    await run(spawnCmd());
    const again = await run(spawnCmd({ op_id: 'op-spawn-2' }));
    expect(again).toMatchObject({ state: 'executed', detail: 'already started' });
    expect(sp.ptys).toHaveLength(1);
  });

  it('codex launches with daemon auto-start disabled and the target binary', () => {
    expect(launchCommand('codex', 'gpt-5', { bin: '/opt/codex' }, true)).toBe(`'/opt/codex' --disable daemon_auto_start -m 'gpt-5' "$ERIDANI_PROMPT"`);
  });

  it('refuses unknown targets, disabled harnesses, a repo mismatch and a prompt that reads as a flag', () => {
    const { dispatch } = setup();
    expect(dispatch.precheck(spawnCmd({ target: { id: 'nope', branch: 'b' } }) as CommandBody)).toMatch(/unknown execution target/);
    expect(dispatch.precheck(spawnCmd({ target: { id: 'proj', branch: 'b', repo: '/elsewhere' } }) as CommandBody)).toMatch(/repo/);
    expect(dispatch.precheck(spawnCmd({ prompt: '--dangerously-skip-permissions' }) as CommandBody)).toMatch(/may not start/);
  });

  it('keeps the run token and env out of the registry, in a 0600 runs file', async () => {
    const dir = tmpDir();
    const { run } = setup({ dir });
    await run(spawnCmd());
    const file = path.join(dir, 'eridani-runs.json');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))[surfFor('run-1', 1, 1)].env.ERIDANI_RUN_TOKEN).toBe('tok-123');
  });
});

describe('dispatch: fenced input', () => {
  const fence = (over: Record<string, unknown> = {}) => ({ op_id: 'op-in', digest: 'd', surf: surfFor('run-1', 1, 1), incarnation: 1, run_id: 'run-1', generation: 1, expires_at: Date.now() + 60_000, ...over });

  it('rejects a stale incarnation, a stale generation and another run', async () => {
    const { run, dispatch } = setup();
    await run(spawnCmd());
    expect(dispatch.precheck({ t: 'input', mode: 'queue', text: 'x', ...fence({ incarnation: 2 }) } as CommandBody)).toBe('stale incarnation');
    expect(dispatch.precheck({ t: 'input', mode: 'queue', text: 'x', ...fence({ generation: 0 }) } as CommandBody)).toBe('stale generation');
    expect(dispatch.precheck({ t: 'input', mode: 'queue', text: 'x', ...fence({ run_id: 'run-2' }) } as CommandBody)).toBe('run does not match');
    expect(dispatch.precheck({ t: 'input', mode: 'queue', text: 'x', ...fence({ surf: 'surf-nope' }) } as CommandBody)).toBe('unknown surface');
  });

  it('a queued input waits until the agent is idle and the link is up, then types a bracketed paste and Enter', async () => {
    const { run, hub, sp, setReady } = setup();
    await run(spawnCmd());
    const pty = sp.last();
    const surf = surfFor('run-1', 1, 1);
    hub.agentState.report(surf, { runDepth: 1 });
    setReady(false);
    const p = run({ t: 'input', mode: 'queue', text: 'next step', ...fence() });
    await new Promise((r) => setTimeout(r, 20));
    expect(pty.written.join('')).not.toContain('next step');
    hub.agentState.report(surf, { runDepth: 0 });
    await new Promise((r) => setTimeout(r, 20));
    // Idle, but the host is disconnected from Eridani: no continuation is invented.
    expect(pty.written.join('')).not.toContain('next step');
    setReady(true);
    const res = await p;
    expect(res).toMatchObject({ state: 'executed', began: true });
    await until(() => pty.written.includes('\r'));
    expect(pty.written.join('')).toContain('\x1b[200~next step\x1b[201~');
  });

  it('steer advances the generation first, interrupts with Esc, then types', async () => {
    const { run, sp, registry } = setup();
    await run(spawnCmd());
    const surf = surfFor('run-1', 1, 1);
    const res = await run({ t: 'input', mode: 'steer', text: 'change of plan', ...fence({ generation: 2 }) });
    expect(res.state).toBe('executed');
    expect(registry.session(surf)!.eridani!.generation).toBe(2);
    await until(() => sp.last().written.includes('\r'));
    expect(sp.last().written[0]).toBe('\x1b');
    expect(sp.last().written.join('')).toContain('change of plan');
  });

  it('a queued input of an older generation is refused when a steer supersedes it', async () => {
    const { run, hub, sp } = setup();
    await run(spawnCmd());
    const surf = surfFor('run-1', 1, 1);
    hub.agentState.report(surf, { runDepth: 1 });
    const queued = run({ t: 'input', mode: 'queue', text: 'old', ...fence() });
    await new Promise((r) => setTimeout(r, 10));
    await run({ t: 'input', mode: 'steer', text: 'new', ...fence({ op_id: 'op-steer', generation: 2 }) });
    expect(await queued).toMatchObject({ state: 'rejected' });
    expect(sp.last().written.join('')).not.toContain('old');
  });
});

describe('dispatch: stop', () => {
  const stop = (mode: 'interrupt' | 'kill', over: Record<string, unknown> = {}) => ({ t: 'stop', mode, op_id: `op-stop-${mode}`, digest: 'd', surf: surfFor('run-1', 1, 1), incarnation: 1, run_id: 'run-1', generation: 1, expires_at: Date.now() + 60_000, ...over });

  it('interrupt sends Ctrl-C twice, records stopRequested until the exit, then clears it', async () => {
    const { run, sp, registry } = setup();
    await run(spawnCmd());
    const surf = surfFor('run-1', 1, 1);
    const pty = sp.last();
    const p = run(stop('interrupt'));
    await until(() => pty.written.filter((w) => w === '\x03').length >= 2);
    expect(registry.session(surf)!.eridani!.stopRequested).toMatchObject({ mode: 'interrupt', op: 'op-stop-interrupt' });
    pty.exit(130);
    expect(await p).toMatchObject({ state: 'executed', result: { exited: true, code: 130 } });
    expect(registry.session(surf)!.eridani!.stopRequested).toBeUndefined();
  });

  it('a stop that does not end the process fails but stays requested; kill then ends it', async () => {
    const { run, sp, registry, dispatch } = setup();
    await run(spawnCmd());
    const surf = surfFor('run-1', 1, 1);
    const res = await run(stop('interrupt'));
    expect(res.state).toBe('failed');
    expect(res.detail).toMatch(/mode:kill/);
    expect(registry.session(surf)!.eridani!.stopRequested?.mode).toBe('interrupt');
    // Input is refused while a stop is pending.
    expect(dispatch.precheck({ t: 'input', mode: 'queue', text: 'x', op_id: 'o', digest: 'd', surf, incarnation: 1, run_id: 'run-1', generation: 1, expires_at: Date.now() + 1000 } as CommandBody)).toBe('stopping');
    const pty = sp.last();
    const p = run(stop('kill'));
    await until(() => pty.killed.length > 0);
    pty.exit(137);
    expect(await p).toMatchObject({ state: 'executed' });
    expect(registry.session(surf)!.eridani!.stopRequested).toBeUndefined();
  });

  it('a stopped run is never resumed', async () => {
    const { run, dispatch, registry } = setup();
    await run(spawnCmd());
    const surf = surfFor('run-1', 1, 1);
    void run(stop('interrupt'));
    const rec = { ...registry.session(surf)!, agent: { provider: 'claude' as const, sessionId: 'sess-1', seenAt: 1 } };
    expect(dispatch.hubHooks().resumeCommand!(rec)).toBeNull();
  });
});

describe('dispatch: recovery', () => {
  it('resumes a lost Eridani session on boot with its model and permission mode', async () => {
    const dir = tmpDir();
    const file = path.join(dir, 'registry.json');
    const first = setup({ registry: Registry.load({ file, bootId: 'boot-1' }), dir });
    await first.run(spawnCmd());
    const surf = surfFor('run-1', 1, 1);
    first.registry.updateSession(surf, { agent: { provider: 'claude', sessionId: 'sess-abc', seenAt: 1 } });
    first.registry.saveNow();

    const second = setup({ registry: Registry.load({ file, bootId: 'boot-2' }), dir, bootId: 'boot-2' });
    expect(second.registry.session(surf)!.state).toBe('lost');
    second.dispatch.resumeOnBoot();
    expect(second.sp.ptys).toHaveLength(1);
    expect(second.sp.last().req.cmd).toBe(`'claude' --resume 'sess-abc' --model 'sonnet' --permission-mode auto`);
    // The run's env (token included) comes back from the runs file, not the registry.
    expect(second.sp.last().req.env).toMatchObject({ ERIDANI_RUN_TOKEN: 'tok-123' });
    expect(second.registry.session(surf)!.eridani!.runId).toBe('run-1');
  });

  it('a lost session whose stop was requested is finished, not resumed', async () => {
    const dir = tmpDir();
    const file = path.join(dir, 'registry.json');
    const first = setup({ registry: Registry.load({ file, bootId: 'boot-1' }), dir });
    await first.run(spawnCmd());
    const surf = surfFor('run-1', 1, 1);
    const b = first.registry.session(surf)!.eridani!;
    first.registry.updateSession(surf, { agent: { provider: 'claude', sessionId: 's', seenAt: 1 }, eridani: { ...b, stopRequested: { at: 1, mode: 'interrupt', op: 'op-x' } } });
    first.registry.saveNow();
    const second = setup({ registry: Registry.load({ file, bootId: 'boot-2' }), dir, bootId: 'boot-2' });
    second.dispatch.resumeOnBoot();
    expect(second.sp.ptys).toHaveLength(0);
    expect(second.registry.session(surf)!.state).toBe('exited');
    expect(second.registry.session(surf)!.eridani!.stopRequested).toBeUndefined();
  });

  it('codex resumes through `codex resume` with the same flags', () => {
    const b = { harness: 'codex', model: 'gpt-5' } as Parameters<typeof resumeLine>[0];
    expect(resumeLine(b, undefined, '0199-abc')).toBe(`'codex' resume --disable daemon_auto_start -m 'gpt-5' '0199-abc'`);
    expect(resumeLine(b, undefined, 'bad id; rm')).toBeNull();
  });

  it('settles a spawn found executing after a restart by the session mapping, never by running it again', async () => {
    const { run, dispatch } = setup();
    await run(spawnCmd());
    const body = spawnCmd();
    expect(dispatch.recover({ op_id: 'op-spawn-1', digest: 'd', t: 'spawn', state: 'executing', at: 1, updatedAt: 1, body })).toMatchObject({ state: 'executed' });
    expect(dispatch.recover({ op_id: 'op-2', digest: 'd', t: 'spawn', state: 'executing', at: 1, updatedAt: 1, body: { ...body, run_id: 'run-9' } })).toMatchObject({ state: 'failed' });
    expect(dispatch.recover({ op_id: 'op-3', digest: 'd', t: 'input', state: 'executing', at: 1, updatedAt: 1 })).toBeNull();
  });

  it('runs.snapshot adopts a newer generation and carries out a desired stop', async () => {
    const { run, dispatch, registry, sp } = setup();
    await run(spawnCmd());
    const surf = surfFor('run-1', 1, 1);
    dispatch.applyRunsSnapshot([{ run_id: 'run-1', generation: 3, desired: 'stop', stop_mode: 'interrupt' }]);
    expect(registry.session(surf)!.eridani).toMatchObject({ generation: 3, stopRequested: { mode: 'interrupt' } });
    await until(() => sp.last().written.includes('\x03'));
  });
});

describe('dispatch: verify', () => {
  it('runs a configured verify id for the run and emits verify.result with the attempt tuple', async () => {
    const { run, verified } = setup();
    await run(spawnCmd());
    const res = await run({ t: 'verify', op_id: 'op-v', digest: 'd', attempt_id: 'att-1', run_id: 'run-1', generation: 1, turn_seq: 4, plan_revision: 2, verify_id: 'test', expires_at: Date.now() + 1000 });
    expect(res.state).toBe('executed');
    expect(verified[0]).toMatchObject({ t: 'verify.result', attempt_id: 'att-1', run_id: 'run-1', generation: 1, turn_seq: 4, plan_revision: 2, verify_id: 'test', exit_code: 0, workspace_fingerprint: 'h:x' });
  });

  it('refuses an unknown verify id and a stale generation', async () => {
    const { run, dispatch } = setup();
    await run(spawnCmd());
    const v = { t: 'verify', op_id: 'op-v', digest: 'd', attempt_id: 'a', run_id: 'run-1', generation: 1, turn_seq: 0, plan_revision: 0, verify_id: 'lint', expires_at: Date.now() + 1000 };
    expect(dispatch.precheck(v as CommandBody)).toMatch(/unknown verify id/);
    expect(dispatch.precheck({ ...v, verify_id: 'test', generation: 0 } as CommandBody)).toBe('stale generation');
  });
});
