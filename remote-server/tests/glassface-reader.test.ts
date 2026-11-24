import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { fitReader, parseReplies } from '../src/glassface-reader';
import { Hub } from '../src/hub';
import { Registry } from '../src/registry';
import { FakeConn, fakeSpawner, ManualTimers, waitFor } from './helpers';

const conversation = '1b628d91-aecc-46f1-ab67-c565aa0d9fd1';
const lines = (...entries: unknown[]) => entries.map(e => JSON.stringify(e)).join('\n');
const claude = (id: string, text: string, extras = {}) => ({
  type: 'assistant', sessionId: conversation, uuid: id,
  message: { id, model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{type:'text', text}] },
  ...extras,
});

describe('Google Glass reply reader', () => {
  it('reads only root assistant answers for the selected Claude conversation', () => {
    const text = 'Run this:\n    echo "restart to update"';
    const result = parseReplies('claude', conversation, lines(
      claude('first',text),
      claude('a','private',{isSidechain:true}),
      claude('b','wrong',{sessionId:'other'}),
      claude('c','tool chatter',{message:{model:'claude-opus-5-5',stop_reason:'tool_use',content:[{type:'text',text:'tool chatter'}]}}),
      claude('reasoning','',{message:{model:'claude-opus-5-5',stop_reason:'end_turn',content:[{type:'thinking',thinking:'private'}]}}),
      claude('second','Done.'),
      {type:'user',sessionId:conversation,message:{content:'secret user prompt'}}
    ));
    expect(result).toEqual({model:'Opus 5.5', replies:[{id:'first',text},{id:'second',text:'Done.'}]});
  });
  it('retains complete long replies and budgets the escaped UTF-8 JSON transferred to Glass', () => {
    const text = ('    a long line🎉\n' + '"'.repeat(11) + '\\' + '\t').repeat(1100);
    expect(text.length).toBeGreaterThan(30_000);
    expect(parseReplies('claude', conversation, lines(claude('long',text))).replies[0].text).toBe(text);
    const mixed = {model:'Opus 5.5', replies:[{id:'old',text:text.repeat(10)}, {id:'new',text}]};
    const newestOnly = {model:'Opus 5.5', replies:[mixed.replies[1]]};
    const exact = Buffer.byteLength(JSON.stringify(newestOnly));
    expect(fitReader(mixed, exact)).toEqual(newestOnly);
    const limited = fitReader(newestOnly,8192);
    expect(Buffer.byteLength(JSON.stringify(limited))).toBeLessThanOrEqual(8192);
    expect(limited.replies[0].text).toContain('[Reply shortened on Glass]');
    expect(text.startsWith(limited.replies[0].text.split('\n[Reply shortened on Glass]')[0])).toBe(true);
  });
  it('keeps one Codex final answer per turn and uses the exact reported model', () => {
    const event = (payload: object) => ({type:'event_msg',payload});
    const result = parseReplies('codex', conversation, lines(
      {type:'turn_context',payload:{turn_id:'a',model:'gpt-6.2-sol'}},
      event({type:'agent_message',phase:'commentary',message:'thinking about it'}),
      event({type:'item_completed',turn_id:'a',item:{type:'AgentMessage',phase:'final_answer',content:[{type:'Text',text:'Line 1\nLine 2'}]}}),
      event({type:'task_complete',turn_id:'a',last_agent_message:'Line 1\nLine 2'}),
      event({type:'task_started',turn_id:'b'}),event({type:'agent_message',phase:'final_answer',message:'All done.'})
    ));
    expect(result).toEqual({model:'6.2 Sol',replies:[{id:'a',text:'Line 1\nLine 2'},{id:'b',text:'All done.'}]});
  });
  it('gates the reader on the app, device, group, current conversation and visibility', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(),'glass-reader-fixture-'));
    vi.stubEnv('CLAUDE_CONFIG_DIR',root);
    const project = path.join(root,'projects','-bench');
    fs.mkdirSync(project, {recursive:true});
    const answer = 'A real reply spanning rows.\n    echo example';
    fs.writeFileSync(path.join(project,conversation+'.jsonl'), lines(claude('current',answer))+'\n');
    const registry = Registry.load({file:null,bootId:'boot'});
    const hub = new Hub({registry,spawn:fakeSpawner().spawn,
      serverId:'server',bootId:'boot',timers:new ManualTimers(),glassfaceForeground:()=>true,glassfaceDeviceId:'device-glass',glassfaceGroupId:'grp-glass'});
    const login = (id:number, device:string, app:string) => {
      const conn=new FakeConn(id); hub.connect(conn);
      hub.handle(conn,{t:'hello',proto:1,device:{id:device,name:device},app:{name:app,version:'1'}});
      return conn;
    };
    const desktop=login(1,'device-desktop','googleglass');
    const ordinary=login(2,'device-glass','desktop');
    const glass=login(3,'device-glass','googleglass');
    expect(desktop.json('welcome')[0].features).not.toContain('glassfaceReader');
    expect(ordinary.json('welcome')[0].features).not.toContain('glassfaceReader');
    expect(glass.json('welcome')[0].features).toContain('glassfaceReader');
    const msg={t:'glassfaceRead' as const,rid:2,id:'surf-one' as const,bootId:'boot',incarnation:1,conversation,maxBytes:32_768};
    hub.handle(desktop,{t:'open',rid:1,id:'surf-one',cols:96,rows:28,create:{cwd:'/bench'}});
    const rec = registry.updateSession('surf-one',{agent:{provider:'claude',sessionId:conversation,seenAt:1},groupId:'grp-other'})!;
    msg.incarnation = rec.incarnation!;
    for (const conn of [desktop,ordinary,glass]) {
      hub.handle(conn,msg);
      expect(conn.json('glassfaceReadResult')[0].reader).toBeNull();
    }
    registry.updateSession('surf-one',{groupId:'grp-glass'});
    for (const conn of [desktop,ordinary]) {
      hub.handle(conn,msg);
      expect(conn.json('glassfaceReadResult').at(-1)!.reader).toBeNull();
    }
    hub.handle(glass,{...msg,conversation:'some-other-session'});
    expect(glass.json('glassfaceReadResult').at(-1)!.reader).toBeNull();
    hub.handle(glass,msg);
    await waitFor(()=>glass.json('glassfaceReadResult').length===3);
    expect(glass.json('glassfaceReadResult').at(-1)!.reader).toEqual({model:'Opus 5.5',replies:[{id:'current',text:answer}]});
    hub.handle(glass,msg);
    registry.updateSession('surf-one',{hiddenBy:['device-glass']});
    await waitFor(()=>glass.json('glassfaceReadResult').length===4);
    expect(glass.json('glassfaceReadResult').at(-1)!.reader).toBeNull();
    await hub.shutdown();
    vi.unstubAllEnvs();
    fs.rmSync(root,{recursive:true,force:true});
  });
});
