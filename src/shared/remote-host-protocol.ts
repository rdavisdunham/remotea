/**
 * remotea remote-host wire protocol: app main <-> remote-server (WSL).
 *
 * One WebSocket per (app instance, host). Control messages are JSON text
 * frames; terminal bytes travel as binary frames so a busy agent's output is
 * not base64-inflated.
 *
 * Binary frame layout (big-endian):
 *   OUTPUT  [u8 kind=1][u8 idLen][id ascii][f64 seq][utf8 data]   server -> client
 *   INPUT   [u8 kind=2][u8 idLen][id ascii][utf8 data]            client -> server
 *
 * The session id rides in every frame instead of a per-connection channel
 * number: a reconnect then has no channel table that could drift out of sync.
 *
 * `seq` numbers every PTY chunk of a session within one server boot. A client
 * remembers the last seq it applied and passes it back as `open.sinceSeq`
 * with the server's `bootId`; when the server's ring still covers the gap it
 * replays just those chunks (mode 'delta'), otherwise it sends a serialized
 * screen + scrollback snapshot taken exactly at a known seq (mode 'snapshot').
 *
 * Pure: no Node or DOM imports — compiled into both the Electron main bundle
 * and the server.
 */

import { isTeaCommand, type TeaCommand, type TeaReply, type TeaState, type TeaInsight, type TeaMessage } from './tea';

export const PROTO = 1;

export type RemoteSurfaceId = `surf-${string}`;
export type GroupId = `grp-${string}`;
export type DeviceId = string;

export const SURFACE_ID_RE = /^surf-[A-Za-z0-9_-]{1,96}$/;
export const GROUP_ID_RE = /^grp-[A-Za-z0-9_-]{1,96}$/;
export const DEVICE_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
/** The fallback group for sessions whose own group is unknown or gone. */
export const INBOX_GROUP_ID: GroupId = 'grp-inbox';

export const LIMITS = Object.freeze({
  maxCommandLength: 4096,
  maxStartupCommands: 16,
  maxEnvEntries: 64,
  maxEnvValue: 8192,
  maxTitle: 200,
  maxName: 120,
  maxPath: 4096,
  maxIdsPerMessage: 512,
  maxCols: 1000,
  maxRows: 500,
  maxInputBytes: 1024 * 1024,
  maxDiagEvents: 200,
  /** One write-back from the code viewer (the WebSocket's own cap is 16 MiB). */
  maxFsWrite: 8 * 1024 * 1024,
  maxDiagFields: 16,
  maxDiagString: 300,
});

export const TIMING = Object.freeze({
  /** Client heartbeat interval. */
  pingMs: 10_000,
  /** No inbound frame for this long = the connection is dead (half-open after sleep). */
  deadMs: 25_000,
  backoffMinMs: 250,
  backoffMaxMs: 15_000,
});

// ── Records ────────────────────────────────────────────────────────────────

export type SessionState = 'live' | 'exited' | 'lost';
export type AgentProvider = 'claude' | 'codex' | 'opencode' | 'qwen' | 'agy' | 'omp';

export interface AgentHandle {
  provider: AgentProvider;
  sessionId: string;
  seenAt: number;
}

/**
 * The command that reopens an agent conversation (`claude --resume <id>`,
 * `codex resume <id>`), or null when the provider has none or the id is not
 * plain. Shared by the server (a lost session respawns with it, hub.ts) and
 * the desktop (Reopen in the recovery inventory starts the new tab with it).
 */
export function agentResumeCommand(agent: Pick<AgentHandle, 'provider' | 'sessionId'>): string | null {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(agent.sessionId)) return null;
  switch (agent.provider) {
    case 'claude': return `claude --resume ${agent.sessionId}`;
    case 'codex': return `codex resume ${agent.sessionId}`;
    default: return null;
  }
}

export interface GroupRecord {
  id: GroupId;
  name: string;
  color?: string;
  createdBy: DeviceId;
  createdAt: number;
  updatedAt: number;
}

export interface SessionRecord {
  id: RemoteSurfaceId;
  groupId: GroupId | null;
  title?: string;
  /** Last explicit rename or reset, including a reset to no custom title. */
  titleUpdatedAt?: number;
  /** Server-generated metadata is separate from the operator's title. */
  tea?: TeaInsight;
  teaSourceVersion?: string;
  /** Directory the session was created in. */
  cwd: string;
  /** Last foreground cwd the server observed. */
  lastCwd?: string;
  /** Command the session runs instead of a login shell, if any. */
  cmd?: string;
  createdBy: DeviceId;
  createdAt: number;
  /** Boot of the server that spawned the current process. */
  bootId: string;
  state: SessionState;
  exitCode?: number;
  exitedAt?: number;
  agent?: AgentHandle;
  /** Last PTY output or input, persisted at most every ~30 s. */
  lastActivityAt?: number;
  /** Devices that chose "Hide on this device" for this session. */
  hiddenBy: DeviceId[];
  /**
   * Bumped each time a lost session is respawned under the same id, so a
   * report about the old process can be told from one about the new one.
   * Absent = 0 (records written before it existed).
   */
  incarnation?: number;
  /** The agent's state as the server derives it from hooks and input (remote-server/src/agent-state.ts). */
  agentState?: AgentStateInfo;
  /** Agent turns captured in this session so far (turn-capture.ts). */
  turnSeq?: number;
  /** Durable attention and one local, server-scheduled reminder. */
  chatAttention?: ChatAttention;
  chatReminder?: ChatReminder | null;
  /** Where turn capture is in the current conversation (turn-capture.ts). */
  turnCursor?: TurnCursor;
  /** Set when Eridani started this session for a run (remote-server/src/dispatch.ts). */
  eridani?: EridaniBinding;
  /** Stage D: the latest verification attempt (remote-server/src/verify-attempts.ts). */
  verify?: VerifyAttemptStatus;
  /**
   * For a session with an Eridani binding: its worktree as the server last
   * inspected it (the same scan as worktrees.report, eridani-runtime.ts).
   * Additive and optional: older servers never set it, and a server without
   * a ready Eridani link does not scan. The desktop's recovery inventory
   * reads it to offer the worktree of a run that ended with unmerged work.
   */
  worktreeState?: WorktreeStateInfo;
}

/** A session's worktree, from the server's worktree scan (see SessionRecord.worktreeState). */
export interface WorktreeStateInfo {
  /** Tracked files changed and not committed. */
  uncommitted: number;
  untracked: number;
  /** Commits on the branch not on its base (null: unknown). */
  ahead: number | null;
  /** Merged into its base; null when unknown or the branch has no commits of its own. */
  merged: boolean | null;
  /** Commits not on its upstream (null: no upstream, or unknown). */
  unpushed: number | null;
  /** The ref ahead/merged were measured against. */
  baseRef: string;
  /** When the server inspected it, epoch ms. */
  at: number;
}

/**
 * An Eridani run executing in a session. No secrets: the run token and the
 * spawn's ERIDANI_* environment live in the server's own eridani-runs.json.
 */
/** S-Q3: dependency preparation (eridani.json `prepare`) before an agent started in a managed worktree. */
export interface PrepareFacts {
  /** The steps ran now (a new worktree, a failed or changed preparation); false: an earlier one in this worktree still holds. */
  ran: boolean;
  ok: boolean;
  /** Each step that ran, in order; the first failure is the last one. */
  steps: Array<{ id: string; exit_code: number | null; duration_ms: number; timed_out?: boolean; error?: string }>;
  /** Why it failed, one line (never argv or env). */
  reason?: string;
  /** The full output of every step, on the host (in the worktree's git folder). */
  log?: string;
  /** On failure only: the last characters the steps printed (≤ 2,000). */
  tail?: string;
}

export interface EridaniBinding {
  runId: string;
  /** The run generation this process currently serves (advanced by steer / runs.snapshot). */
  generation: number;
  attempt: number;
  taskId: string | null;
  /** The execution target id (eridani.json targets[]). */
  target: string;
  harness: 'claude' | 'codex';
  model: string;
  /** Managed runs expose a transcript until the owner explicitly takes over. */
  execution?: 'managed';
  effort?: string;
  permissionProfile?: 'read-only' | 'workspace-write';
  planRevision?: number;
  paused?: boolean;
  controller?: 'eridani' | 'terminal';
  attention?: import('./eridani-link-protocol').ManagedAttention;
  worktree: string;
  branch: string;
  base: string;
  /** The base commit the worktree was created from (null when it was reused). */
  baseSha: string | null;
  /** Freshness at spawn (optional: bindings recorded by older servers): the ref measured against, the fetch, the counts. */
  baseRef?: string | null;
  fetch?: { ok: boolean; error?: string } | null;
  behind?: number | null;
  ahead?: number | null;
  /** op_id of the spawn command. */
  spawnOp: string;
  /** A stop was accepted; cleared only by the process exiting. Never resumed while set. */
  stopRequested?: { at: number; mode: 'interrupt' | 'kill'; op: string | null };
  /** Stage D: verify after each root turn with this target verify id (from the spawn, a verify command or runs.snapshot). */
  verify?: { verifyId: string; planRevision: number };
  /**
   * Stage D (F07): the generation of the input Eridani typed (spawn prompt,
   * queued input, steer), persisted before it was typed. The next prompt the
   * agent accepts binds to it, then it is consumed.
   */
  acceptedInput?: { generation: number; at: number };
  /**
   * Whether the agent was launched with Eridani's MCP server (remote-server
   * eridani-mcp.ts), and why not. Optional: older bindings lack it. Never the key.
   */
  mcp?: { configured: boolean; reason?: string };
  /** S-Q3: the target's dependency preparation in this worktree at spawn, when the target declares one. */
  prepare?: PrepareFacts;
  /**
   * The Eridani web app this run belongs to (origin, no trailing slash), for
   * the desktop's "Open in Eridani": `<webUrl>/?view=remotea&run=<runId>`.
   * From eridani.json (`webUrl`, else derived from the link URL); bindings
   * recorded before it existed are filled in when the link is configured.
   * Optional: absent when the server cannot tell.
   */
  webUrl?: string;
  /** The task's title as the spawn carried it (`title`), when it carried one. */
  taskTitle?: string;
  /**
   * Hyperplan: the role the spawn named (`planner` when absent) and its
   * read-only mode (absent: writable). Kept on the record so a resume keeps
   * the same launch flags and a reviewer is still known as one after a restart.
   */
  role?: 'planner' | 'reviewer' | 'worker';
  mode?: 'plan' | 'review';
  /**
   * The spawn asked to continue an earlier Claude conversation
   * (`resume_session_id`, cap `spawn.resume`), and whether it did (false: its
   * transcript was not found for the worktree, or the harness is not Claude,
   * so the agent started fresh). Absent: an ordinary spawn.
   */
  resume?: { sessionId: string; resumed: boolean };
}

/** Stage D: the latest verification attempt on a surface (verify-attempts.ts). */
export interface VerifyAttemptStatus {
  attemptId: string;
  state: 'pending' | 'running' | 'passed' | 'failed' | 'timed_out' | 'canceled' | 'error' | 'interrupted';
  /** When the run began (null while pending). */
  startedAt: number | null;
  finishedAt?: number;
  runId: string;
  generation: number;
  turnSeq: number;
  planRevision: number;
  verifyId: string;
  initiator: 'host' | 'eridani';
  staleWorkspace?: boolean;
}

export type AgentStateName = 'working' | 'needs_you' | 'idle' | 'exited';

export interface AgentStateInfo {
  state: AgentStateName;
  /** When this state began, epoch ms. */
  since: number;
  reason?: string;
}

export interface TurnCursor {
  provider: string;
  sessionId: string;
  /** Turns opened (UserPromptSubmit) in this conversation on this surface. */
  opened: number;
  /** The turn number the last captured Stop belonged to. */
  captured: number;
  /** Recent provider turn ids already captured, newest last. */
  recent: string[];
  /** The run generation the open turn was bound to when its prompt was accepted (F07). */
  generation?: number;
  runId?: string | null;
}

export interface Tombstone {
  kind: 'session' | 'group';
  at: number;
  by: DeviceId;
  reason: 'closed' | 'group-closed';
}

/** What a client needs to respawn a session the server lost (restart). */
export interface LostInfo {
  cwd?: string;
  title?: string;
  cmd?: string;
  agent?: AgentHandle;
}

export type ProbeStatus = 'live' | 'exited' | 'lost' | 'closed' | 'unknown';

export interface CreateSpec {
  /** Command line to run through the login shell; omitted = interactive login shell. */
  cmd?: string;
  cwd?: string;
  env?: Record<string, string>;
  startupCommands?: string[];
  groupId?: GroupId | null;
  group?: { name: string; color?: string };
  title?: string;
}

export interface ChatAttention {
  revision: number;
  at: number;
  kind: 'finished' | 'needs_you' | 'unread' | 'reminder';
  /** Last revision acknowledged on each device. Viewing never answers an agent. */
  seenBy: Record<string, number>;
}

export interface ChatReminder {
  dueAt: number;
  createdBy: DeviceId;
  note?: string;
  firedAt?: number;
}

export type ChatAttentionAction =
  | { action: 'read'; revision: number }
  | { action: 'unread' }
  | { action: 'remind'; dueAt: number; note?: string }
  | { action: 'cancelReminder' };

export function isChatAttentionAction(raw: unknown): raw is ChatAttentionAction {
  if (!isObj(raw)) return false;
  switch (raw.action) {
    case 'read': return isInt(raw.revision, 1, Number.MAX_SAFE_INTEGER);
    case 'unread': case 'cancelReminder': return true;
    case 'remind': return isInt(raw.dueAt, 1, 8_640_000_000_000_000) && isOptStr(raw.note, 300);
    default: return false;
  }
}

// ── Messages ───────────────────────────────────────────────────────────────

export type ClientMsg =
  /** `features`: what this app understands beyond PROTO (absent from older apps; unknown names are ignored). */
  | { t: 'hello'; proto: number; device: { id: DeviceId; name: string }; app: { name: string; version: string }; features?: ClientFeature[] }
  | { t: 'open'; rid: number; id: RemoteSurfaceId; cols: number; rows: number; sinceSeq?: number; bootId?: string; create?: CreateSpec }
  | { t: 'detach'; ids: RemoteSurfaceId[] }
  | { t: 'close'; rid: number; id: RemoteSurfaceId }
  | { t: 'takeover'; rid: number; id: RemoteSurfaceId }
  | ({ t: 'chatAttention'; rid: number; id: RemoteSurfaceId } & ChatAttentionAction)
  | { t: 'resize'; id: RemoteSurfaceId; cols: number; rows: number }
  | { t: 'claim'; id: RemoteSurfaceId }
  | { t: 'deliver'; id: RemoteSurfaceId; commands: string[] }
  | { t: 'probe'; rid: number; ids: RemoteSurfaceId[]; groups?: GroupId[] }
  | { t: 'groupUpsert'; rid: number; group: { id: GroupId; name: string; color?: string } }
  | { t: 'groupClose'; rid: number; id: GroupId }
  | { t: 'sessionUpdate'; rid: number; id: RemoteSurfaceId; groupId?: GroupId | null; group?: { name: string; color?: string }; title?: string | null }
  | { t: 'hide'; rid: number; id: RemoteSurfaceId }
  | { t: 'unhide'; rid: number; id: RemoteSurfaceId }
  | { t: 'theme'; fg: string; bg: string; cursor: string }
  | { t: 'ping'; n: number }
  | { t: 'tea'; rid: number; command: TeaCommand }
  /** App diagnostics for the server's log (only when welcome lists 'diag'). No terminal content. */
  | { t: 'diag'; events: DiagEvent[] }
  /** Register remotea's status hooks with the server's agents (welcome lists 'hooks'). The user asked for it in the app. */
  | { t: 'hooksInstall'; rid: number }
  /** The explorer / code viewer on a remote pane, inside that session's folder (welcome lists 'fs'). */
  | { t: 'fs'; rid: number; id: RemoteSurfaceId; op: FsOp; path?: string; showHidden?: boolean; content?: string; expectedMtimeMs?: number };

/** File operations on a remote pane's folder (remote-server/src/remote-fs.ts). */
export type FsOp = 'root' | 'list' | 'readCode' | 'readMarkdown' | 'write' | 'diffStats';
const FS_OPS: ReadonlySet<string> = new Set<FsOp>(['root', 'list', 'readCode', 'readMarkdown', 'write', 'diffStats']);

/**
 * One diagnostic event from an app: what happened, never what was on screen
 * or typed. `data` values are short scalars; see parseClientMsg for the caps.
 */
export interface DiagEvent {
  at: number;
  src: 'main' | 'renderer';
  kind: string;
  surf?: string;
  data?: Record<string, string | number | boolean | null>;
}

/** Features a server announces in `welcome`; an app uses a feature only when listed. */
export type ServerFeature = 'rpc' | 'diag' | 'hooks' | 'fs' | 'focus' | 'managedSessions' | 'chatAttention' | 'tea';

/**
 * Features an app announces in `hello`. `focus`: it brings a session's tab to
 * the front on a server `focus` message (Eridani's `terminal.focus`). The
 * server sends `focus` only to apps that listed it.
 */
export type ClientFeature = 'focus';
const MAX_CLIENT_FEATURES = 16;

/** Whether an agent CLI on the server reports its status to remotea (see `remotea hooks`). */
export interface HookAgentStatus {
  agent: string;
  /** The agent is installed on the server (its config directory exists). */
  present: boolean;
  /** remotea's status hooks are registered with it. */
  installed: boolean;
}

/**
 * Agent-status RPCs the server relays from a session's hook bridge to the apps
 * showing it — the same methods an agent sends to the app's named pipe.
 * Anything else (workspace control, send-keys, browser automation) stays local.
 */
export const RELAYED_RPC_METHODS: ReadonlySet<string> = new Set([
  'hook.event',
  'agent.activity',
  'agent.subagent',
  'pane.report_agent',
  'pane.report_agent_session',
  'pane.release_agent',
  'pane.report_codex_session',
  'pane.release_codex_session',
  'pane.release_opencode_session',
  'pane.release_omp_session',
]);

export type OpenMode = 'fresh' | 'delta' | 'snapshot';

export type ServerMsg =
  | {
      t: 'welcome'; proto: number; serverId: string; bootId: string; epoch: string;
      hostname: string; you: DeviceId; groups: GroupRecord[]; sessions: SessionRecord[];
      features?: ServerFeature[];
      /** With feature 'hooks': which agents on the server report their status. */
      hooks?: HookAgentStatus[];
    }
  | {
      t: 'opened'; rid?: number; id: RemoteSurfaceId; mode: OpenMode; seq: number; fromSeq?: number;
      cols: number; rows: number; snapshot?: string; created: boolean; wasLost?: boolean;
      state: SessionState; exitCode?: number; owner: boolean;
    }
  | { t: 'openError'; rid: number; id: RemoteSurfaceId; code: 'closed' | 'lost' | 'bad-request' | 'spawn-failed' | 'hidden'; last?: LostInfo; by?: DeviceId; message: string }
  | { t: 'probed'; rid: number; status: Record<string, ProbeStatus>; last: Record<string, LostInfo>; groupStatus?: Record<string, 'live' | 'closed' | 'unknown'> }
  | { t: 'ack'; rid: number; ok: boolean; error?: string }
  | { t: 'exit'; id: RemoteSurfaceId; code: number; signal?: number }
  /** The terminal's size; `owner`: this device sets it. `ownerName`: the device that does, if any. */
  | { t: 'size'; id: RemoteSurfaceId; cols: number; rows: number; owner: boolean; ownerName?: string }
  | { t: 'meta'; id: RemoteSurfaceId; cwd?: string; fg?: string; agent?: AgentHandle | null; agentState?: AgentStateInfo }
  | { t: 'sessionAdded'; session: SessionRecord }
  | { t: 'sessionUpdated'; session: SessionRecord }
  | { t: 'sessionClosed'; id: RemoteSurfaceId; by: DeviceId; reason: 'closed' | 'group-closed' }
  | { t: 'groupUpserted'; group: GroupRecord }
  | { t: 'groupClosed'; id: GroupId; sessionIds: RemoteSurfaceId[]; by: DeviceId }
  /**
   * An agent in session `id` reported its status through the hook bridge.
   * `replay`: the latest state, re-sent when an app attaches — apply it, but
   * do not notify again for something that happened earlier.
   */
  | { t: 'rpc'; id: RemoteSurfaceId; method: string; params: Record<string, unknown>; replay?: boolean }
  /** The server's agents' hook state changed (an install from any device). */
  | { t: 'hooksStatus'; hooks: HookAgentStatus[] }
  /** The answer to an `fs` request: exactly what the app's local operation would have returned. */
  | { t: 'fsResult'; rid: number; result: unknown }
  | { t: 'teaResult'; rid: number; result: TeaReply }
  | { t: 'teaChanged'; state: TeaState }
  | { t: 'teaStream'; revision: number; message: TeaMessage }
  /**
   * Bring session `id`'s tab to the front (Eridani's "Open terminal in
   * remotea"). Sent only to apps whose hello listed the `focus` feature.
   */
  | { t: 'focus'; id: RemoteSurfaceId; runId?: string; highlight?: boolean }
  | { t: 'goingAway' }
  | { t: 'pong'; n: number; serverAt: number }
  | { t: 'error'; code: string; message: string };

// ── Binary frames ──────────────────────────────────────────────────────────

export const BIN_OUTPUT = 1;
export const BIN_INPUT = 2;

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder('utf-8');

function idBytes(id: string): Uint8Array {
  // Ids are validated ASCII (SURFACE_ID_RE), so one byte per char.
  const out = new Uint8Array(id.length);
  for (let i = 0; i < id.length; i++) out[i] = id.charCodeAt(i) & 0x7f;
  return out;
}

export function encodeOutput(id: string, seq: number, data: string): Uint8Array {
  const idb = idBytes(id);
  const payload = utf8Encoder.encode(data);
  const out = new Uint8Array(2 + idb.length + 8 + payload.length);
  const view = new DataView(out.buffer);
  out[0] = BIN_OUTPUT;
  out[1] = idb.length;
  out.set(idb, 2);
  view.setFloat64(2 + idb.length, seq);
  out.set(payload, 2 + idb.length + 8);
  return out;
}

export function encodeInput(id: string, data: string): Uint8Array {
  const idb = idBytes(id);
  const payload = utf8Encoder.encode(data);
  const out = new Uint8Array(2 + idb.length + payload.length);
  out[0] = BIN_INPUT;
  out[1] = idb.length;
  out.set(idb, 2);
  out.set(payload, 2 + idb.length);
  return out;
}

export interface DecodedFrame {
  kind: typeof BIN_OUTPUT | typeof BIN_INPUT;
  id: RemoteSurfaceId;
  seq?: number;
  data: string;
}

export function decodeFrame(buf: Uint8Array): DecodedFrame | null {
  if (buf.length < 2) return null;
  const kind = buf[0];
  if (kind !== BIN_OUTPUT && kind !== BIN_INPUT) return null;
  const idLen = buf[1];
  const headerLen = 2 + idLen + (kind === BIN_OUTPUT ? 8 : 0);
  if (buf.length < headerLen) return null;
  let id = '';
  for (let i = 0; i < idLen; i++) id += String.fromCharCode(buf[2 + i]);
  if (!SURFACE_ID_RE.test(id)) return null;
  let seq: number | undefined;
  if (kind === BIN_OUTPUT) {
    seq = new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getFloat64(2 + idLen);
    if (!Number.isFinite(seq)) return null;
  }
  const data = utf8Decoder.decode(buf.subarray(headerLen));
  return { kind, id: id as RemoteSurfaceId, seq, data };
}

// ── Guards ─────────────────────────────────────────────────────────────────

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;
const isInt = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
const isSurfaceId = (v: unknown): v is RemoteSurfaceId => typeof v === 'string' && SURFACE_ID_RE.test(v);
const isGroupId = (v: unknown): v is GroupId => typeof v === 'string' && GROUP_ID_RE.test(v);
const isRid = (v: unknown): v is number => isInt(v, 0, Number.MAX_SAFE_INTEGER);
const isOptStr = (v: unknown, max: number) => v === undefined || isStr(v, max);
const noNewline = (s: string) => !/[\r\n]/.test(s);
const isColor = (v: unknown) => v === undefined || (typeof v === 'string' && /^#?[0-9A-Za-z]{1,32}$/.test(v));
const isGroupMeta = (v: unknown): v is { name: string; color?: string } =>
  isObj(v) && isStr(v.name, LIMITS.maxName) && isColor(v.color);

function isSurfaceIdList(v: unknown): v is RemoteSurfaceId[] {
  return Array.isArray(v) && v.length <= LIMITS.maxIdsPerMessage && v.every(isSurfaceId);
}

function isCreateSpec(v: unknown): v is CreateSpec {
  if (!isObj(v)) return false;
  if (v.cmd !== undefined && !(isStr(v.cmd, LIMITS.maxCommandLength) && noNewline(v.cmd))) return false;
  if (!isOptStr(v.cwd, LIMITS.maxPath)) return false;
  if (!isOptStr(v.title, LIMITS.maxTitle)) return false;
  if (v.groupId !== undefined && v.groupId !== null && !isGroupId(v.groupId)) return false;
  if (v.group !== undefined && !isGroupMeta(v.group)) return false;
  if (v.startupCommands !== undefined) {
    if (!Array.isArray(v.startupCommands) || v.startupCommands.length > LIMITS.maxStartupCommands) return false;
    if (!v.startupCommands.every((c) => isStr(c, LIMITS.maxCommandLength) && noNewline(c))) return false;
  }
  if (v.env !== undefined) {
    if (!isObj(v.env)) return false;
    const entries = Object.entries(v.env);
    if (entries.length > LIMITS.maxEnvEntries) return false;
    for (const [k, val] of entries) {
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(k) || !isStr(val, LIMITS.maxEnvValue)) return false;
    }
  }
  return true;
}

/** Strict guard for everything a client may send. Unknown or malformed = null. */
function isDiagEvent(e: unknown): boolean {
  if (!isObj(e) || !isInt(e.at, 0, Number.MAX_SAFE_INTEGER) || (e.src !== 'main' && e.src !== 'renderer')) return false;
  if (!isStr(e.kind, 64) || (e.surf !== undefined && !isStr(e.surf, 128))) return false;
  if (e.data === undefined) return true;
  if (!isObj(e.data)) return false;
  const entries = Object.entries(e.data);
  return entries.length <= LIMITS.maxDiagFields && entries.every(([k, v]) => k.length <= 64
    && (v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))
      || (typeof v === 'string' && v.length <= LIMITS.maxDiagString)));
}

export function parseClientMsg(raw: unknown): ClientMsg | null {
  if (!isObj(raw) || typeof raw.t !== 'string') return null;
  const m = raw;
  switch (m.t) {
    case 'hello':
      return isInt(m.proto, 0, 1_000_000)
        && isObj(m.device) && typeof m.device.id === 'string' && DEVICE_ID_RE.test(m.device.id)
        && isStr(m.device.name, LIMITS.maxName)
        && isObj(m.app) && isStr(m.app.name, 64) && isStr(m.app.version, 64)
        && (m.features === undefined || (Array.isArray(m.features) && m.features.length <= MAX_CLIENT_FEATURES
          && m.features.every((f) => isStr(f, 32))))
        ? (m as unknown as ClientMsg) : null;
    case 'open':
      return isRid(m.rid) && isSurfaceId(m.id)
        && isInt(m.cols, 1, LIMITS.maxCols) && isInt(m.rows, 1, LIMITS.maxRows)
        && (m.sinceSeq === undefined || isInt(m.sinceSeq, 0, Number.MAX_SAFE_INTEGER))
        && isOptStr(m.bootId, 64)
        && (m.create === undefined || isCreateSpec(m.create))
        ? (m as unknown as ClientMsg) : null;
    case 'detach':
      return isSurfaceIdList(m.ids) ? (m as unknown as ClientMsg) : null;
    case 'close':
    case 'takeover':
    case 'hide':
    case 'unhide':
      return isRid(m.rid) && isSurfaceId(m.id) ? (m as unknown as ClientMsg) : null;
    case 'chatAttention':
      return isRid(m.rid) && isSurfaceId(m.id) && isChatAttentionAction(m) ? (m as unknown as ClientMsg) : null;
    case 'resize':
      return isSurfaceId(m.id) && isInt(m.cols, 1, LIMITS.maxCols) && isInt(m.rows, 1, LIMITS.maxRows)
        ? (m as unknown as ClientMsg) : null;
    case 'claim':
      return isSurfaceId(m.id) ? (m as unknown as ClientMsg) : null;
    case 'deliver':
      return isSurfaceId(m.id) && Array.isArray(m.commands) && m.commands.length <= LIMITS.maxStartupCommands
        && m.commands.every((c) => isStr(c, LIMITS.maxCommandLength) && noNewline(c))
        ? (m as unknown as ClientMsg) : null;
    case 'probe':
      return isRid(m.rid) && isSurfaceIdList(m.ids)
        && (m.groups === undefined || (Array.isArray(m.groups) && m.groups.length <= LIMITS.maxIdsPerMessage && m.groups.every(isGroupId)))
        ? (m as unknown as ClientMsg) : null;
    case 'groupUpsert':
      return isRid(m.rid) && isObj(m.group) && isGroupId(m.group.id) && isGroupMeta(m.group)
        ? (m as unknown as ClientMsg) : null;
    case 'groupClose':
      return isRid(m.rid) && isGroupId(m.id) ? (m as unknown as ClientMsg) : null;
    case 'sessionUpdate':
      return isRid(m.rid) && isSurfaceId(m.id)
        && (m.groupId === undefined || m.groupId === null || isGroupId(m.groupId))
        && (m.group === undefined || isGroupMeta(m.group))
        && (m.title === undefined || m.title === null || isStr(m.title, LIMITS.maxTitle))
        ? (m as unknown as ClientMsg) : null;
    case 'theme':
      return isStr(m.fg, 64) && isStr(m.bg, 64) && isStr(m.cursor, 64) ? (m as unknown as ClientMsg) : null;
    case 'ping':
      return isInt(m.n, 0, Number.MAX_SAFE_INTEGER) ? (m as unknown as ClientMsg) : null;
    case 'diag':
      return Array.isArray(m.events) && m.events.length <= LIMITS.maxDiagEvents && m.events.every(isDiagEvent)
        ? (m as unknown as ClientMsg) : null;
    case 'tea':
      return isRid(m.rid) && isTeaCommand(m.command) ? (m as unknown as ClientMsg) : null;
    case 'hooksInstall':
      return isRid(m.rid) ? (m as unknown as ClientMsg) : null;
    case 'fs':
      return isRid(m.rid) && isSurfaceId(m.id) && typeof m.op === 'string' && FS_OPS.has(m.op)
        && (m.path === undefined || isStr(m.path, LIMITS.maxPath))
        && (m.showHidden === undefined || typeof m.showHidden === 'boolean')
        && (m.content === undefined || isStr(m.content, LIMITS.maxFsWrite))
        && (m.expectedMtimeMs === undefined || (typeof m.expectedMtimeMs === 'number' && Number.isFinite(m.expectedMtimeMs)))
        ? (m as unknown as ClientMsg) : null;
    default:
      return null;
  }
}

const SERVER_TYPES = new Set([
  'welcome', 'opened', 'openError', 'probed', 'ack', 'exit', 'size', 'meta',
  'sessionAdded', 'sessionUpdated', 'sessionClosed', 'groupUpserted', 'groupClosed',
  'goingAway', 'pong', 'error', 'rpc', 'hooksStatus', 'fsResult', 'focus', 'teaResult', 'teaChanged', 'teaStream',
]);

/**
 * Light guard for server messages. The server is authenticated and pinned by
 * serverId, so this checks the shape the client dispatches on, not every field.
 */
export function parseServerMsg(raw: unknown): ServerMsg | null {
  if (!isObj(raw) || typeof raw.t !== 'string' || !SERVER_TYPES.has(raw.t)) return null;
  const m = raw;
  switch (m.t) {
    case 'teaStream':
      return isInt(m.revision, 0, Number.MAX_SAFE_INTEGER) && isObj(m.message) && typeof m.message.id === 'string' && /^[A-Za-z0-9_-]{8,96}$/.test(m.message.id) && m.message.role === 'assistant' && typeof m.message.text === 'string' && m.message.text.length <= 12000 && isInt(m.message.at, 0, Number.MAX_SAFE_INTEGER) && m.message.delivery === 'streaming' ? (m as unknown as ServerMsg) : null;
    case 'teaChanged':
      return isObj(m.state) && typeof m.state.revision === 'number' && isObj(m.state.config) && Array.isArray(m.state.messages) && Array.isArray(m.state.turns) ? (m as unknown as ServerMsg) : null;
    case 'teaResult':
      return isRid(m.rid) && isObj(m.result) && typeof m.result.ok === 'boolean' ? (m as unknown as ServerMsg) : null;
    case 'welcome':
      return isInt(m.proto, 0, 1_000_000) && typeof m.bootId === 'string' && typeof m.serverId === 'string'
        && Array.isArray(m.sessions) && Array.isArray(m.groups) ? (m as unknown as ServerMsg) : null;
    case 'opened':
      return isSurfaceId(m.id) && typeof m.mode === 'string' && typeof m.seq === 'number' ? (m as unknown as ServerMsg) : null;
    case 'openError':
    case 'exit':
    case 'size':
    case 'meta':
    case 'sessionClosed':
      return isSurfaceId(m.id) ? (m as unknown as ServerMsg) : null;
    case 'focus':
      return isSurfaceId(m.id) && (m.runId === undefined || isStr(m.runId, 128)) &&
        (m.highlight === undefined || typeof m.highlight === 'boolean') ? (m as unknown as ServerMsg) : null;
    case 'sessionAdded':
    case 'sessionUpdated':
      return isObj(m.session) && isSurfaceId(m.session.id) ? (m as unknown as ServerMsg) : null;
    case 'groupUpserted':
      return isObj(m.group) && isGroupId(m.group.id) ? (m as unknown as ServerMsg) : null;
    case 'groupClosed':
      return isGroupId(m.id) && isSurfaceIdList(m.sessionIds) ? (m as unknown as ServerMsg) : null;
    case 'rpc':
      return isSurfaceId(m.id) && typeof m.method === 'string' && RELAYED_RPC_METHODS.has(m.method) && isObj(m.params)
        ? (m as unknown as ServerMsg) : null;
    default:
      return m as unknown as ServerMsg;
  }
}
