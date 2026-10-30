/**
 * `remotea doctor` (S-Q1): the findings for each kind of fact, redaction,
 * the summary Eridani gets, the JSON shape, the exit code, and a gather run
 * against a scratch config dir with the host's moving parts faked.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { ERIDANI_CAPS_VERSION, ERIDANI_LIMITS, STAGE_F_CAPS, isDoctorSummary, parseUpFrame } from '../../src/shared/eridani-link-protocol';
import {
  DOCTOR_VERSION,
  buildReport,
  dbCheck,
  depsCheck,
  doctorCommand,
  doctorSummary,
  evaluate,
  gatherFacts,
  scrub,
  type DoctorFacts,
  type DoctorItem,
} from '../src/doctor';
import { codexTrust } from '../src/hooks-install';
import { EridaniLink, type LinkStatus } from '../src/eridani-link';
import { probeLink } from '../src/eridani-cli';
import { EridaniRuntime, linkCaps } from '../src/eridani-runtime';
import { Hub } from '../src/hub';
import { Registry } from '../src/registry';
import { fakeSpawner, ManualTimers } from './helpers';
import { hookVersion, loadBuildInfo } from '../src/build-info';
import { defaultHookPaths } from '../src/hooks-install';
import { saveEridaniConfig, writeEridaniToken } from '../src/config';
import { saveTarget } from '../src/eridani-targets';

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function tmp(prefix = 'doctor-'): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  cleanups.push(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

const HOME = '/home/u';
const NOW = 1_800_000_000_000;
const SHA = 'a'.repeat(40);

function link(over: Partial<LinkStatus> = {}): LinkStatus {
  return {
    enabled: true, state: 'ready', url: 'wss://eri/api/v1/external/agents/link', machine: 'box', hostId: 'host-1', connEpoch: 3, attempt: 0, error: null,
    lastConnectedAt: NOW - 60_000, lastAckAt: NOW - 5_000, unacked: 0, spool: { entries: 0, bytes: 0, fill: 0, evicted: 0, degraded: null }, dirty: 0,
    degraded: null, journal: { degraded: null, unrecorded: 0, refused: 0 }, rejected: 0, lastRejection: null, updatedAt: NOW, pid: 1,
    ...over,
  };
}

/** A healthy host with one target: everything ok. */
function facts(over: Partial<DoctorFacts> = {}): DoctorFacts {
  const repo = tmp('doctor-repo-');
  fs.mkdirSync(path.join(repo, '.git'));
  return {
    now: NOW,
    hostname: 'box',
    home: HOME,
    probed: false,
    service: { unitFile: `${HOME}/.config/systemd/user/remotea.service`, installed: true, active: 'active', enabled: 'enabled', user: 'u', path: `${HOME}/.nvm/versions/node/v22.13.0/bin:/usr/bin:/bin` },
    listener: { port: 7717, accepting: true, healthy: true, hookPort: 7718, hookAccepting: true, token: { present: true, mode: 0o600 } },
    running: { pid: 1, bootId: 'boot-1', startedAt: NOW - 3_600_000, version: '0.1.0', build: { sha: SHA, dirty: false, builtAt: null }, proto: 1, capsVersion: 2 },
    diskBuild: { sha: SHA, dirty: false, builtAt: null },
    helper: { installed: 'abc123abc123', bundled: 'abc123abc123', current: true },
    agentHooks: [
      { agent: 'claude', file: `${HOME}/.claude/settings.json`, present: true, entries: 9, expected: 9, helperPath: true },
      { agent: 'codex', file: `${HOME}/.codex/hooks.json`, present: true, entries: 7, expected: 7, helperPath: true, trust: { trusted: 7, disabled: 0, total: 7 } },
      { agent: 'opencode', file: `${HOME}/.config/opencode/plugin/wmux.js`, present: false, entries: 0, expected: 1, helperPath: null, version: { installed: null, bundled: 'ffff' } },
    ],
    eridani: { configured: true, enabled: true, keyPresent: true, mode: 'parity', link: link() },
    collector: { sqlite: null, stateMtime: NOW - 60_000, scan: { mode: 'parity', lastScanAt: NOW - 60_000, lastScan: { seen: 4, queued: 1, failed: 0 }, lastScanError: null, codexUnavailable: null } },
    targets: [{ id: 'proj', repo, worktreeRoot: `${HOME}/wt`, base: 'main', launch: { claude: {} }, verify: [{ id: 'test', argv: ['/usr/bin/true'], timeout: 60 }] }],
    readiness: [{ id: 'proj', repo, harnesses: ['claude'], enabled: ['claude'], launch: { claude: { ready: true, version: '2.1.0' } }, verify: ['test'], verify_status: [{ id: 'test', ready: true }], mcp: { configured: true } }],
    readinessSource: 'hello',
    serviceEnv: { PATH: '/usr/bin:/bin' },
    bwrap: '/usr/bin/bwrap',
    disks: [{ id: 'disk.config', label: 'config', path: `${HOME}/.config/remotea`, free: 100 * 1024 ** 3, total: 500 * 1024 ** 3 }],
    uploads: { bytes: 1024, files: 1, budget: 2048 * 1024 ** 2, source: 'measured', degraded: null },
    worktrees: [],
    registry: { v: 1, epoch: 'e', groups: {}, sessions: {}, tombstones: {}, devices: {} },
    ...over,
  };
}

const byId = (items: DoctorItem[], id: string) => items.find((i) => i.id === id);

describe('doctor: evaluate', () => {
  it('a healthy host is all ok, with no fix lines', () => {
    const items = evaluate(facts());
    const bad = items.filter((i) => i.level !== 'ok');
    expect(bad).toEqual([]);
    expect(items.every((i) => i.fix === undefined)).toBe(true);
    for (const id of ['service.unit', 'service.active', 'service.user', 'service.path', 'build.running', 'build.disk', 'build.caps', 'listener.port', 'listener.token', 'listener.hooks', 'collector.mode', 'collector.sqlite', 'collector.scan', 'eridani.link', 'eridani.backlog', 'eridani.journal', 'hooks.helper', 'hooks.claude', 'hooks.codex', 'hooks.codex.trust', 'hooks.opencode', 'target.proj.repo', 'target.proj.launch.claude', 'target.proj.verify.test', 'target.proj.mcp', 'targets.isolation', 'disk.config', 'uploads.budget', 'recovery.worktrees', 'recovery.sessions']) {
      expect(byId(items, id), id).toBeDefined();
    }
    expect(byId(items, 'service.path')!.summary).toBe('PATH from the unit: ~/.nvm/versions/node/v22.13.0/bin:/usr/bin:/bin');
    expect(byId(items, 'eridani.link')!.summary).toMatch(/^ready: host host-1, last welcome 1m ago/);
  });

  it('a stopped service fails with the commands to start it and read its log; never restarts anything', () => {
    const items = evaluate(facts({
      service: { ...facts().service, active: 'failed' },
      listener: { ...facts().listener, accepting: false, healthy: false, hookAccepting: false },
      running: null,
      eridani: { ...facts().eridani, link: null },
    }));
    expect(byId(items, 'service.active')).toMatchObject({ level: 'fail', summary: 'remotea.service is failed', fix: expect.stringContaining('systemctl --user start remotea') });
    expect(byId(items, 'listener.port')).toMatchObject({ level: 'fail', summary: 'nothing accepts connections on 127.0.0.1:7717' });
    expect(byId(items, 'eridani.link')).toMatchObject({ level: 'warn', summary: 'link enabled; the server is not running' });
    expect(byId(items, 'listener.hooks')).toBeUndefined(); // the port failure already says it
  });

  it('build: a dirty running build, and one on disk that a restart would run', () => {
    const items = evaluate(facts({ running: { ...facts().running!, build: { sha: SHA, dirty: true, builtAt: null } }, diskBuild: { sha: 'b'.repeat(40), dirty: false, builtAt: null } }));
    expect(byId(items, 'build.running')).toMatchObject({ level: 'warn', summary: expect.stringContaining('+dirty') });
    expect(byId(items, 'build.disk')).toMatchObject({ level: 'warn', summary: expect.stringContaining('a restart would run it'), fix: expect.stringContaining('systemctl --user restart remotea') });
  });

  it('token: missing fails, readable by others warns; its value is never part of a fact', () => {
    expect(byId(evaluate(facts({ listener: { ...facts().listener, token: { present: false, mode: null } } })), 'listener.token')).toMatchObject({ level: 'fail', fix: 'remotea token (creates one)' });
    expect(byId(evaluate(facts({ listener: { ...facts().listener, token: { present: true, mode: 0o644 } } })), 'listener.token')).toMatchObject({ level: 'warn', summary: expect.stringContaining('644') });
  });

  it('eridani: refused key fails, outbox degraded fails, nearly full warns, journal degraded fails, refusals warn', () => {
    expect(byId(evaluate(facts({ eridani: { ...facts().eridani, link: link({ state: 'auth-failed' }) } })), 'eridani.link')).toMatchObject({ level: 'fail', fix: expect.stringContaining('remotea eridani setup') });
    expect(byId(evaluate(facts({ eridani: { ...facts().eridani, keyPresent: false } })), 'eridani.link')).toMatchObject({ level: 'fail', summary: 'link enabled but the link key is missing' });
    const degraded = evaluate(facts({ eridani: { ...facts().eridani, link: link({ spool: { entries: 3, bytes: 10, fill: 0.1, evicted: 0, degraded: 'disk-full' }, journal: { degraded: 'write failed: ENOSPC', unrecorded: 1, refused: 2 }, rejected: 2, lastRejection: 'INVALID_ARGUMENT' }) } }));
    expect(byId(degraded, 'eridani.backlog')).toMatchObject({ level: 'fail', summary: expect.stringContaining('disk-full') });
    expect(byId(degraded, 'eridani.journal')).toMatchObject({ level: 'fail' });
    expect(byId(degraded, 'eridani.rejected')).toMatchObject({ level: 'warn', summary: expect.stringContaining('INVALID_ARGUMENT') });
    expect(byId(evaluate(facts({ eridani: { ...facts().eridani, link: link({ spool: { entries: 4000, bytes: 1, fill: 0.85, evicted: 0, degraded: null } }) } })), 'eridani.backlog')).toMatchObject({ level: 'warn' });
  });

  it('not set up: Eridani is optional, so ok; no targets is then not a finding', () => {
    const items = evaluate(facts({ eridani: { configured: false, enabled: false, keyPresent: false, mode: 'parity', link: null }, targets: [], readiness: [], worktrees: null }));
    expect(byId(items, 'eridani.link')).toMatchObject({ level: 'ok', summary: 'Eridani link not set up (optional)' });
    expect(byId(items, 'targets')).toBeUndefined();
    expect(items.filter((i) => i.level !== 'ok')).toEqual([]);
  });

  it('collector: a stale scan while the link is ready warns; no node:sqlite warns', () => {
    const scan = { mode: 'parity', lastScanAt: NOW - 30 * 60_000, lastScan: { seen: 1, queued: 0, failed: 0 }, lastScanError: null, codexUnavailable: 'Node 22.12 has no node:sqlite.' };
    const items = evaluate(facts({ collector: { sqlite: null, stateMtime: null, scan } }));
    expect(byId(items, 'collector.scan')).toMatchObject({ level: 'warn', summary: 'last scan 30m ago (it runs every 2 min while the link is ready)' });
    expect(byId(items, 'collector.sqlite')).toMatchObject({ level: 'warn', summary: expect.stringContaining('Codex sessions are not collected') });
  });

  it('hooks: missing, partial, stale helper, untrusted and disabled Codex entries', () => {
    const items = evaluate(facts({
      helper: { installed: 'old', bundled: 'new', current: false },
      agentHooks: [
        { agent: 'claude', file: `${HOME}/.claude/settings.json`, present: true, entries: 0, expected: 9, helperPath: null },
        { agent: 'codex', file: `${HOME}/.codex/hooks.json`, present: true, entries: 7, expected: 7, helperPath: true, trust: { trusted: 5, disabled: 0, total: 7 } },
        { agent: 'opencode', file: `${HOME}/.config/opencode/plugin/wmux.js`, present: true, entries: 1, expected: 1, helperPath: null, version: { installed: 'aaaa', bundled: 'bbbb' } },
      ],
    }));
    expect(byId(items, 'hooks.helper')).toMatchObject({ level: 'warn', fix: 'remotea hooks install' });
    expect(byId(items, 'hooks.claude')).toMatchObject({ level: 'warn', summary: expect.stringContaining('no remotea hooks') });
    expect(byId(items, 'hooks.codex.trust')).toMatchObject({ level: 'warn', summary: expect.stringContaining('2 of 7') });
    expect(byId(items, 'hooks.opencode')).toMatchObject({ level: 'warn', summary: expect.stringContaining('stale') });
    const disabled = evaluate(facts({ agentHooks: [{ agent: 'codex', file: 'f', present: true, entries: 7, expected: 7, helperPath: true, trust: { trusted: 7, disabled: 1, total: 7 } }] }));
    expect(byId(disabled, 'hooks.codex.trust')).toMatchObject({ level: 'warn', summary: expect.stringContaining('disabled') });
  });

  it('targets: an unprobed launcher warns with --probe, a broken one fails, a verify program off the service PATH fails, no MCP warns', () => {
    const f = facts();
    const unprobed = evaluate(facts({ targets: f.targets, readiness: [{ ...f.readiness[0], launch: { claude: { ready: false, version: null, error: 'not probed yet' } } }] }));
    expect(byId(unprobed, 'target.proj.launch.claude')).toMatchObject({ level: 'warn', fix: expect.stringContaining('remotea doctor --probe') });
    const broken = evaluate(facts({
      targets: f.targets,
      readiness: [{ ...f.readiness[0], launch: { claude: { ready: false, version: null, error: '`claude` is not on the login shell\'s PATH' } }, verify_status: [{ id: 'test', ready: false, reason: 'its program is not on the service PATH' }], mcp: { configured: false, reason: 'no MCP key file at /home/u/.config/remotea/eridani-mcp-token' } }],
    }));
    expect(byId(broken, 'target.proj.launch.claude')).toMatchObject({ level: 'fail', summary: expect.stringContaining("not on the login shell's PATH") });
    expect(byId(broken, 'target.proj.verify.test')).toMatchObject({ level: 'fail', summary: 'proj/test: its program is not on the service PATH' });
    expect(byId(broken, 'target.proj.mcp')).toMatchObject({ level: 'warn', summary: expect.stringContaining('~/.config/remotea/eridani-mcp-token') });
  });

  it('isolation: per entry when the build reports it, else whether bubblewrap is on the service PATH', () => {
    const f = facts();
    expect(byId(evaluate(facts({ bwrap: null })), 'targets.isolation')).toMatchObject({ level: 'warn', fix: 'sudo apt install bubblewrap' });
    const reported = evaluate(facts({ readiness: [{ ...f.readiness[0], verify_status: [{ id: 'test', ready: true, isolated: false, isolation_reason: 'bwrap does not work on this host' } as never] }] }));
    expect(byId(reported, 'targets.isolation')).toMatchObject({ level: 'warn', summary: expect.stringContaining('proj/test (bwrap does not work on this host)') });
  });

  it('disk, uploads and recovery', () => {
    const items = evaluate(facts({
      disks: [
        { id: 'disk.config', label: 'config', path: `${HOME}/.config/remotea`, free: 512 * 1024 ** 2, total: 500 * 1024 ** 3 },
        { id: 'disk.temp', label: 'temp', path: '/tmp', free: 3 * 1024 ** 3, total: 50 * 1024 ** 3 },
      ],
      uploads: { bytes: 2000 * 1024 ** 2, files: 30, budget: 2048 * 1024 ** 2, source: 'server', degraded: null },
      worktrees: [{ target: 'proj', path: `${HOME}/wt/eri--t1`, branch: 'eri/t1', base: 'main', head: 'x', active: false, ahead: 2, behind: 0, unpushed: null, upstream: null, merged: false, uncommitted: 0, untracked: 0, ignored: 0, candidate: false, reasons: ['not merged into main (2 commit(s) ahead)', 'no upstream: the commits exist only here'] }],
      registry: {
        v: 1, epoch: 'e', groups: {}, tombstones: {}, devices: {},
        sessions: {
          'surf-a': { id: 'surf-a', groupId: null, cwd: '/', createdBy: 'd', createdAt: 1, bootId: 'boot-0', state: 'live', hiddenBy: [] },
          'surf-b': { id: 'surf-b', groupId: null, cwd: '/', createdBy: 'd', createdAt: 1, bootId: 'boot-0', state: 'lost', hiddenBy: [], eridani: { runId: 'r', generation: 1, attempt: 1, taskId: null, target: 'proj', harness: 'claude', model: 'm', worktree: '/w', branch: 'b', base: 'main', baseSha: null } as never },
        } as never,
      },
    }));
    expect(byId(items, 'disk.config')).toMatchObject({ level: 'fail' });
    expect(byId(items, 'disk.temp')).toMatchObject({ level: 'warn' });
    expect(byId(items, 'uploads.budget')).toMatchObject({ level: 'warn', summary: expect.stringContaining('over 90%') });
    expect(byId(items, 'recovery.worktrees')).toMatchObject({ level: 'warn', summary: expect.stringContaining('eri/t1 (not merged into main'), fix: expect.stringContaining('remotea eridani worktrees') });
    expect(byId(items, 'recovery.sessions')).toMatchObject({ level: 'warn', summary: expect.stringMatching(/1 session\(s\) marked live by an earlier server boot.*1 Eridani session\(s\) lost/) });
  });

  it('redacts keys and writes $HOME as ~ in every line, whatever a fact carried', () => {
    const items = evaluate(facts({ eridani: { ...facts().eridani, link: link({ state: 'reconnecting', error: 'closed 1006: Bearer eri_bot_SECRETSECRET1234 at /home/u/.config/remotea' }) } }));
    const line = byId(items, 'eridani.link')!.summary;
    expect(line).not.toContain('SECRETSECRET');
    expect(line).not.toContain('/home/u');
    expect(line).toContain('~/.config/remotea');
    expect(scrub('cd /home/u && ls /home/user2', '/home/u')).toBe('cd ~ && ls /home/user2');
  });
});

describe('doctor: verify dependencies and database heuristics', () => {
  it('a node runner without node_modules warns; with it, or with an install step, is ok; unknown toolchains are not judged', () => {
    const repo = tmp();
    fs.writeFileSync(path.join(repo, 'package.json'), '{}');
    expect(depsCheck(repo, { id: 't', argv: ['npm', 'test'], timeout: 1 })).toMatchObject({ ok: false });
    expect(depsCheck(repo, { id: 't', argv: ['npm', 'ci'], timeout: 1 })).toMatchObject({ ok: true });
    fs.mkdirSync(path.join(repo, 'node_modules'));
    expect(depsCheck(repo, { id: 't', argv: ['npx', 'vitest', 'run'], timeout: 1 })).toMatchObject({ ok: true });
    expect(depsCheck(repo, { id: 't', argv: ['./scripts/verify.sh'], timeout: 1 })).toBeNull();
  });

  it('a bare pytest in a Python project without a .venv warns', () => {
    const repo = tmp();
    fs.writeFileSync(path.join(repo, 'pyproject.toml'), '');
    expect(depsCheck(repo, { id: 't', argv: ['pytest', '-q'], timeout: 1 })).toMatchObject({ ok: false });
    expect(depsCheck(repo, { id: 't', argv: ['/opt/venv/bin/pytest'], timeout: 1 })).toBeNull();
  });

  it('pytest in an alembic project needs a database URL in the entry env (names only); a wrapper script is not judged', () => {
    const repo = tmp();
    fs.mkdirSync(path.join(repo, 'apps', 'api'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'apps', 'api', 'alembic.ini'), '');
    expect(dbCheck(repo, { id: 't', argv: ['uv', 'run', 'pytest'], cwd: 'apps/api', timeout: 1 })).toMatchObject({ ok: false });
    const ok = dbCheck(repo, { id: 't', argv: ['uv', 'run', 'pytest'], cwd: 'apps/api', timeout: 1, env: { JARVIS_DATABASE_URL: 'postgresql://secret@x/db' } });
    expect(ok).toMatchObject({ ok: true, summary: expect.stringContaining('JARVIS_DATABASE_URL') });
    expect(ok!.summary).not.toContain('secret');
    expect(dbCheck(repo, { id: 't', argv: ['scripts/verify.sh'], cwd: 'apps/api', timeout: 1 })).toBeNull();
    expect(dbCheck(repo, { id: 't', argv: ['npm', 'test'], timeout: 1 })).toBeNull();
  });
});

describe('doctor: Codex trust records', () => {
  const hooks = '/home/u/.codex/hooks.json';
  const handlers: Array<[string, number, number, string]> = [['SessionStart', 1, 0, 'node wmux-hook.js'], ['PermissionRequest', 0, 0, 'node wmux-hook.js']];
  it('counts trusted and disabled entries by position; no hooks.state at all is "cannot tell"', () => {
    const toml = [
      '[hooks.state]',
      '',
      `[hooks.state."${hooks}:session_start:1:0"]`,
      'trusted_hash = "sha256:aa"',
      '',
      `[hooks.state."${hooks}:permission_request:0:0"]`,
      'trusted_hash = "sha256:bb"',
      'enabled = false',
      '',
      '[tui]',
      'x = 1',
    ].join('\n');
    expect(codexTrust(toml, hooks, handlers)).toEqual({ trusted: 2, disabled: 1, total: 2 });
    expect(codexTrust(toml.replace('session_start:1:0', 'session_start:0:0'), hooks, handlers)).toEqual({ trusted: 1, disabled: 1, total: 2 });
    expect(codexTrust('[tui]\nx = 1\n', hooks, handlers)).toBeNull();
    expect(codexTrust(null, hooks, handlers)).toBeNull();
  });
});

describe('doctor: the summary Eridani gets', () => {
  it('only warn and fail, fail first, at most doctorItems, each clipped; counts stay complete', () => {
    const items: DoctorItem[] = [];
    for (let i = 0; i < 50; i++) items.push({ id: `w.${i}`, section: 'disk', level: 'warn', summary: 'x'.repeat(300), fix: 'f' });
    items.push({ id: 'f.1', section: 'service', level: 'fail', summary: 'down', fix: 'start it' });
    items.push({ id: 'o.1', section: 'build', level: 'ok', summary: 'fine' });
    const s = doctorSummary({ at: NOW, ok: 1, warn: 50, fail: 1, items });
    expect(s.items).toHaveLength(ERIDANI_LIMITS.doctorItems);
    expect(s.items[0]).toEqual({ id: 'f.1', level: 'fail', summary: 'down', fix: 'start it' });
    expect(s.items.some((i) => i.id === 'o.1')).toBe(false);
    expect(s.items[1].summary).toHaveLength(ERIDANI_LIMITS.doctorTextChars);
    expect(s).toMatchObject({ at: NOW, ok: 1, warn: 50, fail: 1, truncated: true });
    expect(isDoctorSummary(s)).toBe(true);
    expect(parseUpFrame({ v: 1, id: 'i', conn_epoch: 1, at: NOW, t: 'doctor', op_id: 'o', digest: 'd', ...s })).not.toBeNull();
    expect(isDoctorSummary({ ...s, items: [...s.items, s.items[0]] })).toBe(false); // over the cap
  });

  it('a healthy host sends counts and no items', () => {
    const r = buildReport(facts());
    expect(doctorSummary(r)).toEqual({ at: NOW, ok: r.ok, warn: 0, fail: 0, items: [] });
  });
});

describe('doctor: gather and the command', () => {
  function world() {
    const root = tmp();
    const home = path.join(root, 'home');
    const dir = path.join(home, '.config', 'remotea');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, 'token'), 'TOKEN-VALUE-never-printed\n', { mode: 0o600 });
    writeEridaniToken(dir, 'eri_bot_LINKKEYnever0printed');
    saveEridaniConfig(dir, { enabled: true, url: 'wss://eri.example/api/v1/external/agents/link', machine: 'box', collector: 'parity' });
    const repo = path.join(home, 'src', 'proj');
    fs.mkdirSync(repo, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init']);
    fs.writeFileSync(path.join(repo, 'package.json'), '{}');
    saveTarget(dir, { id: 'proj', repo, worktreeRoot: path.join(home, 'wt'), base: 'main', launch: { claude: {} }, verify: [{ id: 'test', argv: ['npm', 'test'], timeout: 60 }] });
    const unitDir = path.join(home, '.config', 'systemd', 'user');
    fs.mkdirSync(unitDir, { recursive: true });
    fs.writeFileSync(path.join(unitDir, 'remotea.service'), `[Service]\nExecStart=/usr/bin/node ${home}/remotea/dist/main.js\nEnvironment=PATH=${home}/.nvm/bin:/usr/bin:/bin\n`);
    const hookPaths = { home, cliDir: path.join(home, '.local', 'share', 'remotea', 'cli'), sourceDir: defaultHookPaths().sourceDir };
    const calls: string[][] = [];
    const opts = {
      home,
      env: { PATH: '/usr/bin:/bin' } as NodeJS.ProcessEnv,
      now: () => NOW,
      hostname: 'box',
      hookPaths,
      tmpDir: path.join(root, 'tmp'),
      systemctl: async (args: string[]) => {
        calls.push(args);
        return args[0] === 'is-active' ? 'active' : 'enabled';
      },
      accepts: async () => false,
      healthz: async () => false,
      statfs: () => ({ free: 50 * 1024 ** 3, total: 100 * 1024 ** 3 }),
    };
    return { root, home, dir, repo, opts, calls };
  }

  it('reads the unit, never prints a key or token, writes $HOME as ~, and asks systemctl only read-only questions', async () => {
    const w = world();
    const f = await gatherFacts({ dir: w.dir, ...w.opts });
    expect(f.service).toMatchObject({ installed: true, active: 'active', enabled: 'enabled', path: `${w.home}/.nvm/bin:/usr/bin:/bin` });
    expect(w.calls).toEqual([['is-active', 'remotea'], ['is-enabled', 'remotea']]);
    expect(f.listener.token).toEqual({ present: true, mode: 0o600 });
    expect(f.eridani).toMatchObject({ configured: true, enabled: true, keyPresent: true, mode: 'parity', link: null });
    expect(f.readinessSource).toBe('disk');
    expect(f.worktrees).toEqual([]);
    const report = buildReport(f);
    const json = JSON.stringify(report);
    expect(json).not.toContain('TOKEN-VALUE');
    expect(json).not.toContain('LINKKEY');
    expect(json).not.toContain(w.home);
    expect(byId(report.items, 'service.path')!.summary).toBe('PATH from the unit: ~/.nvm/bin:/usr/bin:/bin');
    expect(byId(report.items, 'target.proj.verify.test.deps')).toMatchObject({ level: 'warn' });
    expect(byId(report.items, 'target.proj.launch.claude')).toMatchObject({ level: 'warn', summary: 'proj: claude launch not probed yet' });
    expect(byId(report.items, 'listener.port')).toMatchObject({ level: 'fail' });
  });

  it('--probe runs the launch probes; --json prints the stable shape; the exit code is 1 on a fail', async () => {
    const w = world();
    const probed: string[] = [];
    const out = { text: '', write(s: string) { this.text += s; return true; } };
    const code = await doctorCommand(w.dir, ['--json', '--probe'], out as unknown as NodeJS.WritableStream, {
      ...w.opts,
      probe: async (h, bin) => {
        probed.push(`${h}:${bin}`);
        return { ok: true, version: '2.1.0' };
      },
    });
    expect(code).toBe(1); // nothing listens on the port
    expect(probed).toContain('claude:claude');
    const r = JSON.parse(out.text);
    expect(Object.keys(r).sort()).toEqual(['at', 'fail', 'hostname', 'items', 'ok', 'probed', 'version', 'warn']);
    expect(r).toMatchObject({ version: DOCTOR_VERSION, at: NOW, hostname: 'box', probed: true });
    for (const i of r.items) {
      expect(Object.keys(i).every((k) => ['id', 'section', 'level', 'summary', 'fix'].includes(k))).toBe(true);
      expect(['ok', 'warn', 'fail']).toContain(i.level);
    }
    expect(r.items.find((i: DoctorItem) => i.id === 'target.proj.launch.claude')).toMatchObject({ level: 'ok', summary: 'proj: claude 2.1.0 starts through the login shell (probed now)' });
    expect(r.ok + r.warn + r.fail).toBe(r.items.length);
  });

  it('exits 0 when nothing fails, and the human report groups by section with fix lines', async () => {
    const w = world();
    fs.mkdirSync(path.join(w.repo, 'node_modules'));
    // npm on the unit's PATH, not on the caller's: verify readiness follows the service.
    fs.mkdirSync(path.join(w.home, '.nvm', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(w.home, '.nvm', 'bin', 'npm'), '#!/bin/sh\n', { mode: 0o755 });
    const out = { text: '', write(s: string) { this.text += s; return true; } };
    const code = await doctorCommand(w.dir, [], out as unknown as NodeJS.WritableStream, { ...w.opts, accepts: async () => true, healthz: async () => true, probe: async () => ({ ok: true, version: '1.0' }) });
    expect(out.text).toMatch(/^remotea doctor on box/);
    expect(out.text).toMatch(/\nservice\n {2}ok {4}service\.unit/);
    expect(out.text).toMatch(/fix: /);
    expect(out.text).toMatch(/\d+ ok, \d+ warn, 0 fail\n$/);
    expect(code).toBe(0);
  });

  it('refuses an unknown option', async () => {
    const w = world();
    await expect(doctorCommand(w.dir, ['--fix'], { write: () => true } as unknown as NodeJS.WritableStream, w.opts)).rejects.toThrow(/usage: remotea doctor/);
  });
});

describe('remotea eridani connect: the probe hello carries the real identity', () => {
  it('build_sha, build_dirty, caps_version, hook_version and caps match what the link\'s hello says', async () => {
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    cleanups.push(() => new Promise((r) => wss.close(() => r(undefined))));
    await new Promise((r) => wss.once('listening', r));
    const hellos: Array<Record<string, unknown>> = [];
    wss.on('connection', (ws: WebSocket) => ws.on('message', (data) => {
      const raw = JSON.parse(String(data)) as Record<string, unknown>;
      const f = parseUpFrame(raw);
      if (f?.t !== 'hello') return;
      hellos.push(raw);
      ws.send(JSON.stringify({ v: 1, id: 'e-1', conn_epoch: 7, at: Date.now(), t: 'welcome', host_id: null, probe: true, server_time: Date.now(), caps: [] }));
    }));
    const url = `ws://127.0.0.1:${(wss.address() as { port: number }).port}/link`;
    await probeLink(url, 'eri_bot_test0123456789', { server_id: 'srv-1', machine: 'box', version: '9.9.9' });
    expect(hellos).toHaveLength(1);
    const real = new EridaniLink({
      url, token: () => null, dir: null, serverId: 'srv-1', bootId: 'b', hostname: 'h', machine: 'box', version: '9.9.9',
      build: loadBuildInfo(), capsVersion: ERIDANI_CAPS_VERSION, hookVersion: () => hookVersion(defaultHookPaths()).installed, caps: () => linkCaps('parity'),
    }).advertised();
    const pick = (o: Record<string, unknown>) => ({ proto: o.proto, version: o.version, build_sha: o.build_sha, build_dirty: o.build_dirty, caps_version: o.caps_version, hook_version: o.hook_version, caps: o.caps });
    expect(pick(hellos[0])).toEqual(pick(real as unknown as Record<string, unknown>));
    expect(hellos[0]).toHaveProperty('build_sha');
    expect(hellos[0]).toHaveProperty('hook_version');
    expect(hellos[0].caps_version).toBe(ERIDANI_CAPS_VERSION);
    expect(hellos[0].caps).toEqual([...STAGE_F_CAPS]);
    expect(String(hellos[0].boot_id)).toMatch(/^probe-/);
  });
});

async function until(cond: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('doctor inside the server (eridani-runtime.ts)', () => {
  it('computes the summary after the probes, sends it as a `doctor` frame to an Eridani that advertised it, and only again on a change', async () => {
    const frames: Array<Record<string, unknown>> = [];
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    cleanups.push(() => new Promise((r) => {
      for (const s of wss.clients) s.terminate();
      wss.close(() => r(undefined));
    }));
    await new Promise((r) => wss.once('listening', r));
    let epoch = 0;
    wss.on('connection', (ws: WebSocket) => ws.on('message', (data) => {
      const raw = JSON.parse(String(data)) as Record<string, unknown>;
      if (raw.t === 'ack' || !parseUpFrame(raw)) return;
      frames.push(raw);
      const send = (b: Record<string, unknown>) => ws.send(JSON.stringify({ v: 1, id: `e-${Math.random()}`, conn_epoch: epoch, at: Date.now(), ...b }));
      if (raw.t === 'hello') send({ t: 'welcome', host_id: 'host-1', conn_epoch: ++epoch, server_time: Date.now(), caps: ['doctor'] });
      else if (typeof raw.op_id === 'string') send({ t: 'ack', acked_id: raw.id, ok: true });
    }));
    const dir = tmp();
    writeEridaniToken(dir, 'eri_bot_test0123456789');
    saveEridaniConfig(dir, { enabled: true, url: `ws://127.0.0.1:${(wss.address() as { port: number }).port}/link`, machine: 'box', collector: 'off' });
    const registry = Registry.load({ file: null, bootId: 'boot-1' });
    const hub = new Hub({ registry, spawn: fakeSpawner().spawn, bootId: 'boot-1', serverId: 'srv', hostname: 'box', timers: new ManualTimers(), probe: () => ({}) });
    fs.mkdirSync(path.join(dir, '.config', 'systemd', 'user'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.config', 'systemd', 'user', 'remotea.service'), '[Service]\nEnvironment=PATH=/usr/bin:/bin\n');
    let active = 'inactive';
    const rt = new EridaniRuntime({
      dir, hub, registry, serverId: 'srv', bootId: 'boot-1', hostname: 'box', version: '9.9.9', log: () => {},
      windowsUsers: null, checkMs: 3_600_000, scanMs: 3_600_000, resumeAgents: false,
      probe: async () => ({ ok: true, version: '1.0.0' }),
      doctor: {
        home: dir, env: { PATH: '/usr/bin:/bin' }, tmpDir: dir,
        systemctl: async (a) => (a[0] === 'is-active' ? active : 'enabled'),
        accepts: async () => false, healthz: async () => false,
        statfs: () => ({ free: 50 * 1024 ** 3, total: 100 * 1024 ** 3 }),
      },
    });
    cleanups.push(() => rt.stop());
    rt.start();
    const doctorFrames = () => frames.filter((f) => f.t === 'doctor');
    // The first summary reaches Eridani in the hello (computed before the socket opened) or, when it
    // was computed during the handshake, as a frame right after the welcome.
    const received = () => [...frames.filter((f) => f.t === 'hello').map((h) => h.doctor), ...doctorFrames()].filter(Boolean) as Array<Record<string, unknown>>;
    await until(() => !!rt.current?.ready && received().length === 1);
    const first = received()[0];
    expect(isDoctorSummary(first)).toBe(true);
    expect(first.items).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'service.active', level: 'fail' })]));
    expect(rt.current!.status().doctor).toMatchObject({ fail: first.fail });
    const framesBefore = doctorFrames().length;
    // Unchanged findings: nothing new on the wire.
    await rt.runDoctor();
    await new Promise((r) => setTimeout(r, 50));
    expect(doctorFrames()).toHaveLength(framesBefore);
    // A change goes out as a frame.
    active = 'active';
    await rt.runDoctor();
    await until(() => doctorFrames().length === framesBefore + 1);
    const changed = doctorFrames()[framesBefore];
    expect(isDoctorSummary(changed)).toBe(true);
    expect((changed.items as Array<{ id: string }>).some((i) => i.id === 'service.active')).toBe(false);
  });
});

describe('doctor: the PTY keeper (S-Q5)', () => {
  const k = (over: Record<string, unknown> = {}) => ({
    enabled: true, running: true, socket: '/s', pid: 42, version: '0.1.0', proto: 1, startedAt: 1,
    owner: { pid: 7, since: 1 }, sessions: 2, alive: 2, ids: ['surf-a', 'surf-b'], aliveIds: ['surf-a', 'surf-b'], ...over,
  });
  it('ok when on and attached; warns when on but missing, unattached, or off while holding sessions', () => {
    expect(byId(evaluate(facts({ keeper: k() })), 'service.pty_keeper')).toMatchObject({ level: 'ok', summary: expect.stringMatching(/survive a server restart/) });
    expect(byId(evaluate(facts({ keeper: k({ running: false, pid: null, owner: null, sessions: 0, alive: 0 }) })), 'service.pty_keeper')).toMatchObject({ level: 'warn' });
    expect(byId(evaluate(facts({ keeper: k({ owner: null }) })), 'service.pty_keeper')).toMatchObject({ level: 'warn', summary: expect.stringMatching(/no server is attached/) });
    expect(byId(evaluate(facts({ keeper: k({ enabled: false }) })), 'service.pty_keeper')).toMatchObject({ level: 'warn', summary: expect.stringMatching(/ptyKeeper is off/) });
    expect(byId(evaluate(facts({ keeper: k({ enabled: false, running: false, sessions: 0, alive: 0 }) })), 'service.pty_keeper')).toMatchObject({ level: 'ok', summary: expect.stringMatching(/ends every session/) });
    expect(byId(evaluate(facts({ keeper: null })), 'service.pty_keeper')).toBeUndefined();
  });
});
