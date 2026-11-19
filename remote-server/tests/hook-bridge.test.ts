/**
 * Phase 4: agent status from hooks. The bridge's auth and method rules; the
 * real remotea-hook.js (resources/cli) talking to a real bridge, exactly as Claude
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
import { LEGACY_OPENCODE_PLUGIN_EXPORT } from '../../src/shared/legacy-names';

const SECRET = 'test-secret';
const SURF = 'surf-hook-1';
const HOOK_JS = path.resolve(__dirname, '..', '..', 'resources', 'cli', 'remotea-hook.js');
const AGY_HOOK = path.resolve(__dirname, '..', '..', 'resources', 'agy-plugin', 'remotea-agy-hook.cjs');

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

describe('hook bridge requests', () => {
  const relayed: Array<[string, string, Record<string, unknown>]> = [];
  const deps = { secret: SECRET, relay: (id: string, m: string, p: Record<string, unknown>) => (relayed.push([id, m, p]), id === SURF) };

  it('accepts a status report only with the token issued to that session', async () => {
    const token = hookToken(SECRET, SURF);
    expect(await handleBridgeRequest(deps, { method: 'hook.event', params: { surfaceId: SURF, event: 'Stop' }, id: 1, token })).toEqual({ result: { ok: true }, id: 1 });
    expect(relayed.at(-1)).toEqual([SURF, 'hook.event', { surfaceId: SURF, event: 'Stop' }]);
    // Another session's token, no token, or a forged surface id: refused, nothing relayed.
    const n = relayed.length;
    expect((await handleBridgeRequest(deps, { method: 'hook.event', params: { surfaceId: SURF }, token: hookToken(SECRET, 'surf-other') })).error?.code).toBe(-32001);
    expect((await handleBridgeRequest(deps, { method: 'hook.event', params: { surfaceId: SURF } })).error?.code).toBe(-32001);
    expect((await handleBridgeRequest(deps, { method: 'hook.event', params: { surfaceId: 'surf-x' }, token })).error?.code).toBe(-32001);
    expect(relayed.length).toBe(n);
  });

  it('relays only agent-status methods; answers discovery itself', async () => {
    const token = hookToken(SECRET, SURF);
    expect((await handleBridgeRequest(deps, { method: 'surface.send_text', params: { surfaceId: SURF, text: 'rm -rf ~' }, token })).error?.code).toBe(-32601);
    expect((await handleBridgeRequest(deps, { method: 'workspace.create', params: { surfaceId: SURF }, token })).error?.code).toBe(-32601);
    expect((await handleBridgeRequest(deps, { method: 'system.identify', id: 3 })).result).toMatchObject({ name: 'remotea' });
    expect((await handleBridgeRequest(deps, { method: 'system.capabilities' })).result).toEqual({ protocols: ['v2'], features: ['status'] });
    // Discovery must not imply desktop controls or status-query support.
    for (const method of ['browser.open', 'markdown.create', 'window.create', 'pane.agent_state']) {
      expect((await handleBridgeRequest(deps, { method, params: { surfaceId: SURF }, token })).error?.code).toBe(-32601);
    }
    expect((await handleBridgeRequest(deps, { method: 'pane.report_agent', params: { surfaceId: SURF, state: 'blocked' }, token })).result).toEqual({ ok: true });
    expect((await handleBridgeRequest(deps, { method: 'agent.subagent', params: { surfaceId: SURF, id: 'child', done: false }, token })).result).toEqual({ ok: true });
    expect((await handleBridgeRequest(deps, 'nonsense')).error?.code).toBe(-32700);
  });

  it('a session that is not live here is an error, not a silent success', async () => {
    const id = 'surf-gone';
    expect((await handleBridgeRequest(deps, { method: 'hook.event', params: { surfaceId: id }, token: hookToken(SECRET, id) })).error?.code).toBe(-32000);
  });
});

/** Run the checked-in hook helper the way an agent does: env from hookEnv, payload on stdin. */
function runHook(args: string[], env: Record<string, string>, payload: object, script = HOOK_JS): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { env: { PATH: process.env.PATH ?? '', ...env }, stdio: ['pipe', 'ignore', 'inherit'] });
    child.on('error', reject);
    child.on('exit', (code) => resolve(code ?? -1));
    child.stdin.end(JSON.stringify(payload));
  });
}

describe('remotea-hook.js through the bridge', () => {
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

  it('Qwen Code: the same helper, provider qwen', async () => {
    const { relayed, env } = await bridge();
    expect(await runHook(['--event', 'Stop', '--provider', 'qwen'], env, { session_id: 'q-1' })).toBe(0);
    expect(relayed[0]).toMatchObject({ method: 'hook.event', params: { event: 'Stop' } });
  });

  it('Antigravity: remotea\'s agy hook reports the conversation over the bridge', async () => {
    const { relayed, env } = await bridge();
    const conv = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
    expect(await runHook(['SessionStart'], env, { conversationId: conv }, AGY_HOOK)).toBe(0);
    expect(relayed).toEqual([{ id: SURF, method: 'pane.report_agent_session', params: { surfaceId: SURF, sessionId: conv, provider: 'agy' } }]);
  });

  it('Stop forwards the final response (≤16k, flagged when cut) and Codex\'s turn id and rollout', async () => {
    const { relayed, env } = await bridge();
    const sid = '0f8fad5b-d9cb-469f-a165-70867728950e';
    expect(await runHook(['--event', 'Stop'], env, { session_id: sid, last_assistant_message: 'All done.' })).toBe(0);
    expect(await runHook(['--event', 'Stop'], env, { session_id: sid, last_assistant_message: 'é'.repeat(16_005) })).toBe(0);
    expect(await runHook(['--event', 'PreToolUse'], env, { session_id: sid, last_assistant_message: 'not on other events' })).toBe(0);
    const rollout = '/home/u/.codex/sessions/rollout-1.jsonl';
    expect(await runHook(['--event', 'Stop', '--provider', 'codex'], env, { session_id: 'thr', turn_id: 'turn-7', transcript_path: rollout, last_assistant_message: 'codex answer' })).toBe(0);
    expect(relayed[0].params).toMatchObject({ event: 'Stop', lastAssistantMessage: 'All done.' });
    expect(relayed[0].params.lastAssistantTruncated).toBeUndefined();
    expect(relayed[1].params.lastAssistantMessage).toHaveLength(16_000);
    expect(relayed[1].params.lastAssistantTruncated).toBe('1');
    expect(relayed[2].params.lastAssistantMessage).toBeUndefined();
    expect(relayed[3].params).toMatchObject({ provider: 'codex', turnId: 'turn-7', transcriptPath: rollout, lastAssistantMessage: 'codex answer' });
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
    expect(a.json('meta').filter((m) => m.agent).at(-1)).toMatchObject({ id: SURF, agent: { provider: 'codex', sessionId: '019a0b1c-2d3e-7f40-8a5b-6c7d8e9f0a1b' } });
  });

  it('derives agent state, captures turns, and keeps the turn text away from apps', () => {
    const sink = { status: [] as any[], turn: [] as any[], exit: [] as any[], captured: [] as string[] };
    const { hub, sp, connect } = setup();
    hub.setSink({
      status: (s) => sink.status.push(s),
      turn: (t) => sink.turn.push(t),
      exit: (e) => sink.exit.push(e),
      turnCaptured: (_p, id) => sink.captured.push(id),
    });
    const a = connect('device-aaaaaaaa');
    hub.handle(a, { t: 'open', rid: 1, id: SURF, cols: 80, rows: 24, create: {} });
    const sid = '0f8fad5b-d9cb-469f-a165-70867728950e';
    hub.relayRpc(SURF, 'hook.event', { surfaceId: SURF, event: 'UserPromptSubmit', sessionId: sid, prompt: 'go', at: 1 });
    expect(a.json('meta').filter((m) => m.agentState).at(-1)).toMatchObject({ id: SURF, agentState: { state: 'working' } });
    hub.relayRpc(SURF, 'hook.event', { surfaceId: SURF, event: 'Stop', sessionId: sid, lastAssistantMessage: 'secret-free answer', at: 2 });
    expect(sink.status.map((s) => s.state)).toEqual(['working', 'idle']);
    expect(sink.status[1].revision).toBeGreaterThan(sink.status[0].revision);
    expect(sink.turn).toHaveLength(1);
    expect(sink.turn[0]).toMatchObject({ surf: SURF, incarnation: 1, text: 'secret-free answer', prompt: 'go', seq: 1 });
    expect(sink.captured).toEqual([sid]);
    // Apps get the event, never the text.
    const stop = a.json('rpc').find((m) => m.params.event === 'Stop')!;
    expect(stop.params.lastAssistantMessage).toBeUndefined();
    expect(hub.snapshot()[0]).toMatchObject({ surf: SURF, incarnation: 1, state: 'live', agent_state: 'idle', turn_seq: 1, provider: 'claude', provider_session_id: sid });
    sp.last().exit(2);
    expect(sink.exit).toEqual([{ surf: SURF, incarnation: 1, code: 2, exited_at: expect.any(Number) }]);
    expect(sink.status.at(-1)).toMatchObject({ state: 'exited' });
  });

  it('a respawned session is a new incarnation that keeps its turn numbering', () => {
    const registry = Registry.load({ file: null, bootId: 'b1' });
    registry.addSession({ id: SURF, cwd: '/', createdBy: 'd', createdAt: 1, bootId: 'b0', state: 'lost', hiddenBy: [], incarnation: 3, turnSeq: 9, agentState: { state: 'working', since: 1 } } as never);
    const hub = new Hub({ registry, spawn: fakeSpawner().spawn, bootId: 'b1', serverId: 's', hostname: 'h', timers: new ManualTimers(), probe: () => ({}) });
    const c = new FakeConn(1);
    hub.connect(c);
    hub.handle(c, { t: 'hello', proto: 1, device: { id: 'device-aaaaaaaa', name: 'a' }, app: { name: 't', version: '0' } });
    hub.handle(c, { t: 'open', rid: 1, id: SURF, cols: 80, rows: 24, create: {} });
    const rec = registry.session(SURF)!;
    expect(rec).toMatchObject({ incarnation: 4, turnSeq: 9, state: 'live' });
    expect(rec.agentState).toBeUndefined();
  });

  it('new sessions get the bridge address and their own token', () => {
    const env = hookEnv(SECRET, 7718, SURF);
    expect(env).toEqual({ REMOTEA: '1', REMOTEA_SURFACE_ID: SURF, REMOTEA_REMOTE: '127.0.0.1:7718', REMOTEA_REMOTE_TOKEN: hookToken(SECRET, SURF) });
    expect(hookEnv(SECRET, 7718, SURF, { cliPath: '/x/remotea.js', nodePath: '/n/node' })).toMatchObject({ REMOTEA_CLI: '/x/remotea.js', REMOTEA_NODE: '/n/node' });
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

  it('replaces its own old-named entries and leaves a wmux install\'s byte-identical (AE5)', () => {
    const { home, paths } = tempHome();
    const settingsFile = path.join(home, '.claude', 'settings.json');
    const wmuxCheckout = path.join(home, 'src', 'wmux');
    fs.mkdirSync(path.join(wmuxCheckout, 'resources', 'cli'), { recursive: true });
    fs.writeFileSync(path.join(wmuxCheckout, 'package.json'), JSON.stringify({ name: 'wmux' }));
    const ourOld = { hooks: [{ type: 'command', command: `node "${paths.cliDir}/wmux-hook.js" --event Stop` }] };
    const theirs = { hooks: [{ type: 'command', command: `node "${wmuxCheckout}/resources/cli/wmux-hook.js" --event Stop` }] };
    fs.writeFileSync(settingsFile, JSON.stringify({ hooks: { Stop: [ourOld, theirs] } }));

    installHooks(paths);
    let stop = read(settingsFile).hooks.Stop;
    expect(stop.map((e: any) => e.hooks[0].command)).toEqual([
      theirs.hooks[0].command, `node "${path.join(paths.cliDir, 'remotea-hook.js')}" --event Stop`,
    ]);
    expect(JSON.stringify(stop[0])).toBe(JSON.stringify(theirs));

    removeHooks(paths);
    stop = read(settingsFile).hooks.Stop;
    expect(stop).toEqual([theirs]);
  });

  it('adds remotea entries beside other tools\' hooks, idempotently, and removes only its own', () => {
    const { home, paths, claude, codex } = tempHome();
    const status1 = installHooks(paths);
    installHooks(paths); // twice: still one entry per event
    expect(fs.existsSync(path.join(paths.cliDir, 'remotea-hook.js'))).toBe(true);
    const c = read(path.join(home, '.claude', 'settings.json'));
    expect(c.model).toBe('opus');
    expect(c.hooks.SessionStart.map((e: any) => e.hooks[0].command)).toEqual([
      "bash '/x/herdr-agent-state.sh' session", `node "${path.join(paths.cliDir, 'remotea-hook.js')}" --event SessionStart`,
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

  it('keeps the settings file\'s mode whatever the umask, and the backup is 0600 (L12)', () => {
    const { home, paths } = tempHome();
    const settings = path.join(home, '.claude', 'settings.json');
    fs.chmodSync(settings, 0o600);
    fs.chmodSync(path.join(home, '.codex', 'hooks.json'), 0o640);
    const old = process.umask(0o022);
    try {
      installHooks(paths);
      removeHooks(paths);
    } finally {
      process.umask(old);
    }
    expect(fs.statSync(settings).mode & 0o777).toBe(0o600);
    expect(fs.statSync(`${settings}.remotea-backup`).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(home, '.codex', 'hooks.json')).mode & 0o777).toBe(0o640);
    expect(fs.statSync(path.join(home, '.codex', 'hooks.json.remotea-backup')).mode & 0o777).toBe(0o600);
  });

  it('OpenCode: installs remotea\'s plugin and the CLI it runs; leaves someone else\'s plugin of that name alone', () => {
    const { home, paths } = tempHome();
    fs.mkdirSync(path.join(home, '.config', 'opencode'), { recursive: true });
    const rows = installHooks(paths);
    const plugin = path.join(home, '.config', 'opencode', 'plugin', 'remotea.js');
    expect(rows.find((r) => r.agent === 'opencode')).toMatchObject({ present: true, entries: 1 });
    expect(fs.readFileSync(plugin, 'utf8')).toContain('RemoteaPlugin');
    expect(fs.existsSync(path.join(paths.cliDir, 'remotea.js'))).toBe(true);
    expect(fs.existsSync(path.join(paths.cliDir, 'wsl-network.js'))).toBe(true);
    removeHooks(paths);
    expect(fs.existsSync(plugin)).toBe(false);
    fs.writeFileSync(plugin, 'export const SomeoneElse = 1;\n');
    installHooks(paths);
    expect(fs.readFileSync(plugin, 'utf8')).toBe('export const SomeoneElse = 1;\n');
    removeHooks(paths);
    expect(fs.existsSync(plugin)).toBe(true);
  });

  it('OpenCode: replaces and removes a plugin installed before its export was renamed', () => {
    const { home, paths } = tempHome();
    const plugin = path.join(home, '.config', 'opencode', 'plugin', 'remotea.js');
    fs.mkdirSync(path.dirname(plugin), { recursive: true });
    // The old export alone, and the old export under the last pre-rename version marker.
    for (const old of [
      `export const ${LEGACY_OPENCODE_PLUGIN_EXPORT} = async () => ({});\n`,
      `// remotea-plugin-version: 10\nexport const ${LEGACY_OPENCODE_PLUGIN_EXPORT} = async () => ({});\n`,
    ]) {
      fs.writeFileSync(plugin, old);
      installHooks(paths);
      expect(fs.readFileSync(plugin, 'utf8')).toContain('RemoteaPlugin');
      expect(fs.readFileSync(plugin, 'utf8')).not.toContain(LEGACY_OPENCODE_PLUGIN_EXPORT);
      fs.writeFileSync(plugin, old);
      removeHooks(paths);
      expect(fs.existsSync(plugin)).toBe(false);
    }
  });

  it('pi, omp, Grok, Qwen and agy: each gets remotea\'s own file or entries, and loses only those', () => {
    const { home, paths } = tempHome();
    const h = (...p: string[]) => path.join(home, ...p);
    for (const d of [['.pi', 'agent'], ['.omp', 'agent'], ['.grok'], ['.qwen'], ['.gemini', 'antigravity-cli']]) fs.mkdirSync(h(...d), { recursive: true });
    const qwen = { model: { name: 'qwen3-coder' }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'mine' }] }] } };
    fs.writeFileSync(h('.qwen', 'settings.json'), JSON.stringify(qwen));
    const rows = installHooks(paths);
    for (const agent of ['pi', 'omp', 'grok', 'qwen', 'agy']) expect(rows.find((r) => r.agent === agent)).toMatchObject({ present: true });
    expect(rows.filter((r) => r.entries > 0).map((r) => r.agent).sort()).toEqual(['agy', 'claude', 'codex', 'grok', 'omp', 'pi', 'qwen']);
    const script = path.join(paths.cliDir, 'remotea-hook.js');
    expect(fs.readFileSync(h('.pi', 'agent', 'extensions', 'remotea.js'), 'utf8')).toMatch(/remotea-plugin-version/);
    expect(fs.readFileSync(h('.omp', 'agent', 'extensions', 'remotea.js'), 'utf8')).toMatch(/remotea-plugin-version/);
    const grok = read(h('.grok', 'hooks', 'remotea.json'));
    expect(grok.hooks.StopFailure[0].hooks[0].command).toBe(`node "${script}" --event StopFailure`);
    const q = read(h('.qwen', 'settings.json'));
    expect(q.model).toEqual(qwen.model);
    expect(q.hooks.Stop.map((e: any) => e.hooks[0].command)).toEqual(['mine', `node ${script} --event Stop --provider qwen`]);
    const agyDir = h('.gemini', 'config', 'plugins', 'remotea');
    expect(fs.readdirSync(agyDir).sort()).toEqual(['hooks.json', 'plugin.json', 'remotea-agy-hook.cjs']);

    removeHooks(paths);
    expect(read(h('.qwen', 'settings.json'))).toEqual(qwen);
    for (const f of [h('.pi', 'agent', 'extensions', 'remotea.js'), h('.omp', 'agent', 'extensions', 'remotea.js'), h('.grok', 'hooks', 'remotea.json'), path.join(agyDir, 'remotea-agy-hook.cjs')]) {
      expect(fs.existsSync(f)).toBe(false);
    }
  });

  it('leaves a Qwen settings file with comments, and a Grok hooks file of the user\'s, untouched', () => {
    const { home, paths } = tempHome();
    fs.mkdirSync(path.join(home, '.grok', 'hooks'), { recursive: true });
    fs.mkdirSync(path.join(home, '.qwen'));
    const commented = '{\n  // my settings\n  "model": {}\n}\n';
    const userGrok = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } });
    fs.writeFileSync(path.join(home, '.qwen', 'settings.json'), commented);
    fs.writeFileSync(path.join(home, '.grok', 'hooks', 'remotea.json'), userGrok);
    const rows = installHooks(paths);
    expect(rows.find((r) => r.agent === 'qwen')).toMatchObject({ present: true, entries: 0 });
    expect(rows.find((r) => r.agent === 'grok')).toMatchObject({ present: true, entries: 0 });
    removeHooks(paths);
    expect(fs.readFileSync(path.join(home, '.qwen', 'settings.json'), 'utf8')).toBe(commented);
    expect(fs.readFileSync(path.join(home, '.grok', 'hooks', 'remotea.json'), 'utf8')).toBe(userGrok);
  });

  it('skips an agent that is not installed', () => {
    const { home, paths } = tempHome();
    fs.rmSync(path.join(home, '.codex'), { recursive: true });
    expect(installHooks(paths).find((s) => s.agent === 'codex')).toMatchObject({ present: false, entries: 0 });
    expect(fs.existsSync(path.join(home, '.codex'))).toBe(false);
  });

  it('applyCodexHooks keeps foreign entries in order', () => {
    const out = applyCodexHooks({ hooks: { Stop: [{ hooks: [{ command: 'a' }] }] } }, '/h/remotea-hook.js');
    expect(out.hooks.Stop.map((e: any) => e.hooks[0].command)).toEqual(['a', 'node "/h/remotea-hook.js" --event Stop --provider codex']);
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
    expect(c.json('welcome')[0].features).toEqual(['rpc', 'chatAttention', 'diag', 'focus', 'remoteaNames']);
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
    expect(a.json('welcome')[0]).toMatchObject({ features: ['rpc', 'chatAttention', 'hooks', 'focus', 'remoteaNames'], hooks: [{ agent: 'claude', present: true, installed: false }, { agent: 'codex', present: false }] });
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
