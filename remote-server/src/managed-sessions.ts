/** Durable ownership and decision journal for Eridani-created structured sessions. */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { EventEmitter } from 'events';
import { spawnPty } from './pty-spawn';
import type { PtyLike } from './pty-spawn';
import { CodexRuntimeAdapter, ClaudeRuntimeAdapter, type HarnessSpec, type HarnessRequest, type RuntimeAdapter, ProviderRequestRejected } from './managed-harness';
import { ManagedAutomation } from './managed-automation';
import { ManagedOutput, emptyOutput, type OutputState } from './managed-output';
import { ManagedTranscript } from './managed-transcript';
import { writePrivate } from './eridani-mcp';
import { canonicalJson } from '../../src/shared/eridani-link-protocol';
import { redact } from './collector/redact';
import { buildAnswers, toItems, redactItem } from './questions-claude';
import type { AnswerCommand, QuestionBody, QuestionItem, ActivityBody, ManagedAttention, AutomationHoldFields } from '../../src/shared/eridani-link-protocol';
import type { CommandResult } from './eridani-link';

type Up = Omit<QuestionBody | ActivityBody, 'op_id' | 'digest'> | Record<string, unknown>;
export interface ManagedSpec extends HarnessSpec { surf: string; runId: string; generation: number; incarnation: number; prompt: string; operationId: string; planRevision?: number | null; origin?: 'human' | 'automation'; automationHoldRevision?: number }
interface Decision { planRevision?: number; id: string; digest: string; request: HarnessRequest; items: QuestionItem[]; kind: 'ask' | 'approval'; state: 'pending' | 'submitted' | 'uncertain' | 'resolved'; sessionId: string; turnId: string | null; generation: number; response?: unknown; action?: QuestionBody['action'] }
interface DirectRecord { nativeStarted?: boolean; assignedTurn?: string; text: string; generation: number; revision: number; stage: 'waiting' | 'executing' | 'handed_to_harness' | 'provider_acknowledged' | 'uncertain' | 'rejected'; turnId: string | null; active: boolean; displayed: boolean; at: number }
interface Saved { inputs: Record<string, DirectRecord>; output: OutputState; claudeTurnSerial?: number; attention?: ManagedAttention; pausedBy?: 'operator' | 'attention'; initialization?: 'executing' | 'ready'; sessionId: string; turnId: string | null; sequence: number; paused: boolean; active: boolean; decisions: Decision[]; operations: Record<string, 'queued' | 'executing' | 'delivered' | 'uncertain' | 'rejected'>; queue: Array<{ text: string; op: string; generation: number; origin?: 'human' | 'automation'; revision?: number }> }
interface Entry { failure?: HarnessFailure; spec: ManagedSpec; state: Saved; adapter: RuntimeAdapter; terminal: ManagedTerminal; transcript: ManagedTranscript; output: ManagedOutput; directTail?: Promise<void>; directPending: Set<string>; ready: Promise<void>; liveRequests: Map<string, HarnessRequest>; busy: boolean; receiptTimers: Map<string, NodeJS.Timeout>; receiptRequests: Map<string, HarnessRequest>; persistenceError?: boolean; recovering?: boolean; pumping?: boolean; started?: boolean; finalText?: string; prompt?: { text: string; op: string; published: boolean }; waiters: Map<string, { resolve: (result: CommandResult) => void; begin: () => void }>; items: Map<string, any>; startupError?: Error; lastActivity?: { kind: string; label?: string; at: number }; handingOff?: boolean }
/** A failure a harness reports about its own session, as the trouble the host publishes (agent-state.ts). */
export interface HarnessFailure { kind: 'errored' | 'rate_limited' | 'auth_expired'; detail: string }
/** Eridani's link accepts a trouble detail of at most 200 characters; a longer one would fail the whole frame. */
const TROUBLE_DETAIL = 200;
const AUTH_ERRORS = ['authentication_failed', 'oauth_org_not_allowed', 'account_on_hold', 'cloud_credential_error'];
const LIMIT_ERRORS = ['rate_limit', 'billing_error'];
/**
 * Claude Code's `error` on an assistant message (the Agent SDK's SDKAssistantMessageError) as a failure. The
 * detail leads with the code, so the other side can tell `model_not_found` from an overloaded API, then what the
 * agent said (a usage limit says when it resets).
 */
export function assistantFailure(code: string, said = ''): HarnessFailure {
  const kind = AUTH_ERRORS.includes(code) ? 'auth_expired' : LIMIT_ERRORS.includes(code) ? 'rate_limited' : 'errored';
  const text = said.replace(/\s+/g, ' ').trim();
  return { kind, detail: text ? `${code}: ${text}`.slice(0, TROUBLE_DETAIL) : code };
}
/** A `result` that ended in an error with no assistant error before it (the turn died outside a model reply). */
export function resultFailure(m: any): HarnessFailure | null {
  if (m?.type !== 'result' || !(m.is_error || String(m.subtype ?? '').startsWith('error_'))) return null;
  const status = Number(m.api_error_status ?? 0);
  const said = (Array.isArray(m.errors) && m.errors.length ? String(m.errors[0]) : typeof m.result === 'string' ? m.result : '').replace(/\s+/g, ' ').trim();
  const code = status ? `http_${status}` : String(m.subtype ?? 'error');
  const kind = status === 401 || status === 403 ? 'auth_expired' : status === 429 ? 'rate_limited' : 'errored';
  return { kind, detail: (said ? `${code}: ${said}` : code).slice(0, TROUBLE_DETAIL) };
}
export interface ManagedDeps {
  /** A session's own harness reported a failure (after the turn that failed has ended). */
  trouble?: (surf: string, kind: HarnessFailure['kind'], detail: string) => void;
  dir: string | null; emit(body: Up): void; changed(surf: string, sessionId: string, paused: boolean, attention?: ManagedAttention | null): void;
  decisionReceiptMs?: number;
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
const empty = (): Saved => ({ inputs: {}, output: emptyOutput(), sessionId: '', turnId: null, sequence: 0, paused: false, active: false, decisions: [], operations: {}, queue: [] });
export class ManagedSessions {
  private entries = new Map<string, Entry>();
  private staged = new Map<string, ManagedSpec>();
  readonly automation: ManagedAutomation;
  constructor(private readonly deps: ManagedDeps) { this.automation = new ManagedAutomation(deps.dir); }
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
    const interruptedTurn = state.active;
    // This is a new provider process. A completed input receipt may be resumed with a new safe continuation; unknown operation IDs remain tombstoned.
    state.active = false;
    // A new surface has no saved conversation; a spec that names one (a restarted run) starts by resuming it, then takes the spawn prompt.
    const sessionId = state.sessionId || spec.sessionId || undefined;
    const adapter = this.deps.factory?.({ ...spec, sessionId }) ?? (spec.harness === 'codex' ? new CodexRuntimeAdapter({ ...spec, sessionId }) : new ClaudeRuntimeAdapter({ ...spec, sessionId }));
    const terminal = new ManagedTerminal();
    let e!: Entry;
    const output = new ManagedOutput(state.output, () => ({ run_id: spec.runId, generation: spec.generation, surf: spec.surf, incarnation: spec.incarnation, session_id: state.sessionId, turn_id: state.turnId }), () => this.save(e), body => this.deps.emit(body), () => this.attention(e, 'Public output could not be persisted'));
    e = { spec, state, adapter, terminal, transcript: new ManagedTranscript(text => terminal.output(text)), output, directPending: new Set(), ready: Promise.resolve(), liveRequests: new Map(), busy: false, receiptTimers: new Map(), receiptRequests: new Map(), items: new Map(), waiters: new Map() };
    this.entries.set(surf, e);
    for (const input of Object.values(state.inputs)) if (input.stage === 'executing') input.stage = 'uncertain';
    for (const q of state.decisions) if (q.state === 'submitted') q.state = 'uncertain';
    for (const [op, status] of Object.entries(state.operations)) if (status === 'executing') state.operations[op] = 'uncertain';
    state.queue = state.queue.filter((input) => state.operations[input.op] === 'queued');
    this.save(e);
    adapter.on('event', (event) => { try { this.event(e, event); } catch { this.attention(e, 'Cannot persist provider event; execution paused'); void adapter.interrupt(); } });
    adapter.on('fault', () => this.attention(e, 'Provider connection failed; reconcile before continuing'));
    adapter.on('exit', (code) => { state.active = false; try { this.save(e); } catch { this.attention(e, 'Cannot persist provider exit'); } if (!e.handingOff) terminal.emit('exit', { exitCode: code }); });
    terminal.on('stop', () => void adapter.stop().catch(() => this.attention(e, 'Provider termination unconfirmed')));
    e.ready = Promise.resolve().then(async () => {
      e.transcript.notice('Managed Eridani conversation · take over to use the terminal directly');
      if (!recovered && state.initialization === 'executing') throw new Error('Conversation creation receipt unknown; reconcile provider sessions before starting again');
      state.initialization = 'executing'; this.save(e);
      const id = recovered ? await adapter.resume() : await adapter.start();
      if (id) state.sessionId = id; state.initialization = 'ready';
      this.save(e); this.deps.changed(surf, state.sessionId, state.paused, state.attention); e.started = true;
      this.hook(e, 'SessionStart');
      if (recovered) {
        for (const q of state.decisions) if (q.state !== 'resolved') this.publish(e, q, true);
        if (state.attention) this.attention(e, state.attention.reason);
        else if (interruptedTurn || Object.values(state.operations).includes('uncertain')) this.attention(e, 'Recovered conversation; previous action needs reconciliation before continuing');
        else this.activity(e, 'idle');
        await this.recreatePending(e);
      } else if (spec.prompt) await this.send(surf, spec.prompt, spec.operationId, true, () => {}, { origin: spec.origin, automation_hold_revision: spec.automationHoldRevision });
    }).catch((error) => { e.startupError = error as Error; this.attention(e, 'Provider startup or receipt stalled; reconcile before retry'); });
    return terminal;
  }
  async ready(surf: string): Promise<void> { const e = this.entries.get(surf); await e?.ready; if (e?.startupError) throw e.startupError; }
  private activity(e: Entry, kind: ActivityBody['kind'], label?: string): void {
    const now = Date.now(); if (e.lastActivity?.kind === kind && e.lastActivity.label === label && now - e.lastActivity.at < 1_000) return;
    e.lastActivity = { kind, label, at: now }; e.state.sequence++; this.save(e);
    this.deps.emit({ t: 'activity', run_id: e.spec.runId, generation: e.spec.generation, surf: e.spec.surf, incarnation: e.spec.incarnation, session_id: e.state.sessionId, turn_id: e.state.turnId, sequence: e.state.sequence, at: Date.now(), kind, ...(label ? { label } : {}) });
  }
  private attention(e: Entry, label: string): void { e.transcript.notice(label); try { this.activity(e, 'waiting', label); } catch { e.terminal.output('[Managed persistence unavailable; execution is blocked]\n'); } }
  private publish(e: Entry, q: Decision, recovering = false): void {
    this.deps.emit({ t: 'question', question_id: q.id, surf: e.spec.surf, incarnation: e.spec.incarnation, run_id: e.spec.runId, generation: q.generation, plan_revision: q.planRevision ?? 0, provider: e.spec.harness, provider_session_id: q.sessionId, provider_request_id: String(q.request.id), provider_turn_id: q.turnId, kind: q.kind, group_id: q.id, items: q.items.map(redactItem), hold_until: 0, durable: true, request_digest: q.digest, ...(q.action ? { action: q.action } : {}), recovery: recovering || q.state !== 'pending' ? 'attention_required' : 'pending' });
  }
  private request(e: Entry, req: HarnessRequest, items: QuestionItem[], kind: Decision['kind']): void {
    // Match the entire provider action and original conversation context. A new request ID alone never grants consent.
    if (kind === 'approval' && Buffer.byteLength(canonicalJson(req.params)) > 120 * 1024) { this.attention(e, 'Unsupported approval action exceeds 128KiB protocol bound; action remains blocked'); return; }
    const contextParams = { ...req.params }; delete contextParams.turnId; delete contextParams.startedAtMs; delete contextParams.itemId; delete contextParams.approvalId;
    const hash = digest({ method: req.method, params: contextParams, sessionId: e.state.sessionId, generation: e.spec.generation, runId: e.spec.runId, profile: e.spec.profile, cwd: e.spec.cwd, model: e.spec.model, effort: e.spec.effort ?? null, planRevision: e.spec.planRevision ?? 0 });
    let q = e.state.decisions.find((d) => d.digest === hash && d.state !== 'resolved');
    if (!q && e.recovering) {
      for (const previous of e.state.decisions) if (previous.state === 'pending') { previous.state = 'resolved'; this.deps.emit({ t: 'question.resolved', question_id: previous.id, surf: e.spec.surf, generation: previous.generation, provider_request_id: String(previous.request.id), incarnation: e.spec.incarnation, request_digest: previous.digest, plan_revision: previous.planRevision ?? 0, outcome: 'canceled', still_open: false, detail: 'Provider recreated a changed action after restart; fresh review required', at: Date.now() }); }
    }
    if (!q) { q = { id: `managed-${crypto.randomUUID()}`, digest: hash, request: req, items, kind, state: 'pending', sessionId: e.state.sessionId, turnId: e.state.turnId, generation: e.spec.generation, planRevision: e.spec.planRevision ?? 0 }; e.state.decisions.push(q); }
    if (kind === 'approval') q.action = { tool: req.method === 'claude/permission' ? String(req.params.tool_name) : req.method, input: JSON.parse(redact(JSON.stringify(req.params))), cwd: e.spec.cwd, digest: hash, ...(req.params.permissions ? { permissions: JSON.parse(redact(JSON.stringify(req.params.permissions))) } : {}) };
    if (e.recovering) e.recovering = false;
    q.request = req; e.liveRequests.set(q.id, req); this.save(e); this.publish(e, q); this.activity(e, 'waiting', kind === 'ask' ? 'Waiting for your answer' : 'Waiting for approval');
  }
  private event(e: Entry, m: any): void {
    if (m.type === 'remotea/direct-start') { const input = e.state.inputs[m.input_id]; if (input) { input.active = false; input.turnId = null; e.prompt = { text: input.text, op: m.input_id, published: false }; e.finalText = ''; e.state.turnId = null; e.state.active = true; this.save(e); } return; }
    if (e.spec.harness === 'claude' && !e.state.active && (m.type === 'assistant' || m.type === 'stream_event' && m.event?.type === 'message_start')) this.beginClaudePending(e);
    if (m.method === 'turn/started' || e.spec.harness === 'claude' && (m.type === 'assistant' || m.type === 'stream_event' && m.event?.type === 'message_start')) { const input = e.prompt && e.state.inputs[e.prompt.op]; if (input) input.nativeStarted = true; }
    e.transcript.event(m);
    e.output.event(m);
    const p = m.params ?? {};
    if (m.type === 'remotea/permission-denied') {
      const input = m.input ?? {}, tool = String(input.tool_name ?? 'tool');
      const action = { tool, input: input.tool_input, cwd: input.cwd ?? e.spec.cwd };
      this.setAttention(e, { kind: 'permission_denied', tool, reason: redact(`Automatic review denied ${tool}: ${String(input.reason ?? 'Review the action in Remotea before continuing')}`).slice(0, 300), ...(Buffer.byteLength(JSON.stringify(action)) <= 120 * 1024 ? { action: JSON.parse(redact(JSON.stringify(action))) } : {}) }); void e.adapter.interrupt().catch(() => this.attention(e, 'Automatic review denied the action; provider interrupt unconfirmed')); return;
    }
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
    if (m.type === 'user' && typeof m.uuid === 'string' && e.state.inputs[m.uuid] && (!m.session_id || m.session_id === e.state.sessionId)) this.inputAcknowledged(e, m.uuid);
    if (m.type === 'user' && m.uuid === e.prompt?.op) this.promptAccepted(e);
    if (m.type === 'assistant') { e.finalText = (m.message?.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join(''); }
    // The harness says its own turn failed (usage limit, sign-in, model or API error). Kept until the turn ends.
    if (m.type === 'assistant' && typeof m.error === 'string' && m.error) e.failure = assistantFailure(m.error, e.finalText ?? '');
    if (m.type === 'assistant' && !m.error && (m.message?.content ?? []).length) e.failure = undefined; // It recovered within the turn.
    if (m.type === 'user') for (const block of m.message?.content ?? []) if (block.type === 'tool_result') { this.confirm(e, String(block.tool_use_id), true); if (block.is_error && String(e.items.get(block.tool_use_id)?.name ?? '').startsWith('mcp__eridani__')) this.toolFailed(e, { ...block, id: block.tool_use_id, name: e.items.get(block.tool_use_id)?.name }); }
    if (m.method === 'turn/started') { this.promptAccepted(e); e.state.active = true; this.activity(e, 'thinking'); }
    if (m.method?.startsWith('item/reasoning/')) this.activity(e, 'thinking');
    if (m.method === 'item/agentMessage/delta') { e.finalText = (e.finalText ?? '') + String(p.delta ?? ''); }
    if (m.method === 'item/completed' && p.item?.type === 'mcpToolCall' && (p.item.status === 'failed' || p.item.error)) this.toolFailed(e, p.item);
    if (m.method === 'item/completed' && p.item?.type === 'agentMessage' && typeof p.item.text === 'string') e.finalText = p.item.text;
    if (m.method === 'item/started' && p.item?.id) e.items.set(p.item.id, p.item);
    if (m.method === 'item/started') this.toolActivity(e, p.item?.type ?? '', p.item?.command ?? '');
    if (m.method === 'turn/completed' || m.type === 'result') { e.state.active = false; e.busy = false; this.hook(e, 'Stop', { turnId: e.state.turnId ?? `${e.state.sessionId}:${e.prompt?.op ?? 'recovered'}`, lastAssistantMessage: m.type === 'result' && typeof m.result === 'string' ? m.result : e.finalText ?? '' }); this.activity(e, e.state.paused ? 'waiting' : 'idle', e.state.paused ? 'Paused; review required' : undefined);
      // After the turn-end reports above, so they do not clear it: what went wrong, for whoever watches the run.
      const failure = e.failure ?? resultFailure(m); e.failure = undefined;
      if (failure) this.deps.trouble?.(e.spec.surf, failure.kind, failure.detail);
      void this.pump(e); }
    if (m.type === 'stream_event') {
      const ev = m.event;
      if (ev?.delta?.type === 'thinking_delta') this.activity(e, 'thinking');
      if (ev?.type === 'content_block_start' && ev.content_block?.type === 'tool_use') this.toolActivity(e, ev.content_block.name, ev.content_block.input?.command ?? '');
    }
    if (m.type === 'assistant') for (const b of m.message?.content ?? []) if (b.type === 'tool_use') { e.items.set(b.id, b); this.toolActivity(e, b.name, b.input?.command ?? ''); }
  }
  private toolFailed(e: Entry, item: any): void {
    const tool = String(item.tool ?? item.name ?? '');
    const name = tool.replace(/^mcp__eridani__/, '');
    // Read failures and unrelated MCP tools cannot leave a planning write unconfirmed.
    if (!['task_interview', 'submit_plan', 'submit_plan_review'].includes(name) ||
        (item.server && item.server !== 'eridani')) return;
    const raw = JSON.stringify(item);
    const correctionCodes = ['INVALID_ARGUMENT', 'VERIFY_UNKNOWN', 'REVISION_CONFLICT', 'REVIEW_UNRESOLVED'];
    const rejectionCodes = ['RUN_TOKEN_REQUIRED', 'RUN_NOT_BOUND', ...correctionCodes];
    let code: string | undefined;
    const inspect = (value: any): void => {
      if (!value || code) return;
      if (typeof value === 'string') { try { inspect(JSON.parse(value)); } catch { /* not JSON */ } }
      else if (Array.isArray(value)) value.forEach(inspect);
      else if (typeof value === 'object') {
        if (typeof value.error?.code === 'string' && rejectionCodes.includes(value.error.code)) code = value.error.code;
        else Object.values(value).forEach(inspect);
      }
    };
    // Arguments may contain error examples. Only a structured tool response proves rejection.
    inspect({ error: item.error, result: item.result, content: item.content });
    // The provider has the validation response and can correct it in this turn.
    // Interrupting here would prevent that correction and manufacture a receipt deadlock.
    if (code && correctionCodes.includes(code)) return;
    const reason = code ? `Planning submission rejected (${code}); no interview or plan was saved.` : 'Coordination tool failed or timed out; reconcile its receipt before retry';
    this.setAttention(e, { kind: 'receipt_uncertain', reason, tool,
      action: { coordination: { code: code ?? 'DELIVERY_UNCONFIRMED', outcome: code ? 'rejected' : 'uncertain', tool,
        request_id: String(item.id ?? crypto.createHash('sha256').update(raw).digest('hex')), binding: !!e.spec.env.ERIDANI_RUN_TOKEN } } });
    void e.adapter.interrupt().catch(() => this.attention(e, 'Provider interrupt unconfirmed; execution remains paused'));
  }
  private toolActivity(e: Entry, tool: string, command: string): void {
    if (tool.toLowerCase() === 'reasoning') this.activity(e, 'thinking');
    else if (tool === 'agentMessage') this.activity(e, 'thinking', 'Writing a response');
    else if (/read|grep|glob|search/i.test(tool)) this.activity(e, 'searching', 'Reading');
    else if (/edit|write|fileChange/i.test(tool)) this.activity(e, 'editing');
    else if (/\b(test|pytest|vitest|jest)\b/.test(command)) this.activity(e, 'testing');
    else this.activity(e, 'tool');
  }
  private hook(e: Entry, event: string, extra: Record<string, unknown> = {}): void {
    this.deps.hook?.(e.spec.surf, { event, sessionId: e.state.sessionId, provider: e.spec.harness, at: Date.now(), ...extra });
  }
  private promptAccepted(e: Entry): void {
    if (!e.prompt || e.prompt.published) return; e.prompt.published = true;
    const input = e.state.inputs[e.prompt.op];
    if (!input?.displayed) { e.transcript.user(e.prompt.text); if (input) { input.displayed = true; this.save(e); } }
    this.hook(e, 'UserPromptSubmit', { prompt: e.prompt.text });
  }
  async send(surf: string, text: string, op: string, startup = false, begin: () => void = () => {}, options: AutomationHoldFields = {}): Promise<CommandResult> {
    const e = this.entries.get(surf); if (!e) return { state: 'rejected', detail: 'unknown managed session' };
    if (!startup) await e.ready;
    if (e.persistenceError) return { state: 'failed', detail: 'managed persistence unavailable' };
    if (e.startupError) return { state: 'failed', detail: 'provider startup failed' };
    if (this.automation.blocked(e.spec.runId, options.origin, options.automation_hold_revision)) return { state: 'rejected', detail: 'Eridani automation is held or superseded' };
    const previous = e.state.operations[op];
    if (previous && previous !== 'queued') return { state: previous === 'delivered' ? 'executed' : previous === 'rejected' ? 'rejected' : 'uncertain', detail: previous === 'delivered' ? 'provider received input' : 'input receipt unknown; reconcile before retry' };
    if (e.waiters.has(op)) return { state: 'rejected', detail: 'input already queued' };
    if (!previous) { e.state.queue.push({ text, op, generation: e.spec.generation, origin: options.origin, revision: options.automation_hold_revision }); e.state.operations[op] = 'queued'; this.save(e); }
    return new Promise<CommandResult>((resolve) => { e.waiters.set(op, { resolve, begin }); void this.pump(e); });
  }
  canDirect(surf: string): boolean { return typeof this.entries.get(surf)?.adapter.sendDirect === 'function'; }
  holdRun(run: string, generation: number, held: boolean, revision: number): string | null {
    const current = this.automation.get(run);
    if (generation === current.generation && held && current.held && revision < current.revision) return null;
    const error = this.automation.set(run, generation, held, revision); if (error) return error;
    for (const entry of this.entries.values()) if (entry.spec.runId === run) {
      entry.state.queue = entry.state.queue.filter(input => {
        if (entry.state.operations[input.op] !== 'queued' || !this.automation.blocked(run, input.origin, input.revision)) return true;
        entry.state.operations[input.op] = 'rejected'; entry.waiters.get(input.op)?.resolve({ state: 'rejected', detail: 'Eridani automation is held or superseded' }); entry.waiters.delete(input.op); return false;
      }); this.save(entry); if (!held) void this.pump(entry);
    }
    return null;
  }
  private inputReceipt(e: Entry, id: string): void {
    const input = e.state.inputs[id]; if (!input || !['handed_to_harness', 'provider_acknowledged', 'uncertain'].includes(input.stage)) return;
    this.deps.emit({ t: 'input.receipt', input_id: id, run_id: e.spec.runId, generation: input.generation, surf: e.spec.surf, incarnation: e.spec.incarnation, session_id: e.state.sessionId, turn_id: input.turnId, at: input.at, stage: input.stage });
  }
  private beginClaudePending(e: Entry): void {
    // Replay UUIDs prove receipt, not the time of consumption. A fresh assistant stream after result proves a new native turn.
    const pending = Object.entries(e.state.inputs).filter(([, input]) => !input.assignedTurn && ['executing', 'handed_to_harness', 'provider_acknowledged', 'uncertain'].includes(input.stage));
    const first = pending[0], id = first?.[0], turnId = id ? `input:${id}` : `native:${e.state.sessionId}:${e.state.claudeTurnSerial = (e.state.claudeTurnSerial ?? 0) + 1}`;
    if (first) first[1].assignedTurn = turnId;
    e.prompt = id ? { text: first[1].text, op: id, published: false } : undefined; e.finalText = ''; e.state.turnId = turnId; e.state.active = true; this.save(e); this.promptAccepted(e);
    if (e.state.paused) void e.adapter.interrupt().catch(() => this.attention(e, 'Paused provider input requires reconciliation'));
  }
  private inputAcknowledged(e: Entry, id: string): void {
    const input = e.state.inputs[id]; if (!input || input.stage === 'provider_acknowledged' || input.stage === 'rejected' || input.stage === 'waiting') return;
    input.stage = 'provider_acknowledged'; input.at = Date.now(); this.save(e); this.inputReceipt(e, id);
    if (!input.displayed) { input.active ? e.transcript.followup(input.text) : e.transcript.user(input.text); input.displayed = true; this.save(e); }
    // A UUID replay confirms receipt only. Later assistant stream boundaries assign buffered inputs to a new native turn.
  }
  async sendDirect(surf: string, text: string, id: string, revision: number, begin: () => void): Promise<CommandResult> {
    const e = this.entries.get(surf); if (!e?.adapter.sendDirect) return { state: 'rejected', detail: 'native direct input is unavailable' };
    await e.ready;
    if (e.persistenceError || e.startupError || e.handingOff || e.state.paused) return { state: 'rejected', detail: e.state.paused ? 'run paused' : 'managed session unavailable' };
    const old = e.state.inputs[id];
    if (old && (old.text !== text || old.revision !== revision || old.generation !== e.spec.generation)) return { state: 'rejected', detail: 'input identity mismatch' };
    if (old && old.stage !== 'waiting') return this.directResult(e, id);
    if (e.directPending.has(id)) return { state: 'rejected', detail: 'input handoff already in progress' };
    begin(); const currentHold = this.automation.get(e.spec.runId); const held = revision < currentHold.revision && e.spec.generation === currentHold.generation ? null : this.holdRun(e.spec.runId, e.spec.generation, true, revision); if (held) return { state: 'rejected', detail: held };
    e.state.inputs[id] ??= { text, revision, generation: e.spec.generation, stage: 'waiting', turnId: e.state.turnId, active: e.state.active || e.busy, displayed: false, at: Date.now() }; this.save(e);
    const previous = e.directTail ?? Promise.resolve(); let release!: () => void; e.directTail = new Promise<void>(resolve => { release = resolve; }); e.directPending.add(id);
    await previous;
    try {
      const input = e.state.inputs[id];
      if (e.state.paused || e.handingOff || input.generation !== e.spec.generation) { input.stage = 'rejected'; this.save(e); return this.directResult(e, id); }
      const active = e.state.active || e.busy; input.active = active; input.turnId = e.state.turnId;
      input.stage = 'executing'; input.at = Date.now(); this.save(e);
      if (!active) { e.prompt = { text, op: id, published: false }; e.finalText = ''; e.state.turnId = e.spec.harness === 'claude' ? `input:${id}` : null; if (e.state.turnId) input.assignedTurn = e.state.turnId; e.state.active = true; }
      const receipt = await e.adapter.sendDirect!(text, id, { active, turnId: input.turnId });
      input.turnId = receipt.turnId ?? input.turnId ?? e.state.turnId;
      if ((input as DirectRecord).stage !== 'provider_acknowledged') input.stage = receipt.providerAcknowledged ? 'provider_acknowledged' : 'handed_to_harness';
      input.at = Date.now(); this.save(e);
      if (!input.displayed) { input.active ? e.transcript.followup(text) : e.transcript.user(text); input.displayed = true; this.save(e); }
      if (!input.active && receipt.providerAcknowledged) this.promptAccepted(e);
      this.inputReceipt(e, id); return this.directResult(e, id);
    } catch (error) {
      const input = e.state.inputs[id];
      if (input.stage !== 'provider_acknowledged') input.stage = error instanceof ProviderRequestRejected ? 'rejected' : 'uncertain'; input.at = Date.now(); this.save(e);
      if (input.stage === 'rejected' && !input.active && !input.nativeStarted && e.prompt?.op === id) { e.state.active = false; e.busy = false; e.state.turnId = null; e.prompt = undefined; this.save(e); }
      if (input.stage === 'uncertain') { this.attention(e, 'Native input handoff is uncertain; do not resend without reconciliation'); this.inputReceipt(e, id); }
      return this.directResult(e, id);
    } finally { e.directPending.delete(id); release(); }
  }
  replayOutput(): void { for (const entry of this.entries.values()) entry.output.replay(); }
  recoveredDirect(surf: string, id: string): CommandResult | null {
    const e = this.entries.get(surf), input = e?.state.inputs[id] ?? this.load(surf).inputs[id];
    if (!input || !['handed_to_harness', 'provider_acknowledged'].includes(input.stage)) return null;
    return { state: 'executed', result: { surf, input_id: id, receipt: 'handed_to_harness', provider_ack: input.stage === 'provider_acknowledged' ? 'confirmed' : 'pending', session_id: e?.state.sessionId ?? this.load(surf).sessionId, turn_id: input.turnId, managed: true } };
  }
  private directResult(e: Entry, id: string): CommandResult {
    const input = e.state.inputs[id];
    if (input.stage === 'rejected') return { state: 'rejected', detail: 'native harness rejected the input before handoff' };
    if (input.stage === 'uncertain' || input.stage === 'executing' || input.stage === 'waiting') return { state: 'uncertain', detail: 'native input delivery requires reconciliation' };
    return { state: 'executed', result: { surf: e.spec.surf, input_id: id, receipt: 'handed_to_harness', provider_ack: input.stage === 'provider_acknowledged' ? 'confirmed' : 'pending', session_id: e.state.sessionId, turn_id: input.turnId, managed: true } };
  }
  private async pump(e: Entry): Promise<void> {
    if (e.persistenceError || !e.started || e.pumping || e.handingOff || e.state.paused || e.busy || e.state.active || this.pending(e.spec.surf).length) return;
    const head = e.state.queue[0]; if (!head) return;
    const waiter = e.waiters.get(head.op); if (!waiter) return; // recovered input waits for journal replay/reconciliation
    e.pumping = true;
    try {
      if (this.automation.blocked(e.spec.runId, head.origin, head.revision)) { e.state.queue.shift(); e.state.operations[head.op] = 'rejected'; this.save(e); waiter.resolve({ state: 'rejected', detail: 'Eridani automation is held or superseded' }); return; }
      if (head.generation !== e.spec.generation) { e.state.queue.shift(); this.save(e); waiter.resolve({ state: 'rejected', detail: 'stale generation' }); return; }
      waiter.begin(); e.state.operations[head.op] = 'executing'; e.state.active = true; e.busy = true;
      e.prompt = { text: head.text, op: head.op, published: false }; e.finalText = ''; e.state.turnId = e.spec.harness === 'claude' ? `input:${head.op}` : null; this.save(e);
      await e.adapter.send(head.text, head.op); this.promptAccepted(e); e.state.operations[head.op] = 'delivered'; e.state.queue.shift(); this.save(e);
      if (e.state.active && !e.state.paused && !this.pending(e.spec.surf).length) this.activity(e, 'thinking');
      waiter.resolve({ state: 'executed', result: { surf: e.spec.surf, managed: true } });
    } catch { e.state.operations[head.op] = 'uncertain'; e.state.queue.shift(); try { this.save(e); } catch { /* block until persistence recovers */ } this.attention(e, 'Input receipt stalled; reconcile before retry'); waiter.resolve({ state: 'uncertain', detail: 'provider input receipt unknown' }); }
    finally {
      e.waiters.delete(head.op); e.pumping = false;
      // Completion can arrive while send() is still awaiting its receipt. Its pump attempt was guarded; retry now.
      void this.pump(e);
    }
  }
  findQuestion(id: string): { entry: Entry; question: Decision } | undefined { for (const entry of this.entries.values()) { const question = entry.state.decisions.find((q) => q.id === id); if (question) return { entry, question }; } return undefined; }
  precheck(cmd: AnswerCommand): string | null {
    const found = this.findQuestion(cmd.question_id); if (!found) return 'unknown managed question';
    const { entry: e, question: q } = found;
    if (cmd.request_digest !== undefined && cmd.request_digest !== q.digest) return 'stale action digest';
    if ((q.planRevision ?? 0) !== (e.spec.planRevision ?? 0)) return 'question belongs to a stale plan revision';
    if (cmd.plan_revision !== undefined && cmd.plan_revision !== (q.planRevision ?? 0)) return `stale plan revision (expected ${q.planRevision ?? 0}, got ${cmd.plan_revision})`;
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
    begin(); q.response = response; q.state = 'submitted'; this.save(e); e.receiptRequests.set(q.id, request);
    try { await e.adapter.respond(request, response); this.save(e); if (q.state === 'submitted') this.watchReceipt(e, q); this.activity(e, 'thinking'); return { state: 'executed', result: { decision: 'submitted', provider_confirmation: 'pending' } }; }
    catch { if (this.findQuestion(q.id)?.question.state === 'resolved') return { state: 'executed', result: { decision: 'consumed' } }; q.state = 'uncertain'; try { this.setAttention(e, { kind: 'receipt_uncertain', question_id: q.id, tool: q.request.method, reason: 'Decision delivery is uncertain; reconcile its receipt before retry' }); this.publish(e, q, true); } catch { this.attention(e, 'Decision delivery is uncertain and persistence is unavailable'); } return { state: 'uncertain', detail: 'decision delivery uncertain; consent will not be replayed' }; }
  }
  private setAttention(e: Entry, attention: ManagedAttention): void {
    if (e.state.attention?.kind === 'permission_denied' && attention.kind === 'receipt_uncertain') attention = e.state.attention;
    e.state.attention = attention; if (!e.state.paused) e.state.pausedBy = 'attention'; e.state.paused = true;
    this.save(e); this.deps.changed(e.spec.surf, e.state.sessionId, true, attention); this.attention(e, attention.reason);
  }
  private watchReceipt(e: Entry, q: Decision): void {
    const timer = setTimeout(() => {
      e.receiptTimers.delete(q.id); if (q.state !== 'submitted') return;
      q.state = 'uncertain';
      try { this.setAttention(e, { kind: 'receipt_uncertain', tool: q.request.method, question_id: q.id, reason: 'Provider did not confirm the submitted decision; reconcile its receipt before retry' }); this.publish(e, q, true); }
      catch { this.attention(e, 'Decision receipt is uncertain and persistence is unavailable'); }
    }, this.deps.decisionReceiptMs ?? 30_000); timer.unref?.(); e.receiptTimers.set(q.id, timer);
  }
  private confirm(e: Entry, id: string, tool = false): void {
    const q = e.state.decisions.find((q) => { const submitted = e.receiptRequests.get(q.id); return !!submitted && String(submitted.id) === String(q.request.id) && (q.state === 'submitted' || q.state === 'uncertain') && q.response !== undefined && String(tool ? submitted.params.tool_use_id : submitted.id) === id; });
    if (!q) return; const timer = e.receiptTimers.get(q.id); if (timer) clearTimeout(timer); e.receiptTimers.delete(q.id);
    q.state = 'resolved'; e.receiptRequests.delete(q.id);
    if (e.state.attention?.kind === 'receipt_uncertain' && e.state.attention.question_id === q.id) {
      delete e.state.attention; if (e.state.pausedBy === 'attention') { e.state.paused = false; delete e.state.pausedBy; }
      this.save(e); this.deps.changed(e.spec.surf, e.state.sessionId, e.state.paused, null);
    }
    this.save(e); e.liveRequests.delete(q.id);
    this.deps.emit({ t: 'question.resolved', question_id: q.id, surf: e.spec.surf, generation: q.generation, provider_request_id: String(q.request.id), incarnation: e.spec.incarnation, request_digest: q.digest, plan_revision: q.planRevision ?? 0, outcome: 'accepted', still_open: false, at: Date.now() });
    this.activity(e, e.state.paused ? 'waiting' : e.state.active ? 'thinking' : 'idle');
  }
  private async recreatePending(e: Entry): Promise<void> {
    const pending = e.state.decisions.filter((q) => q.state === 'pending' && q.generation === e.spec.generation && q.request.method !== 'claude/deferred' && !e.liveRequests.has(q.id));
    if (pending.length !== 1 || e.state.paused || e.handingOff || e.recovering || !e.adapter.recreate || e.state.decisions.some((q) => q.state === 'uncertain' || q.state === 'submitted')) return;
    e.recovering = true; this.activity(e, 'thinking', 'Recreating the pending request for review');
    try { await e.adapter.recreate(pending[0].request); } catch { e.recovering = false; this.attention(e, 'Pending request recreation stalled; review the provider connection'); }
  }
  /** Change a live session's model, keeping its conversation (an `input` with `model`). Throws when it cannot. */
  async setModel(surf: string, model: string): Promise<void> {
    const e = this.entries.get(surf); if (!e) throw new Error('unknown managed session');
    if (e.spec.model === model) return;
    if (!e.adapter.setModel) throw new Error(`${e.spec.harness} cannot change its model in a running session`);
    await e.adapter.setModel(model); e.spec.model = model; this.save(e);
  }
  async pause(surf: string, paused: boolean): Promise<void> {
    const e = this.entries.get(surf); if (!e) throw new Error('unknown managed session');
    if (!paused && e.state.attention?.kind === 'permission_denied') throw new Error('Automatic review denied the action; review it through explicit terminal takeover');
    if (!paused && e.state.attention?.action?.coordination) e.state.attention = undefined;
    e.state.paused = paused; e.state.pausedBy = paused ? 'operator' : undefined; this.save(e); this.deps.changed(surf, e.state.sessionId, paused, e.state.attention ?? null);
    if (paused && e.state.active && !this.pending(surf).length) await e.adapter.interrupt();
    if (!paused) { await this.recreatePending(e); void this.pump(e); }
    this.activity(e, paused ? 'waiting' : 'idle', paused ? 'Paused' : undefined);
  }
  async interrupt(surf: string): Promise<void> { await this.entries.get(surf)?.adapter.interrupt(); }
  async cancel(surf: string): Promise<void> {
    const e = this.entries.get(surf); if (!e) return;
    e.state.paused = true; for (const timer of e.receiptTimers.values()) clearTimeout(timer); e.receiptTimers.clear(); this.save(e); await e.adapter.stop();
    for (const q of e.state.decisions) if (q.state !== 'resolved') { q.state = 'resolved'; this.deps.emit({ t: 'question.resolved', question_id: q.id, surf, generation: q.generation, provider_request_id: String(q.request.id), incarnation: e.spec.incarnation, request_digest: q.digest, plan_revision: q.planRevision ?? 0, outcome: 'canceled', still_open: false, at: Date.now() }); }
    e.state.queue = []; this.save(e); for (const waiter of e.waiters.values()) waiter.resolve({ state: 'rejected', detail: 'run canceled' }); e.waiters.clear();
  }
  async stop(surf: string): Promise<void> { await this.entries.get(surf)?.adapter.stop(); }
  async takeoverNative(surf: string, cmd: string, env: Record<string, string>): Promise<void> {
    const e = this.entries.get(surf); if (!e || e.handingOff) throw new Error('takeover already in progress or unavailable');
    e.handingOff = true; e.state.paused = true; for (const timer of e.receiptTimers.values()) clearTimeout(timer); e.receiptTimers.clear(); this.save(e);
    try { await e.adapter.interrupt(); await e.adapter.stop();
      const native = spawnPty({ sessionId: surf, cmd, cwd: e.spec.cwd, env, cols: 120, rows: 32 });
      e.terminal.adoptNative(native);
    } catch (error) { e.handingOff = false; this.attention(e, 'Takeover failed; run remains paused'); throw error; }
  }
  async takeover(surf: string): Promise<string> { const e = this.entries.get(surf); if (!e?.state.sessionId) throw new Error('provider conversation is not ready'); await e.adapter.interrupt(); await e.adapter.stop(); return e.state.sessionId; }
  planRevision(surf: string, revision: number): void { const e = this.entries.get(surf); if (e && revision > (e.spec.planRevision ?? 0)) { e.spec.planRevision = revision; this.save(e); } }
  generation(surf: string, generation: number): void {
    const e = this.entries.get(surf); if (!e || generation <= e.spec.generation) return; e.spec.generation = generation;
    for (const q of e.state.decisions) if (q.generation < generation && q.state !== 'resolved') { q.state = q.state === 'pending' ? 'resolved' : 'uncertain'; this.deps.emit({ t: 'question.resolved', question_id: q.id, surf, generation: q.generation, provider_request_id: String(q.request.id), incarnation: e.spec.incarnation, request_digest: q.digest, plan_revision: q.planRevision ?? 0, outcome: 'canceled', still_open: false, at: Date.now() }); }
    this.save(e);
  }
  replay(): void { for (const e of this.entries.values()) { for (const q of e.state.decisions) if (q.state !== 'resolved') this.publish(e, q, !e.liveRequests.has(q.id)); for (const id of Object.keys(e.state.inputs)) this.inputReceipt(e, id); e.output.replay(); } }
}
