import { describe, it, expect, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ManagedSessions, type ManagedSpec } from '../src/managed-sessions';
import { ProviderRequestRejected, type RuntimeAdapter, type DirectInputContext, type DirectInputReceipt } from '../src/managed-harness';
class Adapter extends EventEmitter implements RuntimeAdapter {
  sent: string[] = []; direct: Array<{text: string; id: string; context: DirectInputContext}> = []; interrupts = 0;
  implementation?: (id: string) => Promise<DirectInputReceipt>;
  async start() { return 'session'; } async resume() { return 'session'; }
  async send(text: string) { this.sent.push(text); }
  async sendDirect(text: string, id: string, context: DirectInputContext) { this.direct.push({text,id,context}); return this.implementation ? this.implementation(id) : {turnId:context.turnId,providerAcknowledged:false}; }
  async interrupt() { this.interrupts++; } async respond() {} async stop() {}
}
const spec: ManagedSpec = {surf:'surface',runId:'run',generation:1,incarnation:1,prompt:'',operationId:'spawn',harness:'claude',bin:'unused',args:[],cwd:'/tmp',env:{},model:'model',profile:'workspace-write'};
const dirs: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const dir of dirs.splice(0)) fs.rmSync(dir,{recursive:true,force:true}); });
function fixture(dir: string | null = null, harness: 'claude'|'codex' = 'claude') {
 const adapter = new Adapter(), events: any[] = [], hooks: any[] = [];
 const manager = new ManagedSessions({dir,factory:()=>adapter,emit:e=>events.push(e),changed:()=>{},hook:(_surf,e)=>hooks.push(e)});
 manager.prepare({...spec,harness}); const terminal = manager.spawn(spec.surf)!;
 return {manager,adapter,events,hooks,terminal};
}
describe('native direct input ownership',()=>{
 it('hands multiple busy messages independently without interrupting or replacing the active final response',async()=>{
  const {manager,adapter,events,hooks}=fixture(); await manager.ready('surface'); await manager.send('surface','original','initial');
  adapter.emit('event',{type:'assistant',message:{content:[{type:'text',text:'original final'}]}});
  expect(await manager.sendDirect('surface','note one','one',1,()=>{})).toMatchObject({state:'executed',result:{provider_ack:'pending',receipt:'handed_to_harness'}});
  expect(await manager.sendDirect('surface','note two','two',1,()=>{})).toMatchObject({state:'executed',result:{provider_ack:'pending'}});
  expect(adapter.direct.map(item=>item.context)).toEqual([{active:true,turnId:'input:initial'},{active:true,turnId:'input:initial'}]);
  expect(adapter.interrupts).toBe(0);
  adapter.emit('event',{type:'result'}); expect(hooks.filter(h=>h.event==='Stop').at(-1)).toMatchObject({turnId:'input:initial',lastAssistantMessage:'original final'});
  adapter.emit('event',{type:'user',uuid:'two',session_id:'session'});
  expect(events.filter(e=>e.t==='input.receipt'&&e.input_id==='two').at(-1).stage).toBe('provider_acknowledged');
  expect(events.filter(e=>e.t==='input.receipt'&&e.input_id==='one').at(-1).stage).toBe('handed_to_harness');
  expect(await manager.sendDirect('surface','note two','two',1,()=>{})).toMatchObject({state:'executed',result:{provider_ack:'confirmed'}}); expect(adapter.direct).toHaveLength(2);
 });
 it('never regresses an early provider replay acknowledgment after the later pipe-write callback',async()=>{
  const {manager,adapter,events}=fixture();await manager.ready('surface');adapter.implementation=async id=>{adapter.emit('event',{type:'user',uuid:id,session_id:'session'});adapter.emit('event',{type:'result',result:'fast final'});return {turnId:null,providerAcknowledged:false};};
  expect(await manager.sendDirect('surface','fast','one',1,()=>{})).toMatchObject({state:'executed',result:{provider_ack:'confirmed'}});expect(events.filter(e=>e.t==='input.receipt').every(e=>e.stage==='provider_acknowledged')).toBe(true);
  adapter.implementation=async()=>({turnId:null,providerAcknowledged:false});await manager.sendDirect('surface','second','two',2,()=>{});expect(adapter.direct.at(-1)?.context.active).toBe(false);
 });
 it('resets prior semantic text when a busy Codex steer is explicitly rejected as ended before starting a fresh turn',async()=>{
  const {manager,adapter,hooks}=fixture(null,'codex');await manager.ready('surface');await manager.send('surface','old prompt','old');adapter.emit('event',{method:'item/agentMessage/delta',params:{delta:'old answer'}});
  adapter.implementation=async id=>{adapter.emit('event',{type:'remotea/direct-start',input_id:id});adapter.emit('event',{method:'turn/started',params:{turn:{id:'fresh-turn'}}});adapter.emit('event',{method:'item/agentMessage/delta',params:{delta:'new answer'}});adapter.emit('event',{method:'turn/completed',params:{turn:{id:'fresh-turn'}}});return {turnId:'fresh-turn',providerAcknowledged:true};};
  await manager.sendDirect('surface','new prompt','new',1,()=>{});expect(adapter.direct[0].context.active).toBe(true);expect(hooks.filter(h=>h.event==='Stop').at(-1)).toMatchObject({lastAssistantMessage:'new answer'});expect(hooks.filter(h=>h.event==='UserPromptSubmit').at(-1).prompt).toBe('new prompt');
 });
 it('does not invent a receipt timeout while Claude keeps a handed message buffered',async()=>{
  vi.useFakeTimers();const {manager,events}=fixture();await manager.ready('surface');
  await manager.sendDirect('surface','note','one',1,()=>{});await vi.advanceTimersByTimeAsync(24*60*60*1000);
  expect(events.filter(e=>e.t==='input.receipt').map(e=>e.stage)).toEqual(['handed_to_harness']);
 });
 it('retains handed receipts across restart and never retries uncertain native effects',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'direct-state-'));dirs.push(dir);
  const first=fixture(dir);await first.manager.ready('surface');await first.manager.sendDirect('surface','accepted','one',1,()=>{});
  first.adapter.implementation=async()=>{throw new Error('connection lost');};expect(await first.manager.sendDirect('surface','unknown','two',1,()=>{})).toMatchObject({state:'uncertain'});
  const second=fixture(dir);await second.manager.ready('surface');
  expect(second.manager.recoveredDirect('surface','one')).toMatchObject({state:'executed',result:{provider_ack:'pending'}});expect(second.manager.recoveredDirect('surface','two')).toBe(null);
  expect(await second.manager.sendDirect('surface','accepted','one',1,()=>{})).toMatchObject({state:'executed',result:{provider_ack:'pending'}});
  expect(await second.manager.sendDirect('surface','unknown','two',1,()=>{})).toMatchObject({state:'uncertain'}); expect(second.adapter.direct).toHaveLength(0);
 });
 it('resets a definitely rejected idle start and prepares a proven new Codex turn before fast events',async()=>{
  const {manager,adapter,hooks}=fixture(null,'codex');await manager.ready('surface');
  adapter.implementation=async()=>{throw new ProviderRequestRejected('rejected');};expect(await manager.sendDirect('surface','rejected','one',1,()=>{})).toMatchObject({state:'rejected'});
  adapter.implementation=async id=>{adapter.emit('event',{type:'remotea/direct-start',input_id:id});adapter.emit('event',{method:'turn/started',params:{turn:{id:'new'}}});adapter.emit('event',{method:'item/agentMessage/delta',params:{itemId:'answer',delta:'fresh'}});adapter.emit('event',{method:'turn/completed',params:{turn:{id:'new'}}});return {turnId:'new',providerAcknowledged:true};};
  await manager.sendDirect('surface','fresh prompt','two',1,()=>{});
  expect(adapter.direct[1].context.active).toBe(false);expect(hooks.filter(h=>h.event==='Stop').at(-1)).toMatchObject({lastAssistantMessage:'fresh',turnId:'new'}); expect(hooks.filter(h=>h.event==='UserPromptSubmit').at(-1).prompt).toBe('fresh prompt');
 });
 it('clears a definitely rejected idle Claude start instead of leaving a phantom active turn',async()=>{
  const {manager,adapter}=fixture();await manager.ready('surface');adapter.implementation=async()=>{throw new ProviderRequestRejected('input unavailable');};expect(await manager.sendDirect('surface','no','rejected',1,()=>{})).toMatchObject({state:'rejected'});
  adapter.implementation=async()=>({turnId:null,providerAcknowledged:false});await manager.sendDirect('surface','yes','accepted',1,()=>{});expect(adapter.direct.at(-1)?.context.active).toBe(false);
 });
 it('supersedes only explicitly automatic unhanded queue entries and persists the runwide hold',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'direct-hold-'));dirs.push(dir);const {manager,adapter}=fixture(dir);await manager.ready('surface');await manager.send('surface','working','initial');
  const auto=manager.send('surface','automatic','auto',false,()=>{},{origin:'automation',automation_hold_revision:0});
  const legacy=manager.send('surface','legacy manual','legacy');
  expect(manager.holdRun('run',1,true,1)).toBe(null);expect(await auto).toMatchObject({state:'rejected'});
  adapter.emit('event',{type:'result'});expect(await legacy).toMatchObject({state:'executed'});expect(adapter.sent).toEqual(['working','legacy manual']);
  const second=fixture(dir);await second.manager.ready('surface');expect(second.manager.automation.get('run')).toMatchObject({held:true,revision:1});
  expect(second.manager.holdRun('run',1,false,0)).toContain('stale');expect(second.manager.holdRun('run',1,false,2)).toBe(null);
 });
 it('tracks a new Claude native turn after an early replay receipt without reusing its prior final identity',async()=>{
  const {manager,adapter,events,hooks}=fixture();await manager.ready('surface');await manager.send('surface','original','initial');
  await manager.sendDirect('surface','next prompt','note',1,()=>{});adapter.emit('event',{type:'user',uuid:'note',session_id:'session'});
  adapter.emit('event',{type:'assistant',message:{id:'one',content:[{type:'text',text:'first answer'}]}});adapter.emit('event',{type:'result',result:'first answer'});
  adapter.emit('event',{type:'stream_event',event:{type:'message_start',message:{id:'two'}}});adapter.emit('event',{type:'assistant',message:{id:'two',content:[{type:'text',text:'second answer'}]}});adapter.emit('event',{type:'result',result:'second answer'});
  expect(hooks.filter(h=>h.event==='Stop').map(h=>h.turnId)).toEqual(['input:initial','input:note']);
  expect(events.filter(e=>e.t==='output.live'&&e.message_id==='two').at(-1)).toMatchObject({turn_id:'input:note',text:'second answer'});
 });
 it('delivers every human note accepted offline even when a newer hold snapshot was installed first',async()=>{
  const {manager,adapter}=fixture();await manager.ready('surface');manager.holdRun('run',1,true,3);
  expect(await manager.sendDirect('surface','earlier','two',2,()=>{})).toMatchObject({state:'executed'});expect(await manager.sendDirect('surface','latest','three',3,()=>{})).toMatchObject({state:'executed'});
  expect(adapter.direct.map(item=>item.text)).toEqual(['earlier','latest']);expect(manager.automation.get('run')).toMatchObject({held:true,revision:3});
 });
 it('keeps Claude live output and completed turn on the same stable provider turn identity',async()=>{
  const {manager,adapter,events,hooks}=fixture();await manager.ready('surface');await manager.send('surface','work','initial');
  adapter.emit('event',{type:'assistant',message:{id:'public',content:[{type:'text',text:'answer'}]}});adapter.emit('event',{type:'result',result:'answer'});
  expect(events.find(e=>e.t==='output.live').turn_id).toBe(hooks.find(h=>h.event==='Stop').turnId);
 });
});
