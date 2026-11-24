import { describe, expect, it } from 'vitest';
import { parseClientMsg, type SessionRecord } from '../../src/shared/remote-host-protocol';
import { buildComposerWrites } from '../../src/shared/remote-input';
import { GlassfaceInput, composerShows, foregroundAgent, promptIdentity, type GlassfaceRequest } from '../src/glassface-input';
import { Hub } from '../src/hub';
import { Registry } from '../src/registry';
import { FakeConn, fakeSpawner, ManualTimers, waitFor } from './helpers';

const border = '─'.repeat(120);
const cue = '❯\u00a0';
function screen(content: string, suggestion = false) {
  return { lines: [border, cue+content, border, '  ⏵⏵ auto mode on (shift+tab to cycle)'],
    cursorRow: 1, suggestionRow: suggestion ? 1 : null, bracketed: true };
}
function fixture() {
  const service = new GlassfaceInput();
  const record = { id:'surf-one', state:'live', bootId:'boot', incarnation:3,
    agent:{provider:'claude', sessionId:'conversation'} } as SessionRecord;
  const writes: string[] = [], humans: string[] = [];
  let visible = '', isForeground = true, authorized = true;
  const session = {
    state:'live' as const, pid:100, inputRevision:9,
    async composerScreen() { return screen(visible); },
    write(data: string) { this.inputRevision++; writes.push(data); visible = data.slice(6, -6); }
  };
  const msg: GlassfaceRequest = { t:'glassfaceInput', rid:1, id:record.id, bootId:'boot', incarnation:3,
    provider:'claude', conversation:'conversation', operationId:'operation-1', text:'Read the test output.',
    expectedPrompt:promptIdentity(record,9) };
  const submit = () => service.send(msg,'boot',() => authorized, () => ({session,record}), () => isForeground, d => humans.push(d));
  return {session, record, msg, writes, humans, submit, setForeground:(v:boolean) => {isForeground=v;},
    setAuth:(v:boolean) => {authorized=v;}, setVisible:(v:string) => {visible=v;} };
}

describe('glassface guarded composer', () => {
  it('rejects malformed requests, control bytes and slash commands', async () => {
    const f=fixture();
    expect(parseClientMsg(f.msg)).toEqual(f.msg);
    expect(parseClientMsg({...f.msg, text:'a'.repeat(4001)})).toBeNull();
    expect(parseClientMsg({...f.msg, operationId:'bad/route'})).toBeNull();
    for (const text of ['a\rb','a\tb','\x1b[201~oops','/exit','!ls']) {
      f.msg.text=text; expect(await f.submit()).toBe('refused');
    }
    expect(f.writes).toEqual([]);
  });

  it('requires the active native composer, refuses a trust menu and protects typed input', () => {
    expect(composerShows('claude',screen('Try "a task"', true),'')).toBe(true);
    expect(composerShows('claude',screen('Try "a task"'),'')).toBe(false);
    expect(composerShows('claude',{...screen(''),cursorRow:3},'')).toBe(false);
    expect(composerShows('claude',{...screen(''),lines:['Trust folder?','❯ No, exit','Yes, I trust this folder','Enter to confirm']},'')).toBe(false);
    expect(composerShows('claude',{...screen(''),lines:[border,cue,border,'Enter to confirm · Esc to cancel']},'')).toBe(false);
    expect(composerShows('claude',screen('different draft'),'Read the test output.')).toBe(false);
    expect(foregroundAgent(process.pid, 'claude', 'conversation')).toBe(false);
  });

  it('writes exactly the reviewed text, notes human bytes, and replays only its receipt', async () => {
    const f=fixture();
    expect(await f.submit()).toBe('submitted');
    expect(await f.submit()).toBe('submitted');
    expect(f.writes).toEqual(buildComposerWrites(f.msg.text,{bracketed:true,submit:true}));
    expect(f.humans).toEqual(f.writes);
    f.msg.text='Changed'; expect(await f.submit()).toBe('refused');
  });

  it('refuses changed identity, post-recording desktop input, managed work and blocked prompts before pasting', async () => {
    for (const mutate of [
      (f:ReturnType<typeof fixture>) => { f.record.incarnation++; },
      (f:ReturnType<typeof fixture>) => { f.record.eridani = {} as SessionRecord['eridani']; },
      (f:ReturnType<typeof fixture>) => { f.record.agentState = {state:'needs_you', since:1}; },
      (f:ReturnType<typeof fixture>) => { f.msg.bootId='another'; },
      (f:ReturnType<typeof fixture>) => { f.setForeground(false); },
      (f:ReturnType<typeof fixture>) => { f.session.inputRevision++; },
      (f:ReturnType<typeof fixture>) => { f.setVisible('existing desktop draft'); },
      (f:ReturnType<typeof fixture>) => { f.record.turnSeq=200; },
      (f:ReturnType<typeof fixture>) => { f.setAuth(false); },
    ]) {
      const f=fixture(); mutate(f); expect(await f.submit()).toBe('refused'); expect(f.writes).toEqual([]);
    }
  });

  it('withholds Enter if a person types, foreground exits, question changes or gateway disconnects after paste', async () => {
    for (const mutate of [
      (f:ReturnType<typeof fixture>) => {f.session.inputRevision++;},
      (f:ReturnType<typeof fixture>) => {f.setForeground(false);},
      (f:ReturnType<typeof fixture>) => {f.record.chatAttention={revision:2} as SessionRecord['chatAttention'];},
      (f:ReturnType<typeof fixture>) => {f.setAuth(false);},
      (f:ReturnType<typeof fixture>) => {f.setVisible('different draft');},
    ]) {
      const f=fixture();
      const sending=f.submit(); await waitFor(() => f.writes.length === 1);
      mutate(f);
      expect(await sending).toBe('partial');
      expect(f.writes).toHaveLength(1);
      expect(f.humans).toEqual(f.writes);
    }
  });

  it('serializes overlapping operations and reports ambiguity during a send', async () => {
    const f=fixture();
    const sending=f.submit(); await waitFor(() => f.writes.length === 1);
    expect(await f.submit()).toBe('partial');
    const concurrent={...f.msg,operationId:'second-op'};
    Object.assign(f.msg,concurrent);
    expect(await f.submit()).toBe('refused');
    expect(await sending).toBe('submitted');
    expect(f.writes).toHaveLength(2);
  });

  it('offers capability only to the configured gateway and preserves desktop size ownership', async () => {
    const registry=Registry.load({file:null,bootId:'boot-1'});
    const sp=fakeSpawner(), timers=new ManualTimers();
    const hub=new Hub({registry,spawn:sp.spawn,bootId:'boot-1',serverId:'srv-1',timers,
      glassfaceDeviceId:'device-gateway',glassfaceForeground:()=>true});
    function connect(id:number,name:string) {
      const c=new FakeConn(id); hub.connect(c);
      hub.handle(c,{t:'hello',proto:1,device:{id:name,name},app:{name:'test',version:'1'}}); return c;
    }
    const desk=connect(1,'device-desktop'), gateway=connect(2,'device-gateway');
    expect(desk.json('welcome')[0].features).not.toContain('glassfaceInput');
    expect(gateway.json('welcome')[0].features).toContain('glassfaceInput');
    hub.handle(desk,{t:'open',rid:1,id:'surf-one',cols:96,rows:28,create:{}});
    const rec=registry.updateSession('surf-one',{agent:{provider:'claude',sessionId:'conversation',seenAt:1}})!;
    const pty=sp.last();
    const draw=(str:string) => {
      pty.emit('\x1b[?2004h\x1b[2J\x1b[H'+'─'.repeat(80)+'\r\n'+cue+str+'\r\n'+'─'.repeat(80)+'\r\n? for shortcuts\x1b[2;3H');
    };
    draw(''); hub.sessions.get('surf-one')!.flush();
    const msg={...fixture().msg,bootId:'boot-1',incarnation:rec.incarnation!,expectedPrompt:promptIdentity(rec,0)};
    hub.handle(desk,msg);
    await waitFor(() => desk.json('glassfaceReceipt').length>0);
    expect(desk.json('glassfaceReceipt')[0].status).toBe('refused');
    hub.handle(gateway,msg);
    await waitFor(() => pty.written.length > 0);
    draw(msg.text); hub.sessions.get('surf-one')!.flush();
    await waitFor(() => gateway.json('glassfaceReceipt').length>0);
    expect(gateway.json('glassfaceReceipt')[0].status).toBe('submitted');
    expect(pty.size).toEqual([96,28]);
    hub.handle(desk,{t:'resize',id:'surf-one',cols:99,rows:35});
    expect(pty.size).toEqual([99,35]);
    const close = { t:'glassfaceClose' as const, rid:8, id:'surf-one' as const,
      bootId:'boot-1', groupId:'grp-test' as const, incarnation:rec.incarnation! };
    registry.updateSession('surf-one', { groupId:'grp-test' });
    hub.handle(desk,close);
    hub.handle(gateway,{...close,incarnation:close.incarnation+1});
    hub.handle(gateway,{...close,groupId:'grp-other'});
    expect(hub.sessions.has('surf-one')).toBe(true);
    hub.handle(gateway,close);
    expect(hub.sessions.has('surf-one')).toBe(false);
    await hub.shutdown();
  });
});
