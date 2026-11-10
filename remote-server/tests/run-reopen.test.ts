/**
 * `run.reopen`: Eridani's "Reopen terminal" for a run whose agent exited.
 *
 * The host respawns the exited surface IN PLACE, through the path boot
 * recovery takes for a lost one (dispatch `conn.open` → the hub's respawn →
 * `resumeCommand`): the same surf, the binding and the runs-file secrets as
 * they were, `claude --resume <session>` as the next incarnation, no prompt
 * typed. A reopen that already happened answers `executed` again; one that
 * cannot start leaves the surface exited (D4), and says why.
 */
import { EventEmitter } from 'events';
import { afterEach, describe, expect, it } from 'vitest';
import { Hub } from '../src/hub';
import { Registry } from '../src/registry';
import { Dispatch, surfFor, type DispatchDeps } from '../src/dispatch';
import { linkCaps } from '../src/eridani-runtime';
import type { HarnessRequest, RuntimeAdapter } from '../src/managed-harness';
import { QuestionBroker } from '../src/questions-claude';
import type { CommandContext, CommandResult } from '../src/eridani-link';
import type { ExecutionTarget } from '../src/eridani-targets';
import type { WorktreeManager } from '../src/worktrees';
import type { SpawnFn } from '../src/session';
import { commandShapeError, EFFECTFUL_COMMANDS, STAGE_F_AUTHORITATIVE_CAPS, STAGE_F_CAPS, type CommandBody } from '../../src/shared/eridani-link-protocol';
import { FakeConn, fakeSpawner, ManualTimers } from './helpers';

const cleanups: Array<() => unknown> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

const TARGET: ExecutionTarget = {
  id: 'proj', repo: '/repo', worktreeRoot: '/wt', base: 'main',
  launch: { claude: {}, codex: { bin: '/opt/codex' } },
  verify: [{ id: 'test', argv: ['npm', 'test'], timeout: 60 }],
};
const SURF = surfFor('run-1', 1, 1);

class FakeManagedAdapter extends EventEmitter implements RuntimeAdapter {
  async start() { return 'managed-provider-session'; }
  async resume() { return 'managed-provider-session'; }
  async send() {}
  async sendDirect(_text: string, _id: string, context: { turnId: string | null }) { return { turnId: context.turnId, providerAcknowledged: true }; }
  async interrupt() {}
  async respond(_request: HarnessRequest, _response: unknown) {}
  async stop() { this.emit('exit', 0); }
}

function setup(opts: { resumeAgents?: boolean; managedFactory?: DispatchDeps['managedFactory']; spawn?: SpawnFn } = {}) {
  const registry = Registry.load({ file: null, bootId: 'boot-1' });
  const sp = fakeSpawner();
  let failSpawn = false;
  const spawn: SpawnFn = (req) => {
    if (failSpawn) throw new Error('pty unavailable');
    return sp.spawn(req);
  };
  const timers = new ManualTimers();
  const hub = new Hub({ registry, spawn, bootId: 'boot-1', serverId: 'srv', hostname: 'box', timers, probe: () => ({}) });
  const exits: Array<Record<string, unknown>> = [];
  hub.setSink({ status: () => {}, turn: () => {}, exit: (e) => exits.push(e as unknown as Record<string, unknown>) });
  const worktrees = {
    ensure: async (t: ExecutionTarget, branch: string, base: string) => ({ path: `${t.worktreeRoot}/${branch.replace(/\//g, '--')}`, branch, base, baseSha: 'abc123', created: true }),
  } as unknown as WorktreeManager;
  const dispatch = new Dispatch({
    hub, registry, dir: null, worktrees, targets: () => [TARGET],
    questions: new QuestionBroker({ session: (id) => registry.session(id), canHold: () => true, emit: () => {}, needsYou: () => {} }),
    managedFactory: opts.managedFactory, managedEmit: () => {},
    emit: () => {}, linkReady: () => true, resumeAgents: opts.resumeAgents,
    timing: { queuePollMs: 2, pasteEnterMs: 1, steerDelayMs: 1, ctrlCGapMs: 1, ctrlCRetryMs: 5, stopWaitMs: 60, killWaitMs: 60 },
  });
  hub.setEridani(dispatch.hubHooks());
  const h = dispatch.handlers();
  const run = async (cmd: Record<string, unknown>): Promise<CommandResult & { began: boolean }> => {
    const pre = dispatch.precheck(cmd as CommandBody);
    if (pre) return { state: 'rejected', detail: pre, began: false };
    let began = false;
    const ctx: CommandContext = { begin: () => (began = true) };
    return { ...(await h[cmd.t as string](cmd as CommandBody, ctx)), began };
  };
  // The launched agent reports its session through its SessionStart hook (this is what records `rec.agent`).
  const agentUp = (sessionId = 'sess-1') => hub.relayRpc(SURF, 'hook.event', { event: 'SessionStart', sessionId });
  const desktop = (id: number) => {
    const c = new FakeConn(id);
    hub.connect(c);
    hub.handle(c, { t: 'hello', proto: 1, device: { id: `device-desk${id}`, name: `Desk ${id}` }, app: { name: 'test', version: '1' } });
    cleanups.push(() => hub.disconnect(c));
    return c;
  };
  return { hub, registry, sp, timers, dispatch, run, agentUp, exits, desktop, failSpawns: (v: boolean) => (failSpawn = v) };
}

const spawnCmd = (over: Record<string, unknown> = {}) => ({
  t: 'spawn', op_id: 'op-spawn-1', digest: 'd', run_id: 'run-1', generation: 1, attempt: 1, harness: 'claude', model: 'sonnet',
  target: { id: 'proj', branch: 'eri/task-1' }, task_id: 'task-1', prompt: 'Fix the bug', env: { ERIDANI_FOO: 'bar' }, run_token: 'tok-123',
  expires_at: Date.now() + 60_000, ...over,
});

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 2));
  }
}

let ops = 0;
const reopen = (over: Record<string, unknown> = {}) => ({
  t: 'run.reopen', op_id: `op-reopen-${++ops}`, digest: 'd', run_id: 'run-1', generation: 1, surf: SURF, incarnation: 1, expires_at: Date.now() + 300_000, ...over,
});

/** A spawned worker whose agent reported its session, then exited. */
async function exitedWorker(opts: Parameters<typeof setup>[0] & { agent?: boolean; sessionId?: string } = {}) {
  const f = setup(opts);
  expect(await f.run(spawnCmd())).toMatchObject({ state: 'executed' });
  if (opts.agent !== false) f.agentUp(opts.sessionId);
  f.sp.last().exit(0);
  expect(f.registry.session(SURF)).toMatchObject({ state: 'exited', incarnation: 1, exitCode: 0 });
  return f;
}

describe('run.reopen: in place', () => {
  it('respawns an exited worker on the same surface with the resume line, keeping the binding and the run token', async () => {
    const f = await exitedWorker();
    const binding = structuredClone(f.registry.session(SURF)!.eridani);
    const exitedAt = f.registry.session(SURF)!.exitedAt;
    expect(exitedAt).toBeDefined();
    const res = await f.run(reopen());
    expect(res).toMatchObject({ state: 'executed', began: true, result: { surf: SURF, incarnation: 2 } });
    expect(res.result).toEqual({ surf: SURF, incarnation: 2 });
    expect(f.sp.ptys).toHaveLength(2);
    // The resumed agent waits at its prompt: the resume line, no prompt typed.
    expect(f.sp.last().req.cmd).toBe(`'claude' --resume 'sess-1' --model 'sonnet' --permission-mode auto`);
    expect(f.sp.last().written).toEqual([]);
    expect(f.sp.last().req.env).toMatchObject({ ERIDANI_RUN_TOKEN: 'tok-123', ERIDANI_RUN_ID: 'run-1', ERIDANI_FOO: 'bar' });
    const rec = f.registry.session(SURF)!;
    expect(rec).toMatchObject({ state: 'live', incarnation: 2, agent: { provider: 'claude', sessionId: 'sess-1' } });
    expect(rec.exitCode).toBeUndefined();
    expect(rec.eridani).toEqual(binding);
    expect(f.hub.isLive(SURF)).toBe(true);
    expect(f.dispatch.runToken(SURF)).toBe('tok-123');
    // Eridani saw one exit (the one that made the run needs_you); the reopen adds none.
    expect(f.exits).toHaveLength(1);
  });

  it('the new incarnation must report its session before it is steered (M7), like a boot resume', async () => {
    const f = await exitedWorker();
    await f.run(reopen());
    const steer = { t: 'input', mode: 'steer', text: 'go on', op_id: 'op-st', digest: 'd', surf: SURF, incarnation: 2, run_id: 'run-1', generation: 2 } as CommandBody;
    expect(f.dispatch.precheck(steer)).toBe('the agent has not reported its session yet');
    f.agentUp();
    expect(f.dispatch.precheck(steer)).toBeNull();
  });

  it('an app showing the dead terminal is handed the new process', async () => {
    const f = await exitedWorker();
    const desk = f.desktop(7);
    f.hub.handle(desk, { t: 'open', rid: 1, id: SURF, cols: 100, rows: 30 });
    await until(() => desk.json('opened').length > 0);
    expect(desk.json('opened')[0]).toMatchObject({ state: 'exited' });
    desk.clear();
    await f.run(reopen());
    expect(desk.json('opened')).toEqual([expect.objectContaining({ id: SURF, state: 'live', wasLost: true, mode: 'fresh' })]);
    f.sp.last().emit('resumed\r\n');
    f.timers.advance(1000);
    await until(() => desk.outputs(SURF).map((o) => o.data).join('').includes('resumed'));
  });

  it('a replay of a reopen that already happened is executed with the current facts and starts nothing', async () => {
    const f = await exitedWorker();
    expect(await f.run(reopen())).toMatchObject({ state: 'executed', result: { incarnation: 2 } });
    const again = await f.run(reopen());
    expect(again).toMatchObject({ state: 'executed', began: false, result: { surf: SURF, incarnation: 2 } });
    expect(f.sp.ptys).toHaveLength(2);
    // Live at the incarnation it names: there is nothing to reopen.
    expect(await f.run(reopen({ incarnation: 2 }))).toMatchObject({ state: 'rejected', detail: 'the surface is still running' });
  });

  it('a reopened worker that exits again can be reopened again, as the next incarnation', async () => {
    const f = await exitedWorker();
    await f.run(reopen());
    f.agentUp();
    f.sp.last().exit(0);
    expect(await f.run(reopen())).toMatchObject({ state: 'rejected', detail: 'stale incarnation' });
    expect(await f.run(reopen({ incarnation: 2 }))).toMatchObject({ state: 'executed', result: { incarnation: 3 } });
    expect(f.sp.ptys).toHaveLength(3);
  });

  it('a managed run goes through the managed resume branch, never a native shell', async () => {
    let adapters = 0;
    const adapter = () => { adapters++; return new FakeManagedAdapter(); };
    const f = setup({ managedFactory: adapter });
    expect(await f.run(spawnCmd({ execution: 'managed', harness: 'codex' }))).toMatchObject({ state: 'executed' });
    f.hub.killProcess(SURF);
    await until(() => f.registry.session(SURF)!.state === 'exited');
    expect(f.registry.session(SURF)).toMatchObject({ state: 'exited', incarnation: 1 });
    expect(await f.run(reopen())).toMatchObject({ state: 'executed', result: { surf: SURF, incarnation: 2 } });
    expect(adapters).toBe(2);
    expect(f.sp.ptys).toHaveLength(0);
  });
});

describe('run.reopen: refused', () => {
  it('an unknown or pruned surface', async () => {
    const f = await exitedWorker();
    expect(await f.run(reopen({ surf: 'surf-eri-nothere' }))).toMatchObject({ state: 'rejected', detail: 'unknown surface' });
    f.registry.updateSession(SURF, { exitedAt: 1 });
    expect(f.registry.prune()).toEqual([SURF]);
    expect(await f.run(reopen())).toMatchObject({ state: 'rejected', detail: 'unknown surface' });
    expect(f.sp.ptys).toHaveLength(1);
  });

  it('another run, a stale generation, a stale incarnation', async () => {
    const f = await exitedWorker();
    expect(await f.run(reopen({ run_id: 'run-2' }))).toMatchObject({ state: 'rejected', detail: 'run does not match' });
    expect(await f.run(reopen({ generation: 2 }))).toMatchObject({ state: 'rejected', detail: 'stale generation' });
    expect(await f.run(reopen({ generation: 0 }))).toMatchObject({ state: 'rejected', detail: 'stale generation' });
    expect(await f.run(reopen({ incarnation: 0 }))).toMatchObject({ state: 'rejected', detail: 'stale incarnation' });
    expect(f.sp.ptys).toHaveLength(1);
  });

  it('a reviewer surface', async () => {
    const f = await exitedWorker();
    f.hub.updateRecord(SURF, { eridani: { ...f.registry.session(SURF)!.eridani!, role: 'reviewer' } });
    expect(await f.run(reopen())).toMatchObject({ state: 'rejected', detail: 'not the run\'s worker' });
  });

  it('a requested stop', async () => {
    const f = await exitedWorker();
    f.hub.updateRecord(SURF, { eridani: { ...f.registry.session(SURF)!.eridani!, stopRequested: { at: 1, mode: 'interrupt', op: 'op-x' } } });
    expect(await f.run(reopen())).toMatchObject({ state: 'rejected', detail: 'a stop was requested' });
  });

  it('no conversation to resume, and resuming agents turned off', async () => {
    expect(await (await exitedWorker({ agent: false })).run(reopen())).toMatchObject({ state: 'rejected', detail: 'no conversation to resume' });
    expect(await (await exitedWorker({ resumeAgents: false })).run(reopen())).toMatchObject({ state: 'rejected', detail: 'resuming agents is turned off' });
  });

  it('a surface that is still running', async () => {
    const f = setup();
    await f.run(spawnCmd());
    f.agentUp();
    expect(await f.run(reopen())).toMatchObject({ state: 'rejected', detail: 'the surface is still running' });
  });
});

describe('run.reopen: a respawn that does not start', () => {
  it('a resume the hook refuses fails and leaves the surface exited, as it was, with no second exit upstream', async () => {
    // A session id the resume line will not quote: resumeCommand returns null.
    const f = await exitedWorker({ sessionId: 'bad id; rm' });
    const before = structuredClone(f.registry.session(SURF)!);
    const desk = f.desktop(8);
    const res = await f.run(reopen());
    expect(res).toMatchObject({ state: 'failed', detail: 'reopen: the run could not be resumed' });
    expect(f.sp.ptys).toHaveLength(1);
    expect(f.registry.session(SURF)).toEqual(before);
    expect(f.hub.isLive(SURF)).toBe(false);
    expect(f.exits).toHaveLength(1);
    // The tab still shows the dead terminal.
    f.hub.handle(desk, { t: 'open', rid: 1, id: SURF, cols: 80, rows: 24 });
    await until(() => desk.json('opened').length > 0);
    expect(desk.json('opened')[0]).toMatchObject({ state: 'exited' });
  });

  it('a spawn that throws fails and leaves the surface exited', async () => {
    const f = await exitedWorker();
    f.failSpawns(true);
    expect(await f.run(reopen())).toMatchObject({ state: 'failed', detail: 'reopen: pty unavailable' });
    expect(f.registry.session(SURF)).toMatchObject({ state: 'exited', incarnation: 1, exitCode: 0 });
    f.failSpawns(false);
    expect(await f.run(reopen())).toMatchObject({ state: 'executed', result: { incarnation: 2 } });
  });

  it('found executing after a restart: executed when the surface moved on to a newer incarnation, else failed', async () => {
    const f = await exitedWorker();
    const body = reopen();
    const journal = (b: Record<string, unknown>) => f.dispatch.recover({ op_id: String(b.op_id), digest: 'd', t: 'run.reopen', state: 'executing', at: 1, updatedAt: 1, body: b });
    expect(journal(body)).toMatchObject({ state: 'failed', detail: 'interrupted by a server restart' });
    await f.run(reopen());
    expect(journal(body)).toMatchObject({ state: 'executed', outcome: { surf: SURF, incarnation: 2 } });
  });
});

describe('run.reopen: protocol', () => {
  it('is effectful, and fenced like run.pause', () => {
    expect(EFFECTFUL_COMMANDS.has('run.reopen')).toBe(true);
    const fence = { run_id: 'run-1', generation: 1, surf: SURF, incarnation: 1, expires_at: Date.now() + 1000 };
    expect(commandShapeError({ t: 'run.reopen', ...fence })).toBeNull();
    expect(commandShapeError({ t: 'run.reopen', ...fence, surf: undefined })).toBe('bad fence');
    expect(commandShapeError({ t: 'run.reopen', ...fence, surf: 'x'.repeat(121) })).toBe('bad fence');
    expect(commandShapeError({ t: 'run.reopen', ...fence, incarnation: -1 })).toBe('bad fence');
    expect(commandShapeError({ t: 'run.reopen', ...fence, generation: '1' })).toBe('bad fence');
    expect(commandShapeError({ t: 'run.reopen', ...fence, run_id: undefined })).toBe('bad fence');
    expect(commandShapeError({ t: 'run.reopen', ...fence, expires_at: 'soon' })).toBe('bad expires_at');
  });

  it('is advertised by every host, managed or not', () => {
    expect(STAGE_F_CAPS).toContain('run.reopen');
    expect(STAGE_F_AUTHORITATIVE_CAPS).toContain('run.reopen');
    expect(linkCaps('off')).toContain('run.reopen');
    expect(linkCaps('authoritative')).toContain('run.reopen');
  });
});
