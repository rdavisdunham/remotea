import { describe, it, expect, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ManagedSessions, type ManagedSpec } from '../src/managed-sessions';
import type { RuntimeAdapter, HarnessRequest } from '../src/managed-harness';
import type { AnswerCommand } from '../../src/shared/eridani-link-protocol';

class Adapter extends EventEmitter implements RuntimeAdapter {
  sent: Array<[string, string]> = []; responses: unknown[] = []; interrupted = 0;
  async start() { return 'conversation'; } async resume() { return 'conversation'; }
  async send(text: string, op: string) { this.sent.push([text, op]); }
  async interrupt() { this.interrupted++; }
  async respond(_r: HarnessRequest, response: unknown) { this.responses.push(response); }
  async stop() {}
}
const spec: ManagedSpec = { surf: 'surface', runId: 'run', generation: 3, incarnation: 1, prompt: '', operationId: 'spawn-op', harness: 'codex', bin: 'codex', args: [], cwd: '/tmp', env: {}, model: 'actual-model', effort: 'ultra', profile: 'workspace-write' };
const approval = (id: string | number, command = 'npm test') => ({ id, method: 'item/commandExecution/requestApproval', params: { threadId: 'conversation', turnId: 'turn', itemId: 'tool', command, cwd: '/tmp', additionalPermissions: { network: { enabled: true } } } });
const temps: string[] = [];
afterEach(() => { for (const d of temps.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
function fixture(dir: string | null = null) {
  const adapter = new Adapter(); const events: any[] = [];
  const manager = new ManagedSessions({ dir, factory: () => adapter, emit: (e) => events.push(e), changed: () => {} });
  manager.prepare({ ...spec }); const terminal = manager.spawn(spec.surf)!;
  return { adapter, events, manager, terminal };
}
function answer(q: any, choice = 'allow_once'): AnswerCommand { return { t: 'answer', op_id: 'answer-op', digest: 'digest', question_id: q.question_id, provider_request_id: q.provider_request_id, answers: [{ item_id: 'approval', choice_ids: [choice] }] }; }

describe('managed durable ownership', () => {
  it('uses an output-only terminal, explicit once/deny choices and provider confirmation', async () => {
    const { manager, adapter, events, terminal } = fixture(); await manager.ready(spec.surf);
    terminal.write('rm -rf anything\r'); expect(adapter.sent).toEqual([]);
    adapter.emit('event', approval(10));
    const q = events.find((e) => e.t === 'question');
    expect(q).toMatchObject({ durable: true, hold_until: 0, generation: 3, action: { tool: 'item/commandExecution/requestApproval', input: { command: 'npm test' } } });
    expect(manager.precheck({ ...answer(q), answers: [{ item_id: 'approval', text: 'Approved' }] })).toContain('explicitly');
    expect(await manager.answer(answer(q), () => {})).toMatchObject({ state: 'executed', result: { provider_confirmation: 'pending' } });
    expect(adapter.responses).toEqual([{ decision: 'accept' }]);
    expect(events.some((e) => e.t === 'question.resolved')).toBe(false);
    adapter.emit('event', { method: 'serverRequest/resolved', params: { threadId: 'conversation', requestId: 10 } });
    expect(events.find((e) => e.t === 'question.resolved')).toMatchObject({ outcome: 'accepted', still_open: false });
  });
  it('keeps questions across restart and only permits consent after exact verified recreation', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-test-')); temps.push(dir);
    const first = fixture(dir); await first.manager.ready(spec.surf); first.adapter.emit('event', approval(10));
    const q = first.events.find((e) => e.t === 'question');
    const second = fixture(dir); await second.manager.ready(spec.surf);
    expect(second.events.find((e) => e.t === 'question')).toMatchObject({ question_id: q.question_id, recovery: 'attention_required' });
    expect(await second.manager.answer(answer(q), () => {})).toMatchObject({ state: 'rejected' });
    second.adapter.emit('event', approval(11));
    const recreated = second.events.filter((e) => e.t === 'question').at(-1);
    expect(recreated.question_id).toBe(q.question_id);
    expect(await second.manager.answer(answer(recreated), () => {})).toMatchObject({ state: 'executed' });
    expect(second.adapter.responses).toEqual([{ decision: 'accept' }]);
    const third = fixture(dir); await third.manager.ready(spec.surf); third.adapter.emit('event', approval(12));
    const submitted = third.events.filter((e) => e.t === 'question').at(-1);
    expect(third.manager.precheck(answer(submitted))).toContain('reconciliation');
    expect(third.adapter.responses).toEqual([]);
  });
  it('recreates a paused persisted callback after explicit resume and accepts its exact reviewed answer', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-paused-')); temps.push(dir);
    const first = fixture(dir); await first.manager.ready(spec.surf); first.adapter.emit('event', approval(1)); await first.manager.pause(spec.surf, true);
    const events: any[] = []; let recreated = 0;
    const adapter = Object.assign(new Adapter(), { recreate: async (request: HarnessRequest) => { recreated++; adapter.emit('event', { ...request, id: 'recreated-callback' }); } });
    const manager = new ManagedSessions({ dir, factory: () => adapter, emit: (e) => events.push(e), changed: () => {} });
    manager.prepare({ ...spec, incarnation: 2 }); manager.spawn(spec.surf); await manager.ready(spec.surf); expect(recreated).toBe(0);
    await manager.pause(spec.surf, false); expect(recreated).toBe(1);
    const q = events.filter((e) => e.t === 'question').at(-1); expect(q.provider_request_id).toBe('recreated-callback');
    expect(await manager.answer(answer(q), () => {})).toMatchObject({ state: 'executed' }); expect(adapter.responses).toEqual([{ decision: 'accept' }]);
  });
  it('accepts a distinct safe continuation after restart without replaying the interrupted input', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-active-')); temps.push(dir);
    const first = fixture(dir); await first.manager.ready(spec.surf); await first.manager.send(spec.surf, 'work', 'original-input');
    const second = fixture(dir); await second.manager.ready(spec.surf);
    expect(await second.manager.send(spec.surf, 'First reconcile interrupted effects, then continue safely', 'safe-continuation')).toMatchObject({ state: 'executed' });
    expect(second.adapter.sent).toEqual([['First reconcile interrupted effects, then continue safely', 'safe-continuation']]);
    expect(await second.manager.send(spec.surf, 'work', 'original-input')).toMatchObject({ state: 'executed' }); expect(second.adapter.sent).toHaveLength(1);
  });
  it('never labels a naturally recreated uncertain consent as safe pending delivery', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-uncertain-')); temps.push(dir);
    const first = fixture(dir); await first.manager.ready(spec.surf); first.adapter.emit('event', approval(1));
    await first.manager.answer(answer(first.events.find((e) => e.t === 'question')), () => {});
    const second = fixture(dir); await second.manager.ready(spec.surf); second.adapter.emit('event', approval(2));
    const q = second.events.filter((e) => e.t === 'question').at(-1); expect(q.recovery).toBe('attention_required');
    expect(second.manager.precheck(answer(q))).toContain('reconciliation');
  });
  it('never reuses a request or consent after its action/context changed', async () => {
    const { manager, adapter, events } = fixture(); await manager.ready(spec.surf);
    adapter.emit('event', approval(1)); const original = events.find((e) => e.t === 'question');
    adapter.emit('event', approval(2, 'npm publish')); const changed = events.filter((e) => e.t === 'question').at(-1);
    expect(changed.question_id).not.toBe(original.question_id); expect(changed.request_digest).not.toBe(original.request_digest);
    manager.generation(spec.surf, 4); expect(manager.precheck(answer(original))).toBe('stale generation');
  });
  it('persists pause and input receipts while preserving unanswered questions', async () => {
    const { manager, adapter, events } = fixture(); await manager.ready(spec.surf);
    expect(await manager.send(spec.surf, 'work', 'stable-op')).toMatchObject({ state: 'executed' });
    expect(await manager.send(spec.surf, 'work', 'stable-op')).toMatchObject({ state: 'executed' }); expect(adapter.sent).toHaveLength(1);
    adapter.emit('event', approval(1)); const q = events.find((e) => e.t === 'question');
    await manager.pause(spec.surf, true); expect(adapter.interrupted).toBe(0);
    expect(manager.precheck(answer(q))).toBe('run paused'); expect(manager.pending(spec.surf)).toEqual([q.question_id]);
    await manager.pause(spec.surf, false); expect(manager.precheck(answer(q))).toBe(null);
  });
  it('returns only the requested permission subset for this turn with strict subsequent review', async () => {
    const { manager, adapter, events } = fixture(); await manager.ready(spec.surf);
    adapter.emit('event', { id: 2, method: 'item/permissions/requestApproval', params: { threadId: 'conversation', turnId: 'turn', itemId: 'tool', permissions: { network: { enabled: true } } } });
    await manager.answer(answer(events.find((e) => e.t === 'question')), () => {});
    expect(adapter.responses).toEqual([{ permissions: { network: { enabled: true } }, scope: 'turn', strictAutoReview: true }]);
  });
  it('surfaces coordination tool failures and stops automatic continuation', async () => {
    const { manager, adapter, events } = fixture(); await manager.ready(spec.surf);
    adapter.emit('event', { method: 'item/completed', params: { item: { id: 'coordination', type: 'mcpToolCall', status: 'failed', error: { message: 'timeout' } } } });
    expect(adapter.interrupted).toBe(1); expect(events.filter((e) => e.t === 'activity').at(-1)).toMatchObject({ kind: 'waiting', label: 'Coordination tool failed or timed out; reconcile its receipt before retry' });
  });
  it('keeps deferred Claude question answers submitted until the actual tool result confirms them', async () => {
    const { manager, adapter, events } = fixture(); await manager.ready(spec.surf);
    adapter.emit('event', { type: 'result', stop_reason: 'tool_deferred', deferred_tool_use: { id: 'deferred-tool', name: 'AskUserQuestion', input: { questions: [{ question: 'Which?', options: [{ label: 'A' }] }] } } });
    const q = events.find((e) => e.t === 'question');
    await manager.answer({ ...answer(q), answers: [{ item_id: 'q1', choice_ids: ['c1'] }] }, () => {});
    expect(events.some((e) => e.t === 'question.resolved')).toBe(false);
    adapter.emit('event', { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'deferred-tool', content: 'A' }] } });
    expect(events.find((e) => e.t === 'question.resolved')).toMatchObject({ outcome: 'accepted' });
  });
  it('never emits private reasoning text and orders actual activity changes', async () => {
    const { manager, adapter, events } = fixture(); await manager.ready(spec.surf);
    adapter.emit('event', { method: 'item/reasoning/textDelta', params: { delta: 'private thought' } });
    adapter.emit('event', { method: 'item/started', params: { item: { id: 'read', type: 'fileSearch' } } });
    const activity = events.filter((e) => e.t === 'activity');
    expect(activity.map((e) => e.sequence)).toEqual([...activity.map((e) => e.sequence)].sort((a, b) => a - b));
    expect(JSON.stringify(events)).not.toContain('private thought');
  });
});
