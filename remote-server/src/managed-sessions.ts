/** Durable ownership and decision journal for Eridani-created structured sessions. */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { EventEmitter } from 'events';
import { spawnPty } from './pty-spawn';
import type { PtyLike } from './pty-spawn';
import { CodexRuntimeAdapter, ClaudeRuntimeAdapter, type HarnessSpec, type HarnessRequest, type RuntimeAdapter } from './managed-harness';
import { writePrivate } from './eridani-mcp';
import { canonicalJson } from '../../src/shared/eridani-link-protocol';
import { redact } from './collector/redact';
import { buildAnswers, toItems, redactItem } from './questions-claude';
import type { AnswerCommand, QuestionBody, QuestionItem, ActivityBody } from '../../src/shared/eridani-link-protocol';
import type { CommandResult } from './eridani-link';

type Up = Omit<QuestionBody | ActivityBody, 'op_id' | 'digest'> | Record<string, unknown>;
export interface ManagedSpec extends HarnessSpec { surf: string; runId: string; generation: number; incarnation: number; prompt: string; operationId: string; planRevision?: number | null }
interface Decision { id: string; digest: string; request: HarnessRequest; items: QuestionItem[]; kind: 'ask' | 'approval'; state: 'pending' | 'submitted' | 'uncertain' | 'resolved'; sessionId: string; turnId: string | null; generation: number; response?: unknown; action?: QuestionBody['action'] }
interface Saved { initialization?: 'executing' | 'ready'; sessionId: string; turnId: string | null; sequence: number; paused: boolean; active: boolean; decisions: Decision[]; operations: Record<string, 'queued' | 'executing' | 'delivered' | 'uncertain'>; queue: Array<{ text: string; op: string; generation: number }> }
interface Entry { spec: ManagedSpec; state: Saved; adapter: RuntimeAdapter; terminal: ManagedTerminal; ready: Promise<void>; liveRequests: Map<string, HarnessRequest>; busy: boolean; persistenceError?: boolean; recovering?: boolean; pumping?: boolean; started?: boolean; finalText?: string; prompt?: { text: string; op: string; published: boolean }; waiters: Map<string, { resolve: (result: CommandResult) => void; begin: () => void }>; items: Map<string, any>; startupError?: Error; lastActivity?: { kind: string; label?: string; at: number }; handingOff?: boolean }
export interface ManagedDeps {
  dir: string | null; emit(body: Up): void; changed(surf: string, sessionId: string, paused: boolean): void;
  factory?: (spec: HarnessSpec) => RuntimeAdapter;
  hook?: (surf: string, params: Record<string, unknown>) => void;
}
export class ManagedTerminal extends EventEmitter implements PtyLike {
  private native: PtyLike | null = null;
  get pid(): number { return this.native?.pid ?? 0; }
  adoptNative(pty: PtyLike): void { this.native = pty; pty.onData((data) => this.emit('data', data)); pty.onExit((event) => this.emit('exit', event)); }
  onData(cb: (data: string) => void) { this.on('data', cb); return { dispose: () => this.off('data', cb) }; }
  onExit(cb: (e: { exitCode: number }) => void) { this.on('exit', cb); return { dispose: () => this.off('exit', cb) }; }
  write(data: string): void { this.native?.write(data); }
  resize(cols: number, rows: number): void { this.native?.resize(cols, rows); }
  pause(): void { this.native?.pause(); } resume(): void { this.native?.resume(); }
  kill(): void { if (this.native) this.native.kill(); else this.emit('stop'); }
  output(text: string): void { this.emit('data', text.replace(/\r?\n/g, '\r\n')); }
}
const digest = (v: unknown) => crypto.createHash('sha256').update(canonicalJson(v)).digest('hex');
const empty = (): Saved => ({ sessionId: '', turnId: null, sequence: 0, paused: false, active: false, decisions: [], operations: {}, queue: [] });
export class ManagedSessions {
  private entries = new Map<string, Entry>();
  private staged = new Map<string, ManagedSpec>();
  constructor(private readonly deps: ManagedDeps) {}
  private file(surf: string): string | null { return this.deps.dir ? path.join(this.deps.dir, 'managed', `${digest(surf)}.json`) : null; }
  private load(surf: string): Saved {
    const file = this.file(surf); if (!file) return empty();
    try { return { ...empty(), ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return empty(); throw new Error('managed state unreadable; refusing a new conversation'); }
  }
  private save(e: Entry): void {
    const file = this.file(e.spec.surf); if (!file) return;
    try { writePrivate(file, JSON.stringify(e.state)); const fd = fs.openSync(file, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } const parent = fs.openSync(path.dirname(file), 'r'); try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); } e.persistenceError = false; }
    catch (error) { e.persistenceError = true; throw error; }
  }
  prepare(spec: ManagedSpec): void { this.staged.set(spec.surf, spec); }
  has(surf: string): boolean { return this.entries.has(surf); }
  sessionId(surf: string): string { return this.entries.get(surf)?.state.sessionId ?? this.load(surf).sessionId; }
  pending(surf: string): string[] { return this.entries.get(surf)?.state.decisions.filter((q) => q.state !== 'resolved' && q.generation === this.entries.get(surf)?.spec.generation).map((q) => q.id) ?? []; }
  spawn(surf: string): PtyLike | undefined {
    const spec = this.staged.get(surf); if (!spec) return undefined;
    this.staged.delete(surf);
    const state = this.load(surf);
    const recovered = !!state.sessionId;
    const adapter = this.deps.factory?.({ ...spec, sessionId: state.sessionId || undefined }) ?? (spec.harness === 'codex' ? new CodexRuntimeAdapter({ ...spec, sessionId: state.sessionId || undefined }) : new ClaudeRuntimeAdapter({ ...spec, sessionId: state.sessionId || undefined }));
    const terminal = new ManagedTerminal();
    const e: Entry = { spec, state, adapter, terminal, ready: Promise.resolve(), liveRequests: new Map(), busy: false, items: new Map(), waiters: new Map() };
    this.entries.set(surf, e);
    for (const q of state.decisions) if (q.state === 'submitted') q.state = 'uncertain';
    for (const [op, status] of Object.entries(state.operations)) if (status === 'executing') state.operations[op] = 'uncertain';
    state.queue = state.queue.filter((input) => state.operations[input.op] === 'queued');
    this.save(e);
    adapter.on('event', (event) => { try { this.event(e, event); } catch { this.attention(e, 'Cannot persist provider event; execution paused'); void adapter.interrupt(); } });
    adapter.on('fault', () => this.attention(e, 'Provider connection failed; reconcile before continuing'));
    adapter.on('exit', (code) => { state.active = false; try { this.save(e); } catch { this.attention(e, 'Cannot persist provider exit'); } if (!e.handingOff) terminal.emit('exit', { exitCode: code }); });
    terminal.on('stop', () => void adapter.stop().catch(() => this.attention(e, 'Provider termination unconfirmed')));
    e.ready = Promise.resolve().then(async () => {
      terminal.output('Managed Eridani session · use Take over to control this conversation\n');
      if (!recovered && state.initialization === 'executing') throw new Error('Conversation creation receipt unknown; reconcile provider sessions before starting again');
      state.initialization = 'executing'; this.save(e);
      const id = recovered ? await adapter.resume() : await adapter.start();
      if (id) state.sessionId = id; state.initialization = 'ready';
      this.save(e); this.deps.changed(surf, state.sessionId, state.paused); e.started = true;
      this.hook(e, 'SessionStart');
      if (recovered) {
        for (const q of state.decisions) if (q.state !== 'resolved') this.publish(e, q, true);
        if (state.active || Object.values(state.operations).includes('uncertain')) this.attention(e, 'Recovered conversation; previous action needs reconciliation before continuing');
        else this.activity(e, 'idle');
        await this.recreatePending(e);
      } else if (spec.prompt) await this.send(surf, spec.prompt, spec.operationId, true);
    }).catch((error) => { e.startupError = error as Error; this.attention(e, 'Provider startup or receipt stalled; reconcile before retry'); });
    return terminal;
  }
  async ready(surf: string): Promise<void> { const e = this.entries.get(surf); await e?.ready; if (e?.startupError) throw e.startupError; }
  private activity(e: Entry, kind: ActivityBody['kind'], label?: string): void {
    const now = Date.now(); if (e.lastActivity?.kind === kind && e.lastActivity.label === label && now - e.lastActivity.at < 1_000) return;
    e.lastActivity = { kind, label, at: now }; e.state.sequence++; this.save(e);
    this.deps.emit({ t: 'activity', run_id: e.spec.runId, generation: e.spec.generation, surf: e.spec.surf, incarnation: e.spec.incarnation, session_id: e.state.sessionId, turn_id: e.state.turnId, sequence: e.state.sequence, at: Date.now(), kind, ...(label ? { label } : {}) });
  }
  private attention(e: Entry, label: string): void { e.terminal.output(`\n[${label}]\n`); try { this.activity(e, 'waiting', label); } catch { e.terminal.output('[Managed persistence unavailable; execution is blocked]\n'); } }
  private publish(e: Entry, q: Decision, recovering = false): void {
    this.deps.emit({ t: 'question', question_id: q.id, surf: e.spec.surf, incarnation: e.spec.incarnation, run_id: e.spec.runId, generation: q.generation, provider: e.spec.harness, provider_session_id: q.sessionId, provider_request_id: String(q.request.id), provider_turn_id: q.turnId, kind: q.kind, group_id: q.id, items: q.items.map(redactItem), hold_until: 0, durable: true, request_digest: q.digest, ...(q.action ? { action: q.action } : {}), recovery: recovering ? 'attention_required' : 'pending' });
  }
  private request(e: Entry, req: HarnessRequest, items: QuestionItem[], kind: Decision['kind']): void {
    // Match the entire provider action and original conversation context. A new request ID alone never grants consent.
    if (kind === 'approval' && Buffer.byteLength(canonicalJson(req.params)) > 120 * 1024) { this.attention(e, 'Unsupported approval action exceeds 128KiB protocol bound; action remains blocked'); return; }
    const contextParams = { ...req.params }; delete contextParams.turnId; delete contextParams.startedAtMs; delete contextParams.itemId; delete contextParams.approvalId;
    const hash = digest({ method: req.method, params: contextParams, sessionId: e.state.sessionId, generation: e.spec.generation, runId: e.spec.runId, profile: e.spec.profile, cwd: e.spec.cwd, model: e.spec.model, effort: e.spec.effort ?? null, planRevision: e.spec.planRevision ?? null });
    let q = e.state.decisions.find((d) => d.digest === hash && d.state !== 'resolved');
    if (!q && e.recovering) {
      for (const previous of e.state.decisions) if (previous.state === 'pending') { previous.state = 'resolved'; this.deps.emit({ t: 'question.resolved', question_id: previous.id, surf: e.spec.surf, generation: previous.generation, outcome: 'canceled', still_open: false, detail: 'Provider recreated a changed action after restart; fresh review required', at: Date.now() }); }
    }
    if (!q) { q = { id: `managed-${crypto.randomUUID()}`, digest: hash, request: req, items, kind, state: 'pending', sessionId: e.state.sessionId, turnId: e.state.turnId, generation: e.spec.generation }; e.state.decisions.push(q); }
    if (kind === 'approval') q.action = { tool: req.method === 'claude/permission' ? String(req.params.tool_name) : req.method, input: JSON.parse(redact(JSON.stringify(req.params))), cwd: e.spec.cwd, digest: hash, ...(req.params.permissions ? { permissions: JSON.parse(redact(JSON.stringify(req.params.permissions))) } : {}) };
    if (e.recovering) e.recovering = false;
    q.request = req; e.liveRequests.set(q.id, req); this.save(e); this.publish(e, q); this.activity(e, 'waiting');
  }
  private event(e: Entry, m: any): void {
    const p = m.params ?? {};
    if (m.method && m.id !== undefined) {
      if (m.method === 'item/tool/requestUserInput') {
        const items = toItems(p.questions?.map((q: any) => ({ question: q.question, header: q.header, options: q.options }))) ?? [];
        // Preserve provider question IDs for structured response correlation.
        items.forEach((it, i) => { it.id = String(p.questions[i].id); });
        if (items.length) this.request(e, { id: m.id, method: m.method, params: p }, items, 'ask');
      } else if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval'].includes(m.method)) this.request(e, { id: m.id, method: m.method, params: { ...p, ...(m.method === 'item/fileChange/requestApproval' ? { changes: e.items.get(p.itemId)?.changes ?? null } : {}) } }, [{ id: 'approval', text: String(p.reason ?? p.command ?? 'Review this exact action and choose Allow once or Deny').slice(0, 4000), choices: [{ id: 'allow_once', label: 'Allow once' }, { id: 'deny', label: 'Deny' }] }], 'approval');
      else { this.attention(e, `Unsupported provider request: ${m.method}`); }
      return;
    }
    if (m.type === 'result' && m.stop_reason === 'tool_deferred' && m.deferred_tool_use?.name === 'AskUserQuestion') {
      const deferred = m.deferred_tool_use; const items = toItems(deferred.input?.questions);
      if (items) this.request(e, { id: deferred.id, method: 'claude/deferred', params: { tool_name: deferred.name, input: deferred.input, tool_use_id: deferred.id } }, items, 'ask');
      e.state.active = false; e.busy = false; this.save(e); return;
    }
    if (m.type === 'control_request' && m.request?.subtype === 'can_use_tool') {
      const req = m.request; const ask = req.tool_name === 'AskUserQuestion';
      const items = ask ? toItems(req.input?.questions) : [{ id: 'approval', text: redact(JSON.stringify({ tool: req.tool_name, input: req.input, cwd: e.spec.cwd })).slice(0, 4000), choices: [{ id: 'allow_once', label: 'Allow once' }, { id: 'deny', label: 'Deny' }] }];
      if (items) this.request(e, { id: m.request_id, method: ask ? 'claude/ask' : 'claude/permission', params: req }, items, ask ? 'ask' : 'approval'); return;
    }
    if (m.type === 'system' && m.session_id) { e.state.sessionId = m.session_id; this.save(e); this.deps.changed(e.spec.surf, m.session_id, e.state.paused); }
    if (p.turn?.id) e.state.turnId = p.turn.id;
    if (m.method === 'serverRequest/resolved') this.confirm(e, String(p.requestId));
    if (m.type === 'user' && m.uuid === e.prompt?.op) this.promptAccepted(e);
    if (m.type === 'assistant') { e.finalText = (m.message?.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join(''); }
    if (m.type === 'user') for (const block of m.message?.content ?? []) if (block.type === 'tool_result') { this.confirm(e, String(block.tool_use_id), true); if (block.is_error && String(e.items.get(block.tool_use_id)?.name ?? '').startsWith('mcp__eridani__')) this.toolFailed(e); }
    if (m.method === 'turn/started') { this.promptAccepted(e); e.state.active = true; this.activity(e, 'thinking'); }
    if (m.method?.startsWith('item/reasoning/')) this.activity(e, 'thinking');
    if (m.method === 'item/agentMessage/delta') { e.finalText = (e.finalText ?? '') + String(p.delta ?? ''); e.terminal.output(String(p.delta ?? '')); }
    if (m.method === 'item/completed' && p.item?.type === 'mcpToolCall' && (p.item.status === 'failed' || p.item.error)) this.toolFailed(e);
    if (m.method === 'item/completed' && p.item?.type === 'agentMessage' && typeof p.item.text === 'string') e.finalText = p.item.text;
    if (m.method === 'item/started' && p.item?.id) e.items.set(p.item.id, p.item);
    if (m.method === 'item/started') this.toolActivity(e, p.item?.type ?? '', p.item?.command ?? '');
    if (m.method === 'item/commandExecution/outputDelta') e.terminal.output(String(p.delta ?? ''));
    if (m.method === 'turn/completed' || m.type === 'result') { e.state.active = false; e.busy = false; this.hook(e, 'Stop', { turnId: e.state.turnId ?? `${e.state.sessionId}:${e.prompt?.op ?? 'recovered'}`, lastAssistantMessage: m.type === 'result' && typeof m.result === 'string' ? m.result : e.finalText ?? '' }); this.activity(e, e.state.paused ? 'waiting' : 'idle', e.state.paused ? 'Paused; review required' : undefined); e.terminal.output('\n'); void this.pump(e); }
    if (m.type === 'stream_event') {
      const ev = m.event; if (ev?.delta?.type === 'text_delta') e.terminal.output(String(ev.delta.text));
      if (ev?.delta?.type === 'thinking_delta') this.activity(e, 'thinking');
      if (ev?.type === 'content_block_start' && ev.content_block?.type === 'tool_use') this.toolActivity(e, ev.content_block.name, ev.content_block.input?.command ?? '');
    }
    if (m.type === 'assistant') for (const b of m.message?.content ?? []) if (b.type === 'tool_use') { e.items.set(b.id, b); this.toolActivity(e, b.name, b.input?.command ?? ''); }
  }
  private toolFailed(e: Entry): void {
    e.state.paused = true; this.save(e); this.deps.changed(e.spec.surf, e.state.sessionId, true);
    this.attention(e, 'Coordination tool failed or timed out; reconcile its receipt before retry');
    void e.adapter.interrupt().catch(() => this.attention(e, 'Provider interrupt unconfirmed; execution remains paused'));
  }
  private toolActivity(e: Entry, tool: string, command: string): void {
    if (/read|grep|glob|search/i.test(tool)) this.activity(e, 'searching', 'Reading');
    else if (/edit|write|fileChange/i.test(tool)) this.activity(e, 'editing');
    else if (/\b(test|pytest|vitest|jest)\b/.test(command)) this.activity(e, 'testing');
    else this.activity(e, 'tool');
  }
  private hook(e: Entry, event: string, extra: Record<string, unknown> = {}): void {
    this.deps.hook?.(e.spec.surf, { event, sessionId: e.state.sessionId, provider: e.spec.harness, at: Date.now(), ...extra });
  }
  private promptAccepted(e: Entry): void {
    if (!e.prompt || e.prompt.published) return; e.prompt.published = true;
    this.hook(e, 'UserPromptSubmit', { prompt: e.prompt.text });
  }
  async send(surf: string, text: string, op: string, startup = false, begin: () => void = () => {}): Promise<CommandResult> {
    const e = this.entries.get(surf); if (!e) return { state: 'rejected', detail: 'unknown managed session' };
    if (!startup) await e.ready;
    if (e.persistenceError) return { state: 'failed', detail: 'managed persistence unavailable' };
    if (e.startupError) return { state: 'failed', detail: 'provider startup failed' };
    const previous = e.state.operations[op];
    if (previous && previous !== 'queued') return { state: previous === 'delivered' ? 'executed' : 'uncertain', detail: previous === 'delivered' ? 'provider received input' : 'input receipt unknown; reconcile before retry' };
    if (e.waiters.has(op)) return { state: 'rejected', detail: 'input already queued' };
    if (!previous) { e.state.queue.push({ text, op, generation: e.spec.generation }); e.state.operations[op] = 'queued'; this.save(e); }
    return new Promise<CommandResult>((resolve) => { e.waiters.set(op, { resolve, begin }); void this.pump(e); });
  }
  private async pump(e: Entry): Promise<void> {
    if (e.persistenceError || !e.started || e.pumping || e.handingOff || e.state.paused || e.busy || e.state.active || this.pending(e.spec.surf).length) return;
    const head = e.state.queue[0]; if (!head) return;
    const waiter = e.waiters.get(head.op); if (!waiter) return; // recovered input waits for journal replay/reconciliation
    e.pumping = true;
    try {
      if (head.generation !== e.spec.generation) { e.state.queue.shift(); this.save(e); waiter.resolve({ state: 'rejected', detail: 'stale generation' }); return; }
      waiter.begin(); e.state.operations[head.op] = 'executing'; e.state.active = true; e.busy = true;
      e.prompt = { text: head.text, op: head.op, published: false }; e.finalText = ''; this.save(e);
      await e.adapter.send(head.text, head.op); this.promptAccepted(e); e.state.operations[head.op] = 'delivered'; e.state.queue.shift(); this.save(e);
      this.activity(e, 'thinking'); waiter.resolve({ state: 'executed', result: { surf: e.spec.surf, managed: true } });
    } catch { e.state.operations[head.op] = 'uncertain'; e.state.queue.shift(); try { this.save(e); } catch { /* block until persistence recovers */ } this.attention(e, 'Input receipt stalled; reconcile before retry'); waiter.resolve({ state: 'uncertain', detail: 'provider input receipt unknown' }); }
    finally { e.waiters.delete(head.op); e.pumping = false; }
  }
  findQuestion(id: string): { entry: Entry; question: Decision } | undefined { for (const entry of this.entries.values()) { const question = entry.state.decisions.find((q) => q.id === id); if (question) return { entry, question }; } return undefined; }
  precheck(cmd: AnswerCommand): string | null {
    const found = this.findQuestion(cmd.question_id); if (!found) return 'unknown managed question';
    const { entry: e, question: q } = found;
    if (cmd.surf !== undefined && cmd.surf !== e.spec.surf || cmd.run_id !== undefined && cmd.run_id !== e.spec.runId || cmd.incarnation !== undefined && cmd.incarnation !== e.spec.incarnation || cmd.generation !== undefined && cmd.generation !== e.spec.generation) return 'stale answer fence';
    if (e.persistenceError) return 'managed persistence unavailable';
    if (e.handingOff) return 'terminal has control';
    if (e.state.paused) return 'run paused';
    if (q.generation !== e.spec.generation) return 'stale generation';
    if (q.state !== 'pending') return 'decision already submitted or requires reconciliation';
    if (String(q.request.id) !== cmd.provider_request_id) return 'stale provider request';
    if (q.kind === 'approval') return cmd.answers.length === 1 && cmd.answers[0].item_id === 'approval' && cmd.answers[0].choice_ids?.length === 1 && ['allow_once', 'deny'].includes(cmd.answers[0].choice_ids[0]) && !cmd.answers[0].text ? null : 'choose Allow once or Deny explicitly';
    const result = buildAnswers(q.items, cmd.answers); return 'error' in result ? result.error : null;
  }
  async answer(cmd: AnswerCommand, begin: () => void): Promise<CommandResult> {
    const error = this.precheck(cmd); if (error) return { state: 'rejected', detail: error };
    const { entry: e, question: q } = this.findQuestion(cmd.question_id)!;
    const request = e.liveRequests.get(q.id) ?? (q.request.method === 'claude/deferred' ? q.request : undefined);
    if (!request) return { state: 'rejected', detail: 'provider request must be recreated and verified before applying consent' };
    let response: unknown;
    if (q.kind === 'approval') { const allow = cmd.answers[0].choice_ids![0] === 'allow_once'; response = e.spec.harness === 'codex' ? request.method === 'item/permissions/requestApproval' ? { permissions: allow ? Object.fromEntries(Object.entries(request.params.permissions ?? {}).filter(([, value]) => value !== null)) : {}, scope: 'turn', strictAutoReview: true } : { decision: allow ? 'accept' : 'decline' } : allow ? { behavior: 'allow', updatedInput: request.params.input } : { behavior: 'deny', message: 'Denied by user' }; }
    else { const answers = buildAnswers(q.items, cmd.answers); if ('error' in answers) return { state: 'rejected', detail: answers.error }; response = e.spec.harness === 'codex' ? { answers: Object.fromEntries(q.items.map((it) => [it.id, { answers: [answers.answers[it.text]] }])) } : { behavior: 'allow', updatedInput: { ...request.params.input, answers: answers.answers } }; }
    begin(); q.response = response; q.state = 'submitted'; this.save(e);
    try { await e.adapter.respond(request, response); this.save(e); this.activity(e, 'thinking'); return { state: 'executed', result: { decision: 'submitted', provider_confirmation: 'pending' } }; }
    catch { q.state = 'uncertain'; try { this.save(e); } catch { /* uncertain consent is never retried */ } return { state: 'uncertain', detail: 'decision delivery uncertain; consent will not be replayed' }; }
  }
  private confirm(e: Entry, id: string, tool = false): void {
    const q = e.state.decisions.find((q) => q.state === 'submitted' && String(tool ? q.request.params.tool_use_id : q.request.id) === id);
    if (!q) return; q.state = 'resolved'; this.save(e); e.liveRequests.delete(q.id);
    this.deps.emit({ t: 'question.resolved', question_id: q.id, surf: e.spec.surf, generation: q.generation, outcome: 'accepted', still_open: false, at: Date.now() });
  }
  private async recreatePending(e: Entry): Promise<void> {
    const pending = e.state.decisions.filter((q) => q.state === 'pending' && q.generation === e.spec.generation && q.request.method !== 'claude/deferred' && !e.liveRequests.has(q.id));
    if (pending.length !== 1 || e.state.paused || e.handingOff || e.recovering || !e.adapter.recreate || e.state.decisions.some((q) => q.state === 'uncertain' || q.state === 'submitted')) return;
    e.recovering = true; this.activity(e, 'thinking', 'Recreating the pending request for review');
    try { await e.adapter.recreate(pending[0].request); } catch { e.recovering = false; this.attention(e, 'Pending request recreation stalled; review the provider connection'); }
  }
  async pause(surf: string, paused: boolean): Promise<void> {
    const e = this.entries.get(surf); if (!e) throw new Error('unknown managed session');
    e.state.paused = paused; this.save(e); this.deps.changed(surf, e.state.sessionId, paused);
    if (paused && e.state.active && !this.pending(surf).length) await e.adapter.interrupt();
    if (!paused) { await this.recreatePending(e); void this.pump(e); }
    this.activity(e, paused ? 'waiting' : 'idle', paused ? 'Paused' : undefined);
  }
  async interrupt(surf: string): Promise<void> { await this.entries.get(surf)?.adapter.interrupt(); }
  async cancel(surf: string): Promise<void> {
    const e = this.entries.get(surf); if (!e) return;
    e.state.paused = true; this.save(e); await e.adapter.stop();
    for (const q of e.state.decisions) if (q.state !== 'resolved') { q.state = 'resolved'; this.deps.emit({ t: 'question.resolved', question_id: q.id, surf, generation: q.generation, outcome: 'canceled', still_open: false, at: Date.now() }); }
    e.state.queue = []; this.save(e); for (const waiter of e.waiters.values()) waiter.resolve({ state: 'rejected', detail: 'run canceled' }); e.waiters.clear();
  }
  async stop(surf: string): Promise<void> { await this.entries.get(surf)?.adapter.stop(); }
  async takeoverNative(surf: string, cmd: string, env: Record<string, string>): Promise<void> {
    const e = this.entries.get(surf); if (!e || e.handingOff) throw new Error('takeover already in progress or unavailable');
    e.handingOff = true; e.state.paused = true; this.save(e);
    try { await e.adapter.interrupt(); await e.adapter.stop();
      const native = spawnPty({ sessionId: surf, cmd, cwd: e.spec.cwd, env, cols: 120, rows: 32 });
      e.terminal.adoptNative(native);
    } catch (error) { e.handingOff = false; this.attention(e, 'Takeover failed; run remains paused'); throw error; }
  }
  async takeover(surf: string): Promise<string> { const e = this.entries.get(surf); if (!e?.state.sessionId) throw new Error('provider conversation is not ready'); await e.adapter.interrupt(); await e.adapter.stop(); return e.state.sessionId; }
  generation(surf: string, generation: number): void {
    const e = this.entries.get(surf); if (!e || generation <= e.spec.generation) return; e.spec.generation = generation;
    for (const q of e.state.decisions) if (q.generation < generation && q.state !== 'resolved') { q.state = q.state === 'pending' ? 'resolved' : 'uncertain'; this.deps.emit({ t: 'question.resolved', question_id: q.id, surf, generation: q.generation, outcome: 'canceled', still_open: false, at: Date.now() }); }
    this.save(e);
  }
  replay(): void { for (const e of this.entries.values()) for (const q of e.state.decisions) if (q.state !== 'resolved') this.publish(e, q, !e.liveRequests.has(q.id)); }
}
