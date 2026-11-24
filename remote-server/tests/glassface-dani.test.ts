import { afterEach, describe, expect, it } from 'vitest';
import { parseClientMsg } from '../../src/shared/remote-host-protocol';
import { promptIdentity } from '../src/glassface-input';
import { Hub } from '../src/hub';
import { Registry } from '../src/registry';
import { FakeConn, fakeSpawner, ManualTimers, waitFor } from './helpers';

const surf = 'surf-glass', group = 'grp-glass', conversation = 'claude-root-one';
const clean = '❯\u00a0';
const endpoints: Hub[] = [];
afterEach(async () => { for (const h of endpoints.splice(0)) await h.shutdown(); });

function fixture(sharedGroups = false) {
  const registry = Registry.load({ file: null, bootId: 'boot' });
  const sp = fakeSpawner();
  let foreground = true;
  let id = 0;
  let now = 100;
  const hub = new Hub({ registry, spawn: sp.spawn, serverId: 'srv', bootId: 'boot',
    now: () => now, timers: new ManualTimers(), glassfaceDeviceId: 'glassface-gw',
    glassfaceGroupId: sharedGroups ? undefined : group, glassfaceSharedGroups: sharedGroups, glassfaceForeground: () => foreground });
  endpoints.push(hub);
  function login(device = 'glassface-gw', app = 'googleglass') {
    const conn = new FakeConn(++id);
    hub.connect(conn);
    hub.handle(conn, { t: 'hello', proto: 1, device: { id: device, name: 'test' }, app: { name: app, version: '1' } });
    return conn;
  }
  const desktop = login('desktop', 'remotea');
  hub.handle(desktop, { t: 'open', rid: 1, id: surf, cols: 80, rows: 24, create: {} });
  registry.updateSession(surf, { groupId: group, agent: { provider: 'claude', sessionId: conversation, seenAt: now } });
  function hook(event: string, extra = {}) {
    hub.relayRpc(surf, 'hook.event', { at: ++now, sessionId: conversation, event, ...extra });
  }
  function finish(reply = 'Tests pass. Should I retry in ten seconds?', extra = {}) {
    hook('UserPromptSubmit', { prompt: 'Implement reconnect and run the tests.' });
    hook('Stop', { lastAssistantMessage: reply, ...extra });
  }
  function stamp(conn = login()) {
    return conn.json('welcome')[0].sessions.find(r => r.id === surf)?.glassfaceDaniTurn;
  }
  function read(conn: FakeConn, turn: string) {
    hub.handle(conn, { t: 'glassfaceDaniRead', rid: 2, id: surf, turn });
    return conn.json('glassfaceDaniReadResult').at(-1)!.turn;
  }
  const session = hub.sessions.get(surf)!;
  const pty = sp.last();
  function draw(content: string) {
    const rule = '─'.repeat(73);
    pty.emit('\x1b[?2004h\x1b[2J\x1b[H' + rule + '\r\n' + clean + content + '\r\n' +
      rule + '\r\n? for shortcuts\x1b[2;3H');
    session.flush();
  }
  function frame(turn: string) {
    const rec = registry.session(surf)!;
    return { t: 'glassfaceDaniInput' as const, rid: 3, id: surf, bootId: 'boot', incarnation: rec.incarnation!,
      provider: 'claude' as const, conversation, expectedPrompt: promptIdentity(rec, session.inputRevision),
      operationId: 'glass-action-one', text: 'Retry once after ten seconds.', turn };
  }
  return { registry, hub, desktop, login, hook, finish, stamp, read, draw, pty, frame,
    setForeground(value: boolean) { foreground = value; } };
}

describe('Dani on a paired Glass', () => {
  it('binds redacted task, reply and question to one completed root turn on the visible native agent', () => {
    const f = fixture();
    f.finish();
    const glass = f.login(), stamp = f.stamp(glass)!;
    expect(glass.json('welcome')[0].features).toContain('glassfaceDani');
    expect(stamp.kind).toBe('question');
    expect(f.read(glass, stamp.id)).toEqual({ ...stamp, task: 'Implement reconnect and run the tests.',
      reply: 'Tests pass. Should I retry in ten seconds?', question: 'Should I retry in ten seconds?' });
    for (const other of [f.login('other-gw'), f.login('glassface-gw', 'desktop')]) {
      expect(f.stamp(other)).toBeUndefined();
      expect(other.json('welcome')[0].features).not.toContain('glassfaceDani');
      expect(f.read(other, stamp.id)).toBeNull();
    }
    f.setForeground(false);
    expect(f.read(glass, stamp.id)).toBeNull();
    f.setForeground(true);
    f.registry.updateSession(surf, { hiddenBy: ['glassface-gw'] });
    expect(f.read(glass, stamp.id)).toBeNull();
    f.registry.updateSession(surf, { hiddenBy: [], groupId: 'grp-elsewhere' });
    expect(f.read(glass, stamp.id)).toBeNull();
  });

  it('shares visible manual groups with the paired Glass and rechecks visibility before entering', async () => {
    const f = fixture(true);
    f.registry.updateSession(surf, { groupId: 'grp-ordinary' });
    f.finish();
    const glass = f.login();
    const welcome = glass.json('welcome')[0];
    expect(welcome.features).toContain('glassfaceSharedGroups');
    expect(welcome.sessions.find(r => r.id === surf)?.glassfaceWritable).toBe(true);
    const otherApp = f.login('glassface-gw', 'desktop');
    expect(otherApp.json('welcome')[0].features).not.toContain('glassfaceInput');
    const turn = f.stamp(glass)!.id;
    expect(f.read(glass, turn)?.kind).toBe('question');
    const req = f.frame(turn);
    f.draw('');
    f.hub.handle(glass, req);
    await waitFor(() => f.pty.written.length === 1);
    expect(f.registry.session(surf)?.lastInteractedAt).toBeGreaterThan(0);
    f.registry.updateSession(surf, { hiddenBy: ['glassface-gw'] });
    f.draw(req.text);
    await waitFor(() => glass.json('glassfaceReceipt').length > 0);
    expect(glass.json('glassfaceReceipt')[0].status).toBe('partial');
    expect(f.pty.written).toHaveLength(1);
    expect(f.login().json('welcome')[0].sessions.some(r => r.id === surf)).toBe(false);
    const close = { t:'glassfaceClose' as const, rid:4, id:surf, bootId: 'boot',
      groupId: 'grp-ordinary' as const, incarnation: req.incarnation };
    f.hub.handle(glass, close);
    expect(glass.json('ack').at(-1)?.ok).toBe(false);
    f.registry.updateSession(surf, { hiddenBy: [], eridani: { runId: 'managed' } as never });
    expect(f.read(glass, turn)).toBeNull();
    expect(f.login().json('welcome')[0].sessions.find(r => r.id === surf)?.glassfaceWritable).toBe(false);
    f.hub.handle(glass, close);
    expect(glass.json('ack').at(-1)?.ok).toBe(false);
    f.registry.updateSession(surf, { eridani: undefined });
    f.setForeground(false);
    expect(f.login().json('welcome')[0].sessions.find(r => r.id === surf)?.glassfaceWritable).toBe(false);
  });

  it('sends normal-composer text once and refuses the old turn after the direct reply', async () => {
    const f = fixture();
    f.finish();
    const conn = f.login(), turn = f.stamp(conn)!.id, req = f.frame(turn);
    expect(parseClientMsg(req)).toEqual(req);
    expect(parseClientMsg({ ...req, turn: undefined })).toBeNull();
    expect(parseClientMsg({ ...req, turn: 'forged' })).toBeNull();
    f.draw('');
    f.hub.handle(conn, req);
    await waitFor(() => f.pty.written.length === 1);
    expect(f.pty.written[0]).toContain('\x1b[200~Retry once');
    f.draw(req.text);
    await waitFor(() => conn.json('glassfaceReceipt').length > 0);
    expect(conn.json('glassfaceReceipt')[0].status).toBe('submitted');
    expect(f.pty.written[1]).toBe('\r');
    expect(f.stamp()).toBeUndefined();
    f.hub.handle(conn, req);
    await waitFor(() => conn.json('glassfaceReceipt').length === 2);
    expect(f.pty.written).toHaveLength(2);
    expect(conn.json('glassfaceReceipt')[1].status).toBe('submitted');
    f.hub.handle(conn, { ...f.frame(turn), operationId: 'another-action' });
    await waitFor(() => conn.json('glassfaceReceipt').length === 3);
    expect(conn.json('glassfaceReceipt')[2].status).toBe('refused');
  });

  it('never sends when the active question was replaced, a protected notification took over, or a composer contains edits', async () => {
    const f = fixture();
    f.finish();
    const conn = f.login(), turn = f.stamp(conn)!.id;
    f.draw('desktop draft');
    f.hub.handle(conn, f.frame(turn));
    await waitFor(() => conn.json('glassfaceReceipt').length === 1);
    expect(conn.json('glassfaceReceipt')[0].status).toBe('refused');
    f.draw('');
    f.hook('Notification', { notificationType: 'permission_prompt', message: 'Allow this action?' });
    expect(f.stamp()).toBeUndefined();
    f.hub.handle(conn, { ...f.frame(turn), operationId: 'permission-guard' });
    await waitFor(() => conn.json('glassfaceReceipt').length === 2);
    expect(conn.json('glassfaceReceipt')[1].status).toBe('refused');
    f.finish('Which branch should I use?');
    expect(f.stamp()!.id).not.toBe(turn);
    f.hub.handle(conn, { ...f.frame(turn), operationId: 'obsolete-question' });
    await waitFor(() => conn.json('glassfaceReceipt').length === 3);
    expect(conn.json('glassfaceReceipt')[2].status).toBe('refused');
    expect(f.pty.written).toEqual([]);
  });

  it('refuses a protected menu even when the registry still says idle', async () => {
    const f = fixture();
    f.finish();
    const conn = f.login(), req = f.frame(f.stamp(conn)!.id);
    f.pty.emit('\x1b[?2004h\x1b[2J\x1b[HAllow this action?\r\n❯ 1. Yes\r\n  2. No\r\nEnter to select, Esc to cancel');
    f.hub.sessions.get(surf)!.flush();
    f.hub.handle(conn, req);
    await waitFor(() => conn.json('glassfaceReceipt').length === 1);
    expect(conn.json('glassfaceReceipt')[0].status).toBe('refused');
    expect(f.pty.written).toEqual([]);
  });

  it('cannot press Enter after a different root turn lands during the echo', async () => {
    const f = fixture();
    f.finish();
    const conn = f.login(), req = f.frame(f.stamp(conn)!.id);
    f.draw('');
    f.hub.handle(conn, req);
    await waitFor(() => f.pty.written.length === 1);
    f.finish('Use another timeout?');
    f.draw(req.text);
    await waitFor(() => conn.json('glassfaceReceipt').length === 1);
    expect(conn.json('glassfaceReceipt')[0].status).toBe('partial');
    expect(f.pty.written).toHaveLength(1);
  });

  it('retains a completion for lookup, excludes partial outputs, and ignores subagent events', () => {
    const f = fixture();
    f.finish('Tests pass.');
    const plain = f.stamp()!;
    expect(plain.kind).toBe('finished');
    f.hook('Stop', { agentId: 'subagent', lastAssistantMessage: 'Subagent question?' });
    expect(f.stamp()?.id).toBe(plain.id);
    f.finish('Still going?', { backgroundTasks: '1' });
    expect(f.stamp()).toBeUndefined();
    f.finish('token=abc123456789. Done.');
    const result = f.read(f.login(), f.stamp()!.id)!;
    expect(result.kind).toBe('finished');
    expect(result.reply).toBe('[redacted] Done.');
  });
});
