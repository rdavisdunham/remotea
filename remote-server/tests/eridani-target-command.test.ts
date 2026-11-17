/**
 * `target.setup` (eridani-target-command.ts): Eridani's "add a target"
 * through the CLI's guided setup. A proposal runs no check and writes
 * nothing; a confirm asks no harness, runs each check once in the sandbox,
 * keeps the passing ones, saves, and the runtime sends a new hello listing
 * the target. A confirm that does not match its repository, carries more
 * than a proposal has, arrives while another setup runs, has expired, or
 * needs a sandbox the host lacks writes nothing. The harness and the check
 * are injected: no test launches a real harness or bwrap.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { commandShapeError, parseUpFrame, STAGE_F_CAPS, type TargetSetupCommand, type UpFrame } from '../../src/shared/eridani-link-protocol';
import { saveEridaniConfig, writeEridaniToken } from '../src/config';
import { confirmedProposal, recoverTargetSetup, runTargetSetupCommand, TARGET_SETUP_BUSY, type TargetSetupCommandDeps } from '../src/eridani-target-command';
import type { CheckFn, InspectFn } from '../src/eridani-target-setup';
import { loadTargets, saveTarget } from '../src/eridani-targets';
import { EridaniRuntime } from '../src/eridani-runtime';
import { Hub } from '../src/hub';
import { Registry } from '../src/registry';
import type { ProbeFn } from '../src/launch-caps';
import type { VerifyOutcome } from '../src/verify-runner';
import { fakeSpawner, ManualTimers } from './helpers';

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function tmpDir(prefix = 'remotea-target-cmd-'): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

/** A git repository on `main` with one commit and the given files. */
function repoWith(files: Record<string, string> = {}): string {
  const repo = path.join(tmpDir(), 'app');
  fs.mkdirSync(repo);
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  for (const [f, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true });
    fs.writeFileSync(path.join(repo, f), text);
  }
  execFileSync('git', ['-C', repo, 'add', '-A']);
  execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init']);
  return repo;
}

const ANSWER = JSON.stringify({
  base: 'main',
  prepare: [{ id: 'deps', argv: ['npm', 'ci'] }],
  verify: [
    { id: 'test', argv: ['npm', 'test'], why: 'the unit tests' },
    { id: 'lint', argv: ['npm', 'run', 'lint'], why: 'the linter' },
  ],
  notes: 'needs node 22',
});

const probeOnly = (...installed: Array<'claude' | 'codex'>): ProbeFn => async (h) => (installed.includes(h as 'claude' | 'codex') ? { ok: true, version: '9.9.9' } : { ok: false, version: null, error: 'not found' });

function fakeInspect(text = ANSWER) {
  const calls: Array<{ harness: string; model: string | null }> = [];
  const fn: InspectFn = async (harness, _bin, _repo, _prompt, model) => {
    calls.push({ harness, model });
    return { ok: true, text };
  };
  return { fn, calls };
}

function outcome(over: Partial<VerifyOutcome> = {}): VerifyOutcome {
  return { workspace_fingerprint: 'x:y', exit_code: 0, tail: 'ok\n', truncated: false, duration_ms: 1234, timed_out: false, canceled: false, stale_workspace: false, isolated: true, isolation: 'bwrap', ...over };
}

/** A trial where each check id gets its own outcome (default: passed). */
function fakeCheck(by: Record<string, Partial<VerifyOutcome>> = {}) {
  const calls: Array<Parameters<CheckFn>[0]> = [];
  const fn: CheckFn = async (spec) => {
    calls.push(spec);
    return outcome(by[spec.id] ?? {});
  };
  return { fn, calls };
}

let opSeq = 0;
function cmd(over: Partial<TargetSetupCommand> & { repo: string }): TargetSetupCommand {
  return { t: 'target.setup', op_id: `op-ts-${++opSeq}`, digest: '', target_id: null, harness: null, model: null, confirm: false, expires_at: Date.now() + 600_000, ...over };
}

function deps(over: Partial<TargetSetupCommandDeps> = {}): TargetSetupCommandDeps & { inspect: InspectFn; check: ReturnType<typeof fakeCheck>; asked: ReturnType<typeof fakeInspect> } {
  const asked = fakeInspect();
  const check = fakeCheck();
  return { dir: tmpDir(), home: tmpDir('remotea-target-cmd-home-'), env: { PATH: '/usr/bin:/bin' }, probe: probeOnly('claude'), inspect: asked.fn, runCheck: check.fn, sandbox: () => null, asked, check, ...over };
}

/** Propose, as Eridani's first call does; returns the proposal's target. */
async function propose(repo: string, d: TargetSetupCommandDeps): Promise<Record<string, unknown>> {
  const r = await runTargetSetupCommand(cmd({ repo }), d);
  expect(r.outcome.state).toBe('executed');
  return (r.outcome.result as { target: Record<string, unknown> }).target;
}

// ── Shape ──────────────────────────────────────────────────────────────────

describe('target.setup command shape', () => {
  const base = { t: 'target.setup', op_id: 'op-1', repo: '/home/u/app', target_id: null, harness: null, model: null, confirm: false, expires_at: Date.now() + 60_000 };
  it('accepts a proposal and a confirm, refuses the rest', () => {
    expect(STAGE_F_CAPS).toContain('target.setup');
    expect(commandShapeError(base)).toBeNull();
    expect(commandShapeError({ ...base, target_id: 'app', harness: 'codex', model: 'gpt-6.1' })).toBeNull();
    expect(commandShapeError({ ...base, confirm: true, target: { id: 'app' } })).toBeNull();
    expect(commandShapeError({ ...base, expires_at: undefined })).toBe('expires_at required');
    expect(commandShapeError({ ...base, repo: 'relative/app' })).toBe('repo: an absolute path on the host');
    expect(commandShapeError({ ...base, repo: `/${'x'.repeat(1000)}` })).toBe('repo: an absolute path on the host');
    expect(commandShapeError({ ...base, repo: '/a\nb' })).toBe('repo: an absolute path on the host');
    expect(commandShapeError({ ...base, target_id: '../x' })).toMatch(/^target_id/);
    expect(commandShapeError({ ...base, harness: 'gemini' })).toMatch(/^harness/);
    expect(commandShapeError({ ...base, model: '--dangerously' })).toBe('bad model');
    expect(commandShapeError({ ...base, confirm: 'yes' })).toMatch(/^confirm/);
    expect(commandShapeError({ ...base, confirm: true })).toBe('confirm needs the proposed target');
    expect(commandShapeError({ ...base, confirm: true, target: [] })).toBe('confirm needs the proposed target');
    expect(commandShapeError({ ...base, target: { id: 'app' } })).toBe('target only with confirm');
  });
});

// ── Propose ────────────────────────────────────────────────────────────────

describe('target.setup: propose (confirm false)', () => {
  it('asks the harness, runs no check, writes nothing, and returns the --json object', async () => {
    const repo = repoWith({ 'package-lock.json': '{}', '.github/workflows/ci.yml': 'on: [pull_request]\njobs: {}\n' });
    const d = deps();
    const r = await runTargetSetupCommand(cmd({ repo, harness: 'claude', model: 'sonnet' }), d);
    expect(r.saved).toBeNull();
    expect(r.outcome).toMatchObject({
      state: 'executed',
      result: {
        saved: false,
        source: 'harness',
        harness: { asked: 'claude', version: '9.9.9', model: 'sonnet' },
        target: { id: 'app', repo, base: 'main', launch: { claude: {} }, prepare: [{ id: 'deps', argv: ['npm', 'ci'], timeout: 900 }] },
        replaces: null,
        ci: { pull_request: true, workflows: ['ci.yml'] },
        gate: 'local',
        notes: ['needs node 22'],
      },
    });
    const result = r.outcome.result as { checks: Array<Record<string, unknown>>; target: { verify: unknown[] } };
    expect(result.checks.map((c) => [c.id, c.status, c.needs_confirmation, c.kept])).toEqual([['test', 'not_run', true, true], ['lint', 'not_run', true, true]]);
    expect(result.target.verify).toHaveLength(2);
    expect(d.asked.calls).toEqual([{ harness: 'claude', model: 'sonnet' }]);
    expect(d.check.calls).toEqual([]);
    expect(loadTargets(d.dir)).toEqual([]);
  });

  it('makes a proposal on a host without the sandbox (the sandbox is only for the trial)', async () => {
    const repo = repoWith();
    const d = deps({ sandbox: () => 'bwrap (bubblewrap) is not installed on the service PATH' });
    expect((await runTargetSetupCommand(cmd({ repo }), d)).outcome.state).toBe('executed');
  });

  it('a missing folder or a folder that is not a git repository fails plainly', async () => {
    const d = deps();
    const gone = path.join(tmpDir(), 'nope');
    expect((await runTargetSetupCommand(cmd({ repo: gone }), d)).outcome).toEqual({ state: 'failed', detail: `${gone} does not exist on this host` });
    const plain = tmpDir();
    expect((await runTargetSetupCommand(cmd({ repo: plain }), d)).outcome).toEqual({ state: 'failed', detail: `${plain} is not a git repository` });
  });

  it('an id taken by another repository fails with the reason', async () => {
    const repo = repoWith();
    const d = deps();
    saveTarget(d.dir, { id: 'app', repo: '/srv/other', worktreeRoot: '/srv/other-wt', base: 'main', launch: { claude: {} }, verify: [] });
    expect((await runTargetSetupCommand(cmd({ repo, target_id: 'app' }), d)).outcome).toMatchObject({ state: 'failed', detail: expect.stringContaining('target id app is taken by /srv/other') });
  });

  it('redacts secrets in what leaves the host', async () => {
    const repo = repoWith();
    const d = deps({ inspect: fakeInspect(JSON.stringify({ base: 'main', verify: [], notes: 'export TOKEN=abcdefghijklmnop before testing' })).fn });
    const r = await runTargetSetupCommand(cmd({ repo }), d);
    expect((r.outcome.result as { notes: string[] }).notes).toEqual(['export [redacted] before testing']);
  });
});

// ── Confirm ────────────────────────────────────────────────────────────────

describe('target.setup: confirm', () => {
  it('asks no harness, runs each check once in the sandbox, keeps the passing ones, saves', async () => {
    const repo = repoWith();
    const d = deps();
    const target = await propose(repo, d);
    d.asked.calls.length = 0;
    const check = fakeCheck({ lint: { exit_code: 1, tail: 'lint failed: password=hunter2hunter2\n' } });
    const r = await runTargetSetupCommand(cmd({ repo, confirm: true, target }), { ...d, runCheck: check.fn });
    expect(d.asked.calls).toEqual([]);
    expect(check.calls.map((s) => [s.id, s.argv, s.isolation, s.network, s.timeout])).toEqual([
      ['test', ['npm', 'test'], 'bwrap', false, 600],
      ['lint', ['npm', 'run', 'lint'], 'bwrap', false, 600],
    ]);
    expect(r.saved).toBe('app');
    const result = r.outcome.result as { saved: boolean; source: string; harness: unknown; checks: Array<Record<string, unknown>>; target: { verify: unknown[] } };
    expect(r.outcome.state).toBe('executed');
    expect(result).toMatchObject({ saved: true, source: 'confirmed', harness: { asked: null, version: null, model: null } });
    expect(result.checks.map((c) => [c.id, c.status, c.kept])).toEqual([['test', 'passed', true], ['lint', 'failed', false]]);
    expect(result.checks[1].tail).toBe('lint failed: [redacted]');
    expect(result.target.verify).toEqual([{ id: 'test', argv: ['npm', 'test'], timeout: 7200 }]);
    const saved = loadTargets(d.dir);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ id: 'app', repo, base: 'main', verify: [{ id: 'test', argv: ['npm', 'test'], timeout: 7200 }], prepare: [{ id: 'deps', argv: ['npm', 'ci'], timeout: 900 }] });
  });

  it('keeps the existing target\'s launch, worktreeRoot, mcpKeyFile, limits and migrations; the confirm cannot set them', async () => {
    const repo = repoWith();
    const d = deps();
    saveTarget(d.dir, { id: 'app', repo, worktreeRoot: '/srv/wt', base: 'main', launch: { codex: { bin: '/opt/codex' } }, verify: [], mcpKeyFile: '~/.mcp-key', limits: { maxRuns: 2 }, migrations: { dir: 'migrations' } });
    const target = await propose(repo, d);
    expect(target).toMatchObject({ id: 'app', worktreeRoot: '/srv/wt', launch: { codex: { bin: '/opt/codex' } } });
    const r = await runTargetSetupCommand(cmd({ repo, confirm: true, target: { ...target, worktreeRoot: '/elsewhere', launch: { claude: { bin: '/tmp/evil' } }, mcpKeyFile: '/tmp/k', limits: { maxRuns: 64 } } }), d);
    expect(r.outcome.state).toBe('executed');
    expect(loadTargets(d.dir)).toEqual([expect.objectContaining({ id: 'app', worktreeRoot: '/srv/wt', launch: { codex: { bin: '/opt/codex' } }, mcpKeyFile: '~/.mcp-key', limits: { maxRuns: 2 }, migrations: { dir: 'migrations' } })]);
    expect((r.outcome.result as { replaces: string }).replaces).toBe('app');
  });

  it('honours each entry\'s timeout as proposed', async () => {
    const repo = repoWith();
    const d = deps();
    const target = await propose(repo, d);
    const verify = (target.verify as Array<Record<string, unknown>>).map((v) => ({ ...v, timeout: 1800 }));
    await runTargetSetupCommand(cmd({ repo, confirm: true, target: { ...target, verify } }), d);
    expect(loadTargets(d.dir)[0].verify.map((v) => v.timeout)).toEqual([1800, 1800]);
  });

  it('a target for another repository is refused, nothing run or written', async () => {
    const repo = repoWith();
    const other = repoWith();
    const d = deps();
    const target = await propose(other, d);
    const r = await runTargetSetupCommand(cmd({ repo, confirm: true, target }), d);
    expect(r.outcome).toEqual({ state: 'failed', detail: `the target's repository ${other} is not ${repo}` });
    expect(d.check.calls).toEqual([]);
    expect(loadTargets(d.dir)).toEqual([]);
  });

  it('the same repository through a symlink is the same repository', async () => {
    const repo = repoWith();
    const link = path.join(tmpDir(), 'via-link');
    fs.symlinkSync(repo, link);
    const d = deps();
    const target = await propose(repo, d);
    expect((await runTargetSetupCommand(cmd({ repo: link, confirm: true, target }), d)).outcome.state).toBe('executed');
  });

  it.each([
    ['a shell string', (t: Record<string, unknown>) => ({ ...t, verify: [{ id: 'test', argv: ['sh', '-c', 'npm test'], timeout: 600 }] }), /the target is not valid: verify test: argv runs a command line through sh/],
    ['a sandbox setting', (t: Record<string, unknown>) => ({ ...t, verify: [{ id: 'test', argv: ['npm', 'test'], timeout: 600, isolation: 'none' }] }), /verify test: isolation cannot be set here/],
    ['network access', (t: Record<string, unknown>) => ({ ...t, verify: [{ id: 'test', argv: ['npm', 'test'], timeout: 600, network: true }] }), /verify test: network cannot be set here/],
    ['an environment on a prepare step', (t: Record<string, unknown>) => ({ ...t, prepare: [{ id: 'deps', argv: ['npm', 'ci'], timeout: 900, env: { X: '1' } }] }), /prepare deps: env cannot be set here/],
    ['an unknown key', (t: Record<string, unknown>) => ({ ...t, hooks: [] }), /unknown key "hooks"/],
    ['a bad id', (t: Record<string, unknown>) => ({ ...t, id: 'a b' }), /the target is not valid: id/],
    ['a cwd outside the repository', (t: Record<string, unknown>) => ({ ...t, verify: [{ id: 'test', argv: ['npm', 'test'], cwd: '../x', timeout: 600 }] }), /the target is not valid: verify test: cwd/],
    ['too many checks', (t: Record<string, unknown>) => ({ ...t, verify: ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, argv: ['true'], timeout: 600 })) }), /more than 4 entries/],
  ])('an invalid target is refused: %s', async (_name, change, why) => {
    const repo = repoWith();
    const d = deps();
    const target = await propose(repo, d);
    const r = await runTargetSetupCommand(cmd({ repo, confirm: true, target: change(target) }), d);
    expect(r.outcome).toMatchObject({ state: 'failed', detail: expect.stringMatching(why) });
    expect(d.check.calls).toEqual([]);
    expect(loadTargets(d.dir)).toEqual([]);
  });

  it('target_id must name the target it confirms', async () => {
    const repo = repoWith();
    const d = deps();
    const target = await propose(repo, d);
    expect(confirmedProposal({ repo, target_id: 'other', target })).toEqual({ error: 'target_id other does not match the target\'s id app' });
    expect(confirmedProposal({ repo, target_id: 'app', target })).toMatchObject({ id: 'app' });
  });

  it('without the sandbox a confirm with a check fails with the reason and writes nothing; one without a check saves', async () => {
    const repo = repoWith();
    const d = deps({ sandbox: () => 'bwrap (bubblewrap) is not installed on the service PATH' });
    const target = await propose(repo, d);
    const r = await runTargetSetupCommand(cmd({ repo, confirm: true, target }), d);
    expect(r.outcome).toEqual({ state: 'failed', detail: 'the check cannot be tried: the verify sandbox is required and bwrap (bubblewrap) is not installed on the service PATH; nothing saved' });
    expect(d.check.calls).toEqual([]);
    expect(loadTargets(d.dir)).toEqual([]);
    const none = await runTargetSetupCommand(cmd({ repo, confirm: true, target: { ...target, verify: [] } }), d);
    expect(none).toMatchObject({ saved: 'app', outcome: { state: 'executed', result: { saved: true, gate: 'none', checks: [] } } });
  });

  it('a confirm whose checks ran past expires_at writes nothing', async () => {
    const repo = repoWith();
    let t = 1_000;
    const d = deps({ now: () => t });
    const target = await propose(repo, d);
    const slow: CheckFn = async () => {
      t = 5_000;
      return outcome();
    };
    const r = await runTargetSetupCommand(cmd({ repo, confirm: true, target, expires_at: 2_000 }), { ...d, runCheck: slow });
    expect(r).toEqual({ saved: null, outcome: { state: 'failed', detail: 'the command expired while the checks ran; nothing saved' } });
    expect(loadTargets(d.dir)).toEqual([]);
  });

  it('a restart mid-way: a proposal failed, a confirm uncertain', () => {
    expect(recoverTargetSetup({ confirm: false })).toEqual({ state: 'failed', detail: 'interrupted by a server restart; nothing was written' });
    expect(recoverTargetSetup({ confirm: true })).toMatchObject({ state: 'uncertain', detail: expect.stringContaining('may have been saved') });
    expect(recoverTargetSetup(undefined).state).toBe('failed');
  });
});

// ── On the link ────────────────────────────────────────────────────────────

type Frame = UpFrame & Record<string, unknown>;
type Ack = { t: 'ack'; acked_id: string; op_id?: string; ok: boolean; outcome?: { state: string; detail?: string } };

class FakeEridani {
  readonly wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  readonly frames: Frame[] = [];
  readonly acks: Ack[] = [];
  epoch = 0;
  private ws: WebSocket | null = null;
  constructor() {
    this.wss.on('connection', (ws: WebSocket) => {
      this.ws = ws;
      ws.on('message', (data) => {
        const raw = JSON.parse(String(data)) as Record<string, unknown>;
        if (raw.t === 'ack') {
          this.acks.push(raw as unknown as Ack);
          return;
        }
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
  send(body: Record<string, unknown>): void {
    this.ws!.send(JSON.stringify({ v: 1, id: `e-${Math.random().toString(36).slice(2)}`, conn_epoch: this.epoch, at: Date.now(), ...body }));
  }
  hellos(): Array<{ caps: string[]; targets: Array<{ id: string }> }> {
    return this.frames.filter((f) => f.t === 'hello') as unknown as Array<{ caps: string[]; targets: Array<{ id: string }> }>;
  }
  outcome(op: string): Frame | undefined {
    return this.frames.find((f) => f.t === 'command.outcome' && f.command_id === op);
  }
  ack(op: string): Ack | undefined {
    return this.acks.find((a) => a.op_id === op);
  }
  close(): Promise<void> {
    for (const s of this.wss.clients) s.terminate();
    return new Promise((r) => this.wss.close(() => r()));
  }
}

async function until(cond: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function runtime(inspect: InspectFn) {
  const eri = new FakeEridani();
  cleanups.push(() => eri.close());
  await new Promise((r) => eri.wss.once('listening', r));
  const dir = tmpDir('remotea-target-cmd-rt-');
  writeEridaniToken(dir, 'eri_bot_test0123456789');
  saveEridaniConfig(dir, { enabled: true, url: eri.url, machine: 'setup-box', collector: 'off' });
  const registry = Registry.load({ file: null, bootId: 'boot-1' });
  const hub = new Hub({ registry, spawn: fakeSpawner().spawn, bootId: 'boot-1', serverId: 'srv', hostname: 'box', timers: new ManualTimers(), probe: () => ({}) });
  const rt = new EridaniRuntime({
    dir, hub, registry, serverId: 'srv', bootId: 'boot-1', hostname: 'box', version: '9.9.9', log: () => {},
    windowsUsers: null, checkMs: 3_600_000, scanMs: 3_600_000, resumeAgents: false, doctor: false,
    probe: async () => ({ ok: true, version: '1.0.0' }),
    targetSetup: { inspect, runCheck: fakeCheck().fn, sandbox: () => null, home: tmpDir('remotea-target-cmd-home-') },
  });
  cleanups.push(() => rt.stop());
  rt.start();
  await until(() => eri.hellos().length === 1 && eri.epoch === 1);
  return { eri, dir };
}

describe('target.setup on the link', () => {
  it('is advertised; a proposal is acked at once and reported later; a confirm saves and sends a new hello listing the target', async () => {
    const repo = repoWith();
    const { eri, dir } = await runtime(fakeInspect().fn);
    expect(eri.hellos()[0].caps).toContain('target.setup');
    expect(eri.hellos()[0].targets).toEqual([]);

    eri.send({ t: 'target.setup', op_id: 'op-p', repo, target_id: null, harness: null, model: null, confirm: false, expires_at: Date.now() + 600_000 });
    await until(() => !!eri.outcome('op-p'));
    expect(eri.ack('op-p')?.outcome?.state).toBe('accepted');
    const proposed = eri.outcome('op-p') as unknown as { state: string; kind: string; result: { saved: boolean; target: Record<string, unknown> } };
    expect(proposed).toMatchObject({ state: 'executed', kind: 'target.setup', result: { saved: false, target: { id: 'app' } } });
    expect(loadTargets(dir)).toEqual([]);

    eri.send({ t: 'target.setup', op_id: 'op-c', repo, target_id: 'app', harness: null, model: null, confirm: true, target: proposed.result.target, expires_at: Date.now() + 600_000 });
    await until(() => !!eri.outcome('op-c') && eri.hellos().length === 2);
    expect(eri.outcome('op-c')).toMatchObject({ state: 'executed', kind: 'target.setup', result: { saved: true, source: 'confirmed' } });
    expect(eri.hellos()[1].targets.map((t) => t.id)).toEqual(['app']);
    expect(loadTargets(dir).map((t) => t.id)).toEqual(['app']);
  });

  it('one at a time: a second setup while one runs is rejected; an expired or invalid one is rejected at once', async () => {
    const repo = repoWith();
    let release: () => void = () => {};
    const held = new Promise<void>((r) => (release = r));
    const slow: InspectFn = async () => {
      await held;
      return { ok: true, text: ANSWER };
    };
    const { eri } = await runtime(slow);
    eri.send({ t: 'target.setup', op_id: 'op-1', repo, target_id: null, harness: null, model: null, confirm: false, expires_at: Date.now() + 600_000 });
    await until(() => eri.ack('op-1')?.outcome?.state === 'accepted');
    eri.send({ t: 'target.setup', op_id: 'op-2', repo, target_id: null, harness: null, model: null, confirm: false, expires_at: Date.now() + 600_000 });
    await until(() => !!eri.ack('op-2'));
    expect(eri.ack('op-2')?.outcome).toEqual({ state: 'rejected', detail: TARGET_SETUP_BUSY });
    release();
    await until(() => !!eri.outcome('op-1'));
    expect(eri.outcome('op-1')).toMatchObject({ state: 'executed' });

    eri.send({ t: 'target.setup', op_id: 'op-3', repo, target_id: null, harness: null, model: null, confirm: false, expires_at: Date.now() - 1000 });
    await until(() => !!eri.ack('op-3'));
    expect(eri.ack('op-3')?.outcome).toEqual({ state: 'rejected', detail: 'expired' });

    eri.send({ t: 'target.setup', op_id: 'op-4', repo, target_id: null, harness: null, model: null, confirm: true, target: { id: 'app', repo: '/srv/other', worktreeRoot: '/srv/wt', launch: {}, verify: [] }, expires_at: Date.now() + 600_000 });
    await until(() => !!eri.ack('op-4'));
    expect(eri.ack('op-4')?.outcome).toEqual({ state: 'rejected', detail: `the target's repository /srv/other is not ${repo}` });

    eri.send({ t: 'target.setup', op_id: 'op-5', repo: '/nowhere/at/all', target_id: null, harness: null, model: null, confirm: false, expires_at: Date.now() + 600_000 });
    await until(() => !!eri.ack('op-5'));
    expect(eri.ack('op-5')?.outcome).toEqual({ state: 'rejected', detail: '/nowhere/at/all does not exist on this host' });
  });
});
