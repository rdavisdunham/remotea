/** Structured CLI transports. Authentication remains owned by the installed harness. */
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import { canonicalJson } from '../../src/shared/eridani-link-protocol';
import { loginShell, buildEnv } from './pty-spawn';

export interface HarnessSpec {
  harness: 'codex' | 'claude'; bin: string; args: string[]; cwd: string; env: Record<string, string>;
  model: string; effort?: string; profile: 'read-only' | 'workspace-write'; sessionId?: string;
}
export interface HarnessRequest { id: string | number; method: string; params: Record<string, any> }
export interface DirectInputContext { active: boolean; turnId: string | null }
export interface DirectInputReceipt { turnId: string | null; providerAcknowledged: boolean }
export class ProviderRequestRejected extends Error { constructor(message: string, readonly code?: number, readonly data?: unknown) { super(message); this.name = 'ProviderRequestRejected'; } }
export interface RuntimeAdapter {
  start(): Promise<string>;
  send(text: string, operationId: string): Promise<void>;
  sendDirect?(text: string, operationId: string, context: DirectInputContext): Promise<DirectInputReceipt>;
  interrupt(): Promise<void>;
  resume(): Promise<string>;
  respond(request: HarnessRequest, response: unknown): Promise<void>;
  stop(): Promise<void>;
  recreate?(request: HarnessRequest): Promise<void>;
  on(event: string, listener: (...args: any[]) => void): this;
}
const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** JSON lines only; call deadlines expose stalls without retrying uncertain effects. */
export class HarnessProcess extends EventEmitter {
  protected child: ChildProcessWithoutNullStreams | null = null;
  private buffer = '';
  protected restarting = false;
  private next = 0;
  private calls = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  constructor(readonly spec: HarnessSpec, readonly timeoutMs = 30_000) { super(); }
  protected launch(args: string[]): void {
    const command = [this.spec.bin, ...args].map(quote).join(' ');
    this.child = spawn(loginShell(), ['-l', '-i', '-c', `exec ${command}`], { cwd: this.spec.cwd, env: buildEnv(this.spec.env.REMOTEA_SESSION ?? 'managed', this.spec.env), stdio: 'pipe', detached: process.platform === 'linux' });
    this.child.stdin.on('error', (error) => this.emit('fault', error));
    this.child.stdout.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf8');
      if (this.buffer.length > 4 * 1024 * 1024) { this.emit('fault', new Error('provider JSON frame exceeded limit')); void this.stop(); return; }
      let at: number;
      while ((at = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, at); this.buffer = this.buffer.slice(at + 1);
        let message: unknown; try { message = JSON.parse(line); } catch { continue; }
        try { this.receive(message); } catch (error) { this.emit('fault', error); }
      }
    });
    // Provider stderr can contain credentials or private reasoning; retain no raw text.
    this.child.stderr.resume();
    this.child.on('error', (e) => this.emit('fault', e));
    this.child.on('exit', (code) => {
      for (const call of this.calls.values()) { clearTimeout(call.timer); call.reject(new Error('provider exited before receipt; reconcile before retry')); }
      this.calls.clear(); this.child = null; if (!this.restarting) this.emit('exit', code ?? -1);
    });
  }
  protected receive(message: any): void {
    if (message.type === 'control_response') message = { id: message.response?.request_id, ...(message.response?.subtype === 'error' ? { error: { message: message.response.error } } : { result: message.response?.response }) };
    if (message.id !== undefined && !message.method) {
      const call = this.calls.get(String(message.id));
      if (call) { this.calls.delete(String(message.id)); clearTimeout(call.timer); message.error ? call.reject(new ProviderRequestRejected(String(message.error.message ?? 'provider error'), message.error.code, message.error.data)) : call.resolve(message.result); return; }
    }
    this.emit('event', message);
  }
  protected write(message: unknown): void {
    if (!this.child?.stdin.writable) throw new Error('provider unavailable');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }
  /** Resolve when bytes have been accepted by the existing harness pipe, independently of model consumption. */
  protected writeAccepted(message: unknown): Promise<void> {
    const input = this.child?.stdin;
    if (!input?.writable) return Promise.reject(new ProviderRequestRejected('provider input is not writable'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('provider pipe write receipt is uncertain')), this.timeoutMs);
      input.write(`${JSON.stringify(message)}\n`, (error) => { clearTimeout(timer); error ? reject(error) : resolve(); });
    });
  }
  call(method: string, params: unknown): Promise<any> {
    const id = `remotea-${++this.next}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.calls.delete(id); reject(new Error(`${method} receipt stalled after ${this.timeoutMs}ms; execution is uncertain, reconcile before retry`)); }, this.timeoutMs);
      this.calls.set(id, { resolve, reject, timer });
      try { this.write(method.startsWith('control:') ? { type: 'control_request', request_id: id, request: { subtype: method.slice(8), ...(params as object) } } : { id, method, params }); } catch (e) { clearTimeout(timer); this.calls.delete(id); reject(e); }
    });
  }
  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    const signal = (name: NodeJS.Signals) => { try { if (process.platform === 'linux' && child.pid) process.kill(-child.pid, name); else child.kill(name); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; } };
    await new Promise<void>((resolve, reject) => {
      let hardTimeout: NodeJS.Timeout | undefined;
      const timeout = setTimeout(() => { signal('SIGKILL'); hardTimeout = setTimeout(() => reject(new Error('provider termination unconfirmed')), 1_000); }, 5_000);
      child.once('exit', () => { clearTimeout(timeout); if (hardTimeout) clearTimeout(hardTimeout); signal('SIGKILL'); resolve(); }); signal('SIGTERM');
    });
  }
}

export class CodexRuntimeAdapter extends HarnessProcess implements RuntimeAdapter {
  sessionId = ''; turnId: string | null = null;
  protected override receive(message: any): void {
    if (message.method === 'turn/started' && message.params?.turn?.id) this.turnId = message.params.turn.id;
    if (message.method === 'turn/completed' && (!message.params?.turn?.id || message.params.turn.id === this.turnId)) this.turnId = null;
    super.receive(message);
  }
  private async initializeTransport(): Promise<void> {
    this.launch([...CODEX_APP_SERVER_ARGS, ...this.spec.args]);
    const initialized = await this.call('initialize', { clientInfo: { name: 'remotea', version: '0.1.0' }, capabilities: { experimentalApi: true } });
    this.write({ method: 'initialized' }); this.emit('initialized', initialized);
  }
  async modelCatalog(): Promise<any[]> {
    await this.initializeTransport(); const models: any[] = []; let cursor: string | null = null;
    for (let page = 0; page < 5; page++) { const result = await this.call('model/list', { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) }); models.push(...result.data); cursor = result.nextCursor ?? null; if (!cursor) break; }
    return models;
  }
  async start(): Promise<string> {
    await this.initializeTransport();
    const params = { model: this.spec.model, cwd: this.spec.cwd, sandbox: this.spec.profile, approvalPolicy: 'on-request', approvalsReviewer: 'auto_review', config: this.spec.effort ? { model_reasoning_effort: this.spec.effort } : {} };
    const result = await this.call(this.spec.sessionId ? 'thread/resume' : 'thread/start', { ...params, ...(this.spec.sessionId ? { threadId: this.spec.sessionId } : {}) });
    this.sessionId = result.thread.id; return this.sessionId;
  }
  async resume(): Promise<string> { return this.start(); }
  async send(text: string, operationId: string): Promise<void> {
    const result = await this.call('turn/start', { threadId: this.sessionId, clientUserMessageId: operationId, input: [{ type: 'text', text, text_elements: [] }], model: this.spec.model, ...(this.spec.effort ? { effort: this.spec.effort } : {}) });
    this.turnId = result.turn.id;
  }
  async sendDirect(text: string, operationId: string, context: DirectInputContext): Promise<DirectInputReceipt> {
    const expected = context.turnId ?? this.turnId;
    if (context.active) {
      if (!expected) throw new ProviderRequestRejected('active turn identity is not yet available');
      try {
        const result = await this.call('turn/steer', { threadId: this.sessionId, expectedTurnId: expected, clientUserMessageId: operationId, input: [{ type: 'text', text, text_elements: [] }] });
        return { turnId: result.turnId, providerAcknowledged: true };
      } catch (error) {
        // Only an explicit native rejection proves this input was not consumed. Never retry a timed-out effect.
        if (!(error instanceof ProviderRequestRejected) || !/^(no active turn(?: to steer)?(?: on (?:this )?thread)?[.!]?|thread has no active turn[.!]?)$/i.test(error.message.trim())) throw error;
      }
    }
    this.emit('event', { type: 'remotea/direct-start', input_id: operationId });
    await this.send(text, operationId); return { turnId: this.turnId, providerAcknowledged: true };
  }
  async recreate(request: HarnessRequest): Promise<void> {
    const result = await this.call('turn/start', { threadId: this.sessionId, input: [{ type: 'text', text: `A host restart interrupted an UNAPPROVED request. Reconcile read-only context, then recreate only this exact request for fresh human review. Do not claim any action executed, do not replay prior uncertain actions, and do not perform unrelated work. Pending request: ${canonicalJson({ method: request.method, params: request.params })}`, text_elements: [] }], model: this.spec.model, ...(this.spec.effort ? { effort: this.spec.effort } : {}), approvalPolicy: 'untrusted', approvalsReviewer: 'user', sandboxPolicy: { type: 'readOnly', networkAccess: false } });
    this.turnId = result.turn.id;
  }
  async interrupt(): Promise<void> { if (this.turnId) await this.call('turn/interrupt', { threadId: this.sessionId, turnId: this.turnId }); }
  async respond(request: HarnessRequest, response: unknown): Promise<void> { this.write({ id: request.id, result: response }); }
}

/** The app-server transport the Codex adapter speaks (the conformance probe checks `app-server --help` for each flag). */
export const CODEX_APP_SERVER_ARGS: readonly string[] = ['app-server', '--stdio'];

/** The hooks the Claude adapter registers in `initialize`; receive() answers both callback ids. */
export const CLAUDE_INITIALIZE = { hooks: { PreToolUse: [{ matcher: '*', hookCallbackIds: ['remotea-defer-ask'] }], PermissionDenied: [{ matcher: '*', hookCallbackIds: ['remotea-permission-denied'] }] } };

/**
 * The Claude adapter's command line. `--permission-prompt-tool stdio` is what makes Claude Code send
 * `can_use_tool` (approvals, AskUserQuestion) to this host; `--permission-prompts host` alone leaves
 * prompts unanswered and denied locally, and AskUserQuestion disabled (checked on 2.1.316–2.1.318).
 */
export function claudeLaunchArgs(spec: HarnessSpec, sessionId: string): string[] {
  return ['-p', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json', '--include-partial-messages', '--replay-user-messages', '--permission-prompts', 'host', '--permission-prompt-tool', 'stdio', '--settings', JSON.stringify({ env: { MCP_TIMEOUT: '20000', MCP_TOOL_TIMEOUT: '120000', ...(spec.effort ? { CLAUDE_CODE_EFFORT_LEVEL: spec.effort } : {}) } }), '--permission-mode', spec.profile === 'read-only' ? 'plan' : 'auto', '--model', spec.model, ...(spec.effort ? ['--effort', spec.effort] : []), ...(spec.sessionId ? ['--resume', spec.sessionId] : ['--session-id', sessionId]), ...spec.args];
}

/** Every `--flag` an argv uses (the conformance probe's `--help` check). */
export function flagsOf(args: readonly string[]): string[] {
  return [...new Set(args.filter((a) => /^--[a-z][a-z0-9-]*$/.test(a)))];
}

export class ClaudeRuntimeAdapter extends HarnessProcess implements RuntimeAdapter {
  sessionId = '';
  private recoveryGate = false;
  private deferredAnswer: { input: unknown; id: string; response: any } | null = null;
  protected override receive(message: any): void {
    if (message.type === 'control_request' && message.request?.subtype === 'hook_callback' && message.request?.callback_id === 'remotea-permission-denied') {
      this.write({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: { hookSpecificOutput: { hookEventName: 'PermissionDenied', retry: false } } } });
      this.emit('event', { type: 'remotea/permission-denied', input: message.request.input }); return;
    }
    if (message.type === 'control_request' && message.request?.subtype === 'hook_callback' && message.request?.callback_id === 'remotea-defer-ask') {
      const input = message.request.input;
      if (input.tool_name !== 'AskUserQuestion') { this.write({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: this.recoveryGate ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask' } } : {} } }); return; }
      const saved = this.deferredAnswer;
      const matches = saved && saved.id === input.tool_use_id && canonicalJson(saved.input) === canonicalJson(input.tool_input);
      const output = matches ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: saved.response.updatedInput } } : { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'defer' } };
      this.write({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: output } });
      if (matches) this.deferredAnswer = null;
      return;
    }
    super.receive(message);
  }
  async start(): Promise<string> {
    this.sessionId = this.spec.sessionId ?? randomUUID();
    this.launch(claudeLaunchArgs(this.spec, this.sessionId));
    const initialized = await this.call('control:initialize', CLAUDE_INITIALIZE); this.emit('initialized', initialized); this.emit('catalog', initialized.models ?? []); return this.sessionId;
  }
  async resume(): Promise<string> { return this.start(); }
  async send(text: string, operationId: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const listener = (m: any) => { if (m.type === 'user' && m.uuid === operationId) { clearTimeout(timeout); this.off('event', listener); resolve(); } };
      const timeout = setTimeout(() => { this.off('event', listener); reject(new Error('Claude user-message receipt stalled; reconcile before retry')); }, this.timeoutMs);
      this.on('event', listener);
      try { this.write({ type: 'user', session_id: this.sessionId, uuid: operationId, message: { role: 'user', content: text }, parent_tool_use_id: null }); } catch (e) { clearTimeout(timeout); this.off('event', listener); reject(e); }
    });
  }
  async sendDirect(text: string, operationId: string, context: DirectInputContext): Promise<DirectInputReceipt> {
    await this.writeAccepted({ type: 'user', session_id: this.sessionId, uuid: operationId, message: { role: 'user', content: text }, parent_tool_use_id: null });
    return { turnId: context.turnId, providerAcknowledged: false };
  }
  async recreate(request: HarnessRequest): Promise<void> {
    this.recoveryGate = true; await this.call('control:set_permission_mode', { mode: 'manual' });
    await this.send(`A host restart interrupted an UNAPPROVED request. Recreate only this exact request for fresh human review. Do not execute unrelated work or replay any uncertain action. Pending request: ${canonicalJson({ method: request.method, params: request.params })}`, randomUUID());
  }
  async interrupt(): Promise<void> { this.write({ type: 'control_request', request_id: `interrupt-${Date.now()}`, request: { subtype: 'interrupt' } }); }
  async respond(request: HarnessRequest, response: unknown): Promise<void> {
    if (request.method === 'claude/deferred') {
      this.deferredAnswer = { id: String(request.id), input: request.params.input, response };
      this.restarting = true; try { await this.stop(); this.spec.sessionId = this.sessionId; await this.start(); } finally { this.restarting = false; }
      return;
    }
    this.write({ type: 'control_response', response: { subtype: 'success', request_id: request.id, response } });
  }
}
