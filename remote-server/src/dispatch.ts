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
 *           One writer per worktree (S-S4): a spawn onto a branch another
 *           live session (or a spawn in flight) already writes is `rejected`
 *           `worktree_busy` with `{branch, writer}`, unless it says `share`.
 *           Hyperplan: a spawn with `mode` (plan | review) launches the
 *           harness read-only (readOnlyFlags) and carries `role`; such a
 *           session is never a worktree's writer (it starts beside one, and
 *           does not block a later writable spawn) but counts toward
 *           `limits.maxRuns`. A harness without a read-only launch is
 *           `rejected` `mode_unsupported`, never started writable.
 *           S-Q3: a target whose template fails (target-template.ts) is
 *           `rejected` `target_not_ready: <reasons>`; one at its
 *           `limits.maxRuns` is `rejected` `target_busy` with `{limit,
 *           running}`. A target with `prepare` steps runs them in the
 *           worktree before the agent starts (a new worktree, or one whose
 *           last preparation failed or changed); a failure is `failed`
 *           `prepare: <reason>` with `result.prepare` and no agent starts.
 *   input   fenced on (surf, incarnation, run_id, generation). `queue` waits
 *           until the agent is at its prompt (idle) and the link is up (a
 *           disconnected host invents no continuation); `steer` interrupts
 *           (Esc) and starts a new turn with the text: the generation
 *           advances first, so the new turn is bound to it (F07). Text is
 *           typed as a bracketed paste, then Enter; it carries no control
 *           character but newline and tab (refused at the shape check and
 *           stripped again here), so nothing can end the paste early. Injected input never
 *           counts as a person answering (agent-state.ts is not told).
 *           S-N1: each steer or delivery is a PendingWrite with both delays
 *           (Esc→text, text→Enter) inside its lifetime. Immediately before
 *           every injection the write is re-fenced (run, generation,
 *           incarnation, stop, process, agent, link epoch); a stop, a newer
 *           steer, a newer snapshot generation, an exit, a respawn or a
 *           reconnect cancels it at once. `executed` means Enter was sent;
 *           otherwise `failed` with result.outcome "interrupted" and what
 *           was written ({escape, text, enter}).
 *   stop    durable desired state: `stopRequested` is persisted on the
 *           binding before anything is sent and cleared only when the process
 *           is seen to exit; a stopped run is never resumed. interrupt = Ctrl-C
 *           twice (once more after 1.5 s); kill = the process tree.
 *   answer  questions-claude.ts.
 *   verify  verify-attempts.ts (stage D): after every root turn of a run
 *           that carries a verify config, and on an explicit command; one
 *           attempt machinery for both, run by verify-runner.ts.
 *
 * F07: the generation of every input Eridani types (the spawn prompt, a
 * queued input, a steer) is persisted on the binding (`acceptedInput`)
 * BEFORE it is typed; the agent's next accepted prompt binds its turn to it
 * (turn-capture.ts), so the turn, its questions, their resolutions and the
 * verify attempt after it all carry the generation that produced them, even
 * when runs.snapshot advanced the run in between.
 *
 * Recovery: on boot, every Eridani session the restart lost is respawned
 * with its conversation resumed (`claude --resume <id> --model <m>
 * --permission-mode auto`, `codex resume --disable daemon_auto_start -m <m>
 * <id>`), unless a stop was requested. A run that cannot be resumed (no
 * conversation was reported, or resuming is off) is left exited and reported
 * as `exit`, never respawned as a bare shell (D4, stage F). `runs.snapshot`
 * applies Eridani's desired state (stop, a newer generation).
 *
 * Stage F: `input` (queue and steer) and `answer` act only on the run's own
 * agent: the current incarnation was launched by this dispatch with the run's
 * command, and that agent reported its session through its hook (fence).
 */
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ERIDANI_LIMITS } from '../../src/shared/eridani-link-protocol';
import type {
  AnswerCommand,
  CommandBody,
  InputCommand,
  RunsSnapshotEntry,
  SnapshotSurface,
  SpawnCommand,
  StopCommand,
  VerifyCommand,
  WorktreeWriter,
  HelloTemplate,
} from '../../src/shared/eridani-link-protocol';
import { MODE_UNSUPPORTED, TARGET_BUSY, TARGET_NOT_READY, WORKTREE_BUSY } from '../../src/shared/eridani-link-protocol';
import type { SpawnMode } from '../../src/shared/eridani-link-protocol';
import type { CreateSpec, EridaniBinding, PrepareFacts, RemoteSurfaceId, ServerMsg, SessionRecord } from '../../src/shared/remote-host-protocol';
import type { Hub, HubConn, HubEridaniHooks } from './hub';
import type { Registry } from './registry';
import type { CommandContext, CommandHandler, CommandResult } from './eridani-link';
import type { JournalRecord } from './eridani-journal';
import type { ExecutionTarget, LaunchSpec } from './eridani-targets';
import { liveWriters, type EnsuredWorktree, type WorktreeManager } from './worktrees';
import { ManagedSessions, type ManagedSpec } from './managed-sessions';
import type { RunPauseCommand } from '../../src/shared/eridani-link-protocol';
import type { QuestionBroker } from './questions-claude';
import { runVerify, workspaceFingerprint, type VerifyOutcome, type VerifyRunOptions } from './verify-runner';
import { VerifyAttempts, type VerifyResultFields } from './verify-attempts';
import type { TurnFields } from './turn-capture';
import { notReadyReason, runPrepare } from './target-template';
import { claudeMcpConfig, codexMcpArgs, ERIDANI_MCP_DIR, MCP_SERVER_NAME, MCP_TOKEN_ENV, mcpStatus, writePrivate, type McpResolution, type McpStatus } from './eridani-mcp';

export const RUNS_FILE = 'eridani-runs.json';
/** S-Q5: the M7 launch record per surface, so a process the PTY keeper kept is still vouched for after a restart. */
export const LAUNCHED_FILE = 'eridani-launched.json';
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

/**
 * What the agent must know about its base before it touches code, put at the
 * top of the spawn prompt: a failed fetch (the base may be stale), and a
 * reused branch that is behind its base (merge it first, and re-point a
 * reserved migration at the current chain head). Empty when neither.
 */
export function freshnessNote(wt: Pick<EnsuredWorktree, 'branch' | 'base' | 'baseRef' | 'baseSha' | 'fetch' | 'behind' | 'created'>, migration: { number: number; dir: string } | null): string {
  const lines: string[] = [];
  if (wt.fetch && !wt.fetch.ok) {
    lines.push(`Could not fetch origin/${wt.base} (${wt.fetch.error ?? 'unknown error'}); this worktree is based on local ${wt.baseRef ?? wt.base}${wt.baseSha ? ` @ ${wt.baseSha.slice(0, 7)}` : ''}, which may be stale.`);
  }
  if (wt.behind && wt.behind > 0) {
    const ref = wt.baseRef ?? wt.base;
    lines.push(`Your branch ${wt.branch} is ${wt.behind} commit(s) behind ${ref}. Before touching code, merge ${ref} into it (\`git merge ${ref}\`), resolve conflicts, and commit.`);
    if (migration) {
      lines.push(`This plan adds a migration (reserved number ${String(migration.number).padStart(4, '0')}). After merging, re-point its down_revision at the current chain head in ${migration.dir} and renumber it if the number is taken; tests/test_release_migrations.py fails the PR otherwise.`);
    }
  }
  return lines.join('\n');
}

/**
 * Hyperplan: what Claude may do in a read-only session (`mode` plan | review).
 * `dontAsk` denies everything else without a terminal prompt (nothing waits
 * on one remotea does not relay), so the roles' prompts ask through Eridani's
 * `task_interview` instead of AskUserQuestion. Bash rules are matched on the
 * command text and are not a security boundary; the worktree is shared with
 * the writer, so what a reviewer can read is what the writer can.
 */
export const CLAUDE_READ_ONLY_TOOLS: readonly string[] = Object.freeze([
  'Read', 'Grep', 'Glob',
  'Bash(git status *)', 'Bash(git log *)', 'Bash(git diff *)', 'Bash(git show *)', 'Bash(ls *)', 'Bash(cat *)', 'Bash(rg *)',
]);
export const CLAUDE_READ_ONLY_DENIED: readonly string[] = Object.freeze(['Edit', 'Write', 'NotebookEdit']);

/**
 * The launch flags that make a harness read-only, or null when it has none
 * (such a spawn is refused, never started writable). Claude (2.1.x):
 * `--permission-mode dontAsk` with an allow list and a deny list; Codex
 * (0.166): `--sandbox read-only --ask-for-approval never` (also accepted by
 * `codex resume`). Claude's two lists take several values each, so the
 * caller must put an option after them, never the prompt.
 */
export function readOnlyFlags(harness: string): { lists: string[]; tail: string[] } | null {
  switch (harness) {
    case 'claude':
      return { lists: ['--allowedTools', ...CLAUDE_READ_ONLY_TOOLS.map(q), '--disallowedTools', ...CLAUDE_READ_ONLY_DENIED.map(q)], tail: ['--permission-mode', 'dontAsk'] };
    case 'codex':
      return { lists: [], tail: ['--sandbox', 'read-only', '--ask-for-approval', 'never'] };
    default:
      return null;
  }
}

/**
 * The command line a spawn runs (through the login shell; the prompt stays in $ERIDANI_PROMPT).
 * `mcpArgs` (eridani-mcp.ts) come right after the program: Claude's
 * `--mcp-config` takes several values, so an option must follow it, never the prompt.
 * With `mode` (hyperplan) the harness is launched read-only: Claude's
 * `--permission-mode auto` becomes `dontAsk` with the tool lists (placed before
 * `--model`, which ends them), Codex gets its sandbox flags. Without `mode` the
 * line is exactly what it was before modes existed.
 */
export function launchCommand(harness: 'claude' | 'codex', model: string, spec: LaunchSpec, withPrompt: boolean, mcpArgs: string[] = [], mode?: SpawnMode | null): string {
  const bin = q(spec.bin ?? harness);
  const extra = (spec.args ?? []).map(q);
  const mcp = mcpArgs.map(q);
  const ro = mode ? readOnlyFlags(harness) : null;
  if (mode && !ro) throw new Error(`${harness} has no read-only launch`);
  const words = harness === 'claude'
    ? [bin, ...mcp, ...(ro?.lists ?? []), '--model', q(model), ...(ro?.tail ?? ['--permission-mode', 'auto']), ...extra]
    : [bin, ...mcp, '--disable', 'daemon_auto_start', '-m', q(model), ...(ro?.tail ?? []), ...extra];
  if (withPrompt) words.push('"$ERIDANI_PROMPT"');
  return words.join(' ');
}

/** The command that reopens a run's conversation with the same model and permission mode (read-only again when the binding has a `mode`). */
export function resumeLine(b: EridaniBinding, spec: LaunchSpec | undefined, sessionId: string, mcpArgs: string[] = []): string | null {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(sessionId)) return null;
  const bin = q(spec?.bin ?? b.harness);
  const mcp = mcpArgs.map(q);
  const ro = b.mode ? readOnlyFlags(b.harness) : null;
  if (b.mode && !ro) return null;
  if (b.harness === 'claude') return [bin, '--resume', q(sessionId), ...mcp, ...(mcpArgs.includes('--allowedTools') ? [] : ro?.lists ?? []), '--model', q(b.model), ...(b.effort ? ['--effort', q(b.effort)] : []), ...(ro?.tail ?? ['--permission-mode', 'auto']), ...(spec?.args ?? []).map(q)].join(' ');
  return [bin, 'resume', ...mcp, '--disable', 'daemon_auto_start', '-m', q(b.model), ...(b.effort ? ['-c', q(`model_reasoning_effort=${JSON.stringify(b.effort)}`)] : []), ...(ro?.tail ?? []), q(sessionId)].join(' ');
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

/**
 * A write in progress on a surface: a steer (Esc, delay, paste, delay,
 * Enter) or a queued input (paste, delay, Enter). Every injection is fenced
 * on the fields captured when it began (Dispatch.blocked); a cancel wakes its
 * delay at once and nothing more is written.
 */
interface PendingWrite {
  readonly surf: string;
  readonly runId: string;
  readonly kind: 'steer' | 'queue';
  readonly generation: number;
  readonly incarnation: number;
  readonly linkEpoch: number;
  readonly written: { escape: boolean; text: boolean; enter: boolean };
  canceled: string | null;
  timer: unknown;
  wake: ((ok: boolean) => void) | null;
}

export interface DispatchDeps {
  hub: Hub;
  registry: Registry;
  /** Config dir (eridani-runs.json); null keeps run secrets in memory. */
  dir: string | null;
  worktrees: WorktreeManager;
  targets: () => ExecutionTarget[];
  questions: QuestionBroker;
  managedSupported?: (target: ExecutionTarget, harness: 'codex' | 'claude') => boolean;
  managedFactory?: (spec: import('./managed-harness').HarnessSpec) => import('./managed-harness').RuntimeAdapter;
  managedEmit?: (body: Record<string, unknown>) => void;
  /** Send an upward event (verify.result) through the link. */
  emit: (body: VerifyResultFields) => void;
  /** The set of worktrees or their activity changed (worktrees.report). */
  changed?: () => void;
  /** Is the link up (queued input is held while it is not)? */
  linkReady: () => boolean;
  resumeAgents?: boolean;
  timers?: DispatchTimers;
  now?: () => number;
  log?: (m: string) => void;
  verify?: (o: VerifyRunOptions) => Promise<VerifyOutcome>;
  /** Tests: the workspace fingerprint (default: verify-runner's). */
  fingerprint?: (dir: string) => Promise<string>;
  timing?: Partial<typeof DEFAULT_TIMING>;
  /**
   * Eridani's MCP server for a target's agents (eridani-mcp.ts resolveMcp),
   * read on every spawn and resume. Absent: agents are spawned without it and
   * outcomes carry no `mcp` field.
   */
  mcp?: (target: ExecutionTarget) => McpResolution;
  /** Where per-run Claude MCP configs go (default `<dir>/eridani-mcp`, or a private temp folder when dir is null). */
  mcpDir?: string;
  /** Eridani's web app (config.ts resolveWebUrl), recorded on each binding for the desktop's "Open in Eridani". */
  webUrl?: () => string | null;
  /** S-Q3: the target's template checked at spawn (target-template.ts templateStatus). Absent: not checked. */
  checkTarget?: (target: ExecutionTarget) => HelloTemplate;
  /** S-Q3: dependency preparation in a worktree (target-template.ts runPrepare); `force` for a new worktree. Default: runPrepare. */
  prepare?: (target: ExecutionTarget, worktree: string, force: boolean) => Promise<PrepareFacts | null>;
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
  /** After a root turn, how long to wait (for a newer turn) before verifying. */
  verifyDebounceMs: 2_000,
};

export class Dispatch {
  readonly conn: EridaniConn;
  readonly managed: ManagedSessions;
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
  readonly attempts: VerifyAttempts;
  private readonly spawning = new Set<string>();
  /** S-Q3: the target of each spawn in flight (limits.maxRuns). */
  private readonly spawningOn = new Map<string, string>();
  /** S-Q3: the dependency preparation in flight per worktree path. */
  private readonly preparing = new Map<string, Promise<PrepareFacts | null>>();
  /** S-S4: the branch (`<target>\0<branch>`) each spawn in flight is claiming, with its writer. */
  private readonly claims = new Map<string, WorktreeWriter>();
  /**
   * M7: the incarnation of each surface dispatch itself launched with the
   * run's agent command (spawn or resume line), and whether that agent has
   * since reported its session through its hook. Mirrored to LAUNCHED_FILE
   * (S-Q5), but read back only for a surface whose process the PTY keeper
   * kept across the restart, in the same incarnation: a respawned one is a
   * new incarnation and is vouched for afresh.
   */
  private readonly launchedWith = new Map<string, { incarnation: number; agentSeen: boolean }>();
  /** S-Q5: draining for a restart: no queued input starts (the next server replays it). */
  private draining = false;
  /** The write (steer or queued input) pending per surface: see PendingWrite. */
  private readonly writes = new Map<string, PendingWrite>();
  /** Bumped each time the link becomes ready: a write begun before a reconnect writes nothing more. */
  private linkEpoch = 0;
  /** Codex's MCP bearer token per surface, for the next launch only: never persisted (eridani-mcp.ts). */
  private readonly mcpEnv = new Map<string, Record<string, string>>();
  private readonly mcpDir: string;

  constructor(private readonly deps: DispatchDeps) {
    this.timers = deps.timers ?? realTimers;
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? (() => {});
    this.timing = { ...DEFAULT_TIMING, ...deps.timing };
    this.mcpDir = deps.mcpDir ?? (deps.dir ? path.join(deps.dir, ERIDANI_MCP_DIR) : path.join(os.tmpdir(), `remotea-eridani-mcp-${process.getuid?.() ?? 'user'}`));
    this.secrets = this.loadSecrets();
    this.managed = new ManagedSessions({ dir: deps.dir, factory: deps.managedFactory, hook: (surf, params) => { deps.hub.relayRpc(surf, 'hook.event', params); }, emit: (body) => deps.managedEmit?.(body), changed: (surf, sessionId, paused) => {
      const rec = deps.registry.session(surf);
      if (rec?.eridani) { deps.hub.updateRecord(surf, { eridani: { ...rec.eridani, paused }, ...(sessionId ? { agent: { provider: rec.eridani.harness, sessionId, seenAt: Date.now() } } : {}) }); deps.registry.saveNow(); }
    } });
    this.conn = new EridaniConn(deps.hub);
    this.attempts = new VerifyAttempts({
      session: (id) => deps.registry.session(id),
      setStatus: (id, verify) => {
        if (!deps.registry.session(id)) return;
        deps.hub.updateRecord(id, { verify });
        // A few writes per turn; `remotea status` reads the file.
        deps.registry.saveNow();
      },
      spec: (rec, verifyId) => (rec.eridani ? this.target(rec.eridani.target)?.verify.find((v) => v.id === verifyId) : undefined),
      run: deps.verify ?? runVerify,
      fingerprint: deps.fingerprint ?? ((dir) => workspaceFingerprint(dir)),
      emit: deps.emit,
      timers: this.timers,
      now: this.now,
      log: this.log,
      debounceMs: this.timing.verifyDebounceMs,
    });
  }

  // ── Wiring ───────────────────────────────────────────────────────────────

  handlers(): Record<string, CommandHandler> {
    return {
      spawn: (c, ctx) => this.spawn(c as unknown as SpawnCommand, ctx),
      input: (c, ctx) => this.input(c as unknown as InputCommand, ctx),
      stop: (c, ctx) => this.stop(c as unknown as StopCommand, ctx),
      answer: async (c, ctx) => this.managed.findQuestion((c as unknown as AnswerCommand).question_id) ? this.managed.answer(c as unknown as AnswerCommand, () => ctx.begin()) : this.deps.questions.answer(c as unknown as AnswerCommand, () => ctx.begin()),
      'run.pause': (c, ctx) => this.pauseRun(c as unknown as RunPauseCommand, ctx),
      'run.resume': (c, ctx) => this.pauseRun(c as unknown as RunPauseCommand, ctx),
      verify: (c, ctx) => this.verify(c as unknown as VerifyCommand, ctx),
    };
  }

  hubHooks(): HubEridaniHooks {
    return {
      spawn: (rec) => this.managed.spawn(rec.id),
      takeover: (id) => this.takeover(id),
      env: (id) => {
        const env = this.secrets[id]?.env;
        // Consumed by the launch it was prepared for (spawn or resume).
        const mcp = this.mcpEnv.get(id);
        this.mcpEnv.delete(id);
        return mcp ? { ...env, ...mcp } : env;
      },
      resumeCommand: (rec) => this.resumeCommand(rec),
      exited: (id, code) => this.onExit(id, code),
      turn: (t: TurnFields) => { const binding = this.deps.registry.session(t.surf)?.eridani; if (!binding?.paused && binding?.controller !== 'terminal') this.attempts.onTurn(t); },
      hook: (id, params) => {
        this.noteHook(id, params);
        this.deps.questions.hook(id, params);
      },
      snapshot: (id): Partial<SnapshotSurface> => {
        const qs = [...this.deps.questions.openIds(id), ...this.managed.pending(id)];
        const binding = this.deps.registry.session(id)?.eridani;
        return { ...(qs.length ? { questions: qs } : {}), ...(binding?.execution === 'managed' ? { execution: 'managed', controller: binding.controller ?? 'eridani' } : {}) };
      },
    };
  }

  private webUrl(): string | null {
    try {
      return this.deps.webUrl?.() ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Bindings recorded before `webUrl` existed (or while it could not be
   * derived) get the current one, so the desktop can link them to Eridani
   * too. Never changes a binding that already has one. Returns how many.
   */
  backfillWebUrl(): number {
    const url = this.webUrl();
    if (!url) return 0;
    let n = 0;
    for (const rec of this.deps.registry.sessions()) {
      if (!rec.eridani || rec.eridani.webUrl || rec.state === 'exited') continue;
      this.deps.hub.updateRecord(rec.id, { eridani: { ...rec.eridani, webUrl: url } });
      n++;
    }
    if (n) this.deps.registry.saveNow();
    return n;
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
        if (c.execution === 'managed' && (process.platform !== 'linux' || this.deps.managedSupported && !this.deps.managedSupported(t, c.harness))) return 'managed harness protocol is not verified for this installed launcher';
        if (c.execution === 'managed' && c.mode && c.permission_profile === 'workspace-write') return 'read-only role cannot request workspace-write';
        if (!t.launch[c.harness]) return `${c.harness} is not enabled on target ${t.id}`;
        if (c.prompt.trimStart().startsWith('-')) return 'a prompt may not start with "-"';
        if (this.deps.registry.sessionTombstone(surfFor(c.run_id, c.generation, c.attempt))) return 'that run attempt was closed';
        if (c.verify && !t.verify.some((v) => v.id === c.verify!.verify_id)) return `unknown verify id ${c.verify.verify_id}`;
        return null;
      }
      case 'input': {
        const c = cmd as unknown as InputCommand;
        return this.fence(c, c.mode === 'steer' ? 'steer' : 'input');
      }
      case 'run.pause':
      case 'run.resume':
        return this.fence(cmd as unknown as StopCommand, 'stop');
      case 'stop':
        return this.fence(cmd as unknown as StopCommand, 'stop');
      case 'answer': {
        const c = cmd as unknown as AnswerCommand;
        if (this.managed.findQuestion(c.question_id)) return this.managed.precheck(c);
        const pre = this.deps.questions.precheck(c);
        if (pre) return pre;
        // The answer is delivered to the hook that asked; that hook must belong to the run's agent.
        const surf = this.deps.questions.get(c.question_id)?.surf;
        const rec = surf ? this.deps.registry.session(surf) : undefined;
        return rec?.eridani ? this.agentPresent(rec) : 'the surface is not bound to a run';
      }
      case 'verify': {
        const c = cmd as unknown as VerifyCommand;
        const rec = this.boundSession(c.run_id);
        if (!rec?.eridani) return 'unknown run';
        if (rec.eridani.controller === 'terminal') return 'terminal has control';
        if (c.generation !== rec.eridani.generation) return 'stale generation';
        const t = this.target(rec.eridani.target);
        if (!t) return 'the run\'s execution target is gone';
        if (!t.verify.some((v) => v.id === c.verify_id)) return `unknown verify id ${c.verify_id}`;
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
    if (b.controller === 'terminal') return 'terminal has control';
    if (kind === 'stop') return null;
    if (b.stopRequested) return 'stopping';
    if (!this.deps.hub.isLive(c.surf)) return 'the process is not running';
    return this.agentPresent(rec);
  }

  /**
   * Text is typed only into the run's agent (M7): the current incarnation
   * was launched with the run's own command (the spawn's launcher, or its
   * resume line) and the agent has reported its session. Anything else (a
   * shell, an agent that never started) would run the text as a command.
   */
  private agentPresent(rec: SessionRecord): string | null {
    const b = rec.eridani!;
    if (b.execution === 'managed') return b.controller === 'terminal' ? 'terminal has control' : this.managed.has(rec.id) ? null : 'managed session unavailable';
    const launched = this.launchedWith.get(rec.id);
    if (!launched || launched.incarnation !== (rec.incarnation ?? 0)) return 'the run\'s agent was not launched in this incarnation';
    if (!launched.agentSeen || !rec.agent) return 'the agent has not reported its session yet';
    if (rec.agent.provider !== b.harness) return 'the surface is not running the run\'s agent';
    return null;
  }

  /** A hook event from the surface: its agent (of the run's harness) is up in this incarnation. */
  private noteHook(id: string, params: Record<string, unknown>): void {
    const launched = this.launchedWith.get(id);
    const rec = this.deps.registry.session(id);
    if (!launched || !rec?.eridani || launched.incarnation !== (rec.incarnation ?? 0)) return;
    if (params.event === 'SessionEnd' || typeof params.sessionId !== 'string' || !params.sessionId) return;
    const provider = params.provider === 'codex' ? 'codex' : params.provider ? null : 'claude';
    if (provider === rec.eridani.harness && !launched.agentSeen) {
      launched.agentSeen = true;
      this.saveLaunched();
    }
  }

  private noteLaunched(surf: string, incarnation: number): void {
    this.launchedWith.set(surf, { incarnation, agentSeen: false });
    this.saveLaunched();
  }

  /** Best effort: losing it only means an adopted run's input waits for its agent's next hook. */
  private saveLaunched(): void {
    if (!this.deps.dir) return;
    const out: Record<string, { incarnation: number; agentSeen: boolean }> = {};
    for (const [id, v] of this.launchedWith) if (this.deps.registry.session(id)) out[id] = v;
    const file = path.join(this.deps.dir, LAUNCHED_FILE);
    try {
      const tmp = `${file}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(out) + '\n', { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (err) {
      this.log(`eridani: cannot write ${LAUNCHED_FILE}: ${(err as Error).message}`);
    }
  }

  private loadLaunched(): Record<string, { incarnation: number; agentSeen: boolean }> {
    if (!this.deps.dir) return {};
    try {
      const v = JSON.parse(fs.readFileSync(path.join(this.deps.dir, LAUNCHED_FILE), 'utf8')) as unknown;
      return v && typeof v === 'object' ? v as Record<string, { incarnation: number; agentSeen: boolean }> : {};
    } catch {
      return {};
    }
  }

  /** S-Q5 (`remotea upgrade`): while draining no queued input starts; it stays accepted for the next server. */
  setDraining(on: boolean): void {
    this.draining = on;
  }

  /** Surfaces with a steer or input write under way (a drain waits for them). */
  pendingWrites(): string[] {
    return [...this.writes.keys()];
  }

  /**
   * The newest session bound to a run that is not a reviewer (hyperplan: the
   * planner, then the worker), so `verify` never lands on a review session.
   * A run with only reviewer sessions has no bound session.
   */
  private boundSession(runId: string): SessionRecord | undefined {
    return this.deps.registry.sessions()
      .filter((r) => r.eridani?.runId === runId && r.eridani.role !== 'reviewer')
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
      case 'stop': {
        const surf = typeof body?.surf === 'string' ? body.surf : null;
        // S-Q5: the PTY keeper kept the process; the stop stays requested and boot sent it again.
        if (surf && this.deps.hub.isLive(surf)) return { state: 'failed', detail: 'interrupted by a server restart; the process outlived it, the stop stays requested and was sent again' };
        return { state: 'executed', detail: 'the process ended with the server restart' };
      }
      case 'verify':
        return { state: 'failed', detail: 'interrupted by a server restart' };
      default:
        return null; // input, answer: the bytes may or may not have reached the agent
    }
  }

  private async takeover(surf: string): Promise<{ ok: boolean; error?: string }> {
    const rec = this.deps.registry.session(surf); const b = rec?.eridani;
    if (!rec || !b || b.execution !== 'managed' || b.controller === 'terminal') return { ok: false, error: 'not an Eridani-controlled managed session' };
    const launch = this.target(b.target)?.launch[b.harness];
    if (!launch) return { ok: false, error: 'launcher unavailable' };
    const mcp = this.prepareMcp(surf, this.target(b.target), b.harness);
    try {
      const sessionId = this.managed.sessionId(surf); const line = resumeLine(b, launch, sessionId, this.roleMcpArgs(b, mcp?.args ?? []));
      if (!line) return { ok: false, error: 'conversation cannot be resumed' };
      await this.managed.takeoverNative(surf, line, { ...this.secrets[surf]?.env, ...this.mcpEnv.get(surf) });
      this.deps.hub.updateRecord(surf, { eridani: { ...b, controller: 'terminal', paused: true } }); this.deps.registry.saveNow();
      this.deps.hub.agentState.report(surf, { awaitingHuman: true, runDepth: 0, reason: 'Terminal has control' });
      return { ok: true };
    } catch (e) { return { ok: false, error: (e as Error).message }; }
  }

  private roleMcpArgs(b: EridaniBinding, args: string[]): string[] {
    const scope = b.role === 'reviewer' ? ['task_plan', 'submit_plan_review', 'session_link'] : b.role === 'worker' ? ['task_plan', 'task_step', 'session_link'] : ['task_plan', 'task_interview', 'submit_plan', 'session_link'];
    let scoped = [...args];
    if (b.harness === 'codex') scoped.push('-c', `mcp_servers.${MCP_SERVER_NAME}.enabled_tools=${JSON.stringify(scope)}`, '-c', `mcp_servers.${MCP_SERVER_NAME}.tool_timeout_sec=120`, ...scope.flatMap((tool) => ['-c', `mcp_servers.${MCP_SERVER_NAME}.tools.${tool}.approval_mode="auto"`]));
    else {
      scoped.push('--allowedTools', ...scope.map((tool) => `mcp__${MCP_SERVER_NAME}__${tool}`));
      if (b.mode || b.permissionProfile === 'read-only') scoped.push('Read', 'Grep', 'Glob', ...CLAUDE_READ_ONLY_TOOLS.filter((t) => t.startsWith('Bash(')), '--disallowedTools', ...CLAUDE_READ_ONLY_DENIED);
      scoped.push('--strict-mcp-config');
    }
    return scoped;
  }

  private prepareManaged(surf: string, b: EridaniBinding, launch: LaunchSpec, prompt: string, operationId: string, args: string[], env: Record<string, string>, incarnation = 1): void {
    const scoped = this.roleMcpArgs(b, args);
    this.managed.prepare({ surf, runId: b.runId, generation: b.generation, incarnation, prompt, operationId, harness: b.harness, bin: launch.bin ?? b.harness, args: [...scoped, ...(launch.args ?? [])], cwd: b.worktree, env: { ...env, ...(this.mcpEnv.get(surf) ?? {}) }, model: b.model, effort: b.effort, planRevision: b.verify?.planRevision ?? null, profile: b.permissionProfile ?? (b.mode ? 'read-only' : 'workspace-write') });
  }

  private async pauseRun(cmd: RunPauseCommand, ctx: CommandContext): Promise<CommandResult> {
    if (!this.managed.has(cmd.surf)) return { state: 'rejected', detail: 'native sessions do not support managed pause' };
    ctx.begin(); await this.managed.pause(cmd.surf, cmd.t === 'run.pause'); return { state: 'executed' };
  }

  // ── spawn ────────────────────────────────────────────────────────────────

  private spawnFacts(rec: SessionRecord): Record<string, unknown> {
    const b = rec.eridani!;
    return {
      surf: rec.id, incarnation: rec.incarnation ?? 0, worktree: b.worktree, branch: b.branch, base: b.base, base_sha: b.baseSha, target: b.target,
      ...(b.baseRef !== undefined ? { base_ref: b.baseRef, fetch: b.fetch ?? null, behind: b.behind ?? null, ahead: b.ahead ?? null } : {}),
      ...(b.mcp ? { mcp: { ...b.mcp } } : {}),
      ...(b.prepare ? { prepare: { ...b.prepare } } : {}),
      ...(b.role ? { role: b.role } : {}),
      ...(b.mode ? { mode: b.mode } : {}),
    };
  }

  /** The Claude MCP config file of a surface. */
  mcpConfigPath(surf: string): string {
    return path.join(this.mcpDir, `${surf}.json`);
  }

  /**
   * Eridani's MCP server for the agent about to launch on `surf`
   * (eridani-mcp.ts): the launcher arguments, with Claude's config file
   * written (or removed when not configured) and Codex's token set for this
   * launch. null when MCP is not wired in (no `mcp` dep). Never logs the key.
   */
  private prepareMcp(surf: string, target: ExecutionTarget | undefined, harness: 'claude' | 'codex'): { status: McpStatus; args: string[] } | null {
    this.mcpEnv.delete(surf);
    if (!this.deps.mcp) return null;
    const file = this.mcpConfigPath(surf);
    let r: McpResolution;
    try {
      r = target ? this.deps.mcp(target) : { configured: false, reason: 'the run\'s execution target is gone' };
    } catch (err) {
      r = { configured: false, reason: `cannot read the MCP settings: ${(err as Error).message}` };
    }
    if (!r.configured) {
      fs.rmSync(file, { force: true });
      return { status: mcpStatus(r), args: [] };
    }
    if (harness === 'codex') {
      this.mcpEnv.set(surf, { [MCP_TOKEN_ENV]: r.key });
      return { status: { configured: true }, args: codexMcpArgs(r.url) };
    }
    try {
      writePrivate(file, claudeMcpConfig(r.url, r.key));
    } catch (err) {
      return { status: { configured: false, reason: `cannot write the MCP config (${(err as NodeJS.ErrnoException).code ?? 'error'})` }, args: [] };
    }
    return { status: { configured: true }, args: ['--mcp-config', file] };
  }

  /** Forget a surface's MCP config (its session is gone, or its launch failed). */
  private dropMcp(surf: string): void {
    this.mcpEnv.delete(surf);
    try {
      fs.rmSync(this.mcpConfigPath(surf), { force: true });
    } catch {
      /* best effort */
    }
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
    // Hyperplan: a read-only mode the harness cannot honour is refused; it is never launched writable instead.
    const readOnly = !!cmd.mode;
    if (readOnly && !readOnlyFlags(cmd.harness)) return { state: 'rejected', detail: MODE_UNSUPPORTED, result: { harness: cmd.harness, mode: cmd.mode } };
    // S-Q3: what hello would not advertise is not started either (the template may have broken since).
    const template = this.deps.checkTarget?.(target);
    if (template && !template.ready) return { state: 'rejected', detail: `${TARGET_NOT_READY}: ${notReadyReason(template)}`, result: { template } };
    const limit = target.limits?.maxRuns;
    const running = limit ? this.runsOn(target.id) : 0;
    if (limit && running >= limit) {
      this.log(`eridani: refused spawn for run ${cmd.run_id} on ${target.id}: ${running} of ${limit} runs (limits.maxRuns)`);
      return { state: 'rejected', detail: TARGET_BUSY, result: { limit, running } };
    }
    // S-S4: one writer per worktree. Checked and claimed with no await in between, so two spawns cannot both pass.
    // A read-only spawn (hyperplan) neither needs the branch free nor claims it: it writes nothing.
    const claim = `${target.id}\0${cmd.target.branch}`;
    const writer = readOnly ? null : this.writerFor(target.id, cmd.target.branch);
    if (writer && cmd.share !== true) {
      this.log(`eridani: refused spawn for run ${cmd.run_id} on ${cmd.target.branch}: ${writer.surf} (run ${writer.run_id}) writes it`);
      return { state: 'rejected', detail: WORKTREE_BUSY, result: { branch: cmd.target.branch, writer } };
    }
    const claimed = !writer && !readOnly;
    if (claimed) this.claims.set(claim, { surf, run_id: cmd.run_id });
    this.spawning.add(surf);
    this.spawningOn.set(surf, target.id);
    try {
      ctx.begin();
      const base = cmd.target.base ?? target.base;
      let wt;
      try {
        wt = await this.deps.worktrees.ensure(target, cmd.target.branch, base);
      } catch (err) {
        return { state: 'failed', detail: `worktree: ${(err as Error).message}` };
      }
      // S-Q3: the target's dependency preparation, before the agent starts; a failure starts nothing.
      let prepare: PrepareFacts | null = null;
      if (target.prepare?.length) {
        prepare = await this.prepareWorktree(target, wt.path, wt.created);
        this.log(`eridani: prepare for run ${cmd.run_id} in ${wt.path}: ${!prepare ? 'none' : !prepare.ran ? 'already done' : prepare.ok ? `ok (${prepare.steps.map((x) => x.id).join(', ')})` : `FAILED: ${prepare.reason ?? '?'}`}${prepare?.log ? `; log ${prepare.log}` : ''}`);
        if (prepare && !prepare.ok) return { state: 'failed', detail: `prepare: ${prepare.reason ?? 'failed'}`, result: { worktree: wt.path, branch: wt.branch, target: target.id, prepare } };
      }
      const note = cmd.prompt ? freshnessNote(wt, cmd.migration ?? null) : '';
      const prompt = note ? `${note}\n\n${cmd.prompt}` : cmd.prompt;
      const env: Record<string, string> = {
        ...cmd.env,
        ERIDANI_RUN_ID: cmd.run_id,
        ERIDANI_GENERATION: String(cmd.generation),
        ERIDANI_ATTEMPT: String(cmd.attempt),
        ERIDANI_TARGET: target.id,
        ERIDANI_BRANCH: wt.branch,
        ERIDANI_WORKTREE: wt.path,
        ERIDANI_HARNESS: cmd.harness,
        ...(cmd.role ? { ERIDANI_ROLE: cmd.role } : {}),
        ...(cmd.mode ? { ERIDANI_MODE: cmd.mode } : {}),
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
        ...(cmd.effort ? { effort: cmd.effort } : {}),
        ...(cmd.execution ? { execution: cmd.execution, permissionProfile: cmd.permission_profile ?? (cmd.mode ? 'read-only' : 'workspace-write'), controller: 'eridani' as const } : {}),
        worktree: wt.path,
        branch: wt.branch,
        base: wt.base,
        baseSha: wt.baseSha,
        baseRef: wt.baseRef,
        fetch: wt.fetch,
        behind: wt.behind,
        ahead: wt.ahead,
        spawnOp: cmd.op_id,
        ...(cmd.verify ? { verify: { verifyId: cmd.verify.verify_id, planRevision: cmd.verify.plan_revision } } : {}),
        // F07: the prompt typed at launch belongs to the spawn's generation.
        ...(prompt ? { acceptedInput: { generation: cmd.generation, at: this.now() } } : {}),
        // What the desktop needs to link back to the run (no secrets): only what this spawn and config carry.
        ...(cmd.title ? { taskTitle: cmd.title } : {}),
        ...(prepare ? { prepare } : {}),
        // Hyperplan: the role and read-only mode stay on the record (resume reuses the mode; verify skips reviewers).
        ...(cmd.role ? { role: cmd.role } : {}),
        ...(cmd.mode ? { mode: cmd.mode } : {}),
      };
      const webUrl = this.webUrl();
      if (webUrl) binding.webUrl = webUrl;
      const mcp = this.prepareMcp(surf, target, cmd.harness);
      if (mcp) binding.mcp = mcp.status;
      if (cmd.execution === 'managed') this.prepareManaged(surf, binding, launch, prompt, cmd.op_id, mcp?.args ?? [], env);
      const { groupId, group } = this.groupFor(cmd.group ?? 'Eridani');
      const res = this.conn.open(surf, {
        cmd: launchCommand(cmd.harness, cmd.model, launch, !!prompt, mcp?.args, cmd.mode),
        cwd: wt.path,
        groupId: groupId as CreateSpec['groupId'],
        group,
        title: cmd.title ?? `${cmd.harness} · ${wt.branch}`,
      });
      this.mcpEnv.delete(surf);
      if (!res.ok) {
        delete this.secrets[surf];
        this.saveSecrets();
        this.dropMcp(surf);
        return { state: 'failed', detail: `spawn: ${res.message}` };
      }
      const rec = this.deps.hub.updateRecord(surf, { eridani: binding });
      this.noteLaunched(surf, rec?.incarnation ?? 1);
      this.deps.registry.saveNow();
      if (cmd.execution === 'managed') { try { await this.managed.ready(surf); } catch { return { state: 'uncertain', detail: 'managed provider startup or receipt failed; reconcile before retry', result: this.spawnFacts(rec!) }; } }
      this.deps.changed?.();
      this.log(`eridani: spawned ${cmd.harness}${cmd.role ? ` ${cmd.role}` : ''}${cmd.mode ? ` (read-only: ${cmd.mode})` : ''} for run ${cmd.run_id} g${cmd.generation} in ${wt.path} (${surf})${mcp ? `; Eridani MCP ${mcp.status.configured ? 'configured' : `not configured: ${mcp.status.reason}`}` : ''}`);
      return { state: 'executed', result: this.spawnFacts(rec!) };
    } finally {
      this.spawning.delete(surf);
      this.spawningOn.delete(surf);
      if (claimed) this.claims.delete(claim);
    }
  }

  /** S-Q3: live Eridani sessions on a target, plus spawns in flight there (limits.maxRuns). */
  private runsOn(targetId: string): number {
    const live = liveWriters(this.deps.registry.sessions()).filter((w) => w.target === targetId).length;
    return live + [...this.spawningOn.values()].filter((t) => t === targetId).length;
  }

  /**
   * S-Q3: prepare a worktree once at a time: a shared spawn onto a worktree
   * being prepared waits for that preparation instead of starting another.
   */
  private prepareWorktree(target: ExecutionTarget, worktree: string, force: boolean): Promise<PrepareFacts | null> {
    const inflight = this.preparing.get(worktree);
    if (inflight) return inflight;
    const run = (this.deps.prepare ?? ((t, w, f) => runPrepare(t, w, { force: f })))(target, worktree, force).catch(
      (err): PrepareFacts => ({ ran: true, ok: false, steps: [], reason: `cannot run: ${(err as Error)?.message ?? err}`.slice(0, ERIDANI_LIMITS.reasonChars) }),
    );
    const p = run.finally(() => this.preparing.delete(worktree));
    this.preparing.set(worktree, p);
    return p;
  }

  /**
   * S-S4: the live session writing `branch` on `target` (the oldest, when a
   * spawn shared it), or the spawn in flight claiming it; null when free.
   * A read-only session (hyperplan `mode`) is not a writer.
   */
  writerFor(targetId: string, branch: string): WorktreeWriter | null {
    const live = liveWriters(this.deps.registry.sessions()).find((w) => w.target === targetId && w.branch === branch && !w.readOnly);
    return live?.writer ?? this.claims.get(`${targetId}\0${branch}`) ?? null;
  }

  // ── input ────────────────────────────────────────────────────────────────

  /**
   * Begin a write on a surface (a steer, or the delivery of a queued input),
   * fenced on what holds now: the run, the generation, the process
   * incarnation and the link epoch. At most one is pending per surface; the
   * caller cancels an older one first when a newer one supersedes it.
   */
  private startWrite(rec: SessionRecord, kind: PendingWrite['kind'], generation: number): PendingWrite {
    const w: PendingWrite = {
      surf: rec.id,
      runId: rec.eridani!.runId,
      kind,
      generation,
      incarnation: rec.incarnation ?? 0,
      linkEpoch: this.linkEpoch,
      written: { escape: false, text: false, enter: false },
      canceled: null,
      timer: null,
      wake: null,
    };
    this.writes.set(rec.id, w);
    return w;
  }

  private endWrite(w: PendingWrite): void {
    if (this.writes.get(w.surf) === w) this.writes.delete(w.surf);
    if (w.timer !== null) this.timers.clearTimeout(w.timer);
    w.timer = null;
    w.wake = null;
  }

  /** Cancel the surface's pending write (when `which` agrees): it writes nothing more, and reports why. */
  private cancelWrites(surf: string, reason: string, which: (w: PendingWrite) => boolean = () => true): void {
    const w = this.writes.get(surf);
    if (!w || !which(w)) return;
    w.canceled ??= reason;
    this.writes.delete(surf);
    if (w.timer !== null) this.timers.clearTimeout(w.timer);
    w.timer = null;
    const wake = w.wake;
    w.wake = null;
    wake?.(false);
  }

  /** Wait `ms` as part of the write's lifetime. False: it was canceled meanwhile (it is woken at once). */
  private hold(w: PendingWrite, ms: number): Promise<boolean> {
    if (w.canceled) return Promise.resolve(false);
    return new Promise((resolve) => {
      w.wake = resolve;
      w.timer = this.timers.setTimeout(() => {
        w.timer = null;
        w.wake = null;
        resolve(!w.canceled);
      }, ms);
    });
  }

  /**
   * Checked immediately before every byte a write injects: why it may no
   * longer write, or null. The surface must still carry the same run, in the
   * same generation and process incarnation, with no stop requested and the
   * run's agent present (M7), and the link must not have dropped since the
   * write began (Eridani's reconcile decides what happens after a reconnect).
   */
  private blocked(w: PendingWrite): string | null {
    if (w.canceled) return w.canceled;
    const rec = this.deps.registry.session(w.surf);
    const b = rec?.eridani;
    if (!rec || !b || b.runId !== w.runId) return 'the surface is no longer bound to the run';
    if ((rec.incarnation ?? 0) !== w.incarnation) return `the process was replaced (incarnation ${rec.incarnation ?? 0})`;
    if (b.generation !== w.generation) return `superseded by generation ${b.generation}`;
    if (b.stopRequested) return 'a stop was requested';
    if (!this.deps.hub.isLive(w.surf)) return 'the process ended';
    if (w.linkEpoch !== this.linkEpoch || !this.deps.linkReady()) return 'the link to Eridani dropped';
    return this.agentPresent(rec);
  }

  /** One fenced injection of a write. Null when written, else why not. */
  private put(w: PendingWrite, step: keyof PendingWrite['written'], data: string): string | null {
    const why = this.blocked(w);
    if (why) return why;
    if (!this.deps.hub.inject(w.surf, data)) return 'the process ended';
    w.written[step] = true;
    return null;
  }

  /**
   * Type text as a bracketed paste, then Enter `pasteEnterMs` later. Both
   * injections are fenced, and the Enter delay is part of the write: a cancel
   * during it means Enter is never sent. Null when the text was submitted.
   */
  private async type(w: PendingWrite, text: string): Promise<string | null> {
    // M6: no ESC (or C1 CSI) reaches the terminal, so nothing can end the
    // paste early or arrive as a key (commandShapeError already refuses them).
    // eslint-disable-next-line no-control-regex -- removing control characters is the point
    const clean = text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
    const pasted = this.put(w, 'text', `\x1b[200~${clean}\x1b[201~`);
    if (pasted) return pasted;
    if (!(await this.hold(w, this.timing.pasteEnterMs))) return w.canceled ?? 'canceled';
    return this.put(w, 'enter', '\r');
  }

  /** The outcome of a write that did not submit its text, saying what was and was not written. */
  private interrupted(w: PendingWrite, reason: string): CommandResult {
    const { escape, text } = w.written;
    const sent = w.kind === 'steer'
      ? (text ? 'Esc and the text were sent; Enter was not' : escape ? 'Esc was sent; the text and Enter were not' : 'nothing was sent')
      : (text ? 'the text was pasted; Enter was not sent' : 'nothing was typed');
    const left = text ? ', so the text was not submitted (it may still sit in the agent\'s input)' : '';
    return {
      state: 'failed',
      detail: `interrupted: ${reason}. ${sent}${left}.`,
      result: { mode: w.kind, generation: w.generation, outcome: 'interrupted', reason, written: { ...w.written } },
    };
  }

  private wait(ms: number): Promise<void> {
    return new Promise((r) => this.timers.setTimeout(r, ms));
  }

  private async steer(cmd: InputCommand, ctx: CommandContext): Promise<CommandResult> {
    // Fenced again: an accepted command can run later than its precheck (a replay).
    const stale = this.fence(cmd, 'steer');
    if (stale) return { state: 'rejected', detail: stale };
    // A newer steer cancels the older pending write (a steer, or a queued input before its Enter).
    this.cancelWrites(cmd.surf, 'superseded by a newer steer');
    const rec = this.deps.registry.session(cmd.surf)!;
    // The generation advances BEFORE the new turn starts, so its prompt binds to it.
    const updated = this.deps.hub.updateRecord(cmd.surf, { eridani: { ...rec.eridani!, generation: cmd.generation, acceptedInput: { generation: cmd.generation, at: this.now() } } });
    this.deps.registry.saveNow();
    this.rejectQueued(cmd.surf, 'superseded by a steer');
    this.attempts.cancel(cmd.surf, 'steer');
    const w = this.startWrite(updated ?? rec, 'steer', cmd.generation);
    ctx.begin();
    try {
      const esc = this.put(w, 'escape', '\x1b');
      if (esc) return this.interrupted(w, esc);
      if (!(await this.hold(w, this.timing.steerDelayMs))) return this.interrupted(w, w.canceled ?? 'canceled');
      const why = await this.type(w, cmd.text);
      if (why) return this.interrupted(w, why);
      return { state: 'executed', result: { mode: 'steer', generation: cmd.generation } };
    } finally {
      this.endWrite(w);
    }
  }

  private async input(cmd: InputCommand, ctx: CommandContext): Promise<CommandResult> {
    if (this.deps.registry.session(cmd.surf)?.eridani?.execution === 'managed') {
      const rec = this.deps.registry.session(cmd.surf)!;
      if (cmd.generation > rec.eridani!.generation) { this.deps.hub.updateRecord(cmd.surf, { eridani: { ...rec.eridani!, generation: cmd.generation } }); this.managed.generation(cmd.surf, cmd.generation); }
      if (cmd.mode === 'steer') { ctx.begin(); await this.managed.interrupt(cmd.surf); }
      return this.managed.send(cmd.surf, cmd.text, cmd.op_id, false, () => ctx.begin());
    }
    if (cmd.mode === 'steer') return this.steer(cmd, ctx);
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
      // One write per surface at a time: the previous input's Enter may still be due.
      if (!this.draining && !this.writes.has(surf) && this.deps.linkReady() && st?.state === 'idle' && fresh) {
        list.shift();
        try {
          head.ctx.begin();
        } catch (err) {
          // `executing` could not be recorded (the journal is down): nothing was typed. This input
          // fails, and the tick goes on, so the inputs queued behind it are not stranded.
          const why = (err as Error)?.message ?? String(err);
          this.log(`eridani: queued input for ${surf} not delivered: ${why}`);
          head.resolve({ state: 'failed', detail: `not delivered: ${why}`.slice(0, ERIDANI_LIMITS.reasonChars) });
          if (list.length) this.pollTimers.set(surf, this.timers.setTimeout(tick, this.timing.queuePollMs));
          else this.queues.delete(surf);
          return;
        }
        this.delivered.set(surf, this.now());
        this.acceptInput(surf, head.cmd.generation);
        const w = this.startWrite(this.deps.registry.session(surf)!, 'queue', head.cmd.generation);
        // `executed` only once Enter was sent; a cancel before it is reported as interrupted.
        void this.type(w, head.cmd.text).then((why) => {
          this.endWrite(w);
          head.resolve(why ? this.interrupted(w, why) : { state: 'executed', result: { mode: 'queue', generation: head.cmd.generation } });
        });
      }
      if (list.length) this.pollTimers.set(surf, this.timers.setTimeout(tick, this.timing.queuePollMs));
      else this.queues.delete(surf);
    };
    this.pollTimers.set(surf, this.timers.setTimeout(tick, 0));
  }

  /** F07: persist the generation of the input about to be typed, before it is typed. */
  private acceptInput(surf: string, generation: number): void {
    const rec = this.deps.registry.session(surf);
    if (!rec?.eridani) return;
    this.deps.hub.updateRecord(surf, { eridani: { ...rec.eridani, acceptedInput: { generation, at: this.now() } } });
    this.deps.registry.saveNow();
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
    this.cancelWrites(surf, 'a stop was requested');
    this.rejectQueued(surf, 'stopping');
    this.attempts.cancel(surf, 'stop requested');
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
    if (this.deps.registry.session(cmd.surf)?.eridani?.execution === 'managed') { ctx.begin(); await this.managed.cancel(cmd.surf); return { state: 'executed', result: { surf: cmd.surf, exited: true } }; }
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
    this.cancelWrites(surf, 'the process exited');
    this.rejectQueued(surf, 'the process exited');
    this.attempts.cancel(surf, 'the process exited');
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
    if (!rec || !b || !t?.verify.some((v) => v.id === cmd.verify_id)) return { state: 'rejected', detail: 'unknown run or verify id' };
    // A run that never told us its verify config verifies after every turn from now on (a newer plan revision replaces it).
    if (!b.verify || cmd.plan_revision > b.verify.planRevision) {
      this.deps.hub.updateRecord(rec.id, { eridani: { ...b, verify: { verifyId: cmd.verify_id, planRevision: cmd.plan_revision } } });
      this.deps.registry.saveNow();
    }
    ctx.begin();
    const out = await this.attempts.command(rec.id, cmd);
    return out.state === 'executed' ? { state: 'executed', result: out.result } : { state: 'rejected', detail: out.detail };
  }

  // ── Link ─────────────────────────────────────────────────────────────────

  /**
   * The link (re)became ready. A write that began before it may be stale:
   * Eridani's runs.snapshot is the reconcile, and it has not been applied
   * yet. Every pending write is canceled (and says so); none is resumed.
   */
  linkUp(): void {
    this.linkEpoch++;
    this.managed.replay();
    for (const surf of [...this.writes.keys()]) this.cancelWrites(surf, 'the link to Eridani dropped and reconnected');
  }

  // ── Recovery ─────────────────────────────────────────────────────────────

  private resumeCommand(rec: SessionRecord): string | null | undefined {
    const b = rec.eridani;
    if (!b) return undefined;
    if (b.execution === 'managed' && b.controller !== 'terminal') {
      if (b.stopRequested || this.deps.resumeAgents === false) return null;
      const target = this.target(b.target); const launch = target?.launch[b.harness];
      if (!launch) return null;
      const mcp = this.prepareMcp(rec.id, target, b.harness);
      this.prepareManaged(rec.id, b, launch, '', b.spawnOp, mcp?.args ?? [], this.secrets[rec.id]?.env ?? {}, (rec.incarnation ?? 0) + 1);
      return '';
    }
    if (b.stopRequested || this.deps.resumeAgents === false || !rec.agent) return null;
    const t = this.target(b.target);
    const mcp = this.prepareMcp(rec.id, t, b.harness);
    if (mcp && !mcp.status.configured) this.log(`eridani: resuming ${rec.id} without Eridani MCP: ${mcp.status.reason}`);
    const line = resumeLine(b, t?.launch[b.harness], rec.agent.sessionId, b.execution === 'managed' ? this.roleMcpArgs(b, mcp?.args ?? []) : mcp?.args);
    if (!line) this.dropMcp(rec.id);
    // The hub respawns with this line as the next incarnation.
    this.cancelWrites(rec.id, 'the process is being respawned');
    if (line) this.noteLaunched(rec.id, (rec.incarnation ?? 0) + 1);
    return line;
  }

  /**
   * Boot: respawn every Eridani session the restart lost, resuming its
   * conversation (no new prompt: a resumed agent waits at its prompt). A
   * session whose stop was requested is not resumed; its process is gone,
   * so the stop is complete.
   */
  resumeOnBoot(): void {
    for (const rec of this.deps.registry.sessions()) this.attempts.recover(rec);
    // S-Q5: a process the PTY keeper kept is the same incarnation: what vouched for it still does.
    const launched = this.loadLaunched();
    for (const rec of this.deps.registry.sessions()) {
      if (!rec.eridani || !this.deps.hub.isLive(rec.id)) continue;
      const l = launched[rec.id];
      if (l && l.incarnation === (rec.incarnation ?? 0)) this.launchedWith.set(rec.id, { incarnation: l.incarnation, agentSeen: !!l.agentSeen });
      const stop = rec.eridani.stopRequested;
      if (stop) {
        this.log(`eridani: ${rec.id} outlived the restart with a stop requested; stopping it again (${stop.mode})`);
        void this.terminate(rec.id, stop.mode);
      }
    }
    // Rewritten (pruned) only when there is something to keep or to drop.
    if (this.launchedWith.size || Object.keys(launched).length) this.saveLaunched();
    for (const rec of this.deps.registry.sessions()) {
      if (!rec.eridani || rec.state !== 'lost') continue;
      if (rec.eridani.stopRequested) {
        this.finishLost(rec, 'stopped (the process ended with the server restart)');
        continue;
      }
      if ((!rec.agent && rec.eridani.execution !== 'managed') || this.deps.resumeAgents === false) {
        // D4: no conversation to resume is an ended run, never a bare shell.
        this.deps.hub.exitLost(rec.id, rec.agent ? 'resuming agents is turned off' : 'no conversation to resume');
        continue;
      }
      const res = this.conn.open(rec.id, {});
      this.log(res.ok ? `eridani: resumed ${rec.id} (run ${rec.eridani.runId})` : `eridani: cannot resume ${rec.id}: ${res.message}`);
    }
  }

  private finishLost(rec: SessionRecord, why: string): void {
    const { stopRequested: _s, ...rest } = rec.eridani!;
    this.deps.hub.updateRecord(rec.id, { eridani: rest });
    this.deps.hub.exitLost(rec.id, why);
  }

  /**
   * Eridani's desired state after a reconnect (C08). A newer generation is
   * adopted (queued input of an older one is then refused, never typed); a
   * `stop` is carried out like a stop command. Hyperplan: an entry that names
   * a `surf` (or an `attempt`) applies to that one session of the run; one
   * that names neither applies to every session of the run, as before.
   */
  applyRunsSnapshot(runs: RunsSnapshotEntry[]): void {
    for (const r of runs) {
      const targets = this.deps.registry.sessions().filter((s) => s.eridani?.runId === r.run_id
        && (r.surf !== undefined ? s.id === r.surf : r.attempt === undefined || s.eridani!.attempt === r.attempt));
      for (const rec of targets) {
        let b = rec.eridani!;
        if (r.generation > b.generation && rec.state !== 'exited') {
          b = { ...b, generation: r.generation };
          this.managed.generation(rec.id, r.generation);
          this.deps.hub.updateRecord(rec.id, { eridani: b });
          this.deps.registry.saveNow();
          this.cancelWrites(rec.id, `superseded by generation ${r.generation} (runs.snapshot)`, (w) => w.generation < r.generation);
        }
        if (r.verify !== undefined && rec.state !== 'exited') {
          const { verify: _old, ...rest } = b;
          b = r.verify ? { ...rest, verify: { verifyId: r.verify.verify_id, planRevision: r.verify.plan_revision } } : rest;
          this.deps.hub.updateRecord(rec.id, { eridani: b });
          this.deps.registry.saveNow();
        }
        if (b.controller === 'terminal') continue;
        if (this.managed.has(rec.id) && (r.desired === 'pause' || r.desired === 'continue')) void this.managed.pause(rec.id, r.desired === 'pause').catch((e) => this.log(`managed pause: ${String(e)}`));
        if (r.desired !== 'stop') continue;
        if (rec.state === 'lost') {
          this.finishLost({ ...rec, eridani: { ...b, stopRequested: { at: this.now(), mode: r.stop_mode ?? 'interrupt', op: null } } }, 'stopped by Eridani while lost');
        } else if (this.deps.hub.isLive(rec.id) && !b.stopRequested) {
          this.markStop(rec.id, r.stop_mode ?? 'interrupt', null, r.generation);
          if (b.execution === 'managed') void this.managed.cancel(rec.id);
          else void this.terminate(rec.id, r.stop_mode ?? 'interrupt');
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
    for (const id of Object.keys(this.secrets)) {
      if (!this.deps.registry.session(id) && !this.spawning.has(id)) {
        delete this.secrets[id];
        this.dropMcp(id);
      }
    }
    const file = path.join(this.deps.dir, RUNS_FILE);
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(this.secrets, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file);
  }
}
