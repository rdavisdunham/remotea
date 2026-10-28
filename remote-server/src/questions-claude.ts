/**
 * Claude Code's AskUserQuestion, answered from Eridani (decision 10, C07, F04).
 *
 * Verified on Claude Code 2.1.312 (spike-stage-a/capability-matrix.md):
 *
 *   PreToolUse(AskUserQuestion) → a hook that HOLDS, then prints
 *     {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow",
 *      "updatedInput":{"questions":<echo>,"answers":{"<question text>":"<label>"}}}}
 *   is accepted for single choice, multi-select ("Apple, Cherry"), free text
 *   and several questions per call. While it holds the TUI does NOT show the
 *   question. PostToolUse for the same `tool_use_id` echoes
 *   `tool_response.answers` (the acceptance signal); a locally answered call
 *   also carries `tool_response.annotations`.
 *
 * The hook helper (wmux-hook.js `--event AskUserQuestion`) asks the bridge
 * (`remotea.question`) and this broker holds the request:
 *
 *   held       `question` sent up; the pane is needs_you
 *   submitted  an `answer` was handed to the hook (the answer command's
 *              outcome is `executed`); not yet proof
 *   accepted   PostToolUse for that tool_use_id echoed the answers
 *   timed_out  the hold ended (remotea gives up QUESTION_HOLD before Claude's
 *              hook timeout): the hook printed nothing, the terminal now shows
 *              the question. NOT a resolution: still_open, remote answering off
 *   answered_locally  a PostToolUse with `annotations` after a timeout
 *   canceled   the hook process died early (Esc in the terminal: Claude kills
 *              it and fires no event), the process exited, or a timed-out
 *              question was followed by a new prompt with no answer
 *   failed     the answer could not reach the hook (it had already gone)
 *
 * Protections kept from the app (C07): a hook fired inside a subagent
 * (`agent_id`: the prompt-suggestion fork asks phantom questions) is never
 * held or published; only an Eridani-bound surface holds (a person at the
 * keyboard of any other pane sees the question at once, as before); a
 * background tool finishing never clears the question (agent-state.ts rules
 * are untouched, and this broker only sets/clears needs_you itself); the
 * first answer wins and any later one is `stale`.
 */
import crypto from 'crypto';
import { ERIDANI_LIMITS, ERIDANI_TIMING, type AnswerCommand, type QuestionBody, type QuestionItem, type QuestionOutcome, type QuestionResolvedBody } from '../../src/shared/eridani-link-protocol';
import type { SessionRecord } from '../../src/shared/remote-host-protocol';

type Up<T> = Omit<T, 'op_id' | 'digest'>;

export interface QuestionTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
}

export interface QuestionBrokerDeps {
  session(id: string): SessionRecord | undefined;
  /** May this surface's question be held for Eridani (bound to a run, link up)? */
  canHold(id: string): boolean;
  emit(body: Up<QuestionBody> | Up<QuestionResolvedBody>): void;
  /** Set (reason) or clear (null) the pane's needs_you. */
  needsYou(id: string, reason: string | null): void;
  timers?: QuestionTimers;
  now?: () => number;
  /** How long to hold before giving the question back to the terminal. */
  holdMs?: number;
  /** Claude's own timeout for this hook (claude-hooks.ts), to tell a timeout from an Esc. */
  hookTimeoutMs?: number;
  log?: (m: string) => void;
}

export type HoldReply = { answers: Record<string, string>; questions: unknown[] } | { reason: string };

type QState = 'held' | 'submitted' | 'timed_out' | QuestionOutcome;

interface Held {
  id: string;
  surf: string;
  generation: number;
  toolUseId: string;
  items: QuestionItem[];
  /** item id → the question text Claude keys answers by. */
  keys: Map<string, string>;
  questions: unknown[];
  openedAt: number;
  state: QState;
  submitted: Record<string, string> | null;
  reply: ((r: HoldReply) => void) | null;
  timer: unknown;
}

const realTimers: QuestionTimers = {
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  },
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
};

const TOOL_USE_RE = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_ITEMS = 8;
const MAX_CHOICES = 16;
const OPEN: ReadonlySet<QState> = new Set(['held', 'submitted', 'timed_out']);

/** AskUserQuestion's `questions` → items. Null when the shape is not one we can answer. */
export function toItems(questions: unknown): QuestionItem[] | null {
  if (!Array.isArray(questions) || !questions.length || questions.length > MAX_ITEMS) return null;
  const items: QuestionItem[] = [];
  const seen = new Set<string>();
  for (const [i, q] of questions.entries()) {
    const o = q as Record<string, unknown>;
    if (!o || typeof o.question !== 'string' || !o.question.trim() || o.question.length > ERIDANI_LIMITS.questionTextChars) return null;
    if (seen.has(o.question)) return null; // answers are keyed by text: two equal texts are unanswerable
    seen.add(o.question);
    const options = Array.isArray(o.options) ? o.options.slice(0, MAX_CHOICES) : [];
    const choices = options
      .map((opt, j) => {
        const p = opt as Record<string, unknown>;
        if (!p || typeof p.label !== 'string' || !p.label) return null;
        return { id: `c${j + 1}`, label: p.label.slice(0, 500), ...(typeof p.description === 'string' && p.description ? { description: p.description.slice(0, 1000) } : {}) };
      })
      .filter((c): c is NonNullable<typeof c> => !!c);
    items.push({
      id: `q${i + 1}`,
      text: o.question,
      ...(typeof o.header === 'string' && o.header ? { header: o.header.slice(0, 100) } : {}),
      ...(choices.length ? { choices } : {}),
      ...(o.multiSelect === true ? { multi: true } : {}),
    });
  }
  return items;
}

/**
 * An `answer` → Claude's `answers` map. Every item must be answered; choice
 * ids must exist; a single-choice item takes one choice. Labels of a
 * multi-select are comma-joined (as Claude does); free text follows them.
 */
export function buildAnswers(items: QuestionItem[], answers: AnswerCommand['answers']): { answers: Record<string, string> } | { error: string } {
  const byId = new Map(answers.map((a) => [a.item_id, a]));
  if (byId.size !== answers.length) return { error: 'an item is answered twice' };
  for (const a of answers) if (!items.some((it) => it.id === a.item_id)) return { error: `unknown item ${a.item_id}` };
  const out: Record<string, string> = {};
  for (const it of items) {
    const a = byId.get(it.id);
    if (!a) return { error: `item ${it.id} is not answered` };
    const labels: string[] = [];
    for (const cid of a.choice_ids ?? []) {
      const c = it.choices?.find((x) => x.id === cid);
      if (!c) return { error: `unknown choice ${cid} for ${it.id}` };
      if (!labels.includes(c.label)) labels.push(c.label);
    }
    if (labels.length > 1 && !it.multi) return { error: `${it.id} takes one choice` };
    const text = typeof a.text === 'string' ? a.text.replace(/\s+/g, ' ').trim() : '';
    const value = [...labels, ...(text ? [text] : [])].join(', ');
    if (!value) return { error: `item ${it.id} is empty` };
    out[it.text] = value;
  }
  return { answers: out };
}

export class QuestionBroker {
  private readonly byId = new Map<string, Held>();
  private readonly timers: QuestionTimers;
  private readonly now: () => number;
  private readonly holdMs: number;
  private readonly hookTimeoutMs: number;

  constructor(private readonly deps: QuestionBrokerDeps) {
    this.timers = deps.timers ?? realTimers;
    this.now = deps.now ?? Date.now;
    this.holdMs = deps.holdMs ?? ERIDANI_TIMING.questionHoldMs;
    this.hookTimeoutMs = deps.hookTimeoutMs ?? ERIDANI_TIMING.questionHookTimeoutS * 1000;
  }

  /** Open question ids on a surface (for sessions.snapshot). */
  openIds(surf: string): string[] {
    return [...this.byId.values()].filter((q) => q.surf === surf && OPEN.has(q.state)).map((q) => q.id);
  }

  get(id: string): { state: QState; surf: string; toolUseId: string } | undefined {
    const q = this.byId.get(id);
    return q ? { state: q.state, surf: q.surf, toolUseId: q.toolUseId } : undefined;
  }

  /**
   * The hook helper asks to hold an AskUserQuestion. Resolves with the
   * answers to print, or a reason to print nothing. `closed` registers a
   * callback for the helper's connection going away.
   */
  hold(surf: string, p: Record<string, unknown>, closed: (cb: () => void) => void): Promise<HoldReply> {
    if (typeof p.agentId === 'string' && p.agentId) return Promise.resolve({ reason: 'subagent' });
    const toolUseId = typeof p.toolUseId === 'string' && TOOL_USE_RE.test(p.toolUseId) ? p.toolUseId : '';
    const sessionId = typeof p.sessionId === 'string' ? p.sessionId : '';
    if (!toolUseId || !sessionId) return Promise.resolve({ reason: 'incomplete' });
    if (!this.deps.canHold(surf)) return Promise.resolve({ reason: 'not-remote' });
    const items = toItems(p.questions);
    if (!items) return Promise.resolve({ reason: 'unsupported-shape' });
    if ([...this.byId.values()].some((q) => q.toolUseId === toolUseId && OPEN.has(q.state))) return Promise.resolve({ reason: 'duplicate' });
    const rec = this.deps.session(surf);
    if (!rec?.eridani) return Promise.resolve({ reason: 'not-remote' });
    // F07: the generation of the turn that asked, bound at its prompt.
    const cursor = rec.turnCursor;
    const generation = cursor && cursor.sessionId === sessionId && cursor.generation !== undefined ? cursor.generation : rec.eridani.generation;
    const promptId = typeof p.promptId === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(p.promptId) ? p.promptId : null;

    return new Promise<HoldReply>((resolve) => {
      const q: Held = {
        id: crypto.randomUUID(),
        surf,
        generation,
        toolUseId,
        items,
        keys: new Map(items.map((it) => [it.id, it.text])),
        questions: p.questions as unknown[],
        openedAt: this.now(),
        state: 'held',
        submitted: null,
        reply: resolve,
        timer: null,
      };
      this.byId.set(q.id, q);
      q.timer = this.timers.setTimeout(() => this.timeout(q, 'remotea stopped holding; the question is in the terminal now'), this.holdMs);
      closed(() => this.helperGone(q));
      this.deps.emit({
        t: 'question',
        question_id: q.id,
        surf,
        incarnation: rec.incarnation ?? 0,
        run_id: rec.eridani!.runId,
        generation,
        provider: 'claude',
        provider_session_id: sessionId,
        provider_request_id: toolUseId,
        provider_turn_id: promptId,
        kind: 'ask',
        group_id: toolUseId,
        items,
        hold_until: q.openedAt + this.holdMs,
      });
      this.deps.needsYou(surf, `Question: ${items[0].text}`);
      this.deps.log?.(`question ${q.id} held for ${surf} (${items.length} item(s))`);
    });
  }

  /** Fence for an `answer` before it is accepted. */
  precheck(cmd: AnswerCommand): string | null {
    const q = this.byId.get(cmd.question_id);
    if (!q) return 'unknown question';
    if (q.toolUseId !== cmd.provider_request_id) return 'provider_request_id does not match';
    if (q.state === 'timed_out') return 'remote answering is off: the question is in the terminal';
    if (q.state !== 'held') return 'stale';
    const built = buildAnswers(q.items, cmd.answers);
    return 'error' in built ? built.error : null;
  }

  /** Hand an answer to the held hook. The first one wins; the hand-off is `submitted`, not proof. */
  answer(cmd: AnswerCommand, begin: () => void): { state: 'executed' | 'failed' | 'rejected'; detail?: string; result?: Record<string, unknown> } {
    const pre = this.precheck(cmd);
    if (pre) return { state: 'rejected', detail: pre };
    const q = this.byId.get(cmd.question_id)!;
    const built = buildAnswers(q.items, cmd.answers) as { answers: Record<string, string> };
    begin();
    if (!q.reply) {
      this.settle(q, 'failed', 'the hook had already gone');
      return { state: 'failed', detail: 'the hook had already gone' };
    }
    this.timers.clearTimeout(q.timer);
    q.state = 'submitted';
    q.submitted = built.answers;
    const reply = q.reply;
    q.reply = null;
    reply({ answers: built.answers, questions: q.questions });
    this.deps.needsYou(q.surf, null);
    return { state: 'executed', result: { question_id: q.id, state: 'submitted' } };
  }

  /** A relayed hook event: PostToolUse confirms; a new prompt or the process exiting ends what is left. */
  hook(surf: string, params: Record<string, unknown>): void {
    const event = typeof params.event === 'string' ? params.event : '';
    const tool = typeof params.tool === 'string' ? params.tool : '';
    if (!event && tool === 'AskUserQuestion' && typeof params.toolUseId === 'string') {
      const q = [...this.byId.values()].find((x) => x.surf === surf && x.toolUseId === params.toolUseId);
      if (!q || !OPEN.has(q.state)) return;
      if (params.annotations === '1' || q.state === 'timed_out') this.settle(q, 'answered_locally', undefined, parseEcho(params.answerEcho));
      else if (q.state === 'submitted') this.settle(q, 'accepted', undefined, parseEcho(params.answerEcho) ?? q.submitted ?? undefined);
      return;
    }
    if (event === 'UserPromptSubmit' && !params.agentId) {
      // A new turn began: a question the terminal was showing was declined (Esc fires nothing else).
      for (const q of this.byId.values()) if (q.surf === surf && q.state === 'timed_out') this.settle(q, 'canceled', 'a new prompt arrived without an answer');
    }
  }

  surfaceExited(surf: string): void {
    for (const q of this.byId.values()) if (q.surf === surf && OPEN.has(q.state)) this.settle(q, 'canceled', 'the process exited');
  }

  private timeout(q: Held, detail: string): void {
    if (q.state !== 'held') return;
    q.state = 'timed_out';
    const reply = q.reply;
    q.reply = null;
    reply?.({ reason: 'timeout' });
    this.emitResolved(q, 'timed_out', true, detail);
  }

  /** The helper's connection closed while we still held it: Claude's timeout, or an Esc. */
  private helperGone(q: Held): void {
    if (q.state !== 'held') return;
    q.reply = null;
    this.timers.clearTimeout(q.timer);
    if (this.now() - q.openedAt >= this.hookTimeoutMs - 5_000) this.timeout(q, 'the hook timed out; the question is in the terminal now');
    else this.settle(q, 'canceled', 'the question was dismissed in the terminal');
  }

  private settle(q: Held, outcome: QuestionOutcome, detail?: string, echo?: Record<string, string>): void {
    if (!OPEN.has(q.state)) return;
    this.timers.clearTimeout(q.timer);
    q.state = outcome;
    q.reply = null;
    this.emitResolved(q, outcome, false, detail, echo);
    if (outcome !== 'accepted') this.deps.needsYou(q.surf, null);
    // Kept a while for late duplicates (stale answers), then forgotten.
    this.timers.setTimeout(() => this.byId.delete(q.id), 10 * 60_000);
  }

  private emitResolved(q: Held, outcome: QuestionOutcome, stillOpen: boolean, detail?: string, echo?: Record<string, string>): void {
    this.deps.emit({
      t: 'question.resolved',
      question_id: q.id,
      generation: q.generation,
      outcome,
      still_open: stillOpen,
      remote_answerable: false,
      ...(detail ? { detail } : {}),
      ...(echo ? { answer_echo: echo } : {}),
    });
    this.deps.log?.(`question ${q.id}: ${outcome}${stillOpen ? ' (still open in the terminal)' : ''}`);
  }
}

function parseEcho(v: unknown): Record<string, string> | undefined {
  if (typeof v !== 'string' || !v) return undefined;
  try {
    const o = JSON.parse(v) as unknown;
    if (!o || typeof o !== 'object' || Array.isArray(o)) return undefined;
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(o as Record<string, unknown>)) if (typeof val === 'string') out[k.slice(0, 4000)] = val.slice(0, 4000);
    return out;
  } catch {
    return undefined;
  }
}
