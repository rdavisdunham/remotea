/**
 * Delayed writes are fenced (S-N1): a steer is Esc, 800 ms, a bracketed
 * paste, 150 ms, Enter; a queued input is a paste, 150 ms, Enter. Anything
 * that supersedes the write during either delay (a stop, a newer steer, a
 * newer generation from runs.snapshot, the process exiting or being replaced,
 * the link dropping) must stop it from writing another byte, and the command
 * reports what was and was not written. Fake PTYs, and timers that only fire
 * when the test says so.
 */
import { describe, expect, it } from 'vitest';
import { Hub } from '../src/hub';
import { Registry } from '../src/registry';
import { DEFAULT_TIMING, Dispatch, surfFor } from '../src/dispatch';
import { QuestionBroker } from '../src/questions-claude';
import type { CommandContext, CommandResult } from '../src/eridani-link';
import type { ExecutionTarget } from '../src/eridani-targets';
import type { WorktreeManager } from '../src/worktrees';
import type { CommandBody } from '../../src/shared/eridani-link-protocol';
import { fakeSpawner, ManualTimers, type FakePty } from './helpers';

const TARGET: ExecutionTarget = {
  id: 'proj',
  repo: '/repo',
  worktreeRoot: '/wt',
  base: 'main',
  launch: { claude: {} },
  verify: [],
};

const ESC_MS = DEFAULT_TIMING.steerDelayMs;
const ENTER_MS = DEFAULT_TIMING.pasteEnterMs;
const PASTE = '\x1b[200~';

/** Let every promise continuation that is already due run. */
const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

type Result = CommandResult & { began: boolean };

async function setup() {
  const registry = Registry.load({ file: null, bootId: 'boot-1' });
  const sp = fakeSpawner();
  const hub = new Hub({ registry, spawn: sp.spawn, bootId: 'boot-1', serverId: 'srv', hostname: 'box', timers: new ManualTimers(), probe: () => ({}) });
  const timers = new ManualTimers();
  const worktrees = {
    ensure: async (t: ExecutionTarget, branch: string, base: string) => ({ path: `${t.worktreeRoot}/${branch.replace(/\//g, '--')}`, branch, base, baseSha: 'abc123', created: true }),
  } as unknown as WorktreeManager;
  const questions = new QuestionBroker({ session: (id) => registry.session(id), canHold: () => true, emit: () => {}, needsYou: () => {} });
  let ready = true;
  const dispatch = new Dispatch({
    hub,
    registry,
    dir: null,
    worktrees,
    targets: () => [TARGET],
    questions,
    emit: () => {},
    linkReady: () => ready,
    timers,
  });
  hub.setEridani(dispatch.hubHooks());
  const h = dispatch.handlers();
  const agentUp = (s: string) => hub.relayRpc(s, 'hook.event', { event: 'SessionStart', sessionId: 'sess-1' });

  /** Start a command the way the link does (precheck, then the handler); the promise settles when the handler does. */
  const start = (cmd: Record<string, unknown>): { done: () => Result | null; promise: Promise<Result> } => {
    let out: Result | null = null;
    const pre = dispatch.precheck(cmd as CommandBody);
    let began = false;
    const ctx: CommandContext = { begin: () => (began = true) };
    const promise = pre
      ? Promise.resolve<Result>({ state: 'rejected', detail: pre, began })
      : h[cmd.t as string](cmd as CommandBody, ctx).then((r) => ({ ...r, began }));
    void promise.then((r) => (out = r));
    return { done: () => out, promise };
  };

  const spawned = start({
    t: 'spawn', op_id: 'op-spawn', digest: 'd', run_id: 'run-1', generation: 1, attempt: 1, harness: 'claude', model: 'sonnet',
    target: { id: 'proj', branch: 'eri/t' }, prompt: 'go', expires_at: Date.now() + 60_000,
  });
  expect((await spawned.promise).state).toBe('executed');
  const surf = surfFor('run-1', 1, 1);
  agentUp(surf);
  const pty = sp.last();

  const fence = (over: Record<string, unknown> = {}) => ({ digest: 'd', surf, incarnation: registry.session(surf)!.incarnation, run_id: 'run-1', expires_at: Date.now() + 60_000, ...over });
  const steer = (text: string, generation: number, op = `op-steer-${text}`) => start({ t: 'input', mode: 'steer', text, op_id: op, generation, ...fence() });
  const queue = (text: string, generation = registry.session(surf)!.eridani!.generation) => start({ t: 'input', mode: 'queue', text, op_id: `op-q-${text}`, generation, ...fence() });
  const stop = (generation: number) => start({ t: 'stop', mode: 'interrupt', op_id: 'op-stop', generation, ...fence() });
  /** Fires only timers already set: a delay that starts when an earlier one ends needs its own call. */
  const advance = async (ms: number) => {
    timers.advance(ms);
    await settle();
  };
  return { registry, hub, sp, pty, dispatch, timers, surf, steer, queue, stop, advance, agentUp, setReady: (v: boolean) => (ready = v) };
}

const typed = (pty: FakePty) => pty.written.join('');
const enters = (pty: FakePty) => pty.written.filter((w) => w === '\r').length;

describe('S-N1: a steer writes nothing once it is superseded', () => {
  it('runs to completion when nothing intervenes, and only then reports executed', async () => {
    const { pty, steer, advance } = await setup();
    const s = steer('plan b', 2);
    await settle();
    expect(pty.written).toEqual(['\x1b']);
    await advance(ESC_MS);
    expect(typed(pty)).toContain(`${PASTE}plan b`);
    expect(s.done()).toBeNull(); // the Enter is still due: not executed yet
    await advance(ENTER_MS);
    expect(pty.written.at(-1)).toBe('\r');
    expect(s.done()).toMatchObject({ state: 'executed', result: { mode: 'steer', generation: 2 } });
  });

  it('a stop command during the Escape delay: no paste, no Enter, and the steer reports interrupted', async () => {
    const { pty, steer, stop, advance } = await setup();
    const s = steer('plan b', 2);
    await settle();
    stop(2);
    await settle();
    // The steer is woken at once: it does not wait out its delay to report.
    expect(s.done()).toMatchObject({
      state: 'failed',
      result: { mode: 'steer', generation: 2, outcome: 'interrupted', reason: 'a stop was requested', written: { escape: true, text: false, enter: false } },
    });
    expect(s.done()!.detail).toContain('Esc was sent; the text and Enter were not');
    await advance(5_000);
    expect(typed(pty)).not.toContain(PASTE);
    expect(enters(pty)).toBe(0);
    expect(pty.written.filter((w) => w !== '\x03')).toEqual(['\x1b']);
  });

  it('runs.snapshot stops the run at generation 3 during the Enter delay: the pasted steer at generation 2 never gets its Enter', async () => {
    const { pty, steer, dispatch, registry, surf, advance } = await setup();
    const s = steer('plan b', 2);
    await advance(ESC_MS);
    expect(typed(pty)).toContain(`${PASTE}plan b`);
    dispatch.applyRunsSnapshot([{ run_id: 'run-1', generation: 3, desired: 'stop', stop_mode: 'interrupt' }]);
    await settle();
    expect(registry.session(surf)!.eridani).toMatchObject({ generation: 3, stopRequested: { mode: 'interrupt' } });
    expect(s.done()).toMatchObject({
      state: 'failed',
      result: { outcome: 'interrupted', written: { escape: true, text: true, enter: false } },
    });
    expect(s.done()!.detail).toMatch(/Esc and the text were sent; Enter was not, so the text was not submitted/);
    await advance(5_000);
    expect(enters(pty)).toBe(0);
    expect(typed(pty).split(PASTE)).toHaveLength(2);
  });

  it('a newer generation from runs.snapshot (no stop) during the Escape delay cancels the older steer', async () => {
    const { pty, steer, dispatch, advance } = await setup();
    const s = steer('plan b', 2);
    await settle();
    dispatch.applyRunsSnapshot([{ run_id: 'run-1', generation: 3 }]);
    await settle();
    expect(s.done()).toMatchObject({ state: 'failed', result: { outcome: 'interrupted', reason: 'superseded by generation 3 (runs.snapshot)', written: { text: false } } });
    await advance(5_000);
    expect(pty.written).toEqual(['\x1b']);
  });

  it('two overlapping steers (the second during the first\'s Escape delay): the first writes nothing more, the second completes', async () => {
    const { pty, steer, advance } = await setup();
    const a = steer('first', 2);
    await advance(ESC_MS / 2);
    const b = steer('second', 3);
    await settle();
    expect(a.done()).toMatchObject({ state: 'failed', result: { generation: 2, outcome: 'interrupted', reason: 'superseded by a newer steer', written: { escape: true, text: false, enter: false } } });
    await advance(ESC_MS / 2); // when the first steer's delay would have ended
    expect(typed(pty)).not.toContain('first');
    await advance(ESC_MS / 2);
    await advance(ENTER_MS);
    expect(b.done()).toMatchObject({ state: 'executed', result: { generation: 3 } });
    expect(typed(pty)).not.toContain('first');
    expect(pty.written).toEqual(['\x1b', '\x1b', `${PASTE}second\x1b[201~`, '\r']);
  });

  it('two overlapping steers (the second during the first\'s Enter delay): the first\'s Enter is never sent; exactly one Enter, the second\'s', async () => {
    const { pty, steer, advance } = await setup();
    const a = steer('first', 2);
    await advance(ESC_MS);
    const b = steer('second', 2); // the same generation is still a newer steer
    await settle();
    expect(a.done()).toMatchObject({ state: 'failed', result: { outcome: 'interrupted', reason: 'superseded by a newer steer', written: { escape: true, text: true, enter: false } } });
    await advance(ENTER_MS); // when the first steer's Enter was due
    expect(enters(pty)).toBe(0);
    await advance(ESC_MS);
    await advance(ENTER_MS);
    expect(b.done()).toMatchObject({ state: 'executed' });
    expect(enters(pty)).toBe(1);
    expect(pty.written.at(-1)).toBe('\r');
    expect(pty.written.at(-2)).toBe(`${PASTE}second\x1b[201~`);
  });

  it('the process exits during the Escape delay and is respawned (a new incarnation): neither process gets another byte', async () => {
    const { pty, sp, hub, registry, dispatch, surf, steer, advance, agentUp } = await setup();
    const s = steer('plan b', 2);
    await settle();
    pty.exit(1);
    await settle();
    expect(s.done()).toMatchObject({ state: 'failed', result: { outcome: 'interrupted', reason: 'the process exited', written: { escape: true, text: false } } });
    // Respawn in place, as a reopen of a lost run does: a new process, incarnation 2, whose agent reports in.
    (hub as unknown as { sessions: Map<string, unknown> }).sessions.delete(surf);
    registry.updateSession(surf, { state: 'lost', agent: { provider: 'claude', sessionId: 'sess-1', seenAt: 1 } });
    expect(dispatch.conn.open(surf, {})).toEqual({ ok: true });
    const next = sp.last();
    expect(next).not.toBe(pty);
    expect(registry.session(surf)!.incarnation).toBe(2);
    agentUp(surf);
    await advance(5_000);
    expect(pty.written).toEqual(['\x1b']);
    expect(next.written).toEqual([]);
  });

  it('the record moves to a new incarnation during the Enter delay (no exit seen yet): Enter is not sent', async () => {
    const { pty, hub, surf, steer, advance } = await setup();
    const s = steer('plan b', 2);
    await advance(ESC_MS);
    hub.updateRecord(surf, { incarnation: 2 });
    await advance(ENTER_MS);
    expect(s.done()).toMatchObject({ state: 'failed', result: { outcome: 'interrupted', reason: 'the process was replaced (incarnation 2)', written: { text: true, enter: false } } });
    expect(enters(pty)).toBe(0);
  });

  it('the link drops during the Escape delay and reconnects; the reconcile (runs.snapshot) finds the same generation: still nothing is typed', async () => {
    const { pty, steer, dispatch, advance, setReady } = await setup();
    const s = steer('plan b', 2);
    await settle();
    setReady(false);
    await advance(ESC_MS / 2);
    setReady(true);
    dispatch.linkUp();
    await settle();
    expect(s.done()).toMatchObject({ state: 'failed', result: { outcome: 'interrupted', reason: 'the link to Eridani dropped and reconnected', written: { escape: true, text: false } } });
    dispatch.applyRunsSnapshot([{ run_id: 'run-1', generation: 2 }]);
    await advance(5_000);
    expect(pty.written).toEqual(['\x1b']);
  });

  it('the link is down when the Enter falls due: Enter is not sent, and a later reconcile adds nothing', async () => {
    const { pty, steer, dispatch, advance, setReady } = await setup();
    const s = steer('plan b', 2);
    await advance(ESC_MS);
    setReady(false);
    await advance(ENTER_MS);
    expect(s.done()).toMatchObject({ state: 'failed', result: { outcome: 'interrupted', reason: 'the link to Eridani dropped', written: { text: true, enter: false } } });
    setReady(true);
    dispatch.linkUp();
    dispatch.applyRunsSnapshot([{ run_id: 'run-1', generation: 3, desired: 'stop' }]);
    await advance(5_000);
    expect(enters(pty)).toBe(0);
  });

  it('a steer whose fence went stale between its precheck and its run is rejected before any byte', async () => {
    const { pty, hub, registry, surf, dispatch } = await setup();
    const cmd = { t: 'input', mode: 'steer', text: 'late', op_id: 'op-late', digest: 'd', surf, incarnation: 1, run_id: 'run-1', generation: 2, expires_at: Date.now() + 60_000 } as CommandBody;
    expect(dispatch.precheck(cmd)).toBeNull();
    // Accepted, but the run moved on before the handler ran.
    hub.updateRecord(surf, { eridani: { ...registry.session(surf)!.eridani!, generation: 3 } });
    let began = false;
    const res = await dispatch.handlers().input(cmd, { begin: () => (began = true) });
    expect(res).toEqual({ state: 'rejected', detail: 'stale generation' });
    expect(began).toBe(false);
    expect(pty.written).toEqual([]);
  });
});

describe('S-N1: queued input keeps its behaviour, and its Enter is fenced too', () => {
  it('is delivered at an idle prompt and reports executed only after its Enter', async () => {
    const { pty, hub, surf, queue, advance } = await setup();
    hub.agentState.report(surf, { runDepth: 0 });
    const q = queue('next');
    await advance(0);
    expect(typed(pty)).toContain(`${PASTE}next`);
    expect(q.done()).toBeNull();
    await advance(ENTER_MS);
    expect(pty.written.at(-1)).toBe('\r');
    expect(q.done()).toMatchObject({ state: 'executed', result: { mode: 'queue', generation: 1 } });
  });

  it('a stop during its Enter delay: Enter is not sent, and it reports interrupted with the text pasted', async () => {
    const { pty, hub, surf, queue, stop, advance } = await setup();
    hub.agentState.report(surf, { runDepth: 0 });
    const q = queue('next');
    await advance(0);
    stop(1);
    await settle();
    expect(q.done()).toMatchObject({ state: 'failed', result: { mode: 'queue', outcome: 'interrupted', reason: 'a stop was requested', written: { escape: false, text: true, enter: false } } });
    expect(q.done()!.detail).toContain('the text was pasted; Enter was not sent');
    await advance(5_000);
    expect(enters(pty)).toBe(0);
  });

  it('a steer during a queued input\'s Enter delay cancels that Enter; only the steer is submitted', async () => {
    const { pty, hub, surf, queue, steer, advance } = await setup();
    hub.agentState.report(surf, { runDepth: 0 });
    const q = queue('next');
    await advance(0);
    const s = steer('plan b', 2);
    await settle();
    expect(q.done()).toMatchObject({ state: 'failed', result: { outcome: 'interrupted', reason: 'superseded by a newer steer', written: { text: true, enter: false } } });
    await advance(ESC_MS);
    await advance(ENTER_MS);
    expect(s.done()).toMatchObject({ state: 'executed' });
    expect(enters(pty)).toBe(1);
    expect(pty.written.at(-2)).toBe(`${PASTE}plan b\x1b[201~`);
  });

  it('the next queued input waits for the previous one\'s Enter (one write per surface)', async () => {
    const { pty, hub, surf, queue, advance } = await setup();
    hub.agentState.report(surf, { runDepth: 0 });
    const a = queue('one');
    const b = queue('two');
    await advance(0);
    expect(typed(pty)).not.toContain('two');
    await advance(ENTER_MS);
    expect(a.done()).toMatchObject({ state: 'executed' });
    // The second still needs a fresh idle prompt after the first was typed.
    expect(typed(pty)).not.toContain('two');
    expect(b.done()).toBeNull();
  });
});
