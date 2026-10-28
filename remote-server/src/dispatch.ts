/**
 * Dispatch: what Eridani's commands do on this machine (stage C).
 *
 *   spawn   in a configured execution target (eridani-targets.ts), in the
 *           branch's managed worktree (worktrees.ts), run the target's
 *           launcher for the harness:
 *             claude --model <m> --permission-mode auto "$ERIDANI_PROMPT"
 *             codex --disable daemon_auto_start -m <m> "$ERIDANI_PROMPT"
 *           The prompt travels in the environment and is expanded by the
 *           login shell as ONE argument: it is never parsed as shell text.
 *           Eridani's env is limited to ERIDANI_* keys plus the run token.
 *           The session is opened through the hub like any client would
 *           (EridaniConn, device "Eridani"), so every app shows it as a tab.
 *           Its surface id is derived from (run_id, generation, attempt), so
 *           a spawn is reconciled by that mapping and never started twice.
 *   input   fenced on (surf, incarnation, run_id, generation). `queue` waits
 *           until the agent is at its prompt (idle) and the link is up (a
 *           disconnected host invents no continuation); `steer` interrupts
 *           (Esc) and starts a new turn with the text: the generation
 *           advances first, so the new turn is bound to it (F07). Text is
 *           typed as a bracketed paste, then Enter. Injected input never
 *           counts as a person answering (agent-state.ts is not told).
 *   stop    durable desired state: `stopRequested` is persisted on the
 *           binding before anything is sent and cleared only when the process
 *           is seen to exit; a stopped run is never resumed. interrupt = Ctrl-C
 *           twice (once more after 1.5 s); kill = the process tree.
 *   answer  questions-claude.ts.
 *   verify  verify-runner.ts, on an explicit command only.
 *
 * Recovery: on boot, every Eridani session the restart lost is respawned
 * with its conversation resumed (`claude --resume <id> --model <m>
 * --permission-mode auto`, `codex resume --disable daemon_auto_start -m <m>
 * <id>`), unless a stop was requested. `runs.snapshot` applies Eridani's
 * desired state (stop, a newer generation).
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type {
  AnswerCommand,
  CommandBody,
  InputCommand,
  RunsSnapshotEntry,
  SnapshotSurface,
  SpawnCommand,
  StopCommand,
  VerifyCommand,
  VerifyResultBody,
} from '../../src/shared/eridani-link-protocol';
import type { CreateSpec, EridaniBinding, RemoteSurfaceId, ServerMsg, SessionRecord } from '../../src/shared/remote-host-protocol';
import type { Hub, HubConn, HubEridaniHooks } from './hub';
import type { Registry } from './registry';
import type { CommandContext, CommandHandler, CommandResult } from './eridani-link';
import type { JournalRecord } from './eridani-journal';
import type { ExecutionTarget, LaunchSpec } from './eridani-targets';
import type { WorktreeManager } from './worktrees';
import type { QuestionBroker } from './questions-claude';
import { runVerify, type VerifyOutcome, type VerifyRunOptions } from './verify-runner';

export const RUNS_FILE = 'eridani-runs.json';
export const ERIDANI_DEVICE = { id: 'eridani', name: 'Eridani' };
const COLS = 120;
const ROWS = 32;

export interface DispatchTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
}

const realTimers: DispatchTimers = {
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  },
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
};

/** The surface a run attempt lives in: the same (run, generation, attempt) always maps to the same id. */
export function surfFor(runId: string, generation: number, attempt: number): string {
  return `surf-eri-${crypto.createHash('sha256').update(`${runId}\0${generation}\0${attempt}`).digest('hex').slice(0, 32)}`;
}

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The command line a spawn runs (through the login shell; the prompt stays in $ERIDANI_PROMPT). */
export function launchCommand(harness: 'claude' | 'codex', model: string, spec: LaunchSpec, withPrompt: boolean): string {
  const bin = q(spec.bin ?? harness);
  const extra = (spec.args ?? []).map(q);
  const words = harness === 'claude'
    ? [bin, '--model', q(model), '--permission-mode', 'auto', ...extra]
    : [bin, '--disable', 'daemon_auto_start', '-m', q(model), ...extra];
  if (withPrompt) words.push('"$ERIDANI_PROMPT"');
  return words.join(' ');
}

/** The command that reopens a run's conversation with the same model and permission mode. */
export function resumeLine(b: EridaniBinding, spec: LaunchSpec | undefined, sessionId: string): string | null {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(sessionId)) return null;
  const bin = q(spec?.bin ?? b.harness);
  if (b.harness === 'claude') return [bin, '--resume', q(sessionId), '--model', q(b.model), '--permission-mode', 'auto', ...(spec?.args ?? []).map(q)].join(' ');
  return [bin, 'resume', '--disable', 'daemon_auto_start', '-m', q(b.model), q(sessionId)].join(' ');
}

/** A client of the hub that is Eridani: it opens sessions and reads nothing back. */
export class EridaniConn implements HubConn {
  readonly id: number;
  readonly deviceId = ERIDANI_DEVICE.id;
  device: { id: string; name: string } | null = ERIDANI_DEVICE;
  private rid = 1;
  private readonly errors = new Map<number, (m: Extract<ServerMsg, { t: 'openError' }>) => void>();
  private static next = -1;

  constructor(private readonly hub: Hub) {
    this.id = EridaniConn.next--;
    hub.connect(this);
  }

  sendJson(msg: ServerMsg): void {
    if (msg.t === 'openError') this.errors.get(msg.rid)?.(msg);
  }

  sendBinary(): void {}

  bufferedAmount(): number {
    return 0;
  }

  close(): void {}

  /** Create (or respawn) a session. Synchronous: the hub spawns inside `handle`. */
  open(id: string, create: CreateSpec): { ok: true } | { ok: false; message: string } {
    const rid = this.rid++;
    let err: string | null = null;
    this.errors.set(rid, (m) => (err = m.message));
    try {
      this.hub.handle(this, { t: 'open', rid, id: id as RemoteSurfaceId, cols: COLS, rows: ROWS, create });
    } finally {
      this.errors.delete(rid);
    }
    if (err) return { ok: false, message: err };
    // Eridani does not watch the screen: stop the output stream to this connection.
    this.hub.handle(this, { t: 'detach', ids: [id as RemoteSurfaceId] });
    return { ok: true };
  }
}

interface RunSecrets {
  env: Record<string, string>;
}

interface Queued {
  cmd: InputCommand;
  ctx: CommandContext;
  resolve: (r: CommandResult) => void;
}

export interface DispatchDeps {
  hub: Hub;
  registry: Registry;
  /** Config dir (eridani-runs.json); null keeps run secrets in memory. */
  dir: string | null;
  worktrees: WorktreeManager;
  targets: () => ExecutionTarget[];
  questions: QuestionBroker;
  /** Send an upward event (verify.result) through the link. */
  emit: (body: Omit<VerifyResultBody, 'op_id' | 'digest'>) => void;
  /** The set of worktrees or their activity changed (worktrees.report). */
  changed?: () => void;
  /** Is the link up (queued input is held while it is not)? */
  linkReady: () => boolean;
  resumeAgents?: boolean;
  timers?: DispatchTimers;
  now?: () => number;
  log?: (m: string) => void;
  verify?: (o: VerifyRunOptions) => Promise<VerifyOutcome>;
  timing?: Partial<typeof DEFAULT_TIMING>;
}

export const DEFAULT_TIMING = {
  /** How often a queued input checks whether the agent is at its prompt. */
  queuePollMs: 500,
  /** Between a bracketed paste and its Enter. */
  pasteEnterMs: 150,
  /** Between Esc (steer) and the new text. */
  steerDelayMs: 800,
  /** Between the two Ctrl-Cs of an interrupt, and before trying once more. */
  ctrlCGapMs: 300,
  ctrlCRetryMs: 1_500,
  /** How long a stop waits for the exit before reporting failed (the stop stays requested). */
  stopWaitMs: 20_000,
  killWaitMs: 10_000,
};

export class Dispatch {
  readonly conn: EridaniConn;
  private readonly timers: DispatchTimers;
  private readonly now: () => number;
  private readonly log: (m: string) => void;
  private readonly timing: typeof DEFAULT_TIMING;
  private secrets: Record<string, RunSecrets>;
  private readonly queues = new Map<string, Queued[]>();
  private readonly pollTimers = new Map<string, unknown>();
  /** When the last queued input was typed per surface: the next waits for a fresh idle. */
  private readonly delivered = new Map<string, number>();
  private readonly exitWaiters = new Map<string, Array<(code: number) => void>>();
  private readonly verifying = new Map<string, AbortController>();
  private readonly spawning = new Set<string>();

  constructor(private readonly deps: DispatchDeps) {
    this.timers = deps.timers ?? realTimers;
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? (() => {});
    this.timing = { ...DEFAULT_TIMING, ...deps.timing };
    this.secrets = this.loadSecrets();
    this.conn = new EridaniConn(deps.hub);
  }

  // ── Wiring ───────────────────────────────────────────────────────────────

  handlers(): Record<string, CommandHandler> {
    return {
      spawn: (c, ctx) => this.spawn(c as unknown as SpawnCommand, ctx),
      input: (c, ctx) => this.input(c as unknown as InputCommand, ctx),
      stop: (c, ctx) => this.stop(c as unknown as StopCommand, ctx),
      answer: async (c, ctx) => this.deps.questions.answer(c as unknown as AnswerCommand, () => ctx.begin()),
      verify: (c, ctx) => this.verify(c as unknown as VerifyCommand, ctx),
    };
  }

  hubHooks(): HubEridaniHooks {
    return {
      env: (id) => this.secrets[id]?.env,
      resumeCommand: (rec) => this.resumeCommand(rec),
      exited: (id, code) => this.onExit(id, code),
      hook: (id, params) => this.deps.questions.hook(id, params),
      snapshot: (id): Partial<SnapshotSurface> => {
        const qs = this.deps.questions.openIds(id);
        return qs.length ? { questions: qs } : {};
      },
    };
  }

  runToken(surf: string): string | null {
    return this.secrets[surf]?.env.ERIDANI_RUN_TOKEN ?? null;
  }

  /** What an `accepted` ack can already say. */
  acceptFacts(cmd: CommandBody): Record<string, unknown> {
    if (cmd.t !== 'spawn') return {};
    const c = cmd as unknown as SpawnCommand;
    const surf = surfFor(c.run_id, c.generation, c.attempt);
    const rec = this.deps.registry.session(surf);
    return { surf, incarnation: rec?.incarnation ?? 1 };
  }

  private target(id: string): ExecutionTarget | undefined {
    return this.deps.targets().find((t) => t.id === id);
  }

  /** Fences and policy, checked before a command is accepted (and again before a replay). */
  precheck(cmd: CommandBody): string | null {
    switch (cmd.t) {
      case 'spawn': {
        const c = cmd as unknown as SpawnCommand;
        const t = this.target(c.target.id);
        if (!t) return `unknown execution target ${c.target.id}`;
        if (c.target.repo && path.resolve(c.target.repo) !== t.repo) return 'repo does not match the execution target';
        if (!t.launch[c.harness]) return `${c.harness} is not enabled on target ${t.id}`;
        if (c.prompt.trimStart().startsWith('-')) return 'a prompt may not start with "-"';
        if (this.deps.registry.sessionTombstone(surfFor(c.run_id, c.generation, c.attempt))) return 'that run attempt was closed';
        return null;
      }
      case 'input': {
        const c = cmd as unknown as InputCommand;
        return this.fence(c, c.mode === 'steer' ? 'steer' : 'input');
      }
      case 'stop':
        return this.fence(cmd as unknown as StopCommand, 'stop');
      case 'answer':
        return this.deps.questions.precheck(cmd as unknown as AnswerCommand);
      case 'verify': {
        const c = cmd as unknown as VerifyCommand;
        const rec = this.boundSession(c.run_id);
        if (!rec?.eridani) return 'unknown run';
        if (c.generation !== rec.eridani.generation) return 'stale generation';
        const t = this.target(rec.eridani.target);
        if (!t) return 'the run\'s execution target is gone';
        if (!t.verify.some((v) => v.id === c.verify_id)) return `unknown verify id ${c.verify_id}`;
        if (this.verifying.has(rec.eridani.worktree)) return 'busy: a verification is running in this worktree';
        return null;
      }
      default:
        return null;
    }
  }

  private fence(c: { surf: string; incarnation: number; run_id: string; generation: number }, kind: 'input' | 'steer' | 'stop'): string | null {
    const rec = this.deps.registry.session(c.surf);
    if (!rec) return 'unknown surface';
    const b = rec.eridani;
    if (!b) return 'the surface is not bound to a run';
    if (b.runId !== c.run_id) return 'run does not match';
    if ((rec.incarnation ?? 0) !== c.incarnation) return 'stale incarnation';
    // A queued input belongs to the current generation; steer and stop advance it.
    if (kind === 'input' ? c.generation !== b.generation : c.generation < b.generation) return 'stale generation';
    if (kind === 'stop') return null;
    if (b.stopRequested) return 'stopping';
    if (!this.deps.hub.isLive(c.surf)) return 'the process is not running';
    return null;
  }

  /** The newest session bound to a run. */
  private boundSession(runId: string): SessionRecord | undefined {
    return this.deps.registry.sessions()
      .filter((r) => r.eridani?.runId === runId)
      .sort((a, b) => (b.eridani!.generation - a.eridani!.generation) || (b.createdAt - a.createdAt))[0];
  }

  /** Settle a command the journal found `executing` after a restart. */
  recover(rec: JournalRecord): { state: 'executed' | 'failed' | 'rejected'; detail?: string; outcome?: unknown } | null {
    const body = rec.body as Record<string, unknown> | undefined;
    switch (rec.t) {
      case 'spawn': {
        if (!body) return null;
        const surf = surfFor(String(body.run_id), Number(body.generation), Number(body.attempt));
        const s = this.deps.registry.session(surf);
        if (s?.eridani) return { state: 'executed', detail: 'started before the restart', outcome: this.spawnFacts(s) };
        // No session was recorded, so no process survived: nothing to reconcile, and it is not re-run.
        return { state: 'failed', detail: 'the server restarted before the session started' };
      }
      case 'stop':
        return { state: 'executed', detail: 'the process ended with the server restart' };
      case 'verify':
        return { state: 'failed', detail: 'interrupted by a server restart' };
      default:
        return null; // input, answer: the bytes may or may not have reached the agent
    }
  }

  // ── spawn ────────────────────────────────────────────────────────────────

  private spawnFacts(rec: SessionRecord): Record<string, unknown> {
    const b = rec.eridani!;
    return { surf: rec.id, incarnation: rec.incarnation ?? 0, worktree: b.worktree, branch: b.branch, base: b.base, base_sha: b.baseSha, target: b.target };
  }

  private groupFor(name: string): { groupId: string; group: { name: string } } {
    const existing = this.deps.registry.groups().find((g) => g.name === name);
    return { groupId: existing?.id ?? `grp-eri-${crypto.createHash('sha256').update(name).digest('hex').slice(0, 16)}`, group: { name } };
  }

  private async spawn(cmd: SpawnCommand, ctx: CommandContext): Promise<CommandResult> {
    const surf = surfFor(cmd.run_id, cmd.generation, cmd.attempt);
    const existing = this.deps.registry.session(surf);
    if (existing?.eridani) return { state: 'executed', detail: 'already started', result: this.spawnFacts(existing) };
    if (this.spawning.has(surf)) return { state: 'rejected', detail: 'already being started' };
    const target = this.target(cmd.target.id);
    if (!target) return { state: 'rejected', detail: `unknown execution target ${cmd.target.id}` };
    const launch = target.launch[cmd.harness];
    if (!launch) return { state: 'rejected', detail: `${cmd.harness} is not enabled on target ${target.id}` };
    this.spawning.add(surf);
    try {
      ctx.begin();
      const base = cmd.target.base ?? target.base;
      let wt;
      try {
        wt = await this.deps.worktrees.ensure(target, cmd.target.branch, base);
      } catch (err) {
        return { state: 'failed', detail: `worktree: ${(err as Error).message}` };
      }
      const prompt = cmd.prompt;
      const env: Record<string, string> = {
        ...cmd.env,
        ERIDANI_RUN_ID: cmd.run_id,
        ERIDANI_GENERATION: String(cmd.generation),
        ERIDANI_ATTEMPT: String(cmd.attempt),
        ERIDANI_TARGET: target.id,
        ERIDANI_BRANCH: wt.branch,
        ERIDANI_WORKTREE: wt.path,
        ERIDANI_HARNESS: cmd.harness,
        ...(cmd.task_id ? { ERIDANI_TASK_ID: cmd.task_id } : {}),
        ...(prompt ? { ERIDANI_PROMPT: prompt } : {}),
        ...(cmd.run_token ? { ERIDANI_RUN_TOKEN: cmd.run_token } : {}),
      };
      this.secrets[surf] = { env };
      this.saveSecrets();
      const binding: EridaniBinding = {
        runId: cmd.run_id,
        generation: cmd.generation,
        attempt: cmd.attempt,
        taskId: cmd.task_id ?? null,
        target: target.id,
        harness: cmd.harness,
        model: cmd.model,
        worktree: wt.path,
        branch: wt.branch,
        base: wt.base,
        baseSha: wt.baseSha,
        spawnOp: cmd.op_id,
      };
      const { groupId, group } = this.groupFor(cmd.group ?? 'Eridani');
      const res = this.conn.open(surf, {
        cmd: launchCommand(cmd.harness, cmd.model, launch, !!prompt),
        cwd: wt.path,
        groupId: groupId as CreateSpec['groupId'],
        group,
        title: cmd.title ?? `${cmd.harness} · ${wt.branch}`,
      });
      if (!res.ok) {
        delete this.secrets[surf];
        this.saveSecrets();
        return { state: 'failed', detail: `spawn: ${res.message}` };
      }
      const rec = this.deps.hub.updateRecord(surf, { eridani: binding });
      this.deps.registry.saveNow();
      this.deps.changed?.();
      this.log(`eridani: spawned ${cmd.harness} for run ${cmd.run_id} g${cmd.generation} in ${wt.path} (${surf})`);
      return { state: 'executed', result: this.spawnFacts(rec!) };
    } finally {
      this.spawning.delete(surf);
    }
  }

  // ── input ────────────────────────────────────────────────────────────────

  private type(surf: string, text: string): void {
    const clean = text.replace(/\x1b\[20[01]~/g, '');
    this.deps.hub.inject(surf, `\x1b[200~${clean}\x1b[201~`);
    this.timers.setTimeout(() => this.deps.hub.inject(surf, '\r'), this.timing.pasteEnterMs);
  }

  private wait(ms: number): Promise<void> {
    return new Promise((r) => this.timers.setTimeout(r, ms));
  }

  private async input(cmd: InputCommand, ctx: CommandContext): Promise<CommandResult> {
    if (cmd.mode === 'steer') {
      const rec = this.deps.registry.session(cmd.surf)!;
      // The generation advances BEFORE the new turn starts, so its prompt binds to it.
      this.deps.hub.updateRecord(cmd.surf, { eridani: { ...rec.eridani!, generation: cmd.generation } });
      this.deps.registry.saveNow();
      this.rejectQueued(cmd.surf, 'superseded by a steer');
      ctx.begin();
      this.deps.hub.inject(cmd.surf, '\x1b');
      await this.wait(this.timing.steerDelayMs);
      if (!this.deps.hub.isLive(cmd.surf)) return { state: 'failed', detail: 'the process ended before the text was typed' };
      this.type(cmd.surf, cmd.text);
      return { state: 'executed', result: { mode: 'steer', generation: cmd.generation } };
    }
    return new Promise<CommandResult>((resolve) => {
      const list = this.queues.get(cmd.surf) ?? [];
      list.push({ cmd, ctx, resolve });
      this.queues.set(cmd.surf, list);
      this.pollQueue(cmd.surf);
    });
  }

  /** Deliver the next queued input once the agent is idle at its prompt and the link is up. */
  private pollQueue(surf: string): void {
    if (this.pollTimers.has(surf)) return;
    const tick = () => {
      this.pollTimers.delete(surf);
      const list = this.queues.get(surf);
      if (!list?.length) return;
      const head = list[0];
      const stale = this.fence(head.cmd, 'input');
      const expires = typeof head.cmd.expires_at === 'number' ? head.cmd.expires_at : typeof head.cmd.expires_at === 'string' ? Date.parse(head.cmd.expires_at) : NaN;
      if (stale || (Number.isFinite(expires) && expires < this.now())) {
        list.shift();
        head.resolve({ state: 'rejected', detail: stale ?? 'expired while queued' });
        return this.pollQueue(surf);
      }
      const st = this.deps.registry.session(surf)?.agentState;
      const fresh = st && st.since > (this.delivered.get(surf) ?? 0);
      if (this.deps.linkReady() && st?.state === 'idle' && fresh) {
        list.shift();
        head.ctx.begin();
        this.delivered.set(surf, this.now());
        this.type(surf, head.cmd.text);
        head.resolve({ state: 'executed', result: { mode: 'queue', generation: head.cmd.generation } });
      }
      if (list.length) this.pollTimers.set(surf, this.timers.setTimeout(tick, this.timing.queuePollMs));
      else this.queues.delete(surf);
    };
    this.pollTimers.set(surf, this.timers.setTimeout(tick, 0));
  }

  private rejectQueued(surf: string, detail: string): void {
    const list = this.queues.get(surf);
    if (!list) return;
    this.queues.delete(surf);
    const t = this.pollTimers.get(surf);
    if (t !== undefined) this.timers.clearTimeout(t);
    this.pollTimers.delete(surf);
    for (const q of list) q.resolve({ state: 'rejected', detail });
  }

  // ── stop ─────────────────────────────────────────────────────────────────

  private markStop(surf: string, mode: 'interrupt' | 'kill', op: string | null, generation?: number): SessionRecord | undefined {
    const rec = this.deps.registry.session(surf);
    if (!rec?.eridani) return rec;
    const b: EridaniBinding = {
      ...rec.eridani,
      generation: Math.max(rec.eridani.generation, generation ?? 0),
      // A kill upgrades an interrupt; nothing downgrades a stop.
      stopRequested: { at: rec.eridani.stopRequested?.at ?? this.now(), mode: rec.eridani.stopRequested?.mode === 'kill' ? 'kill' : mode, op: op ?? rec.eridani.stopRequested?.op ?? null },
    };
    const updated = this.deps.hub.updateRecord(surf, { eridani: b });
    this.deps.registry.saveNow();
    this.rejectQueued(surf, 'stopping');
    this.verifying.get(b.worktree)?.abort();
    return updated;
  }

  private waitExit(surf: string, ms: number): Promise<number | null> {
    return new Promise((resolve) => {
      let done = false;
      const timer = this.timers.setTimeout(() => {
        if (done) return;
        done = true;
        resolve(null);
      }, ms);
      const list = this.exitWaiters.get(surf) ?? [];
      list.push((code) => {
        if (done) return;
        done = true;
        this.timers.clearTimeout(timer);
        resolve(code);
      });
      this.exitWaiters.set(surf, list);
    });
  }

  private async stop(cmd: StopCommand, ctx: CommandContext): Promise<CommandResult> {
    this.markStop(cmd.surf, cmd.mode, cmd.op_id, cmd.generation);
    ctx.begin();
    if (!this.deps.hub.isLive(cmd.surf)) {
      this.clearStop(cmd.surf);
      return { state: 'executed', detail: 'not running', result: { surf: cmd.surf, exited: true } };
    }
    const code = await this.terminate(cmd.surf, cmd.mode);
    if (code === null) {
      return { state: 'failed', detail: cmd.mode === 'kill' ? 'the process did not exit after SIGKILL' : 'still running after Ctrl-C; send mode:kill (the stop stays requested)' };
    }
    return { state: 'executed', result: { surf: cmd.surf, exited: true, code } };
  }

  /** Interrupt or kill, then wait for the exit. Null: it did not exit in time. */
  private async terminate(surf: string, mode: 'interrupt' | 'kill'): Promise<number | null> {
    const exited = this.waitExit(surf, mode === 'kill' ? this.timing.killWaitMs : this.timing.stopWaitMs);
    if (mode === 'kill') {
      this.deps.hub.killProcess(surf);
      return exited;
    }
    const ctrlC = async () => {
      this.deps.hub.inject(surf, '\x03');
      await this.wait(this.timing.ctrlCGapMs);
      this.deps.hub.inject(surf, '\x03');
    };
    await ctrlC();
    await this.wait(this.timing.ctrlCRetryMs);
    if (this.deps.hub.isLive(surf)) await ctrlC();
    return exited;
  }

  private clearStop(surf: string): void {
    const rec = this.deps.registry.session(surf);
    if (!rec?.eridani?.stopRequested) return;
    const { stopRequested: _done, ...rest } = rec.eridani;
    this.deps.hub.updateRecord(surf, { eridani: rest });
    this.deps.registry.saveNow();
  }

  private onExit(surf: string, code: number): void {
    const waiters = this.exitWaiters.get(surf);
    this.exitWaiters.delete(surf);
    for (const w of waiters ?? []) w(code);
    this.rejectQueued(surf, 'the process exited');
    this.deps.questions.surfaceExited(surf);
    // Durable until the exit is seen: now it is.
    this.clearStop(surf);
    if (this.deps.registry.session(surf)?.eridani) this.deps.changed?.();
  }

  // ── verify ───────────────────────────────────────────────────────────────

  private async verify(cmd: VerifyCommand, ctx: CommandContext): Promise<CommandResult> {
    const rec = this.boundSession(cmd.run_id);
    const b = rec?.eridani;
    const t = b ? this.target(b.target) : undefined;
    const spec = t?.verify.find((v) => v.id === cmd.verify_id);
    if (!b || !spec) return { state: 'rejected', detail: 'unknown run or verify id' };
    const ac = new AbortController();
    this.verifying.set(b.worktree, ac);
    ctx.begin();
    let out: VerifyOutcome;
    try {
      out = await (this.deps.verify ?? runVerify)({ spec, worktree: b.worktree, signal: ac.signal });
    } finally {
      this.verifying.delete(b.worktree);
    }
    this.deps.emit({
      t: 'verify.result',
      attempt_id: cmd.attempt_id,
      run_id: cmd.run_id,
      generation: cmd.generation,
      turn_seq: cmd.turn_seq,
      plan_revision: cmd.plan_revision,
      verify_id: cmd.verify_id,
      ...out,
    });
    return { state: 'executed', result: { attempt_id: cmd.attempt_id, exit_code: out.exit_code, timed_out: out.timed_out, canceled: out.canceled } };
  }

  // ── Recovery ─────────────────────────────────────────────────────────────

  private resumeCommand(rec: SessionRecord): string | null | undefined {
    const b = rec.eridani;
    if (!b) return undefined;
    if (b.stopRequested || this.deps.resumeAgents === false || !rec.agent) return null;
    const t = this.target(b.target);
    return resumeLine(b, t?.launch[b.harness], rec.agent.sessionId);
  }

  /**
   * Boot: respawn every Eridani session the restart lost, resuming its
   * conversation (no new prompt: a resumed agent waits at its prompt). A
   * session whose stop was requested is not resumed; its process is gone,
   * so the stop is complete.
   */
  resumeOnBoot(): void {
    for (const rec of this.deps.registry.sessions()) {
      if (!rec.eridani || rec.state !== 'lost') continue;
      if (rec.eridani.stopRequested) {
        this.finishLost(rec, 'stopped (the process ended with the server restart)');
        continue;
      }
      if (!rec.agent) {
        this.log(`eridani: ${rec.id} (run ${rec.eridani.runId}) has no conversation to resume; left lost`);
        continue;
      }
      const res = this.conn.open(rec.id, {});
      this.log(res.ok ? `eridani: resumed ${rec.id} (run ${rec.eridani.runId})` : `eridani: cannot resume ${rec.id}: ${res.message}`);
    }
  }

  private finishLost(rec: SessionRecord, why: string): void {
    const { stopRequested: _s, ...rest } = rec.eridani!;
    this.deps.hub.updateRecord(rec.id, { state: 'exited', exitCode: -1, exitedAt: this.now(), eridani: rest });
    this.deps.registry.saveNow();
    this.log(`eridani: ${rec.id} ${why}`);
  }

  /**
   * Eridani's desired state after a reconnect (C08). A newer generation is
   * adopted (queued input of an older one is then refused, never typed); a
   * `stop` is carried out like a stop command.
   */
  applyRunsSnapshot(runs: RunsSnapshotEntry[]): void {
    for (const r of runs) {
      for (const rec of this.deps.registry.sessions().filter((s) => s.eridani?.runId === r.run_id)) {
        const b = rec.eridani!;
        if (r.generation > b.generation && rec.state !== 'exited') {
          this.deps.hub.updateRecord(rec.id, { eridani: { ...b, generation: r.generation } });
          this.deps.registry.saveNow();
        }
        if (r.desired !== 'stop') continue;
        if (rec.state === 'lost') {
          this.finishLost({ ...rec, eridani: { ...b, stopRequested: { at: this.now(), mode: r.stop_mode ?? 'interrupt', op: null } } }, 'stopped by Eridani while lost');
        } else if (this.deps.hub.isLive(rec.id) && !b.stopRequested) {
          this.markStop(rec.id, r.stop_mode ?? 'interrupt', null, r.generation);
          void this.terminate(rec.id, r.stop_mode ?? 'interrupt');
        }
      }
    }
  }

  // ── Secrets file ─────────────────────────────────────────────────────────

  private loadSecrets(): Record<string, RunSecrets> {
    if (!this.deps.dir) return {};
    try {
      return JSON.parse(fs.readFileSync(path.join(this.deps.dir, RUNS_FILE), 'utf8')) as Record<string, RunSecrets>;
    } catch {
      return {};
    }
  }

  private saveSecrets(): void {
    if (!this.deps.dir) return;
    // Forget runs whose sessions are gone.
    for (const id of Object.keys(this.secrets)) if (!this.deps.registry.session(id) && !this.spawning.has(id)) delete this.secrets[id];
    const file = path.join(this.deps.dir, RUNS_FILE);
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(this.secrets, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file);
  }
}
