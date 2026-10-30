/**
 * Turn capture: each root agent turn's final response, from the Stop hook.
 *
 * The hook helper forwards `lastAssistantMessage` (Claude Code's and Codex's
 * `last_assistant_message`, cut at 16k with `lastAssistantTruncated`) and, for
 * Codex, `turnId`. This module turns that into exactly one `turn` per logical
 * provider turn (C15):
 *
 *   identity  Codex: its `turn_id`. Claude: its `prompt_id` (stage A: a UUID
 *             on UserPromptSubmit and Stop, unique per turn); for a hook
 *             helper too old to forward it, the session id plus the number of
 *             the turn within this surface's conversation, counted from
 *             UserPromptSubmit (the root Stop sequence). A second Stop for the
 *             same turn (a Stop hook that blocked and continued, a duplicate
 *             hook process) gets the SAME id and is dropped here; Eridani's
 *             unique (session, provider_turn_id) would drop it anyway.
 *   root      A Stop fired inside a subagent (`agentId`) or a SubagentStop is
 *             never a turn.
 *   fallback  Only when the hook carried no text: Codex's rollout tail, the
 *             last `agent_message` whose phase is `final_answer`. It is the
 *             same Stop and the same turn id, so it can never add a turn.
 *   text      Redacted with the collector's rules, then cut at 16k chars with
 *             `truncated` set. Never called a transcript.
 *
 *   generation  The run generation is bound when the turn's prompt is
 *             accepted (UserPromptSubmit): the generation of the input Eridani
 *             typed (persisted by dispatch before typing, `acceptedInput`,
 *             consumed here), else the run's current one. It is persisted on
 *             the cursor and stamped
 *             on the Stop that ends it, so a Stop arriving after a steer keeps
 *             the generation that produced it (F07). A synthetic hand-back
 *             prompt (`<agent-message from=…>`, a background subagent
 *             reporting) keeps the generation of the turn it belongs to.
 *   interim   A root Stop while background tasks still run is an interim
 *             answer (`interim: true`): the real one follows the hand-back.
 *   prompt    A root, non-synthetic UserPromptSubmit on a surface bound to a
 *             run is also emitted at once as a `prompt` (so Eridani's timeline
 *             shows it before the turn ends). Its `seq` is `turnSeq + 1`, the
 *             number the Stop that follows assigns to its turn, so
 *             `prompt.seq === turn.seq` for the turn (or interim turn) that
 *             answers it. The turn still carries `prompt` for older Eridanis.
 *
 * The cursor (which turn a conversation is on, recent ids) and the per-surface
 * `turnSeq` live in the registry, so a server restart neither repeats nor
 * skips a number.
 */
import fs from 'fs';
import path from 'path';
import { ERIDANI_LIMITS, truncateText, type PromptBody, type SessionTool, type TurnBody } from '../../src/shared/eridani-link-protocol';
import type { SessionRecord, TurnCursor } from '../../src/shared/remote-host-protocol';
import { redact } from './collector/redact';

export type TurnFields = Omit<TurnBody, 't' | 'op_id' | 'digest'>;
export type PromptFields = Omit<PromptBody, 't' | 'op_id' | 'digest'>;

const RECENT_IDS = 32;
/** How long an input Eridani typed may wait for the agent to accept it as a prompt (F07). */
export const ACCEPTED_INPUT_MS = 60_000;
const TAIL_BYTES = 512 * 1024;
const SESSION_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const TURN_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

export interface TurnCaptureDeps {
  session(id: string): SessionRecord | undefined;
  update(id: string, patch: Partial<SessionRecord>): void;
  emit(turn: TurnFields): void;
  /** A root prompt was submitted on a run-bound surface (absent: nobody wants prompts live). */
  prompt?(p: PromptFields): void;
  /** The Eridani run the surface serves now, or null. */
  binding?(id: string): { runId: string; generation: number; accepted?: { generation: number; at: number } } | null;
  /** The accepted input's generation was bound to a prompt: forget it. */
  consumeAccepted?(id: string): void;
  now?: () => number;
  /** Rollout reader (tests inject one). */
  readTail?: (file: string, bytes: number) => string;
  log?: (msg: string) => void;
}

function readTail(file: string, max: number): string {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, max);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const text = buf.toString('utf8');
    return len < size ? text.slice(text.indexOf('\n') + 1) : text;
  } catch {
    return '';
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** A Codex rollout file the hook named: only under a `.codex` folder, never anything else on disk. */
export function isRolloutPath(p: unknown): p is string {
  if (typeof p !== 'string' || p.length > 1024 || !path.isAbsolute(p) || !p.endsWith('.jsonl')) return false;
  const norm = path.normalize(p);
  return norm === p && norm.split(path.sep).includes('.codex');
}

/** The final answer of the last turn in a Codex rollout tail, or null. */
export function rolloutFinalAnswer(tail: string, turnId?: string): string | null {
  let found: string | null = null;
  let currentTurn: string | null = null;
  for (const line of tail.split('\n')) {
    if (!line.includes('agent_message') && !line.includes('turn_context') && !line.includes('task_started')) continue;
    let d: { type?: string; payload?: Record<string, unknown> };
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    const p = d.payload && typeof d.payload === 'object' ? d.payload : {};
    if (typeof p.turn_id === 'string') currentTurn = p.turn_id;
    if (d.type === 'event_msg' && p.type === 'agent_message' && p.phase === 'final_answer' && typeof p.message === 'string') {
      if (turnId && currentTurn && currentTurn !== turnId) continue;
      found = p.message;
    }
  }
  return found;
}

export class TurnCapture {
  /** The prompt that opened the current turn, per surface (memory only: the hook sends it at submit). */
  private readonly prompts = new Map<string, { sessionId: string; text: string; synthetic: boolean }>();
  private readonly now: () => number;

  constructor(private readonly deps: TurnCaptureDeps) {
    this.now = deps.now ?? Date.now;
  }

  /**
   * A relayed hook event for surface `surf`. Returns the conversation a turn
   * was captured for (so the caller can rescan that session), else null.
   */
  hook(surf: string, params: Record<string, unknown>): { provider: 'claude' | 'codex'; sessionId: string } | null {
    const event = typeof params.event === 'string' ? params.event : '';
    if (event !== 'UserPromptSubmit' && event !== 'Stop') return null;
    const provider = params.provider === 'codex' ? 'codex' : params.provider ? null : 'claude';
    const sessionId = typeof params.sessionId === 'string' && SESSION_RE.test(params.sessionId) ? params.sessionId : '';
    if (!provider || !sessionId) return null;
    // A subagent's own events are never the root turn.
    if (typeof params.agentId === 'string' && params.agentId) return null;
    const rec = this.deps.session(surf);
    if (!rec) return null;
    const cursor = this.cursorFor(rec, provider, sessionId);

    if (event === 'UserPromptSubmit') {
      const text = typeof params.prompt === 'string' ? params.prompt : '';
      const synthetic = /^\s*<agent-message from=/.test(text);
      cursor.opened += 1;
      if (!synthetic || cursor.generation === undefined) {
        const b = this.deps.binding?.(surf) ?? null;
        // F07: a prompt Eridani typed belongs to the generation it was accepted
        // under, even if the run moved on before the agent took it. A prompt
        // typed in the terminal (nothing accepted recently) takes the current one.
        const acc = b?.accepted && this.now() - b.accepted.at <= ACCEPTED_INPUT_MS ? b.accepted.generation : undefined;
        cursor.generation = acc ?? b?.generation ?? 0;
        cursor.runId = b?.runId ?? null;
        if (!synthetic && b?.accepted) this.deps.consumeAccepted?.(surf);
      }
      this.prompts.set(surf, { sessionId, text, synthetic });
      this.deps.update(surf, { turnCursor: cursor });
      if (!synthetic && cursor.runId && this.deps.prompt) {
        const cut = truncateText(redact(text), ERIDANI_LIMITS.promptChars);
        if (cut.text) {
          this.deps.prompt({
            surf,
            incarnation: rec.incarnation ?? 0,
            run_id: cursor.runId,
            generation: cursor.generation ?? 0,
            provider,
            tool: toolFor(provider),
            provider_session_id: sessionId,
            // The Stop that ends this turn assigns `turnSeq + 1`; nothing else advances turnSeq.
            seq: (rec.turnSeq ?? 0) + 1,
            text: cut.text,
            truncated: cut.truncated,
            at: typeof params.at === 'number' && Number.isFinite(params.at) ? params.at : this.now(),
          });
        }
      }
      return null;
    }

    // Stop. Which turn is ending?
    if (cursor.opened <= cursor.captured) {
      if (cursor.captured === 0) cursor.opened = 1; // never saw the turn open (server restarted mid-turn)
    }
    const n = Math.max(cursor.opened, 1);
    const providerTurn = typeof params.turnId === 'string' && TURN_ID_RE.test(params.turnId) ? params.turnId : null;
    const codexTurn = provider === 'codex' ? providerTurn : null;
    const turnId = providerTurn ?? `${sessionId}:${surf}:${n}`;
    if (cursor.recent.includes(turnId) || (!providerTurn && n <= cursor.captured)) {
      this.deps.log?.(`turn ${turnId}: duplicate Stop ignored`);
      return null;
    }

    let source: TurnFields['source'] = 'hook';
    let raw = typeof params.lastAssistantMessage === 'string' ? params.lastAssistantMessage : null;
    let truncated = params.lastAssistantTruncated === '1' || params.lastAssistantTruncated === true;
    if (!raw && provider === 'codex' && isRolloutPath(params.transcriptPath)) {
      const answer = rolloutFinalAnswer((this.deps.readTail ?? readTail)(params.transcriptPath, TAIL_BYTES), codexTurn ?? undefined);
      if (answer) {
        raw = answer;
        source = 'rollout';
        truncated = false;
      }
    }
    const cut = truncateText(redact(raw ?? ''), ERIDANI_LIMITS.turnTextChars);
    const pending = this.prompts.get(surf);
    this.prompts.delete(surf);
    const prompt = pending && pending.sessionId === sessionId ? truncateText(redact(pending.text), ERIDANI_LIMITS.promptChars) : null;

    cursor.captured = Math.max(cursor.captured, n);
    cursor.recent = [...cursor.recent, turnId].slice(-RECENT_IDS);
    const seq = (rec.turnSeq ?? 0) + 1;
    this.deps.update(surf, { turnCursor: cursor, turnSeq: seq });

    const at = typeof params.at === 'number' && Number.isFinite(params.at) ? params.at : this.now();
    const now = this.deps.binding?.(surf) ?? null;
    const bound = cursor.generation !== undefined ? { runId: cursor.runId ?? null, generation: cursor.generation } : { runId: now?.runId ?? null, generation: now?.generation ?? 0 };
    this.deps.emit({
      surf,
      incarnation: rec.incarnation ?? 0,
      run_id: bound.runId,
      generation: bound.generation,
      provider,
      tool: toolFor(provider),
      provider_session_id: sessionId,
      provider_turn_id: turnId,
      root: true,
      seq,
      text: cut.text,
      truncated: truncated || cut.truncated,
      missing: !raw,
      source,
      ...(prompt && prompt.text ? { prompt: prompt.text, prompt_truncated: prompt.truncated } : {}),
      ...(pending?.synthetic ? { synthetic: true } : {}),
      ...(params.backgroundTasks === '1' ? { interim: true } : {}),
      ended_at: at,
    });
    return { provider, sessionId };
  }

  private cursorFor(rec: SessionRecord, provider: string, sessionId: string): TurnCursor {
    const c = rec.turnCursor;
    if (c && c.provider === provider && c.sessionId === sessionId) return { ...c, recent: [...c.recent] };
    return { provider, sessionId, opened: 0, captured: 0, recent: [] };
  }
}

function toolFor(provider: 'claude' | 'codex'): SessionTool {
  return provider === 'codex' ? 'codex_cli' : 'claude_code';
}
