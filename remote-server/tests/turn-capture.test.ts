import { beforeEach, describe, expect, it } from 'vitest';
import type { SessionRecord } from '../../src/shared/remote-host-protocol';
import { TurnCapture, isRolloutPath, rolloutFinalAnswer, type PromptFields, type TurnCaptureDeps, type TurnFields } from '../src/turn-capture';

type Binding = NonNullable<ReturnType<NonNullable<TurnCaptureDeps['binding']>>>;

let recs: Map<string, SessionRecord>;
let turns: TurnFields[];
let prompts: PromptFields[];
let bindings: Map<string, Binding>;
let tails: Record<string, string>;
let cap: TurnCapture;

function fresh(withPrompt = true): TurnCapture {
  return new TurnCapture({
    session: (id) => recs.get(id),
    update: (id, patch) => recs.set(id, { ...recs.get(id)!, ...patch }),
    emit: (t) => turns.push(t),
    ...(withPrompt ? { prompt: (p: PromptFields) => prompts.push(p) } : {}),
    binding: (id) => bindings.get(id) ?? null,
    now: () => 5000,
    readTail: (file) => tails[file] ?? '',
  });
}

beforeEach(() => {
  recs = new Map([['surf-1', { id: 'surf-1', incarnation: 2 } as SessionRecord]]);
  turns = [];
  prompts = [];
  bindings = new Map();
  tails = {};
  cap = fresh();
});

const claude = (event: string, extra: Record<string, unknown> = {}) => cap.hook('surf-1', { event, sessionId: 'sess-a', ...extra });
const codex = (event: string, extra: Record<string, unknown> = {}) => cap.hook('surf-1', { event, provider: 'codex', sessionId: 'thr-1', ...extra });

describe('TurnCapture', () => {
  it('one root turn per Claude prompt, numbered by the root Stop sequence, prompt attached', () => {
    claude('UserPromptSubmit', { prompt: 'first' });
    expect(claude('Stop', { lastAssistantMessage: 'one', at: 1234 })).toEqual({ provider: 'claude', sessionId: 'sess-a' });
    claude('UserPromptSubmit', { prompt: 'second' });
    claude('Stop', { lastAssistantMessage: 'two' });
    expect(turns.map((t) => [t.provider_turn_id, t.seq, t.text, t.prompt])).toEqual([
      ['sess-a:surf-1:1', 1, 'one', 'first'],
      ['sess-a:surf-1:2', 2, 'two', 'second'],
    ]);
    expect(turns[0]).toMatchObject({ surf: 'surf-1', incarnation: 2, run_id: null, generation: 0, tool: 'claude_code', provider_session_id: 'sess-a', root: true, truncated: false, missing: false, source: 'hook', ended_at: 1234 });
    expect(turns[1].ended_at).toBe(5000);
    expect(recs.get('surf-1')!.turnSeq).toBe(2);
  });

  it('captures explicit managed Claude hooks with the stable live-output turn identity', () => {
    claude('UserPromptSubmit', { provider: 'claude', prompt: 'direct note' });
    expect(claude('Stop', { provider: 'claude', turnId: 'input:direct-op', lastAssistantMessage: 'completed public answer' })).toEqual({provider:'claude',sessionId:'sess-a'});
    expect(turns).toMatchObject([{provider_turn_id:'input:direct-op',text:'completed public answer',prompt:'direct note'}]);
  });

  it('a duplicate Stop for the same turn is dropped (Claude and Codex)', () => {
    claude('UserPromptSubmit');
    claude('Stop', { lastAssistantMessage: 'a' });
    claude('Stop', { lastAssistantMessage: 'a, continued after a blocking Stop hook' });
    expect(turns).toHaveLength(1);
    expect(turns[0].text).toBe('a');

    codex('Stop', { turnId: 'turn-9', lastAssistantMessage: 'x' });
    codex('Stop', { turnId: 'turn-9', lastAssistantMessage: 'x' });
    expect(turns.map((t) => t.provider_turn_id)).toEqual(['sess-a:surf-1:1', 'turn-9']);
  });

  it('the cursor survives a restart: a new instance neither repeats nor skips', () => {
    claude('UserPromptSubmit');
    claude('Stop', { lastAssistantMessage: 'a' });
    cap = fresh();
    claude('Stop', { lastAssistantMessage: 'a' });
    expect(turns).toHaveLength(1);
    claude('UserPromptSubmit');
    claude('Stop', { lastAssistantMessage: 'b' });
    expect(turns.map((t) => [t.provider_turn_id, t.seq])).toEqual([['sess-a:surf-1:1', 1], ['sess-a:surf-1:2', 2]]);
  });

  it('a Stop with no prompt seen (server started mid-turn) still captures turn 1', () => {
    claude('Stop', { lastAssistantMessage: 'late' });
    expect(turns[0]).toMatchObject({ provider_turn_id: 'sess-a:surf-1:1', text: 'late' });
    expect(turns[0].prompt).toBeUndefined();
  });

  it('a subagent Stop and SubagentStop are never turns', () => {
    claude('UserPromptSubmit');
    claude('Stop', { agentId: 'agent-1', lastAssistantMessage: 'sub' });
    claude('SubagentStop', { lastAssistantMessage: 'sub' });
    expect(turns).toEqual([]);
    claude('Stop', { lastAssistantMessage: 'root' });
    expect(turns.map((t) => t.text)).toEqual(['root']);
  });

  it('other providers and missing session ids are ignored', () => {
    cap.hook('surf-1', { event: 'Stop', provider: 'opencode', sessionId: 'x', lastAssistantMessage: 'a' });
    cap.hook('surf-1', { event: 'Stop', lastAssistantMessage: 'a' });
    cap.hook('surf-1', { event: 'Stop', sessionId: '../../etc', lastAssistantMessage: 'a' });
    cap.hook('surf-unknown', { event: 'Stop', sessionId: 's', lastAssistantMessage: 'a' });
    expect(turns).toEqual([]);
  });

  it('Codex: rollout fallback only when the hook carried no text, same turn id either way', () => {
    const file = '/home/u/.codex/sessions/2026/rollout-x.jsonl';
    tails[file] = [
      JSON.stringify({ type: 'turn_context', payload: { turn_id: 'turn-1' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', phase: 'commentary', message: 'thinking' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', phase: 'final_answer', message: 'from rollout' } }),
    ].join('\n');
    codex('Stop', { turnId: 'turn-1', transcriptPath: file, lastAssistantMessage: 'from hook' });
    expect(turns[0]).toMatchObject({ text: 'from hook', source: 'hook', provider_turn_id: 'turn-1', tool: 'codex_cli' });
    // A second Stop for the same turn, now without the field: the fallback cannot add a turn.
    codex('Stop', { turnId: 'turn-1', transcriptPath: file });
    expect(turns).toHaveLength(1);
    codex('Stop', { turnId: 'turn-1b', transcriptPath: file });
    expect(turns).toHaveLength(2);
    // turn-1b has no matching turn_context: the final answer belongs to turn-1, so nothing is read.
    expect(turns[1]).toMatchObject({ missing: true, text: '' });
    tails[file] += '\n' + JSON.stringify({ type: 'turn_context', payload: { turn_id: 'turn-2' } }) + '\n'
      + JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', phase: 'final_answer', message: 'answer two' } });
    codex('Stop', { turnId: 'turn-2', transcriptPath: file });
    expect(turns[2]).toMatchObject({ text: 'answer two', source: 'rollout', missing: false });
  });

  it('reads Codex 0.166 rollouts: task_complete and item_completed AgentMessage, no agent_message event', () => {
    // The shapes a real 0.166.0 rollout has (event_msg agent_message is no longer written).
    const line = (o: object) => JSON.stringify(o);
    const tail = [
      line({ type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' } }),
      line({ type: 'event_msg', payload: { type: 'item_completed', turn_id: 't1', item: { type: 'AgentMessage', phase: 'commentary', content: [{ type: 'Text', text: 'working on it' }] } } }),
      line({ type: 'event_msg', payload: { type: 'item_completed', turn_id: 't1', item: { type: 'AgentMessage', phase: 'final_answer', content: [{ type: 'Text', text: 'final ' }, { type: 'Text', text: 'one' }] } } }),
      line({ type: 'event_msg', payload: { type: 'task_started', turn_id: 't2' } }),
      line({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 't2', last_agent_message: 'final two' } }),
    ].join('\n');
    expect(rolloutFinalAnswer(tail, 't1')).toBe('final one');
    expect(rolloutFinalAnswer(tail, 't2')).toBe('final two');
    expect(rolloutFinalAnswer(tail)).toBe('final two');
    expect(rolloutFinalAnswer(tail, 't3')).toBeNull();
  });

  it('Claude never reads a transcript: missing text is reported missing', () => {
    claude('Stop', { transcriptPath: '/home/u/.claude/projects/x/s.jsonl' });
    expect(turns[0]).toMatchObject({ missing: true, text: '', source: 'hook' });
  });

  it('only a normalized absolute .jsonl under .codex is ever read', () => {
    expect(isRolloutPath('/home/u/.codex/sessions/a.jsonl')).toBe(true);
    expect(isRolloutPath('/home/u/.codex/../.ssh/a.jsonl')).toBe(false);
    expect(isRolloutPath('/home/u/.ssh/id_rsa')).toBe(false);
    expect(isRolloutPath('rel/.codex/a.jsonl')).toBe(false);
    expect(isRolloutPath(42)).toBe(false);
    expect(rolloutFinalAnswer('garbage\n{"type":"event_msg"}')).toBeNull();
  });

  it('truncates at 16k code points with the flag, and honours the helper\'s own flag', () => {
    claude('UserPromptSubmit', { prompt: 'p'.repeat(5000) });
    claude('Stop', { lastAssistantMessage: '😀'.repeat(16_001) });
    expect(Array.from(turns[0].text)).toHaveLength(16_000);
    expect(turns[0].truncated).toBe(true);
    expect(turns[0].prompt).toHaveLength(4000);
    expect(turns[0].prompt_truncated).toBe(true);
    claude('UserPromptSubmit');
    claude('Stop', { lastAssistantMessage: 'short', lastAssistantTruncated: '1' });
    expect(turns[1]).toMatchObject({ text: 'short', truncated: true });
  });

  it('redacts secrets in the text and the prompt', () => {
    claude('UserPromptSubmit', { prompt: 'use key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123' });
    claude('Stop', { lastAssistantMessage: 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789 set' });
    expect(turns[0].text).not.toContain('ghp_abcdef');
    expect(turns[0].prompt).not.toContain('sk-ant-api03');
  });

  describe('live prompt frames', () => {
    beforeEach(() => bindings.set('surf-1', { runId: 'run-7', generation: 3 }));

    it('a root prompt on a run-bound surface is emitted at once, and its seq pairs with the turn that follows', () => {
      claude('UserPromptSubmit', { prompt: 'first', at: 1200 });
      expect(turns).toEqual([]);
      expect(prompts).toEqual([{
        surf: 'surf-1', incarnation: 2, run_id: 'run-7', generation: 3, provider: 'claude', tool: 'claude_code',
        provider_session_id: 'sess-a', seq: 1, text: 'first', truncated: false, at: 1200,
      }]);
      claude('Stop', { lastAssistantMessage: 'one' });
      claude('UserPromptSubmit', { prompt: 'second' });
      claude('Stop', { lastAssistantMessage: 'two' });
      expect(prompts.map((p) => [p.seq, p.text, p.at])).toEqual([[1, 'first', 1200], [2, 'second', 5000]]);
      expect(turns.map((t) => [t.seq, t.prompt, t.run_id, t.generation])).toEqual([[1, 'first', 'run-7', 3], [2, 'second', 'run-7', 3]]);
    });

    it('the seq keeps pairing across a restart and a duplicate Stop', () => {
      claude('UserPromptSubmit', { prompt: 'a' });
      claude('Stop', { lastAssistantMessage: 'a' });
      claude('Stop', { lastAssistantMessage: 'a again' });
      cap = fresh();
      claude('UserPromptSubmit', { prompt: 'b' });
      claude('Stop', { lastAssistantMessage: 'b' });
      expect(prompts.map((p) => p.seq)).toEqual([1, 2]);
      expect(turns.map((t) => t.seq)).toEqual([1, 2]);
    });

    it('Codex prompts carry the Codex tool and thread id', () => {
      codex('UserPromptSubmit', { prompt: 'do it' });
      expect(prompts[0]).toMatchObject({ provider: 'codex', tool: 'codex_cli', provider_session_id: 'thr-1', run_id: 'run-7', seq: 1 });
    });

    it('F07: an accepted input binds the prompt to the generation Eridani typed it under', () => {
      bindings.set('surf-1', { runId: 'run-7', generation: 5, accepted: { generation: 4, at: 4000 } });
      claude('UserPromptSubmit', { prompt: 'steer' });
      expect(prompts[0]).toMatchObject({ run_id: 'run-7', generation: 4 });
    });

    it('is not emitted for an unbound surface', () => {
      bindings.delete('surf-1');
      claude('UserPromptSubmit', { prompt: 'local only' });
      claude('Stop', { lastAssistantMessage: 'x' });
      expect(prompts).toEqual([]);
      expect(turns[0]).toMatchObject({ prompt: 'local only', run_id: null });
    });

    it('is not emitted for a synthetic hand-back, a subagent prompt, an empty prompt, or an unknown surface', () => {
      claude('UserPromptSubmit', { prompt: 'real' });
      claude('Stop', { lastAssistantMessage: 'interim', backgroundTasks: '1' });
      claude('UserPromptSubmit', { prompt: '' });
      claude('UserPromptSubmit', { prompt: 'inside', agentId: 'agent-1' });
      cap.hook('surf-unknown', { event: 'UserPromptSubmit', sessionId: 's', prompt: 'nowhere' });
      claude('UserPromptSubmit', { prompt: '<agent-message from="worker">done</agent-message>' });
      claude('Stop', { lastAssistantMessage: 'final' });
      expect(prompts.map((p) => p.text)).toEqual(['real']);
      // The interim turn pairs with the prompt; the hand-back's turn is a later seq with no prompt frame of its own.
      expect(turns.map((t) => [t.seq, t.interim ?? false, t.synthetic ?? false])).toEqual([[1, true, false], [2, false, true]]);
      expect(prompts[0].seq).toBe(1);
    });

    it('is not emitted when nobody listens (no prompt dependency), and the turn is unchanged', () => {
      cap = fresh(false);
      claude('UserPromptSubmit', { prompt: 'quiet' });
      claude('Stop', { lastAssistantMessage: 'x' });
      expect(prompts).toEqual([]);
      expect(turns[0]).toMatchObject({ prompt: 'quiet', seq: 1, run_id: 'run-7' });
    });

    it('clips at 4000 code points with the flag and redacts secrets, like the turn\'s prompt', () => {
      claude('UserPromptSubmit', { prompt: '😀'.repeat(4001) + ' sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123' });
      expect(Array.from(prompts[0].text)).toHaveLength(4000);
      expect(prompts[0].truncated).toBe(true);
      claude('Stop', { lastAssistantMessage: 'x' });
      expect(prompts[0].text).toBe(turns[0].prompt);
      claude('UserPromptSubmit', { prompt: 'use key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123 now' });
      expect(prompts[1].text).not.toContain('sk-ant-api03');
      expect(prompts[1].truncated).toBe(false);
    });
  });
});
