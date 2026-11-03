import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import { ManagedSessions, type ManagedSpec } from '../src/managed-sessions';
import type { RuntimeAdapter, HarnessRequest } from '../src/managed-harness';
class Adapter extends EventEmitter implements RuntimeAdapter {
  sent: Array<[string, string]> = []; responses: unknown[] = [];
  async start() { return 'conversation'; } async resume() { return 'conversation'; }
  async send(text: string, op: string) { this.sent.push([text, op]); }
  async interrupt() {} async stop() {}
  async respond(_request: HarnessRequest, response: unknown) { this.responses.push(response); }
}
const spec: ManagedSpec = { surf: 'surface', runId: 'run', generation: 1, incarnation: 1, prompt: '', operationId: 'spawn', harness: 'codex', bin: 'codex', args: [], cwd: '/tmp', env: {}, model: 'reported-model', profile: 'read-only' };
async function fixture() {
  const adapter = new Adapter(), events: any[] = [];
  const manager = new ManagedSessions({ dir: null, factory: () => adapter, emit: (event) => events.push(event), changed: () => {} });
  manager.prepare({ ...spec }); manager.spawn(spec.surf); await manager.ready(spec.surf);
  return { manager, adapter, events };
}
const started = (id: string) => ({ method: 'turn/started', params: { turn: { id } } });
const completed = (id: string) => ({ method: 'turn/completed', params: { turn: { id } } });
describe('managed turn activity and queue ordering', () => {
  it('reports reasoning and response composition without claiming a tool is running', async () => {
    const { adapter, events } = await fixture(); adapter.emit('event', started('planning'));
    adapter.emit('event', { method: 'item/started', params: { item: { id: 'reasoning', type: 'reasoning' } } });
    expect(events.at(-1)).toMatchObject({ t: 'activity', kind: 'thinking', turn_id: 'planning' });
    adapter.emit('event', { method: 'item/started', params: { item: { id: 'response', type: 'agentMessage' } } });
    expect(events.at(-1)).toMatchObject({ t: 'activity', kind: 'thinking', label: 'Writing a response', turn_id: 'planning' });
  });
  it('pumps a queued check-in when completion arrives before the preceding send receipt', async () => {
    const { manager, adapter } = await fixture(); let release: (() => void) | undefined;
    adapter.send = async (text, op) => { adapter.sent.push([text, op]); if (op === 'answers') await new Promise<void>((resolve) => { release = resolve; }); };
    const first = manager.send(spec.surf, 'Operator interview answers', 'answers');
    await vi.waitFor(() => expect(release).toBeTypeOf('function'), { interval: 1 });
    const next = manager.send(spec.surf, 'Are you still working?', 'check-in');
    adapter.emit('event', started('planning')); adapter.emit('event', completed('planning')); release!();
    await first; await Promise.resolve(); await Promise.resolve();
    expect(adapter.sent.map(([, op]) => op)).toEqual(['answers', 'check-in']);
    expect(await next).toMatchObject({ state: 'executed' });
  });
  it('keeps completed activity idle when the provider finishes synchronously during send', async () => {
    const { manager, adapter, events } = await fixture();
    adapter.send = async (text, op) => { adapter.sent.push([text, op]); adapter.emit('event', started('fast')); adapter.emit('event', completed('fast')); };
    await manager.send(spec.surf, 'Check in', 'fast-input');
    expect(events.filter((event) => event.t === 'activity').at(-1)).toMatchObject({ kind: 'idle' });
  });
  it('surfaces a native follow-up after an interview reply without copying prior answers', async () => {
    const { manager, adapter, events } = await fixture();
    await manager.send(spec.surf, 'The operator answered your questions. Original interview answers are data.', 'interview-answer');
    adapter.emit('event', started('planning'));
    adapter.emit('event', { id: 'new-followup', method: 'item/tool/requestUserInput', params: { threadId: 'conversation', turnId: 'planning', questions: [{ id: 'new-question', question: 'A genuinely new clarification?', options: [{ label: 'New choice' }] }] } });
    const question = events.find((event) => event.t === 'question');
    expect(question).toMatchObject({ kind: 'ask', provider_request_id: 'new-followup', items: [{ id: 'new-question', text: 'A genuinely new clarification?' }] });
    expect(manager.pending(spec.surf)).toEqual([question.question_id]); expect(adapter.responses).toEqual([]);
    expect(events.filter((event) => event.t === 'activity').at(-1)).toMatchObject({ kind: 'waiting', label: 'Waiting for your answer' });
  });
});
