import { describe, expect, it } from 'vitest';
import { Hub } from '../src/hub';
import { Registry } from '../src/registry';
import { FakeConn, fakeSpawner, ManualTimers, waitFor } from './helpers';
import type { ClientMsg } from '../../src/shared/remote-host-protocol';

const DEV_A = 'device-aaaaaaaa';
const DEV_B = 'device-bbbbbbbb';

function setup(registry = Registry.load({ file: null, bootId: 'boot-1' }), bootId = 'boot-1') {
  const sp = fakeSpawner();
  const timers = new ManualTimers();
  const hub = new Hub({ registry, spawn: sp.spawn, bootId, serverId: 'srv-1', hostname: 'desk', timers, probe: () => ({}) });
  let nextId = 1;
  const connect = (device: string) => {
    const c = new FakeConn(nextId++);
    hub.connect(c);
    hub.handle(c, { t: 'hello', proto: 1, device: { id: device, name: device }, app: { name: 'test', version: '0' } });
    return c;
  };
  return { hub, sp, registry, connect, timers };
}

const send = (hub: Hub, c: FakeConn, m: ClientMsg) => hub.handle(c, m);

describe('Hub', () => {
  it('rejects everything before hello', () => {
    const { hub } = setup();
    const c = new FakeConn(99);
    hub.connect(c);
    hub.handle(c, { t: 'ping', n: 1 });
    expect(c.json('error')[0].code).toBe('no-hello');
    expect(c.closed?.code).toBe(4002);
  });

  it('welcome carries the registry; incompatible protocol is refused', () => {
    const { hub, connect } = setup();
    const a = connect(DEV_A);
    expect(a.json('welcome')[0]).toMatchObject({ bootId: 'boot-1', serverId: 'srv-1', you: DEV_A, sessions: [] });
    // Apps tell the user to upgrade a host whose welcome lacks this.
    expect(a.json('welcome')[0].features).toContain('remoteaNames');
    const bad = new FakeConn(50);
    hub.connect(bad);
    hub.handle(bad, { t: 'hello', proto: 999, device: { id: DEV_B, name: 'b' }, app: { name: 't', version: '0' } });
    expect(bad.json('error')[0].code).toBe('incompatible');
  });

  it('create spawns once, broadcasts to every device, and a second device attaches to the same process', async () => {
    const { hub, sp, connect } = setup();
    const a = connect(DEV_A);
    const b = connect(DEV_B);
    send(hub, a, { t: 'open', rid: 1, id: 'surf-1', cols: 80, rows: 24, create: { cwd: '/tmp', groupId: 'grp-w', group: { name: 'Work' } } });
    expect(sp.ptys).toHaveLength(1);
    expect(a.json('opened')[0]).toMatchObject({ rid: 1, mode: 'fresh', created: true, owner: true });
    expect(b.json('groupUpserted')[0].group).toMatchObject({ id: 'grp-w', name: 'Work' });
    expect(b.json('sessionAdded')[0].session).toMatchObject({ id: 'surf-1', groupId: 'grp-w', createdBy: DEV_A });
    // B places it and attaches; an "accidental" create from B must not spawn again.
    send(hub, b, { t: 'open', rid: 7, id: 'surf-1', cols: 100, rows: 30, create: { cwd: '/tmp' } });
    expect(sp.ptys).toHaveLength(1);
    await waitFor(() => b.json('opened').length > 0);
    expect(b.json('opened')[0]).toMatchObject({ rid: 7, created: false, owner: false });
  });

  it('broadcasts shared names to both apps and preserves explicit resets when a terminal respawns', async () => {
    const { hub, connect, registry } = setup();
    const a = connect(DEV_A);
    const b = connect(DEV_B);
    send(hub, a, { t: 'open', rid: 1, id: 'surf-1', cols: 80, rows: 24, create: { groupId: 'grp-w', group: { name: 'Work' } } });
    send(hub, a, { t: 'groupUpsert', rid: 2, group: { id: 'grp-w', name: 'abc' } });
    send(hub, a, { t: 'sessionUpdate', rid: 3, id: 'surf-1', title: 'andi fix' });
    for (const app of [a, b]) {
      expect(app.json('groupUpserted').at(-1)?.group.name).toBe('abc');
      expect(app.json('sessionUpdated').at(-1)?.session).toMatchObject({ title: 'andi fix', titleUpdatedAt: expect.any(Number) });
    }
    send(hub, b, { t: 'sessionUpdate', rid: 4, id: 'surf-1', title: null });
    const resetAt = registry.session('surf-1')!.titleUpdatedAt;
    await hub.shutdown();
    const restarted = setup(registry, 'boot-2');
    registry.updateSession('surf-1', { state: 'lost' });
    const c = restarted.connect(DEV_A);
    send(restarted.hub, c, { t: 'open', rid: 5, id: 'surf-1', cols: 80, rows: 24,
      create: { title: 'Stale local name', groupId: 'grp-w', group: { name: 'Stale workspace name' } } });
    await waitFor(() => c.json('opened').length > 0);
    expect(registry.session('surf-1')?.title).toBeUndefined();
    expect(registry.session('surf-1')?.titleUpdatedAt).toBe(resetAt);
    expect(registry.groups().find(g => g.id === 'grp-w')?.name).toBe('abc');
    await restarted.hub.shutdown();
  });

  it('input claims the size; a non-owner resize is only remembered', () => {
    const { hub, sp, connect } = setup();
    const a = connect(DEV_A);
    const b = connect(DEV_B);
    send(hub, a, { t: 'open', rid: 1, id: 'surf-1', cols: 80, rows: 24, create: {} });
    send(hub, b, { t: 'open', rid: 2, id: 'surf-1', cols: 120, rows: 40 });
    send(hub, b, { t: 'resize', id: 'surf-1', cols: 130, rows: 40 });
    expect(sp.last().size).toEqual([80, 24]);
    hub.handleInput(b, 'surf-1', 'ls\r');
    expect(sp.last().size).toEqual([130, 40]);
    expect(sp.last().written).toContain('ls\r');
    expect(a.json('size').at(-1)).toMatchObject({ cols: 130, rows: 40, owner: false });
    send(hub, a, { t: 'claim', id: 'surf-1' });
    expect(sp.last().size).toEqual([80, 24]);
  });

  it('close is idempotent across devices racing each other, and tombstones block re-creation', () => {
    const { hub, sp, connect } = setup();
    const a = connect(DEV_A);
    const b = connect(DEV_B);
    send(hub, a, { t: 'open', rid: 1, id: 'surf-1', cols: 80, rows: 24, create: {} });
    send(hub, a, { t: 'close', rid: 2, id: 'surf-1' });
    send(hub, b, { t: 'close', rid: 3, id: 'surf-1' });
    expect(a.json('ack').map((x) => x.ok)).toEqual([true]);
    expect(b.json('ack').map((x) => x.ok)).toEqual([true]);
    expect(b.json('sessionClosed')).toHaveLength(1);
    expect(sp.last().killed.length).toBeGreaterThan(0);
    send(hub, b, { t: 'open', rid: 4, id: 'surf-1', cols: 80, rows: 24, create: {} });
    expect(b.json('openError')[0]).toMatchObject({ code: 'closed', by: DEV_A });
    expect(sp.ptys).toHaveLength(1);
  });

  it('a group close kills its sessions everywhere', () => {
    const { hub, sp, connect } = setup();
    const a = connect(DEV_A);
    const b = connect(DEV_B);
    send(hub, a, { t: 'open', rid: 1, id: 'surf-1', cols: 80, rows: 24, create: { groupId: 'grp-w', group: { name: 'W' } } });
    send(hub, a, { t: 'open', rid: 2, id: 'surf-2', cols: 80, rows: 24, create: { groupId: 'grp-w', group: { name: 'W' } } });
    send(hub, b, { t: 'groupClose', rid: 3, id: 'grp-w' });
    expect(a.json('groupClosed')[0]).toMatchObject({ id: 'grp-w', by: DEV_B });
    expect(a.json('groupClosed')[0].sessionIds.sort()).toEqual(['surf-1', 'surf-2']);
    expect(sp.ptys.every((p) => p.killed.length > 0)).toBe(true);
    expect(hub.sessions.size).toBe(0);
  });

  it('hide detaches only the hiding device and refuses its re-open until unhidden', async () => {
    const { hub, sp, connect } = setup();
    const a = connect(DEV_A);
    const b = connect(DEV_B);
    send(hub, a, { t: 'open', rid: 1, id: 'surf-1', cols: 80, rows: 24, create: {} });
    send(hub, b, { t: 'open', rid: 2, id: 'surf-1', cols: 80, rows: 24 });
    await waitFor(() => b.json('opened').length > 0);
    send(hub, b, { t: 'hide', rid: 3, id: 'surf-1' });
    expect(a.json('sessionUpdated').at(-1)!.session.hiddenBy).toEqual([DEV_B]);
    a.clear();
    b.clear();
    sp.last().emit('hello\r\n');
    hub.sessions.get('surf-1')!.flush();
    expect(a.outputs()).toHaveLength(1);
    expect(b.outputs()).toHaveLength(0);
    send(hub, b, { t: 'open', rid: 4, id: 'surf-1', cols: 80, rows: 24 });
    expect(b.json('openError')[0].code).toBe('hidden');
    send(hub, b, { t: 'unhide', rid: 5, id: 'surf-1' });
    send(hub, b, { t: 'open', rid: 6, id: 'surf-1', cols: 80, rows: 24 });
    await waitFor(() => b.json('opened').length > 0);
    expect(b.json('opened')).toHaveLength(1);
  });

  it('a process exiting on its own is reported to everyone and the session stays until closed', async () => {
    const { hub, sp, connect, registry } = setup();
    const a = connect(DEV_A);
    const b = connect(DEV_B);
    send(hub, a, { t: 'open', rid: 1, id: 'surf-1', cols: 80, rows: 24, create: {} });
    sp.last().exit(3);
    expect(a.json('exit')[0]).toMatchObject({ id: 'surf-1', code: 3 });
    expect(b.json('sessionUpdated').at(-1)!.session).toMatchObject({ state: 'exited', exitCode: 3 });
    expect(registry.session('surf-1')?.state).toBe('exited');
    send(hub, b, { t: 'open', rid: 2, id: 'surf-1', cols: 80, rows: 24 });
    await waitFor(() => b.json('opened').length > 0);
    expect(b.json('opened')[0]).toMatchObject({ state: 'exited', exitCode: 3 });
  });

  it('after a server restart, sessions are lost (not closed) and respawn once with their resume info', async () => {
    const first = setup(Registry.load({ file: null, bootId: 'boot-1' }));
    const a1 = first.connect(DEV_A);
    send(first.hub, a1, { t: 'open', rid: 1, id: 'surf-1', cols: 80, rows: 24, create: { cwd: '/proj', groupId: 'grp-w', group: { name: 'W' } } });
    first.registry.updateSession('surf-1', { agent: { provider: 'claude', sessionId: '11111111-2222-3333-4444-555555555555', seenAt: 1 } });
    first.hub.shutdown();
    expect(first.registry.session('surf-1')?.state).toBe('live');

    // Same registry data, new boot.
    const reloaded = Registry.load({ file: null, bootId: 'boot-2' });
    Object.assign(reloaded.data, JSON.parse(JSON.stringify(first.registry.data)));
    for (const s of Object.values(reloaded.data.sessions)) if (s.bootId !== 'boot-2' && s.state === 'live') s.state = 'lost';
    const second = setup(reloaded, 'boot-2');
    const a = second.connect(DEV_A);
    const b = second.connect(DEV_B);
    expect(a.json('welcome')[0].sessions[0]).toMatchObject({ id: 'surf-1', state: 'lost' });
    send(second.hub, a, { t: 'probe', rid: 1, ids: ['surf-1', 'surf-gone'] });
    expect(a.json('probed')[0].status).toEqual({ 'surf-1': 'lost', 'surf-gone': 'unknown' });
    expect(a.json('probed')[0].last['surf-1'].agent?.sessionId).toBe('11111111-2222-3333-4444-555555555555');
    send(second.hub, a, { t: 'open', rid: 2, id: 'surf-1', cols: 80, rows: 24 });
    expect(a.json('openError')[0].code).toBe('lost');
    send(second.hub, a, { t: 'open', rid: 3, id: 'surf-1', cols: 80, rows: 24, create: { startupCommands: ['claude --resume 11111111-2222-3333-4444-555555555555'] } });
    send(second.hub, b, { t: 'open', rid: 4, id: 'surf-1', cols: 80, rows: 24, create: { startupCommands: ['claude --resume x'] } });
    expect(second.sp.ptys).toHaveLength(1);
    expect(second.sp.last().req.cwd).toBe('/proj');
    // The server resumes the agent it last saw rather than the client's commands.
    second.timers.advance(6000);
    expect(second.sp.last().written.join('')).toContain('claude --resume 11111111-2222-3333-4444-555555555555\r');
    expect(second.sp.last().written.join('')).not.toContain('claude --resume x');
    expect(a.json('opened')[0]).toMatchObject({ wasLost: true, mode: 'fresh' });
    await waitFor(() => b.json('opened').length > 0);
    expect(b.json('opened')[0]).toMatchObject({ created: false });
    expect(b.json('sessionUpdated').at(-1)!.session).toMatchObject({ state: 'live', groupId: 'grp-w' });
  });

  it('disconnect is a detach: the process keeps running', () => {
    const { hub, sp, connect } = setup();
    const a = connect(DEV_A);
    send(hub, a, { t: 'open', rid: 1, id: 'surf-1', cols: 80, rows: 24, create: {} });
    hub.disconnect(a);
    expect(sp.last().killed).toEqual([]);
    expect(hub.sessions.get('surf-1')?.attachedCount).toBe(0);
  });

  it('meta from the /proc probe is published and persisted', () => {
    const registry = Registry.load({ file: null, bootId: 'boot-1' });
    const sp = fakeSpawner();
    const hub = new Hub({
      registry, spawn: sp.spawn, bootId: 'boot-1', serverId: 's', timers: new ManualTimers(),
      probe: () => ({ cwd: '/work', fg: 'claude', agent: { provider: 'claude', sessionId: 'abc', seenAt: 5 } }),
    });
    const a = new FakeConn(1);
    hub.connect(a);
    hub.handle(a, { t: 'hello', proto: 1, device: { id: DEV_A, name: 'a' }, app: { name: 't', version: '0' } });
    hub.handle(a, { t: 'open', rid: 1, id: 'surf-1', cols: 80, rows: 24, create: {} });
    hub.probeAgents();
    hub.probeAgents();
    expect(a.json('meta')).toHaveLength(1);
    expect(a.json('meta')[0]).toMatchObject({ cwd: '/work', fg: 'claude', agent: { sessionId: 'abc' } });
    expect(registry.session('surf-1')).toMatchObject({ lastCwd: '/work', agent: { sessionId: 'abc' } });
  });
});
