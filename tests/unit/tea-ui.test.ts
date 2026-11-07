// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TeaSettings from '../../src/renderer/components/Settings/TeaSettings';
import TeaPanel from '../../src/renderer/components/Tea/TeaPanel';
import { setLatestRemoteViews } from '../../src/renderer/remote-sessions/registry-cache';
import { useRemoteHosts } from '../../src/renderer/remote-sessions/status';
import type { RemoteRegistryView } from '../../src/shared/remote-hosts-types';
import type { TeaReply, TeaState } from '../../src/shared/tea';

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
  request.mockReset().mockResolvedValue({ ok: true });
  setLatestRemoteViews([view()]);
  useRemoteHosts.setState({
    loaded: true,
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
    expect(container.querySelectorAll('.tea-role select')).toHaveLength(4);
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

describe('Tea conversation panel', () => {
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
