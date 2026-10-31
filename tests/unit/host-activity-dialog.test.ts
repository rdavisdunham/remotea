// @vitest-environment jsdom
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import HostActivityDialog from '../../src/renderer/components/Connections/HostActivityDialog';
import { useRemoteHosts } from '../../src/renderer/remote-sessions/status';
import { useRemoteRegistry } from '../../src/renderer/remote-sessions/registry-cache';
import { useStore } from '../../src/renderer/store';
import { INBOX_GROUP_ID, type SessionRecord } from '../../src/shared/remote-host-protocol';
import type { RemoteRegistryView } from '../../src/shared/remote-hosts-types';
import type { RemoteConsoleStatus } from '../../src/shared/remote-console-config';

const unhide = vi.hoisted(() => vi.fn());
vi.mock('../../src/renderer/remote-sessions/sync', () => ({ unhideRemoteSession: unhide }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const DEVICE = 'dev-test0000';
const host = { id: 'desk', name: 'Execution desk', url: 'ws://localhost:7717', enabled: true, hasToken: true };
function session(id: string, patch: Partial<SessionRecord> = {}): SessionRecord {
  return { id: id as SessionRecord['id'], groupId: INBOX_GROUP_ID, cwd: '/repo', createdBy: DEVICE as SessionRecord['createdBy'], createdAt: 1, bootId: 'boot-test', state: 'live', hiddenBy: [], ...patch };
}
function view(sessions: SessionRecord[], patch: Partial<RemoteRegistryView> = {}): RemoteRegistryView {
  return { hostId: host.id, deviceId: DEVICE, connected: false, bootId: 'boot-test', groups: [], sessions, closedIds: [], lost: {}, ...patch };
}
function phone(running: boolean, enabled = true): RemoteConsoleStatus {
  return { running, config: { enabled }, listening: null, lastError: null, lastRejectedOrigin: null, lanAddresses: [], devices: [], connected: [], pairing: null } as RemoteConsoleStatus;
}

describe('HostActivityDialog mounted behavior', () => {
  let root: Root;
  let container: HTMLDivElement;
  let previous: typeof window.wmux;
  let phoneListener: ((status: RemoteConsoleStatus) => void) | undefined;
  const unsubscribe = vi.fn();
  beforeEach(() => {
    previous = window.wmux;
    phoneListener = undefined;
    vi.clearAllMocks();
    window.wmux = { remoteConsole: { getState: vi.fn().mockRejectedValue(new Error('unavailable')), onState: vi.fn((listener) => { phoneListener = listener; return unsubscribe; }) } } as unknown as typeof window.wmux;
    useStore.setState({ language: 'en' });
    useRemoteHosts.setState({ loaded: false, loadError: false, hosts: {}, status: {} });
    useRemoteRegistry.setState({ views: null });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    window.wmux = previous;
    useRemoteHosts.setState({ loaded: false, loadError: false, hosts: {}, status: {} });
    useRemoteRegistry.setState({ views: null });
  });
  const mount = async (onClose = vi.fn()) => act(async () => root.render(createElement(HostActivityDialog, { onClose, onSettings: vi.fn() })));

  it('distinguishes unknown host definitions from a confirmed empty configuration', async () => {
    await mount();
    expect(container.querySelector('[role="status"]')?.textContent).toContain('not yet known');
    expect(container.textContent).not.toContain('No remote hosts are configured');
    expect(container.textContent).toContain('Phone access status is unavailable');
    await act(async () => useRemoteHosts.setState({ loaded: true }));
    expect(container.textContent).toContain('No remote hosts are configured');
    expect(container.textContent).toContain('local terminals without adding one');
  });

  it('does not call a failed host list a confirmed empty configuration', async () => {
    useRemoteHosts.setState({ loaded: true, loadError: true });
    await mount();
    expect(container.textContent).not.toContain('No remote hosts are configured');
    expect(container.querySelector('[role="status"]')).not.toBeNull();
  });

  it('labels disconnected hidden processes last known, excludes closed records, and shows the intended session', async () => {
    useRemoteHosts.setState({ loaded: true, hosts: { desk: host }, status: { desk: { hostId: 'desk', state: 'reconnecting', attempt: 1, lastSeenAt: Date.now() - 60000 } } });
    useRemoteRegistry.setState({ views: [view([
      session('surf-hidden', { title: 'Hidden worker', hiddenBy: [DEVICE as SessionRecord['createdBy']] }),
      session('surf-closed', { title: 'Closed worker', hiddenBy: [DEVICE as SessionRecord['createdBy']] }),
    ], { closedIds: ['surf-closed'] })] });
    await mount();
    const hidden = container.querySelector('.host-activity__hidden')!;
    expect(hidden.textContent).toContain('Hidden worker');
    expect(hidden.textContent).toContain('Live (last known)');
    expect(container.textContent).not.toContain('Closed worker');
    const buttons = hidden.querySelectorAll('button');
    expect(buttons).toHaveLength(1);
    await act(async () => buttons[0].click());
    expect(unhide).toHaveBeenCalledExactlyOnceWith('desk', 'surf-hidden');
  });

  it('keeps phone listener state independent of host connection state', async () => {
    useRemoteHosts.setState({ loaded: true, hosts: { desk: host }, status: { desk: { hostId: 'desk', state: 'reconnecting', attempt: 1 } } });
    await mount();
    await act(async () => phoneListener?.(phone(true)));
    expect(container.textContent).toContain('Phone access is running through this desktop');
    expect(container.querySelector('[data-kind="connection"]')?.textContent).toBe('Reconnecting…');
    await act(async () => phoneListener?.(phone(false, false)));
    expect(container.textContent).toContain('Phone access is off');
    expect(container.querySelector('[data-kind="connection"]')?.textContent).toBe('Reconnecting…');
    await act(async () => phoneListener?.(phone(false)));
    expect(container.textContent).toContain('enabled but its listener is not running');
  });

  it('contains Tab, ShiftTab and outside focus, closes on Escape, and restores the opener', async () => {
    const opener = document.createElement('button');
    opener.textContent = 'Open activity';
    document.body.append(opener);
    opener.focus();
    const close = vi.fn();
    function Harness() {
      const [open, setOpen] = useState(true);
      return open ? createElement(HostActivityDialog, { onClose: () => { close(); setOpen(false); }, onSettings: vi.fn() }) : null;
    }
    try {
      await act(async () => root.render(createElement(Harness)));
      const dialog = container.querySelector('[role="dialog"]')!;
      const controls = [...dialog.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
      expect(document.activeElement).toBe(controls[0]);
      await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true })));
      expect(document.activeElement).toBe(controls.at(-1));
      await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })));
      expect(document.activeElement).toBe(controls[0]);
      act(() => opener.focus());
      expect(document.activeElement).toBe(controls[0]);
      await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
      expect(close).toHaveBeenCalledOnce();
      expect(container.querySelector('[role="dialog"]')).toBeNull();
      expect(document.activeElement).toBe(opener);
      expect(unsubscribe).toHaveBeenCalledOnce();
    } finally { opener.remove(); }
  });
});
