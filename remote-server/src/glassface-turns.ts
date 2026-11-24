import { randomUUID } from 'node:crypto';
import type { GlassfaceTurn, SessionRecord } from '../../src/shared/remote-host-protocol';
import type { TurnFields } from './turn-capture';

interface Captured {
  summary: GlassfaceTurn;
  task: string;
  reply: string;
  question: string;
  bootId: string;
  incarnation: number;
  provider: string;
  conversation: string;
  seq: number;
  revision: number;
  since: number;
}

/** Root Stop hooks carry a redacted prompt and final response for the same turn.
 * A permission notification or a question tool is a different, still-running turn. */
export class GlassfaceTurns {
  private readonly sentences = new Intl.Segmenter('en', { granularity: 'sentence' });
  private readonly latest = new Map<string, Captured>();

  capture(turn: TurnFields, rec: SessionRecord, revision: number): void {
    this.latest.delete(turn.surf);
    if (turn.interim || turn.synthetic || turn.missing || !turn.root || turn.run_id ||
        !rec.bootId || !rec.incarnation || rec.incarnation !== turn.incarnation ||
        rec.agentState?.state !== 'idle' || rec.agentState.trouble ||
        rec.agent?.provider !== turn.provider || rec.agent.sessionId !== turn.provider_session_id) return;
    const reply = turn.text.trim();
    if (!reply) return;
    const lastParagraph = reply.split(/\n\s*\n/u).at(-1)!.trim();
    // A quoted example or a code block ending in "?" is not an instruction to ask the wearer.
    const lastSentence = Array.from(this.sentences.segment(lastParagraph)).at(-1)?.segment.trim() || '';
    const question = !turn.truncated && lastSentence.length <= 1000 &&
      !/^(?:>|\x60{3}|~~~)/u.test(lastParagraph) && /[?？]$/u.test(lastSentence) ? lastSentence : '';
    const summary: GlassfaceTurn = { id: randomUUID(), kind: question ? 'question' : 'finished', endedAt: turn.ended_at };
    const clipped = reply.length > 3200 ? reply.slice(0, 1600) + '\n…\n' + reply.slice(-1500) : reply;
    this.latest.set(turn.surf, { summary, task: (turn.prompt || '').slice(0, 1000), reply: clipped, question,
      bootId: rec.bootId, incarnation: turn.incarnation, provider: turn.provider, conversation: turn.provider_session_id,
      seq: turn.seq, revision, since: rec.agentState.since });
    if (this.latest.size > 256) this.latest.delete(this.latest.keys().next().value!);
  }

  current(rec: SessionRecord, revision: number): Captured | undefined {
    const value = this.latest.get(rec.id);
    if (!value || rec.state !== 'live' || rec.eridani || rec.agentState?.trouble || rec.agentState?.state !== 'idle' ||
        rec.agentState.since !== value.since || rec.bootId !== value.bootId || rec.incarnation !== value.incarnation ||
        rec.agent?.provider !== value.provider || rec.agent.sessionId !== value.conversation ||
        rec.turnSeq !== value.seq || rec.turnCursor?.sessionId !== value.conversation ||
        rec.turnCursor.opened !== rec.turnCursor.captured || value.revision !== revision) return;
    return value;
  }
}
