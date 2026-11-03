/** Public assistant messages only. Complete snapshots replace partial snapshots; they are never turn history. */
import { transcriptText } from './managed-transcript';
import type { LiveOutputBody } from '../../src/shared/eridani-link-protocol';
export type LiveOutputSnapshot = Omit<LiveOutputBody, 'op_id' | 'digest'>;
interface Message { id: string; turn: string | null; generation: number; kind: 'commentary' | 'response'; raw: string; complete: boolean; truncated: boolean; sequence: number; at: number }
export interface OutputState { sequence: number; serial: number; messages: Message[]; claude?: string; codex?: string }
export const emptyOutput = (): OutputState => ({ sequence: 0, serial: 0, messages: [] });
export class ManagedOutput {
  private timer: NodeJS.Timeout | undefined;
  private dirty = new Set<string>();
  constructor(readonly state: OutputState, private readonly context: () => { run_id: string; generation: number; surf: string; incarnation: number; session_id: string; turn_id: string | null }, private readonly persist: () => void, private readonly emit: (body: LiveOutputSnapshot) => void, private readonly failed: (error: unknown) => void = () => {}) {}
  private update(id: string, text: string | undefined, complete: boolean, replace = false, kind?: Message['kind']): void {
    const context = this.context(); if (!context.session_id || !id) return;
    let message = this.state.messages.find(message => message.id === id && message.turn === context.turn_id && message.generation === context.generation);
    if (!message) { message = { id, turn: context.turn_id, generation: context.generation, kind: kind ?? 'response', raw: '', complete: false, truncated: false, sequence: 0, at: 0 }; this.state.messages.push(message); }
    if (kind) message.kind = kind;
    if (text !== undefined) { const raw = replace ? text : message.raw + text; message.raw = raw.slice(0, 32768); message.truncated ||= raw.length > 32768; }
    message.complete ||= complete; this.dirty.add(id);
    while (this.state.messages.length > 32 || this.state.messages.reduce((size, entry) => size + Buffer.byteLength(entry.raw), 0) > 128 * 1024) { if (this.state.messages.length <= 1) break; this.state.messages.shift(); }
    if (complete) this.flush(); else if (!this.timer) { this.timer = setTimeout(() => { try { this.flush(); } catch (error) { this.failed(error); } }, 200); this.timer.unref?.(); }
  }
  private snapshot(message: Message): LiveOutputSnapshot {
    const context = this.context();
    return { t: 'output.live', ...context, generation: message.generation, turn_id: message.turn, message_id: message.id, sequence: message.sequence, at: message.at, kind: message.kind, text: this.publicText(message).slice(0, 32768), complete: message.complete, truncated: message.truncated };
  }
  private publicText(message: Message): string {
    const text = transcriptText(message.raw);
    // A token can cross snapshot boundaries. Mask recognizable unfinished credential prefixes before publishing any suffix.
    return message.complete ? text : text.replace(/(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]*|gh[pousr]_[A-Za-z0-9]*|github_pat_[A-Za-z0-9_]*|AKIA[0-9A-Z]*|xox[abpr]-[A-Za-z0-9-]*|eri_bot_[A-Za-z0-9_-]*|lin_api_[A-Za-z0-9]*|[Bb]earer\s+\S*|(?:[Pp]assword|[Ss]ecret|[Tt]oken|[Aa]pi_[Kk]ey)\s*[=:]\s*\S*)$/g, '[redacted]');
  }
  flush(): void {
    if (this.timer) clearTimeout(this.timer); this.timer = undefined;
    const messages = this.state.messages.filter(message => this.dirty.has(message.id)); if (!messages.length) return;
    for (const message of messages) { message.sequence = ++this.state.sequence; message.at = Date.now(); }
    this.persist(); this.dirty.clear(); for (const message of messages) this.emit(this.snapshot(message));
  }
  replay(): void { this.flush(); for (const message of this.state.messages) if (message.sequence) this.emit(this.snapshot(message)); }
  event(message: Record<string, any>): void {
    const p = message.params ?? {}, item = p.item;
    if (message.method === 'item/started' && item?.type === 'agentMessage') { this.state.codex = item.id; this.update(item.id, undefined, false, false, item.phase === 'commentary' ? 'commentary' : 'response'); }
    if (message.method === 'item/agentMessage/delta') { const id = p.itemId ?? this.state.codex ?? `assistant:${this.context().turn_id ?? ++this.state.serial}`; this.state.codex = id; this.update(id, String(p.delta ?? ''), false); }
    if (message.method === 'item/completed' && item?.type === 'agentMessage') { const current = this.state.messages.find(entry => entry.id === this.state.codex); const id = item.id ?? (current?.complete ? `assistant:${++this.state.serial}` : this.state.codex) ?? `assistant:${++this.state.serial}`; this.state.codex = id; this.update(id, String(item.text ?? ''), true, true, item.phase === 'commentary' ? 'commentary' : undefined); }
    if (message.type === 'stream_event') {
      const event = message.event;
      if (event?.type === 'message_start') { this.state.claude = event.message?.id ?? `claude:${++this.state.serial}`; const text = (event.message?.content ?? []).filter((block: any) => block.type === 'text').map((block: any) => block.text).join(''); if (text) this.update(this.state.claude!, text, false, true); }
      if (event?.delta?.type === 'text_delta') this.update(this.state.claude ?? (this.state.claude = `claude:${++this.state.serial}`), String(event.delta.text ?? ''), false);
      if (event?.type === 'message_stop' && this.state.claude) this.update(this.state.claude, undefined, true);
    }
    if (message.type === 'assistant') { const text = (message.message?.content ?? []).filter((block: any) => block.type === 'text').map((block: any) => block.text).join(''); if (text) { const id = message.message?.id ?? this.state.claude ?? `claude:${++this.state.serial}`; this.state.claude = id; this.update(id, text, true, true); } }
    if (message.type === 'result' && typeof message.result === 'string' && message.result) { const id = this.state.claude ?? `claude:${++this.state.serial}`; const current = this.state.messages.find(entry => entry.id === id); if (!current || current.raw !== message.result) this.update(current?.complete ? `result:${this.context().turn_id ?? ++this.state.serial}` : id, message.result, true, true); }
    if (message.method === 'turn/completed' || message.type === 'result') this.flush();
  }
}
