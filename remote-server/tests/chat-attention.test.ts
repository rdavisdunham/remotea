import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatAttentionService } from '../src/chat-attention';
import { Registry } from '../src/registry';
import { Hub } from '../src/hub';
import { FakeConn, fakeSpawner, ManualTimers } from './helpers';
import { parseClientMsg, type AgentStateInfo } from '../../src/shared/remote-host-protocol';

const id = 'surf-chat';
const device = 'device-aaaaaaaa';
const dirs: string[] = [];
afterEach(() => { dirs.splice(0).forEach(d => fs.rmSync(d, { recursive: true, force: true })); vi.restoreAllMocks(); });
function setup(file: string | null = null) {
  let time = 1000;
  const now = () => time;
  const registry = Registry.load({ file, bootId: 'boot', now });
  registry.addSession({ id, groupId: null, cwd: '/tmp', createdAt: time, createdBy: device, bootId: 'boot', state: 'live', hiddenBy: [] });
  const publish = vi.fn();
  const service = new ChatAttentionService(registry, publish, now);
  const state = (name: AgentStateInfo['state']) => {
    const rec = registry.session(id)!;
    const info = { state: name, since: ++time };
    service.stateChanged(rec, info);
    registry.updateSession(id, { agentState: info });
  };
  return { registry, publish, service, state, advance: (ms: number) => { time += ms; }, now };
}

describe('durable chat attention', () => {
  it('makes completed replies unread once, without treating startup idle as completion', () => {
    const { registry, service, state } = setup();
    state('idle');
    expect(registry.session(id)!.chatAttention).toBeUndefined();
    state('working'); state('idle');
    expect(registry.session(id)!.chatAttention).toMatchObject({ revision: 1, kind: 'finished', seenBy: {} });
    service.apply(id, device, { action: 'read', revision: 1 });
    state('idle');
    expect(registry.session(id)!.chatAttention?.seenBy[device]).toBe(1);
    state('working'); state('idle');
    expect(registry.session(id)!.chatAttention).toMatchObject({ revision: 2, seenBy: {} });
  });

  it('keeps waiting-for-input separate from read state, and rejects stale acknowledgements', () => {
    const { registry, service, state } = setup();
    state('working'); state('needs_you');
    service.apply(id, device, { action: 'read', revision: 1 });
    expect(registry.session(id)!.agentState?.state).toBe('needs_you');
    state('working'); state('idle');
    service.apply(id, device, { action: 'read', revision: 1 });
    expect(registry.session(id)!.chatAttention?.seenBy[device]).toBeUndefined();
  });

  it('does not mistake answering a question for a finished reply', () => {
    const { registry, state } = setup();
    state('needs_you'); state('idle');
    expect(registry.session(id)!.chatAttention).toMatchObject({ revision: 1, kind: 'needs_you' });
  });

  it('marks read and unread per device without clearing another device', () => {
    const { registry, service, state } = setup();
    state('working'); state('idle');
    service.apply(id, device, { action: 'read', revision: 1 });
    service.apply(id, 'device-bbbbbbbb', { action: 'read', revision: 1 });
    service.apply(id, device, { action: 'unread' });
    expect(registry.session(id)!.chatAttention?.seenBy).toEqual({ 'device-bbbbbbbb': 1 });
    expect(registry.session(id)!.agentState?.state).toBe('idle');
  });

  it('fires exactly once without any app connected, retaining notes and reconnect state', () => {
    const { registry, service, publish, advance, state, now } = setup();
    state('working');
    expect(service.apply(id, device, { action: 'remind', dueAt: now() + 5000, note: 'Review the results' }).ok).toBe(true);
    publish.mockClear(); service.tick(); expect(publish).not.toHaveBeenCalled();
    advance(5000); service.tick(); service.tick();
    expect(publish).toHaveBeenCalledTimes(1);
    expect(registry.session(id)).toMatchObject({ agentState: { state: 'working' }, chatReminder: { firedAt: now(), note: 'Review the results' }, chatAttention: { kind: 'reminder', revision: 1 } });
  });

  it('persists future reminders and fires overdue reminders once after restart', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-attention-')); dirs.push(dir);
    const file = path.join(dir, 'registry.json');
    const { service, now, advance } = setup(file);
    service.apply(id, device, { action: 'remind', dueAt: now() + 3000 });
    const restored = Registry.load({ file, bootId: 'next', now });
    const publish = vi.fn(); const restarted = new ChatAttentionService(restored, publish, now);
    restarted.tick(); expect(publish).not.toHaveBeenCalled();
    advance(6000); restarted.tick(); expect(publish).toHaveBeenCalledTimes(1);
    const again = Registry.load({ file, bootId: 'again', now });
    new ChatAttentionService(again, publish, now).tick(); expect(publish).toHaveBeenCalledTimes(1);
    expect(again.session(id)!.chatAttention?.kind).toBe('reminder');
    restored.saveNow(); again.saveNow();
  });

  it('replaces/cancels a reminder and never resurrects a closed chat', () => {
    const { service, registry, advance, now, publish } = setup();
    service.apply(id, device, { action: 'remind', dueAt: now() + 100 });
    service.apply(id, device, { action: 'remind', dueAt: now() + 200 });
    advance(100); service.tick(); expect(registry.session(id)!.chatReminder?.firedAt).toBeUndefined();
    service.apply(id, device, { action: 'cancelReminder' });
    advance(100); service.tick(); expect(registry.session(id)!.chatAttention).toBeUndefined();
    service.apply(id, device, { action: 'remind', dueAt: now() + 100 });
    registry.closeSession(id, device); publish.mockClear(); advance(100); service.tick();
    expect(publish).not.toHaveBeenCalled();
    expect(service.apply(id, device, { action: 'unread' }).ok).toBe(false);
  });

  it('does not prune an exited chat while its reminder is pending', () => {
    const { registry, service, now, advance } = setup();
    registry.updateSession(id, { state: 'exited', exitedAt: now() });
    service.apply(id, device, { action: 'remind', dueAt: now() + 10 * 86400000 });
    advance(8 * 86400000); registry.prune(); expect(registry.session(id)).toBeDefined();
    advance(2 * 86400000); service.tick(); registry.prune(); expect(registry.session(id)).toBeDefined();
    service.apply(id, device, { action: 'read', revision: registry.session(id)!.chatAttention!.revision });
    registry.prune(); expect(registry.session(id)).toBeUndefined();
  });

  it('does not acknowledge or lose reminders when persistence fails', () => {
    const { registry, service, now, advance, publish } = setup();
    service.apply(id, device, { action: 'remind', dueAt: now() + 100 });
    const save = vi.spyOn(registry, 'saveNow').mockImplementation(() => { throw new Error('disk full'); });
    expect(service.apply(id, device, { action: 'cancelReminder' }).ok).toBe(false);
    publish.mockClear(); advance(100); service.tick();
    expect(registry.session(id)!.chatReminder?.firedAt).toBeUndefined();
    expect(publish).not.toHaveBeenCalled();
    save.mockRestore(); service.tick(); expect(publish).toHaveBeenCalledTimes(1);
  });

  it('validates reminder requests and refuses hidden sessions', () => {
    const { registry, service, now } = setup();
    expect(service.apply(id, device, { action: 'remind', dueAt: now() }).ok).toBe(false);
    expect(service.apply(id, device, { action: 'remind', dueAt: now() + 400 * 86400000 }).ok).toBe(false);
    registry.setHidden(id, device, true);
    expect(service.apply(id, device, { action: 'unread' }).ok).toBe(false);
    for (const patch of [{ action: 'read', revision: -1 }, { action: 'remind', dueAt: NaN }, { action: 'remind', dueAt: 1234, note: 'x'.repeat(301) }, { action: 'oops' }]) {
      expect(parseClientMsg({ t: 'chatAttention', rid: 1, id, ...patch })).toBeNull();
    }
    expect(parseClientMsg({ t: 'chatAttention', rid: 1, id, action: 'remind', dueAt: 5000 })).not.toBeNull();
  });

  it('wires hooks, commands and reconnect snapshots through the real Hub without terminal input', () => {
    const sp = fakeSpawner(); const timers = new ManualTimers();
    const registry = Registry.load({ file: null, bootId: 'boot' });
    const hub = new Hub({ registry, spawn: sp.spawn, bootId: 'boot', serverId: 'server', hostname: 'desk', timers, probe: () => ({}) });
    const c = new FakeConn(1); hub.connect(c);
    hub.handle(c, { t: 'hello', proto: 1, device: { id: device, name: 'test' }, app: { name: 'test', version: '1' } });
    expect(c.json('welcome')[0].features).toContain('chatAttention');
    hub.handle(c, { t: 'open', rid: 1, id, cols: 80, rows: 24, create: {} });
    hub.agentState.hook(id, { event: 'UserPromptSubmit' });
    hub.agentState.hook(id, { event: 'Stop' });
    expect(registry.session(id)!.chatAttention?.kind).toBe('finished');
    hub.handle(c, { t: 'chatAttention', id, rid: 2, action: 'remind', dueAt: Date.now() + 60000 });
    expect(c.json('ack').at(-1)).toMatchObject({ rid: 2, ok: true });
    expect(sp.last().written).toEqual([]);
    const b = new FakeConn(2); hub.connect(b);
    hub.handle(b, { t: 'hello', proto: 1, device: { id: 'device-bbbbbbbb', name: 'other' }, app: { name: 'test', version: '1' } });
    expect(b.json('welcome')[0].sessions[0]).toMatchObject({ chatAttention: { kind: 'finished' }, chatReminder: { dueAt: expect.any(Number) } });
  });
});
