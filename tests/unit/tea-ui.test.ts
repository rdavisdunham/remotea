// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TeaSettings from '../../src/renderer/components/Settings/TeaSettings';
import TeaPanel from '../../src/renderer/components/Tea/TeaPanel';
import TeaAssistantSettings from '../../src/renderer/components/Settings/TeaAssistantSettings';
import { setLatestRemoteViews } from '../../src/renderer/remote-sessions/registry-cache';
import { useRemoteHosts } from '../../src/renderer/remote-sessions/status';
import type { RemoteRegistryView } from '../../src/shared/remote-hosts-types';
import type { TeaReply, TeaState } from '../../src/shared/tea';
import { useTerminalHighlight } from '../../src/renderer/utils/terminal-highlight';
import { useStore } from '../../src/renderer/store';
import type { PaneId, SurfaceId, WorkspaceId, WorkspaceInfo } from '../../src/shared/types';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const request = vi.hoisted(() => vi.fn());
vi.mock('../../src/renderer/remote-sessions/tea', () => ({
  requestTea: request,
}));
let root: Root;
let container: HTMLDivElement;

function state(): TeaState {
  return {
    revision: 1,
    config: {
      revision: 1,
      enabled: true,
      autoName: true,
      summaries: true,
      connections: [
        {
          id: 'connection-one',
          name: 'Provider',
          protocol: 'anthropic',
          baseUrl: 'https://provider.test',
          hasKey: true,
        },
      ],
      chat: {
        connectionId: 'connection-one',
        model: 'conversation-model',
        effort: 'medium',
      },
      background: {
        connectionId: 'connection-one',
        model: 'summary-model',
        effort: 'low',
      },
    },
    messages: [],
    turns: [],
    backgroundPending: 0,
    modelChecks: { chat: true, background: true },
  };
}
function view(tea = state()): RemoteRegistryView {
  return {
    hostId: 'desk',
    deviceId: 'test-device',
    connected: true,
    bootId: 'boot',
    groups: [],
    sessions: [],
    lost: {},
    closedIds: [],
    teaAvailable: true,
    tea,
  };
}
function button(label: string): HTMLButtonElement {
  const found = Array.from(document.querySelectorAll('button')).find(
    (item) => item.textContent === label,
  );
  if (!found) throw new Error(`Missing button ${label}`);
  return found;
}
function input(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(
      element,
      value,
    );
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
beforeEach(() => {
  useTerminalHighlight.setState({ surfaceId: null });
  request.mockReset().mockResolvedValue({ ok: true });
  setLatestRemoteViews([view()]);
  useRemoteHosts.setState({
    loaded: true,
    loadError: false,
    status: { desk: { hostId: 'desk', state: 'ready', attempt: 0 } },
    hosts: {
      desk: {
        id: 'desk',
        name: 'Desktop',
        url: 'wss://host.test',
        enabled: true,
        hasToken: true,
        unencryptedAcknowledged: false,
      },
    },
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  setLatestRemoteViews(null);
});

describe('Tea provider settings', () => {
  it('shows discovery feedback beside the connection and makes returned models selectable', async () => {
    const current = state();
    current.config.connections[0].protocol = 'openai';
    current.config.connections[0].baseUrl = 'https://api.openai.com/v1';
    setLatestRemoteViews([view(current)]);
    act(() =>
      root.render(
        React.createElement(TeaSettings, { hostId: 'desk', connected: true }),
      ),
    );
    request.mockResolvedValue({
      ok: true,
      state: current,
      models: [
        { id: 'gpt-fixture-chat', name: 'GPT fixture chat' },
        { id: 'gpt-fixture-small', name: 'GPT fixture small' },
      ],
    });
    await act(async () => button('Test connection and find models').click());
    expect(
      container.querySelector('.tea-connection .tea-connection-feedback')
        ?.textContent,
    ).toContain('Found 2 models');
    const picker = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Tea conversation and actions discovered model"]',
    )!;
    expect(picker.disabled).toBe(false);
    expect(Array.from(picker.options).map((option) => option.value)).toContain(
      'gpt-fixture-chat',
    );
    act(() => {
      picker.value = 'gpt-fixture-chat';
      picker.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(
      container.querySelector<HTMLInputElement>('.tea-role input')?.value,
    ).toBe('gpt-fixture-chat');
    input(
      container.querySelector<HTMLInputElement>('input[type=password]')!,
      'synthetic-replacement-key',
    );
    expect(picker.disabled).toBe(true);
    expect(container.querySelector('.tea-connection-feedback')).toBeNull();
  });

  it('reports discovery failures within the connection card', async () => {
    act(() =>
      root.render(
        React.createElement(TeaSettings, { hostId: 'desk', connected: true }),
      ),
    );
    request.mockResolvedValue({
      ok: false,
      error: 'The provider refused this credential.',
    });
    await act(async () => button('Test connection and find models').click());
    const feedback = container.querySelector('.tea-connection [role=alert]');
    expect(feedback?.textContent).toContain('Connection test failed');
    expect(feedback?.textContent).toContain('refused this credential');
  });

  it('removes a saved key explicitly and confirms the stored state', async () => {
    act(() =>
      root.render(
        React.createElement(TeaSettings, { hostId: 'desk', connected: true }),
      ),
    );
    expect(container.textContent).toContain('API key saved on this host');
    act(() => button('Remove saved key').click());
    expect(container.textContent).toContain('will be removed when you save');
    const saved = state();
    saved.revision = 2;
    saved.config.revision = 2;
    saved.config.connections[0].hasKey = false;
    request.mockResolvedValue({ ok: true, state: saved });
    await act(async () => button('Save Tea settings').click());
    expect(request).toHaveBeenCalledWith(
      'desk',
      expect.objectContaining({
        action: 'configure',
        config: expect.objectContaining({
          connections: [expect.objectContaining({ apiKey: '' })],
        }),
      }),
    );
    expect(container.textContent).toContain('No API key saved on this host');
  });

  it('resets provider-specific models when the API format changes', async () => {
    act(() =>
      root.render(
        React.createElement(TeaSettings, { hostId: 'desk', connected: true }),
      ),
    );
    const protocol = container.querySelector<HTMLSelectElement>(
      '.tea-connection select',
    )!;
    act(() => {
      protocol.value = 'openai';
      protocol.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(
      container.querySelector<HTMLInputElement>('.tea-role input')?.value,
    ).toBe('');
    expect(
      container.querySelector<HTMLInputElement>(
        '.tea-connection input[placeholder="https://gateway.example/v1"]',
      )?.value,
    ).toBe('https://api.openai.com/v1');
    request.mockResolvedValue({ ok: true });
    await act(async () => button('Save Tea settings').click());
    expect(request).toHaveBeenCalledWith(
      'desk',
      expect.objectContaining({
        config: expect.objectContaining({
          chat: null,
          background: null,
          connections: [expect.objectContaining({ protocol: 'openai' })],
        }),
      }),
    );
  });

  it('adds OpenAI with the correct label and API format', async () => {
    const empty = state();
    empty.config.connections = [];
    empty.config.chat = null;
    empty.config.background = null;
    setLatestRemoteViews([view(empty)]);
    act(() =>
      root.render(
        React.createElement(TeaSettings, { hostId: 'desk', connected: true }),
      ),
    );
    const protocol = container.querySelector<HTMLSelectElement>(
      'select[aria-label="New provider"]',
    )!;
    act(() => {
      protocol.value = 'openai';
      protocol.dispatchEvent(new Event('change', { bubbles: true }));
    });
    act(() => button('Add provider connection').click());
    expect(
      container.querySelector<HTMLInputElement>('.tea-connection input')?.value,
    ).toBe('OpenAI');
    expect(
      container.querySelector<HTMLSelectElement>('.tea-connection select')
        ?.value,
    ).toBe('openai');
    expect(
      container.querySelector<HTMLInputElement>('.tea-role input')?.value,
    ).toBe('');
  });

  it('allows discovery after clearing an unfinished model selection', async () => {
    act(() =>
      root.render(
        React.createElement(TeaSettings, { hostId: 'desk', connected: true }),
      ),
    );
    input(container.querySelector<HTMLInputElement>('.tea-role input')!, '');
    const saved = state();
    saved.revision = 2;
    saved.config.revision = 2;
    saved.config.chat = null;
    request
      .mockResolvedValueOnce({ ok: true, state: saved })
      .mockResolvedValueOnce({
        ok: true,
        models: [{ id: 'fixture-model', name: 'Fixture model' }],
      });
    await act(async () => button('Test connection and find models').click());
    expect(request.mock.calls[0][1].config.chat).toBeNull();
    expect(request.mock.calls[1][1]).toEqual({
      action: 'discover',
      connectionId: 'connection-one',
    });
    expect(
      container.querySelector('.tea-connection-feedback')?.textContent,
    ).toContain('Found 1 model');
  });

  it('keeps stored keys write-only and exposes separate protocol and effort controls', () => {
    act(() =>
      root.render(
        React.createElement(TeaSettings, { hostId: 'desk', connected: true }),
      ),
    );
    expect(
      container.querySelector<HTMLInputElement>('input[type=password]')?.value,
    ).toBe('');
    expect(container.textContent).toContain('OpenAI Responses');
    expect(container.textContent).toContain(
      'OpenAI-compatible Chat Completions',
    );
    expect(container.querySelectorAll('.tea-role select')).toHaveLength(6);
    expect(container.querySelectorAll('.tea-role input')).toHaveLength(2);
  });

  it('keeps a newer direct save response over an older shared snapshot', async () => {
    act(() =>
      root.render(
        React.createElement(TeaSettings, { hostId: 'desk', connected: true }),
      ),
    );
    const name = container.querySelector<HTMLInputElement>(
      '.tea-connection input',
    )!;
    input(name, 'Updated provider');
    const saved = state();
    saved.revision = 2;
    saved.config.revision = 2;
    saved.config.connections[0].name = 'Updated provider';
    request.mockResolvedValue({ ok: true, state: saved });
    await act(async () => button('Save Tea settings').click());
    expect(name.value).toBe('Updated provider');
    expect(request).toHaveBeenCalledWith(
      'desk',
      expect.objectContaining({ action: 'configure', expectedRevision: 1 }),
    );
    expect(
      container.querySelector<HTMLInputElement>('input[type=password]')?.value,
    ).toBe('');
  });

  it('preserves unsaved edits when another device changes the host settings', () => {
    act(() =>
      root.render(
        React.createElement(TeaSettings, { hostId: 'desk', connected: true }),
      ),
    );
    const name = container.querySelector<HTMLInputElement>(
      '.tea-connection input',
    )!;
    input(name, 'Unsaved local edit');
    const newer = state();
    newer.revision = 2;
    newer.config.revision = 2;
    newer.config.connections[0].name = 'Other device';
    act(() => setLatestRemoteViews([view(newer)]));
    expect(name.value).toBe('Unsaved local edit');
    expect(container.textContent).toContain(
      'Settings changed on another device',
    );
  });
});

describe('Tea settings discovery', () => {
  it('shows provider and key controls immediately on the Tea page', () => {
    act(() =>
      root.render(
        React.createElement(TeaAssistantSettings, { onManageHosts: vi.fn() }),
      ),
    );
    expect(container.querySelector('input[type=password]')).not.toBeNull();
    expect(container.querySelector('.tea-settings')?.tagName).toBe('SECTION');
    expect(container.querySelector('.tea-settings > summary')).toBeNull();
    expect(container.textContent).toContain('API keys');
  });

  it('opens the requested host and keeps credential drafts scoped to that host', () => {
    const hosts = useRemoteHosts.getState().hosts;
    useRemoteHosts.setState({
      hosts: {
        ...hosts,
        laptop: { ...hosts.desk, id: 'laptop', name: 'Laptop' },
      },
      status: {
        ...useRemoteHosts.getState().status,
        laptop: { hostId: 'laptop', state: 'ready', attempt: 0 },
      },
    });
    setLatestRemoteViews([view(), { ...view(), hostId: 'laptop' }]);
    act(() =>
      root.render(
        React.createElement(TeaAssistantSettings, {
          initialHostId: 'laptop',
          onManageHosts: vi.fn(),
        }),
      ),
    );
    const selector =
      container.querySelector<HTMLSelectElement>('#tea-settings-host')!;
    expect(selector.value).toBe('laptop');
    input(
      container.querySelector<HTMLInputElement>('input[type=password]')!,
      'synthetic-unsaved-key',
    );
    act(() => {
      selector.value = 'desk';
      selector.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(selector.value).toBe('desk');
    expect(
      container.querySelector<HTMLInputElement>('input[type=password]')?.value,
    ).toBe('');
    expect(request).not.toHaveBeenCalled();
  });

  it('offers host management and disables edits when disconnected', () => {
    useRemoteHosts.setState({
      status: { desk: { hostId: 'desk', state: 'reconnecting', attempt: 1 } },
    });
    const manage = vi.fn();
    act(() =>
      root.render(
        React.createElement(TeaAssistantSettings, { onManageHosts: manage }),
      ),
    );
    expect(container.textContent).toContain('Connect to this host');
    expect(container.querySelector('fieldset[disabled]')).not.toBeNull();
    act(() => button('Manage remote hosts').click());
    expect(manage).toHaveBeenCalledOnce();
  });
});

describe('Tea conversation panel', () => {
  it('highlights the exact terminal selected from a reply', async () => {
    const previous = useStore.getState().workspaces;
    const workspace: WorkspaceInfo = {
      id: 'fixture-workspace' as WorkspaceId, title: 'Fixture', pinned: false,
      shell: 'bash', unreadCount: 0,
      splitTree: {
        type: 'leaf', paneId: 'fixture-pane' as PaneId, activeSurfaceIndex: 0,
        surfaces: [{ id: 'surf-fixture' as SurfaceId, type: 'terminal' }],
      },
    };
    useStore.setState({ workspaces: [workspace] });
    const current = view();
    current.tea!.messages = [{
      id: 'reply-fixture', role: 'assistant', text: 'Here is surf-fixture.', at: 1,
    }];
    current.sessions = [{
      id: 'surf-fixture', title: 'Fixture terminal', groupId: 'grp-fixture',
      cwd: '/fixture', createdBy: 'test-device', bootId: 'boot', createdAt: 1,
      state: 'live', hiddenBy: [],
    }];
    setLatestRemoteViews([current]);
    try {
      act(() => root.render(React.createElement(TeaPanel, { onClose: vi.fn() })));
      // The reply names the terminal; its ID is for Tea, not for the reader.
      expect(document.querySelector('.tea-message--assistant p')?.textContent)
        .toBe('Here is Fixture terminal.');
      await act(async () => button('Open Fixture terminal').click());
      expect(useTerminalHighlight.getState().surfaceId).toBe('surf-fixture');
    } finally {
      useStore.setState({ workspaces: previous });
    }
  });

  it('sends with Enter and keeps Shift+Enter and IME confirmation available', async () => {
    act(() => root.render(React.createElement(TeaPanel, { onClose: vi.fn() })));
    const textarea = document.querySelector<HTMLTextAreaElement>('#tea-message')!;
    input(textarea, 'Find the fixture terminal');
    for (const options of [
      { shiftKey: true },
      { isComposing: true },
      { keyCode: 229 },
    ]) {
      const event = new KeyboardEvent('keydown', {
        key: 'Enter', bubbles: true, cancelable: true, ...options,
      });
      act(() => textarea.dispatchEvent(event));
      expect(event.defaultPrevented).toBe(false);
      expect(request).not.toHaveBeenCalled();
    }
    input(textarea, 'Find the fixture terminal\nwith the latest changes');
    const enter = new KeyboardEvent('keydown', {
      key: 'Enter', bubbles: true, cancelable: true,
    });
    await act(async () => textarea.dispatchEvent(enter));
    expect(enter.defaultPrevented).toBe(true);
    expect(request).toHaveBeenCalledExactlyOnceWith('desk', {
      action: 'send', id: expect.any(String),
      text: 'Find the fixture terminal\nwith the latest changes',
    });
    expect(textarea.value).toBe('');
  });

  it.each(['empty', 'unvalidated', 'disconnected', 'disabled'])(
    'keeps Enter subject to Send eligibility when %s',
    async (condition) => {
      const current = view();
      if (condition === 'unvalidated') current.tea!.modelChecks.chat = false;
      if (condition === 'disconnected') current.connected = false;
      if (condition === 'disabled') current.tea!.config.enabled = false;
      setLatestRemoteViews([current]);
      act(() => root.render(React.createElement(TeaPanel, { onClose: vi.fn() })));
      const textarea = document.querySelector<HTMLTextAreaElement>('#tea-message')!;
      if (condition !== 'empty') input(textarea, 'A fixture question');
      await act(async () => textarea.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter', bubbles: true, cancelable: true,
      })));
      expect(button('Send').disabled).toBe(true);
      expect(request).not.toHaveBeenCalled();
    },
  );

  it('does not send a duplicate while the previous request is pending', async () => {
    act(() => root.render(React.createElement(TeaPanel, { onClose: vi.fn() })));
    const textarea = document.querySelector<HTMLTextAreaElement>('#tea-message')!;
    input(textarea, 'A fixture question');
    let resolve!: (reply: TeaReply) => void;
    request.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    act(() => textarea.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter', bubbles: true, cancelable: true,
    })));
    act(() => textarea.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter', bubbles: true, cancelable: true,
    })));
    expect(request).toHaveBeenCalledOnce();
    await act(async () => resolve({ ok: true }));
    expect(textarea.value).toBe('');
  });

  it('shows a thinking bubble before text and updates the same reply while streaming', () => {
    const current = state();
    current.turns = [
      { id: 'turn-stream', state: 'working', phase: 'Thinking' },
    ];
    setLatestRemoteViews([view(current)]);
    act(() => root.render(React.createElement(TeaPanel, { onClose: vi.fn() })));
    expect(
      document.querySelector('[aria-label="Tea is thinking"]'),
    ).not.toBeNull();
    const partial = {
      ...current,
      messages: [
        {
          id: 'reply-stream',
          role: 'assistant' as const,
          text: 'First ',
          at: 1,
          delivery: 'streaming' as const,
        },
      ],
    };
    act(() => setLatestRemoteViews([view(partial)]));
    expect(document.querySelectorAll('.tea-message--assistant')).toHaveLength(
      1,
    );
    expect(document.querySelector('.tea-message__cursor')).not.toBeNull();
    expect(
      document.querySelector('[aria-label="Tea is responding"]'),
    ).not.toBeNull();
    const scroll = document.querySelector<HTMLDivElement>(
      '.tea-panel__messages',
    )!;
    Object.defineProperties(scroll, {
      scrollHeight: { value: 1000 },
      clientHeight: { value: 100 },
    });
    scroll.scrollTop = 50;
    act(() => scroll.dispatchEvent(new Event('scroll', { bubbles: true })));
    const finished = {
      ...current,
      messages: [
        {
          id: 'reply-stream',
          role: 'assistant' as const,
          text: 'First second done.',
          at: 1,
        },
      ],
      turns: [{ id: 'turn-stream', state: 'done' as const, phase: 'Finished' }],
    };
    act(() => setLatestRemoteViews([view(finished)]));
    expect(document.querySelectorAll('.tea-message--assistant')).toHaveLength(
      1,
    );
    expect(
      document.querySelector('.tea-message--assistant')?.textContent,
    ).toContain('First second done.');
    expect(scroll.scrollTop).toBe(50);
    expect(document.querySelector('.tea-thinking')).toBeNull();
    expect(document.querySelector('.tea-message__cursor')).toBeNull();
  });

  it('keeps an interrupted reply visibly partial', () => {
    const current = state();
    current.messages = [
      {
        id: 'reply-interrupted',
        role: 'assistant',
        text: 'Unfinished words',
        at: 1,
        delivery: 'interrupted',
      },
    ];
    act(() => setLatestRemoteViews([view(current)]));
    act(() => root.render(React.createElement(TeaPanel, { onClose: vi.fn() })));
    expect(
      document.querySelector('.tea-message__partial')?.textContent,
    ).toContain('interrupted');
    expect(document.querySelector('.tea-message__cursor')).toBeNull();
  });

  it('opens Tea settings for the currently selected host', async () => {
    const close = vi.fn(),
      settings = vi.fn();
    act(() =>
      root.render(
        React.createElement(TeaPanel, { onClose: close, onSettings: settings }),
      ),
    );
    await act(async () => button('Configure Tea').click());
    expect(close).toHaveBeenCalledOnce();
    expect(settings).toHaveBeenCalledExactlyOnceWith('desk');
  });

  it('explains why sending is unavailable before model validation', () => {
    const tea = state();
    tea.modelChecks.chat = false;
    setLatestRemoteViews([view(tea)]);
    act(() =>
      root.render(React.createElement(TeaPanel, { onClose: () => {} })),
    );
    expect(document.querySelector('.tea-panel')?.textContent).toContain(
      'before sending messages',
    );
    expect(button('Send').disabled).toBe(true);
  });

  it('renders outside the sidebar, exposes recovery controls and closes with Escape', () => {
    const tea = state();
    tea.turns = [
      {
        id: 'interrupted-message',
        state: 'interrupted',
        error: 'Provider disconnected',
      },
    ];
    setLatestRemoteViews([view(tea)]);
    const close = vi.fn();
    act(() => root.render(React.createElement(TeaPanel, { onClose: close })));
    expect(container.querySelector('.tea-panel')).toBeNull();
    expect(
      document.querySelector('.tea-panel__notices')?.textContent,
    ).toContain('Provider disconnected');
    expect(button('Continue saved turn').disabled).toBe(false);
    expect(document.querySelector('.tea-panel__status')?.textContent).toContain(
      'Needs you',
    );
    act(() =>
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })),
    );
    expect(close).toHaveBeenCalledOnce();
  });

  it('reuses a stable message ID after uncertain delivery and clears input after confirmation', async () => {
    act(() =>
      root.render(React.createElement(TeaPanel, { onClose: () => {} })),
    );
    const textarea =
      document.querySelector<HTMLTextAreaElement>('#tea-message')!;
    input(textarea, 'Where is my login terminal?');
    request.mockResolvedValueOnce({
      ok: false,
      uncertain: true,
      error: 'Delivery unconfirmed',
    } satisfies TeaReply);
    await act(async () => button('Send').click());
    expect(textarea.value).toBe('Where is my login terminal?');
    const command = request.mock.calls[0][1];
    request.mockResolvedValueOnce({ ok: true });
    await act(async () => button('Send').click());
    expect(request.mock.calls[1][1]).toEqual(command);
    expect(textarea.value).toBe('');
  });
});
