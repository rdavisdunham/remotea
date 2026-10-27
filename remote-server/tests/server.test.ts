import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { RemoteaServer, FailureTracker, tokenMatches } from '../src/server';
import { Hub } from '../src/hub';
import { Registry } from '../src/registry';
import { fakeSpawner, waitFor } from './helpers';
import { decodeFrame, encodeInput, type ServerMsg } from '../../src/shared/remote-host-protocol';

const TOKEN = 'test-token-0123456789';
let server: RemoteaServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

async function start() {
  const sp = fakeSpawner();
  const hub = new Hub({ registry: Registry.load({ file: null, bootId: 'b' }), spawn: sp.spawn, bootId: 'b', serverId: 'srv', probe: () => ({}) });
  server = new RemoteaServer({ hub, token: () => TOKEN });
  const port = await server.listen('127.0.0.1', 0);
  return { port, sp, hub };
}

function connect(port: number, headers: Record<string, string>): Promise<{ ws?: WebSocket; status?: number }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers });
    ws.once('open', () => resolve({ ws }));
    ws.once('unexpected-response', (_req, res) => resolve({ status: res.statusCode }));
    ws.once('error', () => resolve({}));
  });
}

describe('RemoteaServer auth', () => {
  it('refuses a missing or wrong token with 401', async () => {
    const { port } = await start();
    expect((await connect(port, {})).status).toBe(401);
    expect((await connect(port, { Authorization: 'Bearer nope' })).status).toBe(401);
  });

  it('refuses anything with a browser Origin, even with the right token', async () => {
    const { port } = await start();
    expect((await connect(port, { Authorization: `Bearer ${TOKEN}`, Origin: 'https://evil.example' })).status).toBe(403);
  });

  it('accepts the token, completes hello, and routes binary input to the session', async () => {
    const { port, sp } = await start();
    const { ws } = await connect(port, { Authorization: `Bearer ${TOKEN}` });
    expect(ws).toBeDefined();
    const got: ServerMsg[] = [];
    const out: string[] = [];
    ws!.on('message', (data, isBinary) => {
      if (isBinary) out.push(decodeFrame(new Uint8Array(data as Buffer))!.data);
      else got.push(JSON.parse(String(data)));
    });
    ws!.send(JSON.stringify({ t: 'hello', proto: 1, device: { id: 'device-test01', name: 'test' }, app: { name: 't', version: '0' } }));
    await waitFor(() => got.some((m) => m.t === 'welcome'));
    ws!.send(JSON.stringify({ t: 'open', rid: 1, id: 'surf-ws', cols: 80, rows: 24, create: {} }));
    await waitFor(() => got.some((m) => m.t === 'opened'));
    ws!.send(encodeInput('surf-ws', 'echo hi\r'));
    await waitFor(() => sp.last().written.includes('echo hi\r'));
    sp.last().emit('hi\r\n');
    await waitFor(() => out.join('').includes('hi'));
    ws!.send(JSON.stringify({ t: 'open', rid: 2, id: 'not-a-surface' }));
    await waitFor(() => got.some((m) => m.t === 'error'));
    expect(got.find((m) => m.t === 'error')).toMatchObject({ code: 'bad-request' });
    ws!.close();
  });

  it('serves a health check without auth and nothing else over plain HTTP', async () => {
    const { port } = await start();
    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(health.status).toBe(200);
    const other = await fetch(`http://127.0.0.1:${port}/`);
    expect(other.status).toBe(426);
  });
});

describe('auth helpers', () => {
  it('tokenMatches needs the exact bearer token', () => {
    expect(tokenMatches(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(tokenMatches(`Bearer ${TOKEN}x`, TOKEN)).toBe(false);
    expect(tokenMatches(TOKEN, TOKEN)).toBe(false);
    expect(tokenMatches(undefined, TOKEN)).toBe(false);
  });

  it('bans an IP after 10 failures within a minute, then forgives', () => {
    let now = 0;
    const f = new FailureTracker(() => now);
    for (let i = 0; i < 9; i++) f.fail('1.2.3.4');
    expect(f.banned('1.2.3.4')).toBe(false);
    f.fail('1.2.3.4');
    expect(f.banned('1.2.3.4')).toBe(true);
    expect(f.banned('5.6.7.8')).toBe(false);
    now += 61_000;
    expect(f.banned('1.2.3.4')).toBe(false);
  });
});
