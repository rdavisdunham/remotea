// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { create } from 'zustand';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TerminalPane from '../../src/renderer/components/Terminal/TerminalPane';
import { setLatestRemoteViews } from '../../src/renderer/remote-sessions/registry-cache';
import { forwardTerminalInput } from '../../src/renderer/remote-sessions/managed-control';
import { setKeyRemaps } from '../../src/renderer/key-remaps';
import { makeT } from '../../src/renderer/i18n/core';
import type { RemoteRegistryView } from '../../src/shared/remote-hosts-types';

const state = create(() => ({ workspacePrefs: { defaultShell: 'pwsh' }, shortcuts: {} }));
const focus = vi.fn();
vi.mock('../../src/renderer/store', () => ({ get useStore() { return state; } }));
vi.mock('../../src/renderer/i18n', () => ({ useT: () => makeT('en') }));
vi.mock('../../src/renderer/hooks/useTerminal', () => ({ useTerminal: () => ({ terminalRef: { current: null }, searchAddonRef: { current: null }, xtermRef: { current: { focus } } }) }));
vi.mock('../../src/renderer/components/Terminal/RemoteOverlay', () => ({ default: () => null }));
vi.mock('../../src/renderer/components/Terminal/RemoteSizeBadge', () => ({ default: () => null }));
vi.mock('../../src/renderer/components/Terminal/PinnedPrompt', () => ({ default: () => null }));
vi.mock('../../src/renderer/components/Terminal/PromptOutline', () => ({ default: () => null }));
vi.mock('../../src/renderer/components/Terminal/NewOutputPill', () => ({ default: () => null }));
vi.mock('../../src/renderer/components/Terminal/ResetNotice', () => ({ default: () => null }));
vi.mock('../../src/renderer/components/Terminal/CopyMode', () => ({ default: () => null }));
vi.mock('../../src/renderer/components/Terminal/FindBar', () => ({ default: () => React.createElement('input', { 'aria-label': 'Find' }) }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
let host: HTMLDivElement;
const takeover = vi.fn();
function registry(controller: 'eridani' | 'terminal' = 'eridani', connected = true): RemoteRegistryView[] {
  return [{ hostId: 'host', deviceId: 'desktop', connected, bootId: 'boot', groups: [], closedIds: [], lost: {}, sessions: [{
    id: 'surface', state: 'running', eridani: { execution: 'managed', controller, runId: 'run', generation: 1 },
  }] }] as unknown as RemoteRegistryView[];
}
function render(props = {}) {
  act(() => root.render(React.createElement(TerminalPane, { surfaceId: 'surface', shell: 'remote:host', ...props })));
}
function terminalTarget(): HTMLElement {
  let target = host.querySelector<HTMLElement>('.xterm-helper-textarea');
  if (!target) {
    const xterm = document.createElement('div');
    xterm.className = 'xterm';
    target = document.createElement('textarea'); target.className = 'xterm-helper-textarea';
    xterm.append(target); host.querySelector('.terminal-pane__container')!.append(xterm);
  }
  return target;
}
function press(target: EventTarget = terminalTarget(), options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', { key: ' ', code: 'Space', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true, ...options });
  act(() => { target.dispatchEvent(event); });
  return event;
}
beforeEach(() => {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  focus.mockClear(); takeover.mockReset(); takeover.mockResolvedValue({ ok: true });
  window.wmux = { remoteSessions: { takeover } };
  state.setState({ shortcuts: {} }); setLatestRemoteViews(registry()); setKeyRemaps([]);
});
afterEach(() => {
  act(() => root.unmount()); host.remove(); setLatestRemoteViews(null); setKeyRemaps([]);
});

describe('managed desktop terminal affordance', () => {
  it('allocates a footer outside the transcript viewport with disabled input and explicit takeover', () => {
    render({ showFindBar: true });
    const viewport = host.querySelector('.terminal-pane__viewport')!;
    const footer = host.querySelector('footer')!;
    expect(viewport.contains(footer)).toBe(false);
    expect(viewport.querySelector('input[aria-label="Find"]')).not.toBeNull();
    expect(footer.textContent).toContain('Eridani controls this session');
    expect(footer.textContent).toContain('Scroll, copy and find are available');
    expect(footer.querySelector('input')?.disabled).toBe(true);
    expect(footer.querySelector('button')?.textContent).toBe('Take overCtrl+Shift+Space');
  });
  it('consumes the shortcut before xterm can type a space, once per press', async () => {
    render();
    expect(press().defaultPrevented).toBe(true);
    press(terminalTarget(), { repeat: true });
    expect(takeover).toHaveBeenCalledExactlyOnceWith('host', 'surface');
    await act(async () => {});
    expect(host.querySelector('footer button')?.hasAttribute('disabled')).toBe(true);
    expect(host.textContent).toContain('Waiting for the host');
    expect(focus).not.toHaveBeenCalled();
    act(() => setLatestRemoteViews(registry('terminal')));
    expect(host.querySelector('footer')).toBeNull();
    expect(focus).toHaveBeenCalledOnce();
  });
  it('does not claim IME composition, a hidden pane, an unfocused pane, a text field or another pane', () => {
    render({ showFindBar: true });
    expect(press(terminalTarget(), { isComposing: true }).defaultPrevented).toBe(false);
    expect(press(host.querySelector('input[aria-label="Find"]')!).defaultPrevented).toBe(false);
    expect(press(document.body).defaultPrevented).toBe(false);
    render({ focused: false }); expect(press().defaultPrevented).toBe(false);
    render({ visible: false }); expect(press().defaultPrevented).toBe(false);
    expect(takeover).not.toHaveBeenCalled();
  });
  it('leaves bare Ctrl+Space, unmodified Space and Meta chords alone', () => {
    render();
    for (const options of [{ shiftKey: false }, { ctrlKey: false, shiftKey: false }, { metaKey: true }]) {
      expect(press(terminalTarget(), options).defaultPrevented).toBe(false);
    }
    expect(takeover).not.toHaveBeenCalled();
  });
  it('honors app shortcut and live config remap collisions while retaining the button', () => {
    state.setState({ shortcuts: { find: { key: ' ', ctrl: true, shift: true } } }); render();
    expect(host.querySelector('kbd')).toBeNull(); expect(press().defaultPrevented).toBe(false);
    act(() => state.setState({ shortcuts: {} })); expect(host.querySelector('kbd')).not.toBeNull();
    act(() => setKeyRemaps([{ chord: { key: ' ', ctrl: true, shift: true, alt: false }, send: '', source: 'ctrl+shift+space' }]));
    expect(host.querySelector('kbd')).toBeNull(); expect(press().defaultPrevented).toBe(false);
    expect(host.querySelector<HTMLButtonElement>('footer button')?.disabled).toBe(false);
    expect(takeover).not.toHaveBeenCalled();
  });
  it('keeps uncertain handoffs blocked until registry confirmation', async () => {
    takeover.mockResolvedValue({ ok: false, uncertain: true }); render();
    await act(async () => { host.querySelector<HTMLButtonElement>('footer button')!.click(); });
    expect(host.querySelector<HTMLButtonElement>('footer button')?.disabled).toBe(true);
    expect(host.querySelector('footer input')).not.toBeNull();
    const write = vi.fn(); forwardTerminalInput('surface', ['surface'], 'oops', write);
    expect(write).not.toHaveBeenCalled();
  });
  it.each([{ ok: false, uncertain: true }, { ok: true }])('allows only explicit retry after fresh connected ownership confirmation (%j)', async result => {
    takeover.mockResolvedValue(result); render();
    await act(async () => { host.querySelector<HTMLButtonElement>('footer button')!.click(); });
    render(); // Local rerender is not fresh ownership evidence.
    expect(host.querySelector<HTMLButtonElement>('footer button')?.disabled).toBe(true);
    act(() => setLatestRemoteViews(registry('eridani', false)));
    expect(host.querySelector<HTMLButtonElement>('footer button')?.disabled).toBe(true);
    act(() => setLatestRemoteViews(registry('eridani')));
    const retry = host.querySelector<HTMLButtonElement>('footer button')!;
    expect(retry.disabled).toBe(false);
    expect(retry.textContent).toContain('Retry takeover');
    expect(host.textContent).toContain('host still reports Eridani control');
    expect(host.querySelector<HTMLInputElement>('footer input')?.disabled).toBe(true);
    const write = vi.fn(); forwardTerminalInput('surface', ['surface'], 'still blocked', write);
    expect(write).not.toHaveBeenCalled();
    act(() => setLatestRemoteViews(registry('eridani')));
    expect(takeover).toHaveBeenCalledTimes(1); // Registry updates never retry automatically.
    await act(async () => { retry.click(); });
    expect(takeover).toHaveBeenCalledTimes(2);
    expect(host.querySelector<HTMLButtonElement>('footer button')?.disabled).toBe(true);
    act(() => setLatestRemoteViews(registry('terminal')));
    expect(host.querySelector('footer')).toBeNull();
    forwardTerminalInput('surface', ['surface'], 'confirmed', write);
    expect(write).toHaveBeenCalledExactlyOnceWith('surface', 'confirmed');
  });
  it('waits for a registry update after the uncertain RPC settles, rather than an earlier in-flight update', async () => {
    let settle!: (result: { ok: boolean; uncertain: boolean }) => void;
    takeover.mockReturnValue(new Promise(resolve => { settle = resolve; })); render();
    act(() => host.querySelector<HTMLButtonElement>('footer button')!.click());
    act(() => setLatestRemoteViews(registry('eridani')));
    await act(async () => { settle({ ok: false, uncertain: true }); });
    expect(host.querySelector<HTMLButtonElement>('footer button')?.disabled).toBe(true);
    expect(host.textContent).toContain('Waiting for the host');
    expect(takeover).toHaveBeenCalledTimes(1);
    act(() => setLatestRemoteViews(registry('eridani')));
    expect(host.querySelector<HTMLButtonElement>('footer button')?.disabled).toBe(false);
    expect(takeover).toHaveBeenCalledTimes(1);
  });
  it('shows failed handoff and disconnected state without enabling terminal input', async () => {
    takeover.mockRejectedValue(new Error('offline')); render();
    await act(async () => { host.querySelector<HTMLButtonElement>('footer button')!.click(); });
    expect(host.textContent).toContain('handoff was not confirmed');
    expect(host.querySelector<HTMLInputElement>('footer input')?.disabled).toBe(true);
    act(() => setLatestRemoteViews(registry('eridani', false)));
    expect(host.querySelector<HTMLButtonElement>('footer button')?.disabled).toBe(true);
    expect(host.textContent).toContain('Reconnect');
  });
  it('does not add controls to local or ordinary remote terminals', () => {
    render({ shell: 'pwsh' }); expect(host.querySelector('footer')).toBeNull();
    act(() => setLatestRemoteViews([{ ...registry()[0], sessions: [] }]));
    render(); expect(host.querySelector('footer')).toBeNull();
  });
});

describe('live terminal input ownership', () => {
  it('blocks source keystrokes, IME/paste bytes and broadcast fanout until registry proves takeover', () => {
    const write = vi.fn();
    for (const data of [' ', '\r', 'pasted text', '\x1b[200~paste\x1b[201~', '日本語']) {
      forwardTerminalInput('surface', ['surface', 'local'], data, write);
    }
    expect(write).not.toHaveBeenCalled();
    setLatestRemoteViews(registry('terminal'));
    forwardTerminalInput('surface', ['surface'], 'same conversation', write);
    expect(write).toHaveBeenCalledExactlyOnceWith('surface', 'same conversation');
  });
  it('filters controlled broadcast destinations while preserving native terminal input', () => {
    const write = vi.fn(); forwardTerminalInput('local', ['local', 'surface', 'other'], 'a', write);
    expect(write.mock.calls).toEqual([['local', 'a'], ['other', 'a']]);
    setLatestRemoteViews(null); forwardTerminalInput('local', ['local'], ' ', write);
    expect(write).toHaveBeenLastCalledWith('local', ' ');
  });
});
