import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { codexModelCatalog } from '../src/managed-models';
import { CodexRuntimeAdapter, ClaudeRuntimeAdapter, type HarnessSpec } from '../src/managed-harness';
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function fixture(harness: 'codex' | 'claude'): HarnessSpec {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-provider-')); dirs.push(dir);
  const file = path.join(dir, 'fake-provider');
  fs.writeFileSync(file, `#!/usr/bin/env node
const rl=require('readline').createInterface({input:process.stdin});
const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');
rl.on('line',line=>{const m=JSON.parse(line);
 if(m.method==='initialize') send({id:m.id,result:{}});
 if(m.method==='model/list')send({id:m.id,result:{data:[{model:'actual-sol',displayName:'Actual Sol',hidden:false,isDefault:true,defaultReasoningEffort:'low',supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'ultra'}]}],nextCursor:null}});
 if(m.method==='thread/start'||m.method==='thread/resume'){send({id:m.id,result:{thread:{id:'provider-session'}}});send({method:'test/profile',params:m.params});}
 if(m.method==='turn/start'){send({id:m.id,result:{turn:{id:'provider-turn'}}});send({id:42,method:'item/commandExecution/requestApproval',params:{threadId:'provider-session',turnId:'provider-turn',itemId:'command',command:'npm test'}});}
 if(m.type==='control_request'&&m.request.subtype==='initialize')send({type:'control_response',response:{subtype:'success',request_id:m.request_id,response:{models:[{value:'model',supportedEffortLevels:['low']}]}}});
 if(m.type==='control_request'&&m.request.subtype==='initialize'&&process.env.REMOTEA_TEST_DEFERRED)send({type:'control_request',request_id:'hook-test',request:{subtype:'hook_callback',callback_id:'remotea-defer-ask',input:{tool_name:'AskUserQuestion',tool_use_id:'deferred-id',tool_input:{questions:[{question:'Which?',options:[{label:'A'}]}]}}}});
 if(m.type==='control_response'&&m.response.request_id==='hook-test')send({type:'test/deferred',output:m.response.response});
 if(m.type==='user'){send(m);send({type:'control_request',request_id:'permission',request:{subtype:'can_use_tool',tool_name:'Bash',input:{command:'npm test'},tool_use_id:'tool'}});}
 if(m.id===42||m.type==='control_response')send({type:'test/decision',response:m.result??m.response.response});
});
`, { mode: 0o700 });
  return { harness, bin: file, args: [], cwd: dir, env: {}, model: 'model', effort: 'ultra', profile: 'workspace-write' };
}
const eventually = async (test: () => boolean) => { for (let i = 0; i < 100 && !test(); i++) await new Promise((r) => setTimeout(r, 10)); expect(test()).toBe(true); };
describe('structured provider subprocess transports', () => {
  it('exchanges real JSONL subprocess receipts and typed Codex permission responses', async () => {
    const adapter = new CodexRuntimeAdapter(fixture('codex'), 1000); const events: any[] = []; adapter.on('event', (e) => events.push(e));
    try {
      expect(await adapter.start()).toBe('provider-session'); await adapter.send('test', 'stable-operation');
      await eventually(() => events.some((e) => e.method === 'test/profile'));
      expect(events.find((e) => e.method === 'test/profile').params).toMatchObject({ model: 'model', approvalPolicy: 'on-request', approvalsReviewer: 'auto_review', sandbox: 'workspace-write', config: { model_reasoning_effort: 'ultra' } });
      await eventually(() => events.some((e) => e.id === 42));
      const request = events.find((e) => e.id === 42); await adapter.respond(request, { decision: 'accept' });
      await eventually(() => events.some((e) => e.type === 'test/decision'));
      expect(events.find((e) => e.type === 'test/decision').response).toEqual({ decision: 'accept' });
    } finally { await adapter.stop(); }
  });
  it('initializes Claude permission host, waits for replay receipts and returns updatedInput', async () => {
    const adapter = new ClaudeRuntimeAdapter(fixture('claude'), 1000); const events: any[] = []; adapter.on('event', (e) => events.push(e));
    try {
      expect(await adapter.start()).toMatch(/^[a-f0-9-]{36}$/); await adapter.send('test', 'stable-operation');
      await eventually(() => events.some((e) => e.type === 'control_request'));
      const request = events.find((e) => e.type === 'control_request');
      await adapter.respond({ id: request.request_id, method: 'claude/permission', params: request.request }, { behavior: 'allow', updatedInput: { command: 'npm test' } });
      await eventually(() => events.some((e) => e.type === 'test/decision'));
      expect(events.find((e) => e.type === 'test/decision').response).toEqual({ behavior: 'allow', updatedInput: { command: 'npm test' } });
    } finally { await adapter.stop(); }
  });
  it('defers one Claude question and resumes only its exact saved tool input', async () => {
    const spec = fixture('claude'); spec.env.REMOTEA_TEST_DEFERRED = '1';
    const adapter = new ClaudeRuntimeAdapter(spec, 1000); const events: any[] = []; adapter.on('event', (e) => events.push(e));
    try {
      await adapter.start(); await eventually(() => events.some((e) => e.type === 'test/deferred'));
      expect(events.find((e) => e.type === 'test/deferred').output.hookSpecificOutput.permissionDecision).toBe('defer');
      await adapter.respond({ id: 'deferred-id', method: 'claude/deferred', params: { input: { questions: [{ question: 'Which?', options: [{ label: 'A' }] }] } } }, { behavior: 'allow', updatedInput: { questions: [{ question: 'Which?', options: [{ label: 'A' }] }], answers: { 'Which?': 'A' } } });
      await eventually(() => events.filter((e) => e.type === 'test/deferred').length === 2);
      expect(events.filter((e) => e.type === 'test/deferred').at(-1).output.hookSpecificOutput).toMatchObject({ permissionDecision: 'allow', updatedInput: { answers: { 'Which?': 'A' } } });
    } finally { await adapter.stop(); }
  });
  it('reads authoritative default and efforts with model/list without creating a thread or inference turn', async () => {
    const spec = fixture('codex'); const catalog = await codexModelCatalog(spec.bin);
    expect(catalog).toMatchObject([{ model: 'actual-sol', default: true, efforts: ['low', 'ultra'], default_effort: 'low' }]);
  });
  it('bounds stalled receipts and never retries the effect', async () => {
    const adapter = new CodexRuntimeAdapter(fixture('codex'), 1000);
    try { await adapter.start(); await expect(adapter.call('unsupported/stalls', {})).rejects.toThrow('execution is uncertain'); } finally { await adapter.stop(); }
  });
});
