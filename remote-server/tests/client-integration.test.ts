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

async function startServer(opts: { port?: number; registryFile?: string; bootId?: string; ringBytes?: number } = {}): Promise<Rig> {
  const registryFile = opts.registryFile ?? path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'remotea-int-')), 'registry.json');
  const bootId = opts.bootId ?? `boot-${Math.random().toString(36).slice(2)}`;
  const registry = Registry.load({ file: registryFile, bootId, saveDebounceMs: 1 });
  const sp = fakeSpawner();
  const hub = new Hub({ registry, spawn: sp.spawn, bootId, serverId: 'srv-int', probe: () => ({}), config: { ringBytes: opts.ringBytes ?? 1 << 20 } });
  const server = new RemoteaServer({ hub, token: () => TOKEN });
  const port = await server.listen('127.0.0.1', opts.port ?? 0);
  const rig = { server, hub, sp, port, registryFile };
  cleanup.push(async () => {
    hub.shutdown();
    await server.close();
  });
  return rig;
}

function makeClient(port: number, deviceId: string, token = TOKEN) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remotea-client-'));
  const statuses: HostStatus[] = [];
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
  });
  cleanup.push(() => client.stop());
  return { client, statuses, pin: (id: string | undefined) => (pinned = id) };
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
