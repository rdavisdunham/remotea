/**
 * Hyperplan (PR A): per-spawn roles and read-only modes on the host.
 *
 *   - `spawn` takes `role` (planner | reviewer | worker) and `mode` (plan |
 *     review). A mode launches the harness read-only: Claude with
 *     `--permission-mode dontAsk` and its allow / deny lists, Codex with
 *     `--sandbox read-only --ask-for-approval never`. A resume keeps them.
 *   - Without either field the command line is byte-for-byte what it was.
 *   - A read-only spawn starts beside a live writer on the same branch (it
 *     is not a writer itself) and counts toward `limits.maxRuns`.
 *   - `runs.snapshot` entries naming a `surf` (or `attempt`) apply to that
 *     session only; the run's other sessions are left alone.
 *   - `boundSession` (verify) skips reviewer sessions.
 *   - hello advertises `spawn.roles`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { Hub } from '../src/hub';
import { Registry } from '../src/registry';
import { CLAUDE_READ_ONLY_DENIED, CLAUDE_READ_ONLY_TOOLS, Dispatch, launchCommand, readOnlyFlags, resumeLine, surfFor } from '../src/dispatch';
import { EridaniLink } from '../src/eridani-link';
import { MCP_SERVER_NAME } from '../src/eridani-mcp';
import { linkCaps } from '../src/eridani-runtime';
import { QuestionBroker } from '../src/questions-claude';
import { liveWriters } from '../src/worktrees';
import type { CommandContext, CommandResult } from '../src/eridani-link';
import type { ExecutionTarget } from '../src/eridani-targets';
import type { WorktreeManager } from '../src/worktrees';
import type { CommandBody, UpFrame } from '../../src/shared/eridani-link-protocol';
import { commandShapeError, MODE_UNSUPPORTED, parseDownFrame, parseUpFrame, STAGE_F_CAPS, STAGE_F_AUTHORITATIVE_CAPS, TARGET_BUSY, WORKTREE_BUSY } from '../../src/shared/eridani-link-protocol';
import type { EridaniBinding } from '../../src/shared/remote-host-protocol';
import { fakeSpawner, ManualTimers } from './helpers';

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

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
  launch: { claude: {}, codex: {} },
  verify: [{ id: 'test', argv: ['npm', 'test'], timeout: 60 }],
};

const FAST = { queuePollMs: 2, pasteEnterMs: 1, steerDelayMs: 1, ctrlCGapMs: 1, ctrlCRetryMs: 5, stopWaitMs: 60, killWaitMs: 60 };

/** Dispatch with a fake worktree manager; `run` applies the link's checks (shape, precheck) before the handler, as the link does. */
function setup(target: ExecutionTarget = TARGET) {
  const registry = Registry.load({ file: null, bootId: 'boot-1' });
  const sp = fakeSpawner();
  const hub = new Hub({ registry, spawn: sp.spawn, bootId: 'boot-1', serverId: 'srv', hostname: 'box', timers: new ManualTimers(), probe: () => ({}) });
  const worktrees = {
    ensure: async (t: ExecutionTarget, branch: string, base: string) => ({ path: `${t.worktreeRoot}/${branch.replace(/\//g, '--')}`, branch, base, baseSha: 'abc123', created: true }),
  } as unknown as WorktreeManager;
  const questions = new QuestionBroker({ session: (id) => registry.session(id), canHold: () => true, emit: () => {}, needsYou: () => {} });
  const dispatch = new Dispatch({ hub, registry, dir: null, worktrees, targets: () => [target], questions, emit: () => {}, linkReady: () => true, timing: FAST });
  hub.setEridani(dispatch.hubHooks());
  const h = dispatch.handlers();
  const run = async (cmd: Record<string, unknown>): Promise<CommandResult> => {
    const bad = commandShapeError(cmd);
    if (bad) return { state: 'rejected', detail: bad };
    const pre = dispatch.precheck(cmd as CommandBody);
    if (pre) return { state: 'rejected', detail: pre };
    const ctx: CommandContext = { begin: () => {} };
    const res = await h[cmd.t as string](cmd as CommandBody, ctx);
    if (cmd.t === 'spawn' && res.state === 'executed') hub.relayRpc(String((res.result as { surf: string }).surf), 'hook.event', { event: 'SessionStart', sessionId: `sess-${cmd.attempt}` });
    return res;
  };
  return { registry, hub, sp, dispatch, run };
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

const PLANNER = surfFor('run-1', 1, 1);
const REVIEWER = surfFor('run-1', 1, 2);

const CLAUDE_LISTS = `--allowedTools 'Read' 'Grep' 'Glob' 'Bash(git status *)' 'Bash(git log *)' 'Bash(git diff *)' 'Bash(git show *)' 'Bash(git ls-files *)' 'Bash(git ls-tree *)' 'Bash(git rev-parse *)' 'Bash(pwd)' 'Bash(ls *)' 'Bash(cat *)' 'Bash(rg *)' --disallowedTools 'Edit' 'Write' 'NotebookEdit'`;

describe('hyperplan: read-only launch lines', () => {
  it('claude mode: review swaps auto for dontAsk with the allow and deny lists, before --model so the prompt is never a list value', () => {
    expect(MCP_SERVER_NAME).toBe('eridani');
    expect(CLAUDE_READ_ONLY_TOOLS).not.toContain(`mcp__${MCP_SERVER_NAME}__*`);
    expect(CLAUDE_READ_ONLY_DENIED).toEqual(['Edit', 'Write', 'NotebookEdit']);
    expect(launchCommand('claude', 'sonnet', {}, true, [], 'review')).toBe(`'claude' ${CLAUDE_LISTS} --model 'sonnet' --permission-mode dontAsk "$ERIDANI_PROMPT"`);
    // With the MCP config and target args: the config stays right after the program, the extra args stay before the prompt.
    expect(launchCommand('claude', 'opus', { args: ['--verbose'] }, true, ['--mcp-config', '/c/x.json'], 'plan'))
      .toBe(`'claude' '--mcp-config' '/c/x.json' ${CLAUDE_LISTS} --model 'opus' --permission-mode dontAsk '--verbose' "$ERIDANI_PROMPT"`);
    expect(launchCommand('claude', 'sonnet', {}, true, [], 'review')).not.toContain('--permission-mode auto');
  });

  it('codex mode: review adds --sandbox read-only --ask-for-approval never', () => {
    expect(launchCommand('codex', 'gpt-5', {}, true, [], 'review')).toBe(`'codex' --disable daemon_auto_start -m 'gpt-5' --sandbox read-only --ask-for-approval never "$ERIDANI_PROMPT"`);
    expect(launchCommand('codex', 'gpt-5', { bin: '/opt/codex' }, true, ['-c', 'k=v'], 'plan')).toBe(`'/opt/codex' '-c' 'k=v' --disable daemon_auto_start -m 'gpt-5' --sandbox read-only --ask-for-approval never "$ERIDANI_PROMPT"`);
  });

  it('no mode: the lines are byte-for-byte what they were before modes existed', () => {
    expect(launchCommand('claude', 'sonnet', {}, true)).toBe(`'claude' --model 'sonnet' --permission-mode auto "$ERIDANI_PROMPT"`);
    expect(launchCommand('claude', 'sonnet', {}, true, [], undefined)).toBe(`'claude' --model 'sonnet' --permission-mode auto "$ERIDANI_PROMPT"`);
    expect(launchCommand('claude', 'sonnet', {}, true, [], null)).toBe(`'claude' --model 'sonnet' --permission-mode auto "$ERIDANI_PROMPT"`);
    expect(launchCommand('claude', 'sonnet', {}, true, ['--mcp-config', '/c/x.json'])).toBe(`'claude' '--mcp-config' '/c/x.json' --model 'sonnet' --permission-mode auto "$ERIDANI_PROMPT"`);
    expect(launchCommand('codex', 'gpt-5', { bin: '/opt/codex' }, true)).toBe(`'/opt/codex' --disable daemon_auto_start -m 'gpt-5' "$ERIDANI_PROMPT"`);
    const b = { harness: 'claude', model: 'sonnet' } as EridaniBinding;
    expect(resumeLine(b, undefined, 's-1')).toBe(`'claude' --resume 's-1' --model 'sonnet' --permission-mode auto`);
    expect(resumeLine({ ...b, harness: 'codex' }, undefined, 's-1')).toBe(`'codex' resume --disable daemon_auto_start -m 'sonnet' 's-1'`);
  });

  it('preserves precise managed MCP scope without replacing its allow list during native resume', () => {
    const b = { harness: 'claude', model: 'sonnet', mode: 'review' } as EridaniBinding;
    const line = resumeLine(b, undefined, 's-1', ['--allowedTools', 'Read', 'mcp__eridani__submit_plan_review', '--disallowedTools', 'Edit', 'Write', 'NotebookEdit', '--strict-mcp-config']);
    expect(line).toContain('mcp__eridani__submit_plan_review'); expect(line!.match(/--allowedTools/g)).toHaveLength(1); expect(line).toContain('--permission-mode dontAsk');
  });

  it('a resume keeps the binding\'s mode: the conversation reopens read-only', () => {
    const b = { harness: 'claude', model: 'sonnet', mode: 'review' } as EridaniBinding;
    expect(resumeLine(b, undefined, 's-1', ['--mcp-config', '/c/x.json'])).toBe(`'claude' --resume 's-1' '--mcp-config' '/c/x.json' ${CLAUDE_LISTS} --model 'sonnet' --permission-mode dontAsk`);
    expect(resumeLine({ ...b, harness: 'codex', mode: 'plan' }, undefined, 's-1')).toBe(`'codex' resume --disable daemon_auto_start -m 'sonnet' --sandbox read-only --ask-for-approval never 's-1'`);
  });

  it('a harness without a read-only launch is refused, never launched writable', () => {
    expect(readOnlyFlags('claude')).not.toBeNull();
    expect(readOnlyFlags('codex')).not.toBeNull();
    expect(readOnlyFlags('opencode')).toBeNull();
    expect(() => launchCommand('opencode' as 'claude', 'm', {}, true, [], 'review')).toThrow(/no read-only launch/);
    expect(resumeLine({ harness: 'opencode', model: 'm', mode: 'review' } as unknown as EridaniBinding, undefined, 's-1')).toBeNull();
    expect(MODE_UNSUPPORTED).toBe('mode_unsupported');
  });
});

describe('hyperplan: spawn shape and caps', () => {
  it('validates role and mode; the fields are optional', () => {
    expect(commandShapeError(spawn())).toBeNull();
    expect(commandShapeError(spawn({ role: 'reviewer', mode: 'review', share: true }))).toBeNull();
    expect(commandShapeError(spawn({ role: 'worker' }))).toBeNull();
    expect(commandShapeError(spawn({ mode: 'plan' }))).toBeNull();
    expect(commandShapeError(spawn({ role: 'judge' }))).toBe('bad role');
    expect(commandShapeError(spawn({ mode: 'write' }))).toBe('bad mode');
    expect(commandShapeError(spawn({ role: 1 }))).toBe('bad role');
  });

  it('runs.snapshot entries may name a surf or an attempt', () => {
    const env = (b: Record<string, unknown>) => ({ v: 1, id: 'x', conn_epoch: 1, at: 1, ...b });
    expect(parseDownFrame(env({ t: 'runs.snapshot', runs: [{ run_id: 'r', generation: 1, desired: 'stop', stop_mode: 'kill', surf: REVIEWER }] }))).not.toBeNull();
    expect(parseDownFrame(env({ t: 'runs.snapshot', runs: [{ run_id: 'r', generation: 1, desired: 'continue', attempt: 2 }] }))).not.toBeNull();
    expect(parseDownFrame(env({ t: 'runs.snapshot', runs: [{ run_id: 'r', generation: 1, desired: 'continue', surf: 7 }] }))).toBeNull();
    expect(parseDownFrame(env({ t: 'runs.snapshot', runs: [{ run_id: 'r', generation: 1, desired: 'continue', attempt: 0 }] }))).toBeNull();
  });

  it('spawn.roles is a stage F cap, in both collector modes', () => {
    expect(STAGE_F_CAPS).toContain('spawn.roles');
    expect(STAGE_F_AUTHORITATIVE_CAPS).toContain('spawn.roles');
    expect(linkCaps(null)).toContain('spawn.roles');
    expect(linkCaps('authoritative')).toContain('spawn.roles');
  });
});

describe('hyperplan: a reviewer beside its planner', () => {
  it('a reviewer spawn (role, mode, share) starts in the planner\'s worktree read-only and is recorded as such', async () => {
    const { run, sp, registry } = setup();
    const planner = await run(spawn());
    expect(planner.state).toBe('executed');
    expect(sp.last().req.cmd).toBe(`'claude' --model 'sonnet' --permission-mode auto "$ERIDANI_PROMPT"`);
    const reviewer = await run(spawn({ attempt: 2, harness: 'codex', model: 'gpt-5', role: 'reviewer', mode: 'review', share: true }));
    expect(reviewer).toMatchObject({ state: 'executed', result: { surf: REVIEWER, worktree: planner.result!.worktree, role: 'reviewer', mode: 'review' } });
    expect(sp.last().req.cmd).toBe(`'codex' --disable daemon_auto_start -m 'gpt-5' --sandbox read-only --ask-for-approval never "$ERIDANI_PROMPT"`);
    expect(sp.last().req.env).toMatchObject({ ERIDANI_ROLE: 'reviewer', ERIDANI_MODE: 'review', ERIDANI_RUN_ID: 'run-1', ERIDANI_ATTEMPT: '2' });
    expect(registry.session(REVIEWER)!.eridani).toMatchObject({ runId: 'run-1', attempt: 2, role: 'reviewer', mode: 'review', harness: 'codex' });
    // The planner's record and facts carry neither field: an old Eridani sees exactly what it did.
    expect(registry.session(PLANNER)!.eridani).not.toHaveProperty('role');
    expect(registry.session(PLANNER)!.eridani).not.toHaveProperty('mode');
    expect(planner.result).not.toHaveProperty('role');
    expect(sp.ptys[0].req.env).not.toHaveProperty('ERIDANI_ROLE');
  });

  it('a read-only spawn needs no share to sit beside the writer, and is not a writer itself', async () => {
    const { run, registry, hub } = setup();
    await run(spawn());
    // Read-only: starts without `share` (it writes nothing); a writable one still needs it.
    expect((await run(spawn({ attempt: 2, role: 'reviewer', mode: 'review' }))).state).toBe('executed');
    expect((await run(spawn({ run_id: 'run-2' }))).detail).toBe(WORKTREE_BUSY);
    expect(liveWriters(registry.sessions()).map((w) => [w.writer.surf, w.readOnly ?? false])).toEqual([[PLANNER, false], [REVIEWER, true]]);
    // Once the planner has exited, the live reviewer does not block the next writable spawn (the worker at handoff).
    hub.updateRecord(PLANNER, { state: 'exited' });
    const worker = await run(spawn({ attempt: 3, role: 'worker' }));
    expect(worker.state).toBe('executed');
    expect(worker.result).toMatchObject({ role: 'worker' });
    expect(worker.result).not.toHaveProperty('mode');
  });

  it('read-only spawns count toward limits.maxRuns', async () => {
    const { run } = setup({ ...TARGET, limits: { maxRuns: 2 } });
    expect((await run(spawn())).state).toBe('executed');
    expect((await run(spawn({ attempt: 2, role: 'reviewer', mode: 'review', share: true }))).state).toBe('executed');
    expect(await run(spawn({ run_id: 'run-2', target: { id: 'proj', branch: 'eri/other' } }))).toMatchObject({ state: 'rejected', detail: TARGET_BUSY, result: { limit: 2, running: 2 } });
  });

  it('a runs.snapshot entry for the reviewer\'s surf stops it and leaves the planner alone; one with neither surf nor attempt still reaches every session', async () => {
    const { run, dispatch, registry, sp } = setup();
    await run(spawn());
    await run(spawn({ attempt: 2, role: 'reviewer', mode: 'review', share: true }));
    dispatch.applyRunsSnapshot([
      { run_id: 'run-1', generation: 1, desired: 'continue', surf: PLANNER },
      { run_id: 'run-1', generation: 1, desired: 'stop', stop_mode: 'kill', surf: REVIEWER },
    ]);
    expect(registry.session(REVIEWER)!.eridani!.stopRequested).toMatchObject({ mode: 'kill' });
    expect(registry.session(PLANNER)!.eridani!.stopRequested).toBeUndefined();
    await until(() => sp.ptys[1].killed.length > 0);
    expect(sp.ptys[0].killed).toEqual([]);
    // By attempt: only the planner's generation advances.
    dispatch.applyRunsSnapshot([{ run_id: 'run-1', generation: 3, desired: 'continue', attempt: 1 }]);
    expect(registry.session(PLANNER)!.eridani!.generation).toBe(3);
    expect(registry.session(REVIEWER)!.eridani!.generation).toBe(1);
    // An entry naming a surface of another run touches nothing.
    dispatch.applyRunsSnapshot([{ run_id: 'run-2', generation: 9, desired: 'stop', surf: PLANNER }]);
    expect(registry.session(PLANNER)!.eridani).toMatchObject({ generation: 3 });
    expect(registry.session(PLANNER)!.eridani!.stopRequested).toBeUndefined();
    // Legacy entry (no surf, no attempt): every session of the run, as before.
    dispatch.applyRunsSnapshot([{ run_id: 'run-1', generation: 4, desired: 'continue' }]);
    expect(registry.session(PLANNER)!.eridani!.generation).toBe(4);
    expect(registry.session(REVIEWER)!.eridani!.generation).toBe(4);
  });

  it('verify binds to the newest non-reviewer session: a newer reviewer is skipped, and a run with only reviewers has no bound session', async () => {
    const { run, dispatch, hub } = setup();
    const verify = (over: Record<string, unknown> = {}) => ({ t: 'verify', op_id: `op-v-${++op}`, digest: 'd', run_id: 'run-1', generation: 1, verify_id: 'test', plan_revision: 1, expires_at: Date.now() + 60_000, ...over });
    await run(spawn({ verify: { verify_id: 'test', plan_revision: 1 } }));
    // Reviewer in a newer generation: without the role rule it would be "the newest session".
    await run(spawn({ attempt: 2, generation: 2, role: 'reviewer', mode: 'review', share: true }));
    expect(dispatch.precheck(verify() as CommandBody)).toBeNull();
    expect(dispatch.precheck(verify({ generation: 2 }) as CommandBody)).toBe('stale generation');
    // Handoff: the planner is stopped, a worker (newer, non-reviewer) takes over.
    hub.updateRecord(PLANNER, { state: 'exited' });
    expect((await run(spawn({ attempt: 3, generation: 3, role: 'worker' }))).state).toBe('executed');
    expect(dispatch.precheck(verify({ generation: 3 }) as CommandBody)).toBeNull();
    expect(dispatch.precheck(verify() as CommandBody)).toBe('stale generation');
    // Only reviewers left: no bound session.
    const only = setup();
    await only.run(spawn({ attempt: 2, role: 'reviewer', mode: 'review' }));
    expect(only.dispatch.precheck(verify() as CommandBody)).toBe('unknown run');
  });
});

type Frame = UpFrame & Record<string, unknown>;

/** A fake Eridani: welcomes, acks every op, sends commands and keeps outcomes. */
class FakeEridani {
  readonly wss: WebSocketServer;
  readonly frames: Frame[] = [];
  epoch = 0;
  private ws: WebSocket | null = null;
  constructor() {
    this.wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    this.wss.on('connection', (ws: WebSocket) => {
      this.ws = ws;
      ws.on('message', (data) => {
        const raw = JSON.parse(String(data)) as Record<string, unknown>;
        if (raw.t === 'ack') return;
        const f = parseUpFrame(raw) as Frame | null;
        if (!f) return;
        this.frames.push(f);
        if (f.t === 'hello') this.send({ t: 'welcome', host_id: 'host-1', conn_epoch: ++this.epoch, server_time: Date.now(), caps: [] });
        else if ('op_id' in f) this.send({ t: 'ack', acked_id: f.id, ok: true });
      });
    });
  }
  get url(): string {
    return `ws://127.0.0.1:${(this.wss.address() as { port: number }).port}/link`;
  }
  get connected(): boolean {
    return !!this.ws;
  }
  send(body: Record<string, unknown>): void {
    this.ws!.send(JSON.stringify({ v: 1, id: `e-${Math.random().toString(36).slice(2)}`, conn_epoch: this.epoch, at: Date.now(), ...body }));
  }
  outcome(op: string): Frame | undefined {
    return this.frames.find((f) => f.t === 'command.outcome' && f.command_id === op);
  }
  close(): Promise<void> {
    for (const s of this.wss.clients) s.terminate();
    return new Promise((r) => this.wss.close(() => r()));
  }
}

describe('hyperplan over the link', () => {
  it('hello advertises spawn.roles; a reviewer spawn and a per-surface runs.snapshot go through the link', async () => {
    const eri = new FakeEridani();
    cleanups.push(() => eri.close());
    await new Promise((r) => eri.wss.once('listening', r));
    const { registry, dispatch, sp } = setup();
    const link = new EridaniLink({
      url: eri.url,
      token: () => 'eri_bot_test0123456789',
      dir: null,
      serverId: 'srv-1',
      bootId: 'boot-1',
      hostname: 'box',
      machine: 'box',
      version: '9.9.9',
      snapshot: () => [],
      caps: () => linkCaps(null),
      handlers: dispatch.handlers(),
      precheck: (cmd) => dispatch.precheck(cmd),
      acceptFacts: (cmd) => dispatch.acceptFacts(cmd),
      onRunsSnapshot: (runs) => dispatch.applyRunsSnapshot(runs),
      rand: () => 0.5,
    });
    cleanups.push(() => link.stop());
    link.start();
    await until(() => eri.frames.some((f) => f.t === 'hello') && link.ready);
    expect((eri.frames.find((f) => f.t === 'hello') as Frame & { caps: string[] }).caps).toContain('spawn.roles');

    // The link recomputes the digest and refuses a body whose stated digest differs, so none is sent (as Eridani may).
    const cmd = ({ digest: _d, ...body }: Record<string, unknown>) => {
      const id = `op-link-${++op}`;
      eri.send({ ...body, op_id: id, command_id: id });
      return id;
    };
    const planner = cmd(spawn());
    await until(() => !!eri.outcome(planner));
    expect(eri.outcome(planner)).toMatchObject({ state: 'executed', result: { surf: PLANNER } });
    const reviewer = cmd(spawn({ attempt: 2, role: 'reviewer', mode: 'review', share: true }));
    await until(() => !!eri.outcome(reviewer));
    expect(eri.outcome(reviewer)).toMatchObject({ state: 'executed', result: { surf: REVIEWER, role: 'reviewer', mode: 'review' } });
    expect(sp.last().req.cmd).toBe(`'claude' ${CLAUDE_LISTS} --model 'sonnet' --permission-mode dontAsk "$ERIDANI_PROMPT"`);
    const bad = cmd(spawn({ attempt: 3, role: 'critic' }));
    await until(() => !!eri.outcome(bad));
    expect(eri.outcome(bad)).toMatchObject({ state: 'rejected', detail: 'bad role' });

    eri.send({ t: 'runs.snapshot', runs: [
      { run_id: 'run-1', generation: 1, desired: 'continue', surf: PLANNER },
      { run_id: 'run-1', generation: 1, desired: 'stop', stop_mode: 'kill', surf: REVIEWER },
    ] });
    await until(() => !!registry.session(REVIEWER)?.eridani?.stopRequested);
    expect(registry.session(PLANNER)!.eridani!.stopRequested).toBeUndefined();
  });
});
