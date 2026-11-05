/**
 * One remote host as seen from this app: a single WebSocket that carries
 * every remote terminal on that host, kept alive across sleep and network
 * changes, plus a mirror of the host's session registry.
 *
 * Each terminal ("surf") remembers the last output seq it applied and the
 * server boot that produced it. After any reconnect every wanted terminal is
 * re-opened with that position: the server answers with just the missed bytes
 * (delta), or a fresh screen + scrollback (snapshot, surfaced as a resync),
 * or — after a server restart — a respawned process (lost → fresh).
 *
 * Input typed while disconnected is DROPPED, never queued: replaying
 * keystrokes into an agent minutes later is how commands get approved by
 * accident. Registry changes (close a tab, hide it, rename, move) ARE kept — see
 * PendingIntents, a durable outbox — because those are decisions, not keystrokes.
 *
 * Every request has a deadline (requestTimeoutMs, 15 s by default). A socket
 * can stay up while one answer never comes; the operation then resolves as
 * `uncertain` (it may have been applied) rather than hanging. An uncertain
 * intent is never resent blind: the registry mirror or the next welcome
 * snapshot settles it, and only one that snapshot shows unapplied is retried.
 */
import WebSocket from 'ws';
import {
  BIN_OUTPUT,
  INBOX_GROUP_ID,
  PROTO,
  decodeFrame,
  encodeInput,
  parseServerMsg,
  TIMING,
  type ClientFeature,
  type ClientMsg,
  type CreateSpec,
  type DiagEvent,
  type FsOp,
  type HookAgentStatus,
  type GroupRecord,
  type RemoteSurfaceId,
  type ServerMsg,
  type SessionRecord,
} from '../../shared/remote-host-protocol';
import type { HostStatus, PtyExitInfo, RemoteSize, TerminalSnapshot } from '../../shared/remote-hosts-types';
import { initialFsm, publicState, step, type Fsm, type FsmEvent } from './connection-fsm';
import type { OutboxEntry, PendingIntent, PendingIntents } from './host-config';
import { diag } from './diag';
import { uploadFile } from './upload';

export interface SocketLike {
  readonly readyState: number;
  send(data: string | Uint8Array): void;
  close(): void;
  terminate(): void;
  on(event: 'open', cb: () => void): unknown;
  on(event: 'message', cb: (data: unknown, isBinary: boolean) => void): unknown;
  on(event: 'close', cb: (code: number, reason?: unknown) => void): unknown;
  on(event: 'error', cb: (err: Error) => void): unknown;
  on(event: 'unexpected-response', cb: (req: unknown, res: { statusCode?: number }) => void): unknown;
}

export type SocketFactory = (url: string, headers: Record<string, string>) => SocketLike;

const OPEN = 1;
const FS_TIMEOUT_MS = 20_000;
/** How long a request (or an intent) waits for its ack while the socket stays up. */
export const REQUEST_TIMEOUT_MS = 15_000;
/** The reason onDown gives the acks still waiting. */
const DISCONNECTED = 'disconnected';

/**
 * The outcome of a request. `uncertain`: it was sent but no answer came (the
 * deadline passed, or the connection dropped first), so it may or may not
 * have been applied; check the registry before doing it again.
 */
export interface RequestResult {
  ok: boolean;
  error?: string;
  uncertain?: boolean;
}

/** The server closes sockets admitted with a rotated token with this code (remote-server/src/server.ts TOKEN_ROTATED_CODE). */
export const TOKEN_ROTATED_CLOSE = 4401;

const realSocket: SocketFactory = (url, headers) =>
  new WebSocket(url, { headers, perMessageDeflate: false, handshakeTimeout: 8000, maxPayload: 32 * 1024 * 1024 }) as unknown as SocketLike;

export interface ClientTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(h: unknown): void;
}

const realTimers: ClientTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as NodeJS.Timeout),
};

export interface HostClientDeps {
  hostId: string;
  url: () => string;
  token: () => string | null;
  device: { id: string; name: string };
  appVersion: string;
  pinnedServerId: () => string | undefined;
  pinServer: (serverId: string) => void;
  intents: PendingIntents;
  onStatus: (status: HostStatus) => void;
  /** The registry mirror changed (welcome or any broadcast). */
  onRegistry?: () => void;
  onMeta?: (id: RemoteSurfaceId, meta: { cwd?: string; agent?: SessionRecord['agent'] | null }) => void;
  /** True when the user declined the hook prompt for this host (forever, or for this run). */
  hooksPromptDeclined?: () => boolean;
  /** An agent in a session attached here reported status (the server's hook bridge). */
  onRpc?: (id: RemoteSurfaceId, method: string, params: Record<string, unknown>, replay: boolean) => void;
  /**
   * The server asks this app to bring session `id`'s tab to the front
   * (Eridani's "Open terminal in remotea"). Hello lists the `focus` feature
   * only when this is set.
   */
  onFocus?: (id: RemoteSurfaceId, runId?: string) => void;
  socket?: SocketFactory;
  timers?: ClientTimers;
  now?: () => number;
  rand?: () => number;
  log?: (msg: string) => void;
  /** Deadline for a request's (or an intent's) ack while connected; default REQUEST_TIMEOUT_MS. */
  requestTimeoutMs?: number;
}

export interface RemoteCreateOptions {
  id: RemoteSurfaceId;
  cols: number;
  rows: number;
  spec: CreateSpec;
}

export interface RemoteCreateResult {
  reused: boolean;
  existed: boolean;
  snapshot?: TerminalSnapshot;
  /** The session cannot be opened here: closed elsewhere, or hidden on this device. */
  unavailable?: PtyExitInfo;
}

type DataCb = (data: string) => void;
type ExitCb = (code: number, info: PtyExitInfo) => void;
type ResyncCb = (snap: TerminalSnapshot) => void;

interface Surf {
  id: RemoteSurfaceId;
  spec: CreateSpec;
  cols: number;
  rows: number;
  /** A renderer in this app has this terminal open. */
  wanted: boolean;
  /** The server confirmed the open on the current socket. */
  open: boolean;
  lastSeq: number | null;
  bootId: string | null;
  state: 'live' | 'exited' | 'closed';
  exitCode?: number;
  data: Set<DataCb>;
  exit: Set<ExitCb>;
  resync: Set<ResyncCb>;
  held: string[];
  pendingExit: { code: number; info: PtyExitInfo } | null;
  /** Create calls waiting for this surf's first `opened`. */
  waiters: Array<(r: RemoteCreateResult) => void>;
  /** rid of the open in flight on the current socket. */
  openRid: number | null;
  /** A snapshot re-open was requested to heal a seq gap. */
  healing: boolean;
  /**
   * The server could not start the process (a managed launcher still being
   * probed after a host restart). The open is sent again as soon as the
   * server reports the session live: boot recovery resumes it on its own.
   */
  reopenOnLive: boolean;
  /** The terminal's size on the server, and whether this device sets it (last `size`/`opened`). */
  size?: RemoteSize;
  sizeCbs?: Set<(s: RemoteSize) => void>;
}


const RESTORED_NOTICE = (host: string) =>
  `\x1b[!p\r\n\x1b[2m[remotea] ${host} restarted; session restored\x1b[0m\r\n`;

export class RemoteHostClient {
  readonly hostId: string;
  private fsm: Fsm = initialFsm();
  private ws: SocketLike | null = null;
  private retryTimer: unknown = null;
  private heartbeat: unknown = null;
  private lastInbound = 0;
  private pingN = 0;
  private nextRid = 1;
  private readonly surfs = new Map<string, Surf>();
  private readonly acks = new Map<number, (ok: boolean, error?: string) => void>();
  /** rid -> outbox entry iid, for intents sent on the current socket (kept past the deadline: a late ack still settles). */
  private readonly intentAcks = new Map<number, string>();
  /** rid -> deadline timer of an intent in flight. */
  private readonly intentTimers = new Map<number, unknown>();
  private readonly requestTimeoutMs: number;
  /** Epoch ms of the current connection's welcome. */
  private connectedAt: number | undefined;
  private readonly fsWaiters = new Map<number, (result: unknown) => void>();
  private readonly timers: ClientTimers;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;
  private nextRetryAt: number | undefined;

  // Registry mirror
  bootId: string | null = null;
  serverId: string | null = null;
  epoch: string | null = null;
  serverHostname: string | undefined;
  readonly groups = new Map<string, GroupRecord>();
  readonly sessions = new Map<string, SessionRecord>();
  /** Ids learned to be closed (tombstoned) while this device was away. */
  readonly closedIds = new Set<string>();
  /** What the connected server offers (welcome.features); empty until welcome, and for older servers. */
  private features = new Set<string>();
  /** The server's agents' hook state (welcome / hooksStatus); undefined for servers that do not report it. */
  private hooks: HookAgentStatus[] | undefined;

  constructor(private readonly deps: HostClientDeps) {
    this.hostId = deps.hostId;
    this.timers = deps.timers ?? realTimers;
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? (() => {});
    this.requestTimeoutMs = deps.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  get state(): HostStatus['state'] {
    return publicState(this.fsm.state) as HostStatus['state'];
  }

  get ready(): boolean {
    return this.fsm.state === 'ready';
  }

  status(): HostStatus {
    return {
      hostId: this.hostId,
      state: this.state,
      attempt: this.fsm.attempt,
      nextRetryAt: this.fsm.state === 'reconnecting' || this.fsm.state === 'auth-failed' ? this.nextRetryAt : undefined,
      error: this.fsm.error,
      serverHostname: this.serverHostname,
      connectedAt: this.ready ? this.connectedAt : undefined,
      lastSeenAt: this.lastInbound || undefined,
      hooks: this.hooks && {
        agents: this.hooks,
        prompt: this.ready && !(this.deps.hooksPromptDeclined?.() ?? false) && this.hooks.some((a) => a.present && !a.installed),
      },
      outbox: this.deps.intents.summary(this.hostId),
    };
  }

  /**
   * Put local files on the server for the program in pane `id` (a paste or a
   * drop). All or nothing: the server paths in order, or the first error.
   */
  async uploadFiles(id: string, localPaths: string[], signal?: AbortSignal): Promise<{ ok: true; paths: string[] } | { ok: false; error: string }> {
    const token = this.deps.token();
    if (!this.ready || !token) return { ok: false, error: 'not connected' };
    const paths: string[] = [];
    for (const localPath of localPaths) {
      const r = await uploadFile({ hostUrl: this.deps.url(), token, surfaceId: id, localPath, signal });
      if (!r.ok) {
        diag('surf.upload', { host: this.hostId, ok: false, error: r.error }, id);
        return r;
      }
      paths.push(r.path);
    }
    diag('surf.upload', { host: this.hostId, ok: true, files: paths.length }, id);
    return { ok: true, paths };
  }

  /**
   * The explorer / code viewer on remote pane `id`: run `op` in its folder on
   * the server. Resolves with what the local operation would have returned
   * (an `{ error, code }` object included), never rejects.
   */
  fs(id: string, req: { op: FsOp; path?: string; showHidden?: boolean; content?: string; expectedMtimeMs?: number }): Promise<unknown> {
    if (!this.features.has('fs')) return Promise.resolve({ error: 'Update the remotea server to browse files of remote panes', code: 'read_failed' });
    const rid = this.nextRid++;
    return new Promise((resolve) => {
      if (!this.sendJson({ t: 'fs', rid, id: id as RemoteSurfaceId, ...req })) {
        resolve({ error: 'Not connected to the remote host', code: 'read_failed' });
        return;
      }
      const timer = this.timers.setTimeout(() => {
        this.fsWaiters.delete(rid);
        resolve({ error: 'The remote host did not answer', code: 'read_failed' });
      }, FS_TIMEOUT_MS);
      this.fsWaiters.set(rid, (result) => {
        this.timers.clearTimeout(timer);
        resolve(result);
      });
    });
  }

  /** Register the status hooks with the server's agents (the user said yes in the app). */
  installHooks(): Promise<RequestResult> {
    if (!this.features.has('hooks')) return Promise.resolve({ ok: false, error: 'this server cannot install hooks; update it, or run `remotea hooks install` there' });
    return this.request((rid) => ({ t: 'hooksInstall', rid }));
  }

  /** Explicit handoff only; an uncertain reply is reconciled through the session registry. */
  takeover(id: string): Promise<RequestResult> {
    if (!this.features.has('managedSessions')) return Promise.resolve({ ok: false, error: 'Update this host to take over managed sessions.' });
    return this.request((rid) => ({ t: 'takeover', rid, id: id as RemoteSurfaceId }));
  }

  chatAttention(id: string, action: import('../../shared/remote-host-protocol').ChatAttentionAction): Promise<RequestResult> {
    if (!this.features.has('chatAttention')) return Promise.resolve({ ok: false, error: 'Update the Remotea server to use unread state and reminders.' });
    return this.request(rid => ({ t: 'chatAttention', rid, id: id as RemoteSurfaceId, ...action }));
  }

  /** Something that decides `hooks.prompt` changed outside this client (the user dismissed the prompt). */
  refreshStatus(): void {
    this.deps.onStatus(this.status());
  }

  start(): void {
    if (!this.deps.token()) {
      this.dispatch({ type: 'stop' });
      return;
    }
    this.dispatch({ type: 'start' });
  }

  stop(): void {
    this.dispatch({ type: 'stop' });
  }

  /** Machine is about to sleep: close cleanly now rather than leave a half-open socket. */
  suspend(): void {
    this.dispatch({ type: 'suspend' });
  }

  /** Resume, unlock, window focus: reconnect immediately instead of waiting out a backoff. */
  wake(): void {
    if (this.fsm.state === 'disabled') {
      this.start();
      return;
    }
    this.dispatch({ type: 'wake' });
  }

  /** Synchronous teardown for quit: the server treats a dropped socket as a detach, never a kill. */
  detachNow(): void {
    this.clearTimers();
    try {
      this.ws?.terminate();
    } catch {
      /* already gone */
    }
    this.ws = null;
  }

  private dispatch(ev: FsmEvent): void {
    const before = this.fsm.state;
    const { fsm, effects } = step(this.fsm, ev, this.deps.rand);
    this.fsm = fsm;
    for (const e of effects) {
      switch (e.type) {
        case 'connect': this.connect(); break;
        case 'disconnect': this.dropSocket(); break;
        case 'schedule-retry':
          this.cancelRetry();
          this.nextRetryAt = this.now() + e.ms;
          this.retryTimer = this.timers.setTimeout(() => {
            this.retryTimer = null;
            this.dispatch({ type: 'retry' });
          }, e.ms);
          break;
        case 'cancel-retry': this.cancelRetry(); break;
        case 'ready': this.onReady(); break;
        case 'down': this.onDown(); break;
      }
    }
    if (before !== this.fsm.state || ev.type === 'closed') {
      diag('conn.state', { host: this.hostId, from: before, to: this.fsm.state, ev: ev.type, error: 'error' in ev ? ev.error : undefined });
      this.deps.onStatus(this.status());
    }
  }

  private cancelRetry(): void {
    if (this.retryTimer !== null) this.timers.clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.nextRetryAt = undefined;
  }

  private clearTimers(): void {
    this.cancelRetry();
    if (this.heartbeat !== null) this.timers.clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  private dropSocket(): void {
    if (this.heartbeat !== null) this.timers.clearInterval(this.heartbeat);
    this.heartbeat = null;
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.terminate();
    } catch {
      /* ignore */
    }
  }

  private connect(): void {
    this.dropSocket();
    const token = this.deps.token();
    if (!token) {
      this.dispatch({ type: 'stop' });
      return;
    }
    let ws: SocketLike;
    try {
      ws = (this.deps.socket ?? realSocket)(this.deps.url(), { Authorization: `Bearer ${token}` });
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
      this.sendJson({
        t: 'hello', proto: PROTO, device: this.deps.device, app: { name: 'remotea', version: this.deps.appVersion },
        ...(this.deps.onFocus ? { features: ['focus'] as ClientFeature[] } : {}),
      });
      this.heartbeat = this.timers.setInterval(() => this.beat(), TIMING.pingMs);
    });
    ws.on('unexpected-response', (_req, res) => {
      if (this.ws !== ws) return;
      refused = true;
      if (res.statusCode === 401) this.dispatch({ type: 'auth-failed' });
      else this.dispatch({ type: 'closed', error: `Server refused the connection (HTTP ${res.statusCode ?? '?'})` });
    });
    ws.on('message', (data, isBinary) => {
      if (this.ws !== ws) return;
      this.lastInbound = this.now();
      this.onMessage(data, isBinary);
    });
    ws.on('error', (err) => {
      if (this.ws !== ws || refused) return;
      this.log(`${this.hostId}: socket error ${err.message}`);
    });
    ws.on('close', (code, reason) => {
      if (this.ws !== ws || refused) return;
      diag('conn.close', { host: this.hostId, code, reason: String(reason ?? '') });
      this.ws = null;
      // `remotea rotate-token` revoked the token this socket was admitted with. Reconnecting with it
      // would only be refused (HTTP 401), so go straight to "Token rejected", unless the token was
      // already replaced here: then the next attempt uses the new one.
      if (code === TOKEN_ROTATED_CLOSE && this.deps.token() === token) {
        this.dispatch({ type: 'auth-failed' });
        return;
      }
      this.dispatch({ type: 'closed', error: this.fsm.state === 'connecting' ? 'Cannot reach the server' : undefined });
    });
  }

  /** App-level heartbeat: a laptop that slept leaves a socket that looks open but is dead. */
  private beat(): void {
    if (this.now() - this.lastInbound > TIMING.deadMs) {
      this.log(`${this.hostId}: no traffic for ${TIMING.deadMs} ms, reconnecting`);
      diag('conn.dead', { host: this.hostId, silentMs: this.now() - this.lastInbound });
      const ws = this.ws;
      this.ws = null;
      try {
        ws?.terminate();
      } catch {
        /* ignore */
      }
      this.dispatch({ type: 'closed', error: 'Connection timed out' });
      return;
    }
    this.sendJson({ t: 'ping', n: ++this.pingN });
  }

  private sendJson(msg: ClientMsg): boolean {
    if (!this.ws || this.ws.readyState !== OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  // ── Ready / down ─────────────────────────────────────────────────────────

  private onReady(): void {
    this.probed.clear();
    this.connectedAt = this.now();
    this.settleFromSnapshot();
    // What the snapshot does not show as applied was not applied: resend it.
    const retried = this.deps.intents.retryUncertain(this.hostId);
    if (retried) diag('intent.retry', { host: this.hostId, uncertain: retried });
    this.flushOutbox();
    for (const surf of this.surfs.values()) {
      if (surf.wanted && surf.state !== 'closed') this.sendOpen(surf);
    }
  }

  private onDown(): void {
    // Unacknowledged intents stay in the outbox: settled against, or resent after, the next welcome.
    this.connectedAt = undefined;
    this.intentAcks.clear();
    for (const t of this.intentTimers.values()) this.timers.clearTimeout(t);
    this.intentTimers.clear();
    for (const surf of this.surfs.values()) {
      surf.open = false;
      surf.openRid = null;
    }
    for (const [rid, ack] of this.acks) {
      this.acks.delete(rid);
      ack(false, DISCONNECTED);
    }
    for (const [rid, w] of this.fsWaiters) {
      this.fsWaiters.delete(rid);
      w({ error: 'Disconnected from the remote host', code: 'read_failed' });
    }
  }

  // ── Outbox (see PendingIntents) ──────────────────────────────────────────

  /**
   * The welcome is the server's state after everything it received on earlier
   * connections. A pending (or uncertain) intent whose effect it already
   * shows was applied and only its ack was lost: settle it without resending,
   * so an older choice is never replayed over a state that already moved on.
   */
  private settleFromSnapshot(): void {
    this.settleApplied(this.deps.intents.unsettled(this.hostId));
  }

  /**
   * Between welcomes the mirror is kept current by broadcasts: an uncertain
   * intent whose effect shows up there was applied. One that does not show up
   * stays uncertain (its broadcast may have been lost with the ack) until the
   * next welcome decides.
   */
  private reconcileUncertain(): void {
    this.settleApplied(this.deps.intents.unsettled(this.hostId).filter((e) => e.state === 'uncertain'));
  }

  private settleApplied(entries: OutboxEntry[]): void {
    let changed = false;
    for (const e of entries) {
      if (!this.isApplied(e.intent)) continue;
      diag('intent.proved', { host: this.hostId, t: e.intent.t, attempts: e.attempts, uncertain: e.state === 'uncertain' }, e.intent.id);
      this.deps.intents.settle(this.hostId, e.iid, { ok: true });
      changed = true;
    }
    if (changed) this.outboxChanged();
  }

  /** Whether the registry mirror already shows intent `i`'s effect. */
  private isApplied(i: PendingIntent): boolean {
    const me = this.deps.device.id;
    switch (i.t) {
      case 'close': return !this.sessions.has(i.id);
      case 'groupClose': return !this.groups.has(i.id);
      case 'hide': {
        const s = this.sessions.get(i.id);
        // Gone altogether is as hidden as it gets.
        return !s || (s.hiddenBy as string[]).includes(me);
      }
      case 'unhide': {
        const s = this.sessions.get(i.id);
        return !!s && !(s.hiddenBy as string[]).includes(me);
      }
      case 'sessionUpdate': {
        const s = this.sessions.get(i.id);
        // The server files a session without a (live) group under the inbox, and stores a null title as none.
        return !!s
          && (i.groupId === undefined || s.groupId === (i.groupId ?? INBOX_GROUP_ID))
          && (i.title === undefined || (s.title ?? undefined) === (i.title ?? undefined));
      }
      case 'groupUpsert': {
        const g = this.groups.get(i.id);
        return !!g && g.name === i.name && (g.color ?? undefined) === (i.color ?? undefined);
      }
    }
  }

  /** Send every pending intent not already sent on this connection, oldest first. */
  private flushOutbox(): void {
    const inFlight = new Set(this.intentAcks.values());
    for (const e of this.deps.intents.pending(this.hostId)) {
      if (!inFlight.has(e.iid)) this.sendEntry(e);
    }
    this.outboxChanged();
  }

  /** Count the attempt on disk, then send; the ack (by rid) settles the entry. */
  private sendEntry(e: OutboxEntry): void {
    if (!this.ws || this.ws.readyState !== OPEN) return;
    if (!this.deps.intents.beginSend(this.hostId, e.iid)) return;
    const rid = this.nextRid++;
    this.intentAcks.set(rid, e.iid);
    if (!this.sendIntent(rid, e.intent)) {
      this.intentAcks.delete(rid);
      return;
    }
    this.intentTimers.set(rid, this.timers.setTimeout(() => this.onIntentDeadline(rid), this.requestTimeoutMs));
  }

  /**
   * No ack within the deadline and the socket is still up: the intent may or
   * may not have been applied. Mark it uncertain (never resent blind), and
   * settle it now if the mirror already shows it. A late ack still settles it.
   */
  private onIntentDeadline(rid: number): void {
    this.intentTimers.delete(rid);
    const iid = this.intentAcks.get(rid);
    if (iid === undefined || !this.deps.intents.markUncertain(this.hostId, iid)) return;
    const e = this.deps.intents.get(this.hostId, iid);
    diag('intent.uncertain', { host: this.hostId, t: e?.intent.t ?? null, attempts: e?.attempts ?? null, ms: this.requestTimeoutMs }, e?.intent.id);
    this.log(`${this.hostId}: ${e?.intent.t} ${e?.intent.id} not acknowledged within ${this.requestTimeoutMs} ms; the registry will settle it`);
    this.outboxChanged();
    this.reconcileUncertain();
  }

  private onIntentAck(iid: string, ok: boolean, error?: string): void {
    const e = this.deps.intents.get(this.hostId, iid);
    if (!e) return;
    diag('intent.ack', { host: this.hostId, t: e.intent.t, ok, error: error ?? null, attempts: e.attempts }, e.intent.id);
    if (!ok) this.log(`${this.hostId}: ${e.intent.t} ${e.intent.id} refused: ${error ?? 'no reason'}`);
    this.deps.intents.settle(this.hostId, iid, { ok, error });
    this.outboxChanged();
  }

  private outboxChanged(): void {
    this.deps.onStatus(this.status());
    this.deps.onRegistry?.();
  }

  /**
   * What this device has asked for and the server has not confirmed yet, to
   * lay over the registry mirror: a tab closed or hidden here must not be
   * re-placed from a registry that has not heard about it.
   */
  outboxOverlay(): { closing: Set<string>; groupsClosing: Set<string>; hiding: Set<string>; unhiding: Set<string> } {
    const o = { closing: new Set<string>(), groupsClosing: new Set<string>(), hiding: new Set<string>(), unhiding: new Set<string>() };
    for (const i of this.deps.intents.peek(this.hostId)) {
      if (i.t === 'close') o.closing.add(i.id);
      else if (i.t === 'groupClose') o.groupsClosing.add(i.id);
      else if (i.t === 'hide') o.hiding.add(i.id);
      else if (i.t === 'unhide') o.unhiding.add(i.id);
    }
    return o;
  }

  /**
   * The user forgot one unconfirmed change: it is not sent again, and the
   * registry views stop laying it over the mirror (a tab it closed or hid
   * may come back). An ack already on its way finds no entry and is ignored.
   */
  forgetIntent(iid: string): boolean {
    const e = this.deps.intents.get(this.hostId, iid);
    if (!this.deps.intents.forget(this.hostId, iid)) return false;
    diag('intent.forgotten', { host: this.hostId, t: e?.intent.t ?? null, state: e?.state ?? null, attempts: e?.attempts ?? null }, e?.intent.id);
    this.outboxChanged();
    return true;
  }

  /** The user has seen this host's failed or expired changes. */
  dismissOutboxFailures(): void {
    this.deps.intents.clearDone(this.hostId);
    this.deps.onStatus(this.status());
  }

  private sendIntent(rid: number, intent: PendingIntent): boolean {
    switch (intent.t) {
      case 'close': return this.sendJson({ t: 'close', rid, id: intent.id as RemoteSurfaceId });
      case 'groupClose': return this.sendJson({ t: 'groupClose', rid, id: intent.id as `grp-${string}` });
      case 'hide': return this.sendJson({ t: 'hide', rid, id: intent.id as RemoteSurfaceId });
      case 'unhide': return this.sendJson({ t: 'unhide', rid, id: intent.id as RemoteSurfaceId });
      case 'sessionUpdate':
        return this.sendJson({ t: 'sessionUpdate', rid, id: intent.id as RemoteSurfaceId, groupId: intent.groupId as `grp-${string}` | null | undefined, group: intent.group, title: intent.title });
      case 'groupUpsert': return this.sendJson({ t: 'groupUpsert', rid, group: { id: intent.id as `grp-${string}`, name: intent.name, color: intent.color } });
    }
  }

  /**
   * Record the change in the outbox (on disk), then send it if connected.
   * Either way it stays there until the server acknowledges it.
   */
  intent(intent: PendingIntent): void {
    const entry = this.deps.intents.add(this.hostId, intent);
    if (this.ready) this.sendEntry(entry);
    this.outboxChanged();
  }

  private sendOpen(surf: Surf): void {
    const rid = this.nextRid++;
    surf.openRid = rid;
    surf.reopenOnLive = false;
    const resume = surf.lastSeq !== null && surf.bootId === this.bootId && !surf.healing;
    diag('surf.open', { host: this.hostId, sinceSeq: resume ? surf.lastSeq : null, healing: surf.healing, waiters: surf.waiters.length }, surf.id);
    this.sendJson({
      t: 'open', rid, id: surf.id, cols: surf.cols, rows: surf.rows,
      sinceSeq: resume ? surf.lastSeq! : undefined,
      bootId: resume ? surf.bootId! : undefined,
      create: surf.spec,
    });
  }

  // ── Inbound ──────────────────────────────────────────────────────────────

  private onMessage(data: unknown, isBinary: boolean): void {
    if (isBinary) {
      const buf = data instanceof Uint8Array ? data : Array.isArray(data) ? Buffer.concat(data as Buffer[]) : Buffer.from(data as ArrayBuffer);
      const frame = decodeFrame(buf);
      if (frame && frame.kind === BIN_OUTPUT) this.onOutput(frame.id, frame.seq!, frame.data);
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(String(data));
    } catch {
      return;
    }
    const msg = parseServerMsg(raw);
    if (msg) this.onServerMsg(msg);
  }

  private onServerMsg(msg: ServerMsg): void {
    switch (msg.t) {
      case 'welcome': return this.onWelcome(msg);
      case 'opened': return this.onOpened(msg);
      case 'openError': return this.onOpenError(msg);
      case 'ack': {
        const iid = this.intentAcks.get(msg.rid);
        if (iid !== undefined) {
          this.intentAcks.delete(msg.rid);
          const timer = this.intentTimers.get(msg.rid);
          if (timer !== undefined) this.timers.clearTimeout(timer);
          this.intentTimers.delete(msg.rid);
          this.onIntentAck(iid, msg.ok, msg.error);
          return;
        }
        const ack = this.acks.get(msg.rid);
        this.acks.delete(msg.rid);
        ack?.(msg.ok, msg.error);
        return;
      }
      case 'exit': {
        const surf = this.surfs.get(msg.id);
        if (surf && surf.state === 'live') {
          surf.state = 'exited';
          surf.exitCode = msg.code;
          this.emitExit(surf, msg.code, { reason: 'exited' });
        }
        return;
      }
      case 'meta': {
        this.deps.onMeta?.(msg.id, { cwd: msg.cwd, agent: msg.agent });
        // The agent's state reaches the registry through meta only: keep the mirror current for the status UI.
        const rec = msg.agentState ? this.sessions.get(msg.id) : undefined;
        if (rec) {
          this.sessions.set(msg.id, { ...rec, agentState: msg.agentState });
          this.deps.onRegistry?.();
        }
        return;
      }
      case 'focus':
        diag('surf.focus', { host: this.hostId }, msg.id);
        this.deps.onFocus?.(msg.id, msg.runId);
        return;
      case 'fsResult': {
        const w = this.fsWaiters.get(msg.rid);
        this.fsWaiters.delete(msg.rid);
        w?.(msg.result);
        return;
      }
      case 'hooksStatus':
        this.hooks = msg.hooks;
        diag('conn.hooks', { host: this.hostId, installed: msg.hooks.filter((a) => a.installed).map((a) => a.agent).join(',') });
        this.deps.onStatus(this.status());
        return;
      case 'size': {
        const surf = this.surfs.get(msg.id);
        if (surf) this.setSize(surf, { cols: msg.cols, rows: msg.rows, owner: msg.owner, ownerName: msg.ownerName });
        return;
      }
      case 'rpc':
        // Only for a session this app has open; one it is not showing gets the
        // latest state replayed when (if) it opens it.
        if (this.surfs.get(msg.id)?.state === 'live') {
          const event = typeof msg.params.event === 'string' ? msg.params.event : undefined;
          diag('surf.rpc', { host: this.hostId, method: msg.method, event, tool: typeof msg.params.tool === 'string' ? msg.params.tool : undefined, replay: msg.replay === true }, msg.id);
          this.deps.onRpc?.(msg.id, msg.method, msg.params, msg.replay === true);
        }
        return;
      case 'probed': {
        let changed = false;
        for (const [id, st] of Object.entries(msg.status)) {
          if (st === 'closed' && !this.closedIds.has(id)) {
            this.closedIds.add(id);
            changed = true;
          }
        }
        if (changed) this.deps.onRegistry?.();
        return;
      }
      case 'sessionAdded':
      case 'sessionUpdated':
        this.sessions.set(msg.session.id, msg.session);
        this.closedIds.delete(msg.session.id);
        if (msg.session.hiddenBy.includes(this.deps.device.id)) this.markGone(msg.session.id, { reason: 'hidden' });
        else this.reopenIfLive(msg.session);
        this.reconcileUncertain();
        this.deps.onRegistry?.();
        return;
      case 'sessionClosed':
        this.sessions.delete(msg.id);
        this.closedIds.add(msg.id);
        this.markGone(msg.id, { reason: 'closed', by: this.deviceLabel(msg.by) });
        this.reconcileUncertain();
        this.deps.onRegistry?.();
        return;
      case 'groupUpserted':
        this.groups.set(msg.group.id, msg.group);
        this.reconcileUncertain();
        this.deps.onRegistry?.();
        return;
      case 'groupClosed':
        this.groups.delete(msg.id);
        for (const id of msg.sessionIds) {
          this.sessions.delete(id);
          this.closedIds.add(id);
          this.markGone(id, { reason: 'closed', by: this.deviceLabel(msg.by) });
        }
        this.reconcileUncertain();
        this.deps.onRegistry?.();
        return;
      case 'goingAway':
        this.log(`${this.hostId}: server is shutting down`);
        return;
      case 'error':
        if (msg.code === 'incompatible') this.dispatch({ type: 'incompatible', error: msg.message });
        else this.log(`${this.hostId}: server error ${msg.code}: ${msg.message}`);
        return;
      default:
        return;
    }
  }

  private deviceLabel(deviceId: string): string {
    return deviceId === this.deps.device.id ? 'this device' : deviceId === 'server' ? 'the server' : 'another device';
  }

  private onWelcome(msg: Extract<ServerMsg, { t: 'welcome' }>): void {
    const pinned = this.deps.pinnedServerId();
    if (pinned && pinned !== msg.serverId) {
      this.dispatch({ type: 'wrong-server' });
      return;
    }
    if (!pinned) this.deps.pinServer(msg.serverId);
    this.serverId = msg.serverId;
    this.bootId = msg.bootId;
    this.epoch = msg.epoch;
    this.serverHostname = msg.hostname;
    this.features = new Set(msg.features ?? []);
    this.hooks = msg.features?.includes('hooks') ? msg.hooks : undefined;
    diag('conn.welcome', { host: this.hostId, boot: msg.bootId.slice(0, 8), sessions: msg.sessions.length, features: (msg.features ?? []).join(',') });
    this.groups.clear();
    for (const g of msg.groups) this.groups.set(g.id, g);
    this.sessions.clear();
    for (const s of msg.sessions) this.sessions.set(s.id, s);
    this.dispatch({ type: 'welcome' });
    this.deps.onRegistry?.();
  }

  private onOpened(msg: Extract<ServerMsg, { t: 'opened' }>): void {
    const surf = this.surfs.get(msg.id);
    if (!surf) return;
    if (msg.rid !== undefined && msg.rid !== surf.openRid) return; // reply to a superseded open
    surf.openRid = null;
    surf.open = true;
    const firstOpen = surf.waiters.length > 0;
    diag('surf.opened', {
      host: this.hostId, mode: msg.mode, seq: msg.seq, fromSeq: msg.fromSeq ?? null, created: msg.created, wasLost: !!msg.wasLost,
      state: msg.state, firstOpen, waiters: surf.waiters.length, snapshotBytes: msg.snapshot?.length ?? 0, owner: msg.owner,
    }, msg.id);
    surf.healing = false;
    const snapshot = msg.mode === 'snapshot' ? { data: msg.snapshot ?? '', cols: msg.cols, rows: msg.rows } : undefined;
    const prevState = surf.state;
    surf.state = msg.state === 'exited' ? 'exited' : 'live';
    surf.exitCode = msg.exitCode;
    // A delta replays everything AFTER fromSeq (msg.seq is the server's head);
    // a snapshot or a fresh process starts exactly at msg.seq.
    surf.lastSeq = msg.mode === 'delta' ? msg.fromSeq ?? surf.lastSeq : msg.seq;
    surf.bootId = this.bootId;
    this.setSize(surf, { cols: msg.cols, rows: msg.rows, owner: msg.owner, ownerName: msg.owner ? undefined : surf.size?.ownerName });

    if (firstOpen) {
      const waiters = surf.waiters;
      surf.waiters = [];
      // Only the first caller wires output forwarding. A second create() that
      // arrived while the open was in flight (React StrictMode runs effects
      // twice) is a reuse, exactly as it would be for a local PTY — otherwise
      // every chunk is forwarded, and painted, twice.
      waiters.forEach((w, i) => w({ reused: i > 0, existed: !msg.created, snapshot }));
    } else if (msg.mode === 'fresh') {
      // A new process under an existing tab: respawned after a server restart
      // (wasLost), or re-created because the registry no longer knew it.
      this.deliver(surf, RESTORED_NOTICE(this.serverHostname ?? this.hostId));
    } else if (snapshot) {
      for (const cb of surf.resync) cb(snapshot);
    }
    // Exited while we were away (or already exited when first opened): tell the renderer once.
    if (surf.state === 'exited' && prevState === 'live') {
      this.emitExit(surf, msg.exitCode ?? 0, { reason: 'exited' });
    }
  }

  private onOpenError(msg: Extract<ServerMsg, { t: 'openError' }>): void {
    const surf = this.surfs.get(msg.id);
    if (!surf || (surf.openRid !== null && msg.rid !== surf.openRid)) return;
    surf.openRid = null;
    if (msg.code === 'closed' || msg.code === 'hidden') {
      const info: PtyExitInfo = msg.code === 'closed' ? { reason: 'closed', by: msg.by ? this.deviceLabel(msg.by) : undefined } : { reason: 'hidden' };
      if (msg.code === 'closed') this.closedIds.add(msg.id);
      const waiters = surf.waiters;
      surf.waiters = [];
      if (waiters.length) {
        surf.state = 'closed';
        this.surfs.delete(surf.id);
        for (const w of waiters) w({ reused: false, existed: false, unavailable: info });
      } else {
        this.markGone(surf.id, info);
      }
      return;
    }
    // The process could not be started now (a managed launcher is still being probed after a host
    // restart). The tab stays wanted; the server's own boot recovery resumes the session once the
    // probe passes and broadcasts it live, and that broadcast re-sends this open (reopenIfLive).
    const retry = msg.code === 'spawn-failed' && surf.wanted && surf.state !== 'closed';
    surf.reopenOnLive = retry;
    this.log(`${this.hostId}: open ${msg.id} failed: ${msg.code} ${msg.message}${retry ? ' (will open again when the host reports it live)' : ''}`);
    diag('surf.openError', { host: this.hostId, code: msg.code, retry }, msg.id);
  }

  /** A session the server refused to spawn is live again (resumed by boot recovery): open it now. */
  private reopenIfLive(session: SessionRecord): void {
    const surf = this.surfs.get(session.id);
    if (!surf || !surf.reopenOnLive || !surf.wanted || surf.open || surf.openRid !== null || surf.state === 'closed') return;
    if (session.state !== 'live' || !this.ready) return;
    this.log(`${this.hostId}: ${session.id} is live again, opening it`);
    diag('surf.reopen', { host: this.hostId }, session.id);
    this.sendOpen(surf);
  }

  private onOutput(id: string, seq: number, data: string): void {
    const surf = this.surfs.get(id);
    if (!surf || !surf.open) return;
    if (surf.lastSeq !== null && seq <= surf.lastSeq) return; // duplicate after a resync
    if (surf.lastSeq !== null && seq !== surf.lastSeq + 1) {
      // A gap can only mean lost frames: heal with a snapshot rather than draw a corrupt screen.
      if (!surf.healing) {
        surf.healing = true;
        this.log(`${this.hostId}: seq gap on ${id} (${surf.lastSeq} -> ${seq}), resnapshotting`);
        diag('surf.gap', { host: this.hostId, last: surf.lastSeq, got: seq }, id);
        this.sendOpen(surf);
      }
      return;
    }
    surf.lastSeq = seq;
    this.deliver(surf, data);
  }

  private deliver(surf: Surf, data: string): void {
    if (surf.data.size === 0) {
      surf.held.push(data);
      return;
    }
    for (const cb of surf.data) cb(data);
  }

  private emitExit(surf: Surf, code: number, info: PtyExitInfo): void {
    diag('surf.exit', { host: this.hostId, code, reason: info.reason, by: info.by ?? null }, surf.id);
    if (surf.exit.size === 0) {
      surf.pendingExit = { code, info };
      return;
    }
    for (const cb of [...surf.exit]) cb(code, info);
  }

  /** The session ended for this device (closed anywhere, or hidden here). */
  private markGone(id: string, info: PtyExitInfo): void {
    const surf = this.surfs.get(id);
    if (!surf) return;
    surf.state = 'closed';
    surf.wanted = false;
    surf.open = false;
    this.emitExit(surf, -1, info);
    this.surfs.delete(id);
  }

  // ── Backend operations (called through TerminalRouter) ─────────────────

  owns(id: string): boolean {
    return this.surfs.has(id);
  }

  has(id: string): boolean {
    const s = this.surfs.get(id);
    return !!s && s.wanted && s.state !== 'closed' && s.waiters.length === 0;
  }

  /** Terminals open in this app whose (re-)open the server has not confirmed on the current socket. */
  restoringIds(): string[] {
    const ids: string[] = [];
    for (const s of this.surfs.values()) if (s.wanted && s.state !== 'closed' && !s.open) ids.push(s.id);
    return ids;
  }

  attachedCount(): number {
    let n = 0;
    for (const s of this.surfs.values()) if (s.wanted && s.open) n++;
    return n;
  }

  /**
   * Open (attach to, or create) a remote terminal. Resolves once the server
   * has it — however long the host takes to become reachable.
   */
  create(opts: RemoteCreateOptions): Promise<RemoteCreateResult> {
    const existing = this.surfs.get(opts.id);
    if (existing && existing.wanted && existing.state !== 'closed' && existing.waiters.length === 0) {
      diag('surf.create', { host: this.hostId, result: 'reused' }, opts.id);
      return Promise.resolve({ reused: true, existed: true });
    }
    diag('surf.create', { host: this.hostId, result: existing ? 'joined' : 'new', waiters: existing?.waiters.length ?? 0 }, opts.id);
    const surf: Surf = existing ?? {
      id: opts.id, spec: opts.spec, cols: opts.cols, rows: opts.rows, wanted: true, open: false,
      lastSeq: null, bootId: null, state: 'live', data: new Set(), exit: new Set(), resync: new Set(),
      held: [], pendingExit: null, waiters: [], openRid: null, healing: false, reopenOnLive: false,
    };
    surf.spec = opts.spec;
    surf.cols = opts.cols;
    surf.rows = opts.rows;
    surf.wanted = true;
    this.surfs.set(opts.id, surf);
    return new Promise((resolve) => {
      surf.waiters.push(resolve);
      if (surf.waiters.length === 1 && this.ready && surf.openRid === null) this.sendOpen(surf);
    });
  }

  write(id: string, data: string): void {
    const s = this.surfs.get(id);
    if (!s || !s.open || s.state !== 'live' || !this.ws || this.ws.readyState !== OPEN) return;
    this.ws.send(encodeInput(id, data));
  }

  resize(id: string, cols: number, rows: number): void {
    const s = this.surfs.get(id);
    if (!s) return;
    s.cols = cols;
    s.rows = rows;
    if (s.open) this.sendJson({ t: 'resize', id: s.id, cols, rows });
  }

  claim(id: string): void {
    const s = this.surfs.get(id);
    if (s?.open) this.sendJson({ t: 'claim', id: s.id });
  }

  deliverCommands(id: string, commands: string[]): boolean {
    const s = this.surfs.get(id);
    if (!s?.open || s.state !== 'live') return false;
    return this.sendJson({ t: 'deliver', id: s.id, commands });
  }

  /** Whether diagnostics can go to this server now (connected, and it offers 'diag'). */
  get acceptsDiag(): boolean {
    return this.ready && this.features.has('diag');
  }

  sendDiag(events: DiagEvent[]): boolean {
    return this.acceptsDiag && this.sendJson({ t: 'diag', events });
  }

  /** Close the session everywhere (the user closed the tab). Queued when offline. */
  kill(id: string): void {
    const s = this.surfs.get(id);
    this.intent({ t: 'close', id });
    if (s) {
      s.state = 'closed';
      s.wanted = false;
      for (const w of s.waiters) w({ reused: false, existed: false, unavailable: { reason: 'closed', by: 'this device' } });
      s.waiters = [];
      this.emitExit(s, -1, { reason: 'closed', by: 'this device' });
      this.surfs.delete(id);
    }
  }

  /**
   * Send this terminal's current screen through onResync — the renderer that
   * shows it lost its copy (a window reload). A re-open without sinceSeq: the
   * server answers with a snapshot at a fence, and output continues after it.
   */
  resnapshot(id: string): void {
    const s = this.surfs.get(id);
    if (!s || !s.open || s.openRid !== null || !this.ready) return;
    diag('surf.resnapshot', { host: this.hostId }, id);
    s.healing = true;
    this.sendOpen(s);
  }

  /** Stop streaming to this app but keep the session (window closed, or hidden here). */
  release(id: string): void {
    const s = this.surfs.get(id);
    if (!s) return;
    s.wanted = false;
    if (s.open) this.sendJson({ t: 'detach', ids: [s.id] });
    this.surfs.delete(id);
  }

  onData(id: string, cb: DataCb): () => void {
    const s = this.surfs.get(id);
    if (!s) return () => {};
    s.data.add(cb);
    if (s.held.length) {
      const held = s.held;
      s.held = [];
      for (const d of held) cb(d);
    }
    return () => s.data.delete(cb);
  }

  onExit(id: string, cb: ExitCb): () => void {
    const s = this.surfs.get(id);
    if (!s) return () => {};
    s.exit.add(cb);
    if (s.pendingExit) {
      const { code, info } = s.pendingExit;
      s.pendingExit = null;
      cb(code, info);
    }
    return () => s.exit.delete(cb);
  }

  /** Size changes of terminal `id` (see RemoteSize). */
  onSize(id: string, cb: (s: RemoteSize) => void): () => void {
    const s = this.surfs.get(id);
    if (!s) return () => {};
    (s.sizeCbs ??= new Set()).add(cb);
    return () => s.sizeCbs?.delete(cb);
  }

  sizeOf(id: string): RemoteSize | undefined {
    return this.surfs.get(id)?.size;
  }

  private setSize(surf: Surf, size: RemoteSize): void {
    const prev = surf.size;
    if (prev && prev.cols === size.cols && prev.rows === size.rows && prev.owner === size.owner && prev.ownerName === size.ownerName) return;
    surf.size = size;
    for (const cb of surf.sizeCbs ?? []) cb(size);
  }

  onResync(id: string, cb: ResyncCb): () => void {
    const s = this.surfs.get(id);
    if (!s) return () => {};
    s.resync.add(cb);
    return () => s.resync.delete(cb);
  }

  /** Ids already asked about on this connection. */
  private probed = new Set<string>();

  /**
   * Ask the server about tabs this device shows that the registry does not
   * list: a session closed on another device while this one was offline is
   * not in the welcome at all, only in the server's tombstones.
   */
  probeUnknown(ids: Iterable<string>): void {
    if (!this.ready) return;
    const ask: string[] = [];
    for (const id of ids) {
      if (this.sessions.has(id) || this.closedIds.has(id) || this.probed.has(id)) continue;
      if (!/^surf-[A-Za-z0-9_-]{1,96}$/.test(id)) continue;
      this.probed.add(id);
      ask.push(id);
    }
    for (let i = 0; i < ask.length; i += 256) {
      this.sendJson({ t: 'probe', rid: this.nextRid++, ids: ask.slice(i, i + 256) as RemoteSurfaceId[] });
    }
  }

  /**
   * Request/response helper. Resolves with the ack; `not connected` when it
   * could not be sent; `uncertain` when it was sent but no answer came (the
   * deadline passed with the socket up, or the connection dropped first). A
   * late ack after the deadline is ignored: the caller already moved on.
   */
  request(build: (rid: number) => ClientMsg): Promise<RequestResult> {
    const rid = this.nextRid++;
    return new Promise((resolve) => {
      if (!this.sendJson(build(rid))) {
        resolve({ ok: false, error: 'not connected' });
        return;
      }
      const timer = this.timers.setTimeout(() => {
        if (!this.acks.delete(rid)) return;
        diag('req.uncertain', { host: this.hostId, ms: this.requestTimeoutMs });
        resolve({ ok: false, uncertain: true, error: `no answer from the host within ${Math.round(this.requestTimeoutMs / 1000)} s; it may or may not have been applied` });
      }, this.requestTimeoutMs);
      this.acks.set(rid, (ok, error) => {
        this.timers.clearTimeout(timer);
        if (!ok && error === DISCONNECTED) resolve({ ok: false, uncertain: true, error: 'disconnected before the host answered; it may or may not have been applied' });
        else resolve({ ok, error });
      });
    });
  }
}
