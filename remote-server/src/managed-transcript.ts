/** Display-only formatting for managed xterm sessions. Provider events and receipts remain unchanged. */
import { redact } from './collector/redact';

export const TRANSCRIPT_TOOL_LIMIT = 4_000;
const ASSISTANT_LIMIT = 256_000;

/** Text in a transcript is content, never terminal instructions (OSC52, cursor movement, hyperlinks, etc.). */
export function transcriptText(value: unknown): string {
  if (typeof value !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  const plain = value.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '').replace(/\x1b[P_^][\s\S]*?\x1b\\/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\x9b[0-?]*[ -/]*[@-~]/g, '').replace(/\x1b[@-_]/g, '').replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '');
  return redact(plain);
}

interface Message { raw: string; rendered: string; closed: boolean; clipped: boolean }
interface Tool { name: string; raw: string; clipped: boolean; summary: string; finished: boolean }
type ProviderEvent = Record<string, any>;

export class ManagedTranscript {
  private turn = 0;
  private channel = '';
  private atLineStart = true;
  private assistantKey = '';
  private toolKey = '';
  private serial = 0;
  private messages = new Map<string, Message>();
  private tools = new Map<string, Tool>();
  constructor(private readonly write: (text: string) => void, private readonly toolLimit = TRANSCRIPT_TOOL_LIMIT) {}

  private output(text: string): void {
    if (!text) return;
    this.write(text); this.atLineStart = text.endsWith('\n');
  }
  private line(): void { if (!this.atLineStart) this.output('\n'); }
  private heading(label: string, key: string): void {
    if (this.channel === key) return;
    this.line(); this.output(`\n── ${label} ──\n`); this.channel = key;
  }
  user(text: string): void {
    this.flushAssistant(); for (const [key, tool] of this.tools) if (!tool.finished) this.toolEnd(key, 'Output before next turn'); this.turn++;
    this.messages.clear(); this.tools.clear(); this.assistantKey = ''; this.toolKey = '';
    this.heading(`User · Turn ${this.turn}`, `user:${this.turn}`);
    this.output(transcriptText(text)); this.line();
  }
  notice(text: string): void {
    this.flushAssistant(); this.heading('Status', `notice:${++this.serial}`); this.output(transcriptText(text)); this.line();
  }

  private message(key?: string): [string, Message] {
    const id = key || this.assistantKey || `assistant:${++this.serial}`;
    this.assistantKey = id;
    if (!this.messages.has(id)) this.messages.set(id, { raw: '', rendered: '', closed: false, clipped: false });
    return [id, this.messages.get(id)!];
  }
  assistantDelta(text: string, key?: string): void {
    const [id, message] = this.message(key);
    if (message.closed || !text) return;
    const available = ASSISTANT_LIMIT - message.raw.length;
    message.raw += text.slice(0, Math.max(0, available)); message.clipped ||= text.length > available;
    this.renderAssistant(id, message, false);
  }
  assistantComplete(text: string, key?: string): void {
    const [id, message] = this.message(key);
    if (message.closed) return;
    if (!message.raw || text.startsWith(message.raw)) { message.raw = text.slice(0, ASSISTANT_LIMIT); message.clipped ||= text.length > ASSISTANT_LIMIT; }
    else if (text !== message.raw && !message.clipped) {
      // A final revision is explicitly labelled; it is never concatenated onto an earlier streamed version.
      if (message.rendered) { this.line(); this.channel = ''; this.heading('Assistant · Final version', `final:${id}`); }
      message.raw = text.slice(0, ASSISTANT_LIMIT); message.rendered = ''; message.clipped = text.length > ASSISTANT_LIMIT;
    }
    this.renderAssistant(id, message, true); message.closed = true; this.line();
  }
  private renderAssistant(id: string, message: Message, complete: boolean): void {
    // Redact the complete accumulated text before flushing lines, including keys and escapes split over chunks.
    const safe = transcriptText(message.raw);
    const visible = complete ? safe : safe.slice(0, safe.lastIndexOf('\n') + 1);
    if (visible.startsWith(message.rendered)) {
      const next = visible.slice(message.rendered.length);
      if (next) { this.heading('Assistant', `assistant:${id}`); this.output(next); message.rendered = visible; }
    }
    if (complete && message.clipped) { this.line(); this.output('[Further assistant text remains in the provider conversation]\n'); }
  }
  private flushAssistant(): void {
    if (!this.assistantKey) return;
    const message = this.messages.get(this.assistantKey);
    if (message && !message.closed) this.renderAssistant(this.assistantKey, message, true);
  }

  private toolName(name: string): string {
    return transcriptText(name).replace(/^mcp__eridani__/, 'Eridani · ').replace(/^mcp__[^_]+__/, '').replace(/_/g, ' ').slice(0, 100) || 'Tool';
  }
  private summary(input: unknown): string {
    if (!input || typeof input !== 'object') return typeof input === 'string' ? transcriptText(input).replace(/\s+/g, ' ').slice(0, 240) : '';
    const data = input as Record<string, unknown>;
    const value = [data.command, data.file_path, data.path, data.pattern, data.query, data.url].find(value => typeof value === 'string');
    return typeof value === 'string' ? transcriptText(value).replace(/\s+/g, ' ').slice(0, 240) : '';
  }
  toolStart(key: string, name: string, input?: unknown): void {
    this.flushAssistant(); this.toolKey = key;
    const summary = this.summary(input), existing = this.tools.get(key);
    if (existing) {
      if (summary && !existing.summary) { existing.summary = summary; this.heading(`Tool · ${existing.name}`, `tool:${key}`); this.output(`  ${summary}\n`); }
      return;
    }
    const tool = { name: this.toolName(name), summary, raw: '', clipped: false, finished: false }; this.tools.set(key, tool);
    this.heading(`Tool · ${tool.name}`, `tool:${key}`); if (summary) this.output(`  ${summary}\n`);
  }
  toolOutput(key: string, text: string): void {
    if (!this.tools.has(key)) this.toolStart(key, 'Command');
    const tool = this.tools.get(key)!;
    const available = this.toolLimit - tool.raw.length;
    tool.raw += text.slice(0, Math.max(0, available)); tool.clipped ||= text.length > available;
  }
  private readableResult(text: string): string {
    const safe = transcriptText(text).trim();
    if (!safe.startsWith('{') && !safe.startsWith('[')) return safe;
    try {
      const value = JSON.parse(safe);
      if (Array.isArray(value)) return `Structured result · ${value.length} items`;
      if (value && typeof value === 'object') {
        const note = [value.message, value.error, value.status].find(entry => typeof entry === 'string');
        return `${note ? transcriptText(note).slice(0, 400) + '\n' : ''}Structured result · ${Object.keys(value).length} fields`;
      }
    } catch { return 'Structured result · see the provider conversation for the full content'; }
    return safe;
  }
  toolEnd(key: string, status?: string, result?: string): void {
    if (!this.tools.has(key)) this.toolStart(key, 'Tool');
    const tool = this.tools.get(key)!; if (tool.finished) return; this.flushAssistant();
    if (result && !tool.raw) this.toolOutput(key, result);
    this.heading(`Tool · ${tool.name}`, `tool:${key}`);
    const body = this.readableResult(tool.raw);
    if (body) this.output(body.split('\n').slice(0, 40).map(line => `  │ ${line}`).join('\n') + '\n');
    if (tool.clipped || body.split('\n').length > 40) this.output('  [Further tool output hidden; preserved in the provider conversation]\n');
    if (status) this.output(`  [${transcriptText(status).slice(0, 120)}]\n`);
    tool.finished = true;
  }
  endTurn(finalText?: string): void {
    if (typeof finalText === 'string' && finalText) this.assistantComplete(finalText);
    else this.flushAssistant();
    for (const [key, tool] of this.tools) if (!tool.finished) this.toolEnd(key);
    this.line(); this.output('\n'); this.channel = '';
  }

  /** Provider protocol mapping only. No commands, approvals, prompts, or activity state are produced here. */
  event(message: ProviderEvent): void {
    const params = message.params ?? {}, item = params.item;
    if (message.method === 'item/agentMessage/delta') this.assistantDelta(String(params.delta ?? ''), params.itemId);
    if (message.method === 'item/started' && item?.type !== 'reasoning' && item?.type !== 'agentMessage') {
      const names: Record<string, string> = { commandExecution: 'Command', fileChange: 'Edit files', webSearch: 'Search', imageView: 'View image' };
      if (names[item?.type] || /ToolCall$/.test(item?.type ?? '')) this.toolStart(item.id ?? `tool:${++this.serial}`, item.tool ?? item.name ?? names[item.type] ?? 'Tool', item.arguments ?? item.input ?? (Array.isArray(item.changes) ? { path: item.changes.slice(0, 3).map((change: any) => change.path).filter(Boolean).join(', ') } : { command: item.command }));
    }
    if (message.method === 'item/commandExecution/outputDelta') this.toolOutput(params.itemId ?? this.toolKey, String(params.delta ?? ''));
    if (message.method === 'item/completed' && item?.type === 'agentMessage') this.assistantComplete(String(item.text ?? ''), item.id);
    if (message.method === 'item/completed' && item?.type !== 'agentMessage' && item?.type !== 'reasoning' && this.tools.has(item?.id ?? this.toolKey)) this.toolEnd(item?.id ?? this.toolKey, typeof item.exitCode === 'number' ? `Exit ${item.exitCode}` : item.status === 'failed' || item.error ? 'Failed' : 'Finished');
    if (message.method === 'turn/completed') this.endTurn();
    if (message.type === 'stream_event') {
      const event = message.event;
      if (event?.type === 'message_start') this.assistantKey = event.message?.id ?? `assistant:${++this.serial}`;
      if (event?.type === 'content_block_start' && event.content_block?.type === 'tool_use') this.toolStart(event.content_block.id ?? `tool:${++this.serial}`, event.content_block.name, event.content_block.input);
      if (event?.delta?.type === 'text_delta') this.assistantDelta(String(event.delta.text ?? ''));
    }
    if (message.type === 'assistant') {
      const blocks = message.message?.content ?? [], text = blocks.filter((block: any) => block.type === 'text').map((block: any) => block.text).join('');
      if (text) this.assistantComplete(text, message.message?.id);
      for (const block of blocks) if (block.type === 'tool_use') this.toolStart(block.id ?? `tool:${++this.serial}`, block.name, block.input);
    }
    if (message.type === 'user') for (const block of message.message?.content ?? []) if (block.type === 'tool_result') {
      const text = typeof block.content === 'string' ? block.content : Array.isArray(block.content) ? block.content.filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n') : '';
      this.toolEnd(block.tool_use_id, block.is_error ? 'Failed' : 'Finished', text);
    }
    if (message.type === 'result' && message.stop_reason !== 'tool_deferred') this.endTurn(typeof message.result === 'string' ? message.result : undefined);
  }
}
