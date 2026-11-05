/**
 * S-N4 (verify isolation) and S-S2 (workspace evidence completeness).
 *
 * The sandbox tests run the real bubblewrap when it works on this host (they
 * are skipped otherwise); the fake-bwrap and fake-spawn tests run everywhere.
 */
import { execFileSync, type ChildProcess, type SpawnOptions } from 'child_process';
import { EventEmitter } from 'events';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { PassThrough } from 'stream';
import { afterEach, describe, expect, it } from 'vitest';
import { parseUpFrame } from '../../src/shared/eridani-link-protocol';
import { saveTarget } from '../src/eridani-targets';
import { targetError, type VerifySpec } from '../src/eridani-targets';
import { EridaniRuntime } from '../src/eridani-runtime';
import { Hub } from '../src/hub';
import { Registry } from '../src/registry';
import { runVerify, workspaceState } from '../src/verify-runner';
import { findBwrap, isolationStatus, planIsolation, probeBwrap, resetBwrapProbes, SANDBOX_HOME, withIsolation } from '../src/verify-sandbox';
import type { GitRunner } from '../src/worktrees';
import { fakeSpawner, ManualTimers } from './helpers';

const cleanups: Array<() => unknown> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  resetBwrapProbes();
});

function tmp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
}

function repo(): string {
  const r = tmp('iso-repo-');
  git(r, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(r, 'a.txt'), 'one\n');
  git(r, 'add', '.');
  git(r, 'commit', '-q', '-m', 'init');
  return r;
}

/** A service environment with a secret the run must never see. */
const SERVICE_ENV = { PATH: '/usr/bin:/bin', HOME: os.homedir(), LANG: 'C.UTF-8', REMOTEA_TEST_SECRET: 'sekrit-token-123' };

function fakeBwrapDir(body: string): { dir: string; log: string } {
  const dir = tmp('fake-bwrap-');
  const log = path.join(dir, 'args.log');
  fs.writeFileSync(path.join(dir, 'bwrap'), `#!/bin/sh\nLOG=${JSON.stringify(log)}\n${body}\n`, { mode: 0o755 });
  return { dir, log };
}

/** Records its arguments up to `--`, then runs the rest unsandboxed (argv composition only). */
const RECORDING = `: > "$LOG.tmp"
while [ $# -gt 0 ]; do
  if [ "$1" = "--" ]; then shift; break; fi
  printf '%s\\n' "$1" >> "$LOG.tmp"; shift
done
mv "$LOG.tmp" "$LOG"
exec "$@"`;

const realBwrap = findBwrap(process.env);
const sandboxWorks = !!realBwrap && probeBwrap(realBwrap).ok;
const describeSandbox = sandboxWorks ? describe : describe.skip;

function hostServer(greeting: string): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const s = net.createServer((c) => c.end(greeting));
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      const close = () => s.close();
      cleanups.push(close);
      resolve({ port, close });
    });
  });
}

/** A node fixture that prints what a connection to 127.0.0.1:<port> got. */
const CONNECT = (port: number, host = '127.0.0.1') =>
  `{ const c = require('net').connect(${port}, ${JSON.stringify(host)}); let d = ''; c.setTimeout(3000, () => { console.log('error:TIMEOUT'); c.destroy(); }); c.on('data', (x) => (d += x)); c.on('end', () => console.log('connected:' + d)); c.on('error', (e) => console.log('error:' + e.code)); }`;

describeSandbox('verify sandbox (real bubblewrap)', () => {
  it('a normal verify runs, isolated, with a temporary empty HOME and only the minimal environment', async () => {
    const r = repo();
    const out = await runVerify({
      spec: { id: 't', argv: ['/bin/sh', '-c', 'env; echo "home:$(ls -A "$HOME" | wc -l)"; echo pwd:$(pwd)'], timeout: 20 },
      worktree: r,
      env: SERVICE_ENV,
    });
    expect(out).toMatchObject({ exit_code: 0, isolated: true, isolation: 'bwrap', workspace_complete: true, workspace_reasons: [] });
    expect(out.isolation_reason).toBeUndefined();
    expect(out.tail).toContain(`HOME=${SANDBOX_HOME}`);
    expect(out.tail).toContain('home:0');
    expect(out.tail).toContain(`pwd:${fs.realpathSync(r)}`);
    expect(out.tail).toContain('CI=1');
    expect(out.tail).not.toContain('sekrit-token-123');
    expect(out.tail).not.toContain('REMOTEA_TEST_SECRET');
  });

  it('cannot read a sentinel outside the allowed mounts, nor the real HOME\'s dotfiles', async () => {
    const r = repo();
    const outside = tmp('iso-sentinel-');
    const sentinel = path.join(outside, 'sentinel.txt');
    fs.writeFileSync(sentinel, 'TOP-SECRET-SENTINEL');
    // A sibling of the worktree, in the same parent folder.
    const sibling = path.join(path.dirname(r), `${path.basename(r)}-sibling.txt`);
    fs.writeFileSync(sibling, 'SIBLING-SENTINEL');
    cleanups.push(() => fs.rmSync(sibling, { force: true }));
    const home = os.homedir();
    const out = await runVerify({
      spec: { id: 't', argv: ['/bin/sh', '-c', 'cat "$1" 2>&1; cat "$2" 2>&1; echo "--home--"; ls -A "$3" 2>&1; echo "--end--"', 'x', sentinel, sibling, home], timeout: 20 },
      worktree: r,
      env: SERVICE_ENV,
    });
    expect(out.isolated).toBe(true);
    expect(out.tail).not.toContain('TOP-SECRET-SENTINEL');
    expect(out.tail).not.toContain('SIBLING-SENTINEL');
    const listing = out.tail.split('--home--')[1].split('--end--')[0];
    for (const dot of ['.ssh', '.config', '.bashrc', '.gitconfig', '.claude', '.codex', '.aws']) {
      if (fs.existsSync(path.join(home, dot))) expect(listing.split('\n')).not.toContain(dot);
    }
  });

  it('cannot write outside the worktree and the private /tmp; read-only mounts stay read-only', async () => {
    const r = repo();
    const ro = tmp('iso-ro-');
    fs.writeFileSync(path.join(ro, 'readable.txt'), 'readable-content');
    const out1 = tmp('iso-out-');
    const script = [
      'cat "$1/readable.txt"; echo',
      'echo x > "$1/new.txt" 2>/dev/null && echo WROTE_RO',
      'echo x > "$2/new.txt" 2>/dev/null && echo WROTE_OUT',
      'echo x > /evil.txt 2>/dev/null && echo WROTE_ROOT',
      'echo x > /usr/evil.txt 2>/dev/null && echo WROTE_USR',
      'echo x > /tmp/scratch.txt && echo WROTE_TMP',
      'echo x > inside.txt && echo WROTE_WT',
    ].join('; ');
    const out = await runVerify({
      spec: { id: 't', argv: ['/bin/sh', '-c', script, 'x', ro, out1], timeout: 20, mounts: [ro] },
      worktree: r,
      env: SERVICE_ENV,
    });
    expect(out.isolated).toBe(true);
    expect(out.tail).toContain('readable-content');
    expect(out.tail).toContain('WROTE_TMP');
    expect(out.tail).toContain('WROTE_WT');
    for (const bad of ['WROTE_RO', 'WROTE_OUT', 'WROTE_ROOT', 'WROTE_USR']) expect(out.tail).not.toContain(bad);
    expect(fs.existsSync(path.join(ro, 'new.txt'))).toBe(false);
    expect(fs.existsSync(path.join(out1, 'new.txt'))).toBe(false);
    expect(fs.existsSync('/tmp/scratch.txt') && fs.readFileSync('/tmp/scratch.txt', 'utf8') === 'x\n').toBe(false);
    expect(fs.readFileSync(path.join(r, 'inside.txt'), 'utf8')).toBe('x\n');
  });

  it('a symlinked node_modules outside the worktree is mounted read-only, its vite cache folders get a throwaway tmpfs', async () => {
    const r = repo();
    const deps = path.join(tmp('iso-deps-'), 'node_modules');
    fs.mkdirSync(path.join(deps, '.vite-temp'), { recursive: true });
    fs.writeFileSync(path.join(deps, 'dep.txt'), 'dep-content');
    fs.symlinkSync(deps, path.join(r, 'node_modules'));
    const script = 'cat node_modules/dep.txt; echo; echo x > node_modules/new.txt 2>/dev/null && echo WROTE_DEPS; echo x > node_modules/.vite-temp/cfg.mjs && echo WROTE_CACHE';
    const out = await runVerify({ spec: { id: 't', argv: ['/bin/sh', '-c', script], timeout: 20 }, worktree: r, env: SERVICE_ENV });
    expect(out.tail).toContain('dep-content');
    expect(out.tail).not.toContain('WROTE_DEPS');
    expect(out.tail).toContain('WROTE_CACHE');
    expect(fs.existsSync(path.join(deps, 'new.txt'))).toBe(false);
    expect(fs.readdirSync(path.join(deps, '.vite-temp'))).toEqual([]);
  });

  it('no network by default: neither the host\'s loopback nor the outside', async () => {
    const r = repo();
    const srv = await hostServer('hello-from-host');
    const script = `${CONNECT(srv.port)} require('net').connect(80, '1.1.1.1').on('error', (e) => console.log('outside:' + e.code)).on('connect', () => console.log('outside:CONNECTED'));`;
    const out = await runVerify({ spec: { id: 't', argv: [process.execPath, '-e', script], timeout: 20 }, worktree: r, env: SERVICE_ENV });
    expect(out.isolated).toBe(true);
    expect(out.tail).toContain('error:ECONNREFUSED');
    expect(out.tail).not.toContain('hello-from-host');
    expect(out.tail).toMatch(/outside:E[A-Z]+/);
    expect(out.tail).not.toContain('outside:CONNECTED');
  });

  it('network "loopback" reaches only the listed host ports on 127.0.0.1', async () => {
    const r = repo();
    const allowed = await hostServer('db-greeting');
    const other = await hostServer('other-service');
    const script = `${CONNECT(allowed.port)} ${CONNECT(other.port)}`;
    const out = await runVerify({
      spec: { id: 't', argv: [process.execPath, '-e', script], timeout: 20, network: 'loopback', ports: [allowed.port] },
      worktree: r,
      env: SERVICE_ENV,
    });
    expect(out).toMatchObject({ exit_code: 0, isolated: true });
    expect(out.tail).toContain('connected:db-greeting');
    expect(out.tail).not.toContain('other-service');
    expect(out.tail).toContain('error:ECONNREFUSED');
    // The forwarder's folder is gone after the run.
    expect(fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('remotea-loopback-')).every((f) => !fs.existsSync(path.join(os.tmpdir(), f, `${allowed.port}.sock`)))).toBe(true);
  });

  it('network: true shares the host network', async () => {
    const r = repo();
    const srv = await hostServer('shared-net');
    const out = await runVerify({ spec: { id: 't', argv: [process.execPath, '-e', CONNECT(srv.port)], timeout: 20, network: true }, worktree: r, env: SERVICE_ENV });
    expect(out.isolated).toBe(true);
    expect(out.tail).toContain('connected:shared-net');
  });

  it('a timeout kills the whole sandboxed tree', async () => {
    const r = repo();
    const marker = '47.3125';
    const out = await runVerify({ spec: { id: 't', argv: ['/bin/sh', '-c', `sleep ${marker} & sleep ${marker}`], timeout: 30 }, worktree: r, env: SERVICE_ENV, timeoutMs: 400, killGraceMs: 200 });
    expect(out.timed_out).toBe(true);
    const alive = () =>
      fs.readdirSync('/proc').filter((p) => /^\d+$/.test(p)).some((p) => {
        try {
          return fs.readFileSync(`/proc/${p}/cmdline`, 'utf8') === `sleep\0${marker}\0`;
        } catch {
          return false;
        }
      });
    const end = Date.now() + 4000;
    while (alive() && Date.now() < end) await new Promise((res) => setTimeout(res, 50));
    expect(alive()).toBe(false);
  });
});

describe('verify isolation: the trust choice and its fallback (fake bwrap, fake spawn)', () => {
  it('a fake bwrap on PATH gets the sandbox arguments: no network, private /tmp, read-only root, the worktree read-write', async () => {
    const r = repo();
    const fake = fakeBwrapDir(RECORDING);
    const out = await runVerify({ spec: { id: 't', argv: ['/usr/bin/env'], timeout: 20 }, worktree: r, env: { ...SERVICE_ENV, PATH: `${fake.dir}:/usr/bin:/bin` } });
    expect(out).toMatchObject({ exit_code: 0, isolated: true, isolation: 'bwrap' });
    expect(out.tail).toContain(`HOME=${SANDBOX_HOME}`);
    expect(out.tail).not.toContain('sekrit-token-123');
    const args = fs.readFileSync(fake.log, 'utf8').split('\n');
    expect(args).toContain('--unshare-all');
    expect(args).not.toContain('--share-net');
    expect(args).toContain('--die-with-parent');
    const rw = args.indexOf('--bind');
    expect(args.slice(rw, rw + 3)).toEqual(['--bind', fs.realpathSync(r), fs.realpathSync(r)]);
    expect(args.join(' ')).toContain('--tmpfs /tmp --dir /tmp/home');
    expect(args.join(' ')).toContain('--remount-ro /');
    expect(args.join(' ')).toMatch(/--ro-bind \/etc \/etc/);
  });

  it('network: true adds --share-net; network "loopback" runs the forwarder in front of the command', async () => {
    const r = repo();
    const fake = fakeBwrapDir(RECORDING);
    const env = { ...SERVICE_ENV, PATH: `${fake.dir}:/usr/bin:/bin` };
    await runVerify({ spec: { id: 't', argv: ['/bin/true'], timeout: 20, network: true }, worktree: r, env });
    expect(fs.readFileSync(fake.log, 'utf8').split('\n')).toContain('--share-net');
    // A fake spawn sees the full command line without running it.
    const seen: Array<{ cmd: string; args: string[]; env: NodeJS.ProcessEnv | undefined }> = [];
    const spawn = (cmd: string, args: string[], opts: SpawnOptions): ChildProcess => {
      seen.push({ cmd, args, env: opts.env });
      const child = new EventEmitter() as ChildProcess;
      Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough(), pid: undefined });
      setTimeout(() => child.emit('close', 0, null), 5);
      return child;
    };
    const out = await runVerify({ spec: { id: 't', argv: ['pytest', '-q'], timeout: 20, network: 'loopback', ports: [5432] }, worktree: r, env, spawn });
    expect(out).toMatchObject({ exit_code: 0, isolated: true });
    const { cmd, args } = seen[0];
    expect(cmd).toBe(path.join(fake.dir, 'bwrap'));
    expect(args).not.toContain('--share-net');
    const sep = args.indexOf('--');
    expect(args.slice(0, sep).join(' ')).toMatch(/--ro-bind \S*remotea-loopback-\S+ \/run\/remotea-loopback/);
    expect(args.slice(sep + 1)).toEqual([fs.realpathSync(process.execPath), '/run/remotea-loopback/forward.js', '5432', '--', '/bin/sh', '-c', 'ulimit -c 0 2>/dev/null; exec "$@"', 'remotea-verify', 'pytest', '-q']);
    expect(seen[0].env?.HOME).toBe(SANDBOX_HOME);
  });

  it('where bwrap does not work, the default falls back to none and says why; the run still happens', async () => {
    const r = repo();
    const broken = fakeBwrapDir('echo "bwrap: setting up uid map: Permission denied" >&2; exit 1');
    const env = { ...SERVICE_ENV, PATH: `${broken.dir}:/usr/bin:/bin` };
    const out = await runVerify({ spec: { id: 't', argv: ['/bin/sh', '-c', 'echo ran'], timeout: 20 }, worktree: r, env });
    expect(out).toMatchObject({ exit_code: 0, isolated: false, isolation: 'none' });
    expect(out.isolation_reason).toMatch(/bwrap does not work on this host \(bwrap: setting up uid map/);
    expect(out.tail).toContain('ran');
    // Not installed at all.
    const none = await runVerify({ spec: { id: 't', argv: ['/bin/true'], timeout: 20 }, worktree: r, env: SERVICE_ENV, bwrap: null });
    expect(none).toMatchObject({ exit_code: 0, isolated: false, isolation: 'none', isolation_reason: 'bwrap (bubblewrap) is not installed on the service PATH' });
  });

  it('isolation "bwrap" where bwrap is unusable refuses to run; isolation "none" runs unsandboxed by choice', async () => {
    const r = repo();
    const marker = path.join(r, 'ran.txt');
    const refused = await runVerify({ spec: { id: 't', argv: ['/bin/sh', '-c', `touch ${marker}`], timeout: 20, isolation: 'bwrap' }, worktree: r, env: SERVICE_ENV, bwrap: null });
    expect(refused).toMatchObject({ exit_code: null, isolated: false, isolation: 'bwrap' });
    expect(refused.error).toMatch(/isolation "bwrap" is required but bwrap \(bubblewrap\) is not installed/);
    expect(fs.existsSync(marker)).toBe(false);
    const fake = fakeBwrapDir(RECORDING);
    const chosen = await runVerify({ spec: { id: 't', argv: ['/usr/bin/env'], timeout: 20, isolation: 'none' }, worktree: r, env: { ...SERVICE_ENV, PATH: `${fake.dir}:/usr/bin:/bin` } });
    expect(chosen).toMatchObject({ exit_code: 0, isolated: false, isolation: 'none', isolation_reason: 'the entry sets isolation "none"' });
    expect(fs.existsSync(fake.log)).toBe(false);
    expect(chosen.tail).toContain(`HOME=${os.homedir()}`);
  });

  it('validates isolation, network, ports and mounts', () => {
    const t = (v: Record<string, unknown>) =>
      targetError({ id: 'x', repo: '/r', worktreeRoot: '/w', base: 'main', launch: { claude: {} }, verify: [{ id: 'v', argv: ['npm', 'test'], timeout: 5, ...v }] });
    expect(t({ isolation: 'bwrap', network: 'loopback', ports: [5432], mounts: ['~/.local/share/uv/python', '/opt/tools'] })).toBeNull();
    expect(t({ isolation: 'none' })).toBeNull();
    expect(t({ network: true })).toBeNull();
    expect(t({ isolation: 'docker' })).toMatch(/isolation/);
    expect(t({ network: 'internet' })).toMatch(/network/);
    expect(t({ network: 'loopback' })).toMatch(/ports/);
    expect(t({ network: 'loopback', ports: [0] })).toMatch(/ports/);
    expect(t({ ports: [5432] })).toMatch(/ports only/);
    expect(t({ mounts: ['relative/path'] })).toMatch(/mounts/);
    expect(t({ mounts: ['/'] })).toMatch(/mounts/);
  });

  it('validates notifyAfter: whole seconds, at least 60, under the timeout', () => {
    const t = (v: Record<string, unknown>) =>
      targetError({ id: 'x', repo: '/r', worktreeRoot: '/w', base: 'main', launch: { claude: {} }, verify: [{ id: 'v', argv: ['npm', 'test'], timeout: 7200, ...v }] });
    expect(t({ notifyAfter: 1800 })).toBeNull();
    for (const bad of [30, 7200, 9000, 90.5, '1800']) expect(t({ notifyAfter: bad })).toMatch(/notifyAfter/);
  });

  it('hello verify_status reports whether each entry would run isolated', () => {
    const fake = fakeBwrapDir(RECORDING);
    const specs: VerifySpec[] = [
      { id: 'auto', argv: ['/bin/true'], timeout: 5 },
      { id: 'optout', argv: ['/bin/true'], timeout: 5, isolation: 'none' },
      { id: 'strict', argv: ['/bin/true'], timeout: 5, isolation: 'bwrap' },
    ];
    const status = specs.map((s) => ({ id: s.id, ready: true }));
    expect(withIsolation(status, specs, { PATH: `${fake.dir}:/usr/bin:/bin` })).toEqual([
      { id: 'auto', ready: true, isolated: true, isolation: 'bwrap' },
      { id: 'optout', ready: true, isolated: false, isolation: 'none', isolation_reason: 'the entry sets isolation "none"' },
      { id: 'strict', ready: true, isolated: true, isolation: 'bwrap' },
    ]);
    expect(withIsolation(status, specs, { PATH: '/nonexistent-bin' })).toEqual([
      { id: 'auto', ready: true, isolated: false, isolation: 'none', isolation_reason: 'bwrap (bubblewrap) is not installed on the service PATH' },
      { id: 'optout', ready: true, isolated: false, isolation: 'none', isolation_reason: 'the entry sets isolation "none"' },
      { id: 'strict', ready: false, reason: 'isolation "bwrap" is required but bwrap (bubblewrap) is not installed on the service PATH', isolated: false, isolation: 'bwrap', isolation_reason: 'bwrap (bubblewrap) is not installed on the service PATH' },
    ]);
    expect(isolationStatus(specs[0], {}, null)).toMatchObject({ isolated: false });
    expect(planIsolation(specs[0], { PATH: `${fake.dir}:/usr/bin:/bin` })).toMatchObject({ isolated: true, bwrap: path.join(fake.dir, 'bwrap') });
  });

  it('the runtime\'s hello targets carry the isolation fields', () => {
    const dir = tmp('iso-cfg-');
    const r = repo();
    saveTarget(dir, { id: 'proj', repo: r, worktreeRoot: path.join(path.dirname(r), 'wt-proj'), base: 'main', launch: { claude: {} }, verify: [{ id: 'test', argv: ['/bin/true'], timeout: 60 }] });
    const registry = Registry.load({ file: null, bootId: 'boot-1' });
    const hub = new Hub({ registry, spawn: fakeSpawner().spawn, bootId: 'boot-1', serverId: 'srv', hostname: 'box', timers: new ManualTimers(), probe: () => ({}) });
    const rt = new EridaniRuntime({
      dir, hub, registry, serverId: 'srv', bootId: 'boot-1', hostname: 'box', version: '0.1.0', log: () => {},
      windowsUsers: null, checkMs: 3_600_000, scanMs: 3_600_000, resumeAgents: false,
      verifyEnv: { PATH: '/nonexistent-bin:/usr/bin:/bin' },
    });
    cleanups.push(() => rt.stop());
    const [t] = rt.helloTargets();
    const expected = sandboxWorks && findBwrap({ PATH: '/nonexistent-bin:/usr/bin:/bin' })
      ? { id: 'test', ready: true, isolated: true, isolation: 'bwrap' }
      : { id: 'test', ready: true, isolated: false, isolation: 'none' };
    expect(t.verify_status?.[0]).toMatchObject(expected);
  });
});

describe('workspace evidence completeness (S-S2)', () => {
  const fakeGit = (fail: string): GitRunner => async (args) => {
    if (args[0] === fail) return { code: 128, stdout: '', stderr: 'fatal: boom' };
    if (args[0] === 'rev-parse') return { code: 0, stdout: 'a'.repeat(40) + '\n', stderr: '' };
    if (args[0] === 'symbolic-ref') return { code: 0, stdout: 'main\n', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };

  it('a clean tree is complete with no reasons', async () => {
    const r = repo();
    fs.writeFileSync(path.join(r, 'small.txt'), 'x');
    fs.symlinkSync('a.txt', path.join(r, 'link'));
    expect(await workspaceState(r)).toMatchObject({ complete: true, reasons: [] });
  });

  it('git status or git diff failing makes it incomplete, and verify.result says so', async () => {
    const r = repo();
    expect(await workspaceState(r, fakeGit('status'))).toMatchObject({ complete: false, reasons: ['git status failed'] });
    expect(await workspaceState(r, fakeGit('diff'))).toMatchObject({ complete: false, reasons: ['git diff failed'] });
    const out = await runVerify({ spec: { id: 't', argv: ['/bin/true'], timeout: 10 }, worktree: r, git: fakeGit('status'), bwrap: null });
    expect(out).toMatchObject({ exit_code: 0, workspace_complete: false, workspace_reasons: ['git status failed'] });
  });

  it('more than 2000 untracked files are capped, and say so', async () => {
    const r = repo();
    const d = path.join(r, 'many');
    fs.mkdirSync(d);
    for (let i = 0; i < 2003; i++) fs.writeFileSync(path.join(d, `f${i}.txt`), String(i));
    const s = await workspaceState(r);
    expect(s.complete).toBe(false);
    expect(s.reasons).toEqual(['untracked files capped at 2000 (2003 found)']);
  });

  it('untracked files over 4 MiB are hashed by metadata, and say so', async () => {
    const r = repo();
    fs.writeFileSync(path.join(r, 'big1.bin'), Buffer.alloc(4 * 1024 * 1024 + 1));
    fs.writeFileSync(path.join(r, 'big2.bin'), Buffer.alloc(4 * 1024 * 1024 + 2));
    fs.writeFileSync(path.join(r, 'big3.bin'), Buffer.alloc(4 * 1024 * 1024 + 3));
    fs.writeFileSync(path.join(r, 'edge.bin'), Buffer.alloc(4 * 1024 * 1024));
    const s = await workspaceState(r);
    expect(s).toMatchObject({ complete: false, reasons: ['3 untracked files over 4 MiB hashed by size and mtime'] });
    const out = await runVerify({ spec: { id: 't', argv: ['/bin/true'], timeout: 10 }, worktree: r, bwrap: null });
    expect(out).toMatchObject({ workspace_complete: false, workspace_reasons: ['3 untracked files over 4 MiB hashed by size and mtime'] });
  });

  it('a repository with no commit yet still fingerprints staged content', async () => {
    const r = tmp('iso-empty-');
    git(r, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(r, 'a.txt'), 'one');
    git(r, 'add', '.');
    const a = await workspaceState(r);
    expect(a).toMatchObject({ head: null, complete: true });
    fs.writeFileSync(path.join(r, 'a.txt'), 'two');
    git(r, 'add', '.');
    expect((await workspaceState(r)).fingerprint).not.toBe(a.fingerprint);
  });

  it('a missing worktree is incomplete evidence', async () => {
    const out = await runVerify({ spec: { id: 't', argv: ['/bin/true'], timeout: 10 }, worktree: '/nonexistent/wt', bwrap: null });
    expect(out).toMatchObject({ workspace_fingerprint: 'none:', workspace_complete: false, workspace_reasons: ['the workspace was not read'] });
  });

  it('the wire frame carries the new fields', () => {
    const frame = {
      v: 1, id: 'f1', t: 'verify.result', op_id: 'o', digest: 'd', attempt_id: 'a', run_id: 'r', generation: 1, turn_seq: 1, plan_revision: 1, verify_id: 'v',
      workspace_fingerprint: 'h:t', exit_code: 0, tail: '', truncated: false, duration_ms: 1, timed_out: false, canceled: false, stale_workspace: false,
      isolated: true, isolation: 'bwrap', workspace_complete: false, workspace_reasons: ['git status failed'],
    };
    expect(parseUpFrame(frame)).toMatchObject({ isolated: true, isolation: 'bwrap', workspace_complete: false, workspace_reasons: ['git status failed'] });
  });
});
