import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  RemoteHostClient,
  type ClientTimers,
  type SocketLike,
} from '../../src/main/remote-hosts/host-client';
import { PendingIntents } from '../../src/main/remote-hosts/host-config';
import {
  parseClientMsg,
  parseServerMsg,
} from '../../src/shared/remote-host-protocol';
import type { TeaState } from '../../src/shared/tea';

class Socket implements SocketLike {
  readyState = 0;
  sent: Record<string, unknown>[] = [];
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
  send(data: string | Uint8Array) {
    if (typeof data === 'string') this.sent.push(JSON.parse(data));
  }
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
  dirs
    .splice(0)
    .forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
});
function state(revision = 1): TeaState {
  return {
    revision,
    config: {
      revision: 0,
      enabled: false,
      connections: [],
      chat: null,
      background: null,
      autoName: true,
      summaries: true,
    },
    messages: [],
    turns: [],
    backgroundPending: 0,
    modelChecks: { chat: false, background: false },
  };
}
function setup(features: string[] = ['tea']) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remotea-tea-transport-'));
  dirs.push(dir);
  const socket = new Socket();
  const timers: ClientTimers = {
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
  };
  const client = new RemoteHostClient({
    hostId: 'desk',
    url: () => 'ws://desk:7717',
    token: () => 'synthetic-token',
    device: { id: 'device-test', name: 'Test' },
    appVersion: 'test',
    pinnedServerId: () => undefined,
    pinServer: () => {},
    intents: new PendingIntents(path.join(dir, 'pending.json')),
    onStatus: () => {},
    socket: () => socket,
    timers,
  });
  clients.push(client);
  client.start();
  socket.readyState = 1;
  socket.emit('open');
  socket.receive({
    t: 'welcome',
    proto: 1,
    serverId: 'server',
    bootId: 'boot',
    epoch: 'epoch',
    hostname: 'desk',
    you: 'device-test',
    groups: [],
    sessions: [],
    features,
  });
  return { socket, client };
}

describe('Tea desktop transport', () => {
  it('updates one streamed message and rejects older updates after finalization', () => {
    const { client, socket } = setup();
    socket.receive({ t: 'teaChanged', state: state(1) });
    const message = {
      id: 'reply-stream',
      role: 'assistant',
      text: 'First ',
      at: 1,
      delivery: 'streaming',
    };
    socket.receive({ t: 'teaStream', revision: 2, message });
    socket.receive({
      t: 'teaStream',
      revision: 3,
      message: { ...message, text: 'First second ' },
    });
    expect(client.teaState?.messages).toHaveLength(1);
    expect(client.teaState?.messages[0].text).toBe('First second ');
    const finished = state(4);
    finished.messages = [
      {
        id: 'reply-stream',
        role: 'assistant',
        text: 'First second done.',
        at: 1,
      },
    ];
    socket.receive({ t: 'teaChanged', state: finished });
    socket.receive({ t: 'teaStream', revision: 3, message });
    expect(client.teaState?.messages[0]).toEqual(finished.messages[0]);
    expect(
      parseServerMsg({ t: 'teaStream', revision: 5, message }),
    ).not.toBeNull();
    expect(
      parseServerMsg({
        t: 'teaStream',
        revision: 5,
        message: { ...message, text: 'x'.repeat(12001) },
      }),
    ).toBeNull();
  });

  it('keeps the newest shared state when an older direct response arrives', async () => {
    const { client, socket } = setup();
    const request = client.tea({ action: 'state' });
    const sent = socket.sent.find((message) => message.t === 'tea')!;
    socket.receive({ t: 'teaChanged', state: state(4) });
    socket.receive({
      t: 'teaResult',
      rid: sent.rid,
      result: { ok: true, state: state(3) },
    });
    expect((await request).ok).toBe(true);
    expect(client.teaState?.revision).toBe(4);
    socket.receive({ t: 'teaChanged', state: state(2) });
    expect(client.teaState?.revision).toBe(4);
  });

  it('surfaces uncertain delivery on disconnect without resending a message', async () => {
    const { client, socket } = setup();
    const request = client.tea({
      action: 'send',
      id: 'message-test',
      text: 'Find login',
    });
    socket.readyState = 3;
    socket.emit('close', 1006);
    expect(await request).toMatchObject({ ok: false, uncertain: true });
    expect(socket.sent.filter((message) => message.t === 'tea')).toHaveLength(
      1,
    );
  });

  it('gates Tea requests on advertised host support', async () => {
    const { client, socket } = setup([]);
    expect(await client.tea({ action: 'state' })).toMatchObject({ ok: false });
    expect(socket.sent.some((message) => message.t === 'tea')).toBe(false);
  });

  it('validates command envelopes and rejects invalid response shapes', () => {
    expect(
      parseClientMsg({
        t: 'tea',
        rid: 1,
        command: { action: 'send', id: 'message-test', text: 'Find login' },
      }),
    ).not.toBeNull();
    expect(
      parseClientMsg({
        t: 'tea',
        rid: 1,
        command: { action: 'send', id: '../unsafe', text: 'Find login' },
      }),
    ).toBeNull();
    expect(
      parseClientMsg({
        t: 'tea',
        rid: 1,
        command: { action: 'send', id: 'message-test', text: 'x'.repeat(8001) },
      }),
    ).toBeNull();
    expect(parseServerMsg({ t: 'teaChanged', state: state() })).not.toBeNull();
    expect(parseServerMsg({ t: 'teaChanged', state: {} })).toBeNull();
    expect(parseServerMsg({ t: 'teaResult', rid: 1, result: {} })).toBeNull();
  });
});
