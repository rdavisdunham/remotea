/**
 * Restart run (cap `spawn.resume`): a spawn with `resume_session_id` continues
 * the earlier Claude conversation when its transcript exists for the worktree,
 * else starts fresh; the executed outcome says which (`result.resumed`).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';
import { afterEach, describe, expect, it } from 'vitest';
import { Hub } from '../src/hub';
import { Registry } from '../src/registry';
import { claudeTranscriptExists, Dispatch, surfFor, type DispatchDeps } from '../src/dispatch';
import { linkCaps } from '../src/eridani-runtime';
import type { HarnessSpec, RuntimeAdapter } from '../src/managed-harness';
import { QuestionBroker } from '../src/questions-claude';
import type { CommandContext, CommandResult } from '../src/eridani-link';
import type { ExecutionTarget } from '../src/eridani-targets';
import type { WorktreeManager } from '../src/worktrees';
import { commandShapeError, STAGE_F_AUTHORITATIVE_CAPS, STAGE_F_CAPS, type CommandBody } from '../../src/shared/eridani-link-protocol';
import { fakeSpawner, ManualTimers } from './helpers';

const cleanups: Array<() => unknown> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-resume-'));
  cleanups.push(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

const TARGET: ExecutionTarget = {
  id: 'proj',
  repo: '/repo',
  worktreeRoot: '/wt',
  base: 'main',
  launch: { claude: {}, codex: { bin: '/opt/codex' } },
};

const WORKTREE = '/wt/eri--task-1';
const OLD = '4b1c0d2e-1111-4222-8333-944455556666';

/** Claude's transcript of `id` for `cwd`, as Claude itself would leave it. */
function transcript(config: string, cwd: string, id: string, folder = cwd.replace(/[^a-zA-Z0-9]/g, '-')): void {
  const dir = path.join(config, 'projects', folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), '{}\n');
}

class FakeManagedAdapter extends EventEmitter implements RuntimeAdapter {
  inputs: string[] = [];
  constructor(private readonly spec: HarnessSpec) { super(); }
  async start() { return this.spec.sessionId ?? 'fresh-managed-session'; }
  async resume() { return this.start(); }
  async send(text: string) { this.inputs.push(text); }
  async sendDirect(text: string, _id: string, context: { turnId: string | null }) { this.inputs.push(text); return { turnId: context.turnId, providerAcknowledged: true }; }
  async interrupt() {}
  async respond() {}
  async stop() {}
}

function setup(opts: { managedFactory?: DispatchDeps['managedFactory'] } = {}) {
  const config = tmpDir();
  const registry = Registry.load({ file: null, bootId: 'boot-1' });
  const sp = fakeSpawner();
  const hub = new Hub({ registry, spawn: sp.spawn, bootId: 'boot-1', serverId: 'srv', hostname: 'box', timers: new ManualTimers(), probe: () => ({}) });
  const worktrees = {
    ensure: async (t: ExecutionTarget, branch: string, base: string) => ({ path: `${t.worktreeRoot}/${branch.replace(/\//g, '--')}`, branch, base, baseSha: 'abc123', created: false }),
  } as unknown as WorktreeManager;
  const questions = new QuestionBroker({ session: (id) => registry.session(id), canHold: () => true, emit: () => {}, needsYou: () => {} });
  const logs: string[] = [];
  const dispatch = new Dispatch({
    hub, registry, dir: null, worktrees, targets: () => [TARGET], questions,
    managedFactory: opts.managedFactory,
    emit: () => {}, linkReady: () => true, log: (m) => logs.push(m),
    claudeConfigDir: config,
  });
  hub.setEridani(dispatch.hubHooks());
  const h = dispatch.handlers();
  const run = async (cmd: Record<string, unknown>): Promise<CommandResult> => {
    const pre = dispatch.precheck(cmd as CommandBody);
    if (pre) return { state: 'rejected', detail: pre };
    const ctx: CommandContext = { begin: () => {} };
    return h[cmd.t as string](cmd as CommandBody, ctx);
  };
  return { config, registry, sp, dispatch, run, logs };
}

const spawnCmd = (over: Record<string, unknown> = {}) => ({
  t: 'spawn',
  op_id: 'op-restart-1',
  digest: 'd',
  run_id: 'run-2',
  generation: 1,
  attempt: 1,
  harness: 'claude',
  model: 'sonnet',
  target: { id: 'proj', branch: 'eri/task-1' },
  task_id: 'task-1',
  prompt: 'Also handle the empty list',
  run_token: 'tok-123',
  resume_session_id: OLD,
  expires_at: Date.now() + 60_000,
  ...over,
});

describe('spawn.resume: cap and shape', () => {
  it('is advertised in every collector mode', () => {
    expect(STAGE_F_CAPS).toContain('spawn.resume');
    expect(STAGE_F_AUTHORITATIVE_CAPS).toContain('spawn.resume');
    expect(linkCaps(null)).toContain('spawn.resume');
    expect(linkCaps('authoritative')).toContain('spawn.resume');
  });

  it('accepts the ids a resume line accepts; anything else is rejected "bad resume_session_id" (the link admits no malformed frame)', () => {
    expect(commandShapeError(spawnCmd())).toBeNull();
    expect(commandShapeError(spawnCmd({ resume_session_id: 'sess-abc.1:2_3' }))).toBeNull();
    for (const bad of ['', 'a b', '../x', 'x/y', '$(rm -rf /)', 'x'.repeat(129), 42, null]) {
      expect(commandShapeError(spawnCmd({ resume_session_id: bad }))).toBe('bad resume_session_id');
    }
  });
});

describe('spawn.resume: native Claude', () => {
  it('resumes the conversation when its transcript exists for the worktree, with the prompt as the first message', async () => {
    const { config, run, sp, registry } = setup();
    transcript(config, WORKTREE, OLD);
    const res = await run(spawnCmd());
    const surf = surfFor('run-2', 1, 1);
    expect(res).toMatchObject({ state: 'executed', result: { surf, incarnation: 1, worktree: WORKTREE, resumed: true } });
    const req = sp.last().req;
    expect(req.cwd).toBe(WORKTREE);
    expect(req.cmd).toBe(`'claude' --resume '${OLD}' --model 'sonnet' --permission-mode auto "$ERIDANI_PROMPT"`);
    expect(req.env).toMatchObject({ ERIDANI_PROMPT: 'Also handle the empty list', ERIDANI_RUN_TOKEN: 'tok-123', ERIDANI_RUN_ID: 'run-2' });
    const rec = registry.session(surf)!;
    expect(rec.agent).toMatchObject({ provider: 'claude', sessionId: OLD });
    expect(rec.eridani).toMatchObject({ runId: 'run-2', resume: { sessionId: OLD, resumed: true } });
  });

  it('keeps the effort and the read-only launch of the spawn in the resume line', async () => {
    const { config, run, sp } = setup();
    transcript(config, WORKTREE, OLD);
    await run(spawnCmd({ effort: 'high', role: 'planner', mode: 'plan' }));
    const cmd = sp.last().req.cmd;
    expect(cmd.startsWith(`'claude' --resume '${OLD}' `)).toBe(true);
    expect(cmd).toContain(`--effort 'high'`);
    expect(cmd).toContain('--permission-mode dontAsk');
    expect(cmd.endsWith(' "$ERIDANI_PROMPT"')).toBe(true);
  });

  it('an empty prompt appends nothing, so the resumed agent waits at its prompt', async () => {
    const { config, run, sp } = setup();
    transcript(config, WORKTREE, OLD);
    const res = await run(spawnCmd({ prompt: '' }));
    expect(res).toMatchObject({ state: 'executed', result: { resumed: true } });
    const req = sp.last().req;
    expect(req.cmd).toBe(`'claude' --resume '${OLD}' --model 'sonnet' --permission-mode auto`);
    expect(req.env).not.toHaveProperty('ERIDANI_PROMPT');
  });

  it('a missing transcript starts fresh exactly as without the field, and says so', async () => {
    const { config, run, sp, registry, logs } = setup();
    // The conversation exists, but for another directory: Claude would not find it from this worktree.
    transcript(config, '/wt/eri--task-9', OLD);
    const res = await run(spawnCmd());
    const surf = surfFor('run-2', 1, 1);
    expect(res).toMatchObject({ state: 'executed', result: { surf, resumed: false } });
    expect(sp.last().req.cmd).toBe(`'claude' --model 'sonnet' --permission-mode auto "$ERIDANI_PROMPT"`);
    expect(registry.session(surf)!.agent).toBeUndefined();
    expect(registry.session(surf)!.eridani).toMatchObject({ resume: { sessionId: OLD, resumed: false } });
    expect(logs.some((l) => l.includes(`no transcript of ${OLD}`))).toBe(true);
  });

  it('a spawn without the field reports no `resumed`', async () => {
    const { run } = setup();
    const res = await run(spawnCmd({ resume_session_id: undefined }));
    expect(res.state).toBe('executed');
    expect(res.result).not.toHaveProperty('resumed');
  });

  it('replaying the spawn reports the same `resumed`', async () => {
    const { config, run, sp } = setup();
    transcript(config, WORKTREE, OLD);
    await run(spawnCmd());
    const again = await run(spawnCmd());
    expect(again).toMatchObject({ state: 'executed', detail: 'already started', result: { resumed: true } });
    expect(sp.ptys).toHaveLength(1);
  });
});

describe('spawn.resume: other harnesses and managed runs', () => {
  it('a non-Claude harness ignores the field and starts fresh', async () => {
    const { config, run, sp, registry } = setup();
    transcript(config, WORKTREE, OLD);
    const res = await run(spawnCmd({ harness: 'codex', model: 'gpt-6.1-sol' }));
    expect(res).toMatchObject({ state: 'executed', result: { resumed: false } });
    const cmd = sp.last().req.cmd;
    expect(cmd).not.toContain('resume');
    expect(cmd).not.toContain(OLD);
    expect(cmd.endsWith('"$ERIDANI_PROMPT"')).toBe(true);
    expect(registry.session(surfFor('run-2', 1, 1))!.agent).toBeUndefined();
  });

  it('a managed Claude run hands the session id to its adapter, which resumes it and then sends the prompt', async () => {
    const specs: HarnessSpec[] = [];
    const adapters: FakeManagedAdapter[] = [];
    const { config, run, dispatch } = setup({ managedFactory: (spec) => { specs.push(spec); const a = new FakeManagedAdapter(spec); adapters.push(a); return a; } });
    transcript(config, WORKTREE, OLD);
    const res = await run(spawnCmd({ execution: 'managed', permission_profile: 'workspace-write', role: 'worker' }));
    expect(res).toMatchObject({ state: 'executed', result: { resumed: true } });
    const surf = surfFor('run-2', 1, 1);
    await dispatch.managed.ready(surf);
    expect(specs[0].sessionId).toBe(OLD);
    expect(dispatch.managed.sessionId(surf)).toBe(OLD);
    expect(adapters[0].inputs).toEqual([expect.stringContaining('Also handle the empty list')]);
  });

  it('a managed Claude run without the transcript starts a fresh conversation', async () => {
    const specs: HarnessSpec[] = [];
    const { run, dispatch } = setup({ managedFactory: (spec) => { specs.push(spec); return new FakeManagedAdapter(spec); } });
    const res = await run(spawnCmd({ execution: 'managed', permission_profile: 'workspace-write', role: 'worker' }));
    expect(res).toMatchObject({ state: 'executed', result: { resumed: false } });
    const surf = surfFor('run-2', 1, 1);
    await dispatch.managed.ready(surf);
    expect(specs[0].sessionId).toBeUndefined();
    expect(dispatch.managed.sessionId(surf)).toBe('fresh-managed-session');
  });
});

describe('claudeTranscriptExists', () => {
  it('finds the transcript under the folder Claude names after the directory', () => {
    const config = tmpDir();
    transcript(config, '/home/me/wt/proj/eri--t_1.x', 'abc');
    expect(claudeTranscriptExists(config, '/home/me/wt/proj/eri--t_1.x', 'abc')).toBe(true);
    expect(claudeTranscriptExists(config, '/home/me/wt/proj/eri--t_1.x', 'abd')).toBe(false);
    expect(claudeTranscriptExists(config, '/home/me/wt/proj/eri--t_2.x', 'abc')).toBe(false);
  });

  it('matches a long directory by the 200-character prefix Claude keeps (its hash suffix varies by build)', () => {
    const config = tmpDir();
    const cwd = `/wt/${'a'.repeat(250)}`;
    const name = cwd.replace(/[^a-zA-Z0-9]/g, '-');
    transcript(config, cwd, 'abc', `${name.slice(0, 200)}-1x2y3z`);
    expect(claudeTranscriptExists(config, cwd, 'abc')).toBe(true);
    expect(claudeTranscriptExists(config, `/wt/${'a'.repeat(249)}b`, 'abc')).toBe(true); // same first 200 characters
    expect(claudeTranscriptExists(config, `/wt/${'b'.repeat(250)}`, 'abc')).toBe(false);
  });

  it('also tries the real path of a symlinked worktree', () => {
    const config = tmpDir();
    const real = fs.realpathSync(tmpDir());
    const link = path.join(tmpDir(), 'link');
    fs.symlinkSync(real, link);
    transcript(config, real, 'abc');
    expect(claudeTranscriptExists(config, link, 'abc')).toBe(true);
  });
});
