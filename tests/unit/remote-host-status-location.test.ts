import { afterEach, describe, expect, it, vi } from 'vitest';
import { refreshRemoteHosts, useRemoteHosts } from '../../src/renderer/remote-sessions/status';

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
afterEach(() => {
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
  useRemoteHosts.setState({ loaded: false, loadError: false, hosts: {}, status: {} });
});

describe('location configuration certainty', () => {
  it('distinguishes an unavailable host list from a confirmed removed host', async () => {
    const list = vi.fn().mockRejectedValueOnce(new Error('bridge unavailable')).mockResolvedValueOnce([]);
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { remotea: { remoteHosts: { list } } } });
    await refreshRemoteHosts();
    expect(useRemoteHosts.getState()).toMatchObject({ loaded: true, loadError: true });
    await refreshRemoteHosts();
    expect(useRemoteHosts.getState()).toMatchObject({ loaded: true, loadError: false, hosts: {} });
  });
});
