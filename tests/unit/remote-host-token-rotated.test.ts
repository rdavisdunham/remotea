/**
 * `remotea rotate-token` closes the sockets admitted with the old token with
 * 4401. The client goes straight to "Token rejected" (auth-failed) instead of a
 * reconnect round trip that the server would only refuse with a 401.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { RemoteHostClient, TOKEN_ROTATED_CLOSE, type ClientTimers, type SocketLike } from '../../src/main/remote-hosts/host-client';
import { PendingIntents } from '../../src/main/remote-hosts/host-config';
import { PROTO } from '../../src/shared/remote-host-protocol';
import type { HostStatus } from '../../src/shared/remote-hosts-types';

const DEVICE = { id: 'dev-0123456789abcdef', name: 'laptop' };

class FakeSocket implements SocketLike {
  readyState = 0;
  private handlers = new Map<string, Array<(...a: unknown[]) => void>>();
  on(ev: string, cb: (...a: never[]) => void): unknown {
    const list = this.handlers.get(ev) ?? [];
    list.push(cb as (...a: unknown[]) => void);
    this.handlers.set(ev, list);
    return this;
  }
  emit(ev: string, ...args: unknown[]): void {
    for (const cb of this.handlers.get(ev) ?? []) cb(...args);
  }
  send(data: string | Uint8Array): void {
    if (typeof data !== 'string') return;
    const msg = JSON.parse(data) as { t: string; device?: { id: string } };
    if (msg.t === 'hello') {
      this.emit('message', JSON.stringify({
        t: 'welcome', proto: PROTO, serverId: 'srv-1', bootId: 'boot-1', epoch: 'ep-1', hostname: 'desk',
        you: msg.device?.id, groups: [], sessions: [], features: [],
      }), false);
    }
  }
  close(): void { this.readyState = 3; }
  terminate(): void { this.readyState = 3; }
  open(): void { this.readyState = 1; this.emit('open'); }
  closeWith(code: number, reason = ''): void { this.readyState = 3; this.emit('close', code, Buffer.from(reason)); }
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function setup(token: { value: string }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remotea-rotated-'));
  dirs.push(dir);
  const sockets: FakeSocket[] = [];
  const delays: number[] = [];
  const timers: ClientTimers = {
    setTimeout: (_fn, ms) => { delays.push(ms); return delays.length; },
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
  };
  let status: HostStatus | undefined;
  const client = new RemoteHostClient({
    hostId: 'desk', url: () => 'ws://desk:7717', token: () => token.value, device: DEVICE, appVersion: 'test',
    pinnedServerId: () => undefined, pinServer: () => {}, intents: new PendingIntents(path.join(dir, 'p.json')),
    onStatus: (s) => { status = s; },
    socket: () => { const s = new FakeSocket(); sockets.push(s); return s; },
    timers, now: () => 1_000,
  });
  return { client, sockets, delays, status: () => status };
}

describe('token rotated close (4401)', () => {
  it('goes straight to "Token rejected" without a reconnect attempt', () => {
    const t = setup({ value: 'tok' });
    t.client.start();
    t.sockets[0].open();
    expect(t.status()?.state).toBe('ready');
    t.delays.length = 0;

    t.sockets[0].closeWith(TOKEN_ROTATED_CLOSE, 'token rotated');

    expect(t.status()?.state).toBe('auth-failed');
    expect(t.sockets).toHaveLength(1);
    // Only the slow auth retry is scheduled, not a reconnect backoff.
    expect(t.delays.filter((ms) => ms < 60_000)).toEqual([]);
    t.client.stop();
  });

  it('a plain drop still reconnects', () => {
    const t = setup({ value: 'tok' });
    t.client.start();
    t.sockets[0].open();
    t.sockets[0].closeWith(1006);
    expect(t.status()?.state).toBe('reconnecting');
    t.client.stop();
  });

  it('4401 after the token was already replaced here: reconnect with the new one', () => {
    const token = { value: 'old' };
    const t = setup(token);
    t.client.start();
    t.sockets[0].open();
    token.value = 'new';
    t.sockets[0].closeWith(TOKEN_ROTATED_CLOSE, 'token rotated');
    expect(t.status()?.state).toBe('reconnecting');
    t.client.stop();
  });
});
