/**
 * Turn capture: each root agent turn's final response, from the Stop hook.
 *
 * The hook helper forwards `lastAssistantMessage` (Claude Code's and Codex's
 * `last_assistant_message`, cut at 16k with `lastAssistantTruncated`) and, for
 * Codex, `turnId`. This module turns that into exactly one `turn` per logical
 * provider turn (C15):
 *
 *   identity  Codex: its `turn_id`. Claude: the session id plus the number of
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
 * The cursor (which turn a conversation is on, recent ids) and the per-surface
 * `turnSeq` live in the registry, so a server restart neither repeats nor
 * skips a number.
 */
import fs from 'fs';
import path from 'path';
import { ERIDANI_LIMITS, truncateText, type SessionTool, type TurnBody } from '../../src/shared/eridani-link-protocol';
import type { SessionRecord, TurnCursor } from '../../src/shared/remote-host-protocol';
import { redact } from './collector/redact';

export type TurnFields = Omit<TurnBody, 't' | 'op_id' | 'digest'>;

const RECENT_IDS = 32;
const TAIL_BYTES = 512 * 1024;
const SESSION_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const TURN_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

export interface TurnCaptureDeps {
  session(id: string): SessionRecord | undefined;
  update(id: string, patch: Partial<SessionRecord>): void;
  emit(turn: TurnFields): void;
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
  private readonly prompts = new Map<string, { sessionId: string; text: string }>();
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
      cursor.opened += 1;
      this.prompts.set(surf, { sessionId, text: typeof params.prompt === 'string' ? params.prompt : '' });
      this.deps.update(surf, { turnCursor: cursor });
      return null;
    }

    // Stop. Which turn is ending?
    if (cursor.opened <= cursor.captured) {
      if (cursor.captured === 0) cursor.opened = 1; // never saw the turn open (server restarted mid-turn)
    }
    const n = Math.max(cursor.opened, 1);
    const codexTurn = provider === 'codex' && typeof params.turnId === 'string' && TURN_ID_RE.test(params.turnId) ? params.turnId : null;
    const turnId = codexTurn ?? `${sessionId}:${surf}:${n}`;
    if (cursor.recent.includes(turnId) || (!codexTurn && n <= cursor.captured)) {
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
    this.deps.emit({
      surf,
      incarnation: rec.incarnation ?? 0,
      run_id: null,
      generation: 0,
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
