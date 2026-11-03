import { describe, expect, it, vi } from 'vitest';
import { Hub } from '../src/hub';
import { Registry } from '../src/registry';
import { FakeConn, fakeSpawner, ManualTimers, waitFor } from './helpers';
import type { EridaniBinding } from '../../src/shared/remote-host-protocol';

const binding: EridaniBinding = {
  runId: 'run-managed', generation: 1, attempt: 1, taskId: 'task-managed', target: 'repo',
  harness: 'codex', model: 'gpt-6.1-sol', execution: 'managed', controller: 'eridani',
  worktree: '/tmp/work', branch: 'task/managed', base: 'main', baseSha: null, spawnOp: 'spawn-managed',
};

function setup() {
  const registry = Registry.load({ file: null, bootId: 'boot-managed' });
  const native = fakeSpawner(), managed = fakeSpawner();
  const hub = new Hub({ registry, spawn: native.spawn, bootId: 'boot-managed', serverId: 'host-managed', timers: new ManualTimers() });
  const owner = new FakeConn(1);
  hub.connect(owner);
  hub.handle(owner, { t: 'hello', proto: 1, device: { id: 'device-owner', name: 'Owner' }, app: { name: 'test', version: '1' } });
  return { registry, native, managed, hub, owner };
}

describe('managed sessions in the desktop hub', () => {
  it('uses the managed transcript while keeping ordinary terminals native', async () => {
    const { hub, owner, managed, native } = setup();
    hub.setEridani({ spawn: (record, request) => record.id === 'surf-managed' ? managed.spawn(request) : undefined });
    hub.handle(owner, { t: 'open', id: 'surf-managed', rid: 1, cols: 80, rows: 24, create: {} });
    hub.handle(owner, { t: 'open', id: 'surf-shell', rid: 2, cols: 80, rows: 24, create: {} });
    expect(managed.ptys).toHaveLength(1);
    expect(native.ptys).toHaveLength(1);
    managed.last().emit('Reading files…\r\n');
    hub.sessions.get('surf-managed')!.flush();
    await waitFor(() => owner.outputs('surf-managed').some(output => output.data.includes('Reading files')));
  });

  it('blocks raw terminal input until explicit takeover, and does not claim success early', async () => {
    const { hub, owner, registry, managed } = setup();
    let finish!: () => void;
    const completed = new Promise<void>(resolve => { finish = resolve; });
    const takeover = vi.fn(async () => {
      await completed;
      registry.updateSession('surf-managed', { eridani: { ...binding, controller: 'terminal' } });
      return { ok: true };
    });
    hub.setEridani({ spawn: (_, request) => managed.spawn(request), takeover });
    hub.handle(owner, { t: 'open', id: 'surf-managed', rid: 1, cols: 80, rows: 24, create: {} });
    registry.updateSession('surf-managed', { eridani: binding });
    hub.handleInput(owner, 'surf-managed', 'dangerous input\r');
    hub.handle(owner, { t: 'deliver', id: 'surf-managed', commands: ['also blocked'] });
    expect(managed.last().written).toEqual([]);
    hub.handle(owner, { t: 'takeover', id: 'surf-managed', rid: 2 });
    expect(takeover).toHaveBeenCalledExactlyOnceWith('surf-managed');
    expect(owner.json('ack')).toEqual([]);
    hub.handleInput(owner, 'surf-managed', 'still blocked\r');
    expect(managed.last().written).toEqual([]);
    finish();
    await waitFor(() => owner.json('ack').length === 1);
    expect(owner.json('ack')[0]).toMatchObject({ rid: 2, ok: true });
    hub.handleInput(owner, 'surf-managed', 'now native\r');
    expect(managed.last().written).toContain('now native\r');
    hub.handle(owner, { t: 'takeover', id: 'surf-managed', rid: 3 });
    expect(takeover).toHaveBeenCalledTimes(1);
  });

  it('refuses hidden or ordinary sessions and surfaces a failed handoff', async () => {
    const { hub, owner, registry, native } = setup();
    const takeover = vi.fn(async () => { throw new Error('managed process did not stop'); });
    hub.setEridani({ takeover });
    hub.handle(owner, { t: 'open', id: 'surf-managed', rid: 1, cols: 80, rows: 24, create: {} });
    hub.handle(owner, { t: 'takeover', id: 'surf-managed', rid: 2 });
    expect(takeover).not.toHaveBeenCalled();
    registry.updateSession('surf-managed', { eridani: binding, hiddenBy: ['device-owner'] });
    hub.handle(owner, { t: 'takeover', id: 'surf-managed', rid: 3 });
    expect(takeover).not.toHaveBeenCalled();
    registry.updateSession('surf-managed', { hiddenBy: [] });
    hub.handle(owner, { t: 'takeover', id: 'surf-managed', rid: 4 });
    await waitFor(() => owner.json('ack').length === 3);
    expect(owner.json('ack').at(-1)).toMatchObject({ rid: 4, ok: false, error: 'managed process did not stop' });
    expect(native.ptys).toHaveLength(1);
    expect(registry.session('surf-managed')!.eridani!.controller).toBe('eridani');
  });
});
