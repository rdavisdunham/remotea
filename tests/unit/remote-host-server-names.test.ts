/**
 * U19: a host whose session server predates the rename to remotea names (its
 * welcome lacks `remoteaNames`) still connects, and its status says so, so
 * the host's health can tell the user to run `remotea upgrade` there.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { RemoteHostClient, type ClientTimers, type SocketLike } from '../../src/main/remote-hosts/host-client';
import { PendingIntents } from '../../src/main/remote-hosts/host-config';
import type { HostStatus } from '../../src/shared/remote-hosts-types';

class Socket implements SocketLike {
  readyState = 0;
  handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  on(event: string, callback: (...args: never[]) => void) {
    const callbacks = this.handlers.get(event) || [];
    callbacks.push(callback as (...args: unknown[]) => void);
    this.handlers.set(event, callbacks);
    return this;
  }
  emit(event: string, ...args: unknown[]) {
    this.handlers.get(event)?.forEach((callback) => callback(...args));
  }
  send() {}
  close() {
    this.readyState = 3;
  }
  terminate() {
    this.close();
  }
  receive(message: unknown) {
    this.emit('message', JSON.stringify(message), false);
  }
}

const dirs: string[] = [];
const clients: RemoteHostClient[] = [];
afterEach(() => {
  clients.splice(0).forEach((client) => client.stop());
  dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
});

function connect(features: string[] | undefined) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remotea-server-names-'));
  dirs.push(dir);
  const socket = new Socket();
  const timers: ClientTimers = { setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {} };
  const statuses: HostStatus[] = [];
  const client = new RemoteHostClient({
    hostId: 'desk',
    url: () => 'ws://desk:7717',
    token: () => 'synthetic-token',
    device: { id: 'device-test', name: 'Test' },
    appVersion: 'test',
    pinnedServerId: () => undefined,
    pinServer: () => {},
    intents: new PendingIntents(path.join(dir, 'pending.json')),
    onStatus: (s) => statuses.push(s),
    socket: () => socket,
    timers,
  });
  clients.push(client);
  client.start();
  socket.readyState = 1;
  socket.emit('open');
  expect(client.status().serverPredatesRename).toBeUndefined(); // nothing to say before welcome
  socket.receive({
    t: 'welcome', proto: 1, serverId: 'server', bootId: 'boot', epoch: 'epoch', hostname: 'desk',
    you: 'device-test', groups: [], sessions: [], ...(features ? { features } : {}),
  });
  return { client, socket, statuses };
}

describe('host server older than the rename', () => {
  it('a welcome without remoteaNames connects, and the status says the server predates the rename', () => {
    const { client, statuses } = connect(['rpc', 'chatAttention', 'focus']);
    expect(client.ready).toBe(true);
    expect(client.status()).toMatchObject({ state: 'ready', serverPredatesRename: true });
    expect(statuses.at(-1)).toMatchObject({ state: 'ready', serverPredatesRename: true });
  });

  it('a welcome with no features at all (oldest servers) is treated the same way', () => {
    const { client } = connect(undefined);
    expect(client.ready).toBe(true);
    expect(client.status().serverPredatesRename).toBe(true);
  });

  it('a welcome with remoteaNames sets nothing', () => {
    const { client, statuses } = connect(['rpc', 'chatAttention', 'focus', 'remoteaNames']);
    expect(client.ready).toBe(true);
    expect(client.status().serverPredatesRename).toBeUndefined();
    expect(statuses.at(-1)?.serverPredatesRename).toBeUndefined();
  });

  it('the notice clears once the connection drops (the host may be upgrading)', () => {
    const { client, socket } = connect(['rpc']);
    expect(client.status().serverPredatesRename).toBe(true);
    socket.emit('close', 1006, Buffer.from(''));
    expect(client.ready).toBe(false);
    expect(client.status().serverPredatesRename).toBeUndefined();
  });
});
