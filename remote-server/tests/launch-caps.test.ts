/**
 * S-S1 and S-S5: hello advertises spawn only for harnesses whose launcher was
 * probed (through the login-shell rules) and works on a target that enables
 * them; each target lists only what its launch config enables, with launch
 * and verify readiness; hello, the status file and `remotea status --json`
 * carry the build, protocol, caps and hook versions, with a fallback.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { ERIDANI_CAPS_VERSION, parseUpFrame, type HelloBody, type UpFrame } from '../../src/shared/eridani-link-protocol';
import { saveEridaniConfig, writeEridaniToken } from '../src/config';
import { saveTarget, type ExecutionTarget } from '../src/eridani-targets';
import { EridaniRuntime } from '../src/eridani-runtime';
import { readLinkStatus } from '../src/eridani-link';
import { harnessMatrix, helloTargets, launchersToProbe, probeKey, probeLauncher, verifyStatus, type LauncherProbe, type ProbeHarness } from '../src/launch-caps';
import { fileVersion, hookVersion, loadBuildInfo, readServerInfo, serverInfo, UNKNOWN_BUILD, writeServerInfo } from '../src/build-info';
import { buildStatus, fmtBuild } from '../src/cli';
import { fmtAdvertised } from '../src/eridani-cli';
import { Hub } from '../src/hub';
import { Registry } from '../src/registry';
import { fakeSpawner, IMPOSSIBLE_PID, ManualTimers } from './helpers';

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function tmpDir(prefix = 'remotea-caps-'): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

/** A repository with a commit on main: the template check (S-Q3) advertises only a target whose base exists. */
function gitRepo(): string {
  const d = tmpDir('remotea-caps-repo-');
  execFileSync('git', ['init', '-q', '-b', 'main', d]);
  execFileSync('git', ['-C', d, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init']);
  return d;
}

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

function script(dir: string, name: string, body: string): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return p;
}

const sh = { shell: '/bin/sh', args: (cmd: string) => ['-c', cmd] };

const target = (over: Partial<ExecutionTarget> = {}): ExecutionTarget => ({
  id: 'proj',
  repo: '/r',
  worktreeRoot: '/w',
  base: 'main',
  launch: { claude: {} },
  verify: [],
  ...over,
});

const ok = (version = '2.0.1'): LauncherProbe => ({ ok: true, version });
const no = (error = '`codex` is not on the login shell\'s PATH'): LauncherProbe => ({ ok: false, version: null, error });

describe('probeLauncher: `<bin> --version` the way a spawn runs it', () => {
  it('reads the version printed after the marker, ignoring what the profile printed first', async () => {
    const bin = tmpDir();
    script(bin, 'fakeclaude', 'echo "2.1.3 (Claude Code)"');
    const r = await probeLauncher('fakeclaude', { ...sh, args: (cmd) => ['-c', `echo "nvm 0.39.7 loaded"; ${cmd}`], env: { PATH: `${bin}:/usr/bin:/bin` } });
    expect(r).toEqual({ ok: true, version: '2.1.3' });
  });

  it('a program not on the PATH, one that fails and one that hangs are not ready, and say why', async () => {
    const bin = tmpDir();
    script(bin, 'broken', 'exit 3');
    script(bin, 'hangs', 'sleep 5');
    const env = { PATH: `${bin}:/usr/bin:/bin` };
    expect(await probeLauncher('no-such-harness-xyz', { ...sh, env })).toMatchObject({ ok: false, version: null, error: expect.stringMatching(/not on the login shell's PATH/) });
    expect(await probeLauncher(path.join(bin, 'missing'), { ...sh, env })).toMatchObject({ ok: false, error: expect.stringMatching(/does not exist/) });
    expect(await probeLauncher('broken', { ...sh, env })).toMatchObject({ ok: false, error: '`broken --version` exited 3' });
    expect(await probeLauncher('hangs', { ...sh, env, timeoutMs: 200 })).toMatchObject({ ok: false, error: expect.stringMatching(/did not answer/) });
  });

  it('a bin with shell metacharacters is one quoted word, never shell text', async () => {
    const dir = tmpDir();
    const marker = path.join(dir, 'pwned');
    const r = await probeLauncher(`x; touch ${marker}`, { ...sh, env: { PATH: '/usr/bin:/bin' } });
    expect(r.ok).toBe(false);
    expect(fs.existsSync(marker)).toBe(false);
  });
});

describe('harnessMatrix: host-wide flags', () => {
  it('spawn only for a harness whose probe succeeded on a target that enables it', () => {
    const probes = new Map([[probeKey('claude', 'claude'), ok('2.1.314')], [probeKey('codex', 'codex'), no()]]);
    const m = harnessMatrix(probes, [target({ launch: { claude: {}, codex: {} } })], { claudeAsk: true, codexApproval: true });
    expect(m.claude).toMatchObject({ version: '2.1.314', installed: true, spawn: true, observe: true, question: true, question_kinds: ['ask'], steer: 'interrupt', loop: true, permission: 'capture' });
    expect(m.codex).toMatchObject({ version: null, installed: false, spawn: false, launch_error: expect.stringMatching(/not on the login shell's PATH/) });
  });

  it('installed but enabled on no target: installed, not spawnable; never probed: neither', () => {
    const m = harnessMatrix(new Map([[probeKey('claude', 'claude'), ok()]]), [target({ launch: {} })]);
    expect(m.claude).toMatchObject({ installed: true, spawn: false });
    expect(m.codex).toMatchObject({ installed: false, spawn: false, launch_error: 'not probed yet' });
  });

  it('a target\'s own bin counts: the bare name failing does not hide a configured absolute launcher', () => {
    const probes = new Map([[probeKey('codex', 'codex'), no()], [probeKey('codex', '/opt/codex'), ok('0.50.0')]]);
    const m = harnessMatrix(probes, [target({ launch: { codex: { bin: '/opt/codex' } } })]);
    expect(m.codex).toMatchObject({ installed: true, spawn: true, version: '0.50.0' });
    expect(m.codex).not.toHaveProperty('launch_error');
  });

  it('launchersToProbe: both bare names plus every target bin, once each', () => {
    const l = launchersToProbe([target({ launch: { codex: { bin: '/opt/codex' } } }), target({ id: 'b', launch: { claude: {}, codex: { bin: '/opt/codex' } } })]);
    expect(l).toEqual([{ harness: 'claude', bin: 'claude' }, { harness: 'codex', bin: 'codex' }, { harness: 'opencode', bin: 'opencode' }, { harness: 'codex', bin: '/opt/codex' }]);
  });
});

describe('helloTargets: permission, launch and verify readiness per target', () => {
  it('lists only what the launch config enables, and of that only what was probed ready', () => {
    const probes = new Map([[probeKey('claude', 'claude'), ok()], [probeKey('codex', 'codex'), no()]]);
    const [a, b] = helloTargets([
      target({ id: 'claude-only', launch: { claude: {} } }),
      target({ id: 'both', launch: { claude: {}, codex: {} } }),
    ], probes);
    expect(a).toMatchObject({ id: 'claude-only', harnesses: ['claude'], enabled: ['claude'], launch: { claude: { ready: true, version: '2.0.1' } } });
    expect(a.launch).not.toHaveProperty('codex');
    expect(b).toMatchObject({ id: 'both', harnesses: ['claude'], enabled: ['claude', 'codex'], launch: { codex: { ready: false, version: null, error: expect.any(String) } } });
  });

  it('verify readiness follows verify-runner: no shell, the service PATH or the entry\'s own PATH, cwd in the repository', () => {
    const repo = tmpDir();
    fs.mkdirSync(path.join(repo, 'remote-server'));
    script(repo, 'verify.sh', 'exit 0');
    const nodeDir = path.dirname(process.execPath);
    const env = { PATH: '/nonexistent-bin', HOME: '/tmp' };
    const v = (id: string, argv: string[], extra: Partial<{ cwd: string; env: Record<string, string> }> = {}) => verifyStatus(repo, { id, argv, timeout: 60, ...extra }, { env });
    expect(v('uv', ['uv', 'run', 'pytest'])).toEqual({ id: 'uv', ready: false, reason: expect.stringMatching(/not on the service PATH/), timeout_s: 60 });
    expect(v('abs', [process.execPath, '-e', '0'])).toEqual({ id: 'abs', ready: true, timeout_s: 60 });
    expect(v('abs-missing', ['/nonexistent/uv'])).toMatchObject({ ready: false, reason: expect.stringMatching(/does not exist/) });
    expect(v('own-path', ['node', '-e', '0'], { env: { PATH: nodeDir } })).toEqual({ id: 'own-path', ready: true, timeout_s: 60 });
    expect(verifyStatus(repo, { id: 'svc', argv: ['node'], timeout: 900 }, { env: { PATH: nodeDir } })).toEqual({ id: 'svc', ready: true, timeout_s: 900 });
    expect(v('rel', ['./verify.sh'])).toEqual({ id: 'rel', ready: true, timeout_s: 60 });
    expect(v('rel-missing', ['./nope.sh'])).toMatchObject({ ready: false });
    expect(v('cwd', [process.execPath], { cwd: 'remote-server' })).toEqual({ id: 'cwd', ready: true, timeout_s: 60 });
    expect(v('cwd-missing', [process.execPath], { cwd: 'no-such-dir' })).toMatchObject({ ready: false, reason: expect.stringMatching(/cwd does not exist/) });
  });

  it('carries verify ids and their status in order, never argv or env', () => {
    const repo = tmpDir();
    const [t] = helloTargets([target({
      repo,
      verify: [
        { id: 'test', argv: [process.execPath, '--secret-flag-zz'], timeout: 60, env: { TOKEN: 'secret-value-zz' } },
        { id: 'py', argv: ['uv-not-here-zz', 'run'], timeout: 1800 },
      ],
    })], new Map(), { env: { PATH: '/nonexistent-bin' } });
    expect(t.verify).toEqual(['test', 'py']);
    expect(t.verify_status).toEqual([{ id: 'test', ready: true, timeout_s: 60 }, { id: 'py', ready: false, reason: expect.any(String), timeout_s: 1800 }]);
    const text = JSON.stringify(t);
    for (const s of ['secret-flag-zz', 'secret-value-zz', 'uv-not-here-zz', process.execPath]) expect(text).not.toContain(s);
  });
});

describe('build identity', () => {
  it('reads dist/build-info.json, falling back to "unknown" when missing, foreign or malformed', () => {
    const d = tmpDir();
    const f = path.join(d, 'build-info.json');
    expect(loadBuildInfo(f)).toEqual(UNKNOWN_BUILD);
    const sha = 'a'.repeat(40);
    fs.writeFileSync(f, JSON.stringify({ name: 'remotea-server', sha, dirty: true, built_at: '2026-10-30T00:00:00.000Z' }));
    expect(loadBuildInfo(f)).toEqual({ sha, dirty: true, builtAt: '2026-10-30T00:00:00.000Z' });
    fs.writeFileSync(f, JSON.stringify({ name: 'something-else', sha }));
    expect(loadBuildInfo(f)).toEqual(UNKNOWN_BUILD);
    fs.writeFileSync(f, JSON.stringify({ name: 'remotea-server', sha: 'not-a-sha', dirty: false }));
    expect(loadBuildInfo(f)).toMatchObject({ sha: 'unknown', dirty: null });
    fs.writeFileSync(f, '{nope');
    expect(loadBuildInfo(f)).toEqual(UNKNOWN_BUILD);
  });

  it('the build script writes the commit it ran in', () => {
    const out = path.join(tmpDir(), 'dist', 'build-info.json');
    execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'build-info.mjs'), out], { stdio: 'ignore' });
    const raw = JSON.parse(fs.readFileSync(out, 'utf8'));
    expect(raw.name).toBe('remotea-server');
    let head: string | null = null;
    try {
      head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: __dirname, encoding: 'utf8' }).trim();
    } catch {
      /* no git: the script says unknown */
    }
    expect(raw.sha).toBe(head ?? 'unknown');
    expect(loadBuildInfo(out).sha).toBe(head ?? 'unknown');
    if (head) expect(typeof raw.dirty).toBe('boolean');
  });

  it('server-info.json names the running build only while its process lives', () => {
    const dir = tmpDir();
    const build = { sha: 'b'.repeat(40), dirty: false, builtAt: null };
    writeServerInfo(dir, serverInfo({ bootId: 'boot-1', version: '0.1.0', build }));
    expect(readServerInfo(dir)).toMatchObject({ pid: process.pid, build, proto: 1, capsVersion: ERIDANI_CAPS_VERSION });
    writeServerInfo(dir, serverInfo({ bootId: 'boot-1', version: '0.1.0', build, pid: IMPOSSIBLE_PID }));
    expect(readServerInfo(dir)).toBeNull();
  });

  it('hook version: the installed helper\'s hash, and whether it is the one this checkout ships', () => {
    const cliDir = tmpDir();
    const sourceDir = tmpDir();
    expect(hookVersion({ cliDir, sourceDir })).toEqual({ installed: null, bundled: null, current: null });
    fs.writeFileSync(path.join(sourceDir, 'wmux-hook.js'), 'v2');
    fs.writeFileSync(path.join(cliDir, 'wmux-hook.js'), 'v1');
    expect(hookVersion({ cliDir, sourceDir })).toMatchObject({ installed: fileVersion(path.join(cliDir, 'wmux-hook.js')), current: false });
    fs.writeFileSync(path.join(cliDir, 'wmux-hook.js'), 'v2');
    expect(hookVersion({ cliDir, sourceDir }).current).toBe(true);
    expect(hookVersion({ cliDir, sourceDir }).installed).toMatch(/^[0-9a-f]{12}$/);
  });

  it('remotea status --json reports proto, caps version, the build on disk (unknown from sources) and no running build without a server', async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ port: 1 }));
    const s = await buildStatus(dir);
    expect(s.server).toMatchObject({ running: false, build: null, diskBuild: { sha: 'unknown', dirty: null, builtAt: null }, proto: 1, capsVersion: ERIDANI_CAPS_VERSION });
    expect(s.server.hooks).toHaveProperty('installed');
    expect(s.server.eridani).toMatchObject({ advertised: null });
    expect(fmtBuild(s.server)).toMatch(/^build of the running server unknown; on disk unknown; proto 1 caps v2/);
    const sha = 'c'.repeat(40);
    expect(fmtBuild({ ...s.server, build: { sha, dirty: false, builtAt: null, pid: 1, startedAt: 0, version: '0.1.0' }, diskBuild: { sha: 'd'.repeat(40), dirty: false, builtAt: null }, hooks: { installed: 'abc', bundled: 'def', current: false } }))
      .toBe(`build ${sha.slice(0, 12)}; on disk ${'d'.repeat(12)} (restart to run it); proto 1 caps v2; hooks abc (stale: run \`remotea hooks install\`)`);
  });
});

/** A fake Eridani that records hello and acks the rest. */
class FakeEridani {
  readonly wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  readonly frames: UpFrame[] = [];
  private epoch = 0;
  constructor() {
    this.wss.on('connection', (ws: WebSocket) => {
      ws.on('message', (data) => {
        const f = parseUpFrame(JSON.parse(String(data)));
        if (!f) return;
        this.frames.push(f);
        const send = (b: Record<string, unknown>) => ws.send(JSON.stringify({ v: 1, id: `e-${Math.random()}`, conn_epoch: this.epoch, at: Date.now(), ...b }));
        if (f.t === 'hello') send({ t: 'welcome', host_id: 'host-1', conn_epoch: ++this.epoch, server_time: Date.now() });
        else if ('op_id' in f) send({ t: 'ack', acked_id: f.id, ok: true });
      });
    });
  }
  get url(): string {
    return `ws://127.0.0.1:${(this.wss.address() as { port: number }).port}/link`;
  }
  hellos(): HelloBody[] {
    return this.frames.filter((f) => f.t === 'hello') as unknown as HelloBody[];
  }
  close(): Promise<void> {
    for (const s of this.wss.clients) s.terminate();
    return new Promise((r) => this.wss.close(() => r()));
  }
}

describe('EridaniRuntime hello (caps_version 2)', () => {
  async function runtime(probe: (h: ProbeHarness, bin: string) => Promise<LauncherProbe>) {
    const eri = new FakeEridani();
    cleanups.push(() => eri.close());
    await new Promise((r) => eri.wss.once('listening', r));
    const dir = tmpDir();
    const repo = gitRepo();
    writeEridaniToken(dir, 'eri_bot_test0123456789');
    saveEridaniConfig(dir, { enabled: true, url: eri.url, machine: 'caps-box', collector: 'off' });
    saveTarget(dir, { id: 'jarvis', repo, worktreeRoot: path.join(repo, '..', 'wt-jarvis'), base: 'main', launch: { claude: {} }, verify: [{ id: 'api', argv: ['uv-not-on-path-zz', 'run', 'pytest'], timeout: 600 }] });
    saveTarget(dir, { id: 'remotea', repo, worktreeRoot: path.join(repo, '..', 'wt-remotea'), base: 'main', launch: { claude: {}, codex: {} }, verify: [{ id: 'test', argv: [process.execPath], timeout: 600 }] });
    const cliDir = tmpDir();
    fs.writeFileSync(path.join(cliDir, 'wmux-hook.js'), 'helper');
    const registry = Registry.load({ file: null, bootId: 'boot-1' });
    const hub = new Hub({ registry, spawn: fakeSpawner().spawn, bootId: 'boot-1', serverId: 'srv', hostname: 'box', timers: new ManualTimers(), probe: () => ({}) });
    const logs: string[] = [];
    const rt = new EridaniRuntime({
      dir, hub, registry, serverId: 'srv', bootId: 'boot-1', hostname: 'box', version: '0.1.0',
      log: (m) => logs.push(m),
      windowsUsers: null, checkMs: 3_600_000, scanMs: 3_600_000, resumeAgents: false,
      probe,
      build: { sha: 'e'.repeat(40), dirty: true, builtAt: null },
      hookPaths: { cliDir, sourceDir: tmpDir() },
      adapterHooks: () => ({ claudeAsk: true, codexApproval: true }),
      verifyEnv: { PATH: '/nonexistent-bin' },
    });
    cleanups.push(() => rt.stop());
    return { eri, dir, rt, logs, cliDir };
  }

  it('waits for the probes, then advertises spawn only for the probed harness and per target only what it enables', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const asked: string[] = [];
    const { eri, dir, rt, logs, cliDir } = await runtime(async (h, bin) => {
      asked.push(`${h}:${bin}`);
      await gate;
      return h === 'claude' ? { ok: true, version: '2.0.30' } : h === 'opencode' ? { ok: true, version: '1.17.20' } : { ok: false, version: null, error: '`codex` is not on the login shell\'s PATH' };
    });
    rt.start();
    await until(() => asked.length === 3);
    await new Promise((r) => setTimeout(r, 100));
    expect(eri.hellos()).toHaveLength(0);
    release();
    await until(() => eri.hellos().length === 1);
    const hello = eri.hellos()[0];
    expect(asked.sort()).toEqual(['claude:claude', 'codex:codex', 'opencode:opencode']);
    expect(hello).toMatchObject({
      version: '0.1.0',
      build_sha: 'e'.repeat(40),
      build_dirty: true,
      caps_version: ERIDANI_CAPS_VERSION,
      hook_version: fileVersion(path.join(cliDir, 'wmux-hook.js')),
      proto: 1,
    });
    // 2.0.30 is below the range the AskUserQuestion adapter was tested on: not advertised, hook or no hook.
    expect(hello.harnesses.claude).toMatchObject({ version: '2.0.30', installed: true, spawn: true, question: false, question_kinds: [] });
    expect(hello.harnesses.opencode).toMatchObject({ version: '1.17.20', installed: true, observe: true, capture: false, question: false, spawn: false, resume: false, loop: false });
    expect(hello.harnesses.codex).toMatchObject({ version: null, installed: false, spawn: false, launch_error: expect.stringMatching(/codex/) });
    const byId = Object.fromEntries((hello.targets ?? []).map((t) => [t.id, t]));
    expect(byId.jarvis).toMatchObject({ harnesses: ['claude'], enabled: ['claude'], verify: ['api'], verify_status: [{ id: 'api', ready: false, reason: expect.stringMatching(/service PATH/) }] });
    expect(byId.remotea).toMatchObject({ harnesses: ['claude'], enabled: ['claude', 'codex'], launch: { claude: { ready: true }, codex: { ready: false } }, verify_status: [{ id: 'test', ready: true }] });
    expect(JSON.stringify(hello)).not.toContain('uv-not-on-path-zz');
    expect(logs.some((l) => /codex launcher `codex`: not ready/.test(l))).toBe(true);
    // The status file says the same, for `remotea status` and `remotea eridani status`.
    await until(() => !!readLinkStatus(dir)?.advertised);
    const adv = readLinkStatus(dir)!.advertised!;
    expect(adv).toMatchObject({ build_sha: 'e'.repeat(40), caps_version: ERIDANI_CAPS_VERSION, harnesses: { codex: { spawn: false } } });
    const text = fmtAdvertised(adv).join('\n');
    expect(text).toMatch(/codex not installed/);
    expect(text).toMatch(/target jarvis: claude ready; verify api NOT ready/);
  });

  it('a later link start reuses the last probes and does not wait for the refresh', async () => {
    let calls = 0;
    let hold = false;
    const { eri, rt, dir } = await runtime(async () => {
      calls++;
      if (hold) await new Promise(() => {});
      return { ok: true, version: '1.0.0' };
    });
    rt.start();
    await until(() => eri.hellos().length === 1);
    expect(eri.hellos()[0].harnesses.codex).toMatchObject({ spawn: true });
    hold = true;
    // Touch eridani.json so the runtime reconfigures (a new link, same probes).
    saveEridaniConfig(dir, { enabled: true, url: eri.url, machine: 'caps-box-2', collector: 'off' });
    rt.check();
    await until(() => eri.hellos().length === 2);
    expect(calls).toBeGreaterThan(2);
    expect(eri.hellos()[1].harnesses.codex).toMatchObject({ spawn: true });
  });

  it('a target added later (no reconfigure) has its launcher probed on the next check', async () => {
    const asked: string[] = [];
    const { eri, rt, dir } = await runtime(async (h, bin) => (asked.push(`${h}:${bin}`), { ok: true, version: '1.0.0' }));
    rt.start();
    await until(() => eri.hellos().length === 1);
    const late = gitRepo();
    saveTarget(dir, { id: 'late', repo: late, worktreeRoot: `${late}-wt`, base: 'main', launch: { codex: { bin: '/opt/codex-late' } }, verify: [] });
    rt.check();
    await until(() => asked.includes('codex:/opt/codex-late'));
    await until(() => rt.helloTargets().find((t) => t.id === 'late')?.harnesses.includes('codex') === true);
    expect(eri.hellos()).toHaveLength(1);
  });
});
