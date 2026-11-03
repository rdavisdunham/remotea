/**
 * The Eridani link: one outbound WebSocket from this server to Eridani
 * (protocol: src/shared/eridani-link-protocol.ts; design:
 * docs/remotea/eridani-link.md).
 *
 *   connecting ─open→ hello ─welcome→ ready: sessions.snapshot, then the spool
 *        ↑                                 │ close / 25 s silent / bye
 *        └──── backoff (250 ms · 2ⁿ ≤ 15 s) ┘     401/403 → retry every 5 min
 *
 * The connection lifecycle is the app's own reducer (connection-fsm.ts), so
 * the edges behave like a remote host in the app. Everything upward goes
 * through the spool (eridani-spool.ts) and leaves it only on Eridani's ack;
 * every reconnect sends each unacked event once more, same op_id, new
 * envelope id. Inbound commands go through the journal (eridani-journal.ts).
 *
 * Headers: `Authorization: Bearer <link key>` and an explicit `User-Agent`
 * (Cloudflare refuses library default agents with error 1010). No Origin: a
 * server is not a browser, and Eridani refuses Origin on this endpoint.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import WebSocket from 'ws';
import type { HelloBody, HelloTarget } from '../../src/shared/eridani-link-protocol';
import {
  ERIDANI_LIMITS,
  ERIDANI_PROTO,
  ERIDANI_SUBPROTOCOL,
  ERIDANI_TIMING,
  STAGE_B_CAPS,
  canonicalJson,
  chunkItems,
  EFFECTFUL_COMMANDS,
  commandShapeError,
  parseDownFrame,
  semanticPayload,
  type AckBody,
  type CapabilityMatrix,
  type CommandBody,
  type CommandOutcomeState,
  type DownFrame,
  type LinkCap,
  type RunsSnapshotBody,
  type ExitBody,
  type DoctorSummary,
  type PromptBody,
  type SessionReportInput,
  type SessionTool,
  type SnapshotSurface,
  type StatusBody,
  type TurnBody,
} from '../../src/shared/eridani-link-protocol';
import { initialFsm, publicState, step, type Fsm, type FsmEvent } from '../../src/main/remote-hosts/connection-fsm';
import { Spool, type Lane, type SpoolEntry } from './eridani-spool';
import { FINAL_STATES, JOURNAL_UNAVAILABLE, Journal, JournalUnavailableError, type JournalRecord, type JournalState } from './eridani-journal';

export const OUTBOX_FILE = 'eridani-outbox.jsonl';
export const JOURNAL_FILE = 'eridani-journal.jsonl';
export const STATUS_FILE = 'eridani-status.json';

export interface LinkTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
}

const realTimers: LinkTimers = {
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  },
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
};

export interface LinkSocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string): void;
  ping(): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  on(event: 'open', cb: () => void): unknown;
  on(event: 'message', cb: (data: WebSocket.RawData, isBinary: boolean) => void): unknown;
  on(event: 'pong', cb: () => void): unknown;
  on(event: 'close', cb: (code: number, reason: Buffer) => void): unknown;
  on(event: 'error', cb: (err: Error) => void): unknown;
  on(event: 'unexpected-response', cb: (req: unknown, res: { statusCode?: number }) => void): unknown;
}

export type LinkSocketFactory = (url: string, headers: Record<string, string>) => LinkSocket;

const realSocket: LinkSocketFactory = (url, headers) =>
  new WebSocket(url, [ERIDANI_SUBPROTOCOL], {
    headers,
    perMessageDeflate: false,
    handshakeTimeout: ERIDANI_TIMING.handshakeMs,
    maxPayload: 1024 * 1024,
  }) as unknown as LinkSocket;

export interface CommandResult {
  state: 'executed' | 'failed' | 'rejected' | 'uncertain';
  detail?: string;
  /** Kind-specific facts, recorded in the journal and sent as `command.outcome.result`. */
  result?: Record<string, unknown>;
}

export interface CommandContext {
  /**
   * The effect is about to happen: journal `executing` (fsync). Until a
   * handler calls this the command is only `accepted`, and a restart re-runs
   * it (a queued input waits here until the agent is at its prompt).
   */
  begin(): void;
}

/** Executes one inbound command kind (stage C). Returns the outcome to record and report. */
export type CommandHandler = (cmd: CommandBody, ctx: CommandContext) => Promise<CommandResult>;

export interface LinkStatus {
  enabled: boolean;
  state: string;
  url: string;
  machine: string;
  hostId: string | null;
  connEpoch: number | null;
  attempt: number;
  error: string | null;
  lastConnectedAt: number | null;
  lastAckAt: number | null;
  unacked: number;
  spool: { entries: number; bytes: number; fill: number; evicted: number; degraded?: string | null };
  dirty: number;
  /**
   * Why the link is degraded, or null: the journal first
   * (`journal_unavailable (write failed: ENOSPC)`: commands are refused),
   * then the outbox (`spool-full`, `disk-full`, …: events are only in memory).
   */
  degraded: string | null;
  /** The inbound journal (task 9d3eda83). Optional: an older server's status file lacks it. */
  journal?: {
    /** Why commands cannot be recorded, or null. */
    degraded: string | null;
    /** Outcomes that happened but are not on disk yet (reported once they are). */
    unrecorded: number;
    /** Commands refused with `journal_unavailable` since the server started. */
    refused: number;
  };
  rejected: number;
  lastRejection: string | null;
  updatedAt: number;
  pid: number;
  /** What hello advertises now (S-S1, S-S5): build, protocol, caps, harnesses and targets with their readiness. */
  advertised?: Advertised;
  /** S-Q1 (optional): the latest doctor summary the server computed (what hello and `doctor` frames carry). */
  doctor?: DoctorSummary | null;
  /** S-Q1 (optional): the collector as the running server sees it. */
  collector?: CollectorLinkStatus | null;
  /** S-Q5 (optional): the server is draining for a restart (`remotea upgrade`): commands are held, not run. */
  draining?: { reason: string; since: number } | null;
}

/** The collector's last scan (for `remotea doctor`'s parity age). */
export interface CollectorLinkStatus {
  mode: string;
  /** When the last full scan finished, and what it did; null before the first. */
  lastScanAt: number | null;
  lastScan: { seen: number; queued: number; failed: number } | null;
  lastScanError: string | null;
  /** Why Codex threads are skipped (node:sqlite missing), or null. */
  codexUnavailable: string | null;
}

/** hello without the connection's identity fields. */
export type Advertised = Omit<HelloBody, 't' | 'server_id' | 'boot_id' | 'hostname' | 'machine'>;

/** What a hello says about the build: the same in the link's hello and in `remotea eridani connect`'s probe. */
export type HelloIdentity = Pick<Advertised, 'proto' | 'version' | 'build_sha' | 'build_dirty' | 'caps_version' | 'hook_version'>;

/**
 * The build identity a hello carries. `capsVersion` absent: not sent.
 * `hookVersion` absent: not sent; null is sent (no helper installed).
 */
export function helloIdentity(o: { version: string; build?: { sha: string; dirty: boolean | null }; capsVersion?: number; hookVersion?: string | null }): HelloIdentity {
  return {
    proto: ERIDANI_PROTO,
    version: o.version,
    build_sha: o.build?.sha ?? 'unknown',
    ...(typeof o.build?.dirty === 'boolean' ? { build_dirty: o.build.dirty } : {}),
    ...(o.capsVersion !== undefined ? { caps_version: o.capsVersion } : {}),
    ...(o.hookVersion !== undefined ? { hook_version: o.hookVersion } : {}),
  };
}

/** A doctor summary's findings without its time: two summaries with the same key say the same thing. */
export function doctorKey(s: DoctorSummary): string {
  return JSON.stringify([s.ok, s.warn, s.fail, s.truncated ?? false, s.items]);
}

export interface EridaniLinkDeps {
  url: string;
  token: () => string | null;
  /** Config dir for the outbox, journal and status file; null keeps everything in memory (tests). */
  dir: string | null;
  serverId: string;
  bootId: string;
  hostname: string;
  machine: string;
  version: string;
  /** The commit this server was built from (build-info.ts); "unknown" when absent. */
  build?: { sha: string; dirty: boolean | null };
  /** ERIDANI_CAPS_VERSION when `harnesses` and `targets` come from probes (eridani-runtime.ts); absent: not sent. */
  capsVersion?: number;
  /** The installed hook helper's version; absent: not sent. */
  hookVersion?: () => string | null;
  harnesses?: () => CapabilityMatrix;
  /** Every surface, for the reconcile snapshot sent after each welcome. */
  snapshot?: () => SnapshotSurface[];
  journalPending?: () => { pending: string[]; uncertain: string[] };
  /** Commands this release executes, by frame type. Stage B has none. */
  handlers?: Record<string, CommandHandler>;
  /**
   * Fence and policy check before a command is accepted (stale incarnation,
   * generation, unknown run, …). A reason rejects it; null accepts it.
   */
  precheck?: (cmd: CommandBody) => string | null;
  /** Settle a command found `executing` after a restart (see eridani-journal.ts). */
  recover?: (rec: JournalRecord) => { state: 'executed' | 'failed' | 'rejected' | 'uncertain'; detail?: string; outcome?: unknown } | null;
  /** Facts the ack of an accepted command carries (a spawn: its surf and incarnation). */
  acceptFacts?: (cmd: CommandBody) => Record<string, unknown>;
  /** Execution targets listed in hello (stage C). */
  targets?: () => HelloTarget[];
  modelCatalog?: () => import('../../src/shared/eridani-link-protocol').ModelCatalogEntry[];
  /** Capabilities advertised in hello (defaults to stage B's). */
  caps?: () => readonly LinkCap[];
  /** S-Q1: the latest doctor summary (doctor.ts), sent in hello when there is one; null: none yet. */
  doctor?: () => DoctorSummary | null;
  /** S-Q1: the collector's last scan, for the status file. */
  collectorStatus?: () => CollectorLinkStatus | null;
  /** Eridani's desired state per run, after each welcome. */
  onRunsSnapshot?: (runs: RunsSnapshotBody['runs']) => void;
  /** An event left the spool acknowledged (the collector advances its fingerprint here). */
  onDelivered?: (entry: SpoolEntry) => void;
  /** An event was evicted before delivery: its entity must be re-read. */
  onDirty?: (entity: string) => void;
  /** Eridani refused an event for good (no retry); it is out of the spool. */
  onRefused?: (entry: SpoolEntry) => void;
  onReady?: () => void;
  timers?: LinkTimers;
  now?: () => number;
  rand?: () => number;
  socket?: LinkSocketFactory;
  log?: (msg: string) => void;
  limits?: Partial<{ maxEntries: number; maxBytes: number; hardFactor: number; inflightMax: number; maxFrameBytes: number }>;
}

const OPEN = 1;
const MAX_BUFFERED = 1024 * 1024;
const RETRY_LATER_MS = 30_000;
/** While the journal cannot record, how often to try writing it again. */
export const JOURNAL_PROBE_MS = 30_000;

type FinalPatch = { digest: string; t: string; state: JournalState & CommandOutcomeState; detail?: string; outcome?: unknown };

export function digestOf(body: Record<string, unknown>): string {
  return crypto.createHash('sha256').update(canonicalJson(semanticPayload(body))).digest('hex');
}

function newId(): string {
  return crypto.randomUUID();
}

export class EridaniLink {
  private fsm: Fsm = initialFsm();
  private ws: LinkSocket | null = null;
  private retryTimer: unknown = null;
  private beatTimer: unknown = null;
  private handshakeTimer: unknown = null;
  private statusTimer: unknown = null;
  private lastInbound = 0;
  private readonly inflight = new Map<string, string>(); // envelope id -> op_id
  private readonly inflightOps = new Set<string>();
  /** Ops Eridani asked to resend later (ack ok:false retry:true): op_id -> not before. */
  private readonly held = new Map<string, number>();
  private heldTimer: unknown = null;
  readonly spool: Spool;
  readonly journal: Journal;
  private readonly timers: LinkTimers;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;
  private hostId: string | null = null;
  private connEpoch: number | null = null;
  /** What Eridani's welcome advertised (stage F: `context.scope`). */
  private peerCaps = new Set<string>();
  private lastConnectedAt: number | null = null;
  private lastAckAt: number | null = null;
  private rejected = 0;
  private lastRejection: string | null = null;
  private stopped = true;
  private readonly inflightMax: number;
  private readonly maxFrameBytes: number;
  /** Correlated requests (context.request) waiting for their response, by req_id. */
  private readonly waiting = new Map<string, { resolve: (f: Record<string, unknown> | null) => void; timer: unknown }>();
  /** runs.snapshot parts being assembled, by `part.of`. */
  private readonly runParts = new Map<string, Array<{ i: number; runs: RunsSnapshotBody['runs'] }>>();
  /** Commands running now, so a duplicate arriving mid-effect is not run twice. */
  private readonly running = new Set<string>();
  /**
   * Outcomes that happened while the journal could not record them, by op_id.
   * They are written (then reported) once it can; until then the journal
   * still says `accepted`/`executing`, which is what a restart or a
   * reconnect snapshot sees.
   */
  private readonly unrecorded = new Map<string, FinalPatch>();
  /** How many of `journal.settledOnLoad` were reported. */
  private settledReported = 0;
  private journalRefused = 0;
  private probeTimer: unknown = null;
  /** The doctor summary this connection's Eridani has (doctorKey): what hello carried, then each `doctor` frame. */
  private doctorSent: string | null = null;
  /** S-Q5: set while draining for a restart. */
  private draining: { reason: string; since: number } | null = null;
  private hostStateRev = 0;
  /** op_id → kind of every command that called begin() and has not settled. */
  private readonly begun = new Map<string, string>();
  /** What the hello on the current socket carried, until welcome makes it `doctorSent`. */
  private doctorInHello: string | null = null;
  private doctorRev = 0;

  constructor(private readonly deps: EridaniLinkDeps) {
    this.timers = deps.timers ?? realTimers;
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? (() => {});
    this.inflightMax = deps.limits?.inflightMax ?? ERIDANI_LIMITS.inflightMax;
    this.maxFrameBytes = deps.limits?.maxFrameBytes ?? ERIDANI_LIMITS.maxFrameBytes;
    this.spool = new Spool({
      file: deps.dir ? path.join(deps.dir, OUTBOX_FILE) : null,
      maxEntries: deps.limits?.maxEntries ?? ERIDANI_LIMITS.spoolMaxEntries,
      maxBytes: deps.limits?.maxBytes ?? ERIDANI_LIMITS.spoolMaxBytes,
      hardFactor: deps.limits?.hardFactor ?? ERIDANI_LIMITS.spoolHardFactor,
      onDirty: (entity) => deps.onDirty?.(entity),
      log: this.log,
      now: this.now,
    });
    this.journal = new Journal({
      file: deps.dir ? path.join(deps.dir, JOURNAL_FILE) : null,
      horizonMs: ERIDANI_LIMITS.replayHorizonMs,
      now: this.now,
      log: this.log,
      recover: deps.recover,
    });
    // What a restart settled (or left uncertain) is reported once, through the spool, once it is on disk.
    this.reportSettled();
    if (this.journal.degraded) this.scheduleProbe();
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  start(): void {
    this.stopped = false;
    this.dispatch({ type: 'start' });
    this.writeStatus();
  }

  /** Stop for good (disable, shutdown): says bye when connected. */
  stop(reason = 'shutdown'): void {
    this.stopped = true;
    if (this.fsm.state === 'ready' && this.ws) {
      // Close cleanly so the bye is flushed; terminate would drop it.
      this.sendFrame({ t: 'bye', reason });
      const ws = this.ws;
      this.ws = null;
      try {
        ws.close(1000, 'bye');
      } catch {
        /* gone */
      }
    }
    this.dispatch({ type: 'stop' });
    this.clearTimer('statusTimer');
    this.clearTimer('heldTimer');
    this.clearTimer('probeTimer');
    this.writeStatusNow();
    this.spool.close();
    this.journal.close();
  }

  get ready(): boolean {
    return this.fsm.state === 'ready';
  }

  /** Why the link is degraded (journal first, then outbox), or null. Sent in hello as `degraded_reason`. */
  degradedReason(): string | null {
    const j = this.journal.degraded;
    if (j) return `${JOURNAL_UNAVAILABLE} (${j})`;
    return this.spool.degraded;
  }

  status(): LinkStatus {
    return {
      enabled: !this.stopped,
      state: publicState(this.fsm.state),
      url: this.deps.url,
      machine: this.deps.machine,
      hostId: this.hostId,
      connEpoch: this.connEpoch,
      attempt: this.fsm.attempt,
      error: this.fsm.error ?? null,
      lastConnectedAt: this.lastConnectedAt,
      lastAckAt: this.lastAckAt,
      unacked: [...this.spool.pending()].filter((e) => !e.ephemeral).length,
      spool: { entries: this.spool.size, bytes: this.spool.bytes, fill: Math.round(this.spool.fill * 1000) / 1000, evicted: this.spool.evictedTotal, degraded: this.spool.degraded },
      dirty: this.spool.dirty.length,
      degraded: this.degradedReason(),
      journal: { degraded: this.journal.degraded, unrecorded: this.unrecorded.size, refused: this.journalRefused },
      rejected: this.rejected,
      lastRejection: this.lastRejection,
      updatedAt: this.now(),
      pid: process.pid,
      advertised: this.advertised(),
      ...(this.deps.doctor ? { doctor: this.deps.doctor() } : {}),
      ...(this.deps.collectorStatus ? { collector: this.deps.collectorStatus() } : {}),
      draining: this.draining,
    };
  }

  /** The hello fields that describe this host (also in the status file, so `remotea status` shows what Eridani was told). */
  advertised(): Advertised {
    return {
      ...helloIdentity({
        version: this.deps.version,
        build: this.deps.build,
        capsVersion: this.deps.capsVersion,
        ...(this.deps.hookVersion ? { hookVersion: this.deps.hookVersion() } : {}),
      }),
      caps: [...(this.deps.caps?.() ?? STAGE_B_CAPS)],
      harnesses: this.deps.harnesses?.() ?? {},
      ...(this.deps.modelCatalog ? { model_catalog: this.deps.modelCatalog() } : {}),
      ...(this.deps.targets ? { targets: this.deps.targets() } : {}),
    };
  }

  // ── Upward events ────────────────────────────────────────────────────────

  /**
   * A collector report. Returns false when it could not be queued (the source stays unrecorded).
   * The spool revision carries the mode, so an authoritative report is never
   * coalesced into a parity one of the same fingerprint still in the outbox
   * (that one would be compared, not stored). The wire revision is the fingerprint.
   */
  report(r: { entity: string; revision: string; tool: SessionTool; session_id: string; report: SessionReportInput }, parity: boolean): boolean {
    return this.enqueue({ t: 'session.report', entity: r.entity, revision: r.revision, parity, tool: r.tool, session_id: r.session_id, report: r.report }, 2, r.entity, `${parity ? 'parity' : 'store'}:${r.revision}`);
  }

  turn(t: Omit<TurnBody, 't' | 'op_id' | 'digest'>): boolean {
    return this.enqueue({ t: 'turn', ...t }, 1);
  }

  /**
   * A root prompt as it was submitted. Only for an Eridani whose welcome
   * advertised `prompt`: an older one learns the prompt from the turn, and a
   * frame it does not know would only be refused. Not spooled while
   * disconnected for the same reason (the turn carries the prompt anyway).
   */
  prompt(p: Omit<PromptBody, 't' | 'op_id' | 'digest'>): boolean {
    if (!this.peerHas('prompt')) return false;
    return this.enqueue({ t: 'prompt', ...p }, 1);
  }

  /**
   * S-Q1: the doctor summary changed (or was recomputed). hello carries the
   * latest one anyway; this sends a `doctor` frame only to an Eridani whose
   * welcome advertised `doctor` (an older one would refuse a frame it does not
   * know), and only when the findings differ from what this connection's
   * Eridani already has (`at` alone is no change). Ephemeral and coalesced:
   * only the newest matters, and the next hello carries it after a
   * disconnect. Returns true when a frame was queued.
   */
  /**
   * S-Q5 (`remotea upgrade`, docs/remotea/upgrade.md): drain for a restart,
   * or stop draining. While draining, commands are still journaled and
   * acked `accepted` but not run (the next server replays them after its
   * runs.snapshot), and hello says `draining: true`. An Eridani whose welcome
   * advertised `draining` is also told at once with an ephemeral
   * `host.state {draining, reason?}`; an older one is sent nothing new.
   */
  setDraining(on: boolean, reason = 'restart'): void {
    const was = this.draining !== null;
    this.draining = on ? this.draining ?? { reason, since: this.now() } : null;
    if (was === on) return;
    this.log(on ? `eridani: draining for a ${reason}; commands are held for the next server` : 'eridani: no longer draining');
    if (this.ready && this.peerHas('draining')) {
      this.enqueue({ t: 'host.state', draining: on, ...(on ? { reason } : {}) }, 0, 'host.state', ++this.hostStateRev, true);
    }
    this.writeStatus();
  }

  get isDraining(): boolean {
    return this.draining !== null;
  }

  /** Commands whose effect has begun (`executing`) and that have not settled: what a drain waits for. */
  begunOps(): Array<{ op_id: string; t: string }> {
    return [...this.begun].map(([op_id, t]) => ({ op_id, t }));
  }

  reportDoctor(summary: DoctorSummary | null): boolean {
    this.writeStatus(); // the status file shows the latest summary (deps.doctor)
    if (!summary || !this.ready || !this.peerHas('doctor')) return false;
    const key = doctorKey(summary);
    if (key === this.doctorSent) return false;
    if (!this.enqueue({ t: 'doctor', ...summary }, 2, 'doctor', ++this.doctorRev, true)) return false;
    this.doctorSent = key;
    return true;
  }

  agentStatus(s: Omit<StatusBody, 't' | 'op_id' | 'digest' | 'entity'>): boolean {
    const entity = `status:${s.surf}`;
    return this.enqueue({ t: 'status', entity, ...s }, 1, entity, s.revision);
  }

  exit(e: Omit<ExitBody, 't' | 'op_id' | 'digest'>): boolean {
    return this.enqueue({ t: 'exit', ...e }, 1);
  }

  /** Queue one event. The digest covers the semantic body, so it is the same on every resend. */
  enqueue(body: Record<string, unknown>, lane: Lane, entity?: string, revision?: string | number, ephemeral = false): boolean {
    const op_id = newId();
    const full = { ...body, op_id };
    const digest = digestOf(full);
    const res = this.spool.put({ op_id, lane, entity, revision, body: { ...full, digest }, ephemeral });
    if (!res.ok) {
      if (entity) this.deps.onDirty?.(entity);
      this.writeStatus();
      return false;
    }
    this.pump();
    this.writeStatus();
    return true;
  }

  // ── Connection ───────────────────────────────────────────────────────────

  private dispatch(ev: FsmEvent): void {
    const before = this.fsm.state;
    const { fsm, effects } = step(this.fsm, ev, this.deps.rand);
    this.fsm = fsm;
    for (const e of effects) {
      switch (e.type) {
        case 'connect': this.connect(); break;
        case 'disconnect': this.dropSocket(); break;
        case 'schedule-retry':
          this.clearTimer('retryTimer');
          this.retryTimer = this.timers.setTimeout(() => {
            this.retryTimer = null;
            this.dispatch({ type: 'retry' });
          }, e.ms);
          break;
        case 'cancel-retry': this.clearTimer('retryTimer'); break;
        case 'ready': this.onReady(); break;
        case 'down': this.onDown(); break;
      }
    }
    if (before !== this.fsm.state) {
      this.log(`eridani: ${before} -> ${this.fsm.state}${this.fsm.error ? ` (${this.fsm.error})` : ''}`);
      this.writeStatus();
    }
  }

  private clearTimer(name: 'retryTimer' | 'beatTimer' | 'handshakeTimer' | 'statusTimer' | 'heldTimer' | 'probeTimer'): void {
    if (this[name] !== null) this.timers.clearTimeout(this[name]);
    this[name] = null;
  }

  private dropSocket(): void {
    this.clearTimer('beatTimer');
    this.clearTimer('handshakeTimer');
    const ws = this.ws;
    this.ws = null;
    this.inflight.clear();
    this.inflightOps.clear();
    try {
      ws?.terminate();
    } catch {
      /* already gone */
    }
  }

  private connect(): void {
    this.dropSocket();
    const token = this.deps.token();
    if (!token) {
      this.dispatch({ type: 'auth-failed' });
      this.fsm = { ...this.fsm, error: 'No link key (run `remotea eridani connect`)' };
      return;
    }
    let ws: LinkSocket;
    try {
      ws = (this.deps.socket ?? realSocket)(this.deps.url, {
        Authorization: `Bearer ${token}`,
        'User-Agent': `remotea-server/${this.deps.version}`,
      });
    } catch (err) {
      this.timers.setTimeout(() => this.dispatch({ type: 'closed', error: (err as Error).message }), 0);
      return;
    }
    this.ws = ws;
    let refused = false;
    ws.on('open', () => {
      if (this.ws !== ws) return;
      this.lastInbound = this.now();
      this.dispatch({ type: 'opened' });
      const doctor = this.deps.doctor?.() ?? null;
      this.doctorInHello = doctor ? doctorKey(doctor) : null;
      this.sendFrame({
        t: 'hello',
        server_id: this.deps.serverId,
        boot_id: this.deps.bootId,
        hostname: this.deps.hostname,
        machine: this.deps.machine,
        ...this.advertised(),
        ...(this.degradedReason() ? { degraded_reason: this.degradedReason() } : {}),
        // S-Q5, additive: a restart is coming (`remotea upgrade`).
        ...(this.draining ? { draining: true } : {}),
        // Additive: an Eridani that does not know it ignores it (its hello model ignores extra fields).
        ...(doctor ? { doctor } : {}),
      });
      this.handshakeTimer = this.timers.setTimeout(() => {
        this.handshakeTimer = null;
        if (this.ws !== ws || this.fsm.state !== 'handshaking') return;
        this.log('eridani: no welcome; reconnecting');
        this.dropSocket();
        this.dispatch({ type: 'closed', error: 'Eridani did not answer hello' });
      }, ERIDANI_TIMING.handshakeMs);
      this.scheduleBeat(ws);
    });
    ws.on('unexpected-response', (_req, res) => {
      if (this.ws !== ws) return;
      refused = true;
      this.ws = null;
      try {
        ws.terminate();
      } catch {
        /* already gone */
      }
      if (res.statusCode === 401 || res.statusCode === 403) this.dispatch({ type: 'auth-failed' });
      else this.dispatch({ type: 'closed', error: `Eridani refused the connection (HTTP ${res.statusCode ?? '?'})` });
    });
    ws.on('message', (data, isBinary) => {
      if (this.ws !== ws) return;
      this.lastInbound = this.now();
      if (isBinary) return;
      let raw: unknown;
      try {
        raw = JSON.parse(String(data));
      } catch {
        return;
      }
      const frame = parseDownFrame(raw);
      if (frame) this.onFrame(frame);
    });
    ws.on('pong', () => {
      if (this.ws === ws) this.lastInbound = this.now();
    });
    ws.on('error', (err) => {
      if (this.ws !== ws || refused) return;
      this.log(`eridani: socket error ${err.message}`);
    });
    ws.on('close', (code, reason) => {
      if (this.ws !== ws || refused) return;
      this.ws = null;
      this.clearTimer('beatTimer');
      this.clearTimer('handshakeTimer');
      this.inflight.clear();
      this.inflightOps.clear();
      if (code === 4401 || code === 4403) {
        this.dispatch({ type: 'auth-failed' });
        return;
      }
      const why = String(reason ?? '');
      this.dispatch({ type: 'closed', error: this.fsm.state === 'connecting' ? 'Cannot reach Eridani' : why ? `closed ${code}: ${why.slice(0, 120)}` : undefined });
    });
  }

  /** WebSocket ping every 15 s; 25 s without any frame or pong is a dead link. */
  private scheduleBeat(ws: LinkSocket): void {
    this.clearTimer('beatTimer');
    this.beatTimer = this.timers.setTimeout(() => {
      this.beatTimer = null;
      if (this.ws !== ws) return;
      if (this.now() - this.lastInbound > ERIDANI_TIMING.deadMs) {
        this.log(`eridani: no traffic for ${ERIDANI_TIMING.deadMs} ms, reconnecting`);
        this.dropSocket();
        this.dispatch({ type: 'closed', error: 'Connection timed out' });
        return;
      }
      try {
        ws.ping();
      } catch {
        /* close follows */
      }
      this.scheduleBeat(ws);
    }, ERIDANI_TIMING.pingMs);
  }

  private onReady(): void {
    this.clearTimer('handshakeTimer');
    this.held.clear();
    this.lastConnectedAt = this.now();
    this.spool.dropEphemeral();
    // Eridani has what hello carried; a summary that changed during the handshake goes out now.
    this.doctorSent = this.doctorInHello;
    this.sendSnapshot();
    this.pump();
    this.deps.onReady?.();
    this.reportDoctor(this.deps.doctor?.() ?? null);
  }

  private onDown(): void {
    this.connEpoch = null;
    this.peerCaps.clear();
    this.doctorSent = null;
    this.spool.dropEphemeral();
    this.runParts.clear();
    for (const [id, w] of this.waiting) {
      this.timers.clearTimeout(w.timer);
      this.waiting.delete(id);
      w.resolve(null);
    }
  }

  /** Did the current connection's welcome advertise this capability? */
  peerHas(cap: string): boolean {
    return this.peerCaps.has(cap);
  }

  /**
   * Send one correlated request now (never spooled: it only means something
   * while the asker waits) and resolve with the matching response, or null
   * when the link is down or nothing came back within `ms`. A response that
   * arrives later is dropped.
   */
  request(body: Record<string, unknown> & { t: string; req_id: string }, ms: number): Promise<Record<string, unknown> | null> {
    if (!this.ready || this.waiting.has(body.req_id)) return Promise.resolve(null);
    return new Promise((resolve) => {
      const timer = this.timers.setTimeout(() => {
        this.waiting.delete(body.req_id);
        resolve(null);
      }, ms);
      this.waiting.set(body.req_id, { resolve, timer });
      if (!this.sendFrame(body)) {
        this.timers.clearTimeout(timer);
        this.waiting.delete(body.req_id);
        resolve(null);
      }
    });
  }

  /**
   * Re-run commands accepted before a restart and never started. Called once
   * the reconcile has settled (runs.snapshot applied), so their fences are
   * checked against the current state.
   */
  replayAccepted(): void {
    if (this.draining) return; // held for the next server
    for (const rec of this.journal.acceptedOps()) {
      if (this.running.has(rec.op_id) || this.unrecorded.has(rec.op_id)) continue;
      const cmd = { ...rec.body, op_id: rec.op_id, digest: rec.digest } as CommandBody;
      this.run(cmd, rec.digest, true).catch((err) => this.contain(rec.op_id, err));
    }
  }

  private sendSnapshot(): void {
    const surfaces = this.deps.snapshot?.() ?? [];
    const of = newId();
    const parts = chunkItems(surfaces, this.maxFrameBytes, 2048);
    const journal = this.journal.unsettled();
    parts.forEach((items, i) => {
      this.enqueue({ t: 'sessions.snapshot', part: { of, i: i + 1, n: parts.length }, surfaces: items, journal }, 0, undefined, undefined, true);
    });
  }

  // ── Frames ───────────────────────────────────────────────────────────────

  private sendFrame(body: Record<string, unknown>): string | null {
    const ws = this.ws;
    if (!ws || ws.readyState !== OPEN) return null;
    const id = newId();
    try {
      ws.send(JSON.stringify({ v: 1, id, conn_epoch: this.connEpoch, at: this.now(), ...body }));
    } catch {
      return null;
    }
    return id;
  }

  /** Send what the window allows: control first, then live, then bulk. */
  private pump(): void {
    if (this.fsm.state !== 'ready' || !this.ws) return;
    for (const e of this.spool.pending()) {
      if (this.inflightOps.size >= this.inflightMax || this.ws.bufferedAmount > MAX_BUFFERED) break;
      if (this.inflightOps.has(e.op_id)) continue;
      const until = this.held.get(e.op_id);
      if (until !== undefined) {
        if (until > this.now()) continue;
        this.held.delete(e.op_id);
      }
      const id = this.sendFrame(e.body);
      if (!id) break;
      this.inflight.set(id, e.op_id);
      this.inflightOps.add(e.op_id);
    }
  }

  private onFrame(f: DownFrame): void {
    if (f.t !== 'welcome') {
      // Until welcome nothing else counts, and after it only this connection's epoch does.
      if (this.connEpoch === null || f.conn_epoch !== this.connEpoch) return;
    }
    switch (f.t) {
      case 'welcome': {
        const w = f as DownFrame & { host_id: string; conn_epoch: number; caps?: unknown };
        this.hostId = w.host_id;
        this.connEpoch = w.conn_epoch;
        this.peerCaps = new Set(Array.isArray(w.caps) ? w.caps.filter((c): c is string => typeof c === 'string') : []);
        this.log(`eridani: welcome host ${w.host_id} epoch ${w.conn_epoch}`);
        this.dispatch({ type: 'welcome' });
        return;
      }
      case 'ack':
        return this.onAck(f as DownFrame & AckBody);
      case 'bye':
        this.log(`eridani: bye (${(f as { reason?: string }).reason || 'no reason'})`);
        return;
      case 'context.response': {
        const r = f as DownFrame & { req_id: string };
        const w = this.waiting.get(r.req_id);
        if (!w) return; // late or unknown: dropped
        this.waiting.delete(r.req_id);
        this.timers.clearTimeout(w.timer);
        w.resolve(r as unknown as Record<string, unknown>);
        return;
      }
      case 'runs.snapshot':
        return this.onRunsSnapshot(f as DownFrame & RunsSnapshotBody);
      default: {
        const cmd = f as DownFrame & CommandBody;
        // The asynchronous boundary: nothing a command does may become an unhandled rejection
        // in the process that owns every terminal.
        this.onCommand(cmd).catch((err) => this.contain(cmd.op_id, err));
      }
    }
  }

  private onAck(a: AckBody): void {
    const op = this.inflight.get(a.acked_id);
    if (!op) return; // a late ack from a superseded connection, or for a replaced entry
    this.inflight.delete(a.acked_id);
    this.inflightOps.delete(op);
    if (!a.ok && a.retry) {
      // Transient refusal: send it again in a while, not in a tight loop.
      this.held.set(op, this.now() + RETRY_LATER_MS);
      if (this.heldTimer === null) {
        this.heldTimer = this.timers.setTimeout(() => {
          this.heldTimer = null;
          this.pump();
        }, RETRY_LATER_MS);
      }
    } else {
      const entry = this.spool.ack(op);
      if (entry) {
        if (a.ok) {
          this.lastAckAt = this.now();
          this.deps.onDelivered?.(entry);
        } else {
          this.rejected++;
          this.lastRejection = `${entry.body.t}: ${String(a.error ?? 'refused').slice(0, ERIDANI_LIMITS.reasonChars)}`;
          // A refused report would be refused again unchanged; it goes again only when its source changes.
          this.log(`eridani: refused ${this.lastRejection}`);
          this.deps.onRefused?.(entry);
        }
      }
    }
    this.pump();
    this.writeStatus();
  }

  private onRunsSnapshot(f: RunsSnapshotBody): void {
    if (!f.part || f.part.n <= 1) {
      this.deps.onRunsSnapshot?.(f.runs);
      return;
    }
    const list = this.runParts.get(f.part.of) ?? [];
    if (!list.some((p) => p.i === f.part!.i)) list.push({ i: f.part.i, runs: f.runs });
    this.runParts.set(f.part.of, list);
    if (list.length < f.part.n) return;
    this.runParts.delete(f.part.of);
    this.deps.onRunsSnapshot?.(list.sort((a, b) => a.i - b.i).flatMap((p) => p.runs));
  }

  /**
   * An inbound operation (C01, F06):
   *   1. a repeat of a known op_id: same digest → its recorded state, never
   *      run again; different digest → refused;
   *   2. shape, expiry (and the replay horizon), and the host's fences and
   *      policy → `rejected`, journaled, reported;
   *   3. `accepted` is journaled and fsynced BEFORE the ack goes out;
   *   4. the handler marks `executing` when its effect starts; the outcome is
   *      journaled, then reported as `command.outcome`.
   *
   * When the journal cannot record (2) or (3), the command is refused with
   * `ack ok:false error:"journal_unavailable"`: nothing is journaled, nothing
   * runs, and no `command.outcome` follows (that would claim a recorded
   * state). Every record goes through the journal's own durable-first write,
   * so what a duplicate or a reconnect snapshot sees is only ever on disk.
   */
  private async onCommand(cmd: CommandBody & { id: string }): Promise<void> {
    // The digest is recomputed, never trusted: a body that does not match it is refused outright.
    const digest = digestOf(cmd as unknown as Record<string, unknown>);
    if (typeof cmd.digest === 'string' && cmd.digest && cmd.digest !== digest) {
      this.sendFrame({ t: 'ack', acked_id: cmd.id, op_id: cmd.op_id, ok: false, error: 'DIGEST_MISMATCH' });
      return;
    }
    const prior = this.journal.get(cmd.op_id);
    if (prior) {
      if (prior.digest !== digest) {
        this.sendFrame({ t: 'ack', acked_id: cmd.id, op_id: cmd.op_id, ok: false, error: 'DIGEST_MISMATCH' });
        return;
      }
      this.sendFrame({ t: 'ack', acked_id: cmd.id, op_id: cmd.op_id, ok: true, outcome: { state: prior.state, detail: prior.detail, result: prior.outcome } });
      if (FINAL_STATES.has(prior.state)) this.outcome(cmd.op_id, prior.state as CommandOutcomeState, prior.detail, prior.t, prior.outcome);
      return;
    }
    const reject = this.admit(cmd);
    if (reject) {
      if (!this.journalWrite(cmd.op_id, { digest, t: cmd.t, state: 'rejected', detail: reject, ...(cmd.expires_at === 0 && this.peerHas('commands.durable') ? { durable: true } : {}) })) return this.refuseUnjournaled(cmd);
      this.sendFrame({ t: 'ack', acked_id: cmd.id, op_id: cmd.op_id, ok: true, outcome: { state: 'rejected', detail: reject, ...(cmd.expires_at === 0 && this.peerHas('commands.durable') ? { durable: true } : {}) } });
      this.outcome(cmd.op_id, 'rejected', reject, cmd.t);
      return;
    }
    const body: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(cmd)) if (!['v', 'id', 'conn_epoch', 'at', 'op_id', 'digest'].includes(k)) body[k] = v;
    // Never ack an acceptance that is not on disk.
    if (!this.journalWrite(cmd.op_id, { digest, t: cmd.t, state: 'accepted', body, ...(cmd.expires_at === 0 ? { durable: true } : {}) })) return this.refuseUnjournaled(cmd);
    this.sendFrame({ t: 'ack', acked_id: cmd.id, op_id: cmd.op_id, ok: true, outcome: { state: 'accepted', ...this.acceptFacts(cmd) } });
    if (this.draining) {
      // S-Q5: accepted and on disk; the next server runs it (replayAccepted), with its fences checked then.
      this.log(`eridani: ${cmd.t} ${cmd.op_id} held for the restart`);
      return;
    }
    await this.run(cmd, digest, false);
  }

  /**
   * The journal could not record this command's first state: refuse it
   * without claiming anything was recorded. Eridani treats `ok:false` without
   * `retry` as a final refusal (its command becomes `rejected`, "refused by
   * the host: journal_unavailable"); the op_id is not remembered here, so a
   * resend is judged afresh.
   */
  private refuseUnjournaled(cmd: CommandBody & { id: string }): void {
    this.journalRefused++;
    this.log(`eridani: refused ${cmd.t} ${cmd.op_id}: ${JOURNAL_UNAVAILABLE} (${this.journal.degraded ?? 'unknown'})`);
    this.sendFrame({
      t: 'ack',
      acked_id: cmd.id,
      op_id: cmd.op_id,
      ok: false,
      error: JOURNAL_UNAVAILABLE,
      outcome: { state: 'rejected', detail: JOURNAL_UNAVAILABLE, durable: false },
    });
    this.writeStatus();
  }

  /** Record durably; false (journal degraded, a probe scheduled) when it could not be. */
  private journalWrite(op: string, patch: Parameters<Journal['record']>[1]): boolean {
    try {
      this.journal.record(op, patch);
    } catch (err) {
      this.journalDown(err);
      return false;
    }
    this.journalUp();
    return true;
  }

  private journalDown(err: unknown): void {
    if (!(err instanceof JournalUnavailableError)) this.log(`eridani: journal write failed unexpectedly: ${(err as Error)?.message ?? String(err)}`);
    this.scheduleProbe();
    this.writeStatus();
  }

  /** A write succeeded: record what waited for the journal (then report it), and stop probing. */
  private journalUp(): void {
    if (this.journal.degraded) return;
    if (this.probeTimer === null && this.unrecorded.size === 0 && this.settledReported === this.journal.settledOnLoad.length) return;
    this.clearTimer('probeTimer');
    for (const [op, patch] of [...this.unrecorded]) {
      try {
        this.journal.record(op, patch);
      } catch (err) {
        this.journalDown(err);
        return;
      }
      this.unrecorded.delete(op);
      this.outcome(op, patch.state, patch.detail, patch.t, patch.outcome);
    }
    this.reportSettled();
    this.writeStatus();
  }

  private scheduleProbe(): void {
    if (this.probeTimer !== null) return;
    this.probeTimer = this.timers.setTimeout(() => {
      this.probeTimer = null;
      try {
        if (this.journal.probe()) this.journalUp();
        else this.scheduleProbe();
      } catch (err) {
        this.log(`eridani: journal probe failed: ${(err as Error)?.message ?? String(err)}`);
        this.scheduleProbe();
      }
      this.writeStatus();
    }, JOURNAL_PROBE_MS);
  }

  /** Report what a restart settled, once the journal has it on disk. */
  private reportSettled(): void {
    const settled = this.journal.settledOnLoad;
    for (; this.settledReported < settled.length; this.settledReported++) {
      const r = settled[this.settledReported];
      this.outcome(r.op_id, r.state as CommandOutcomeState, r.detail, r.t, r.outcome);
    }
  }

  /** Last line of defence at an asynchronous boundary: log, never rethrow. */
  private contain(op: string, err: unknown): void {
    this.log(`eridani: command ${op} failed outside its handler: ${(err as Error)?.message ?? String(err)}`);
    this.writeStatus();
  }

  /** Why a command is refused before it is accepted, or null. */
  private admit(cmd: CommandBody): string | null {
    const handler = this.deps.handlers?.[cmd.t];
    if (!handler) return 'unsupported';
    const shape = commandShapeError(cmd as unknown as Record<string, unknown>);
    if (shape) return shape;
    if (cmd.t === 'run.cleanup' && cmd.scope === 'retired_planner' && !this.peerHas('run.cleanup.handoff')) return 'planner cleanup capability not negotiated';
    const expires = typeof cmd.expires_at === 'number' ? cmd.expires_at : typeof cmd.expires_at === 'string' ? Date.parse(cmd.expires_at) : NaN;
    const durable = expires === 0 && this.peerHas('commands.durable') && (cmd.t === 'run.cleanup' && this.peerHas('run.cleanup') || ['input', 'answer', 'run.pause', 'run.resume'].includes(cmd.t) || cmd.t === 'spawn' && cmd.execution === 'managed' && this.peerHas('managed.sessions'));
    if (Number.isFinite(expires) && !durable) {
      if (expires < this.now()) return 'expired';
      // An op must not outlive the memory of its id, or a late duplicate could run twice.
      if (expires > this.now() + ERIDANI_LIMITS.replayHorizonMs) return 'expires beyond the replay horizon';
    } else if (!durable && EFFECTFUL_COMMANDS.has(cmd.t)) return 'expires_at required';
    return this.deps.precheck?.(cmd) ?? null;
  }

  /** Facts the ack can carry at once (a spawn's surface id is known before it runs). */
  private acceptFacts(cmd: CommandBody): Record<string, unknown> {
    try {
      return this.deps.acceptFacts?.(cmd) ?? {};
    } catch {
      return {};
    }
  }

  private async run(cmd: CommandBody, digest: string, replay: boolean): Promise<void> {
    if (this.running.has(cmd.op_id) || this.unrecorded.has(cmd.op_id)) return;
    if (replay) {
      // Accepted before a restart: everything is checked again against what is true now.
      const reject = this.admit(cmd);
      if (reject) {
        this.settle(cmd.op_id, { digest, t: cmd.t, state: 'rejected', detail: reject, ...(cmd.expires_at === 0 && this.peerHas('commands.durable') ? { durable: true } : {}) });
        return;
      }
    }
    const handler = this.deps.handlers![cmd.t];
    this.running.add(cmd.op_id);
    let began = false;
    // Settles the run when `executing` cannot be recorded, even if the handler never returns.
    let abort: (r: CommandResult) => void = () => {};
    const aborted = new Promise<CommandResult>((resolve) => (abort = resolve));
    const ctx: CommandContext = {
      begin: () => {
        if (began) return;
        // The body stays with the record so a restart can reconcile it (recover).
        try {
          this.journal.record(cmd.op_id, { digest, t: cmd.t, state: 'executing', body: this.journal.get(cmd.op_id)?.body });
        } catch (err) {
          this.journalDown(err);
          const reason = err instanceof JournalUnavailableError ? err.reason : (err as Error)?.message ?? String(err);
          abort({ state: 'failed', detail: `${JOURNAL_UNAVAILABLE}: not started (${reason})`.slice(0, ERIDANI_LIMITS.reasonChars) });
          // Throwing stops the handler before its effect: no effect runs unjournaled.
          throw err instanceof JournalUnavailableError ? err : new JournalUnavailableError(String(reason));
        }
        began = true;
        this.begun.set(cmd.op_id, cmd.t);
        this.journalUp();
      },
    };
    let res: CommandResult;
    try {
      res = await Promise.race([handler(cmd, ctx), aborted]);
    } catch (err) {
      res = { state: 'failed', detail: ((err as Error)?.message ?? String(err)).slice(0, ERIDANI_LIMITS.reasonChars) };
    } finally {
      this.running.delete(cmd.op_id);
      this.begun.delete(cmd.op_id);
    }
    this.settle(cmd.op_id, { digest, t: cmd.t, state: res.state, detail: res.detail, outcome: res.result });
  }

  /**
   * Journal an outcome, then report it. When the journal cannot record it,
   * the outcome waits (in memory, never reported) until a write succeeds;
   * the journal keeps saying `accepted`/`executing`, which is what a restart
   * then settles from.
   */
  private settle(op: string, patch: FinalPatch): void {
    if (this.journalWrite(op, patch)) {
      this.outcome(op, patch.state, patch.detail, patch.t, patch.outcome);
      return;
    }
    this.unrecorded.set(op, patch);
    this.log(`eridani: outcome of ${op} (${patch.state}) waits for the journal`);
  }

  private outcome(commandId: string, state: CommandOutcomeState, detail?: string, kind?: string, result?: unknown): void {
    this.enqueue({
      t: 'command.outcome',
      command_id: commandId,
      state,
      ...(detail ? { detail: detail.slice(0, ERIDANI_LIMITS.reasonChars) } : {}),
      ...(kind ? { kind } : {}),
      ...(result && typeof result === 'object' ? { result } : {}),
    }, 0, `outcome:${commandId}`, state);
  }

  // ── Status file ──────────────────────────────────────────────────────────

  /** Coalesced to at most one write a second. */
  private writeStatus(): void {
    if (!this.deps.dir || this.statusTimer !== null) return;
    this.statusTimer = this.timers.setTimeout(() => {
      this.statusTimer = null;
      this.writeStatusNow();
    }, 1000);
  }

  writeStatusNow(): void {
    if (!this.deps.dir) return;
    const file = path.join(this.deps.dir, STATUS_FILE);
    const tmp = `${file}.tmp-${process.pid}`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(this.status(), null, 2) + '\n', { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (err) {
      this.log(`eridani: cannot write ${STATUS_FILE}: ${(err as Error).message}`);
    }
  }
}

/** Read the status a running server last wrote (for `remotea status` / `remotea eridani status`). */
export function readLinkStatus(dir: string): LinkStatus | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, STATUS_FILE), 'utf8')) as LinkStatus;
  } catch {
    return null;
  }
}
