import { describe, expect, it } from 'vitest';
import type { SessionRecord } from '../../src/shared/remote-host-protocol';
import { parseClientMsg } from '../../src/shared/remote-host-protocol';
import { GlassfaceInput, promptIdentity, type GlassfaceRequest, type GlassfaceTarget } from '../src/glassface-input';
import { Hub } from '../src/hub';
import { Registry } from '../src/registry';
import { FakeConn, fakeSpawner } from './helpers';

function fixture(ack: string | null = 'received') {
  let sends = 0;
  let draft = '';
  const service = new GlassfaceInput(async () => { sends++; return ack; });
  const record = {id:'surf-test', state:'live', bootId:'boot', incarnation:1,
    agent:{provider:'codex',sessionId:'thread'}} as SessionRecord;
  const target: GlassfaceTarget = {record, nativeQueue:{pid:100, executable:'/fixture', fileKey:'file'},
    session:{pid:99, state:'live', inputRevision:0, async composerScreen() {
      return {lines:['› '+draft,'GPT-6.2-Sol high · ~/repo'], bracketed:true, cursorRow:0, suggestionRow:null};
    }, write() { throw Error('Addressed input must never write shell keystrokes'); }}};
  const msg: GlassfaceRequest = {t:'glassfaceInput', rid:1, id:record.id, bootId:'boot', incarnation:1,
    provider:'codex', conversation:'thread', operationId:'test-operation', text:'Read the task.',
    expectedPrompt:promptIdentity(record,0)};
  const send = (candidate: GlassfaceRequest = msg) =>
    service.send(candidate, 'boot', () => true, () => target, () => false, () => {});
  return {target, msg, send, service, sends:() => sends, draft:(s:string) => {draft=s;}};
}

describe('addressed agent message', () => {
  it('spends the reviewed prompt exactly once and returns the same provider receipt', async () => {
    const f = fixture();
    expect(await f.send()).toBe('queued');
    expect(await f.send()).toBe('queued');
    expect(f.service.providerReceipt(f.msg.operationId)).toBe('received');
    expect(await f.send({...f.msg, text:'changed'})).toBe('refused');
    expect(await f.send({...f.msg, operationId:'different-op'})).toBe('refused');
    expect(f.sends()).toBe(1);
  });

  it('never retries an ambiguous provider acceptance or falls back to the PTY', async () => {
    const f = fixture(null);
    expect(await f.send()).toBe('uncertain');
    expect(await f.send()).toBe('uncertain');
    expect(f.sends()).toBe(1);
  });

  it('refuses desktop drafts, new owners, and managed panes before dispatch', async () => {
    for (const change of ['draft','owner','managed','thread','unverified question']) {
      const f = fixture();
      let msg = f.msg;
      if (change === 'draft') f.draft('unfinished desktop typing');
      if (change === 'owner') {
        const screen = f.target.session.composerScreen.bind(f.target.session);
        f.target.session.composerScreen = async () => { f.target.nativeQueue = {...f.target.nativeQueue!, pid:101}; return screen(); };
      }
      if (change === 'managed') f.target.record.eridani = {} as SessionRecord['eridani'];
      if (change === 'thread') f.target.record.agent = {...f.target.record.agent!, sessionId:'different-thread'};
      if (change === 'unverified question') msg = {...msg, t:'glassfaceDaniInput', turn:'old-question'};
      expect(await f.send(msg)).toBe('refused');
      expect(f.sends()).toBe(0);
    }
  });

  it('offers the generic target only to the subscribed desktop or the configured Glass', async () => {
    const registry = Registry.load({file:null,bootId:'boot'});
    const hub = new Hub({registry,spawn:fakeSpawner().spawn,bootId:'boot',serverId:'proof',
      glassfaceDeviceId:'actual-glass',glassfaceSharedGroups:true,glassfaceForeground:() => true});
    function connect(id:number, device:string, app:string) {
      const c = new FakeConn(id); hub.connect(c);
      hub.handle(c,{t:'hello',proto:1,device:{id:device,name:device},app:{name:app,version:'1'}}); return c;
    }
    try {
      const desk = connect(1,'desktop','remotea');
      const glass = connect(2,'actual-glass','googleglass');
      const other = connect(3,'another-desktop','remotea');
      const impostor = connect(4,'another-glass','googleglass');
      const id = 'surf-proof';
      const query = {t:'agentMessageTarget' as const, id, rid:1} as const;
      hub.handle(desk,{t:'open',id,rid:1,cols:80,rows:24,create:{}});
      hub.handle(impostor,{t:'open',id,rid:1,cols:80,rows:24});
      registry.updateSession(id,{agent:{provider:'claude',sessionId:'thread',seenAt:1}});
      for (const conn of [desk,glass,other,impostor]) hub.handle(conn,query);
      expect(desk.json('agentMessageTargetResult')[0].target?.conversation).toBe('thread');
      expect(glass.json('agentMessageTargetResult')[0].target?.conversation).toBe('thread');
      expect(other.json('agentMessageTargetResult')[0].target).toBeNull();
      expect(impostor.json('agentMessageTargetResult')[0].target).toBeNull();
      expect(parseClientMsg({...fixture().msg,t:'agentMessage',turn:'junk'})).toBeNull();
      expect(parseClientMsg({...fixture().msg,t:'agentMessage'})).toBeTruthy();
    } finally { await hub.shutdown(); }
  });
});
