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
 * accident. Destructive intents (close a tab, hide it) ARE queued — see
 * PendingIntents — because those are decisions, not keystrokes.
 */
import WebSocket from 'ws';
import {
  BIN_OUTPUT,
  PROTO,
  decodeFrame,
  encodeInput,
  parseServerMsg,
  TIMING,
  type ClientMsg,
  type CreateSpec,
  type DiagEvent,
  type HookAgentStatus,
  type GroupRecord,
  type RemoteSurfaceId,
  type ServerMsg,
  type SessionRecord,
} from '../../shared/remote-host-protocol';
import type { HostStatus, PtyExitInfo, TerminalSnapshot } from '../../shared/remote-hosts-types';
import { initialFsm, publicState, step, type Fsm, type FsmEvent } from './connection-fsm';
import type { PendingIntent, PendingIntents } from './host-config';
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
  socket?: SocketFactory;
  timers?: ClientTimers;
  now?: () => number;
  rand?: () => number;
  log?: (msg: string) => void;
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
      hooks: this.hooks && {
        agents: this.hooks,
        prompt: this.ready && !(this.deps.hooksPromptDeclined?.() ?? false) && this.hooks.some((a) => a.present && !a.installed),
      },
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

  /** Register the status hooks with the server's agents (the user said yes in the app). */
  installHooks(): Promise<{ ok: boolean; error?: string }> {
    if (!this.features.has('hooks')) return Promise.resolve({ ok: false, error: 'this server cannot install hooks; update it, or run `remotea hooks install` there' });
    return this.request((rid) => ({ t: 'hooksInstall', rid }));
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
      this.sendJson({ t: 'hello', proto: PROTO, device: this.deps.device, app: { name: 'remotea', version: this.deps.appVersion } });
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
    for (const intent of this.deps.intents.take(this.hostId)) this.sendIntent(intent);
    for (const surf of this.surfs.values()) {
      if (surf.wanted && surf.state !== 'closed') this.sendOpen(surf);
    }
  }

  private onDown(): void {
    for (const surf of this.surfs.values()) {
      surf.open = false;
      surf.openRid = null;
    }
    for (const [rid, ack] of this.acks) {
      this.acks.delete(rid);
      ack(false, 'disconnected');
    }
  }

  private sendIntent(intent: PendingIntent): void {
    const rid = this.nextRid++;
    switch (intent.t) {
      case 'close': this.sendJson({ t: 'close', rid, id: intent.id as RemoteSurfaceId }); break;
      case 'groupClose': this.sendJson({ t: 'groupClose', rid, id: intent.id as `grp-${string}` }); break;
      case 'hide': this.sendJson({ t: 'hide', rid, id: intent.id as RemoteSurfaceId }); break;
      case 'unhide': this.sendJson({ t: 'unhide', rid, id: intent.id as RemoteSurfaceId }); break;
      case 'sessionUpdate':
        this.sendJson({ t: 'sessionUpdate', rid, id: intent.id as RemoteSurfaceId, groupId: intent.groupId as `grp-${string}` | null | undefined, group: intent.group, title: intent.title });
        break;
      case 'groupUpsert': this.sendJson({ t: 'groupUpsert', rid, group: { id: intent.id as `grp-${string}`, name: intent.name, color: intent.color } }); break;
    }
  }

  /** Send now when connected, otherwise keep it for the next welcome. */
  intent(intent: PendingIntent): void {
    if (this.ready) this.sendIntent(intent);
    else this.deps.intents.add(this.hostId, intent);
  }

  private sendOpen(surf: Surf): void {
    const rid = this.nextRid++;
    surf.openRid = rid;
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
      case 'meta':
        this.deps.onMeta?.(msg.id, { cwd: msg.cwd, agent: msg.agent });
        return;
      case 'hooksStatus':
        this.hooks = msg.hooks;
        diag('conn.hooks', { host: this.hostId, installed: msg.hooks.filter((a) => a.installed).map((a) => a.agent).join(',') });
        this.deps.onStatus(this.status());
        return;
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
        this.deps.onRegistry?.();
        return;
      case 'sessionClosed':
        this.sessions.delete(msg.id);
        this.closedIds.add(msg.id);
        this.markGone(msg.id, { reason: 'closed', by: this.deviceLabel(msg.by) });
        this.deps.onRegistry?.();
        return;
      case 'groupUpserted':
        this.groups.set(msg.group.id, msg.group);
        this.deps.onRegistry?.();
        return;
      case 'groupClosed':
        this.groups.delete(msg.id);
        for (const id of msg.sessionIds) {
          this.sessions.delete(id);
          this.closedIds.add(id);
          this.markGone(id, { reason: 'closed', by: this.deviceLabel(msg.by) });
        }
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
    this.log(`${this.hostId}: open ${msg.id} failed: ${msg.code} ${msg.message}`);
    diag('surf.openError', { host: this.hostId, code: msg.code }, msg.id);
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
      held: [], pendingExit: null, waiters: [], openRid: null, healing: false,
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

  /** Request/response helper for registry operations (phase 2 sync). */
  request(build: (rid: number) => ClientMsg): Promise<{ ok: boolean; error?: string }> {
    const rid = this.nextRid++;
    return new Promise((resolve) => {
      if (!this.sendJson(build(rid))) {
        resolve({ ok: false, error: 'not connected' });
        return;
      }
      this.acks.set(rid, (ok, error) => resolve({ ok, error }));
    });
  }
}
