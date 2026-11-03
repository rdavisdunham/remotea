import fs from 'fs';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';
import { afterEach, describe, expect, it } from 'vitest';
import { Hub } from '../src/hub';
import { Registry } from '../src/registry';
import { Dispatch, launchCommand, resumeLine, surfFor, type DispatchDeps } from '../src/dispatch';
import type { HarnessRequest, HarnessSpec, RuntimeAdapter } from '../src/managed-harness';
import { QuestionBroker } from '../src/questions-claude';
import type { CommandContext, CommandResult } from '../src/eridani-link';
import type { ExecutionTarget } from '../src/eridani-targets';
import type { WorktreeManager } from '../src/worktrees';
import type { CommandBody } from '../../src/shared/eridani-link-protocol';
import { commandShapeError } from '../../src/shared/eridani-link-protocol';
import { FakePty, fakeSpawner, ManualTimers } from './helpers';

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

function setup(opts: { registry?: Registry; dir?: string | null; linkReady?: boolean; bootId?: string; silentAgent?: boolean; wt?: Record<string, unknown>; managedFactory?: DispatchDeps['managedFactory']; managedSupported?: DispatchDeps['managedSupported'] } = {}) {
  const registry = opts.registry ?? Registry.load({ file: null, bootId: 'boot-1' });
  const sp = fakeSpawner();
  const hub = new Hub({ registry, spawn: sp.spawn, bootId: opts.bootId ?? 'boot-1', serverId: 'srv', hostname: 'box', timers: new ManualTimers(), probe: () => ({}) });
  const ensured: Array<{ branch: string; base: string }> = [];
  const worktrees = {
    ensure: async (t: ExecutionTarget, branch: string, base: string) => {
      ensured.push({ branch, base });
      return { path: `${t.worktreeRoot}/${branch.replace(/\//g, '--')}`, branch, base, baseSha: 'abc123', created: true, ...opts.wt };
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
    managedFactory: opts.managedFactory,
    managedSupported: opts.managedSupported,
    managedEmit: (body) => emitted.push(body),
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
    // The launched agent reports its session through its SessionStart hook (M7: input waits for it).
    if (cmd.t === 'spawn' && res.state === 'executed' && !opts.silentAgent) agentUp(String((res.result as { surf: string }).surf));
    return { ...res, began };
  };
  const agentUp = (surf: string, provider?: string) => hub.relayRpc(surf, 'hook.event', { event: 'SessionStart', sessionId: 'sess-1', ...(provider ? { provider } : {}) });
  return { hub, registry, sp, dispatch, run, ensured, emitted, verified, agentUp, setReady: (v: boolean) => (ready = v) };
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

class FakeManagedAdapter extends EventEmitter implements RuntimeAdapter {
  inputs: string[] = [];
  responses: Array<{ request: HarnessRequest; response: unknown }> = [];
  interrupted = 0;
  async start() { return 'managed-provider-session'; }
  async resume() { return this.start(); }
  async send(text: string) { this.inputs.push(text); }
  async sendDirect(text: string, _id: string, context: {turnId:string|null}) { this.inputs.push(text); return {turnId:context.turnId,providerAcknowledged:true}; }
  async interrupt() { this.interrupted++; }
  async respond(request: HarnessRequest, response: unknown) { this.responses.push({ request, response }); }
  async stop() {}
  complete() { this.emit('event', { method: 'turn/completed', params: { threadId: 'managed-provider-session', turn: { id: 'turn-managed', status: 'completed' } } }); }
}

describe('dispatch: managed integration', () => {
  function managedSetup() {
    const adapter = new FakeManagedAdapter();
    const specifications: HarnessSpec[] = [];
    const fixture = setup({ silentAgent: true, managedFactory: spec => { specifications.push(spec); return adapter; } });
    return { ...fixture, adapter, specifications };
  }
  const managedSpawn = () => spawnCmd({ execution: 'managed', harness: 'codex', model: 'gpt-6.1-sol', effort: 'xhigh', permission_profile: 'read-only', mode: 'plan', role: 'planner' });
  const input = (op_id: string, text: string) => ({ t: 'input', op_id, digest: 'd', surf: surfFor('run-1', 1, 1), incarnation: 1, run_id: 'run-1', generation: 1, mode: 'queue', text, durable: true, expires_at: 0 });

  it('delivers busy native direct input and revisioned human hold without interruption',async()=>{
    const {run,dispatch,adapter}=managedSetup();await run(managedSpawn());const surf=surfFor('run-1',1,1);await dispatch.managed.ready(surf);
    expect(await run({...input('direct-note','literal note'),mode:'direct',origin:'human',automation_hold:true,automation_hold_revision:1})).toMatchObject({state:'executed',result:{receipt:'handed_to_harness',provider_ack:'confirmed',generation:1}});
    expect(adapter.inputs.at(-1)).toBe('literal note');expect(adapter.interrupted).toBe(0);
    expect(dispatch.hubHooks().snapshot!(surf)).toMatchObject({automation_hold:true,automation_hold_revision:1});
    expect(await run({...input('stale-auto','automatic'),origin:'automation',automation_hold_revision:0})).toMatchObject({state:'rejected',began:false});
    expect(await run({t:'automation.hold',op_id:'release',digest:'d',run_id:'run-1',generation:1,held:false,automation_hold_revision:2,origin:'human',expires_at:0})).toMatchObject({state:'executed',result:{automation_hold:false,automation_hold_revision:2}});
  });
  it('preserves older offline human sends after the newest hold snapshot while rejecting stale automation',async()=>{
    const {run,dispatch,adapter}=managedSetup();await run(managedSpawn());const surf=surfFor('run-1',1,1);await dispatch.managed.ready(surf);
    dispatch.applyRunsSnapshot([{run_id:'run-1',generation:1,desired:'continue',automation_hold:true,automation_hold_revision:3}]);
    expect(await run({t:'automation.hold',op_id:'old-hold',digest:'d',run_id:'run-1',generation:1,held:true,automation_hold_revision:2,origin:'human',expires_at:0})).toMatchObject({state:'executed',result:{automation_hold_revision:3}});
    for(const revision of [2,3]) expect(await run({...input('human-'+revision,'note '+revision),mode:'direct',origin:'human',automation_hold:true,automation_hold_revision:revision})).toMatchObject({state:'executed'});
    expect(adapter.inputs.slice(-2)).toEqual(['note 2','note 3']);expect(dispatch.managed.automation.get('run-1').revision).toBe(3);
  });
  it('holds a run before any surface exists and refuses automatic spawn before worktree effects',async()=>{
    const {run,dispatch,ensured}=managedSetup();expect(await run({t:'automation.hold',op_id:'hold',digest:'d',run_id:'run-1',generation:1,held:true,automation_hold_revision:1,origin:'human',expires_at:0})).toMatchObject({state:'executed'});
    expect(await run({...managedSpawn(),origin:'automation',automation_hold_revision:0})).toMatchObject({state:'rejected',began:false});expect(ensured).toHaveLength(0);
    expect(dispatch.managed.automation.get('run-1')).toMatchObject({held:true,revision:1});
  });

  it('launches through the structured adapter with role options and no native terminal writer', async () => {
    const { run, dispatch, sp, registry, adapter, specifications } = managedSetup();
    const result = await run(managedSpawn());
    expect(result.state).toBe('executed');
    const surf = surfFor('run-1', 1, 1);
    await dispatch.managed.ready(surf);
    expect(sp.ptys).toHaveLength(0);
    expect(specifications[0]).toMatchObject({ harness: 'codex', model: 'gpt-6.1-sol', effort: 'xhigh', profile: 'read-only' });
    expect(registry.session(surf)?.eridani).toMatchObject({ execution: 'managed', controller: 'eridani' });
    expect(adapter.inputs).toHaveLength(1);
    adapter.complete();
    expect(await run(input('managed-input-1', 'Follow up'))).toMatchObject({ state: 'executed', result: { surf, incarnation: 1, generation: 1, managed: true } });
    expect(adapter.inputs).toEqual([expect.any(String), 'Follow up']);
    adapter.complete();
    expect(await run(input('managed-input-1', 'Follow up'))).toMatchObject({ state: 'executed', result: { surf, incarnation: 1, generation: 1, managed: true } });
    expect(adapter.inputs).toHaveLength(2);
  });

  it('tracks independent plan revision through spawn, input and reconciliation with no verify configuration', async () => {
    const { run, dispatch, adapter, registry, emitted } = managedSetup();
    await run({ ...managedSpawn(), plan_revision: 1 }); const surf = surfFor('run-1', 1, 1);
    expect(registry.session(surf)?.eridani).toMatchObject({ planRevision: 1 }); expect(registry.session(surf)?.eridani?.verify).toBeUndefined();
    adapter.complete(); await run({ ...input('next-plan', 'Read the new plan context'), plan_revision: 2 }); expect(registry.session(surf)?.eridani?.planRevision).toBe(2);
    adapter.complete(); dispatch.applyRunsSnapshot([{ run_id: 'run-1', generation: 1, desired: 'continue', surf, plan_revision: 3 }]);
    adapter.emit('event', { id: 'plan-context-approval', method: 'item/commandExecution/requestApproval', params: { threadId: 'managed-provider-session', turnId: 'turn-managed', itemId: 'tool-plan', command: 'npm test', cwd: '/repo' } });
    const question = emitted.filter((event) => event.t === 'question').at(-1)!; expect(question.plan_revision).toBe(3);
    expect((await run({ t: 'answer', op_id: 'answer-plan-context', digest: 'd', question_id: question.question_id, provider_request_id: question.provider_request_id, surf, incarnation: 1, run_id: 'run-1', generation: 1, plan_revision: 3, request_digest: question.request_digest, answers: [{ item_id: 'approval', choice_ids: ['deny'] }], expires_at: 0 })).state).toBe('executed');
  });

  it('keeps queued follow-ups until a busy managed agent finishes', async () => {
    const { run, dispatch, adapter } = managedSetup();
    await run(managedSpawn());
    await dispatch.managed.ready(surfFor('run-1', 1, 1));
    let settled = false;
    const delivery = run(input('managed-queued-1', 'Please review the tests too')).then(result => { settled = true; return result; });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(adapter.inputs).toHaveLength(1);
    expect(settled).toBe(false);
    adapter.complete();
    expect(await delivery).toMatchObject({ state: 'executed' });
    expect(adapter.inputs.at(-1)).toBe('Please review the tests too');
  });

  it('persists pause separately, and preserves a pending approval without interrupting its callback', async () => {
    const { run, dispatch, adapter, registry, emitted } = managedSetup();
    await run(managedSpawn());
    const surf = surfFor('run-1', 1, 1);
    await dispatch.managed.ready(surf);
    adapter.emit('event', { id: 'provider-approval', method: 'item/commandExecution/requestApproval', params: { threadId: 'managed-provider-session', turnId: 'turn-managed', itemId: 'tool-1', command: 'npm test', cwd: '/repo' } });
    expect(emitted.some(event => event.t === 'question' && event.durable === true)).toBe(true);
    expect(await run({ ...input('pause-1', ''), t: 'run.pause' })).toMatchObject({ state: 'executed' });
    expect(registry.session(surf)?.eridani?.paused).toBe(true);
    expect(adapter.interrupted).toBe(0);
    expect(dispatch.managed.pending(surf)).toHaveLength(1);
    expect(await run({ ...input('resume-1', ''), t: 'run.resume' })).toMatchObject({ state: 'executed' });
    expect(registry.session(surf)?.eridani?.paused).toBe(false);
    expect(dispatch.managed.pending(surf)).toHaveLength(1);
  });
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

  it('a reused branch behind its base gets a merge-first note at the top of the prompt, with the migration re-point when one is reserved', async () => {
    const { run, sp, registry } = setup({ wt: { created: false, baseRef: 'origin/main', fetch: { ok: true }, behind: 3, ahead: 2 } });
    const res = await run(spawnCmd({ migration: { number: 34, dir: 'migrations/versions' } }));
    expect(res.result).toMatchObject({ base_ref: 'origin/main', fetch: { ok: true }, behind: 3, ahead: 2 });
    const prompt = String(sp.last().req.env?.ERIDANI_PROMPT);
    expect(prompt.startsWith('Your branch eri/task-1 is 3 commit(s) behind origin/main. Before touching code, merge origin/main into it')).toBe(true);
    expect(prompt).toContain('reserved number 0034');
    expect(prompt).toContain('re-point its down_revision at the current chain head in migrations/versions');
    expect(prompt.endsWith(spawnCmd().prompt)).toBe(true);
    expect(registry.session(surfFor('run-1', 1, 1))!.eridani).toMatchObject({ baseRef: 'origin/main', behind: 3 });
  });

  it('a failed fetch warns that the base may be stale; an up-to-date worktree adds nothing', async () => {
    const stale = setup({ wt: { baseRef: 'main', fetch: { ok: false, error: 'could not read from remote' }, behind: 0, ahead: 0 } });
    expect((await stale.run(spawnCmd())).result).toMatchObject({ fetch: { ok: false, error: 'could not read from remote' } });
    expect(String(stale.sp.last().req.env?.ERIDANI_PROMPT)).toMatch(/^Could not fetch origin\/main \(could not read from remote\); this worktree is based on local main @ abc123, which may be stale\./);
    const fresh = setup({ wt: { baseRef: 'origin/main', fetch: { ok: true }, behind: 0, ahead: 0 } });
    await fresh.run(spawnCmd({ migration: { number: 34, dir: 'migrations/versions' } }));
    expect(fresh.sp.last().req.env?.ERIDANI_PROMPT).toBe(spawnCmd().prompt);
  });

  it('a spawn may carry a reserved migration; a malformed one fails the shape check', () => {
    expect(commandShapeError(spawnCmd({ migration: { number: 34, dir: 'migrations/versions' } }))).toBeNull();
    expect(commandShapeError(spawnCmd({ migration: null }))).toBeNull();
    expect(commandShapeError(spawnCmd({ migration: { number: 0, dir: 'm' } }))).toBe('bad migration');
    expect(commandShapeError(spawnCmd({ migration: { number: 3, dir: 'a\nb' } }))).toBe('bad migration');
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

  it('a queued input whose begin() throws fails alone: nothing is typed, and the input behind it is still delivered', async () => {
    const { run, hub, sp, dispatch } = setup();
    await run(spawnCmd());
    const pty = sp.last();
    const surf = surfFor('run-1', 1, 1);
    hub.agentState.report(surf, { runDepth: 1 });
    const h = dispatch.handlers();
    const first = h.input({ t: 'input', mode: 'queue', text: 'first', ...fence({ op_id: 'op-a' }) } as CommandBody, {
      begin: () => {
        throw new Error('journal_unavailable (write failed: ENOSPC)');
      },
    });
    let began = false;
    const second = h.input({ t: 'input', mode: 'queue', text: 'second', ...fence({ op_id: 'op-b' }) } as CommandBody, { begin: () => (began = true) });
    await new Promise((r) => setTimeout(r, 10));
    hub.agentState.report(surf, { runDepth: 0 });
    expect(await first).toMatchObject({ state: 'failed', detail: expect.stringContaining('not delivered: journal_unavailable') });
    // The tick rescheduled itself: the next input goes out once the agent is (still) idle.
    expect(await second).toMatchObject({ state: 'executed' });
    expect(began).toBe(true);
    await until(() => pty.written.includes('\r'));
    const typed = pty.written.join('');
    expect(typed).toContain('second');
    expect(typed).not.toContain('first');
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
  it('defers managed boot recovery until readiness and refuses an unverified launcher without native fallback', async () => {
    const dir = tmpDir(), file = path.join(dir, 'registry.json');
    const first = setup({ registry: Registry.load({ file, bootId: 'boot-1' }), dir, silentAgent: true, managedFactory: () => new FakeManagedAdapter() });
    await first.run(spawnCmd({ execution: 'managed', harness: 'codex' })); first.registry.saveNow();
    let factories = 0;
    const second = setup({ registry: Registry.load({ file, bootId: 'boot-2' }), dir, bootId: 'boot-2', managedSupported: () => false, managedFactory: () => { factories++; return new FakeManagedAdapter(); } });
    const surf = surfFor('run-1', 1, 1);
    second.dispatch.resumeOnBoot({ includeManaged: false }); expect(second.registry.session(surf)!.state).toBe('lost');
    second.dispatch.resumeOnBoot({ onlyManaged: true }); expect(second.registry.session(surf)!.state).toBe('exited');
    expect(factories).toBe(0); expect(second.sp.ptys).toHaveLength(0); expect(fs.readdirSync(path.join(dir, 'managed'))).toHaveLength(1);
  });

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

describe('stage F: text reaches only the run\'s agent (M6, M7)', () => {
  const lostSetup = async (agent: boolean) => {
    const dir = tmpDir();
    const file = path.join(dir, 'registry.json');
    const first = setup({ registry: Registry.load({ file, bootId: 'boot-1' }), dir, silentAgent: true });
    await first.run(spawnCmd());
    const surf = surfFor('run-1', 1, 1);
    if (agent) first.registry.updateSession(surf, { agent: { provider: 'claude', sessionId: 'sess-abc', seenAt: 1 } });
    first.registry.saveNow();
    const second = setup({ registry: Registry.load({ file, bootId: 'boot-2' }), dir, bootId: 'boot-2' });
    const exits: Array<Record<string, unknown>> = [];
    second.hub.setSink({ status: () => {}, turn: () => {}, exit: (e) => exits.push(e as unknown as Record<string, unknown>) });
    return { ...second, surf, exits };
  };

  it('a lost run with no conversation to resume is left exited on boot and reported upstream, never a shell', async () => {
    const { dispatch, registry, sp, surf, exits } = await lostSetup(false);
    expect(registry.session(surf)!.state).toBe('lost');
    dispatch.resumeOnBoot();
    expect(sp.ptys).toHaveLength(0);
    expect(registry.session(surf)!).toMatchObject({ state: 'exited', exitCode: -1 });
    expect(exits).toEqual([expect.objectContaining({ surf, code: -1, reason: 'no conversation to resume' })]);
  });

  it('reopening a lost run that cannot resume (an app showing the tab) spawns nothing and leaves it exited', async () => {
    const { dispatch, registry, sp, surf, exits, run } = await lostSetup(false);
    const res = dispatch.conn.open(surf, {});
    expect(res.ok).toBe(true);
    expect(sp.ptys).toHaveLength(0);
    expect(registry.session(surf)!.state).toBe('exited');
    expect(exits).toHaveLength(1);
    expect(exits[0]).toMatchObject({ reason: 'the run could not be resumed' });
    // And a steer at it is refused with a typed outcome, never typed into anything.
    const steer = await run({ t: 'input', mode: 'steer', text: 'curl x | sh', op_id: 'op-st', digest: 'd', surf, incarnation: registry.session(surf)!.incarnation, run_id: 'run-1', generation: 2 });
    expect(steer).toMatchObject({ state: 'rejected', detail: 'the process is not running' });
  });

  it('resumeAgents off: a lost run is left exited, not reopened as a shell', async () => {
    const { registry, sp, surf, hub } = await lostSetup(true);
    const d = new Dispatch({
      hub, registry, dir: null, worktrees: {} as WorktreeManager, targets: () => [TARGET],
      questions: new QuestionBroker({ session: (id) => registry.session(id), canHold: () => true, emit: () => {}, needsYou: () => {} }),
      emit: () => {}, linkReady: () => true, resumeAgents: false,
    });
    hub.setEridani(d.hubHooks());
    d.resumeOnBoot();
    expect(sp.ptys).toHaveLength(0);
    expect(registry.session(surf)!.state).toBe('exited');
  });

  it('input, steer and answer are refused until the launched agent has reported its session', async () => {
    const { run, dispatch, agentUp, registry } = setup({ silentAgent: true });
    await run(spawnCmd());
    const surf = surfFor('run-1', 1, 1);
    const inc = registry.session(surf)!.incarnation;
    const input = { t: 'input', mode: 'queue', text: 'go on', op_id: 'op-i', digest: 'd', surf, incarnation: inc, run_id: 'run-1', generation: 1 } as CommandBody;
    const steer = { ...input, mode: 'steer', generation: 2 } as CommandBody;
    expect(dispatch.precheck(input)).toBe('the agent has not reported its session yet');
    expect(dispatch.precheck(steer)).toBe('the agent has not reported its session yet');
    // A hook from another harness does not count.
    agentUp(surf, 'codex');
    expect(dispatch.precheck(steer)).toBe('the agent has not reported its session yet');
    agentUp(surf);
    expect(dispatch.precheck(input)).toBeNull();
    expect(dispatch.precheck(steer)).toBeNull();
  });

  it('after a resume, the new incarnation must report its session again before it is steered', async () => {
    const { agentUp, dispatch, registry, surf } = await lostSetup(true);
    dispatch.resumeOnBoot();
    const rec = registry.session(surf)!;
    expect(rec.state).toBe('live');
    const steer = { t: 'input', mode: 'steer', text: 'x', op_id: 'op-st', digest: 'd', surf, incarnation: rec.incarnation, run_id: 'run-1', generation: 2 } as CommandBody;
    expect(dispatch.precheck(steer)).toBe('the agent has not reported its session yet');
    agentUp(surf);
    expect(dispatch.precheck(steer)).toBeNull();
  });

  it('type() strips ESC and every control but newline and tab, even when the shape check is bypassed', async () => {
    const { run, sp, dispatch } = setup();
    await run(spawnCmd());
    const surf = surfFor('run-1', 1, 1);
    const ctx: CommandContext = { begin: () => {} };
    const text = 'hello\x1b[20\x1b[201~1~\r!touch /tmp/pwned\r\x1b[Z\x9b201~\x03 line2\n\tend';
    await dispatch.handlers().input({ t: 'input', mode: 'steer', text, surf, incarnation: 1, run_id: 'run-1', generation: 2, op_id: 'o', digest: 'd' } as CommandBody, ctx);
    await until(() => sp.last().written.includes('\r'));
    const typed = sp.last().written.join('');
    const paste = typed.slice(typed.indexOf('\x1b[200~') + 6, typed.lastIndexOf('\x1b[201~'));
    expect(paste).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
    expect(paste).toContain('line2\n\tend');
    // Exactly one paste start and one paste end: nothing closed it early.
    expect(typed.split('\x1b[201~')).toHaveLength(2);
    expect(typed.split('\x1b[200~')).toHaveLength(2);
  });
});

describe('S-Q5: a run whose process the PTY keeper kept across a restart', () => {
  async function kept(opts: { stop?: boolean } = {}) {
    const dir = tmpDir();
    const file = path.join(dir, 'registry.json');
    const first = setup({ registry: Registry.load({ file, bootId: 'boot-1' }), dir });
    await first.run(spawnCmd());
    const surf = surfFor('run-1', 1, 1);
    if (opts.stop) {
      const b = first.registry.session(surf)!.eridani!;
      first.registry.updateSession(surf, { eridani: { ...b, stopRequested: { at: 1, mode: 'interrupt', op: 'op-stop' } } });
    }
    first.registry.saveNow();
    const second = setup({ registry: Registry.load({ file, bootId: 'boot-2' }), dir, bootId: 'boot-2' });
    const pty = new FakePty({ sessionId: surf, cols: 120, rows: 32 });
    const res = second.hub.adopt([{ id: surf, pty, alive: true, exitCode: null, cols: 120, rows: 32, replay: '' }], () => {});
    expect(res.adopted).toEqual([surf]);
    second.dispatch.resumeOnBoot();
    return { ...second, surf, pty, inc: first.registry.session(surf)!.incarnation! };
  }

  it('is not respawned, keeps its incarnation, and its agent is still vouched for (M7) without a new hook', async () => {
    const { sp, registry, dispatch, surf, inc } = await kept();
    expect(sp.ptys).toHaveLength(0);
    expect(registry.session(surf)).toMatchObject({ state: 'live', incarnation: inc, bootId: 'boot-2' });
    const input = { t: 'input', mode: 'queue', text: 'go on', op_id: 'op-i', digest: 'd', surf, incarnation: inc, run_id: 'run-1', generation: 1 } as CommandBody;
    expect(dispatch.precheck(input)).toBeNull();
  });

  it('a stop requested before the restart is sent again; an executing stop is reported interrupted, not done', async () => {
    const { pty, dispatch, surf } = await kept({ stop: true });
    await until(() => pty.written.filter((w) => w === '\x03').length >= 1);
    expect(dispatch.recover({ op_id: 'op-stop', digest: 'd', t: 'stop', state: 'executing', at: 1, updatedAt: 1, body: { surf } })).toMatchObject({ state: 'failed', detail: expect.stringMatching(/outlived/) });
  });

  it('while draining, a queued input is not started; it is delivered once draining stops', async () => {
    const { run, hub, sp, dispatch } = setup();
    await run(spawnCmd());
    const surf = surfFor('run-1', 1, 1);
    const pty = sp.last();
    dispatch.setDraining(true);
    hub.agentState.report(surf, { runDepth: 1 });
    const p = run({ t: 'input', mode: 'queue', text: 'held', op_id: 'op-in', digest: 'd', surf, incarnation: 1, run_id: 'run-1', generation: 1, expires_at: Date.now() + 60_000 });
    hub.agentState.report(surf, { runDepth: 0 });
    await new Promise((r) => setTimeout(r, 30));
    expect(pty.written.join('')).not.toContain('held');
    expect(dispatch.pendingWrites()).toEqual([]);
    dispatch.setDraining(false);
    expect(await p).toMatchObject({ state: 'executed' });
  });
});
