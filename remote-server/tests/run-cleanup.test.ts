import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { Dispatch, surfFor } from '../src/dispatch';
import { Hub } from '../src/hub';
import { Registry } from '../src/registry';
import { QuestionBroker } from '../src/questions-claude';
import { fakeSpawner, ManualTimers } from './helpers';
import { commandShapeError, STAGE_F_CAPS, type CommandBody, type RunCleanupCommand } from '../../src/shared/eridani-link-protocol';
import type { WorktreeManager } from '../src/worktrees';
import type { ExecutionTarget } from '../src/eridani-targets';
import type { HarnessRequest, RuntimeAdapter } from '../src/managed-harness';

class Adapter extends EventEmitter implements RuntimeAdapter {
  stops = 0; exits = true;
  async start() { return 'conversation'; } async resume() { return this.start(); }
  async send() {} async interrupt() {} async respond(_request: HarnessRequest, _response: unknown) {}
  async stop() { this.stops++; if (this.exits) this.emit('exit', 0); }
}
const folders: string[] = [];
afterEach(() => { for (const folder of folders.splice(0)) fs.rmSync(folder, { recursive: true, force: true }); });
function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-cleanup-')); folders.push(dir);
  const worktree = path.join(dir, 'worktree'); fs.mkdirSync(worktree); fs.writeFileSync(path.join(worktree, 'keep.txt'), 'work'); fs.writeFileSync(path.join(dir, 'provider-conversation.json'), 'history');
  const registry = Registry.load({ file: path.join(dir, 'registry.json'), bootId: 'boot' });
  const native = fakeSpawner(), adapters: Adapter[] = [];
  const hub = new Hub({ registry, spawn: native.spawn, bootId: 'boot', serverId: 'host', timers: new ManualTimers(), probe: () => ({}) });
  const target: ExecutionTarget = { id: 'repo', repo: dir, worktreeRoot: dir, base: 'main', launch: { codex: {} }, verify: [] };
  const questions = new QuestionBroker({ session: id => registry.session(id), canHold: () => false, emit: () => {}, needsYou: () => {} });
  const dispatch = new Dispatch({ hub, registry, dir, worktrees: { ensure: async (_target: unknown, branch: string) => ({ path: worktree, branch, base: 'main', baseSha: null, created: false }) } as unknown as WorktreeManager, targets: () => [target], questions, emit: () => {}, linkReady: () => true, managedFactory: () => { const adapter = new Adapter(); adapters.push(adapter); return adapter; }, timing: { killWaitMs: 10 } });
  hub.setEridani(dispatch.hubHooks());
  const execute = async (command: Record<string, unknown>) => {
    const precheck = dispatch.precheck(command as CommandBody); if (precheck) return { state: 'rejected', detail: precheck };
    return dispatch.handlers()[String(command.t)](command as CommandBody, { begin: () => {} });
  };
  const spawn = async (attempt: number, generation = 1, role: 'planner' | 'reviewer' | 'worker' = 'worker', managed = true) => {
    const result = await execute({ t: 'spawn', op_id: `spawn-${attempt}`, digest: 'd', run_id: 'run', generation, attempt, harness: 'codex', model: 'actual', target: { id: 'repo', branch: 'task/test' }, role, ...(role !== 'worker' ? { mode: role === 'reviewer' ? 'review' : 'plan' } : {}), ...(managed ? { execution: 'managed' } : {}), share: true, prompt: 'Work', expires_at: 0 });
    expect(result.state).toBe('executed'); return { surf: surfFor('run', generation, attempt), incarnation: 1, generation };
  };
  const cleanup = (surfaces: RunCleanupCommand['surfaces'], generation = 3) => ({ t: 'run.cleanup', op_id: 'cleanup', digest: 'd', run_id: 'run', generation, terminal_state: 'completed', surfaces, expires_at: 0 });
  return { dir, worktree, registry, native, adapters, hub, dispatch, execute, spawn, cleanup };
}

describe('explicit final-run terminal cleanup', () => {
  it('closes all exact role surfaces after confirmed managed exit, retaining worktree and conversation history', async () => {
    const f = setup(); const planner = await f.spawn(1, 1, 'planner'), reviewer = await f.spawn(2, 1, 'reviewer'), worker = await f.spawn(3, 3);
    const result = await f.execute(f.cleanup([planner, reviewer, worker]));
    expect(result).toMatchObject({ state: 'executed', result: { surfaces: [ { ...planner, status: 'closed' }, { ...reviewer, status: 'closed' }, { ...worker, status: 'closed' } ] } });
    expect(f.registry.sessions()).toHaveLength(0); expect(f.adapters.map(adapter => adapter.stops)).toEqual([1, 1, 1]);
    expect(fs.existsSync(path.join(f.worktree, 'keep.txt'))).toBe(true); expect(fs.existsSync(path.join(f.dir, 'provider-conversation.json'))).toBe(true); expect(fs.readdirSync(path.join(f.dir, 'managed'))).toHaveLength(3);
    expect(await f.execute(f.cleanup([planner, reviewer, worker]))).toMatchObject({ result: { surfaces: [{ status: 'already_closed' }, { status: 'already_closed' }, { status: 'already_closed' }] } });
    expect(f.adapters.map(adapter => adapter.stops)).toEqual([1, 1, 1]);
  });
  it('keeps waiting/planning/paused sessions until explicit terminal cleanup; protects live takeover but removes exited takeover windows', async () => {
    const f = setup(), surface = await f.spawn(1, 1, 'planner');
    await f.execute({ t: 'run.pause', op_id: 'pause', digest: 'd', run_id: 'run', generation: 1, surf: surface.surf, incarnation: 1, expires_at: 0 });
    expect(f.registry.session(surface.surf)).toBeDefined(); expect(f.adapters[0].stops).toBe(0);
    f.registry.updateSession(surface.surf, { eridani: { ...f.registry.session(surface.surf)!.eridani!, controller: 'terminal' } });
    expect(await f.execute(f.cleanup([surface]))).toMatchObject({ result: { surfaces: [{ status: 'operator_control' }] } }); expect(f.adapters[0].stops).toBe(0);
    f.adapters[0].emit('exit', 0); expect(await f.execute(f.cleanup([surface]))).toMatchObject({ result: { surfaces: [{ status: 'closed' }] } });
  });
  it('refuses wrong run, generation or incarnation and never removes unknown or newly rebound sessions', async () => {
    const f = setup(), surface = await f.spawn(1);
    for (const changed of [{ ...surface, incarnation: 2 }, { ...surface, generation: 0 }]) expect(await f.execute(f.cleanup([changed]))).toMatchObject({ result: { surfaces: [{ status: 'stale' }] } });
    expect(await f.execute({ ...f.cleanup([surface]), run_id: 'other' })).toMatchObject({ result: { surfaces: [{ status: 'stale' }] } });
    expect(await f.execute(f.cleanup([{ surf: 'not-known', incarnation: 1, generation: 1 }]))).toMatchObject({ result: { surfaces: [{ status: 'unknown' }] } });
    expect(f.registry.session(surface.surf)).toBeDefined(); expect(f.adapters[0].stops).toBe(0);
  });
  it('stops a legacy native owned process and only closes after its actual exit; leaves unconfirmed processes for review', async () => {
    const f = setup(), native = await f.spawn(1, 1, 'worker', false);
    const pty = f.native.last(), kill = pty.kill.bind(pty); pty.kill = (signal) => { kill(signal); pty.exit(0); };
    expect(await f.execute(f.cleanup([native]))).toMatchObject({ result: { surfaces: [{ status: 'closed' }] } }); expect(pty.killed).not.toHaveLength(0);
    const managed = await f.spawn(2); f.adapters[0].exits = false;
    expect(await f.execute(f.cleanup([managed]))).toMatchObject({ result: { surfaces: [{ status: 'stop_failed' }] } }); expect(f.registry.session(managed.surf)).toBeDefined();
  });
  it('closes only the exact retired planner after a distinct worker is established, preserving the active worker', async () => {
    const f = setup(), planner = await f.spawn(1, 1, 'planner'), worker = await f.spawn(2, 2);
    const command = { t: 'run.cleanup', op_id: 'handoff-cleanup', digest: 'd', run_id: 'run', generation: 2, scope: 'retired_planner', surfaces: [planner], handoff_to: worker, expires_at: 0 };
    expect(commandShapeError(command)).toBeNull(); expect(STAGE_F_CAPS).toContain('run.cleanup.handoff');
    expect(await f.execute(command)).toMatchObject({ state: 'executed', result: { scope: 'retired_planner', handoff_to: worker, surfaces: [{ ...planner, status: 'closed' }] } });
    expect(f.registry.session(worker.surf)).toBeDefined(); expect(f.hub.isLive(worker.surf)).toBe(true); expect(f.adapters.map(adapter => adapter.stops)).toEqual([1, 0]);
    expect(fs.existsSync(path.join(f.worktree, 'keep.txt'))).toBe(true); expect(fs.existsSync(path.join(f.dir, 'provider-conversation.json'))).toBe(true);
    expect(await f.execute(command)).toMatchObject({ result: { surfaces: [{ status: 'already_closed' }] } }); expect(f.adapters[1].stops).toBe(0);
  });
  it('retains the planner if the worker has failed, is not attached, or its exact binding changed', async () => {
    const f = setup(), planner = await f.spawn(1, 1, 'planner'), worker = await f.spawn(2, 2);
    const command = { t: 'run.cleanup', op_id: 'handoff-cleanup', digest: 'd', run_id: 'run', generation: 2, scope: 'retired_planner', surfaces: [planner], handoff_to: worker, expires_at: 0 };
    expect(await f.execute({ ...command, handoff_to: { ...worker, incarnation: 3 } })).toMatchObject({ result: { surfaces: [{ status: 'stale' }] } });
    f.registry.updateSession(worker.surf, { agent: undefined }); expect(await f.execute(command)).toMatchObject({ result: { surfaces: [{ status: 'stale' }] } });
    f.adapters[1].emit('exit', 1); expect(await f.execute(command)).toMatchObject({ result: { surfaces: [{ status: 'stale' }] } });
    expect(f.registry.session(planner.surf)).toBeDefined(); expect(f.adapters[0].stops).toBe(0);
  });
  it('never uses planner handoff authorization to close the worker or a live manual planner', async () => {
    const f = setup(), planner = await f.spawn(1, 1, 'planner'), worker = await f.spawn(2, 2);
    const command = { t: 'run.cleanup', op_id: 'handoff-cleanup', digest: 'd', run_id: 'run', generation: 2, scope: 'retired_planner', surfaces: [planner], handoff_to: worker, expires_at: 0 };
    f.registry.updateSession(planner.surf, { eridani: { ...f.registry.session(planner.surf)!.eridani!, controller: 'terminal' } });
    expect(await f.execute(command)).toMatchObject({ result: { surfaces: [{ status: 'operator_control' }] } });
    expect(commandShapeError({ ...command, surfaces: [worker] })).toBe('bad planner handoff fence'); expect(commandShapeError({ ...command, terminal_state: 'completed' })).toBe('bad planner handoff fence');
    expect(await f.execute({ ...command, surfaces: [worker], handoff_to: planner })).toMatchObject({ result: { surfaces: [{ status: 'stale' }] } }); expect(f.adapters.map(adapter => adapter.stops)).toEqual([0, 0]);
  });

  it('reports the actual stop generation for both managed and native bindings instead of guessing from the command', async () => {
    const managed = setup(), surface = await managed.spawn(1);
    const stop = { t: 'stop', op_id: 'stop', digest: 'd', run_id: 'run', surf: surface.surf, incarnation: 1, generation: 3, mode: 'kill', expires_at: Date.now() + 30_000 };
    expect(await managed.execute(stop)).toMatchObject({ state: 'executed', result: { surf: surface.surf, incarnation: 1, generation: 1, exited: true } });
    const native = setup(), nativeSurface = await native.spawn(1, 1, 'worker', false), pty = native.native.last(), kill = pty.kill.bind(pty); pty.kill = signal => { kill(signal); pty.exit(0); };
    expect(await native.execute({ ...stop, surf: nativeSurface.surf })).toMatchObject({ state: 'executed', result: { surf: nativeSurface.surf, incarnation: 1, generation: 3, exited: true } });
  });
  it('reports positive run binding generation on status and actual exit without a reconnect', async () => {
    const f = setup(), surface = await f.spawn(1); const statuses: unknown[] = [], exits: unknown[] = [];
    f.hub.setSink({ status: value => statuses.push(value), exit: value => exits.push(value), turn: () => {} });
    f.registry.updateSession(surface.surf, { eridani: { ...f.registry.session(surface.surf)!.eridani!, generation: 4 } });
    f.hub.agentState.report(surface.surf, { runDepth: 1 }); f.adapters[0].emit('exit', 0);
    expect(statuses.at(-1)).toMatchObject({ surf: surface.surf, incarnation: 1, run_id: 'run', generation: 4, state: 'exited' });
    expect(exits.at(-1)).toMatchObject({ surf: surface.surf, incarnation: 1, run_id: 'run', generation: 4, code: 0 });
  });

  it('reconciles cleanup after restart only from tombstones, actual exits or the exact persisted stop intent', async () => {
    const f = setup(), surface = await f.spawn(1); const command = f.cleanup([surface]);
    f.registry.updateSession(surface.surf, { state: 'lost', eridani: { ...f.registry.session(surface.surf)!.eridani!, stopRequested: { at: 1, op: 'cleanup', mode: 'kill' } } });
    f.hub.sessions.delete(surface.surf);
    expect(f.dispatch.recover({ op_id: 'cleanup', digest: 'd', t: 'run.cleanup', state: 'executing', body: command, at: 1, updatedAt: 1 })).toMatchObject({ state: 'executed', outcome: { surfaces: [{ status: 'closed' }] } });
    expect(f.dispatch.recover({ op_id: 'cleanup', digest: 'd', t: 'run.cleanup', state: 'executing', body: command, at: 1, updatedAt: 1 })).toMatchObject({ outcome: { surfaces: [{ status: 'already_closed' }] } });
  });
  it('admits only explicit terminal states and unique exact surface tuples', () => {
    const f = setup(), body = f.cleanup([{ surf: 's', incarnation: 1, generation: 1 }]); expect(STAGE_F_CAPS).toContain('run.cleanup'); expect(commandShapeError(body)).toBeNull();
    expect(commandShapeError({ ...body, terminal_state: 'waiting_answer' })).toBe('bad terminal_state'); expect(commandShapeError({ ...body, surfaces: [...body.surfaces, ...body.surfaces] })).toBe('duplicate cleanup surface'); expect(commandShapeError({ ...body, generation: 0 })).toBe('bad cleanup fence');
  });
});
