/**
 * Phase 4: agent status from hooks. The bridge's auth and method rules; the
 * real wmux-hook.js (resources/cli) talking to a real bridge, exactly as Claude
 * Code and Codex run it; and the hub's relay — live to attached apps, replayed
 * to apps that attach later.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { HookBridge, handleBridgeRequest, hookEnv, hookToken } from '../src/hook-bridge';
import { applyCodexHooks, installHooks, removeHooks, hooksStatus } from '../src/hooks-install';
import { Hub } from '../src/hub';
import { Registry } from '../src/registry';
import { DiagLog } from '../src/diag-log';
import { FakeConn, fakeSpawner, ManualTimers, waitFor } from './helpers';
import { parseClientMsg } from '../../src/shared/remote-host-protocol';

const SECRET = 'test-secret';
const SURF = 'surf-hook-1';
const HOOK_JS = path.resolve(__dirname, '..', '..', 'resources', 'cli', 'wmux-hook.js');

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

describe('hook bridge requests', () => {
  const relayed: Array<[string, string, Record<string, unknown>]> = [];
  const deps = { secret: SECRET, relay: (id: string, m: string, p: Record<string, unknown>) => (relayed.push([id, m, p]), id === SURF) };

  it('accepts a status report only with the token issued to that session', () => {
    const token = hookToken(SECRET, SURF);
    expect(handleBridgeRequest(deps, { method: 'hook.event', params: { surfaceId: SURF, event: 'Stop' }, id: 1, token })).toEqual({ result: { ok: true }, id: 1 });
    expect(relayed.at(-1)).toEqual([SURF, 'hook.event', { surfaceId: SURF, event: 'Stop' }]);
    // Another session's token, no token, or a forged surface id: refused, nothing relayed.
    const n = relayed.length;
    expect(handleBridgeRequest(deps, { method: 'hook.event', params: { surfaceId: SURF }, token: hookToken(SECRET, 'surf-other') }).error?.code).toBe(-32001);
    expect(handleBridgeRequest(deps, { method: 'hook.event', params: { surfaceId: SURF } }).error?.code).toBe(-32001);
    expect(handleBridgeRequest(deps, { method: 'hook.event', params: { surfaceId: 'surf-x' }, token }).error?.code).toBe(-32001);
    expect(relayed.length).toBe(n);
  });

  it('relays only agent-status methods; answers discovery itself', () => {
    const token = hookToken(SECRET, SURF);
    expect(handleBridgeRequest(deps, { method: 'surface.send_text', params: { surfaceId: SURF, text: 'rm -rf ~' }, token }).error?.code).toBe(-32601);
    expect(handleBridgeRequest(deps, { method: 'workspace.create', params: { surfaceId: SURF }, token }).error?.code).toBe(-32601);
    expect(handleBridgeRequest(deps, { method: 'system.identify', id: 3 }).result).toMatchObject({ name: 'remotea' });
    expect(handleBridgeRequest(deps, 'nonsense').error?.code).toBe(-32700);
  });

  it('a session that is not live here is an error, not a silent success', () => {
    const id = 'surf-gone';
    expect(handleBridgeRequest(deps, { method: 'hook.event', params: { surfaceId: id }, token: hookToken(SECRET, id) }).error?.code).toBe(-32000);
  });
});

/** Run the checked-in hook helper the way an agent does: env from hookEnv, payload on stdin. */
function runHook(args: string[], env: Record<string, string>, payload: object): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK_JS, ...args], { env: { PATH: process.env.PATH ?? '', ...env }, stdio: ['pipe', 'ignore', 'inherit'] });
    child.on('error', reject);
    child.on('exit', (code) => resolve(code ?? -1));
    child.stdin.end(JSON.stringify(payload));
  });
}

describe('wmux-hook.js through the bridge', () => {
  async function bridge() {
    const relayed: Array<{ id: string; method: string; params: Record<string, unknown> }> = [];
    const b = new HookBridge({ secret: SECRET, relay: (id, method, params) => (relayed.push({ id, method, params }), true) });
    const port = await b.listen(0);
    cleanup.push(() => b.close());
    return { relayed, env: hookEnv(SECRET, port, SURF) };
  }

  it('Claude Code: lifecycle events with their session id', async () => {
    const { relayed, env } = await bridge();
    const sid = '0f8fad5b-d9cb-469f-a165-70867728950e';
    expect(await runHook(['--event', 'SessionStart'], env, { session_id: sid, source: 'startup' })).toBe(0);
    expect(await runHook(['--event', 'PreToolUse'], env, { session_id: sid, tool_name: 'Bash' })).toBe(0);
    expect(await runHook(['Edit'], env, { session_id: sid, tool_input: { file_path: '/tmp/x.ts' } })).toBe(0);
    expect(await runHook(['--event', 'Stop'], env, { session_id: sid })).toBe(0);
    expect(relayed.map((r) => [r.method, r.params.event ?? `tool:${r.params.tool}`])).toEqual([
      ['hook.event', 'SessionStart'], ['hook.event', 'PreToolUse'], ['hook.event', 'tool:Edit'], ['hook.event', 'Stop'],
    ]);
    expect(relayed.every((r) => r.id === SURF && r.params.surfaceId === SURF && r.params.sessionId === sid)).toBe(true);
    expect(relayed[1].params.tool).toBe('Bash');
    expect(relayed[2].params.file).toBe('/tmp/x.ts');
    expect(typeof relayed[0].params.at).toBe('number');
  });

  it('Codex: provider is codex, and a PermissionRequest is a permission prompt', async () => {
    const { relayed, env } = await bridge();
    const sid = '019a0b1c-2d3e-7f40-8a5b-6c7d8e9f0a1b';
    expect(await runHook(['--event', 'PermissionRequest', '--provider', 'codex'], env, { session_id: sid, tool_name: 'shell' })).toBe(0);
    expect(relayed[0].params).toMatchObject({ event: 'Notification', notificationType: 'permission_prompt', provider: 'codex', sessionId: sid });
  });

  it('outside a remotea session (no bridge in the environment) the helper leaves at once', async () => {
    const t0 = Date.now();
    expect(await runHook(['--event', 'Stop'], {}, { session_id: 'x' })).toBe(0);
    expect(Date.now() - t0).toBeLessThan(900); // never waits on stdin or a pipe
  });
});

describe('hub relay', () => {
  function setup() {
    const sp = fakeSpawner();
    const hub = new Hub({ registry: Registry.load({ file: null, bootId: 'b1' }), spawn: sp.spawn, bootId: 'b1', serverId: 's', hostname: 'h', timers: new ManualTimers(), probe: () => ({}) });
    let n = 1;
    const connect = (dev: string) => {
      const c = new FakeConn(n++);
      hub.connect(c);
      hub.handle(c, { t: 'hello', proto: 1, device: { id: dev, name: dev }, app: { name: 't', version: '0' } });
      return c;
    };
    return { hub, sp, connect };
  }

  it('relays to attached apps live, and replays the latest of each event to an app that attaches later', async () => {
    const { hub, sp, connect } = setup();
    const a = connect('device-aaaaaaaa');
    expect(a.json('welcome')[0].features).toContain('rpc');
    hub.handle(a, { t: 'open', rid: 1, id: SURF, cols: 80, rows: 24, create: {} });
    const ev = (event: string, at: number) => ({ surfaceId: SURF, event, at, sessionId: '0f8fad5b-d9cb-469f-a165-70867728950e' });
    expect(hub.relayRpc(SURF, 'hook.event', ev('SessionStart', 1))).toBe(true);
    hub.relayRpc(SURF, 'hook.event', ev('UserPromptSubmit', 2));
    hub.relayRpc(SURF, 'hook.event', ev('PreToolUse', 3));
    hub.relayRpc(SURF, 'hook.event', ev('PreToolUse', 4));
    hub.relayRpc(SURF, 'hook.event', ev('Stop', 5));
    expect(a.json('rpc').map((m) => [m.params.event, m.replay ?? false])).toEqual([
      ['SessionStart', false], ['UserPromptSubmit', false], ['PreToolUse', false], ['PreToolUse', false], ['Stop', false],
    ]);
    // The agent's session id reached the registry (status --json, resume after a restart).
    expect(hub.sessions.get(SURF)).toBeTruthy();

    const b = connect('device-bbbbbbbb');
    sp.last().emit('some output');
    hub.handle(b, { t: 'open', rid: 1, id: SURF, cols: 80, rows: 24 });
    await waitFor(() => b.json('rpc').length > 0);
    expect(b.json('rpc').map((m) => [m.params.event, m.params.at, m.replay])).toEqual([
      ['SessionStart', 1, true], ['UserPromptSubmit', 2, true], ['PreToolUse', 4, true], ['Stop', 5, true],
    ]);
    // Only after the open was answered.
    const kinds = b.received.filter((r) => r.kind === 'json').map((r) => (r as { msg: { t: string } }).msg.t);
    expect(kinds.indexOf('opened')).toBeLessThan(kinds.indexOf('rpc'));
  });

  it('a new conversation or an exit clears what is replayed; unknown sessions are refused', async () => {
    const { hub, sp, connect } = setup();
    const a = connect('device-aaaaaaaa');
    hub.handle(a, { t: 'open', rid: 1, id: SURF, cols: 80, rows: 24, create: {} });
    hub.relayRpc(SURF, 'hook.event', { surfaceId: SURF, event: 'Stop', at: 1 });
    hub.relayRpc(SURF, 'hook.event', { surfaceId: SURF, event: 'SessionStart', at: 2 });
    const b = connect('device-bbbbbbbb');
    hub.handle(b, { t: 'open', rid: 1, id: SURF, cols: 80, rows: 24 });
    await waitFor(() => b.json('opened').length > 0);
    expect(b.json('rpc').map((m) => m.params.event)).toEqual(['SessionStart']);
    sp.last().exit(0);
    expect(hub.relayRpc(SURF, 'hook.event', { surfaceId: SURF, event: 'Stop' })).toBe(false);
    expect(hub.relayRpc('surf-nope', 'hook.event', {})).toBe(false);
  });

  it('a hook-reported session id is recorded as the session\'s agent', () => {
    const { hub, connect } = setup();
    const a = connect('device-aaaaaaaa');
    hub.handle(a, { t: 'open', rid: 1, id: SURF, cols: 80, rows: 24, create: {} });
    hub.relayRpc(SURF, 'hook.event', { surfaceId: SURF, event: 'SessionStart', sessionId: '019a0b1c-2d3e-7f40-8a5b-6c7d8e9f0a1b', provider: 'codex' });
    expect(a.json('meta').at(-1)).toMatchObject({ id: SURF, agent: { provider: 'codex', sessionId: '019a0b1c-2d3e-7f40-8a5b-6c7d8e9f0a1b' } });
  });

  it('new sessions get the bridge address and their own token', () => {
    const env = hookEnv(SECRET, 7718, SURF);
    expect(env).toEqual({ WMUX: '1', WMUX_SURFACE_ID: SURF, WMUX_REMOTE: '127.0.0.1:7718', WMUX_REMOTE_TOKEN: hookToken(SECRET, SURF) });
    expect(hookEnv(SECRET, 7718, SURF, { cliPath: '/x/wmux.js', nodePath: '/n/node' })).toMatchObject({ WMUX_CLI: '/x/wmux.js', WMUX_NODE: '/n/node' });
    expect(hookToken(SECRET, SURF)).not.toBe(hookToken(SECRET, 'surf-other'));
    expect(hookToken(SECRET, SURF)).not.toContain(SECRET);
  });
});

describe('hooks install', () => {
  function tempHome() {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'remotea-hooks-'));
    cleanup.push(() => fs.rmSync(home, { recursive: true, force: true }));
    fs.mkdirSync(path.join(home, '.claude'));
    fs.mkdirSync(path.join(home, '.codex'));
    const claude = { model: 'opus', hooks: { SessionStart: [{ hooks: [{ type: 'command', command: "bash '/x/herdr-agent-state.sh' session" }] }], Stop: [{ hooks: [{ type: 'command', command: "'/x/moshi-hook' claude-hook" }] }] } };
    const codex = { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: "bash '/x/herdr-agent-state.sh' session", timeout: 10 }] }] } };
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify(claude));
    fs.writeFileSync(path.join(home, '.codex', 'hooks.json'), JSON.stringify(codex));
    const paths = { home, cliDir: path.join(home, '.local', 'share', 'remotea', 'cli'), sourceDir: path.dirname(HOOK_JS) };
    return { home, paths, claude, codex };
  }
  const read = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8'));

  it('adds remotea entries beside other tools\' hooks, idempotently, and removes only its own', () => {
    const { home, paths, claude, codex } = tempHome();
    const status1 = installHooks(paths);
    installHooks(paths); // twice: still one entry per event
    expect(fs.existsSync(path.join(paths.cliDir, 'wmux-hook.js'))).toBe(true);
    const c = read(path.join(home, '.claude', 'settings.json'));
    expect(c.model).toBe('opus');
    expect(c.hooks.SessionStart.map((e: any) => e.hooks[0].command)).toEqual([
      "bash '/x/herdr-agent-state.sh' session", `node "${path.join(paths.cliDir, 'wmux-hook.js')}" --event SessionStart`,
    ]);
    expect(c.hooks.Stop[0].hooks[0].command).toContain('moshi-hook');
    const x = read(path.join(home, '.codex', 'hooks.json'));
    expect(x.hooks.SessionStart).toHaveLength(2);
    expect(x.hooks.PermissionRequest[0].hooks[0].command).toContain('--event PermissionRequest --provider codex');
    expect(status1.find((s) => s.agent === 'codex')!.entries).toBe(7);
    expect(hooksStatus(paths).map((s) => s.entries)).toEqual(status1.map((s) => s.entries));
    // The original is kept beside it the first time.
    expect(read(path.join(home, '.claude', 'settings.json.remotea-backup'))).toEqual(claude);

    removeHooks(paths);
    expect(read(path.join(home, '.claude', 'settings.json'))).toEqual(claude);
    expect(read(path.join(home, '.codex', 'hooks.json'))).toEqual(codex);
  });

  it('OpenCode: installs wmux\'s plugin and the CLI it runs; leaves someone else\'s plugin of that name alone', () => {
    const { home, paths } = tempHome();
    fs.mkdirSync(path.join(home, '.config', 'opencode'), { recursive: true });
    const rows = installHooks(paths);
    const plugin = path.join(home, '.config', 'opencode', 'plugin', 'wmux.js');
    expect(rows.find((r) => r.agent === 'opencode')).toMatchObject({ present: true, entries: 1 });
    expect(fs.readFileSync(plugin, 'utf8')).toContain('WmuxPlugin');
    expect(fs.existsSync(path.join(paths.cliDir, 'wmux.js'))).toBe(true);
    expect(fs.existsSync(path.join(paths.cliDir, 'wsl-network.js'))).toBe(true);
    removeHooks(paths);
    expect(fs.existsSync(plugin)).toBe(false);
    fs.writeFileSync(plugin, 'export const SomeoneElse = 1;\n');
    installHooks(paths);
    expect(fs.readFileSync(plugin, 'utf8')).toBe('export const SomeoneElse = 1;\n');
    removeHooks(paths);
    expect(fs.existsSync(plugin)).toBe(true);
  });

  it('skips an agent that is not installed', () => {
    const { home, paths } = tempHome();
    fs.rmSync(path.join(home, '.codex'), { recursive: true });
    expect(installHooks(paths).find((s) => s.agent === 'codex')).toMatchObject({ present: false, entries: 0 });
    expect(fs.existsSync(path.join(home, '.codex'))).toBe(false);
  });

  it('applyCodexHooks keeps foreign entries in order', () => {
    const out = applyCodexHooks({ hooks: { Stop: [{ hooks: [{ command: 'a' }] }] } }, '/h/wmux-hook.js');
    expect(out.hooks.Stop.map((e: any) => e.hooks[0].command)).toEqual(['a', 'node "/h/wmux-hook.js" --event Stop --provider codex']);
  });
});

describe('diagnostics', () => {
  it('apps\' diag messages are validated: short scalars only', () => {
    const ok = { t: 'diag', events: [{ at: 1, src: 'main', kind: 'conn.state', surf: 'surf-1', data: { from: 'ready', to: 'backoff', n: 2, ok: true, x: null } }] };
    expect(parseClientMsg(ok)).not.toBeNull();
    expect(parseClientMsg({ t: 'diag', events: [{ at: 1, src: 'main', kind: 'k', data: { blob: 'x'.repeat(301) } }] })).toBeNull();
    expect(parseClientMsg({ t: 'diag', events: [{ at: 1, src: 'main', kind: 'k', data: { nested: { a: 1 } } }] })).toBeNull();
    expect(parseClientMsg({ t: 'diag', events: Array.from({ length: 201 }, () => ({ at: 1, src: 'main', kind: 'k' })) })).toBeNull();
  });

  it('are written per device, rate-capped, and reach the log only after hello', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remotea-diag-'));
    cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    let now = 1_000_000;
    const log = new DiagLog(dir, () => now);
    const hub = new Hub({ registry: Registry.load({ file: null, bootId: 'b' }), spawn: fakeSpawner().spawn, bootId: 'b', serverId: 's', timers: new ManualTimers(), probe: () => ({}), diag: (d, e) => log.write(d, e) });
    const c = new FakeConn(1);
    hub.connect(c);
    hub.handle(c, { t: 'diag', events: [{ at: 1, src: 'main', kind: 'early' }] });
    expect(fs.existsSync(path.join(dir, 'device-aaaaaaaa.jsonl'))).toBe(false);
    hub.handle(c, { t: 'hello', proto: 1, device: { id: 'device-aaaaaaaa', name: 'Laptop' }, app: { name: 't', version: '0' } });
    expect(c.json('welcome')[0].features).toEqual(['rpc', 'diag']);
    hub.handle(c, { t: 'diag', events: [{ at: 2, src: 'renderer', kind: 'detect.verdict', surf: 'surf-1', data: { state: 'idle' } }] });
    const lines = fs.readFileSync(path.join(dir, 'device-aaaaaaaa.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toEqual([{ recv: now, device: 'Laptop', at: 2, src: 'renderer', kind: 'detect.verdict', surf: 'surf-1', data: { state: 'idle' } }]);
    // A flood is capped per minute, and the drop is recorded once the window turns over.
    log.write({ id: 'device-aaaaaaaa', name: 'Laptop' }, Array.from({ length: 4000 }, (_, i) => ({ at: i, src: 'main' as const, kind: 'spam' })));
    now += 61_000;
    log.write({ id: 'device-aaaaaaaa', name: 'Laptop' }, [{ at: 9, src: 'main', kind: 'after' }]);
    const all = fs.readFileSync(path.join(dir, 'device-aaaaaaaa.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(all.filter((e) => e.kind === 'spam').length).toBe(2999);
    expect(all.find((e) => e.kind === 'diag.dropped')?.data.count).toBe(1001);
  });
});

describe('hook status for the app\'s prompt', () => {
  it('welcome reports each agent\'s hooks; an install from one device updates every device', () => {
    let installed = false;
    const hooks = {
      status: () => [{ agent: 'claude', present: true, installed }, { agent: 'codex', present: false, installed: false }],
      install: () => { installed = true; return hooks.status(); },
    };
    const hub = new Hub({ registry: Registry.load({ file: null, bootId: 'b' }), spawn: fakeSpawner().spawn, bootId: 'b', serverId: 's', timers: new ManualTimers(), probe: () => ({}), hooks });
    const connect = (id: number, dev: string) => {
      const c = new FakeConn(id);
      hub.connect(c);
      hub.handle(c, { t: 'hello', proto: 1, device: { id: dev, name: dev }, app: { name: 't', version: '0' } });
      return c;
    };
    const a = connect(1, 'device-aaaaaaaa');
    const b = connect(2, 'device-bbbbbbbb');
    expect(a.json('welcome')[0]).toMatchObject({ features: ['rpc', 'hooks'], hooks: [{ agent: 'claude', present: true, installed: false }, { agent: 'codex', present: false }] });
    expect(parseClientMsg({ t: 'hooksInstall', rid: 4 })).not.toBeNull();
    hub.handle(a, { t: 'hooksInstall', rid: 4 });
    expect(a.json('ack').at(-1)).toEqual({ t: 'ack', rid: 4, ok: true });
    expect(b.json('hooksStatus').at(-1)!.hooks[0]).toEqual({ agent: 'claude', present: true, installed: true });
  });

  it('a failed install is reported to the asking device; a server without the feature says so', () => {
    const failing = { status: () => [], install: () => { throw new Error('settings.json is not valid JSON'); } };
    const mk = (hooks?: typeof failing) => {
      const hub = new Hub({ registry: Registry.load({ file: null, bootId: 'b' }), spawn: fakeSpawner().spawn, bootId: 'b', serverId: 's', timers: new ManualTimers(), probe: () => ({}), hooks });
      const c = new FakeConn(1);
      hub.connect(c);
      hub.handle(c, { t: 'hello', proto: 1, device: { id: 'device-aaaaaaaa', name: 'a' }, app: { name: 't', version: '0' } });
      hub.handle(c, { t: 'hooksInstall', rid: 9 });
      return c;
    };
    expect(mk(failing).json('ack')[0]).toMatchObject({ ok: false, error: 'settings.json is not valid JSON' });
    const old = mk();
    expect(old.json('welcome')[0].hooks).toBeUndefined();
    expect(old.json('ack')[0]).toMatchObject({ ok: false });
  });
});
