/**
 * S-Q3 (Eridani task 7f5a5c5f): managed target templates, validated before
 * they are advertised. The schema (prepare, limits), the whole-template
 * check, hello and doctor reporting, dependency preparation in a managed
 * worktree, and dispatch refusing what is not ready.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { Hub } from '../src/hub';
import { Registry } from '../src/registry';
import { Dispatch, surfFor } from '../src/dispatch';
import { QuestionBroker } from '../src/questions-claude';
import type { CommandContext, CommandResult } from '../src/eridani-link';
import { readTargets, saveTarget, targetError, type ExecutionTarget } from '../src/eridani-targets';
import { helloTargets, type LauncherProbe } from '../src/launch-caps';
import { PREPARE_LOG, PREPARE_STATE, runPrepare, templateStatus, withTemplate, worktreeGitDir } from '../src/target-template';
import { evaluate, type DoctorFacts } from '../src/doctor';
import { fmtReadiness } from '../src/eridani-setup';
import { eridaniCommand } from '../src/eridani-cli';
import type { WorktreeManager } from '../src/worktrees';
import type { CommandBody, HelloTemplate } from '../../src/shared/eridani-link-protocol';
import type { PrepareFacts } from '../../src/shared/remote-host-protocol';
import { fakeSpawner, ManualTimers } from './helpers';

const cleanups: Array<() => unknown> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function tmpDir(prefix = 'remotea-tpl-'): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  cleanups.push(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' });

/** A repository with one commit on main. */
function gitRepo(files: Record<string, string> = {}): string {
  const d = tmpDir('remotea-tpl-repo-');
  execFileSync('git', ['init', '-q', '-b', 'main', d]);
  for (const [f, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true });
    fs.writeFileSync(path.join(d, f), body, { mode: 0o755 });
  }
  git(d, 'add', '-A');
  git(d, 'commit', '-q', '--allow-empty', '-m', 'init');
  return d;
}

const ENV = { PATH: '/usr/bin:/bin' };

function target(repo: string, over: Partial<ExecutionTarget> = {}): ExecutionTarget {
  return { id: 'proj', repo, worktreeRoot: `${repo}-wt`, base: 'main', launch: { claude: {} }, verify: [], ...over };
}

describe('schema: prepare and limits are optional and checked', () => {
  const base = { id: 'x', repo: '/r', worktreeRoot: '/w', base: 'main', launch: { claude: {} }, verify: [] };

  it('accepts a target without them (unchanged) and with them', () => {
    expect(targetError(base)).toBeNull();
    expect(targetError({ ...base, prepare: [{ id: 'deps', argv: ['uv', 'sync', '--locked'], cwd: 'apps/api', timeout: 900, env: { UV_FROZEN: '1' } }], limits: { maxRuns: 2, minFreeMiB: 1024 } })).toBeNull();
    expect(targetError({ ...base, prepare: [] })).toBeNull();
  });

  it('refuses bad steps and limits with a reason', () => {
    const p = (step: Record<string, unknown>) => targetError({ ...base, prepare: [{ id: 'deps', argv: ['npm', 'ci'], timeout: 60, ...step }] });
    expect(p({ argv: [] })).toBe('prepare deps: argv');
    expect(p({ cwd: '../elsewhere' })).toBe('prepare deps: cwd is relative to the worktree');
    expect(p({ timeout: 3 * 3600 })).toBe('prepare deps: timeout in seconds (≤ 2 h)');
    expect(p({ env: { 'BAD-KEY': 'x' } })).toMatch(/^prepare deps: env/);
    expect(targetError({ ...base, prepare: [{ id: 'a', argv: ['x'], timeout: 1 }, { id: 'a', argv: ['y'], timeout: 1 }] })).toBe('prepare id a twice');
    expect(targetError({ ...base, prepare: 'npm ci' })).toMatch(/^prepare: a list/);
    expect(targetError({ ...base, limits: { maxRuns: 0 } })).toMatch(/^limits.maxRuns/);
    expect(targetError({ ...base, limits: { cpu: 2 } })).toMatch(/^limits.cpu: unknown/);
    expect(targetError({ ...base, limits: { minFreeMiB: 1.5 } })).toMatch(/^limits.minFreeMiB/);
  });

  it('loads them, and reports invalid entries instead of dropping them silently', () => {
    const dir = tmpDir();
    saveTarget(dir, { ...base, id: 'ok', prepare: [{ id: 'deps', argv: ['npm', 'ci'], timeout: 60 }], limits: { maxRuns: 1 } });
    const file = path.join(dir, 'eridani.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    raw.targets.push({ ...base, id: 'broken', limits: { maxRuns: 99 } });
    fs.writeFileSync(file, JSON.stringify(raw));
    const { targets, invalid } = readTargets(dir);
    expect(targets.map((t) => t.id)).toEqual(['ok']);
    expect(targets[0]).toMatchObject({ prepare: [{ id: 'deps', argv: ['npm', 'ci'], timeout: 60 }], limits: { maxRuns: 1 } });
    expect(invalid).toEqual([{ id: 'broken', error: 'limits.maxRuns: a whole number from 1 to 64' }]);
  });
});

describe('remotea eridani targets add/list with prepare and limits', () => {
  it('saves --prepare steps and --max-runs, lists them, and warns when the template is not ready', async () => {
    const dir = tmpDir();
    const repo = gitRepo();
    let text = '';
    const out = { write: (s: string) => ((text += s), true) } as unknown as NodeJS.WriteStream;
    const code = await eridaniCommand(dir, ['targets', 'add', '--id', 'proj', '--repo', repo, '--worktree-root', `${repo}-wt`, '--base', 'develop', '--prepare', 'deps=npm ci', '--prepare-timeout', '300', '--max-runs', '2'], async () => false, out);
    expect(code).toBe(0);
    expect(readTargets(dir).targets[0]).toMatchObject({ id: 'proj', prepare: [{ id: 'deps', argv: ['npm', 'ci'], timeout: 300 }], limits: { maxRuns: 2 } });
    expect(text).toContain('warning: target proj is not ready');
    expect(text).toContain('NOT READY base: the base develop is not a branch, origin branch or tag of the repository');
    text = '';
    await eridaniCommand(dir, ['targets', 'list'], async () => false, out);
    expect(text).toContain('  prepare deps: npm ci, 300 s');
    expect(text).toContain('  limits: maxRuns 2');
  });
});

describe('templateStatus: the whole template checked before it is advertised', () => {
  it('a sound template is ready with no problems', () => {
    const repo = gitRepo({ 'scripts/prep.sh': '#!/bin/sh\n' });
    const t = target(repo, { prepare: [{ id: 'deps', argv: ['./scripts/prep.sh'], timeout: 60 }, { id: 'sh', argv: ['sh', '-c', 'true'], timeout: 60 }], verify: [{ id: 'test', argv: ['/bin/true'], timeout: 60 }] });
    expect(templateStatus(t, { env: ENV })).toEqual({ ready: true });
  });

  it('a missing repository, a non-git folder and a missing base each fail', () => {
    expect(templateStatus(target('/nonexistent/repo-zz', { worktreeRoot: path.join(tmpDir(), 'wt') }), { env: ENV })).toMatchObject({ ready: false, problems: [{ check: 'repo', level: 'fail', reason: 'the repository folder does not exist' }] });
    expect(templateStatus(target(tmpDir()), { env: ENV }).problems).toEqual([{ check: 'repo', level: 'fail', reason: 'the repository folder is not a git checkout' }]);
    const repo = gitRepo();
    expect(templateStatus(target(repo, { base: 'develop' }), { env: ENV })).toEqual({ ready: false, problems: [{ check: 'base', level: 'fail', reason: 'the base develop is not a branch, origin branch or tag of the repository' }] });
    // An origin branch is enough: worktrees.ts bases on origin/<base> when there is no local one.
    git(repo, 'update-ref', 'refs/remotes/origin/develop', 'HEAD');
    expect(templateStatus(target(repo, { base: 'develop' }), { env: ENV })).toEqual({ ready: true });
    // A git failure is reported, not taken as a missing base.
    expect(templateStatus(target(repo), { env: ENV, git: () => ({ code: null, stdout: '' }) })).toEqual({ ready: true, problems: [{ check: 'base', level: 'warn', reason: 'cannot read the repository\'s refs (git failed)' }] });
  });

  it('a worktree root that cannot be created fails', () => {
    const repo = gitRepo();
    const file = path.join(tmpDir(), 'a-file');
    fs.writeFileSync(file, '');
    expect(templateStatus(target(repo, { worktreeRoot: path.join(file, 'wt') }), { env: ENV }).problems).toEqual([
      { check: 'worktree_root', level: 'fail', reason: 'the worktree root does not exist and cannot be created (its parent is not writable)' },
    ]);
    expect(templateStatus(target(repo, { worktreeRoot: file }), { env: ENV }).problems).toEqual([{ check: 'worktree_root', level: 'fail', reason: 'the worktree root exists and is not a folder' }]);
  });

  it('a prepare step whose program or folder does not resolve fails; never the argv in the reason', () => {
    const repo = gitRepo();
    const t = target(repo, { prepare: [{ id: 'deps', argv: ['uv-not-on-path-zz', 'sync', '--secret-flag'], timeout: 60 }, { id: 'web', argv: ['/bin/true'], cwd: 'apps/web', timeout: 60 }] });
    const st = templateStatus(t, { env: ENV });
    expect(st.ready).toBe(false);
    expect(st.problems).toEqual([
      { check: 'prepare.deps', level: 'fail', reason: 'prepare step deps: its program is not on the service PATH (use an absolute path or set PATH in the entry\'s env)' },
      { check: 'prepare.web', level: 'fail', reason: 'prepare step web: its cwd does not exist in the repository' },
    ]);
    expect(JSON.stringify(st)).not.toContain('secret-flag');
    // The step's own PATH is honoured, as for a verify entry.
    const bin = tmpDir();
    fs.writeFileSync(path.join(bin, 'uv-not-on-path-zz'), '#!/bin/sh\n', { mode: 0o755 });
    expect(templateStatus(target(repo, { prepare: [{ id: 'deps', argv: ['uv-not-on-path-zz'], timeout: 60, env: { PATH: `${bin}:/usr/bin:/bin` } }] }), { env: ENV })).toEqual({ ready: true });
  });

  it('a verify entry that is not ready and a missing migrations folder warn without blocking', () => {
    const repo = gitRepo();
    const st = templateStatus(target(repo, { verify: [{ id: 'api', argv: ['uv-not-on-path-zz', 'run', 'pytest'], timeout: 600 }], migrations: { dir: 'apps/api/migrations' } }), { env: ENV });
    expect(st).toEqual({
      ready: true,
      problems: [
        { check: 'verify.api', level: 'warn', reason: 'verify api: its program is not on the service PATH (use an absolute path or set PATH in the entry\'s env)' },
        { check: 'migrations', level: 'warn', reason: 'migrations.dir apps/api/migrations is not a folder in the repository checkout' },
      ],
    });
  });

  it('no harness enabled, and too little disk under limits.minFreeMiB, fail', () => {
    const repo = gitRepo();
    expect(templateStatus(target(repo, { launch: {} }), { env: ENV }).problems).toEqual([{ check: 'launch', level: 'fail', reason: 'no harness is enabled (launch names neither claude nor codex)' }]);
    const t = target(repo, { limits: { minFreeMiB: 2048 } });
    expect(templateStatus(t, { env: ENV, statfs: () => ({ free: 4096 * 1024 * 1024 }) })).toEqual({ ready: true });
    expect(templateStatus(t, { env: ENV, statfs: () => ({ free: 100 * 1024 * 1024 }) }).problems).toEqual([{ check: 'limits.disk', level: 'fail', reason: '100 MiB free where the worktrees live, under limits.minFreeMiB 2048' }]);
  });
});

describe('hello and doctor carry the template', () => {
  const probes = new Map<string, LauncherProbe>([['claude\0claude', { ok: true, version: '2.0.0' }]]);

  it('a target that is not ready is listed with harnesses [] and its reasons; a ready one keeps its harnesses', () => {
    const good = gitRepo();
    const targets = [
      target(good, { id: 'good', prepare: [{ id: 'deps', argv: ['/bin/true'], timeout: 60 }] }),
      target('/nonexistent/repo-zz', { id: 'bad', worktreeRoot: path.join(tmpDir(), 'wt') }),
    ];
    const hello = withTemplate(helloTargets(targets, probes, { env: ENV }), targets, { env: ENV });
    expect(hello[0]).toMatchObject({ id: 'good', harnesses: ['claude'], enabled: ['claude'], prepare: ['deps'], template: { ready: true } });
    expect(hello[1]).toMatchObject({ id: 'bad', harnesses: [], enabled: ['claude'], template: { ready: false, problems: [{ check: 'repo', level: 'fail' }] } });
    expect(hello[1]).not.toHaveProperty('prepare');
    expect(JSON.stringify(hello)).not.toContain('/bin/true');
    // `remotea eridani setup` / status rows.
    const rows = fmtReadiness(hello).join('\n');
    expect(rows).toMatch(/bad\s+template\s+NOT READY\s+not advertised/);
    expect(rows).toMatch(/bad\s+repo\s+NOT READY\s+the repository folder does not exist/);
    expect(rows).toMatch(/good\s+prepare\s+ready\s+a new worktree runs deps first/);
  });

  it('doctor reports a not-ready template, its uncovered problems, and ignored entries', () => {
    const repo = gitRepo();
    const tg = target(repo, { base: 'develop', prepare: [{ id: 'deps', argv: ['npm', 'ci'], timeout: 60 }] });
    const template: HelloTemplate = {
      ready: false,
      problems: [
        { check: 'base', level: 'fail', reason: 'the base develop is not a branch, origin branch or tag of the repository' },
        { check: 'prepare.deps', level: 'fail', reason: 'prepare step deps: its program is not on the service PATH' },
        { check: 'verify.api', level: 'warn', reason: 'verify api: not ready' },
      ],
    };
    const facts = {
      now: 0, hostname: 'box', home: '/home/u', probed: false,
      service: { unitFile: '/u', installed: true, active: 'active', enabled: 'enabled', user: 'u', path: '/usr/bin' },
      listener: { port: 7717, accepting: true, healthy: true, hookPort: 7718, hookAccepting: true, token: true },
      running: null, diskBuild: { sha: 'unknown', dirty: null, builtAt: null }, helper: { installed: null, bundled: null, current: false }, agentHooks: [],
      eridani: { configured: true, enabled: true, keyPresent: true, mode: 'parity', link: null },
      collector: { sqlite: null, stateMtime: null, scan: null },
      targets: [tg],
      invalidTargets: [{ id: 'broken', error: 'limits.maxRuns: a whole number from 1 to 64' }],
      readiness: [{ id: 'proj', repo, harnesses: [], enabled: ['claude'], verify: [], template }],
      readinessSource: 'disk', serviceEnv: {}, bwrap: null, disks: [], uploads: null, worktrees: null, registry: null,
    } as unknown as DoctorFacts;
    const items = evaluate(facts).filter((i) => i.section === 'targets');
    const byId = (id: string) => items.find((i) => i.id === id);
    expect(byId('target.broken.config')).toMatchObject({ level: 'fail', summary: 'broken: ignored, not advertised: limits.maxRuns: a whole number from 1 to 64' });
    expect(byId('target.proj.template')).toMatchObject({ level: 'fail', summary: expect.stringContaining('proj: not advertised as ready: the base develop is not a branch') });
    expect(byId('target.proj.base')).toMatchObject({ level: 'fail', fix: expect.stringContaining('git branch -a') });
    expect(byId('target.proj.prepare.deps')).toMatchObject({ level: 'fail' });
    // verify has its own item (target.proj.verify.<id>); it is not repeated from the template.
    expect(items.some((i) => i.id === 'target.proj.verify.api')).toBe(false);
  });
});

describe('runPrepare: dependency preparation in a managed worktree', () => {
  function worktree(files: Record<string, string> = {}): { repo: string; wt: string } {
    const repo = gitRepo(files);
    const wt = path.join(tmpDir(), 'eri--task');
    git(repo, 'worktree', 'add', '-q', '-b', 'eri/task', wt);
    return { repo, wt };
  }

  it('runs the steps in order in their folders with the minimal environment, logs into the git folder, and runs once', async () => {
    const { repo, wt } = worktree({ 'apps/web/.keep': '' });
    const t = target(repo, {
      prepare: [
        { id: 'one', argv: ['sh', '-c', 'echo "one in $(pwd)"; echo "secret=${SERVER_SECRET:-unset} step=$STEP_VAR ci=$CI"'], timeout: 30, env: { STEP_VAR: 'yes' } },
        { id: 'two', argv: ['sh', '-c', 'echo two > made-by-prepare'], cwd: 'apps/web', timeout: 30 },
      ],
    });
    const env = { ...ENV, HOME: os.tmpdir(), SERVER_SECRET: 'leak' };
    const first = await runPrepare(t, wt, { force: true, env });
    const gitDir = worktreeGitDir(wt)!;
    expect(gitDir).toContain(path.join('.git', 'worktrees'));
    expect(first).toMatchObject({ ran: true, ok: true, log: path.join(gitDir, PREPARE_LOG), steps: [{ id: 'one', exit_code: 0 }, { id: 'two', exit_code: 0 }] });
    expect(first).not.toHaveProperty('tail');
    expect(fs.readFileSync(path.join(wt, 'apps/web/made-by-prepare'), 'utf8')).toBe('two\n');
    const log = fs.readFileSync(first!.log!, 'utf8');
    expect(log).toContain(`one in ${wt}`);
    expect(log).toContain('secret=unset step=yes ci=1');
    expect(log).toMatch(/# two: exit 0 after/);
    expect(JSON.parse(fs.readFileSync(path.join(gitDir, PREPARE_STATE), 'utf8'))).toMatchObject({ ok: true });
    // Nothing of it in the working tree (the log and state live in the git folder).
    expect(git(wt, 'status', '--porcelain', '--', '.', ':!apps/web/made-by-prepare').trim()).toBe('');
    // A reused worktree whose preparation succeeded with the same steps: not again.
    expect(await runPrepare(t, wt, { env })).toEqual({ ran: false, ok: true, steps: [], log: first!.log });
    // Changed steps: again.
    const changed = { ...t, prepare: [t.prepare![0]] };
    expect(await runPrepare(changed, wt, { env })).toMatchObject({ ran: true, ok: true, steps: [{ id: 'one' }] });
  });

  it('stops at the first failure with the reason and the tail, and prepares again next time', async () => {
    const { repo, wt } = worktree();
    const t = target(repo, {
      prepare: [
        { id: 'bad', argv: ['sh', '-c', 'echo installing; echo "boom: lockfile out of date" >&2; exit 3'], timeout: 30 },
        { id: 'never', argv: ['sh', '-c', 'touch never-ran'], timeout: 30 },
      ],
    });
    const r = await runPrepare(t, wt, { force: true, env: ENV });
    expect(r).toMatchObject({ ran: true, ok: false, reason: 'step bad exited 3', steps: [{ id: 'bad', exit_code: 3 }] });
    expect(r!.steps).toHaveLength(1);
    expect(r!.tail).toContain('boom: lockfile out of date');
    expect(fs.existsSync(path.join(wt, 'never-ran'))).toBe(false);
    // Not forced, but the last preparation failed: it runs again.
    expect(await runPrepare(t, wt, { env: ENV })).toMatchObject({ ran: true, ok: false });
  });

  it('a step over its timeout is killed (with what it started) and reported', async () => {
    const { repo, wt } = worktree();
    const t = target(repo, { prepare: [{ id: 'slow', argv: ['sh', '-c', 'sleep 30 & sleep 30'], timeout: 600 }] });
    const started = Date.now();
    const r = await runPrepare(t, wt, { force: true, env: ENV, timeoutMs: 200, killGraceMs: 100 });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(r).toMatchObject({ ok: false, reason: 'step slow timed out after 600 s', steps: [{ id: 'slow', timed_out: true }] });
  });

  it('a program that does not exist, or a folder that does not, fails clearly', async () => {
    const { repo, wt } = worktree();
    const r = await runPrepare(target(repo, { prepare: [{ id: 'deps', argv: ['uv-not-on-path-zz', 'sync'], timeout: 30 }] }), wt, { force: true, env: ENV });
    expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/^step deps could not start: .*ENOENT/), steps: [{ id: 'deps', exit_code: null }] });
    const r2 = await runPrepare(target(repo, { prepare: [{ id: 'web', argv: ['true'], cwd: 'apps/web', timeout: 30 }] }), wt, { force: true, env: ENV });
    expect(r2).toMatchObject({ ok: false, reason: 'step web: its cwd apps/web is not a folder in the worktree' });
  });

  it('a target without prepare steps prepares nothing', async () => {
    expect(await runPrepare(target('/r'), '/nonexistent')).toBeNull();
  });
});

// ── Dispatch ────────────────────────────────────────────────────────────────

function dispatchSetup(t: ExecutionTarget, deps: { checkTarget?: (t: ExecutionTarget) => HelloTemplate; prepare?: (t: ExecutionTarget, wt: string, force: boolean) => Promise<PrepareFacts | null>; created?: boolean } = {}) {
  const registry = Registry.load({ file: null, bootId: 'boot-1' });
  const sp = fakeSpawner();
  const hub = new Hub({ registry, spawn: sp.spawn, bootId: 'boot-1', serverId: 'srv', hostname: 'box', timers: new ManualTimers(), probe: () => ({}) });
  const worktrees = {
    ensure: async (tg: ExecutionTarget, branch: string, base: string) => ({ path: `${tg.worktreeRoot}/${branch.replace(/\//g, '--')}`, branch, base, baseSha: 'abc123', created: deps.created ?? true }),
  } as unknown as WorktreeManager;
  const questions = new QuestionBroker({ session: (id) => registry.session(id), canHold: () => true, emit: () => {}, needsYou: () => {} });
  const logs: string[] = [];
  const dispatch = new Dispatch({
    hub, registry, dir: null, worktrees, targets: () => [t], questions, emit: () => {}, linkReady: () => true, log: (m) => logs.push(m),
    ...(deps.checkTarget ? { checkTarget: deps.checkTarget } : {}),
    ...(deps.prepare ? { prepare: deps.prepare } : {}),
  });
  hub.setEridani(dispatch.hubHooks());
  const h = dispatch.handlers();
  const run = async (n: number, over: Record<string, unknown> = {}): Promise<CommandResult> => {
    const cmd = {
      t: 'spawn', op_id: `op-${n}`, digest: 'd', run_id: `run-${n}`, generation: 1, attempt: 1, harness: 'claude', model: 'sonnet',
      target: { id: t.id, branch: `eri/task-${n}` }, prompt: 'go', expires_at: Date.now() + 60_000, ...over,
    };
    const pre = dispatch.precheck(cmd as unknown as CommandBody);
    if (pre) return { state: 'rejected', detail: pre };
    const ctx: CommandContext = { begin: () => {} };
    return h.spawn(cmd as unknown as CommandBody, ctx);
  };
  return { run, sp, registry, logs };
}

describe('dispatch: templates at spawn', () => {
  const T = target('/repo', { worktreeRoot: '/wt' });

  it('a target whose template fails is rejected with its reasons, and nothing starts', async () => {
    const tpl: HelloTemplate = { ready: false, problems: [{ check: 'base', level: 'fail', reason: 'the base main is not a branch, origin branch or tag of the repository' }, { check: 'verify.x', level: 'warn', reason: 'w' }] };
    const { run, sp } = dispatchSetup(T, { checkTarget: () => tpl });
    expect(await run(1)).toEqual({ state: 'rejected', detail: 'target_not_ready: the base main is not a branch, origin branch or tag of the repository', result: { template: tpl } });
    expect(sp.ptys).toHaveLength(0);
    // Warnings alone do not block.
    const ok = dispatchSetup(T, { checkTarget: () => ({ ready: true, problems: [{ check: 'verify.x', level: 'warn', reason: 'w' }] }) });
    expect(await ok.run(1)).toMatchObject({ state: 'executed' });
  });

  it('limits.maxRuns: one spawn more than the limit is rejected target_busy', async () => {
    const { run, sp } = dispatchSetup({ ...T, limits: { maxRuns: 2 } });
    expect(await run(1)).toMatchObject({ state: 'executed' });
    expect(await run(2)).toMatchObject({ state: 'executed' });
    expect(await run(3)).toEqual({ state: 'rejected', detail: 'target_busy', result: { limit: 2, running: 2 } });
    expect(sp.ptys).toHaveLength(2);
  });

  it('prepares a new worktree before the agent starts and records it on the outcome', async () => {
    const calls: Array<[string, boolean]> = [];
    const facts: PrepareFacts = { ran: true, ok: true, steps: [{ id: 'deps', exit_code: 0, duration_ms: 5 }], log: '/repo/.git/worktrees/x/remotea-prepare.log' };
    const { run, sp, registry } = dispatchSetup({ ...T, prepare: [{ id: 'deps', argv: ['npm', 'ci'], timeout: 60 }] }, {
      prepare: async (_t, wt, force) => {
        calls.push([wt, force]);
        expect(sp.ptys).toHaveLength(0); // before the agent
        return facts;
      },
    });
    const res = await run(1);
    expect(calls).toEqual([['/wt/eri--task-1', true]]);
    expect(res).toMatchObject({ state: 'executed', result: { prepare: facts } });
    expect(registry.session(surfFor('run-1', 1, 1))!.eridani!.prepare).toEqual(facts);
  });

  it('a failed preparation fails the spawn with the reason and starts no agent', async () => {
    const facts: PrepareFacts = { ran: true, ok: false, steps: [{ id: 'deps', exit_code: 1, duration_ms: 5 }], reason: 'step deps exited 1', tail: 'npm ERR! lockfile' };
    const { run, sp, logs } = dispatchSetup({ ...T, prepare: [{ id: 'deps', argv: ['npm', 'ci'], timeout: 60 }] }, { prepare: async () => facts, created: false });
    expect(await run(1)).toEqual({ state: 'failed', detail: 'prepare: step deps exited 1', result: { worktree: '/wt/eri--task-1', branch: 'eri/task-1', target: 'proj', prepare: facts } });
    expect(sp.ptys).toHaveLength(0);
    expect(logs.join('\n')).toContain('prepare for run run-1 in /wt/eri--task-1: FAILED: step deps exited 1');
    // A thrown preparation is a failure too.
    const thrown = dispatchSetup({ ...T, prepare: [{ id: 'deps', argv: ['npm', 'ci'], timeout: 60 }] }, { prepare: async () => { throw new Error('disk on fire'); } });
    expect(await thrown.run(1)).toMatchObject({ state: 'failed', detail: 'prepare: cannot run: disk on fire' });
  });

  it('a shared spawn onto a worktree being prepared waits for that preparation instead of starting another', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let n = 0;
    const { run } = dispatchSetup({ ...T, prepare: [{ id: 'deps', argv: ['npm', 'ci'], timeout: 60 }] }, {
      prepare: async () => {
        n++;
        await gate;
        return { ran: true, ok: true, steps: [] };
      },
    });
    const a = run(1, { target: { id: 'proj', branch: 'eri/shared' } });
    await new Promise((r) => setTimeout(r, 5));
    const b = run(2, { target: { id: 'proj', branch: 'eri/shared' }, share: true });
    await new Promise((r) => setTimeout(r, 5));
    release();
    expect((await a).state).toBe('executed');
    expect((await b).state).toBe('executed');
    expect(n).toBe(1);
  });

  it('a target without prepare or limits spawns exactly as before (no prepare field)', async () => {
    const { run } = dispatchSetup(T, { prepare: async () => { throw new Error('must not run'); } });
    const res = await run(1);
    expect(res.state).toBe('executed');
    expect(res.result).not.toHaveProperty('prepare');
  });
});
