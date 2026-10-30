/**
 * Rotation is revocation (Eridani roadmap 5fddb759, review S-N5): a socket is
 * admitted with the token in effect at the time, and once the token changes it
 * loses read and write access at once and is closed with 4401 "token rotated".
 * Sessions and their PTYs live in the hub, which only sees a disconnect, so an
 * app that reconnects with the new token reattaches to the same terminal.
 * The hook bridge (7718) has its own secret and is untouched by a rotation.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import WebSocket from 'ws';
import { RemoteaServer, TOKEN_ROTATED_CODE, TOKEN_ROTATED_REASON } from '../src/server';
import { Hub } from '../src/hub';
import { Registry } from '../src/registry';
import { HookBridge, hookToken } from '../src/hook-bridge';
import { ensureToken, rotateToken, watchTokenFile } from '../src/config';
import { fakeSpawner, waitFor } from './helpers';
import { decodeFrame, encodeInput, type ServerMsg } from '../../src/shared/remote-host-protocol';

const OLD = 'old-token-0123456789';
const NEW = 'new-token-9876543210';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

async function start(token: () => string) {
  const sp = fakeSpawner();
  const hub = new Hub({ registry: Registry.load({ file: null, bootId: 'b' }), spawn: sp.spawn, bootId: 'b', serverId: 'srv', probe: () => ({}) });
  const logs: string[] = [];
  const server = new RemoteaServer({ hub, token, log: (m) => logs.push(m) });
  cleanup.push(() => server.close());
  const port = await server.listen('127.0.0.1', 0);
  return { port, sp, hub, server, logs };
}

interface Client {
  ws: WebSocket;
  json: ServerMsg[];
  out: string[];
  closed: Promise<{ code: number; reason: string }>;
  isClosed(): boolean;
}

function connect(port: number, token: string): Promise<{ client?: Client; status?: number }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { Authorization: `Bearer ${token}` } });
    cleanup.push(() => ws.terminate());
    const json: ServerMsg[] = [];
    const out: string[] = [];
    let done = false;
    const closed = new Promise<{ code: number; reason: string }>((r) =>
      ws.once('close', (code, reason) => {
        done = true;
        r({ code, reason: String(reason) });
      }),
    );
    ws.on('message', (data, isBinary) => {
      if (isBinary) out.push(decodeFrame(new Uint8Array(data as Buffer))!.data);
      else json.push(JSON.parse(String(data)) as ServerMsg);
    });
    ws.once('open', () => resolve({ client: { ws, json, out, closed, isClosed: () => done } }));
    ws.once('unexpected-response', (_req, res) => resolve({ status: res.statusCode }));
    ws.once('error', () => resolve({}));
  });
}

async function hello(c: Client, device: string): Promise<void> {
  c.ws.send(JSON.stringify({ t: 'hello', proto: 1, device: { id: device, name: device }, app: { name: 't', version: '0' } }));
  await waitFor(() => c.json.some((m) => m.t === 'welcome'));
}

async function openSurf(c: Client, rid: number, create: boolean): Promise<void> {
  c.ws.send(JSON.stringify({ t: 'open', rid, id: 'surf-rot', cols: 80, rows: 24, ...(create ? { create: {} } : {}) }));
  await waitFor(() => c.json.some((m) => m.t === 'opened' && m.id === 'surf-rot'));
}

describe('token rotation revokes connections', () => {
  it('closes the old socket with 4401 at once, drops what it sent, and keeps the session for the new token', async () => {
    let token = OLD;
    const { port, sp, hub, server, logs } = await start(() => token);
    const { client: old } = await connect(port, OLD);
    await hello(old!, 'device-old');
    await openSurf(old!, 1, true);
    const pty = sp.last();
    old!.ws.send(encodeInput('surf-rot', 'before\r'));
    await waitFor(() => pty.written.includes('before\r'));

    // Rotate. A frame already on the wire from the old socket must not reach the PTY.
    token = NEW;
    old!.ws.send(encodeInput('surf-rot', 'after\r'));
    expect(server.checkToken()).toBe(1);
    const closed = await old!.closed;
    expect(closed).toEqual({ code: TOKEN_ROTATED_CODE, reason: TOKEN_ROTATED_REASON });
    expect(pty.written).not.toContain('after\r');
    expect(logs.some((l) => l.includes('token rotated: closed 1 connection'))).toBe(true);

    // Nothing more reaches the old socket: output produced now goes nowhere near it.
    const outBefore = old!.out.length;
    pty.emit('secret output\r\n');
    await new Promise((r) => setTimeout(r, 30));
    expect(old!.out.length).toBe(outBefore);

    // The session survived: the hub still runs it and the PTY was never signalled.
    expect(hub.isLive('surf-rot')).toBe(true);
    expect(pty.killed).toEqual([]);
    expect(sp.ptys.length).toBe(1);

    // The old token is refused; the new one reattaches to the same terminal.
    expect((await connect(port, OLD)).status).toBe(401);
    const { client: fresh } = await connect(port, NEW);
    await hello(fresh!, 'device-new');
    await openSurf(fresh!, 2, false);
    expect(fresh!.json.find((m) => m.t === 'opened')).toMatchObject({ created: false });
    expect(sp.ptys.length).toBe(1);
    fresh!.ws.send(encodeInput('surf-rot', 'again\r'));
    await waitFor(() => pty.written.includes('again\r'));
    pty.emit('hello new\r\n');
    await waitFor(() => fresh!.out.join('').includes('hello new'));
    // A second check with the same token closes nothing.
    expect(server.checkToken()).toBe(0);
    expect(fresh!.isClosed()).toBe(false);
  });

  it('a handshake with the new token is enough for the server to notice and revoke', async () => {
    let token = OLD;
    const { port } = await start(() => token);
    const { client: a } = await connect(port, OLD);
    const { client: b } = await connect(port, OLD);
    await hello(a!, 'device-a');
    token = NEW;
    const { client: c } = await connect(port, NEW);
    expect((await a!.closed).code).toBe(TOKEN_ROTATED_CODE);
    expect((await b!.closed).code).toBe(TOKEN_ROTATED_CODE);
    await hello(c!, 'device-c');
    expect(c!.isClosed()).toBe(false);
  });

  it('`rotateToken` on the token file revokes promptly through the file watch', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remotea-rot-'));
    cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const first = ensureToken(dir);
    const { port, server, hub, sp } = await start(() => ensureToken(dir));
    server.checkToken();
    // A poll far longer than the test: only the directory watch can make this prompt.
    const watch = watchTokenFile(dir, () => server.checkToken(), 60_000);
    cleanup.push(() => watch.close());
    const { client: old } = await connect(port, first);
    await hello(old!, 'device-old');
    await openSurf(old!, 1, true);

    const t0 = Date.now();
    const second = rotateToken(dir);
    expect(second).not.toBe(first);
    const closed = await old!.closed;
    expect(closed.code).toBe(TOKEN_ROTATED_CODE);
    expect(Date.now() - t0).toBeLessThan(1500);
    // The rotation is a rename: no temp file left behind, and the file is never seen empty.
    expect(fs.readdirSync(dir)).toEqual(['token']);
    expect(hub.isLive('surf-rot')).toBe(true);
    expect(sp.last().killed).toEqual([]);
    expect((await connect(port, first)).status).toBe(401);
    expect((await connect(port, second)).client).toBeDefined();
  });

  it('watchTokenFile falls back to polling and stops on close', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remotea-rot-'));
    cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    let calls = 0;
    const watch = watchTokenFile(dir, () => calls++, 20);
    await waitFor(() => calls >= 2);
    watch.close();
    const after = calls;
    await new Promise((r) => setTimeout(r, 80));
    expect(calls).toBe(after);
  });

  it('the hook bridge has its own secret: session hooks keep reporting across a rotation', async () => {
    let token = OLD;
    const { port, hub, server } = await start(() => token);
    const secret = 'hook-secret-independent';
    const bridge = new HookBridge({ secret, relay: (id, m, p) => hub.relayRpc(id, m, p) });
    cleanup.push(() => bridge.close());
    const bridgePort = await bridge.listen(0);
    const { client: old } = await connect(port, OLD);
    await hello(old!, 'device-old');
    await openSurf(old!, 1, true);

    token = NEW;
    server.checkToken();
    expect((await old!.closed).code).toBe(TOKEN_ROTATED_CODE);

    const { client: fresh } = await connect(port, NEW);
    await hello(fresh!, 'device-new');
    await openSurf(fresh!, 2, false);
    const reply = await new Promise<string>((resolve, reject) => {
      const sock = net.connect(bridgePort, '127.0.0.1', () => {
        sock.write(JSON.stringify({ method: 'hook.event', params: { surfaceId: 'surf-rot', event: 'Stop' }, id: 7, token: hookToken(secret, 'surf-rot') }) + '\n');
      });
      sock.setEncoding('utf8');
      let buf = '';
      sock.on('data', (d: string) => {
        buf += d;
        if (buf.includes('\n')) {
          sock.end();
          resolve(buf.trim());
        }
      });
      sock.on('error', reject);
    });
    expect(JSON.parse(reply)).toEqual({ result: { ok: true }, id: 7 });
    await waitFor(() => fresh!.json.some((m) => m.t === 'rpc' && m.method === 'hook.event'));
  });
});
