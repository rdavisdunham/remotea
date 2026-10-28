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
 * its transport id. Stage B uses: hello/welcome/bye, ack, and the upward
 * events session.report, turn, status, exit, sessions.snapshot. The
 * context.request/response types are declared for stage C and not sent.
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
});

export const ERIDANI_TIMING = Object.freeze({
  /** WebSocket-level ping; any inbound frame or pong counts as life. */
  pingMs: 15_000,
  deadMs: 25_000,
  handshakeMs: 10_000,
  /** How long `remotea eridani connect` waits for welcome. */
  probeMs: 10_000,
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
  // Stage C and later; never advertised by this release.
  | 'question'
  | 'context'
  | 'spawn'
  | 'input'
  | 'answer'
  | 'stop'
  | 'verify';

export const STAGE_B_CAPS: readonly LinkCap[] = Object.freeze([
  'session.report', 'session.report.parity', 'turn', 'status', 'exit', 'sessions.snapshot', 'chunking', 'journal',
]);

/** What one harness can do on this host (the capability matrix, C15). Advertise only what is verified. */
export interface HarnessCaps {
  /** `claude --version` / `codex --version`, or null when not installed. */
  version: string | null;
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
  caps: LinkCap[];
  harnesses: CapabilityMatrix;
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
  /** When the Stop hook fired, epoch ms. */
  ended_at: number;
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
  /** Stage C: run bindings, open questions. Always empty in B. */
  run_id: string | null;
  generation: number;
}

export interface SessionsSnapshotBody extends OpFields {
  t: 'sessions.snapshot';
  part: Part;
  surfaces: SnapshotSurface[];
  /** Inbound journal entries that are not settled (stage C has real ones). */
  journal: { pending: string[]; uncertain: string[] };
}

export interface ContextRequestBody {
  t: 'context.request';
  req_id: string;
  surf: string;
  incarnation: number;
  provider_session_id: string;
}

export interface CommandOutcomeBody extends OpFields {
  t: 'command.outcome';
  /** The op_id of the command this reports on. */
  command_id: string;
  state: 'executed' | 'failed' | 'rejected' | 'uncertain';
  detail?: string;
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
  host_id: string;
  conn_epoch: number;
  server_time: number | string;
  /** Seconds Eridani remembers op ids for. */
  replay_horizon?: number;
  caps?: string[];
}

export interface ContextResponseBody {
  t: 'context.response';
  req_id: string;
  text: string;
}

export type UpBody =
  | HelloBody
  | SessionReportBody
  | TurnBody
  | StatusBody
  | ExitBody
  | SessionsSnapshotBody
  | ContextRequestBody
  | CommandOutcomeBody
  | AckBody
  | ByeBody;

export type UpFrame = Envelope & UpBody;

/** An inbound command (stage C kinds included only as an opaque shape). */
export interface CommandBody extends OpFields {
  t: string;
  expires_at?: number | string;
  [k: string]: unknown;
}

export type DownBody = WelcomeBody | AckBody | ByeBody | ContextResponseBody | CommandBody;
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
      return isStr(m.host_id, 200) && isNum(m.conn_epoch) ? (m as unknown as DownFrame) : null;
    case 'ack':
      return isStr(m.acked_id, 200) && typeof m.ok === 'boolean' ? (m as unknown as DownFrame) : null;
    case 'bye':
      return { ...(m as unknown as DownFrame), reason: typeof m.reason === 'string' ? m.reason.slice(0, ERIDANI_LIMITS.reasonChars) : '' } as DownFrame;
    case 'context.response':
      return isStr(m.req_id, 200) && typeof m.text === 'string' ? (m as unknown as DownFrame) : null;
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
    case 'status':
      return op && isStr(m.surf, 120) && isNum(m.since) && isNum(m.revision)
        && ['working', 'needs_you', 'idle', 'exited'].includes(m.state as string) ? (m as unknown as UpFrame) : null;
    case 'exit':
      return op && isStr(m.surf, 120) && isNum(m.code) ? (m as unknown as UpFrame) : null;
    case 'sessions.snapshot':
      return op && isObj(m.part) && Array.isArray(m.surfaces) ? (m as unknown as UpFrame) : null;
    case 'ack':
      return isStr(m.acked_id, 200) && typeof m.ok === 'boolean' ? (m as unknown as UpFrame) : null;
    case 'bye':
    case 'context.request':
    case 'command.outcome':
      return m as unknown as UpFrame;
    default:
      return null;
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
