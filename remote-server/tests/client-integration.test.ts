/**
 * The app's RemoteHostClient (src/main/remote-hosts) against a real server:
 * real WebSockets, real Hub and registry, fake PTYs. Exercises what the
 * Windows app relies on end to end — reconnect deltas, resyncs, closes from
 * another device, server restarts, auth — without Electron.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { RemoteaServer } from '../src/server';
import { Hub } from '../src/hub';
import { Registry } from '../src/registry';
import { fakeSpawner, waitFor } from './helpers';
import { RemoteHostClient } from '../../src/main/remote-hosts/host-client';
import { HookBridge, hookToken } from '../src/hook-bridge';
import net from 'net';
import { PendingIntents } from '../../src/main/remote-hosts/host-config';
import type { HostStatus, PtyExitInfo, TerminalSnapshot } from '../../src/shared/remote-hosts-types';

const TOKEN = 'integration-token-0123456789';

interface Rig {
  server: RemoteaServer;
  hub: Hub;
  sp: ReturnType<typeof fakeSpawner>;
  port: number;
  registryFile: string;
}

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

async function startServer(opts: { port?: number; registryFile?: string; bootId?: string; ringBytes?: number; hooks?: ConstructorParameters<typeof Hub>[0]['hooks'] } = {}): Promise<Rig> {
  const registryFile = opts.registryFile ?? path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'remotea-int-')), 'registry.json');
  const bootId = opts.bootId ?? `boot-${Math.random().toString(36).slice(2)}`;
  const registry = Registry.load({ file: registryFile, bootId, saveDebounceMs: 1 });
  const sp = fakeSpawner();
  const hub = new Hub({ registry, spawn: sp.spawn, bootId, serverId: 'srv-int', probe: () => ({}), config: { ringBytes: opts.ringBytes ?? 1 << 20 }, hooks: opts.hooks });
  const server = new RemoteaServer({ hub, token: () => TOKEN });
  const port = await server.listen('127.0.0.1', opts.port ?? 0);
  const rig = { server, hub, sp, port, registryFile };
  cleanup.push(async () => {
    hub.shutdown();
    await server.close();
  });
  return rig;
}

function makeClient(port: number, deviceId: string, token = TOKEN, hooksPromptDeclined?: () => boolean) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remotea-client-'));
  const statuses: HostStatus[] = [];
  const rpcs: Array<{ id: string; method: string; params: Record<string, unknown>; replay: boolean }> = [];
  let pinned: string | undefined;
  const client = new RemoteHostClient({
    hostId: 'desk',
    url: () => `ws://127.0.0.1:${port}`,
    token: () => token,
    device: { id: deviceId, name: deviceId },
    appVersion: 'test',
    pinnedServerId: () => pinned,
    pinServer: (id) => {
      pinned = id;
    },
    intents: new PendingIntents(path.join(dir, 'pending.json')),
    onStatus: (s) => statuses.push(s),
    onRpc: (id, method, params, replay) => rpcs.push({ id, method, params, replay }),
    hooksPromptDeclined,
  });
  cleanup.push(() => client.stop());
  return { client, statuses, rpcs, pin: (id: string | undefined) => (pinned = id) };
}

function collect(client: RemoteHostClient, id: string) {
  const out: string[] = [];
  const exits: Array<{ code: number; info: PtyExitInfo }> = [];
  const resyncs: TerminalSnapshot[] = [];
  client.onData(id, (d) => out.push(d));
  client.onExit(id, (code, info) => exits.push({ code, info }));
  client.onResync(id, (s) => resyncs.push(s));
  return { out, exits, resyncs, text: () => out.join('') };
}

describe('RemoteHostClient against a real server', () => {
  it('round trips unread state and reminders without writing input to a terminal', async () => {
    const rig = await startServer();
    const a = makeClient(rig.port, 'device-attention-a').client;
    const b = makeClient(rig.port, 'device-attention-b').client;
    a.start(); b.start();
    await waitFor(() => a.ready && b.ready);
    const id = 'surf-attention-wire';
    await a.create({ id, cols: 80, rows: 24, spec: {} });
    rig.hub.agentState.hook(id, { event: 'UserPromptSubmit' });
    rig.hub.agentState.hook(id, { event: 'Stop' });
    await waitFor(() => b.sessions.get(id)?.chatAttention?.kind === 'finished');
    expect((await a.chatAttention(id, { action: 'read', revision: 1 })).ok).toBe(true);
    await waitFor(() => b.sessions.get(id)?.chatAttention?.seenBy['device-attention-a'] === 1);
    expect(b.sessions.get(id)?.chatAttention?.seenBy['device-attention-b']).toBeUndefined();
    expect((await a.chatAttention(id, { action: 'remind', dueAt: Date.now() + 60000, note: 'Read the answer' })).ok).toBe(true);
    await waitFor(() => b.sessions.get(id)?.chatReminder?.note === 'Read the answer');
    const reminder = rig.hub['deps'].registry.session(id)!.chatReminder!;
    reminder.dueAt = Date.now() - 1; rig.hub.chatAttention.tick();
    await waitFor(() => b.sessions.get(id)?.chatAttention?.kind === 'reminder');
    expect(b.sessions.get(id)?.chatReminder?.firedAt).toBeGreaterThan(0);
    expect((await a.chatAttention(id, { action: 'cancelReminder' })).ok).toBe(true);
    await waitFor(() => b.sessions.get(id)?.chatReminder === null);
    expect(rig.sp.last().written).toEqual([]);
  });

  it('a second create while the first is in flight is a reuse (no double forwarding)', async () => {
    const rig = await startServer();
    const { client } = makeClient(rig.port, 'device-alpha01');
    client.start();
    await waitFor(() => client.ready);
    const opts = { id: 'surf-int-dup', cols: 80, rows: 24, spec: { cwd: '/tmp' } };
    const [a, b] = await Promise.all([client.create(opts), client.create(opts)]);
    expect([a.reused, b.reused]).toEqual([false, true]);
    expect(rig.sp.ptys.length).toBe(1);
    const third = await client.create(opts);
    expect(third.reused).toBe(true);
  });

  it('creates a session, streams output, and sends input', async () => {
    const rig = await startServer();
    const { client } = makeClient(rig.port, 'device-alpha01');
    client.start();
    await waitFor(() => client.ready);
    const res = await client.create({ id: 'surf-int-1', cols: 80, rows: 24, spec: { cwd: '/tmp' } });
    expect(res).toMatchObject({ reused: false, existed: false });
    const io = collect(client, 'surf-int-1');
    rig.sp.last().emit('hello from the server\r\n');
    await waitFor(() => io.text().includes('hello from the server'));
    client.write('surf-int-1', 'ls\r');
    await waitFor(() => rig.sp.last().written.includes('ls\r'));
  });

  it('asks about agent hooks only while an agent lacks them and the user has not declined', async () => {
    let installed = false;
    const hooks = {
      status: () => [{ agent: 'claude', present: true, installed }, { agent: 'codex', present: false, installed: false }],
      install: () => { installed = true; return hooks.status(); },
    };
    const rig = await startServer({ hooks });
    let declined = false;
    const { client, statuses } = makeClient(rig.port, 'device-alpha11', TOKEN, () => declined);
    client.start();
    await waitFor(() => client.ready);
    expect(client.status().hooks).toMatchObject({ prompt: true, agents: [{ agent: 'claude', installed: false }, { agent: 'codex', present: false }] });
    declined = true;
    expect(client.status().hooks?.prompt).toBe(false);
    declined = false;
    expect(await client.installHooks()).toEqual({ ok: true, error: undefined });
    await waitFor(() => statuses.at(-1)?.hooks?.agents[0].installed === true);
    expect(statuses.at(-1)!.hooks!.prompt).toBe(false);
  });

  it('an older server (no hooks feature) never prompts, and install says why', async () => {
    const rig = await startServer();
    const { client } = makeClient(rig.port, 'device-alpha12');
    client.start();
    await waitFor(() => client.ready);
    expect(client.status().hooks).toBeUndefined();
    expect((await client.installHooks()).ok).toBe(false);
  });

  it('the device that types sets the size; the other learns it, and who has it', async () => {
    const rig = await startServer();
    const desk = makeClient(rig.port, 'device-desk0001').client;
    const lap = makeClient(rig.port, 'device-lap00001').client;
    desk.start();
    lap.start();
    await waitFor(() => desk.ready && lap.ready);
    await desk.create({ id: 'surf-int-13', cols: 200, rows: 60, spec: {} });
    await lap.create({ id: 'surf-int-13', cols: 80, rows: 24, spec: {} });
    const lapSizes: Array<{ cols: number; rows: number; owner: boolean; ownerName?: string }> = [];
    lap.onSize('surf-int-13', (sz) => lapSizes.push(sz));
    expect(desk.sizeOf('surf-int-13')).toMatchObject({ cols: 200, rows: 60, owner: true });
    expect(lap.sizeOf('surf-int-13')).toMatchObject({ cols: 200, rows: 60, owner: false });
    lap.write('surf-int-13', 'x');
    // Two sockets: the desk hearing of the change says nothing about the lap having heard yet.
    await waitFor(() => desk.sizeOf('surf-int-13')?.owner === false && lapSizes.at(-1)?.owner === true);
    expect(desk.sizeOf('surf-int-13')).toEqual({ cols: 80, rows: 24, owner: false, ownerName: 'device-lap00001' });
    expect(lapSizes.at(-1)).toMatchObject({ cols: 80, rows: 24, owner: true });
    desk.claim('surf-int-13');
    await waitFor(() => lap.sizeOf('surf-int-13')?.owner === false);
    expect(lap.sizeOf('surf-int-13')).toEqual({ cols: 200, rows: 60, owner: false, ownerName: 'device-desk0001' });
  });

  it('resnapshot sends the current screen through onResync (a renderer that reloaded)', async () => {
    const rig = await startServer();
    const { client } = makeClient(rig.port, 'device-alpha10');
    client.start();
    await waitFor(() => client.ready);
    await client.create({ id: 'surf-int-10', cols: 80, rows: 24, spec: {} });
    const io = collect(client, 'surf-int-10');
    rig.sp.last().emit('history-line\r\n');
    await waitFor(() => io.text().includes('history-line'));
    client.resnapshot('surf-int-10');
    await waitFor(() => io.resyncs.length === 1);
    expect(io.resyncs[0].data).toContain('history-line');
    // Output after the fence still streams, once.
    rig.sp.last().emit('after\r\n');
    await waitFor(() => io.text().includes('after'));
    expect(io.text().match(/after/g)).toHaveLength(1);
  });

  it('agent status from a hook reaches the app live, and is replayed (marked) after a reconnect', async () => {
    const rig = await startServer();
    const { client, rpcs } = makeClient(rig.port, 'device-alpha09');
    client.start();
    await waitFor(() => client.ready);
    await client.create({ id: 'surf-int-9', cols: 80, rows: 24, spec: {} });
    const secret = 'integration-secret';
    const bridge = new HookBridge({ secret, relay: (id, m, p) => rig.hub.relayRpc(id, m, p) });
    const bport = await bridge.listen(0);
    cleanup.push(() => bridge.close());
    // Exactly what remotea-hook.js sends (see hook-bridge.test.ts for the real script).
    const send = (params: Record<string, unknown>) => new Promise<string>((resolve, reject) => {
      const sock = net.connect(bport, '127.0.0.1', () => sock.write(JSON.stringify({ method: 'hook.event', params: { surfaceId: 'surf-int-9', ...params }, id: 1, token: hookToken(secret, 'surf-int-9') }) + '\n'));
      sock.setEncoding('utf8');
      sock.on('data', (d) => { sock.destroy(); resolve(String(d)); });
      sock.on('error', reject);
    });
    expect(await send({ event: 'UserPromptSubmit', at: 10 })).toContain('"ok":true');
    await send({ event: 'PreToolUse', tool: 'Bash', at: 11 });
    await waitFor(() => rpcs.length === 2);
    expect(rpcs.map((r) => [r.id, r.params.event, r.replay])).toEqual([['surf-int-9', 'UserPromptSubmit', false], ['surf-int-9', 'PreToolUse', false]]);
    // The laptop sleeps through the end of the turn.
    for (const c of rig.hub.conns.values()) c.close(1001, 'test drop');
    await waitFor(() => !client.ready);
    await send({ event: 'Stop', at: 12 });
    await waitFor(() => client.ready, 5000);
    await waitFor(() => rpcs.some((r) => r.params.event === 'Stop'));
    expect(rpcs.slice(2).map((r) => [r.params.event, r.replay])).toEqual([['UserPromptSubmit', true], ['PreToolUse', true], ['Stop', true]]);
  });

  it('reconnects after a dropped connection and replays only what it missed (no resync)', async () => {
    const rig = await startServer();
    const { client } = makeClient(rig.port, 'device-alpha02');
    client.start();
    await waitFor(() => client.ready);
    await client.create({ id: 'surf-int-2', cols: 80, rows: 24, spec: {} });
    const io = collect(client, 'surf-int-2');
    rig.sp.last().emit('before\r\n');
    await waitFor(() => io.text().includes('before'));
    // Drop the socket from the server side (Wi-Fi gone).
    for (const c of rig.hub.conns.values()) c.close(1001, 'test drop');
    await waitFor(() => !client.ready);
    // Input while disconnected is dropped, never replayed later.
    client.write('surf-int-2', 'rm -rf typed-while-offline\r');
    rig.sp.last().emit('while-away\r\n');
    try { await waitFor(() => client.ready, 5000); } catch { throw new Error('never reconnected: ' + JSON.stringify(client.status())); }
    try { await waitFor(() => io.text().includes('while-away')); } catch { throw new Error('no delta: ' + JSON.stringify(io.text()) + ' resyncs=' + io.resyncs.length); }
    expect(io.resyncs).toHaveLength(0);
    expect(io.text()).toBe('before\r\nwhile-away\r\n');
    expect(rig.sp.last().written.join('')).not.toContain('typed-while-offline');
  });

  it('resyncs with a snapshot when the gap is too long for the ring', async () => {
    const rig = await startServer({ ringBytes: 64 });
    const { client } = makeClient(rig.port, 'device-alpha03');
    client.start();
    await waitFor(() => client.ready);
    await client.create({ id: 'surf-int-3', cols: 80, rows: 24, spec: {} });
    const io = collect(client, 'surf-int-3');
    rig.sp.last().emit('first\r\n');
    await waitFor(() => io.text().includes('first'));
    for (const c of rig.hub.conns.values()) c.close(1001, 'test drop');
    await waitFor(() => !client.ready);
    for (let i = 0; i < 20; i++) {
      rig.sp.last().emit(`missed line ${i} ${'z'.repeat(30)}\r\n`);
      rig.hub.sessions.get('surf-int-3')!.flush();
    }
    await waitFor(() => client.ready, 5000);
    await waitFor(() => io.resyncs.length === 1);
    expect(io.resyncs[0].data).toContain('missed line 19');
  });

  it('closing on one device removes the session from the other', async () => {
    const rig = await startServer();
    const a = makeClient(rig.port, 'device-alpha04');
    const b = makeClient(rig.port, 'device-bravo04');
    a.client.start();
    b.client.start();
    await waitFor(() => a.client.ready && b.client.ready);
    await a.client.create({ id: 'surf-int-4', cols: 80, rows: 24, spec: {} });
    const res = await b.client.create({ id: 'surf-int-4', cols: 100, rows: 30, spec: {} });
    expect(res.existed).toBe(true);
    const bio = collect(b.client, 'surf-int-4');
    a.client.kill('surf-int-4');
    await waitFor(() => bio.exits.length === 1);
    expect(bio.exits[0].info).toEqual({ reason: 'closed', by: 'another device' });
    expect(b.client.owns('surf-int-4')).toBe(false);
    expect(rig.sp.last().killed.length).toBeGreaterThan(0);
  });

  it('a close made while offline is delivered on reconnect, before anything is re-placed', async () => {
    const rig = await startServer();
    const a = makeClient(rig.port, 'device-alpha05');
    a.client.start();
    await waitFor(() => a.client.ready);
    await a.client.create({ id: 'surf-int-5', cols: 80, rows: 24, spec: {} });
    for (const c of rig.hub.conns.values()) c.close(1001, 'test drop');
    await waitFor(() => !a.client.ready);
    a.client.kill('surf-int-5');
    await waitFor(() => a.client.ready, 5000);
    await waitFor(() => !rig.hub.sessions.has('surf-int-5'));
    expect(rig.hub['deps'].registry.sessionTombstone('surf-int-5')).toBeDefined();
  });

  it('after a server restart the tab is respawned in place with a notice', async () => {
    const first = await startServer({ bootId: 'boot-A' });
    const { client } = makeClient(first.port, 'device-alpha06');
    client.start();
    await waitFor(() => client.ready);
    await client.create({ id: 'surf-int-6', cols: 80, rows: 24, spec: { cwd: '/srv' } });
    const dueAt = Date.now() + 86400000;
    await client.chatAttention('surf-int-6', { action: 'unread' });
    await client.chatAttention('surf-int-6', { action: 'remind', dueAt, note: 'After restart' });
    const io = collect(client, 'surf-int-6');
    first.sp.last().emit('old output\r\n');
    await waitFor(() => io.text().includes('old output'));
    await new Promise((r) => setTimeout(r, 30)); // registry save
    // Simulate a crash/restart on the same port with the same registry file.
    cleanup.pop();
    first.hub.shutdown();
    await first.server.close();
    const second = await startServer({ port: first.port, registryFile: first.registryFile, bootId: 'boot-B' });
    await waitFor(() => client.ready && second.sp.ptys.length === 1, 8000);
    await waitFor(() => io.text().includes('restarted; session restored'));
    expect(second.sp.last().req.cwd).toBe('/srv');
    await waitFor(() => client.sessions.get('surf-int-6')?.state === 'live');
    expect(client.sessions.get('surf-int-6')).toMatchObject({ chatAttention: { kind: 'unread', revision: 1 }, chatReminder: { dueAt, note: 'After restart' } });
    second.hub['deps'].registry.session('surf-int-6')!.chatReminder!.dueAt = Date.now() - 1;
    second.hub.chatAttention.tick();
    await waitFor(() => client.sessions.get('surf-int-6')?.chatAttention?.kind === 'reminder');
    expect(io.exits).toHaveLength(0);
  });

  it('a wrong token lands in auth-failed without a reconnect storm', async () => {
    const rig = await startServer();
    const { client, statuses } = makeClient(rig.port, 'device-alpha07', 'not-the-token');
    client.start();
    await waitFor(() => statuses.some((s) => s.state === 'auth-failed'));
    await new Promise((r) => setTimeout(r, 600));
    expect(statuses.filter((s) => s.state === 'connecting').length).toBe(1);
  });

  it('refuses a different server at a pinned address', async () => {
    const rig = await startServer();
    const { client, statuses, pin } = makeClient(rig.port, 'device-alpha08');
    pin('some-other-server');
    client.start();
    await waitFor(() => statuses.some((s) => s.state === 'wrong-server'));
    expect(client.ready).toBe(false);
  });
});
