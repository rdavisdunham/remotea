// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../src/renderer/store';
import { useRemoteHosts } from '../../src/renderer/remote-sessions/status';
import { makeT } from '../../src/renderer/i18n/core';
import RemoteOverlay from '../../src/renderer/components/Terminal/RemoteOverlay';
import HelpSettings from '../../src/renderer/components/Settings/HelpSettings';
import { recoveryDetail, type RecoveryItem } from '../../src/renderer/remote-sessions/recovery';
import RemotePendingChanges from '../../src/renderer/components/Settings/RemotePendingChanges';
import { describeIntent, forgetEffect, intentStatus, type HostPendingChanges } from '../../src/renderer/remote-sessions/pending-changes';
import { PRODUCT } from '../../src/shared/product';

vi.mock('../../src/renderer/hooks/useUpdate', () => ({ useUpdate: () => ({ state: { phase: 'idle' }, trigger: vi.fn() }) }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
const openExternal = vi.fn();
beforeEach(() => {
  useStore.setState({ language: 'en' });
  useRemoteHosts.setState({ loaded: true, hosts: { host: { id: 'host', name: 'Same-PC WSL', url: 'ws://localhost:7717', enabled: true, hasToken: true } }, status: {} });
  (window as unknown as { wmux: unknown }).wmux = { system: { getVersion: () => Promise.resolve('0.1.0'), openExternal } };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  openExternal.mockClear();
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('disconnected host language', () => {
  it('keeps liveness unknown and output stale until reconnection, including same-PC WSL', async () => {
    useRemoteHosts.setState({ status: { host: { state: 'reconnecting', lastSeenAt: 1_700_000_000_000 } } });
    await act(async () => root.render(createElement(RemoteOverlay, { hostId: 'host' })));
    expect(container.textContent).toContain('Same-PC WSL');
    expect(container.textContent).toContain('Terminal status is unknown');
    expect(container.textContent).toContain('Last seen');
    expect(container.textContent).not.toContain('still running');
    await act(async () => useRemoteHosts.setState({ status: { host: { state: 'suspended' } } }));
    expect(container.textContent).toContain('We will check');
    expect(container.textContent).not.toContain('keeps the session running');
    await act(async () => useRemoteHosts.setState({ status: { host: { state: 'ready' } } }));
    expect(container.textContent).toBe('');
  });

  it('localizes offline uncertainty and never invents a last-seen timestamp', async () => {
    useStore.setState({ language: 'zh-TW' });
    useRemoteHosts.setState({ status: { host: { state: 'reconnecting' } } });
    await act(async () => root.render(createElement(RemoteOverlay, { hostId: 'host' })));
    expect(container.textContent).toContain('無法確認終端機狀態');
    expect(container.textContent).not.toContain('最後連線時間');
    expect(makeT('cs')('remote.close.endHint')).toContain('všech připojených zařízeních');
  });
});

it('routes support and docs to Remotea and exposes lifecycle, credentials and snapshot scope', async () => {
  await act(async () => root.render(createElement(HelpSettings)));
  const click = async (label: string) => {
    const b = [...container.querySelectorAll('button')].find((b) => b.textContent === label)!;
    await act(async () => b.click());
  };
  await click('Report a Remotea issue');
  expect(openExternal).toHaveBeenLastCalledWith(PRODUCT.issuesUrl);
  await click('Remotea documentation');
  expect(openExternal).toHaveBeenLastCalledWith(PRODUCT.documentationUrl);
  expect(container.textContent).toContain('terminal preferences');
  expect(container.textContent).toContain('Native Windows Eridani execution is not available');
  expect(container.textContent).toContain('Phone access');
  const input = container.querySelector('input[type=search]') as HTMLInputElement;
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setValue.call(input, 'phone');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(container.querySelectorAll('details').length).toBeLessThan(10);
  expect(container.textContent).toContain('Pair a phone');
  await act(async () => {
    setValue.call(input, 'no-topic-could-match-this');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(container.querySelectorAll('details')).toHaveLength(0);
  expect(container.textContent).toContain('No matching help topics');
});

it('describes recovery as new process / conversation continuation without changing its identity', () => {
  const item: RecoveryItem = {
    key: 'exited:surf-1:3', kind: 'exited', hostId: 'host', surfaceId: 'surf-1', title: 'Agent',
    detail: 'legacy', detailInfo: { exitCode: 1, provider: 'codex', work: { uncommitted: 2 } as never },
    choices: ['leave', 'reopen'], clean: false,
  };
  expect(recoveryDetail(item)).toContain('Exited while this device was away');
  expect(recoveryDetail(item)).toContain('starts a new process');
  expect(recoveryDetail(item)).toContain('Uncommitted changes: 2');
  const translated = recoveryDetail(item, ((key: string) => `translated:${key}`) as ReturnType<typeof makeT>);
  expect(translated).toContain('translated:remote.recovery.exitedDetail');
  expect(item.key).toBe('exited:surf-1:3');
  expect(item.choices).toEqual(['leave', 'reopen']);
});

describe('pending change acknowledgements', () => {
  const host: HostPendingChanges = {
    hostId: 'host', hostName: 'WSL', uncertain: 1, unlisted: 0,
    items: [{ iid: 'change-1', hostId: 'host', state: 'uncertain', action: 'Close Agent', status: 'Unanswered', forgetEffect: 'Already applied changes remain applied.', createdAt: 1 }],
  };
  it.each([
    [false, 'Could not confirm removal'],
    [true, 'Removed from this device’s pending changes'],
    [undefined, 'request returned without an acknowledgement'],
  ])('reports result %s without implying host rollback', async (response, expected) => {
    const onForget = vi.fn().mockResolvedValue(response);
    await act(async () => root.render(createElement(RemotePendingChanges, { host, onForget })));
    await act(async () => container.querySelector('button')!.click());
    expect(onForget).toHaveBeenCalledWith('host', 'change-1');
    expect(container.querySelector('[role=status]')!.textContent).toContain(expected);
    expect(container.textContent).toMatch(/remains applied|rolled back|does not undo/);
    expect(container.querySelector('button')!.disabled).toBe(false);
  });
  it('catches a rejected request and keeps the change visible for retry', async () => {
    const onForget = vi.fn().mockRejectedValue(new Error('Unavailable'));
    await act(async () => root.render(createElement(RemotePendingChanges, { host, onForget })));
    await act(async () => container.querySelector('button')!.click());
    expect(container.textContent).toContain('Could not confirm removal');
    expect(container.querySelector('[data-iid="change-1"]')).not.toBeNull();
    expect(container.querySelector('button')!.disabled).toBe(false);
  });
  it('uses translated pure descriptions without changing the pending intent', () => {
    const intent = { t: 'close', id: 'surf-1' } as const;
    const t = makeT('zh-TW');
    expect(describeIntent(intent, undefined, t)).toContain('所有裝置');
    expect(intentStatus({ state: 'uncertain', attempts: 1 }, false, t)).toContain('可能已套用');
    expect(forgetEffect(intent, 'uncertain', t)).toContain('該變更會維持');
    expect(intent).toEqual({ t: 'close', id: 'surf-1' });
  });
});
