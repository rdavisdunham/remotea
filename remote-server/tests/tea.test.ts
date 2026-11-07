import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Tea } from '../src/tea';
import { TeaStore } from '../src/tea-store';
import { TeaTools } from '../src/tea-tools';
import { Hub } from '../src/hub';
import { Registry } from '../src/registry';
import { Collector } from '../src/collector/collector';
import type { TeaCompletion, TeaProviderRequest } from '../src/tea-provider';
import type { TeaConfigurationInput } from '../../src/shared/tea';
import { FakeConn, fakeSpawner } from './helpers';

const device = 'device-one';
const configuration = (): TeaConfigurationInput => ({
  enabled: true,
  autoName: true,
  summaries: true,
  connections: [
    {
      id: 'connection-one',
      name: 'Provider',
      protocol: 'anthropic',
      baseUrl: 'https://provider.test',
      apiKey: 'synthetic-secret-for-tea-tests',
    },
  ],
  chat: {
    connectionId: 'connection-one',
    model: 'claude-sonnet-5-5',
    effort: 'medium',
  },
  background: {
    connectionId: 'connection-one',
    model: 'claude-haiku-5-5',
    effort: 'low',
  },
});
const completion = (
  text: string,
  calls: TeaCompletion['calls'] = [],
): TeaCompletion => ({
  text,
  calls,
  output: [{ role: 'assistant', content: text || 'tool request' }],
});
const dirs: string[] = [];
const assistants: Tea[] = [];
beforeEach(() =>
  vi
    .spyOn(Collector.prototype, 'scan')
    .mockResolvedValue({ seen: 0, queued: 0, failed: 0, rows: [] }),
);
afterEach(() => {
  assistants.splice(0).forEach((tea) => tea.stop());
  dirs
    .splice(0)
    .forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
  vi.restoreAllMocks();
});

function setup(
  onChat: (request: TeaProviderRequest) => Promise<TeaCompletion> = async () =>
    completion('Ready'),
  onSummary: () => Promise<TeaCompletion> = async () =>
    completion(
      '{"title":"Fix login","summary":"Investigating login settings."}',
    ),
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remotea-tea-test-'));
  dirs.push(dir);
  const registry = Registry.load({
    file: path.join(dir, 'registry.json'),
    bootId: 'test-boot',
  });
  registry.addSession({
    id: 'surf-test',
    groupId: 'grp-test',
    title: undefined,
    cwd: '/repo',
    createdBy: device,
    createdAt: 1,
    bootId: 'test-boot',
    state: 'live',
    hiddenBy: [],
    agent: { provider: 'claude', sessionId: 'conversation', seenAt: 1 },
  });
  registry.upsertGroup('grp-test', { name: 'Project' }, device);
  registry.saveNow();
  const hub = new Hub({
    registry,
    spawn: fakeSpawner().spawn,
    bootId: 'test-boot',
    serverId: 'test-server',
  });
  const factory = () => ({
    models: async () => [{ id: 'test-model', name: 'Test' }],
    user: (text: string) => ({ role: 'user', content: text }),
    results: (_calls: unknown[], results: unknown[]) => [
      { role: 'tool', content: JSON.stringify(results) },
    ],
    complete: async (request: TeaProviderRequest): Promise<TeaCompletion> => {
      if (request.tools?.[0]?.name === 'tea_test')
        return request.history.length === 1
          ? completion('', [
              { id: 'probe-call', name: 'tea_test', input: { value: 'tea' } },
            ])
          : completion('OK');
      if (request.schema)
        return JSON.stringify(request.history).includes(
          'untrusted_terminal_context',
        )
          ? onSummary()
          : completion('{"title":"Fixture","summary":"A capability check."}');
      return onChat(request);
    },
  });
  const create = () => {
    const tea = new Tea({ dir, hub, registry, provider: factory });
    assistants.push(tea);
    hub.setTea(tea);
    return tea;
  };
  return { dir, registry, hub, create, tea: create() };
}
async function ready(tea: Tea) {
  expect(
    (
      await tea.request(
        { action: 'configure', expectedRevision: 0, config: configuration() },
        device,
      )
    ).ok,
  ).toBe(true);
  expect((await tea.request({ action: 'testModels' }, device)).ok).toBe(true);
}

describe('Tea host state', () => {
  it('requests a terminal highlight only on the device asking Tea', async () => {
    let calls = 0;
    const { tea, hub } = setup(async () => {
      calls++;
      return calls === 1
        ? completion('', [{ id: 'open-fixture', name: 'open_terminal', input: { terminal_id: 'surf-test' } }])
        : completion('Here is your fixture terminal.');
    });
    await ready(tea);
    const first = new FakeConn(1), second = new FakeConn(2);
    for (const [connection, id] of [[first, device], [second, 'device-two']] as const) {
      hub.connect(connection);
      hub.handle(connection, {
        t: 'hello', proto: 1, device: { id, name: id },
        app: { name: 'test', version: '1' }, features: ['focus'],
      });
    }
    await tea.request({ action: 'send', id: 'message-open-fixture', text: 'Show my fixture terminal' }, device);
    await vi.waitFor(() => expect(tea.state().turns[0].state).toBe('done'));
    expect(first.json('focus')).toEqual([{ t: 'focus', id: 'surf-test', highlight: true }]);
    expect(second.json('focus')).toEqual([]);
  });

  it('publishes partial text before completion and finalizes the same message', async () => {
    let emit!: (delta: string) => void;
    let finish!: (value: TeaCompletion) => void;
    const { tea, hub } = setup(async (request) => {
      emit = request.onText!;
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    await ready(tea);
    const conn = new FakeConn(1);
    hub.connect(conn);
    hub.handle(conn, {
      t: 'hello',
      proto: 1,
      device: { id: device, name: 'Test' },
      app: { name: 'test', version: '1' },
    });
    await tea.request(
      { action: 'send', id: 'message-streaming', text: 'Say hello' },
      device,
    );
    await vi.waitFor(() => expect(emit).toBeTypeOf('function'));
    emit('Hello ');
    const partial = tea
      .state()
      .messages.find((message) => message.role === 'assistant')!;
    expect(partial).toMatchObject({ text: 'Hello ', delivery: 'streaming' });
    expect(tea.state().turns[0].state).toBe('working');
    const reconnected = new FakeConn(2);
    hub.connect(reconnected);
    hub.handle(reconnected, {
      t: 'hello',
      proto: 1,
      device: { id: 'device-reconnected', name: 'Second app' },
      app: { name: 'test', version: '1' },
    });
    expect(
      reconnected
        .json('teaChanged')[0]
        ?.state.messages.find((message) => message.id === partial.id)?.text,
    ).toBe('Hello ');
    emit('there ');
    await vi.waitFor(() =>
      expect(conn.json('teaStream').at(-1)?.message.text).toBe('Hello there '),
    );
    finish(completion('Hello there!'));
    await vi.waitFor(() => expect(tea.state().turns[0].state).toBe('done'));
    expect(
      tea.state().messages.filter((message) => message.role === 'assistant'),
    ).toEqual([{ ...partial, text: 'Hello there!', delivery: undefined }]);
  });

  it('keeps an interrupted draft readable across restart and replaces it on retry', async () => {
    let attempts = 0;
    const { tea, create } = setup(async (request) => {
      attempts++;
      request.onText!('A partial ');
      if (attempts === 1) throw new Error('Fixture connection lost');
      return completion('A complete answer.');
    });
    await ready(tea);
    await tea.request(
      { action: 'send', id: 'message-stream-retry', text: 'Answer please' },
      device,
    );
    await vi.waitFor(() =>
      expect(tea.state().turns[0].state).toBe('interrupted'),
    );
    const draft = tea
      .state()
      .messages.find((message) => message.role === 'assistant')!;
    expect(draft.delivery).toBe('interrupted');
    tea.stop();
    const restored = create();
    expect(
      restored.state().messages.find((message) => message.id === draft.id)
        ?.delivery,
    ).toBe('interrupted');
    await restored.request(
      { action: 'retry', id: 'message-stream-retry' },
      device,
    );
    await vi.waitFor(() =>
      expect(restored.state().turns[0].state).toBe('done'),
    );
    expect(
      restored
        .state()
        .messages.filter((message) => message.role === 'assistant'),
    ).toEqual([{ ...draft, text: 'A complete answer.', delivery: undefined }]);
  });

  it('redacts keys split between streamed chunks and leaves tool execution until completion', async () => {
    let finish!: (value: TeaCompletion) => void;
    let emit!: (delta: string) => void;
    const { tea, registry } = setup(async (request) => {
      emit = request.onText!;
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    await ready(tea);
    await tea.request(
      {
        action: 'send',
        id: 'message-stream-redaction',
        text: 'Prepare a rename',
      },
      device,
    );
    await vi.waitFor(() => expect(emit).toBeTypeOf('function'));
    emit('A key synthetic-secret-for-');
    expect(
      tea.state().messages.find((message) => message.role === 'assistant')
        ?.text,
    ).toBe('A key ');
    emit('tea-tests is hidden. ');
    expect(
      tea.state().messages.find((message) => message.role === 'assistant')
        ?.text,
    ).toBe('A key [redacted] is hidden. ');
    expect(registry.session('surf-test')?.title).toBeUndefined();
    await tea.request(
      { action: 'cancel', id: 'message-stream-redaction' },
      device,
    );
    emit('This late chunk must be ignored. ');
    finish(
      completion('Late completed text.', [
        {
          id: 'tool-late',
          name: 'set_terminal_name',
          input: { terminal_id: 'surf-test', title: 'Unapproved late rename' },
        },
      ]),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(registry.session('surf-test')?.title).toBeUndefined();
    expect(
      tea.state().messages.find((message) => message.role === 'assistant'),
    ).toMatchObject({
      text: 'A key [redacted] is hidden. ',
      delivery: 'interrupted',
    });
  });

  it('marks a checkpointed in-flight stream interrupted when the host reopens its state', async () => {
    let emit!: (delta: string) => void;
    let finish!: (value: TeaCompletion) => void;
    const { tea, dir } = setup(async (request) => {
      emit = request.onText!;
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    await ready(tea);
    await tea.request(
      { action: 'send', id: 'message-stream-reopen', text: 'Continue later' },
      device,
    );
    await vi.waitFor(() => expect(emit).toBeTypeOf('function'));
    emit('Checkpointed words ');
    const reopened = new TeaStore(path.join(dir, 'tea-state.json'));
    expect(
      reopened.data.messages.find((message) => message.role === 'assistant')
        ?.delivery,
    ).toBe('interrupted');
    expect(reopened.data.turns[0].state).toBe('interrupted');
    await tea.request(
      { action: 'cancel', id: 'message-stream-reopen' },
      device,
    );
    finish(completion('Stopped.'));
  });

  it('purges removed connection credentials from persistent state', () => {
    const { tea, dir } = setup();
    tea.store.configure(configuration(), 0);
    tea.store.configure(
      { ...configuration(), connections: [], chat: null, background: null },
      1,
    );
    const restored = new TeaStore(path.join(dir, 'tea-state.json'));
    expect(restored.data.keys).toEqual({});
    expect(restored.data.config.connections).toEqual([]);
    expect(
      fs.readFileSync(path.join(dir, 'tea-state.json'), 'utf8'),
    ).not.toContain('synthetic-secret-for-tea-tests');
  });

  it('keeps API credentials private, persists settings and rejects stale edits', () => {
    const { dir, tea } = setup();
    tea.store.configure(configuration(), 0);
    expect(JSON.stringify(tea.state())).not.toContain('synthetic-secret');
    expect(tea.state().config.connections[0].hasKey).toBe(true);
    const store = new TeaStore(path.join(dir, 'tea-state.json'));
    expect(store.connection(configuration().chat!).apiKey).toBe(
      'synthetic-secret-for-tea-tests',
    );
    expect(fs.statSync(path.join(dir, 'tea-state.json')).mode & 0o777).toBe(
      0o600,
    );
    expect(() => store.configure(configuration(), 0)).toThrow('another device');
    expect(() =>
      store.configure(
        {
          ...configuration(),
          connections: [
            {
              ...configuration().connections[0],
              baseUrl: 'https://provider.test/?api_key=secret',
            },
          ],
        },
        1,
      ),
    ).toThrow('credential');
  });

  it('pushes the same host conversation to connected devices and deduplicates message IDs', async () => {
    const { tea, hub } = setup();
    await ready(tea);
    const first = new FakeConn(1),
      second = new FakeConn(2);
    hub.connect(first);
    hub.connect(second);
    hub.handle(first, {
      t: 'hello',
      proto: 1,
      device: { id: device, name: 'Laptop' },
      app: { name: 'test', version: '1' },
    });
    hub.handle(second, {
      t: 'hello',
      proto: 1,
      device: { id: 'device-two', name: 'Desktop' },
      app: { name: 'test', version: '1' },
    });
    const command = {
      action: 'send' as const,
      id: 'message-one',
      text: 'Where is login work?',
    };
    expect((await tea.request(command, device)).ok).toBe(true);
    expect((await tea.request(command, device)).ok).toBe(true);
    await vi.waitFor(() => expect(tea.state().turns[0].state).toBe('done'));
    expect(
      tea.state().messages.filter((message) => message.role === 'user'),
    ).toHaveLength(1);
    expect(first.json('teaChanged').at(-1)?.state.messages).toEqual(
      second.json('teaChanged').at(-1)?.state.messages,
    );
    expect(
      (await tea.request({ ...command, text: 'A different input' }, device)).ok,
    ).toBe(false);
  });

  it('preserves a custom rename made during background generation while updating its summary', async () => {
    let release!: (value: TeaCompletion) => void;
    const summarizing = vi.fn(
      () =>
        new Promise<TeaCompletion>((resolve) => {
          release = resolve;
        }),
    );
    const { tea, registry, hub } = setup(undefined, summarizing);
    await ready(tea);
    tea.observe(
      'surf-test',
      'claude:conversation',
      'Fix login settings',
      '',
      Date.now(),
    );
    await vi.waitFor(() => expect(summarizing).toHaveBeenCalledTimes(1));
    hub.updateRecord('surf-test', {
      title: 'My login task',
      titleUpdatedAt: Date.now(),
    });
    registry.saveNow();
    release(
      completion(
        '{"title":"Automatic login name","summary":"Investigating saved login credentials."}',
      ),
    );
    await vi.waitFor(() =>
      expect(registry.session('surf-test')?.tea?.summary).toContain(
        'Investigating',
      ),
    );
    expect(registry.session('surf-test')?.title).toBe('My login task');
    expect(registry.session('surf-test')?.tea?.title).toBe(
      'Automatic login name',
    );
  });

  it('discards a generated result for a replaced provider conversation', async () => {
    let release!: (value: TeaCompletion) => void;
    const summarizing = vi.fn(
      () =>
        new Promise<TeaCompletion>((resolve) => {
          release = resolve;
        }),
    );
    const { tea, registry, hub } = setup(undefined, summarizing);
    await ready(tea);
    tea.observe('surf-test', 'claude:conversation', 'Old task', '', Date.now());
    await vi.waitFor(() => expect(summarizing).toHaveBeenCalled());
    hub.updateRecord('surf-test', {
      agent: {
        provider: 'claude',
        sessionId: 'replacement',
        seenAt: Date.now(),
      },
    });
    release(
      completion('{"title":"Old task","summary":"An outdated summary."}'),
    );
    await vi.waitFor(() => expect(tea.state().backgroundPending).toBe(0));
    expect(registry.session('surf-test')?.tea).toBeUndefined();
  });

  it('retains a saved action result across interrupted model continuation and host restart', async () => {
    let calls = 0;
    const { tea, registry, create } = setup(async () => {
      calls++;
      if (calls === 1)
        return completion('', [
          {
            id: 'rename-call',
            name: 'set_terminal_name',
            input: { terminal_id: 'surf-test', title: 'Login review' },
          },
        ]);
      if (calls === 2) throw new Error('Synthetic provider disconnect');
      return completion('The name is saved.');
    });
    await ready(tea);
    await tea.request(
      {
        action: 'send',
        id: 'message-recovery',
        text: 'Rename this terminal Login review',
      },
      device,
    );
    await vi.waitFor(() =>
      expect(tea.state().turns[0].state).toBe('interrupted'),
    );
    expect(registry.session('surf-test')?.title).toBe('Login review');
    const stamp = registry.session('surf-test')!.titleUpdatedAt;
    tea.stop();
    const restored = create();
    expect(
      (
        await restored.request(
          { action: 'retry', id: 'message-recovery' },
          device,
        )
      ).ok,
    ).toBe(true);
    await vi.waitFor(() =>
      expect(restored.state().turns[0].state).toBe('done'),
    );
    expect(registry.session('surf-test')?.titleUpdatedAt).toBe(stamp);
    expect(
      restored.state().messages.filter((message) => message.role === 'tool'),
    ).toHaveLength(1);
  });

  it('fences a recovered write when another device changed the name', () => {
    const { tea, registry, hub } = setup();
    const tools = new TeaTools({
      registry,
      attention: hub.chatAttention,
      evidence: () => ({}),
      messages: () => [],
      publishSession: () => {},
      publishGroup: () => {},
      focus: () => 0,
      refresh: () => {},
      now: Date.now,
      safe: (text) => text,
    });
    const call = {
      id: 'call-fence',
      name: 'set_terminal_name',
      input: { terminal_id: 'surf-test', title: 'Prepared name' },
    };
    const fence = tools.fence(call, device);
    hub.updateRecord('surf-test', {
      title: 'Another device name',
      titleUpdatedAt: Date.now(),
    });
    expect(tools.execute(call, device, fence)).toMatchObject({ ok: false });
    expect(registry.session('surf-test')?.title).toBe('Another device name');
    expect(tea.state().messages).toEqual([]);
  });

  it('targets navigation to the requesting device and keeps reminders in the existing service', () => {
    const { tea, registry, hub } = setup();
    const first = new FakeConn(1),
      second = new FakeConn(2);
    for (const [conn, id] of [
      [first, device],
      [second, 'device-two'],
    ] as const) {
      hub.connect(conn);
      hub.handle(conn, {
        t: 'hello',
        proto: 1,
        device: { id, name: id },
        app: { name: 'test', version: '1' },
        features: ['focus'],
      });
    }
    expect(hub.focus('surf-test', undefined, device)).toBe(1);
    expect(first.json('focus')).toHaveLength(1);
    expect(second.json('focus')).toHaveLength(0);
    const tools = new TeaTools({
      registry,
      attention: hub.chatAttention,
      evidence: () => ({}),
      messages: () => tea.state().messages,
      publishSession: () => {},
      publishGroup: () => {},
      focus: () => 0,
      refresh: () => {},
      now: Date.now,
      safe: (text) => text,
    });
    const call = {
      id: 'reminder-call',
      name: 'set_terminal_reminder',
      input: {
        terminal_id: 'surf-test',
        due_at: new Date(Date.now() + 60000).toISOString(),
        note: 'Review it',
      },
    };
    expect(
      tools.execute(call, device, tools.fence(call, device)),
    ).toMatchObject({ ok: true });
    expect(registry.session('surf-test')?.chatReminder?.createdBy).toBe(device);
  });
});
