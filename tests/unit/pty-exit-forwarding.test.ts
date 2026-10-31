import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { IPC_CHANNELS, type SurfaceId } from '../../src/shared/types';
import type { PtyExitInfo } from '../../src/shared/remote-hosts-types';

vi.mock('node-pty', () => ({ spawn: vi.fn() }));
const handlers = new Map<string, Function>();
let targetWindow: unknown;
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: Function) => handlers.set(channel, handler), on: vi.fn() },
  BrowserWindow: { getAllWindows: () => [], fromWebContents: () => targetWindow, getFocusedWindow: () => null },
  clipboard: { readText: () => '', writeText: () => {} }, shell: {}, dialog: {},
  app: { getPath: () => os.tmpdir(), getVersion: () => '0.0.0' },
  nativeTheme: { on: () => {} }, safeStorage: { isEncryptionAvailable: () => false },
}));
vi.mock('../../src/shared/instance', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  getAppDataDir: () => path.join(os.tmpdir(), 'remotea-pty-exit-forwarding-test'),
}));

import { ptyManager, registerIpcHandlers, setupAgentPtyForwarding } from '../../src/main/ipc-handlers';
import { RemoteHostClient } from '../../src/main/remote-hosts/host-client';
import { remoteTaps } from '../../src/main/remote-console/taps';

const ID = 'surf-exit-forwarding' as SurfaceId;
const INFO: PtyExitInfo = { reason: 'exited' };

/** The actual HostClient subscription methods replay held output and pending exit
 * synchronously. No socket/PTY is necessary to exercise that retained state. */
function fixture(pending: boolean) {
  const state = {
    data: new Set<(data: string) => void>(),
    exit: new Set<(code: number, info: PtyExitInfo) => void>(),
    resync: new Set<Function>(), sizeCbs: new Set<Function>(),
    held: ['first', 'tail'], pendingExit: pending ? { code: 7, info: INFO } : null,
  };
  const client = Object.assign(Object.create(RemoteHostClient.prototype) as RemoteHostClient, { surfs: new Map([[ID, state]]) });
  const off = { data: vi.fn(), exit: vi.fn(), size: vi.fn(), resync: vi.fn() };
  for (const [method, key] of [['onData', 'data'], ['onExit', 'exit'], ['onSize', 'size'], ['onResync', 'resync']] as const) {
    vi.spyOn(ptyManager, method).mockImplementation(((id: SurfaceId, cb: never) => {
      const dispose = client[method](id, cb);
      return () => { off[key](); dispose(); };
    }) as never);
  }
  return { state, off };
}

beforeAll(() => registerIpcHandlers({} as never));
beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); targetWindow = undefined; });

describe.each(['create', 'agent'] as const)('%s PTY forwarding', (route) => {
  it.each([true, false])('handles synchronous pending exit=%s with exactly-once cleanup and output before exit', async (pending) => {
    const { state, off } = fixture(pending);
    const events: unknown[][] = [];
    const wc = { id: 390, once: vi.fn(), send: (channel: string, ...args: unknown[]) => events.push([channel, ...args]) };
    const win = { webContents: wc, isDestroyed: () => false };
    targetWindow = win;
    const tapExit = vi.spyOn(remoteTaps, 'exit');
    const unbind = vi.spyOn(remoteTaps, 'unbindSurface');
    const created = { id: ID, shell: 'remote:desk', remote: true, reused: false };
    vi.spyOn(ptyManager, 'create').mockResolvedValue(created);

    const attach = () => route === 'create'
      ? handlers.get(IPC_CHANNELS.PTY_CREATE)!({ sender: wc }, { surfaceId: ID, shell: 'remote:desk' })
      : setupAgentPtyForwarding(ID, win as never);
    await expect(Promise.resolve().then(attach)).resolves.toEqual(route === 'create' ? created : undefined);
    if (!pending) {
      expect(state.exit.size).toBe(1);
      const callback = [...state.exit][0];
      callback(7, INFO);
      // A retained callback or reentrant duplicate cannot run teardown twice.
      callback(8, { reason: 'closed' });
    }
    expect(events).toEqual([
      [IPC_CHANNELS.PTY_DATA, ID, 'first'],
      [IPC_CHANNELS.PTY_DATA, ID, 'tail'],
      [IPC_CHANNELS.PTY_EXIT, ID, 7, ...(route === 'create' ? [INFO] : [])],
    ]);
    expect(tapExit).toHaveBeenCalledExactlyOnceWith(ID, 7);
    expect(unbind).toHaveBeenCalledExactlyOnceWith(ID);
    expect(off.data).toHaveBeenCalledTimes(1);
    expect(off.exit).toHaveBeenCalledTimes(1);
    expect(state.data.size).toBe(0);
    expect(state.exit.size).toBe(0);
    if (route === 'create') {
      expect(off.size).toHaveBeenCalledTimes(1);
      expect(off.resync).toHaveBeenCalledTimes(1);
      expect(state.sizeCbs.size).toBe(0);
      expect(state.resync.size).toBe(0);
    }
    vi.runAllTimers();
    expect(events).toHaveLength(3);
  });
});
