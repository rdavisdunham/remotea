import {describe,it,expect,vi,afterEach} from 'vitest';
import {ManagedOutput,emptyOutput} from '../src/managed-output';
afterEach(()=>vi.useRealTimers());
function fixture(){const state=emptyOutput(),events:any[]=[],persist=vi.fn();const context={run_id:'run',generation:1,surf:'surface',incarnation:1,session_id:'session',turn_id:'turn'};const output=new ManagedOutput(state,()=>context,persist,e=>events.push(e));return {state,events,persist,context,output};}
describe('bounded public assistant output',()=>{
 it('coalesces public deltas, flushes complete messages and excludes reasoning and tools',async()=>{
  vi.useFakeTimers();const {output,events,persist}=fixture();
  output.event({method:'item/reasoning/textDelta',params:{delta:'private reasoning'}});output.event({method:'item/commandExecution/outputDelta',params:{delta:'private command'}});
  output.event({method:'item/started',params:{item:{type:'agentMessage',id:'comment',phase:'commentary'}}});
  for(let i=0;i<100;i++)output.event({method:'item/agentMessage/delta',params:{itemId:'comment',delta:'a'}});
  expect(events).toHaveLength(0);await vi.advanceTimersByTimeAsync(200);expect(events).toHaveLength(1);expect(persist).toHaveBeenCalledTimes(1);
  output.event({method:'item/completed',params:{item:{type:'agentMessage',id:'comment',text:'published commentary',phase:'commentary'}}});
  expect(events.at(-1)).toMatchObject({message_id:'comment',kind:'commentary',text:'published commentary',complete:true});expect(JSON.stringify(events)).not.toContain('private');
  const sequence=events.at(-1).sequence;output.replay();expect(events.at(-1).sequence).toBe(sequence);
 });
 it('does not expose a recognizable credential prefix split across streamed snapshots',()=>{
  const {output,events}=fixture();output.event({method:'item/agentMessage/delta',params:{itemId:'message',delta:'Key sk-proj-short'}});output.flush();expect(events.at(-1).text).toBe('Key [redacted]');
  output.event({method:'item/agentMessage/delta',params:{itemId:'message',delta:'abcdefghijklmnopqrstuvwxyz'}});output.flush();expect(events.at(-1).text).toBe('Key [redacted]');
 });
 it('normalizes Claude partial/full message identity and preserves prior completed commentary',()=>{
  const {output,events,state}=fixture();output.event({type:'stream_event',event:{type:'message_start',message:{id:'one',content:[{type:'text',text:'Hello'}]}}});
  output.event({type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:' there'}}});
  output.event({type:'assistant',message:{id:'one',content:[{type:'text',text:'Hello there'}]}});output.event({type:'result',result:'Final answer'});
  expect(state.messages).toHaveLength(2);expect(events.find(e=>e.message_id==='one')).toMatchObject({text:'Hello there',complete:true});expect(events.at(-1).text).toBe('Final answer');
 });
 it('bounds replay and redacts complete snapshots without emitting raw JSON or escapes',()=>{
  const {output,state,events}=fixture();for(let i=0;i<60;i++)output.event({method:'item/completed',params:{item:{type:'agentMessage',id:String(i),text:'x'.repeat(40000)}}});
  expect(state.messages.length).toBeLessThanOrEqual(32);expect(state.messages.reduce((n,m)=>n+Buffer.byteLength(m.raw),0)).toBeLessThanOrEqual(128*1024);expect(events.at(-1).text.length).toBeLessThanOrEqual(32768);expect(events.at(-1).truncated).toBe(true);
 });
});
