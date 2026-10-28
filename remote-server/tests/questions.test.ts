import { describe, expect, it } from 'vitest';
import { QuestionBroker, buildAnswers, toItems, type HoldReply } from '../src/questions-claude';
import type { SessionRecord } from '../../src/shared/remote-host-protocol';
import type { AnswerCommand } from '../../src/shared/eridani-link-protocol';
import { ManualTimers } from './helpers';

// AskUserQuestion's tool_input.questions, as stage A recorded it.
const QUESTIONS = [
  { question: 'Which fruits do you like?', header: 'Fruits', options: [{ label: 'Apple', description: 'Apple' }, { label: 'Pear', description: 'Pear' }], multiSelect: true },
  { question: 'Which city should we use?', header: 'City', options: [{ label: 'Paris', description: '' }, { label: 'Oslo', description: '' }], multiSelect: false },
];

const REC = {
  id: 'surf-1',
  incarnation: 2,
  eridani: { runId: 'run-1', generation: 4 },
  turnCursor: { sessionId: 'sess-1', generation: 3 },
} as unknown as SessionRecord;

function setup(opts: { canHold?: boolean } = {}) {
  const timers = new ManualTimers();
  const emitted: Array<Record<string, unknown>> = [];
  const needs: Array<string | null> = [];
  const broker = new QuestionBroker({
    session: (id) => (id === 'surf-1' ? REC : undefined),
    canHold: () => opts.canHold ?? true,
    emit: (b) => emitted.push(b as unknown as Record<string, unknown>),
    needsYou: (_id, r) => needs.push(r),
    timers,
    now: () => timers.now,
    holdMs: 570_000,
    hookTimeoutMs: 600_000,
  });
  let onClose: (() => void) | null = null;
  const hold = (p: Record<string, unknown> = {}) =>
    broker.hold('surf-1', { toolUseId: 'toolu_1', sessionId: 'sess-1', promptId: 'p-1', questions: QUESTIONS, ...p }, (cb) => (onClose = cb));
  const answer = (over: Partial<AnswerCommand> = {}): AnswerCommand => ({
    t: 'answer',
    op_id: 'op-a',
    digest: 'd',
    question_id: emitted.find((e) => e.t === 'question')!.question_id as string,
    provider_request_id: 'toolu_1',
    answers: [{ item_id: 'q1', choice_ids: ['c1', 'c2'] }, { item_id: 'q2', choice_ids: ['c2'] }],
    expires_at: 1e15,
    ...over,
  } as AnswerCommand);
  return { broker, timers, emitted, needs, hold, answer, close: () => onClose?.() };
}

describe('questions-claude', () => {
  it('maps AskUserQuestion to items and builds Claude\'s answers map (multi-select comma-joined)', () => {
    const items = toItems(QUESTIONS)!;
    expect(items[0]).toMatchObject({ id: 'q1', text: 'Which fruits do you like?', header: 'Fruits', multi: true, choices: [{ id: 'c1', label: 'Apple' }, { id: 'c2', label: 'Pear' }] });
    expect(buildAnswers(items, [{ item_id: 'q1', choice_ids: ['c1', 'c2'] }, { item_id: 'q2', text: 'Bergen' }])).toEqual({
      answers: { 'Which fruits do you like?': 'Apple, Pear', 'Which city should we use?': 'Bergen' },
    });
    expect(buildAnswers(items, [{ item_id: 'q1', choice_ids: ['c1'] }])).toEqual({ error: 'item q2 is not answered' });
    expect(buildAnswers(items, [{ item_id: 'q1', choice_ids: ['c1'] }, { item_id: 'q2', choice_ids: ['c1', 'c2'] }])).toEqual({ error: 'q2 takes one choice' });
    expect(toItems([{ question: 'same' }, { question: 'same' }])).toBeNull();
  });

  it('holds, emits question with the turn\'s generation, and a submitted answer releases the hook', async () => {
    const { broker, emitted, needs, hold, answer } = setup();
    const p = hold();
    const q = emitted[0];
    expect(q).toMatchObject({ t: 'question', surf: 'surf-1', incarnation: 2, run_id: 'run-1', generation: 3, provider: 'claude', provider_session_id: 'sess-1', provider_request_id: 'toolu_1', provider_turn_id: 'p-1', kind: 'ask', group_id: 'toolu_1' });
    expect(needs[0]).toMatch(/^Question: Which fruits/);
    let begun = false;
    expect(broker.answer(answer(), () => (begun = true))).toMatchObject({ state: 'executed', result: { state: 'submitted' } });
    expect(begun).toBe(true);
    const reply = (await p) as Extract<HoldReply, { answers: unknown }>;
    expect(reply.answers).toEqual({ 'Which fruits do you like?': 'Apple, Pear', 'Which city should we use?': 'Oslo' });
    expect(reply.questions).toBe(QUESTIONS);
    // PostToolUse with the same tool_use_id confirms.
    broker.hook('surf-1', { tool: 'AskUserQuestion', toolUseId: 'toolu_1', answerEcho: JSON.stringify(reply.answers) });
    expect(emitted.at(-1)).toMatchObject({ t: 'question.resolved', outcome: 'accepted', still_open: false, remote_answerable: false, answer_echo: reply.answers });
  });

  it('the first answer wins; a second is stale', () => {
    const { broker, hold, answer } = setup();
    void hold();
    broker.answer(answer(), () => {});
    expect(broker.precheck(answer({ op_id: 'op-b' }))).toBe('stale');
  });

  it('skips subagent calls, non-remote surfaces and duplicates', async () => {
    const { hold, emitted } = setup();
    expect(await hold({ agentId: 'a1' })).toEqual({ reason: 'subagent' });
    void hold();
    expect(await hold()).toEqual({ reason: 'duplicate' });
    expect(emitted.filter((e) => e.t === 'question')).toHaveLength(1);
    const other = setup({ canHold: false });
    expect(await other.hold()).toEqual({ reason: 'not-remote' });
  });

  it('gives the question back to the terminal at the hold limit: timed_out, still open, then answered locally', async () => {
    const { broker, timers, emitted, hold, answer } = setup();
    const p = hold();
    timers.advance(570_000);
    expect(await p).toEqual({ reason: 'timeout' });
    expect(emitted.at(-1)).toMatchObject({ t: 'question.resolved', outcome: 'timed_out', still_open: true });
    expect(broker.precheck(answer())).toMatch(/terminal/);
    broker.hook('surf-1', { tool: 'AskUserQuestion', toolUseId: 'toolu_1', annotations: '1' });
    expect(emitted.at(-1)).toMatchObject({ outcome: 'answered_locally', still_open: false });
  });

  it('tells an Esc (hook killed early) from Claude\'s timeout by elapsed time', () => {
    const early = setup();
    void early.hold();
    early.timers.advance(10_000);
    early.close();
    expect(early.emitted.at(-1)).toMatchObject({ outcome: 'canceled', still_open: false });

    const late = setup();
    void late.hold();
    late.timers.now = 598_000;
    late.close();
    expect(late.emitted.at(-1)).toMatchObject({ outcome: 'timed_out', still_open: true });
    // A new prompt after a question the terminal showed: declined.
    late.broker.hook('surf-1', { event: 'UserPromptSubmit' });
    expect(late.emitted.at(-1)).toMatchObject({ outcome: 'canceled' });
  });

  it('the process exiting cancels an open question', () => {
    const { broker, hold, emitted } = setup();
    void hold();
    broker.surfaceExited('surf-1');
    expect(emitted.at(-1)).toMatchObject({ outcome: 'canceled' });
  });
});
