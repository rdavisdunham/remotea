/**
 * The Eridani link: remotea-server <-> Eridani, one outbound WebSocket that
 * the server dials (Eridani on Railway cannot reach a Tailscale-only box).
 *
 *   wss://…/api/v1/external/agents/link   subprotocol `eridani.v1`
 *   Authorization: Bearer <link bot key>    User-Agent: remotea-server/<version>
 *
 * Every frame is one JSON text message with an envelope:
 *
 *   { v: 1, id, conn_epoch, t, at, ...body }
 *
 * `id` is the TRANSPORT id: new for every send, including a resend after a
 * reconnect. Anything with an effect on the other side (an event Eridani
 * stores, a command remotea runs) also carries a stable `op_id` and a `digest`
 * of its semantic payload, which never change across reconnects (F06). The
 * receiver journals on `op_id`: a repeat with the same digest returns the
 * recorded outcome, a repeat with a different digest is rejected.
 *
 * `ack { acked_id, op_id?, ok, error?, retry?, outcome? }` answers one frame by
 * its transport id. Stage B: hello/welcome/bye, ack, and the upward events
 * session.report, turn, status, exit, sessions.snapshot. Stage C adds the
 * commands Eridani sends down (spawn, input, answer, stop, verify), their
 * `command.outcome`, the reconcile answer `runs.snapshot`, questions
 * (`question`, `question.resolved`), `verify.result`, and the correlated
 * `context.request` / `context.response` pair.
 *
 * Pure: no Node or DOM imports (the digest itself is computed by the server
 * with node:crypto over `canonicalJson(semanticPayload(frame))`).
 */

export const ERIDANI_PROTO = 1;
export const ERIDANI_SUBPROTOCOL = 'eridani.v1';

export const ERIDANI_LIMITS = Object.freeze({
  /** Eridani runs uvicorn with --ws-max-size 262144; stay well below it. */
  maxFrameBytes: 200_000,
  /** A turn's final response, in characters (decision 3: "the final response, up to 16k"). */
  turnTextChars: 16_000,
  /** The prompt that opened the turn, in characters (the hook helper's own cap). */
  promptChars: 4_000,
  /** Free text in status reasons and errors. */
  reasonChars: 300,
  /** Spool bounds (C14). Protected entries may exceed them up to `spoolHardFactor`. */
  spoolMaxEntries: 5_000,
  spoolMaxBytes: 32 * 1024 * 1024,
  spoolHardFactor: 2,
  /** Unacked frames on the wire at once. */
  inflightMax: 32,
  /** How long a command id is remembered (and older commands refused). */
  replayHorizonMs: 7 * 24 * 60 * 60 * 1000,
  /** A spawn prompt or an input text, in characters. */
  promptInChars: 32_000,
  /** context.response text printed to the agent, in characters. */
  contextChars: 16_000,
  /** One question's text. */
  questionTextChars: 4_000,
  /** The output tail of a verify run, in characters. */
  verifyTailChars: 4_000,
});

export const ERIDANI_TIMING = Object.freeze({
  /** WebSocket-level ping; any inbound frame or pong counts as life. */
  pingMs: 15_000,
  deadMs: 25_000,
  handshakeMs: 10_000,
  /** How long `remotea eridani connect` waits for welcome. */
  probeMs: 10_000,
  /** SessionStart waits this long for context.response; a later answer is dropped. */
  contextMs: 2_500,
  /** Claude's AskUserQuestion hook timeout (claude-hooks.ts) and how long remotea holds before it. */
  questionHookTimeoutS: 600,
  questionHoldMs: 570_000,
});

// ── Ids and fences ─────────────────────────────────────────────────────────

/** Link capabilities a side may advertise in hello (remotea) or welcome (Eridani). */
export type LinkCap =
  | 'session.report'
  | 'session.report.parity'
  | 'turn'
  | 'status'
  | 'exit'
  | 'sessions.snapshot'
  | 'chunking'
  | 'journal'
  // Stage C.
  | 'question'
  | 'context'
  | 'spawn'
  | 'input'
  | 'answer'
  | 'stop'
  | 'verify'
  | 'runs.snapshot'
  | 'worktrees.report'
  // Stage D: the host verifies after each root turn on its own (`local:` attempt ids).
  | 'verify.auto'
  // Stage E: this host's collector is authoritative (reports carry parity: false). Informational.
  | 'collector.authoritative'
  // Stage F: every op frame carries its digest (Eridani may then require it), and
  // context.response's `scope` is honoured (D6: full text only for run-bound surfaces).
  | 'digest'
  | 'context.scope'
  // The host sends each root prompt as it is submitted (`prompt`), before the turn that answers it.
  | 'prompt'
  // The host takes `worktrees.scan`: a fresh worktrees.report and session.report on request (the judge's PR evidence).
  | 'worktrees.scan';

export const STAGE_B_CAPS: readonly LinkCap[] = Object.freeze([
  'session.report', 'session.report.parity', 'turn', 'status', 'exit', 'sessions.snapshot', 'chunking', 'journal',
]);

/** Stage C: everything in B, plus remote control. */
export const STAGE_C_CAPS: readonly LinkCap[] = Object.freeze([
  ...STAGE_B_CAPS, 'question', 'context', 'spawn', 'input', 'answer', 'stop', 'verify', 'runs.snapshot', 'worktrees.report',
]);

/** Stage D: everything in C, plus automatic verification after turns. */
export const STAGE_D_CAPS: readonly LinkCap[] = Object.freeze([...STAGE_C_CAPS, 'verify.auto']);

/** Stage E, advertised only while `eridani.json.collector` is `authoritative`. */
export const STAGE_E_AUTHORITATIVE_CAPS: readonly LinkCap[] = Object.freeze([...STAGE_D_CAPS, 'collector.authoritative']);

/** Stage F: everything in D, plus `digest`, `context.scope`, live `prompt` frames and `worktrees.scan`. */
export const STAGE_F_CAPS: readonly LinkCap[] = Object.freeze([...STAGE_D_CAPS, 'digest', 'context.scope', 'prompt', 'worktrees.scan']);
export const STAGE_F_AUTHORITATIVE_CAPS: readonly LinkCap[] = Object.freeze([...STAGE_F_CAPS, 'collector.authoritative']);

/**
 * The shape of `harnesses` and `targets` in hello (S-S1). 1: every harness was
 * marked spawn-capable; 2: `spawn` means the launcher was probed through the
 * login shell and works on some target that enables it, `installed` and
 * `launch_error` say why not, and each target carries `enabled`, `launch` and
 * `verify_status`. Additions never lower it.
 */
export const ERIDANI_CAPS_VERSION = 2;

/** What one harness can do on this host (the capability matrix, C15). Advertise only what is verified. */
export interface HarnessCaps {
  /** `claude --version` / `codex --version`, or null when not installed. */
  version: string | null;
  /**
   * caps_version 2: some launcher for this harness (the bare name, or a
   * target's `bin`) answered `--version` through the login shell, with the
   * environment a launch gets. Absent from older hosts.
   */
  installed?: boolean;
  /** caps_version 2: why the harness is not installed (no launcher answered), ≤ 300 characters. */
  launch_error?: string;
  /** Hooks installed so status and turns are observed. */
  observe: boolean;
  /** Final responses captured from the Stop hook. */
  capture: boolean;
  /** Structured question answering (stage C, Claude only). */
  question: boolean;
  /** SessionStart context injection (stage C). */
  context: boolean;
  /** The server resumes the conversation after a restart. */
  resume: boolean;
  /**
   * Stage C: Eridani may `spawn` this harness. caps_version 2: true only when
   * some target enables it AND that target's launcher was probed and works.
   */
  spawn?: boolean;
  /** Stage C: how `input mode:steer` is carried out. Always 'interrupt' in v1: the turn is interrupted and the text starts a new one. */
  steer?: 'interrupt';
  /** Stage C: permission prompts are captured (needs_you), never answered remotely in v1. */
  permission?: 'capture';
  /** Stage C: flags every launch of this harness carries (Codex: `--disable daemon_auto_start`). */
  launch_flags?: string[];
}

export type HarnessName = 'claude' | 'codex' | 'opencode';
export type CapabilityMatrix = Partial<Record<HarnessName, HarnessCaps>>;

export type AgentRunStateName = 'working' | 'needs_you' | 'idle' | 'exited';
export type SessionTool = 'claude_code' | 'claude_desktop' | 'codex_cli' | 'codex_desktop';

// ── Envelope ───────────────────────────────────────────────────────────────

export interface Envelope {
  v: 1;
  /** Transport id: unique per send. */
  id: string;
  /** Eridani's id for this accepted connection; null before welcome. */
  conn_epoch: number | null;
  t: string;
  /** Sender's clock, epoch milliseconds. */
  at: number;
}

/** An effectful frame: stable across reconnects. */
export interface OpFields {
  op_id: string;
  /** sha256 hex of canonicalJson(semanticPayload(frame)). */
  digest: string;
}

/** `part` of a chunked message: `of` names the whole, `i` counts from 1. */
export interface Part {
  of: string;
  i: number;
  n: number;
}

// ── remotea → Eridani ──────────────────────────────────────────────────────

export interface HelloBody {
  t: 'hello';
  server_id: string;
  boot_id: string;
  hostname: string;
  machine: string;
  proto: number;
  /** remotea-server package version. */
  version: string;
  /** The git commit the running server was built from (40 hex), or "unknown" (a build without git, or an older build script). */
  build_sha?: string;
  /** The build had uncommitted changes; absent when unknown. */
  build_dirty?: boolean;
  /** ERIDANI_CAPS_VERSION: how to read `harnesses` and `targets`. Absent: 1. */
  caps_version?: number;
  /** The installed hook helper (wmux-hook.js): the first 12 hex of its sha256, null when not installed. */
  hook_version?: string | null;
  caps: LinkCap[];
  harnesses: CapabilityMatrix;
  /** Stage C: the configured execution targets (ids and repos only; never argv or env). */
  targets?: HelloTarget[];
  /**
   * Present only while the host is degraded: why (e.g.
   * `journal_unavailable (write failed: ENOSPC)` while effectful commands are
   * refused, or `disk-full` / `spool-full` for the outbox). Absent when
   * healthy. Optional; an older Eridani ignores it.
   */
  degraded_reason?: string;
}

/** One launcher on one target, as probed (caps_version 2). */
export interface HelloLaunch {
  /** `<bin> --version` answered through the login shell. */
  ready: boolean;
  version: string | null;
  /** Why not ready, ≤ 300 characters. */
  error?: string;
}

/** One verify entry's readiness (caps_version 2): its program resolves on the service PATH, its cwd exists. */
export interface HelloVerifyStatus {
  id: string;
  ready: boolean;
  /** Why not ready (never the argv). */
  reason?: string;
}

/** One execution target as hello lists it, for Eridani's target picker. */
export interface HelloTarget {
  id: string;
  repo: string;
  worktree_root?: string;
  /**
   * The harnesses Eridani may spawn here. Older hosts: those the target's
   * `launch` enables. caps_version 2: those it enables AND whose launcher
   * probe succeeded (always a subset of `enabled`).
   */
  harnesses: Array<'claude' | 'codex'>;
  /** caps_version 2: the harnesses the target's `launch` enables (permission, whether or not installed). */
  enabled?: Array<'claude' | 'codex'>;
  /** caps_version 2: the probe of each enabled harness's launcher on this target. */
  launch?: Partial<Record<'claude' | 'codex', HelloLaunch>>;
  /** Verification ids the target defines (`verify` commands name one). */
  verify: string[];
  /** caps_version 2: one entry per verify id, in the same order. */
  verify_status?: HelloVerifyStatus[];
  /** Where numbered migrations live, when configured (Eridani then reserves migration numbers). */
  migrations?: { dir: string; pattern?: string };
}

/** The SessionInput the HTTP collector PUTs to /sessions/{tool}/{session_id}, unchanged. */
export interface SessionReportInput {
  machine: string;
  environment: string;
  cwd: string;
  repo: string;
  branch: string;
  title: string;
  first_prompt: string;
  last_prompt: string;
  excerpt: string;
  pr_urls: string[];
  turn_count: number;
  started_at: string | null;
  last_active_at: string | null;
  resume: Record<string, unknown>;
}

export interface SessionReportBody extends OpFields {
  t: 'session.report';
  /** Coalescing key: `${tool}:${session_id}`. */
  entity: string;
  /** The report's fingerprint; a newer revision of an entity replaces an unsent older one. */
  revision: string;
  /** Shadow mode: Eridani compares with what it has instead of upserting. */
  parity: boolean;
  tool: SessionTool;
  session_id: string;
  report: SessionReportInput;
}

export interface TurnBody extends OpFields {
  t: 'turn';
  surf: string;
  incarnation: number;
  run_id: string | null;
  generation: number;
  provider: 'claude' | 'codex';
  tool: SessionTool;
  provider_session_id: string;
  provider_turn_id: string;
  root: true;
  /** Per surface, persisted, counts captured turns from 1. */
  seq: number;
  text: string;
  truncated: boolean;
  /** The hook carried no final response (and no fallback found one). */
  missing: boolean;
  source: 'hook' | 'rollout';
  prompt?: string;
  prompt_truncated?: boolean;
  /** The prompt was a background subagent's hand-back, not new input (it does not count as a turn of its own). */
  synthetic?: boolean;
  /** A root Stop while background tasks still ran: an interim answer, not the turn's final one. */
  interim?: boolean;
  /** When the Stop hook fired, epoch ms. */
  ended_at: number;
}

/**
 * A root prompt the moment it was submitted (UserPromptSubmit), so Eridani's
 * run timeline shows it before the turn ends. Sent only for a surface bound
 * to a run and only to an Eridani whose welcome advertised `prompt`; the
 * `turn` that follows still carries `prompt` for older Eridanis.
 */
export interface PromptBody extends OpFields {
  t: 'prompt';
  surf: string;
  incarnation: number;
  run_id: string;
  generation: number;
  provider: 'claude' | 'codex';
  tool: SessionTool;
  provider_session_id: string;
  /**
   * The `seq` the turn answering this prompt will carry (`turnSeq + 1` at
   * submit; the Stop that follows assigns the same number). A prompt without a
   * matching turn (restart mid-turn, dropped Stop) leaves a gap, never a clash.
   */
  seq: number;
  /** Redacted and cut at `ERIDANI_LIMITS.promptChars` code points. */
  text: string;
  truncated: boolean;
  /** When the hook fired, epoch ms. */
  at: number;
}

export interface StatusBody extends OpFields {
  t: 'status';
  /** Coalescing key: `status:${surf}`. */
  entity: string;
  /** Monotonic per surface; a lower revision never overrides a higher one. */
  revision: number;
  surf: string;
  incarnation: number;
  state: AgentRunStateName;
  /** When this state began, epoch ms. */
  since: number;
  reason?: string;
  provider?: string;
  provider_session_id?: string;
  effective_permission_mode?: string;
}

export interface ExitBody extends OpFields {
  t: 'exit';
  surf: string;
  incarnation: number;
  code: number;
  exited_at: number;
  /** Why the host ended it itself (stage F: a lost run that could not be resumed is left exited, never a bare shell). */
  reason?: string;
}

export interface SnapshotSurface {
  surf: string;
  incarnation: number;
  /** The terminal: live here, lost in a restart, or exited. */
  state: 'live' | 'lost' | 'exited';
  agent_state: AgentRunStateName | null;
  since: number | null;
  provider: string | null;
  provider_session_id: string | null;
  group: string | null;
  title: string | null;
  cwd: string;
  turn_seq: number;
  /** The Eridani run this surface executes, or null. */
  run_id: string | null;
  generation: number;
  /** Stage C: the rest of the run binding (absent when there is none). */
  task_id?: string | null;
  target?: string | null;
  worktree?: string | null;
  branch?: string | null;
  /** A `stop` was accepted and the process has not been seen to exit yet. */
  stop_requested?: boolean;
  /** Question ids still open on this surface. */
  questions?: string[];
}

export interface SessionsSnapshotBody extends OpFields {
  t: 'sessions.snapshot';
  part: Part;
  surfaces: SnapshotSurface[];
  /** Inbound journal entries that are not settled (stage C has real ones). */
  journal: { pending: string[]; uncertain: string[] };
}

/**
 * SessionStart asked for the agent's grounding text. Correlated by `req_id`;
 * remotea waits ERIDANI_TIMING.contextMs for the answer and drops a later one.
 * Ephemeral: never spooled, never resent.
 */
export interface ContextRequestBody {
  t: 'context.request';
  req_id: string;
  surf: string;
  incarnation: number;
  provider: 'claude' | 'codex';
  provider_session_id: string;
  /** SessionStart's `source`: startup | resume | clear | compact. */
  source: string;
  cwd: string;
  run_id: string | null;
  generation: number;
  task_id: string | null;
}

export type CommandOutcomeState = 'executed' | 'failed' | 'rejected' | 'uncertain';

export interface CommandOutcomeBody extends OpFields {
  t: 'command.outcome';
  /** The op_id of the command this reports on. */
  command_id: string;
  state: CommandOutcomeState;
  detail?: string;
  /** The command's kind (spawn, input, …), when known. */
  kind?: string;
  /** Kind-specific facts: spawn → {surf, incarnation, worktree, branch, base, base_sha, base_ref?, fetch?, behind?, ahead?}. */
  result?: Record<string, unknown>;
}

/** One question item as Eridani shows it (AskUserQuestion's `questions[i]`). */
export interface QuestionItem {
  id: string;
  text: string;
  header?: string;
  choices?: Array<{ id: string; label: string; description?: string }>;
  multi?: boolean;
}

/** An agent asked something that can be answered remotely (Claude AskUserQuestion). */
export interface QuestionBody extends OpFields {
  t: 'question';
  question_id: string;
  surf: string;
  incarnation: number;
  run_id: string | null;
  /** The generation the turn that asked belongs to (F07), not the run's current one. */
  generation: number;
  provider: 'claude';
  provider_session_id: string;
  /** Claude's `tool_use_id` for the AskUserQuestion call; `answer` must echo it. */
  provider_request_id: string;
  provider_turn_id: string | null;
  kind: 'ask';
  /** One AskUserQuestion call = one group; answered all at once. */
  group_id: string;
  items: QuestionItem[];
  /** remotea stops holding at this time (epoch ms) and the question falls back to the terminal. */
  hold_until: number;
}

/**
 * What became of a question. `timed_out` is NOT a resolution (F04): the hook
 * gave up, the terminal now shows the question, `still_open` is true and
 * remote answering is off. `answered_locally` / `accepted` close it.
 */
export type QuestionOutcome = 'accepted' | 'timed_out' | 'failed' | 'canceled' | 'answered_locally';

export interface QuestionResolvedBody extends OpFields {
  t: 'question.resolved';
  question_id: string;
  generation: number;
  outcome: QuestionOutcome;
  still_open: boolean;
  remote_answerable: false;
  detail?: string;
  /** The answers as the agent received them (accepted / answered_locally). */
  answer_echo?: Record<string, string>;
}

/** What the fingerprint was taken from (stage D, additive). */
export interface WorkspaceFacts {
  /** HEAD's commit, or null in a repository with no commit. */
  head: string | null;
  /** The checked-out branch, or null when HEAD is detached. */
  branch: string | null;
  /** sha256 of the branch, the status, the diff against HEAD and every untracked file. */
  tree: string;
}

/**
 * One verification attempt's result. The tuple (run_id, generation,
 * turn_seq, plan_revision, attempt_id) is what Eridani matches on. Stage D:
 * an attempt the host started on its own after a turn has an attempt id
 * `local:<uuid>` and `initiator: "host"`; an Eridani `verify` command's
 * attempt keeps its id (a host attempt already running for the same tuple is
 * adopted under it, `adopted` naming the local id).
 */
export interface VerifyResultBody extends OpFields {
  t: 'verify.result';
  attempt_id: string;
  run_id: string;
  generation: number;
  turn_seq: number;
  plan_revision: number;
  verify_id: string;
  /** `<HEAD sha>:<sha256 of the dirty tree>` before the run. */
  workspace_fingerprint: string;
  exit_code: number | null;
  /** The last ERIDANI_LIMITS.verifyTailChars characters of stdout+stderr. */
  tail: string;
  truncated: boolean;
  duration_ms: number;
  timed_out: boolean;
  canceled: boolean;
  error?: string;
  /** Stage D (additive): who started the attempt. */
  initiator?: 'host' | 'eridani';
  /** Stage D: HEAD, branch and tree hash behind `workspace_fingerprint`. */
  workspace?: WorkspaceFacts;
  /**
   * Stage D: the checkout changed between the turn and the run, or during
   * the run, so the result does not describe the tree the turn left.
   */
  stale_workspace?: boolean;
  /** Stage D: the turn's fingerprint (taken when the turn ended), when known. */
  turn_fingerprint?: string;
  /** Stage D: the host attempt this Eridani attempt adopted (same tuple, already running or finished). */
  adopted?: string;
}

// ── Both ways ──────────────────────────────────────────────────────────────

export interface AckBody {
  t: 'ack';
  /** Transport id of the frame being acknowledged. */
  acked_id: string;
  /** The op it carried, when it had one (a convenience; acked_id is authoritative). */
  op_id?: string;
  ok: boolean;
  error?: string;
  /** With ok:false: transient, send again later. Without it, a refusal is permanent. */
  retry?: boolean;
  outcome?: unknown;
}

export interface ByeBody {
  t: 'bye';
  reason: string;
}

// ── Eridani → remotea ──────────────────────────────────────────────────────

export interface WelcomeBody {
  t: 'welcome';
  /** Null only on a probe welcome for a server_id Eridani has not registered yet. */
  host_id: string | null;
  conn_epoch: number;
  /** Set when the hello carried a probe-* boot_id (`remotea eridani connect`); no lease was taken. */
  probe?: boolean;
  server_time: number | string;
  /** Seconds Eridani remembers op ids for. */
  replay_horizon?: number;
  caps?: string[];
}

export interface ContextResponseBody {
  t: 'context.response';
  req_id: string;
  text: string;
  /**
   * Stage F (D6): `run` is the full grounding for a run-bound surface;
   * `candidates` is the short fenced task list an unbound session may see.
   */
  scope?: 'run' | 'candidates';
  /** A short-lived token the agent's Eridani tools present to bind calls to the run. */
  run_token?: string;
}

// ── Commands (Eridani → remotea, stage C) ──────────────────────────────────

export type Harness = 'claude' | 'codex';

export interface SpawnCommand extends OpFields {
  t: 'spawn';
  run_id: string;
  generation: number;
  attempt: number;
  harness: Harness;
  model: string;
  /** `id` names an execution target in eridani.json; `repo`, when sent, must match it. */
  target: { id: string; repo?: string; branch: string; base?: string };
  task_id?: string;
  title?: string;
  /** Workspace group name; created once, then reused by name. */
  group?: string;
  prompt: string;
  /** Only ERIDANI_* keys are accepted. */
  env?: Record<string, string>;
  run_token?: string;
  /** Stage D: verify after each root turn with this target verify id, against this plan revision. */
  verify?: RunVerifyConfig | null;
  /** The migration number Eridani reserved for this run's plan; a reused, stale worktree's prompt then says to re-point it. */
  migration?: { number: number; dir: string } | null;
  expires_at: number | string;
}

/** The verification a run's frozen plan asks for after each root turn (stage D). */
export interface RunVerifyConfig {
  verify_id: string;
  plan_revision: number;
}

export interface InputCommand extends OpFields {
  t: 'input';
  surf: string;
  incarnation: number;
  run_id: string;
  generation: number;
  text: string;
  /** queue: delivered when the agent is next at its prompt. steer: interrupt now, then deliver (generation advances). */
  mode: 'queue' | 'steer';
  expires_at?: number | string;
}

export interface AnswerItem {
  item_id: string;
  choice_ids?: string[];
  text?: string;
}

export interface AnswerCommand extends OpFields {
  t: 'answer';
  question_id: string;
  provider_request_id: string;
  answers: AnswerItem[];
  expires_at?: number | string;
}

export interface StopCommand extends OpFields {
  t: 'stop';
  surf: string;
  incarnation: number;
  run_id: string;
  generation: number;
  /** interrupt: Ctrl-C twice. kill: SIGHUP the tree, SIGKILL after a grace. */
  mode: 'interrupt' | 'kill';
  expires_at?: number | string;
}

export interface VerifyCommand extends OpFields {
  t: 'verify';
  attempt_id: string;
  run_id: string;
  generation: number;
  turn_seq: number;
  plan_revision: number;
  verify_id: string;
  expires_at?: number | string;
}

/**
 * Rescan now and report even what did not change: every worktree
 * (`worktrees.report`) and, when named, one session (`session.report`). Eridani
 * sends it while a judge verdict waits for a PR record newer than the turn.
 * The fence is informational: a stale one is harmless, only `expires_at` counts.
 */
export interface WorktreesScanCommand extends OpFields {
  t: 'worktrees.scan';
  run_id: string;
  generation: number;
  branch?: string | null;
  turn_seq?: number | null;
  tool?: SessionTool;
  session_id?: string;
  expires_at: number | string;
}

export const SESSION_TOOLS: ReadonlySet<string> = new Set<SessionTool>(['claude_code', 'claude_desktop', 'codex_cli', 'codex_desktop']);

/** Eridani's answer to sessions.snapshot: what each run should be doing. */
export interface RunsSnapshotEntry {
  run_id: string;
  generation: number;
  desired: 'continue' | 'stop' | 'none';
  stop_mode?: 'interrupt' | 'kill';
  /** Stage D: the run's current verify config (null: none; absent: unchanged). */
  verify?: RunVerifyConfig | null;
}
/** One managed worktree, as `remotea eridani worktrees` reports it (nominate-only, never removed). */
export interface WorktreeReport {
  target: string;
  path: string;
  branch: string | null;
  base: string;
  /** The ref ahead/behind/merged are measured against: `origin/<base>` after a fetch, else `<base>`. Optional: older hosts. */
  base_ref?: string;
  head: string | null;
  active: boolean;
  ahead: number | null;
  behind: number | null;
  unpushed: number | null;
  upstream: string | null;
  /** null when it cannot be known, or when the branch has no commits of its own (then `merged_reason` says so). */
  merged: boolean | null;
  merged_reason?: string;
  uncommitted: number;
  untracked: number;
  ignored: number;
  /** Nothing would be lost. Still never removed automatically. */
  candidate: boolean;
  /** Why it is unmerged work (empty for a candidate). */
  reasons: string[];
}

/** Every managed worktree, after sessions.snapshot and whenever the list changes. */
export interface WorktreesReportBody extends OpFields {
  t: 'worktrees.report';
  worktrees: WorktreeReport[];
  /** Each target with `migrations` configured: its newest migration number on the fresh base ref. Optional: older hosts. */
  heads?: MigrationHeadReport[];
}

export interface MigrationHeadReport {
  target: string;
  dir: string;
  ref: string;
  head: number | null;
}

export interface RunsSnapshotBody {
  t: 'runs.snapshot';
  part?: Part;
  runs: RunsSnapshotEntry[];
}

export type UpBody =
  | HelloBody
  | SessionReportBody
  | TurnBody
  | PromptBody
  | StatusBody
  | ExitBody
  | SessionsSnapshotBody
  | ContextRequestBody
  | CommandOutcomeBody
  | QuestionBody
  | QuestionResolvedBody
  | VerifyResultBody
  | WorktreesReportBody
  | AckBody
  | ByeBody;

export type UpFrame = Envelope & UpBody;

/** An inbound command (stage C kinds included only as an opaque shape). */
export interface CommandBody extends OpFields {
  t: string;
  expires_at?: number | string;
  [k: string]: unknown;
}

export type DownBody = WelcomeBody | AckBody | ByeBody | ContextResponseBody | RunsSnapshotBody | CommandBody;
export type DownFrame = Envelope & DownBody;

// ── Guards ─────────────────────────────────────────────────────────────────

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isStr = (v: unknown, max = 512): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Validate the envelope of anything received. Returns null for garbage. */
export function parseEnvelope(raw: unknown): (Envelope & Record<string, unknown>) | null {
  if (!isObj(raw)) return null;
  if (raw.v !== 1 || !isStr(raw.id, 200) || !isStr(raw.t, 64)) return null;
  if (raw.conn_epoch !== null && raw.conn_epoch !== undefined && !isNum(raw.conn_epoch)) return null;
  return raw as Envelope & Record<string, unknown>;
}

/** Parse one inbound frame. Unknown kinds that carry an op_id come back as commands. */
export function parseDownFrame(raw: unknown): DownFrame | null {
  const m = parseEnvelope(raw);
  if (!m) return null;
  switch (m.t) {
    case 'welcome':
      // A probe (`remotea eridani connect`) against an Eridani that has never seen this server_id
      // answers with host_id null: the host row is only created by a real hello.
      return (isStr(m.host_id, 200) || (m.host_id === null && m.probe === true)) && isNum(m.conn_epoch)
        ? (m as unknown as DownFrame) : null;
    case 'ack':
      return isStr(m.acked_id, 200) && typeof m.ok === 'boolean' ? (m as unknown as DownFrame) : null;
    case 'bye':
      return { ...(m as unknown as DownFrame), reason: typeof m.reason === 'string' ? m.reason.slice(0, ERIDANI_LIMITS.reasonChars) : '' } as DownFrame;
    case 'context.response':
      return isStr(m.req_id, 200) && typeof m.text === 'string' && m.text.length <= ERIDANI_LIMITS.contextChars
        && (m.run_token === undefined || isStr(m.run_token, 512)) ? (m as unknown as DownFrame) : null;
    case 'runs.snapshot':
      return Array.isArray(m.runs) && m.runs.every(isRunsEntry) ? (m as unknown as DownFrame) : null;
    default:
      return isStr(m.op_id, 200) ? (m as unknown as DownFrame) : null;
  }
}

/** Validate an upward frame (used by tests and the fake Eridani). */
export function parseUpFrame(raw: unknown): UpFrame | null {
  const m = parseEnvelope(raw);
  if (!m) return null;
  const op = isStr(m.op_id, 200) && isStr(m.digest, 128);
  switch (m.t) {
    case 'hello':
      return isStr(m.server_id) && isStr(m.boot_id) && isNum(m.proto) && Array.isArray(m.caps) && isObj(m.harnesses) ? (m as unknown as UpFrame) : null;
    case 'session.report':
      return op && isStr(m.entity) && isStr(m.tool, 40) && isStr(m.session_id, 200) && typeof m.parity === 'boolean' && isObj(m.report) ? (m as unknown as UpFrame) : null;
    case 'turn':
      return op && isStr(m.surf, 120) && isStr(m.provider_turn_id, 200) && isNum(m.seq) && typeof m.text === 'string'
        && m.text.length <= ERIDANI_LIMITS.turnTextChars && typeof m.truncated === 'boolean' ? (m as unknown as UpFrame) : null;
    case 'prompt':
      return op && isStr(m.surf, 120) && isStr(m.run_id, 200) && isNum(m.generation) && isNum(m.seq) && isNum(m.at)
        && typeof m.text === 'string' && m.text.length <= ERIDANI_LIMITS.promptChars && typeof m.truncated === 'boolean' ? (m as unknown as UpFrame) : null;
    case 'status':
      return op && isStr(m.surf, 120) && isNum(m.since) && isNum(m.revision)
        && ['working', 'needs_you', 'idle', 'exited'].includes(m.state as string) ? (m as unknown as UpFrame) : null;
    case 'exit':
      return op && isStr(m.surf, 120) && isNum(m.code) ? (m as unknown as UpFrame) : null;
    case 'sessions.snapshot':
      return op && isObj(m.part) && Array.isArray(m.surfaces) ? (m as unknown as UpFrame) : null;
    case 'ack':
      return isStr(m.acked_id, 200) && typeof m.ok === 'boolean' ? (m as unknown as UpFrame) : null;
    case 'context.request':
      return isStr(m.req_id, 200) && isStr(m.surf, 120) && isNum(m.incarnation) && isNum(m.generation) ? (m as unknown as UpFrame) : null;
    case 'command.outcome':
      return op && isStr(m.command_id, 200) && ['executed', 'failed', 'rejected', 'uncertain'].includes(m.state as string) ? (m as unknown as UpFrame) : null;
    case 'question':
      return op && isStr(m.question_id, 200) && isStr(m.surf, 120) && isNum(m.generation) && isStr(m.provider_request_id, 200)
        && isStr(m.group_id, 200) && Array.isArray(m.items) && m.items.length > 0 && (m.items as unknown[]).every(isQuestionItem) ? (m as unknown as UpFrame) : null;
    case 'question.resolved':
      return op && isStr(m.question_id, 200) && isNum(m.generation) && typeof m.still_open === 'boolean'
        && ['accepted', 'timed_out', 'failed', 'canceled', 'answered_locally'].includes(m.outcome as string) ? (m as unknown as UpFrame) : null;
    case 'verify.result':
      return op && isStr(m.attempt_id, 200) && isStr(m.run_id, 200) && isNum(m.generation) && isStr(m.workspace_fingerprint, 200)
        && (m.exit_code === null || isNum(m.exit_code)) && typeof m.tail === 'string' && m.tail.length <= ERIDANI_LIMITS.verifyTailChars
        && typeof m.timed_out === 'boolean' && (m.stale_workspace === undefined || typeof m.stale_workspace === 'boolean') ? (m as unknown as UpFrame) : null;
    case 'worktrees.report':
      return op && Array.isArray(m.worktrees) && (m.worktrees as unknown[]).every((w) => isObj(w) && isStr(w.target, 64) && isStr(w.path, 4096)
        && typeof w.candidate === 'boolean' && Array.isArray(w.reasons)) ? (m as unknown as UpFrame) : null;
    case 'bye':
      return m as unknown as UpFrame;
    default:
      return null;
  }
}

function isQuestionItem(v: unknown): boolean {
  if (!isObj(v) || !isStr(v.id, 64) || !isStr(v.text, ERIDANI_LIMITS.questionTextChars)) return false;
  if (v.choices !== undefined && !(Array.isArray(v.choices) && v.choices.every((c) => isObj(c) && isStr(c.id, 64) && isStr(c.label, 500)))) return false;
  return v.multi === undefined || typeof v.multi === 'boolean';
}

function isRunsEntry(v: unknown): boolean {
  return isObj(v) && isStr(v.run_id, 200) && isNum(v.generation) && ['continue', 'stop', 'none'].includes(v.desired as string)
    && (v.stop_mode === undefined || v.stop_mode === 'interrupt' || v.stop_mode === 'kill')
    && (v.verify === undefined || v.verify === null || isVerifyConfig(v.verify));
}

const VERIFY_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

export function isVerifyConfig(v: unknown): v is RunVerifyConfig {
  return isObj(v) && typeof v.verify_id === 'string' && VERIFY_ID_RE.test(v.verify_id) && isInt(v.plan_revision);
}

const RUN_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const ENV_KEY_RE = /^ERIDANI_[A-Z0-9_]{1,64}$/;
/** A model name: `opus`, `claude-opus-5-5`, `gpt-5.6-sol`, `sonnet[1m]`. Never a flag, never a newline. */
export const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]{0,79}$/;
/** A branch or base: git ref characters only, no leading dash, no `..`. */
export const BRANCH_RE = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*\.lock$)[A-Za-z0-9._/-]{1,200}$/;
const isInt = (v: unknown, min = 0): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min;
const isExpiry = (v: unknown) => v === undefined || isNum(v) || (typeof v === 'string' && !Number.isNaN(Date.parse(v)));
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const noControl = (s: string) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(s);
/**
 * Text typed into an agent's terminal (`input`): no C0 or C1 control
 * character except newline and tab. ESC, CSI (U+009B) and CR are what turn a
 * bracketed paste into keystrokes (M6, stage F).
 */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
export const isPasteSafe = (s: string) => !/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(s);

/** Effectful commands: each must carry `expires_at` within the replay horizon (L11, stage F). */
export const EFFECTFUL_COMMANDS: ReadonlySet<string> = new Set(['spawn', 'input', 'answer', 'stop', 'verify']);

/**
 * Validate a stage C command's body. Returns null when it is well formed,
 * else a short reason (sent back as a `rejected` outcome). Expiry, fences
 * and policy are checked later by the host; this is shape only.
 */
export function commandShapeError(m: Record<string, unknown>): string | null {
  if (!isExpiry(m.expires_at)) return 'bad expires_at';
  switch (m.t) {
    case 'spawn': {
      if (!isStr(m.run_id, 128) || !RUN_ID_RE.test(m.run_id)) return 'bad run_id';
      if (!isInt(m.generation) || !isInt(m.attempt, 1)) return 'bad generation/attempt';
      if (m.harness !== 'claude' && m.harness !== 'codex') return 'unsupported harness';
      if (!isStr(m.model, 80) || !MODEL_RE.test(m.model)) return 'bad model';
      const t = m.target;
      if (!isObj(t) || !isStr(t.id, 64) || !isStr(t.branch, 200) || !BRANCH_RE.test(t.branch)) return 'bad target';
      if (t.base !== undefined && !(isStr(t.base, 200) && BRANCH_RE.test(t.base))) return 'bad base';
      if (t.repo !== undefined && !isStr(t.repo, 1024)) return 'bad repo';
      if (typeof m.prompt !== 'string' || m.prompt.length > ERIDANI_LIMITS.promptInChars || m.prompt.includes('\u0000')) return 'bad prompt';
      if (m.title !== undefined && !(isStr(m.title, 200) && noControl(m.title) && !/[\r\n]/.test(m.title))) return 'bad title';
      if (m.group !== undefined && !(isStr(m.group, 100) && noControl(m.group) && !/[\r\n]/.test(m.group))) return 'bad group';
      if (m.task_id !== undefined && !(isStr(m.task_id, 128) && RUN_ID_RE.test(m.task_id))) return 'bad task_id';
      if (m.verify !== undefined && m.verify !== null && !isVerifyConfig(m.verify)) return 'bad verify';
      if (m.migration !== undefined && m.migration !== null) {
        const mg = m.migration;
        if (!isObj(mg) || !isInt(mg.number, 1) || !isStr(mg.dir, 200) || !noControl(mg.dir) || /[\r\n]/.test(mg.dir)) return 'bad migration';
      }
      if (m.run_token !== undefined && !(isStr(m.run_token, 512) && /^[\x21-\x7e]+$/.test(m.run_token))) return 'bad run_token';
      if (m.env !== undefined) {
        if (!isObj(m.env) || Object.keys(m.env).length > 32) return 'bad env';
        for (const [k, v] of Object.entries(m.env)) {
          if (!ENV_KEY_RE.test(k) || typeof v !== 'string' || v.length > 4096 || !noControl(v) || /[\r\n]/.test(v)) return `env ${k.slice(0, 40)} refused (ERIDANI_* only, one line)`;
        }
      }
      return null;
    }
    case 'input':
      if (!isStr(m.surf, 120) || !isInt(m.incarnation) || !isStr(m.run_id, 128) || !isInt(m.generation)) return 'bad fence';
      if (m.mode !== 'queue' && m.mode !== 'steer') return 'bad mode';
      if (typeof m.text !== 'string' || !m.text.trim() || m.text.length > ERIDANI_LIMITS.promptInChars) return 'bad text';
      if (!isPasteSafe(m.text)) return 'text may not contain control characters (only newline and tab)';
      // A leading `/` is a slash command and `!` is Claude Code's shell mode: input is a message, never either.
      if (/^[/!]/.test(m.text.trimStart())) return 'text may not start with "/" or "!"';
      return null;
    case 'answer':
      if (!isStr(m.question_id, 200) || !isStr(m.provider_request_id, 200)) return 'bad question';
      if (!Array.isArray(m.answers) || !m.answers.length || m.answers.length > 16) return 'bad answers';
      for (const a of m.answers as unknown[]) {
        if (!isObj(a) || !isStr(a.item_id, 64)) return 'bad answer item';
        if (a.choice_ids !== undefined && !(Array.isArray(a.choice_ids) && a.choice_ids.length <= 32 && a.choice_ids.every((c) => isStr(c, 64)))) return 'bad choice_ids';
        if (a.text !== undefined && !(typeof a.text === 'string' && a.text.length <= 4000)) return 'bad answer text';
        if (!a.choice_ids?.length && !(typeof a.text === 'string' && a.text.trim())) return 'empty answer';
      }
      return null;
    case 'stop':
      if (!isStr(m.surf, 120) || !isInt(m.incarnation) || !isStr(m.run_id, 128) || !isInt(m.generation)) return 'bad fence';
      return m.mode === 'interrupt' || m.mode === 'kill' ? null : 'bad mode';
    case 'verify':
      if (!isStr(m.attempt_id, 200) || !isStr(m.run_id, 128) || !isInt(m.generation)) return 'bad attempt';
      if (!isInt(m.turn_seq) || !isInt(m.plan_revision) || !isStr(m.verify_id, 64) || !/^[A-Za-z0-9._-]+$/.test(m.verify_id)) return 'bad verify';
      return null;
    case 'worktrees.scan':
      // Not effectful, but short-lived (2 min): a scan nobody waits for any more is refused.
      if (m.expires_at === undefined) return 'expires_at required';
      if (!isStr(m.run_id, 128) || !isInt(m.generation)) return 'bad fence';
      if (m.branch !== undefined && m.branch !== null && !isStr(m.branch, 200)) return 'bad branch';
      if (m.turn_seq !== undefined && m.turn_seq !== null && !isInt(m.turn_seq)) return 'bad turn_seq';
      if ((m.tool === undefined) !== (m.session_id === undefined)) return 'tool and session_id go together';
      if (m.tool !== undefined && !(typeof m.tool === 'string' && SESSION_TOOLS.has(m.tool))) return 'bad tool';
      if (m.session_id !== undefined && !(isStr(m.session_id, 200) && /^[A-Za-z0-9._:-]+$/.test(m.session_id))) return 'bad session_id';
      return null;
    default:
      return null; // a kind this module does not describe: its handler validates it
  }
}

// ── Digest input ───────────────────────────────────────────────────────────

const ENVELOPE_KEYS = new Set(['v', 'id', 'conn_epoch', 'at', 'op_id', 'digest']);

/** The part of a frame its digest covers: everything except envelope and identity fields. */
export function semanticPayload(frame: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(frame)) if (!ENVELOPE_KEYS.has(k) && v !== undefined) out[k] = v;
  return out;
}

/**
 * JSON with object keys sorted at every level and no whitespace. Python's
 * `json.dumps(x, sort_keys=True, separators=(",", ":"), ensure_ascii=False)`
 * produces the same bytes for the strings, integers, booleans and nulls these
 * frames carry.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).filter((k) => (value as Record<string, unknown>)[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(',')}}`;
}

// ── Sizes and chunking ─────────────────────────────────────────────────────

/** UTF-8 byte length without Buffer or TextEncoder (pure). */
export function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

/** Cut text to at most `max` characters (code points), saying whether anything was cut. */
export function truncateText(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  const points = Array.from(text);
  if (points.length <= max) return { text, truncated: false };
  return { text: points.slice(0, max).join(''), truncated: true };
}

/**
 * Split items into parts whose serialized size stays under `maxBytes` each
 * (`overhead` accounts for the rest of the frame). An item larger than the
 * budget travels alone; the caller bounds item size.
 */
export function chunkItems<T>(items: T[], maxBytes: number, overhead = 1024): T[][] {
  const parts: T[][] = [];
  let cur: T[] = [];
  let size = overhead;
  for (const item of items) {
    const n = utf8Length(JSON.stringify(item)) + 1;
    if (cur.length && size + n > maxBytes) {
      parts.push(cur);
      cur = [];
      size = overhead;
    }
    cur.push(item);
    size += n;
  }
  if (cur.length || !parts.length) parts.push(cur);
  return parts;
}

/** Reassemble chunked parts on the receiving side (the fake Eridani uses it). Null until all n parts are in. */
export function assembleParts<T>(parts: Array<{ part: Part; items: T[] }>): T[] | null {
  if (!parts.length) return null;
  const n = parts[0].part.n;
  const byIndex = new Map(parts.map((p) => [p.part.i, p.items]));
  if (byIndex.size !== n) return null;
  const out: T[] = [];
  for (let i = 1; i <= n; i++) {
    const items = byIndex.get(i);
    if (!items) return null;
    out.push(...items);
  }
  return out;
}
