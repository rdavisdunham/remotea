/**
 * The conformance probe (launcher-conformance.ts decides what its result
 * admits): the REAL installed binary, started by the REAL runtime adapter
 * (managed-harness.ts) exactly as a managed run starts it, through the login
 * shell, and driven through everything the adapter and managed-sessions.ts
 * rely on.
 *
 * No paid model call, no account: the binary runs against a scratch config
 * (CLAUDE_CONFIG_DIR / CODEX_HOME in a temporary folder) and a local fake
 * model API that scripts each turn (the same technique as
 * scripts/capability-codex.mjs). Nothing in ~/.claude or ~/.codex is read or
 * written, no user hook fires, and every turn is checked to have reached the
 * fake (a login shell that overrides the endpoint fails the probe instead of
 * spending). REMOTEA_LAUNCHER_PROBE_TURNS=off skips every step that drives a
 * turn; they are reported `skipped` ("not probed") and do not fail the probe.
 *
 * Claude steps:  help, initialize, permission_mode, user_echo, hook_callback,
 *                approval_allow, approval_deny, question_defer, interrupt
 * Codex steps:   help, initialize, model_catalog, thread_start, user_echo,
 *                approval_allow, approval_deny, steer, interrupt, steer_idle, resume
 *
 * Each step has a hard timeout (STEP_MS) and the whole probe a budget
 * (TOTAL_MS); after a failure the remaining steps are `skipped`.
 */
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import type { Socket } from 'net';
import { ClaudeRuntimeAdapter, CodexRuntimeAdapter, CODEX_APP_SERVER_ARGS, claudeLaunchArgs, flagsOf, type HarnessSpec } from './managed-harness';
import { buildEnv, loginShell, shellArgs } from './pty-spawn';
import type { ConformanceRunner, ConformanceStep, ManagedHarness } from './launcher-conformance';

export const STEP_MS = 20_000;
export const TOTAL_MS = 90_000;
const DIRECTIVE = 'REMOTEA_PROBE';
const PROBE_ANSWER = 'Beta';
const PROBE_QUESTION = 'Which option should the conformance probe pick?';
const clip = (s: string) => (s.length > 300 ? `${s.slice(0, 299)}…` : s);
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export interface ConformanceProbeOptions {
  stepMs?: number;
  totalMs?: number;
  /** false: skip the steps that drive a turn (reported `skipped`). Default: REMOTEA_LAUNCHER_PROBE_TURNS is not off. */
  turns?: boolean;
  /** Where the scratch folder goes (default os.tmpdir()). */
  tmpDir?: string;
}

export function turnsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !/^(off|0|false|no)$/i.test(env.REMOTEA_LAUNCHER_PROBE_TURNS?.trim() ?? '');
}

export const defaultConformanceRunner: ConformanceRunner = (harness, bin) => runConformance(harness, bin);

export function runConformance(harness: ManagedHarness, bin: string, o: ConformanceProbeOptions = {}): Promise<ConformanceStep[]> {
  return harness === 'claude' ? claudeConformance(bin, o) : codexConformance(bin, o);
}

// ── Step bookkeeping ───────────────────────────────────────────────────────

class Steps {
  readonly list: ConformanceStep[] = [];
  private failed: string | null = null;
  private readonly deadline: number;
  constructor(private readonly stepMs: number, totalMs: number, private readonly turns: boolean) {
    this.deadline = Date.now() + totalMs;
  }

  get ok(): boolean { return this.failed === null; }

  /** Run one step; true when it passed (or was skipped as a turn step). */
  async run(id: string, fn: () => Promise<string | void>, o: { turn?: boolean } = {}): Promise<boolean> {
    if (this.failed) { this.list.push({ id, status: 'skipped', ms: 0, message: `not run: ${this.failed} failed` }); return false; }
    if (o.turn && !this.turns) { this.list.push({ id, status: 'skipped', ms: 0, message: 'not probed: turn steps are off (REMOTEA_LAUNCHER_PROBE_TURNS)' }); return true; }
    const left = this.deadline - Date.now();
    if (left <= 0) { this.failed = id; this.list.push({ id, status: 'fail', ms: 0, message: 'the probe ran out of time' }); return false; }
    const ms = Math.min(this.stepMs, left);
    const t0 = Date.now();
    let timer: NodeJS.Timeout | undefined;
    try {
      const note = await Promise.race([fn(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`no answer within ${Math.round(ms / 1000)} s`)), ms); })]);
      this.list.push({ id, status: 'pass', ms: Date.now() - t0, ...(note ? { message: clip(note) } : {}) });
      return true;
    } catch (err) {
      this.failed = id;
      this.list.push({ id, status: 'fail', ms: Date.now() - t0, message: clip((err as Error).message || String(err)) });
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Every event an adapter emits, so a step can wait for one that arrives after a mark (registered before it acts). */
class Events {
  private readonly list: any[] = [];
  private waiters: Array<{ from: number; match: (e: any) => boolean; fail?: (e: any) => string | null; resolve: (e: any) => void; reject: (e: Error) => void }> = [];
  constructor(emitter: { on(event: string, l: (...a: any[]) => void): unknown }, event: string) {
    emitter.on(event, (e: any) => {
      this.list.push(e);
      const at = this.list.length - 1;
      for (const w of [...this.waiters]) this.check(w, e, at);
    });
  }
  mark(): number { return this.list.length; }
  private check(w: Events['waiters'][number], e: any, at: number): void {
    if (at < w.from) return;
    const why = w.fail?.(e);
    if (why) { this.waiters = this.waiters.filter((x) => x !== w); w.reject(new Error(why)); return; }
    if (w.match(e)) { this.waiters = this.waiters.filter((x) => x !== w); w.resolve(e); }
  }
  /** The first event at or after `from` that matches; `fail` names an event that proves it will not come. */
  waitFor(match: (e: any) => boolean, from: number, fail?: (e: any) => string | null): Promise<any> {
    return new Promise((resolve, reject) => {
      const w = { from, match, fail, resolve, reject };
      for (let i = from; i < this.list.length; i++) {
        const why = fail?.(this.list[i]);
        if (why) { reject(new Error(why)); return; }
        if (match(this.list[i])) { resolve(this.list[i]); return; }
      }
      this.waiters.push(w);
    });
  }
}

const until = async (test: () => boolean): Promise<void> => { while (!test()) await new Promise((r) => setTimeout(r, 25)); };

/** `<bin> <args…>` through the login shell with a session's environment; its stdout. */
export function shellOutput(bin: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = buildEnv('conformance-probe', undefined);
    delete env.REMOTEA_SESSION;
    const child = spawn(loginShell(), shellArgs([bin, ...args].map(q).join(' ')), { cwd: os.homedir(), env, stdio: ['ignore', 'pipe', 'ignore'], detached: true });
    let out = '';
    const timer = setTimeout(() => { try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } reject(new Error(`\`${bin} ${args.join(' ')}\` did not answer within ${Math.round(timeoutMs / 1000)} s`)); }, timeoutMs);
    child.stdout.on('data', (d: Buffer) => { if (out.length < 512 * 1024) out += d.toString('utf8'); });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => { clearTimeout(timer); code === 0 ? resolve(out) : reject(new Error(`\`${bin} ${args.join(' ')}\` exited ${code}`)); });
  });
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** The flags a `--help` text does not mention. */
export function missingFlags(help: string, flags: readonly string[]): string[] {
  return flags.filter((f) => !new RegExp(`(^|[\\s,\\[])${escapeRe(f)}(?=[\\s,=<\\[\\]]|$)`, 'm').test(help));
}

/** `--permission-mode <mode> … (choices: "acceptEdits", "auto", …)`; null when the help lists no choices. */
export function permissionModeChoices(help: string): string[] | null {
  const at = help.indexOf('--permission-mode');
  if (at < 0) return null;
  const rest = help.slice(at);
  const next = rest.slice(1).search(/\n\s{0,4}-/);
  const block = next < 0 ? rest : rest.slice(0, next + 1);
  const m = /choices:([^)]*)\)/.exec(block);
  return m ? [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]) : null;
}

// ── Fake model APIs ─────────────────────────────────────────────────────────

interface ProbeTurn { action: string; arg?: string }
interface FakeModel {
  url: string;
  /** Model requests received. */
  requests: number;
  /** Requests being held open (a `hang` turn). */
  hangs: number;
  /** Tool results the binary sent back, by tool call id. */
  results: Map<string, { isError: boolean; text: string }>;
  close(): Promise<void>;
}

/** The last directive in a conversation (a user message containing REMOTEA_PROBE:<action>[:<arg>]) and its index. */
function directive(items: any[], isUser: (i: any) => boolean): { turn: ProbeTurn | null; at: number } {
  for (let i = items.length - 1; i >= 0; i--) {
    if (!isUser(items[i])) continue;
    const m = new RegExp(`${DIRECTIVE}:([a-z]+)(?::([^\\s"\\\\]+))?`).exec(JSON.stringify(items[i]));
    if (m) return { turn: { action: m[1], arg: m[2] }, at: i };
  }
  return { turn: null, at: -1 };
}

function serve(handle: (body: any, url: string, res: http.ServerResponse, fake: FakeModel) => void): Promise<FakeModel> {
  const sockets = new Set<Socket>();
  const fake: FakeModel = { url: '', requests: 0, hangs: 0, results: new Map(), close: async () => {} };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { if (raw.length < 16 * 1024 * 1024) raw += c; });
    req.on('end', () => {
      let body: any = {};
      try { body = JSON.parse(raw || '{}'); } catch { /* not JSON */ }
      try { handle(body, req.url ?? '', res, fake); } catch { res.writeHead(500); res.end('{}'); }
    });
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    fake.close = () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); });
    resolve(fake);
  }));
}

const sse = (res: http.ServerResponse, events: any[], end = true) => {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  for (const e of events) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  if (end) res.end();
};

/** Anthropic Messages API: `echo` answers, `bash:<file>` asks for `touch <file>`, `ask` asks AskUserQuestion, `hang` never answers. */
export function fakeAnthropic(): Promise<FakeModel> {
  return serve((j, url, res, fake) => {
    if (!/^\/v1\/messages(\?|$)/.test(url)) { res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'not part of the conformance probe' } })); return; }
    const n = ++fake.requests;
    const messages: any[] = Array.isArray(j.messages) ? j.messages : [];
    const { turn, at } = directive(messages, (m) => m?.role === 'user');
    let answered = false;
    for (const m of messages.slice(at + 1)) for (const c of Array.isArray(m?.content) ? m.content : []) {
      if (c?.type !== 'tool_result') continue;
      answered = true;
      const text = typeof c.content === 'string' ? c.content : JSON.stringify(c.content ?? '');
      fake.results.set(String(c.tool_use_id), { isError: c.is_error === true, text });
    }
    const start = { type: 'message_start', message: { id: `msg_probe_${n}`, type: 'message', role: 'assistant', model: j.model ?? 'probe', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } };
    if (turn?.action === 'hang' && !answered) { fake.hangs++; sse(res, [start], false); return; }
    let tool: { name: string; input: unknown } | null = null;
    if (!answered && turn?.action === 'bash' && turn.arg) tool = { name: 'Bash', input: { command: `touch ${turn.arg}`, description: 'remotea conformance probe' } };
    if (!answered && turn?.action === 'ask') tool = { name: 'AskUserQuestion', input: { questions: [{ question: PROBE_QUESTION, header: 'Probe', multiSelect: false, options: [{ label: 'Alpha', description: 'first' }, { label: PROBE_ANSWER, description: 'second' }] }] } };
    const block = tool
      ? [{ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `toolu_remotea_probe_${n}`, name: tool.name, input: {} } }, { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(tool.input) } }, { type: 'content_block_stop', index: 0 }]
      : [{ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'probe turn done' } }, { type: 'content_block_stop', index: 0 }];
    const end = [{ type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }, { type: 'message_stop' }];
    if (j.stream === false) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ...start.message, content: tool ? [{ type: 'tool_use', id: `toolu_remotea_probe_${n}`, ...tool }] : [{ type: 'text', text: 'probe turn done' }], stop_reason: tool ? 'tool_use' : 'end_turn' }));
      return;
    }
    sse(res, [start, ...block, ...end]);
  });
}

/** OpenAI Responses API (as scripts/capability-codex.mjs): `echo`, `bash:<file>` (an escalated `touch`), `hang`. */
export function fakeResponses(): Promise<FakeModel> {
  return serve((j, url, res, fake) => {
    if (!/responses/.test(url)) { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{}'); return; }
    const n = ++fake.requests;
    const input: any[] = Array.isArray(j.input) ? j.input : [];
    const { turn, at } = directive(input, (i) => i?.role === 'user');
    const outputs = input.slice(at + 1).filter((i) => i?.type === 'function_call_output');
    for (const o of outputs) fake.results.set(String(o.call_id), { isError: false, text: typeof o.output === 'string' ? o.output : JSON.stringify(o.output ?? '') });
    const created = { type: 'response.created', response: { id: `resp_probe_${n}` } };
    if (turn?.action === 'hang' && !outputs.length) { fake.hangs++; sse(res, [created], false); return; }
    let item: any;
    if (turn?.action === 'bash' && turn.arg && !outputs.length) {
      const tools: string[] = (Array.isArray(j.tools) ? j.tools : []).map((t: any) => t?.name ?? t?.type);
      const name = tools.includes('shell_command') ? 'shell_command' : tools.includes('exec_command') ? 'exec_command' : 'shell';
      const cmd = `touch ${turn.arg}`;
      const args = name === 'shell' ? { command: ['bash', '-lc', cmd] } : name === 'exec_command' ? { cmd } : { command: cmd };
      item = { type: 'function_call', id: `fc_probe_${n}`, call_id: `call_probe_${n}`, name, arguments: JSON.stringify({ ...args, sandbox_permissions: 'require_escalated', justification: 'remotea conformance probe' }) };
    } else {
      item = { type: 'message', role: 'assistant', id: `msg_probe_${n}`, content: [{ type: 'output_text', text: 'probe turn done', annotations: [] }] };
    }
    sse(res, [created, { type: 'response.output_item.done', item }, { type: 'response.completed', response: { id: `resp_probe_${n}`, usage: { input_tokens: 1, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 2 } } }]);
  });
}

// ── Claude ──────────────────────────────────────────────────────────────────

/** The real adapter; hook callbacks are also reported to the probe (receive() still answers them). */
class ProbeClaudeAdapter extends ClaudeRuntimeAdapter {
  protected override receive(message: any): void {
    if (message?.type === 'control_request' && message.request?.subtype === 'hook_callback') this.emit('probe-hook', message);
    super.receive(message);
  }
}

/** Flags `--help` does not show (the SDK's own); the approval steps prove they work instead. */
const CLAUDE_HIDDEN_FLAGS: readonly string[] = ['--permission-prompt-tool'];

const NOT_REACHED = 'the turn never reached the local fake model (does the login shell override ANTHROPIC_BASE_URL or CLAUDE_CONFIG_DIR?)';

export async function claudeConformance(bin: string, o: ConformanceProbeOptions = {}): Promise<ConformanceStep[]> {
  const stepMs = o.stepMs ?? STEP_MS;
  const steps = new Steps(stepMs, o.totalMs ?? TOTAL_MS, o.turns ?? turnsEnabled());
  const root = fs.mkdtempSync(path.join(o.tmpDir ?? os.tmpdir(), 'remotea-conformance-claude-'));
  let fake: FakeModel | null = null;
  let adapter: ProbeClaudeAdapter | null = null;
  try {
    await steps.run('help', async () => {
      const help = await shellOutput(bin, ['--help'], stepMs);
      const sample: HarnessSpec = { harness: 'claude', bin, args: [], cwd: root, env: {}, model: 'default', effort: 'low', profile: 'workspace-write' };
      const flags = [...new Set([...flagsOf(claudeLaunchArgs(sample, randomUUID())), ...flagsOf(claudeLaunchArgs({ ...sample, sessionId: randomUUID() }, ''))])];
      const missing = missingFlags(help, flags.filter((f) => !CLAUDE_HIDDEN_FLAGS.includes(f)));
      if (missing.length) throw new Error(`\`${bin} --help\` does not list ${missing.join(', ')}`);
      const modes = permissionModeChoices(help);
      const absent = modes ? ['plan', 'auto', 'manual'].filter((m) => !modes.includes(m)) : [];
      if (absent.length) throw new Error(`--permission-mode no longer offers ${absent.join(', ')}`);
      return `${flags.length} flags listed`;
    });
    fake = await fakeAnthropic();
    const config = path.join(root, 'config');
    const work = path.join(root, 'work');
    fs.mkdirSync(config, { recursive: true });
    fs.mkdirSync(work, { recursive: true });
    // Also in settings: they apply after anything the login shell's profile exports.
    fs.writeFileSync(path.join(config, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: fake.url } }));
    const spec: HarnessSpec = {
      harness: 'claude', bin, args: [], cwd: work, model: 'default', effort: 'low', profile: 'workspace-write',
      env: { REMOTEA_SESSION: 'conformance-probe', CLAUDE_CONFIG_DIR: config, ANTHROPIC_BASE_URL: fake.url, ANTHROPIC_API_KEY: 'sk-ant-remotea-conformance-probe', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1' },
    };
    const a = (adapter = new ProbeClaudeAdapter(spec, stepMs));
    const events = new Events(a, 'event');
    const hooks = new Events(a, 'probe-hook');
    let init: any = null;
    a.on('initialized', (r: any) => { init = r; });
    a.on('fault', () => {});
    a.on('exit', () => {});
    const fake_ = fake;

    await steps.run('initialize', async () => {
      await a.start();
      const models = init?.models;
      if (!Array.isArray(models) || !models.length) throw new Error('initialize returned no model list');
      if (models.some((m: any) => typeof m?.value !== 'string' || typeof m?.displayName !== 'string')) throw new Error('a model entry has no value or displayName');
      if (!models.some((m: any) => Array.isArray(m?.supportedEffortLevels))) throw new Error('no model reports supportedEffortLevels');
      if (!models.some((m: any) => typeof m?.supportsAutoMode === 'boolean')) throw new Error('no model reports supportsAutoMode');
      if (typeof init.current_permission_mode === 'string' && init.current_permission_mode !== 'auto') throw new Error(`--permission-mode auto started in "${init.current_permission_mode}"`);
      return `${models.length} models`;
    });
    await steps.run('permission_mode', async () => {
      for (const mode of ['manual', 'auto', 'manual']) {
        const r = await a.call('control:set_permission_mode', { mode });
        if (typeof r?.mode !== 'string') throw new Error(`set_permission_mode ${mode} answered without a mode`);
        if (mode === 'auto' && r.mode !== 'auto') throw new Error(`set_permission_mode auto answered "${r.mode}"`);
      }
    });
    const result = (e: any) => e?.type === 'result';
    await steps.run('user_echo', async () => {
      const from = events.mark();
      await a.send(`${DIRECTIVE}:echo`, randomUUID()); // resolves on the replayed user message with this uuid
      await events.waitFor(result, from);
      if (!fake_.requests) throw new Error(NOT_REACHED);
    }, { turn: true });

    const allowed = path.join(work, 'allowed');
    const denied = path.join(work, 'denied');
    let from = 0;
    await steps.run('hook_callback', async () => {
      from = events.mark();
      const hookFrom = hooks.mark();
      await a.send(`${DIRECTIVE}:bash:${allowed}`, randomUUID());
      const h = await hooks.waitFor((m) => m.request?.input?.tool_name === 'Bash', hookFrom);
      const input = h.request.input;
      if (h.request.callback_id !== 'remotea-defer-ask') throw new Error(`PreToolUse called back "${h.request.callback_id}"`);
      if (input.hook_event_name !== 'PreToolUse' || typeof input.tool_use_id !== 'string' || typeof input.tool_input?.command !== 'string') throw new Error('the PreToolUse callback lacks hook_event_name, tool_use_id or tool_input.command');
    }, { turn: true });
    const permission = (e: any) => e?.type === 'control_request' && e.request?.subtype === 'can_use_tool';
    const decidedLocally = (e: any) => (result(e) ? 'the command was decided without asking the host (no can_use_tool)' : null);
    await steps.run('approval_allow', async () => {
      const req = await events.waitFor(permission, from, decidedLocally);
      if (req.request.tool_name !== 'Bash' || typeof req.request.input?.command !== 'string') throw new Error('can_use_tool lacks tool_name or input');
      await a.respond({ id: req.request_id, method: 'claude/permission', params: req.request }, { behavior: 'allow', updatedInput: req.request.input });
      await events.waitFor(result, from);
      if (!fs.existsSync(allowed)) throw new Error('an allowed command did not run');
      const r = typeof req.request.tool_use_id === 'string' ? fake_.results.get(req.request.tool_use_id) : undefined;
      if (r?.isError) throw new Error('an allowed command came back as an error');
    }, { turn: true });
    await steps.run('approval_deny', async () => {
      const start = events.mark();
      await a.send(`${DIRECTIVE}:bash:${denied}`, randomUUID());
      const req = await events.waitFor(permission, start, decidedLocally);
      await a.respond({ id: req.request_id, method: 'claude/permission', params: req.request }, { behavior: 'deny', message: 'denied by the remotea conformance probe' });
      await events.waitFor(result, start);
      if (fs.existsSync(denied)) throw new Error('a denied command ran');
      const r = typeof req.request.tool_use_id === 'string' ? fake_.results.get(req.request.tool_use_id) : undefined;
      if (r && !r.isError) throw new Error('a denied command did not come back as an error');
    }, { turn: true });
    await steps.run('question_defer', async () => {
      const start = events.mark();
      await a.send(`${DIRECTIVE}:ask`, randomUUID());
      const res = await events.waitFor(result, start);
      const d = res.deferred_tool_use;
      if (res.stop_reason !== 'tool_deferred' || d?.name !== 'AskUserQuestion') throw new Error(`AskUserQuestion was not deferred to the host (stop_reason ${String(res.stop_reason)})`);
      const question = d.input?.questions?.[0]?.question;
      if (typeof question !== 'string') throw new Error('the deferred tool use has no question');
      const resumed = events.mark();
      // The adapter restarts the CLI with --resume and answers the repeated PreToolUse with the saved answer.
      await a.respond({ id: String(d.id), method: 'claude/deferred', params: { tool_name: d.name, input: d.input, tool_use_id: d.id } }, { behavior: 'allow', updatedInput: { ...d.input, answers: { [question]: PROBE_ANSWER } } });
      await events.waitFor(result, resumed);
      const r = fake_.results.get(String(d.id));
      if (!r || r.isError || !r.text.includes(PROBE_ANSWER)) throw new Error('the resumed conversation did not give the model the answer');
    }, { turn: true });
    await steps.run('interrupt', async () => {
      const start = events.mark();
      const hangs = fake_.hangs;
      await a.send(`${DIRECTIVE}:hang`, randomUUID());
      await until(() => fake_.hangs > hangs);
      await a.interrupt();
      await events.waitFor(result, start);
    }, { turn: true });
  } finally {
    await adapter?.stop().catch(() => {});
    await fake?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
  return steps.list;
}

// ── Codex ───────────────────────────────────────────────────────────────────

export async function codexConformance(bin: string, o: ConformanceProbeOptions = {}): Promise<ConformanceStep[]> {
  const stepMs = o.stepMs ?? STEP_MS;
  const steps = new Steps(stepMs, o.totalMs ?? TOTAL_MS, o.turns ?? turnsEnabled());
  const root = fs.mkdtempSync(path.join(o.tmpDir ?? os.tmpdir(), 'remotea-conformance-codex-'));
  let fake: FakeModel | null = null;
  const adapters: CodexRuntimeAdapter[] = [];
  try {
    await steps.run('help', async () => {
      const help = await shellOutput(bin, [CODEX_APP_SERVER_ARGS[0], '--help'], stepMs);
      const missing = missingFlags(help, flagsOf(CODEX_APP_SERVER_ARGS));
      if (missing.length) throw new Error(`\`${bin} ${CODEX_APP_SERVER_ARGS[0]} --help\` does not list ${missing.join(', ')}`);
    });
    fake = await fakeResponses();
    const home = path.join(root, 'codex-home');
    const work = path.join(root, 'work');
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(work, { recursive: true });
    const provider = `{ name = "remotea-probe", base_url = "${fake.url}/v1", wire_api = "responses", requires_openai_auth = false, stream_max_retries = 0, request_max_retries = 0 }`;
    fs.writeFileSync(path.join(home, 'config.toml'), [
      'model = "remotea-probe-model"', 'model_provider = "remotea_probe"', 'check_for_update_on_startup = false',
      `model_providers.remotea_probe = ${provider}`, `[projects."${work}"]`, 'trust_level = "trusted"', '',
    ].join('\n'));
    // The provider also on the command line: it holds even if the login shell's profile moves CODEX_HOME.
    const spec: HarnessSpec = { harness: 'codex', bin, args: ['-c', 'model_provider="remotea_probe"', '-c', `model_providers.remotea_probe=${provider}`], cwd: work, env: { REMOTEA_SESSION: 'conformance-probe', CODEX_HOME: home }, model: 'remotea-probe-model', effort: 'low', profile: 'workspace-write' };
    const fresh = (s: HarnessSpec) => { const x = new CodexRuntimeAdapter(s, stepMs); x.on('fault', () => {}); x.on('exit', () => {}); adapters.push(x); return x; };
    const fake_ = fake;

    let models: any[] = [];
    await steps.run('initialize', async () => {
      const catalog = fresh(spec);
      let init: any = null;
      catalog.on('initialized', (r: any) => { init = r; });
      try { models = await catalog.modelCatalog(); } finally { await catalog.stop().catch(() => {}); }
      if (typeof init?.userAgent !== 'string') throw new Error('initialize answered without userAgent');
      if (typeof init.codexHome === 'string' && path.resolve(init.codexHome) !== path.resolve(home)) throw new Error('the login shell overrides CODEX_HOME; the probe would not be isolated');
    });
    await steps.run('model_catalog', async () => {
      if (!models.length) throw new Error('model/list returned no models');
      if (models.some((m) => typeof m?.model !== 'string')) throw new Error('a model/list entry has no model');
      if (!models.some((m) => Array.isArray(m?.supportedReasoningEfforts) && m.supportedReasoningEfforts.every((e: any) => typeof e?.reasoningEffort === 'string'))) throw new Error('no model/list entry has supportedReasoningEfforts');
      if (!models.some((m) => typeof m?.isDefault === 'boolean')) throw new Error('no model/list entry has isDefault');
      return `${models.length} models`;
    });
    const a = fresh(spec);
    const events = new Events(a, 'event');
    await steps.run('thread_start', async () => {
      const id = await a.start();
      if (typeof id !== 'string' || !id) throw new Error('thread/start returned no thread id');
    });
    const completed = (e: any) => e?.method === 'turn/completed';
    await steps.run('user_echo', async () => {
      const from = events.mark();
      const op = randomUUID();
      await a.send(`${DIRECTIVE}:echo`, op);
      await events.waitFor((e) => (e?.method === 'item/started' || e?.method === 'item/completed') && e.params?.item?.type === 'userMessage' && e.params.item.clientId === op, from);
      await events.waitFor((e) => e?.method === 'item/completed' && e.params?.item?.type === 'agentMessage' && typeof e.params.item.text === 'string', from);
      await events.waitFor(completed, from);
      if (!fake_.requests) throw new Error('the turn never reached the local fake model (does the login shell override CODEX_HOME?)');
    }, { turn: true });
    const approval = (e: any) => e?.method === 'item/commandExecution/requestApproval' && e.id !== undefined;
    const decidedLocally = (e: any) => (completed(e) ? 'the command was decided without asking the host (no requestApproval)' : null);
    // recreate(): the adapter's own turn/start with per-turn approvalPolicy untrusted, approvalsReviewer user, read-only sandbox.
    const approvalTurn = async (file: string, decision: 'accept' | 'decline') => {
      const from = events.mark();
      await a.recreate({ id: `probe-${decision}`, method: 'remotea/probe', params: { probe: `${DIRECTIVE}:bash:${file}` } });
      const req = await events.waitFor(approval, from, decidedLocally);
      if (typeof req.params?.command !== 'string' || typeof req.params?.turnId !== 'string') throw new Error('requestApproval lacks command or turnId');
      await a.respond(req, { decision });
      await events.waitFor(completed, from);
      return { req, from };
    };
    await steps.run('approval_allow', async () => {
      const file = path.join(work, 'allowed');
      await approvalTurn(file, 'accept');
      if (!fs.existsSync(file)) throw new Error('an accepted command did not run');
    }, { turn: true });
    await steps.run('approval_deny', async () => {
      const file = path.join(work, 'denied');
      const { from } = await approvalTurn(file, 'decline');
      if (fs.existsSync(file)) throw new Error('a declined command ran');
      await events.waitFor((e) => e?.method === 'item/completed' && e.params?.item?.type === 'commandExecution', from).then((e) => { if (e.params.item.status !== 'declined') throw new Error(`a declined command ended "${e.params.item.status}"`); });
    }, { turn: true });
    let busyTurn: string | null = null;
    await steps.run('steer', async () => {
      const hangs = fake_.hangs;
      await a.send(`${DIRECTIVE}:hang`, randomUUID());
      busyTurn = a.turnId;
      await until(() => fake_.hangs > hangs);
      const r = await a.sendDirect('more input from the conformance probe', randomUUID(), { active: true, turnId: busyTurn });
      if (!r.providerAcknowledged || r.turnId !== busyTurn) throw new Error('turn/steer did not acknowledge the active turn');
    }, { turn: true });
    await steps.run('interrupt', async () => {
      const from = events.mark();
      await a.interrupt();
      const done = await events.waitFor(completed, from);
      if (done.params?.turn?.status !== 'interrupted') throw new Error(`an interrupted turn ended "${String(done.params?.turn?.status)}"`);
    }, { turn: true });
    await steps.run('steer_idle', async () => {
      // Steering a finished turn must be rejected with the message the adapter recognises, so it starts a turn instead.
      const from = events.mark();
      await a.sendDirect(`${DIRECTIVE}:echo`, randomUUID(), { active: true, turnId: busyTurn });
      await events.waitFor((e) => e?.type === 'remotea/direct-start', from);
      await events.waitFor(completed, from);
    }, { turn: true });
    await steps.run('resume', async () => {
      const id = a.sessionId;
      await a.stop();
      const again = fresh({ ...spec, sessionId: id });
      const resumed = await again.resume();
      if (resumed !== id) throw new Error('thread/resume returned a different thread');
    });
  } finally {
    for (const x of adapters) await x.stop().catch(() => {});
    await fake?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
  return steps.list;
}
