import { beforeEach, describe, expect, it } from 'vitest';
import type { SessionRecord } from '../../src/shared/remote-host-protocol';
import { TurnCapture, isRolloutPath, rolloutFinalAnswer, type TurnFields } from '../src/turn-capture';

let recs: Map<string, SessionRecord>;
let turns: TurnFields[];
let tails: Record<string, string>;
let cap: TurnCapture;

function fresh(): TurnCapture {
  return new TurnCapture({
    session: (id) => recs.get(id),
    update: (id, patch) => recs.set(id, { ...recs.get(id)!, ...patch }),
    emit: (t) => turns.push(t),
    now: () => 5000,
    readTail: (file) => tails[file] ?? '',
  });
}

beforeEach(() => {
  recs = new Map([['surf-1', { id: 'surf-1', incarnation: 2 } as SessionRecord]]);
  turns = [];
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
});
