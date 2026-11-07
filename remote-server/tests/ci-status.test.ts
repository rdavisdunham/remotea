/**
 * `ci.status` (Eridani's "CI as the final verification"): GitHub CI's view of
 * a run's pull request, read with the host's `gh`. `gh` and `git` are mocked
 * throughout (an injected exec); nothing here talks to GitHub.
 *
 * Unit: the pr / checks / failed-log / head parsing, `gh`'s exit codes (8 =
 * pending, "no pull requests found", "no checks reported"), redaction of the
 * log tails, a missing or logged-out `gh`. Shape: the command's fence, branch
 * and log_lines checks. Runtime: advertised in hello; an executed outcome
 * carries the result; a branch with no worktree here fails with the reason.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { commandShapeError, parseUpFrame, STAGE_F_CAPS, type UpFrame } from '../../src/shared/eridani-link-protocol';
import { ciFolder, ciStatus, logTail, type Exec, type ExecResult } from '../src/ci-status';
import { saveEridaniConfig, writeEridaniToken } from '../src/config';
import { EridaniRuntime } from '../src/eridani-runtime';
import { saveTarget } from '../src/eridani-targets';
import { Hub } from '../src/hub';
import { Registry } from '../src/registry';
import { branchDir } from '../src/worktrees';
import { fakeSpawner, ManualTimers } from './helpers';

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const HEAD = 'a'.repeat(40);
const PR_JSON = JSON.stringify({ number: 151, url: 'https://github.com/o/r/pull/151', headRefOid: HEAD, state: 'OPEN', baseRefName: 'main', isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'BEHIND' });
const VIEW = ['--json', 'number,url,headRefOid,state,baseRefName,isDraft,mergeable,mergeStateStatus'];
const job = (run: number, id: number) => `https://github.com/o/r/actions/runs/${run}/job/${id}`;

/** A fake `gh`/`git`: answers by the argv's first words; records every call. */
function fakeExec(answers: Record<string, ExecResult | ((args: string[]) => ExecResult)>) {
  const calls: string[][] = [];
  const exec: Exec = async (file, args) => {
    calls.push([file, ...args]);
    const key = file === 'git' ? 'git' : `${args[0]} ${args[1]}`;
    const a = answers[key];
    if (!a) return { code: 1, stdout: '', stderr: `unexpected ${key}` };
    return typeof a === 'function' ? a(args) : a;
  };
  return { exec, calls };
}
const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: '' });

describe('ciStatus', () => {
  it('reads the pull request, its checks and the worktree head', async () => {
    const checks = [
      { name: 'backend', state: 'SUCCESS', bucket: 'pass', link: job(1, 11), workflow: 'CI', startedAt: '2026-11-05T10:00:00Z', completedAt: '2026-11-05T10:20:00Z' },
      { name: 'web', state: 'IN_PROGRESS', bucket: 'pending', link: job(1, 12), workflow: 'CI', startedAt: '2026-11-05T10:00:00Z' },
    ];
    const { exec, calls } = fakeExec({ 'pr view': ok(PR_JSON), 'pr checks': { code: 8, stdout: JSON.stringify(checks), stderr: '' }, git: ok(`${HEAD}\n`) });
    const r = await ciStatus({ cwd: '/w', branch: 'eri/task-1', logLines: 40, exec });
    expect(r).toEqual({
      pr: { number: 151, url: 'https://github.com/o/r/pull/151', head_sha: HEAD, state: 'OPEN', base: 'main', draft: false, mergeable: 'MERGEABLE', merge_state: 'BEHIND' },
      checks,
      failed_logs: [],
      worktree_head: HEAD,
    });
    expect(calls).toEqual([
      ['gh', 'pr', 'view', 'eri/task-1', ...VIEW],
      ['gh', 'pr', 'checks', 'eri/task-1', '--json', 'name,state,bucket,link,workflow,startedAt,completedAt'],
      ['git', 'rev-parse', 'HEAD'],
    ]);
  });

  it('no pull request: pr null, no checks asked', async () => {
    const { exec, calls } = fakeExec({ 'pr view': { code: 1, stdout: '', stderr: 'no pull requests found for branch "eri/x"' }, git: ok(HEAD) });
    const r = await ciStatus({ cwd: '/w', branch: 'eri/x', logLines: 0, exec });
    expect(r).toMatchObject({ pr: null, checks: [], worktree_head: HEAD });
    expect(calls.map((c) => c[2])).toEqual(['view', 'HEAD']);
  });

  it('no checks reported yet: an empty list, not a failure', async () => {
    const { exec } = fakeExec({ 'pr view': ok(PR_JSON), 'pr checks': { code: 1, stdout: '', stderr: "no checks reported on the 'eri/x' branch" }, git: ok(HEAD) });
    expect((await ciStatus({ cwd: '/w', branch: 'eri/x', logLines: 40, exec })).checks).toEqual([]);
  });

  it('a failed job while others are pending: its log tail is read at once, redacted', async () => {
    const checks = [
      { name: 'backend', state: 'FAILURE', bucket: 'fail', link: job(7, 70), workflow: 'CI' },
      { name: 'web', state: 'IN_PROGRESS', bucket: 'pending', link: job(7, 71), workflow: 'CI' },
      { name: 'lint', state: 'FAILURE', bucket: 'fail', link: 'https://example.com/not-actions', workflow: '' },
    ];
    const log = [
      ...Array.from({ length: 60 }, (_, i) => `backend\tRun tests\t2026-11-05T10:00:${String(i % 60).padStart(2, '0')}.0000000Z line ${i}`),
      'backend\tRun tests\t2026-11-05T10:01:00.0000000Z \x1b[31mFAILED\x1b[0m tests/test_x.py::test_y',
      'backend\tRun tests\t2026-11-05T10:01:01.0000000Z token ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    ].join('\n');
    const { exec, calls } = fakeExec({ 'pr view': ok(PR_JSON), 'pr checks': { code: 8, stdout: JSON.stringify(checks), stderr: '' }, 'run view': ok(log), git: ok(HEAD) });
    const r = await ciStatus({ cwd: '/w', branch: 'eri/x', logLines: 40, exec });
    expect(calls).toContainEqual(['gh', 'run', 'view', '7', '--job', '70', '--log-failed']);
    expect(calls.filter((c) => c[1] === 'run')).toHaveLength(1); // the non-Actions check has no log to read
    expect(r.failed_logs).toHaveLength(1);
    const lines = r.failed_logs[0].lines;
    expect(lines).toHaveLength(40);
    expect(lines[38]).toBe('FAILED tests/test_x.py::test_y');
    expect(lines[39]).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    expect(lines[0]).toBe('line 22');
  });

  it('log_lines 0 reads no logs; a log not available yet is skipped', async () => {
    const checks = [{ name: 'backend', state: 'FAILURE', bucket: 'fail', link: job(7, 70), workflow: 'CI' }];
    // gh pr checks exits 1 when a check failed; the JSON is still printed.
    const base = { 'pr view': ok(PR_JSON), 'pr checks': { code: 1, stdout: JSON.stringify(checks), stderr: '' }, git: ok(HEAD) };
    const none = fakeExec(base);
    await expect(ciStatus({ cwd: '/w', branch: 'eri/x', logLines: 0, exec: none.exec })).resolves.toMatchObject({ failed_logs: [] });
    expect(none.calls.some((c) => c[1] === 'run')).toBe(false);
    const later = fakeExec({ ...base, 'run view': { code: 1, stdout: '', stderr: 'log not found' } });
    await expect(ciStatus({ cwd: '/w', branch: 'eri/x', logLines: 40, exec: later.exec })).resolves.toMatchObject({ checks: [{ name: 'backend' }], failed_logs: [] });
  });

  it('a missing gh, a logged-out gh and a bad branch fail with the reason', async () => {
    const missing = fakeExec({ 'pr view': { code: 1, stdout: '', stderr: '', missing: true } });
    await expect(ciStatus({ cwd: '/w', branch: 'eri/x', logLines: 0, exec: missing.exec })).rejects.toThrow(/gh is not installed/);
    const out = fakeExec({ 'pr view': { code: 4, stdout: '', stderr: 'To get started with GitHub CLI, please run:  gh auth login' } });
    await expect(ciStatus({ cwd: '/w', branch: 'eri/x', logLines: 0, exec: out.exec })).rejects.toThrow(/gh pr view: To get started .*gh auth login/);
    for (const b of ['--repo=x', 'a..b', 'a b', '']) {
      await expect(ciStatus({ cwd: '/w', branch: b, logLines: 0, exec: missing.exec })).rejects.toThrow('bad branch');
    }
    expect(missing.calls).toHaveLength(1);
  });

  it('an unreadable head is null', async () => {
    const { exec } = fakeExec({ 'pr view': { code: 1, stdout: '', stderr: 'no pull requests found' }, git: { code: 128, stdout: '', stderr: 'not a git repository' } });
    expect((await ciStatus({ cwd: '/w', branch: 'eri/x', logLines: 0, exec })).worktree_head).toBeNull();
  });

  it('logTail keeps plain lines as they are', () => {
    expect(logTail('a\n\nb\nc\n', 2)).toEqual(['b', 'c']);
  });
});

describe('ci.status command shape', () => {
  const cmd = (over: Record<string, unknown> = {}) => ({ t: 'ci.status', op_id: 'op-1', run_id: 'run-1', generation: 1, branch: 'eri/task-1', turn_seq: 3, log_lines: 40, expires_at: Date.now() + 60_000, ...over });
  it('accepts a well-formed poll and refuses the rest', () => {
    expect(commandShapeError(cmd())).toBeNull();
    expect(commandShapeError(cmd({ log_lines: undefined, turn_seq: null }))).toBeNull();
    expect(commandShapeError(cmd({ expires_at: undefined }))).toBe('expires_at required');
    expect(commandShapeError(cmd({ generation: 'x' }))).toBe('bad fence');
    expect(commandShapeError(cmd({ branch: '-x' }))).toBe('bad branch');
    expect(commandShapeError(cmd({ branch: 'a..b' }))).toBe('bad branch');
    expect(commandShapeError(cmd({ branch: 'a;b' }))).toBe('bad branch');
    expect(commandShapeError(cmd({ log_lines: 201 }))).toBe('bad log_lines');
    expect(commandShapeError(cmd({ log_lines: -1 }))).toBe('bad log_lines');
    expect(commandShapeError(cmd({ target: 'jarvis' }))).toBeNull();
    expect(commandShapeError(cmd({ target: '../x' }))).toBe('bad target');
  });
});

describe('ciFolder', () => {
  it('finds the managed worktree of the branch, else the run folder, else the target repository', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remotea-ci-'));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const target = { id: 'p', repo: path.join(root, 'repo'), worktreeRoot: path.join(root, 'wt'), base: 'main', launch: { claude: {} }, verify: [] };
    expect(ciFolder([target], 'eri/task-1', null)).toBeNull();
    expect(ciFolder([target], 'eri/task-1', root)).toBe(root);
    expect(ciFolder([target], 'eri/task-1', null, 'p')).toBeNull(); // the repository does not exist yet
    fs.mkdirSync(path.join(root, 'repo'));
    expect(ciFolder([target], 'eri/task-1', null, 'p')).toBe(path.join(root, 'repo'));
    expect(ciFolder([target], 'eri/task-1', null, 'other')).toBeNull();
    fs.mkdirSync(path.join(root, 'wt', branchDir('eri/task-1')), { recursive: true });
    expect(ciFolder([target], 'eri/task-1', null)).toBe(path.join(root, 'wt', 'eri--task-1'));
  });
});

// ── Runtime ────────────────────────────────────────────────────────────────

type Frame = UpFrame & Record<string, unknown>;

class FakeEridani {
  readonly wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  readonly frames: Frame[] = [];
  epoch = 0;
  private ws: WebSocket | null = null;
  constructor() {
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

async function until(cond: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function runtime(exec: Exec) {
  const eri = new FakeEridani();
  cleanups.push(() => eri.close());
  await new Promise((r) => eri.wss.once('listening', r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remotea-ci-rt-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  const worktreeRoot = path.join(dir, 'wt');
  fs.mkdirSync(path.join(worktreeRoot, branchDir('eri/task-1')), { recursive: true });
  writeEridaniToken(dir, 'eri_bot_test0123456789');
  saveEridaniConfig(dir, { enabled: true, url: eri.url, machine: 'ci-box', collector: 'off' });
  saveTarget(dir, { id: 'proj', repo, worktreeRoot, base: 'main', launch: { claude: {} }, verify: [{ id: 'quick', argv: ['/bin/true'], timeout: 600, notifyAfter: 300 }] });
  const registry = Registry.load({ file: null, bootId: 'boot-1' });
  const hub = new Hub({ registry, spawn: fakeSpawner().spawn, bootId: 'boot-1', serverId: 'srv', hostname: 'box', timers: new ManualTimers(), probe: () => ({}) });
  const rt = new EridaniRuntime({
    dir, hub, registry, serverId: 'srv', bootId: 'boot-1', hostname: 'box', version: '9.9.9', log: () => {},
    windowsUsers: null, checkMs: 3_600_000, scanMs: 3_600_000, resumeAgents: false,
    probe: async () => ({ ok: true, version: '1.0.0' }),
    ciExec: exec,
    prSleep: async () => {},
  });
  cleanups.push(() => rt.stop());
  rt.start();
  await until(() => eri.frames.some((f) => f.t === 'hello') && eri.frames.some((f) => f.t === 'worktrees.report'));
  return { eri, worktreeRoot };
}

describe('ci.status on the link', () => {
  it('is advertised in hello with each verify entry\'s notify_after_s, and answers with the result', async () => {
    expect(STAGE_F_CAPS).toContain('ci.status');
    const { exec, calls } = fakeExec({ 'pr view': ok(PR_JSON), 'pr checks': ok('[]'), git: ok(HEAD) });
    const { eri, worktreeRoot } = await runtime(exec);
    const hello = eri.frames.find((f) => f.t === 'hello') as unknown as { caps: string[]; targets: Array<{ verify_status: Array<{ id: string; notify_after_s?: number }> }> };
    expect(hello.caps).toContain('ci.status');
    expect(hello.targets[0].verify_status[0]).toMatchObject({ id: 'quick', notify_after_s: 300 });
    eri.send({ t: 'ci.status', op_id: 'op-ci-1', run_id: 'run-1', generation: 1, branch: 'eri/task-1', turn_seq: 3, log_lines: 40, expires_at: Date.now() + 60_000 });
    await until(() => !!eri.outcome('op-ci-1'));
    expect(eri.outcome('op-ci-1')).toMatchObject({ state: 'executed', kind: 'ci.status', result: { pr: { number: 151, head_sha: HEAD }, checks: [], failed_logs: [], worktree_head: HEAD } });
    expect(calls[0]).toEqual(['gh', 'pr', 'view', 'eri/task-1', ...VIEW]);
    expect(calls.every((c) => c.length > 1)).toBe(true);
    expect(fs.existsSync(path.join(worktreeRoot, 'eri--task-1'))).toBe(true);
  });

  it('a branch with no worktree on this host fails with the reason, without running gh', async () => {
    const { exec, calls } = fakeExec({});
    const { eri } = await runtime(exec);
    eri.send({ t: 'ci.status', op_id: 'op-ci-2', run_id: 'run-1', generation: 1, branch: 'eri/elsewhere', expires_at: Date.now() + 60_000 });
    await until(() => !!eri.outcome('op-ci-2'));
    expect(eri.outcome('op-ci-2')).toMatchObject({ state: 'failed', detail: 'no worktree for eri/elsewhere on this host' });
    expect(calls).toEqual([]);
  });

  it('a logged-out gh fails with gh\'s own words', async () => {
    const { exec } = fakeExec({ 'pr view': { code: 4, stdout: '', stderr: 'You are not logged into any GitHub hosts. To log in, run: gh auth login' } });
    const { eri } = await runtime(exec);
    eri.send({ t: 'ci.status', op_id: 'op-ci-3', run_id: 'run-1', generation: 1, branch: 'eri/task-1', expires_at: Date.now() + 60_000 });
    await until(() => !!eri.outcome('op-ci-3'));
    expect(eri.outcome('op-ci-3')).toMatchObject({ state: 'failed', detail: expect.stringContaining('gh auth login') });
  });

  it('pr.merge is advertised and merges through the same gh, refusals carry the reason', async () => {
    const merged = JSON.stringify({ ...JSON.parse(PR_JSON), state: 'MERGED' });
    const views = [PR_JSON, merged, `${'c'.repeat(40)}\n`];
    const { exec, calls } = fakeExec({ 'pr view': () => ok(views.shift() ?? merged), 'pr merge': ok(''), git: ok(HEAD) });
    const { eri } = await runtime(exec);
    const hello = eri.frames.find((f) => f.t === 'hello') as unknown as { caps: string[] };
    expect(hello.caps).toEqual(expect.arrayContaining(['pr.merge', 'pr.update_branch']));
    eri.send({ t: 'pr.merge', op_id: 'op-m-1', run_id: 'run-1', generation: 1, branch: 'eri/task-1', head_sha: HEAD, target: 'proj', origin: 'human', expires_at: Date.now() + 60_000 });
    await until(() => !!eri.outcome('op-m-1'));
    expect(eri.outcome('op-m-1')).toMatchObject({ state: 'executed', kind: 'pr.merge', result: { merged: true, already: false, merge_commit: 'c'.repeat(40) } });
    expect(calls).toContainEqual(['gh', 'pr', 'merge', '151', '--merge', '--match-head-commit', HEAD]);

    eri.send({ t: 'pr.merge', op_id: 'op-m-2', run_id: 'run-1', generation: 1, branch: 'eri/task-1', head_sha: 'd'.repeat(40), expires_at: Date.now() + 60_000 });
    await until(() => !!eri.outcome('op-m-2'));
    expect(eri.outcome('op-m-2')).toMatchObject({ state: 'executed', result: { merged: true, already: true } });
  });

  it('pr.update_branch with no clone of the repository fails with the reason', async () => {
    const { exec, calls } = fakeExec({});
    const { eri } = await runtime(exec);
    eri.send({ t: 'pr.update_branch', op_id: 'op-u-1', run_id: 'run-1', generation: 1, branch: 'eri/elsewhere', head_sha: HEAD, target: 'nope', expires_at: Date.now() + 60_000 });
    await until(() => !!eri.outcome('op-u-1'));
    expect(eri.outcome('op-u-1')).toMatchObject({ state: 'failed', detail: 'no clone of the repository for eri/elsewhere on this host' });
    expect(calls).toEqual([]);
  });

  it('pr.update_branch falls back to the target repository once the worktree is gone', async () => {
    const { exec, calls } = fakeExec({ 'pr view': ok(PR_JSON), 'api -X': ok('{}') });
    const { eri } = await runtime(exec);
    eri.send({ t: 'pr.update_branch', op_id: 'op-u-2', run_id: 'run-1', generation: 1, branch: 'eri/gone', head_sha: HEAD, target: 'proj', expires_at: Date.now() + 60_000 });
    await until(() => !!eri.outcome('op-u-2'));
    expect(eri.outcome('op-u-2')).toMatchObject({ state: 'executed', result: { updated: true, new_head_sha: null, worktree_synced: false } });
    expect(calls[0]).toEqual(['gh', 'pr', 'view', 'eri/gone', ...VIEW]);
  });
});
