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
import type { HelloTarget } from '../../src/shared/eridani-link-protocol';
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
  type SessionReportInput,
  type SessionTool,
  type SnapshotSurface,
  type StatusBody,
  type TurnBody,
} from '../../src/shared/eridani-link-protocol';
import { initialFsm, publicState, step, type Fsm, type FsmEvent } from '../../src/main/remote-hosts/connection-fsm';
import { Spool, type Lane, type SpoolEntry } from './eridani-spool';
import { FINAL_STATES, Journal, type JournalRecord } from './eridani-journal';

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
  state: 'executed' | 'failed' | 'rejected';
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
  spool: { entries: number; bytes: number; fill: number; evicted: number };
  dirty: number;
  degraded: string | null;
  rejected: number;
  lastRejection: string | null;
  updatedAt: number;
  pid: number;
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
  recover?: (rec: JournalRecord) => { state: 'executed' | 'failed' | 'rejected'; detail?: string; outcome?: unknown } | null;
  /** Facts the ack of an accepted command carries (a spawn: its surf and incarnation). */
  acceptFacts?: (cmd: CommandBody) => Record<string, unknown>;
  /** Execution targets listed in hello (stage C). */
  targets?: () => HelloTarget[];
  /** Capabilities advertised in hello (defaults to stage B's). */
  caps?: () => readonly LinkCap[];
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
    // What a restart settled (or left uncertain) is reported once, through the spool.
    for (const r of this.journal.settledOnLoad) this.outcome(r.op_id, r.state as CommandOutcomeState, r.detail, r.t, r.outcome);
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
    this.writeStatusNow();
    this.spool.close();
    this.journal.close();
  }

  get ready(): boolean {
    return this.fsm.state === 'ready';
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
      spool: { entries: this.spool.size, bytes: this.spool.bytes, fill: Math.round(this.spool.fill * 1000) / 1000, evicted: this.spool.evictedTotal },
      dirty: this.spool.dirty.length,
      degraded: this.spool.degraded,
      rejected: this.rejected,
      lastRejection: this.lastRejection,
      updatedAt: this.now(),
      pid: process.pid,
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

  private clearTimer(name: 'retryTimer' | 'beatTimer' | 'handshakeTimer' | 'statusTimer' | 'heldTimer'): void {
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
      this.sendFrame({
        t: 'hello',
        server_id: this.deps.serverId,
        boot_id: this.deps.bootId,
        hostname: this.deps.hostname,
        machine: this.deps.machine,
        proto: ERIDANI_PROTO,
        version: this.deps.version,
        caps: [...(this.deps.caps?.() ?? STAGE_B_CAPS)],
        harnesses: this.deps.harnesses?.() ?? {},
        ...(this.deps.targets ? { targets: this.deps.targets() } : {}),
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
    this.sendSnapshot();
    this.pump();
    this.deps.onReady?.();
  }

  private onDown(): void {
    this.connEpoch = null;
    this.peerCaps.clear();
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
    for (const rec of this.journal.acceptedOps()) {
      if (this.running.has(rec.op_id)) continue;
      const cmd = { ...rec.body, op_id: rec.op_id, digest: rec.digest } as CommandBody;
      void this.run(cmd, rec.digest, true);
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
      default:
        void this.onCommand(f as DownFrame & CommandBody);
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
      this.journal.record(cmd.op_id, { digest, t: cmd.t, state: 'rejected', detail: reject });
      this.sendFrame({ t: 'ack', acked_id: cmd.id, op_id: cmd.op_id, ok: true, outcome: { state: 'rejected', detail: reject } });
      this.outcome(cmd.op_id, 'rejected', reject, cmd.t);
      return;
    }
    const body: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(cmd)) if (!['v', 'id', 'conn_epoch', 'at', 'op_id', 'digest'].includes(k)) body[k] = v;
    this.journal.record(cmd.op_id, { digest, t: cmd.t, state: 'accepted', body });
    this.sendFrame({ t: 'ack', acked_id: cmd.id, op_id: cmd.op_id, ok: true, outcome: { state: 'accepted', ...this.acceptFacts(cmd) } });
    await this.run(cmd, digest, false);
  }

  /** Why a command is refused before it is accepted, or null. */
  private admit(cmd: CommandBody): string | null {
    const handler = this.deps.handlers?.[cmd.t];
    if (!handler) return 'unsupported';
    const shape = commandShapeError(cmd as unknown as Record<string, unknown>);
    if (shape) return shape;
    const expires = typeof cmd.expires_at === 'number' ? cmd.expires_at : typeof cmd.expires_at === 'string' ? Date.parse(cmd.expires_at) : NaN;
    if (Number.isFinite(expires)) {
      if (expires < this.now()) return 'expired';
      // An op must not outlive the memory of its id, or a late duplicate could run twice.
      if (expires > this.now() + ERIDANI_LIMITS.replayHorizonMs) return 'expires beyond the replay horizon';
    } else if (EFFECTFUL_COMMANDS.has(cmd.t)) return 'expires_at required';
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
    if (this.running.has(cmd.op_id)) return;
    if (replay) {
      // Accepted before a restart: everything is checked again against what is true now.
      const reject = this.admit(cmd);
      if (reject) {
        this.journal.record(cmd.op_id, { digest, t: cmd.t, state: 'rejected', detail: reject });
        this.outcome(cmd.op_id, 'rejected', reject, cmd.t);
        return;
      }
    }
    const handler = this.deps.handlers![cmd.t];
    this.running.add(cmd.op_id);
    let began = false;
    const ctx: CommandContext = {
      begin: () => {
        if (began) return;
        began = true;
        // The body stays with the record so a restart can reconcile it (recover).
        this.journal.record(cmd.op_id, { digest, t: cmd.t, state: 'executing', body: this.journal.get(cmd.op_id)?.body });
      },
    };
    let res: CommandResult;
    try {
      res = await handler(cmd, ctx);
    } catch (err) {
      res = { state: 'failed', detail: (err as Error).message.slice(0, ERIDANI_LIMITS.reasonChars) };
    } finally {
      this.running.delete(cmd.op_id);
    }
    this.journal.record(cmd.op_id, { digest, t: cmd.t, state: res.state, detail: res.detail, outcome: res.result });
    this.outcome(cmd.op_id, res.state, res.detail, cmd.t, res.result);
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
