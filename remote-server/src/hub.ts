/**
 * The server's brain, independent of the transport: connections, live
 * sessions, and the registry, plus every operation a client can request.
 *
 * Every registry change is broadcast to EVERY connection, the originator
 * included. Clients apply these idempotently, so the echo is harmless and the
 * originator never needs a separate "your change landed" path.
 */
import os from 'os';
import {
  PROTO,
  type AgentHandle,
  type ClientMsg,
  type DiagEvent,
  type GroupId,
  type HookAgentStatus,
  type ServerFeature,
  type LostInfo,
  type ProbeStatus,
  type RemoteSurfaceId,
  type ServerMsg,
  type SessionRecord,
} from '../../src/shared/remote-host-protocol';
import { Registry } from './registry';
import { TermSession, type ConnLike, type Timers } from './session';
import type { SpawnFn } from './pty-spawn';
import { DEFAULT_THEME, type ThemeColors } from './queries';
import { probeSession, type ProbeResult } from './agent-probe';
import type { FsRequest } from './remote-fs';
import { childrenIndex } from './proc';
import { AgentStateTracker } from './agent-state';
import { TurnCapture, type TurnFields } from './turn-capture';
import type { ExitBody, SnapshotSurface, StatusBody } from '../../src/shared/eridani-link-protocol';

/**
 * Where the hub's agent events go upward (the Eridani link, via main.ts).
 * Every method is fire-and-forget: the hub never waits on Eridani.
 */
export interface HubEventSink {
  status(s: Omit<StatusBody, 't' | 'op_id' | 'digest' | 'entity'>): void;
  turn(t: TurnFields): void;
  exit(e: Omit<ExitBody, 't' | 'op_id' | 'digest'>): void;
  /** A turn was captured for this conversation: its collector report is worth refreshing. */
  turnCaptured?(provider: 'claude' | 'codex', sessionId: string): void;
}

/** Hook fields that exist for the server alone: never relayed to apps (they can be 16k each). */
const SERVER_ONLY_PARAMS = ['lastAssistantMessage', 'lastAssistantTruncated', 'transcriptPath', 'turnId', 'backgroundTasks', 'permissionMode', 'toolUseId', 'answered', 'annotations', 'answerEcho', 'promptId', 'source'];

export interface HubConfig {
  /** Respawn a lost session's agent with its resume command (`claude --resume <id>`). */
  resumeAgents: boolean;
  scrollback: number;
  snapshotScrollback: number;
  ringBytes: number;
  defaultCols: number;
  defaultRows: number;
}

export const DEFAULT_HUB_CONFIG: HubConfig = {
  resumeAgents: true,
  scrollback: 5000,
  snapshotScrollback: 5000,
  ringBytes: 1024 * 1024,
  defaultCols: 120,
  defaultRows: 32,
};

/** The command that reopens an agent conversation, or null when the provider has none. */
export function resumeCommand(agent: AgentHandle): string | null {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(agent.sessionId)) return null;
  switch (agent.provider) {
    case 'claude': return `claude --resume ${agent.sessionId}`;
    case 'codex': return `codex resume ${agent.sessionId}`;
    default: return null;
  }
}

/** How stale the persisted lastActivityAt may get. */
const ACTIVITY_PERSIST_MS = 30_000;

export interface HubDeps {
  registry: Registry;
  spawn: SpawnFn;
  bootId: string;
  serverId: string;
  hostname?: string;
  config?: Partial<HubConfig>;
  timers?: Timers;
  now?: () => number;
  log?: (msg: string) => void;
  /** Injectable for tests; defaults to reading /proc. */
  probe?: (pid: number, index: Map<number, number[]>) => ProbeResult;
  /** Extra environment for every spawned session (the hook bridge's address and token). */
  sessionEnv?: (id: string) => Record<string, string>;
  /** Where app diagnostics go; absent = the server does not offer 'diag'. */
  diag?: (device: { id: string; name: string }, events: DiagEvent[]) => void;
  /** The explorer's file operations on a session's folder (remote-fs.ts); absent = no 'fs'. */
  fs?: (cwd: string | undefined, req: FsRequest) => Promise<unknown>;
  /** The agents' status hooks (hooks-install.ts); absent = the server does not offer 'hooks'. */
  hooks?: { status(): HookAgentStatus[]; install(): HookAgentStatus[] };
  /** Upward agent events (status, turns, exits); absent = nobody listens. Settable later via setSink. */
  sink?: HubEventSink | null;
}

/** What the Eridani side plugs into the hub (dispatch.ts); every member optional. */
export interface HubEridaniHooks {
  /** Extra environment for a session (a run's ERIDANI_* and token). Applied under the hook identity. */
  env?(id: string): Record<string, string> | undefined;
  /** The command that reopens a lost session, before the default `claude --resume <id>`. */
  resumeCommand?(rec: SessionRecord): string | null | undefined;
  /** A session's process ended (also during shutdown is NOT reported). */
  exited?(id: string, code: number): void;
  /** A hook event was relayed for a live session. */
  hook?(id: string, params: Record<string, unknown>): void;
  /** Extra snapshot fields for a surface (open question ids). */
  snapshot?(id: string): Partial<SnapshotSurface>;
}

export interface HubConn extends ConnLike {
  /** Set by hello. Messages before it are rejected. */
  device: { id: string; name: string } | null;
  close(code: number, reason: string): void;
}

export class Hub {
  readonly conns = new Map<number, HubConn>();
  readonly sessions = new Map<string, TermSession>();
  private theme: ThemeColors = DEFAULT_THEME;
  private shuttingDown = false;
  private readonly cfg: HubConfig;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;
  readonly agentState: AgentStateTracker;
  readonly turns: TurnCapture;
  private sink: HubEventSink | null;
  private eridani: HubEridaniHooks = {};
  /** The last `permission_mode` a hook reported, per surface (effective_permission_mode). */
  private readonly permissionMode = new Map<string, string>();
  /** Status revisions: monotonic across restarts (seeded from the clock), so a spooled older one never wins. */
  private statusRev: number;

  constructor(private readonly deps: HubDeps) {
    this.cfg = { ...DEFAULT_HUB_CONFIG, ...deps.config };
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? (() => {});
    this.sink = deps.sink ?? null;
    this.statusRev = this.now();
    this.agentState = new AgentStateTracker({
      now: this.now,
      onChange: ({ surf, info }) => {
        const rec = this.registry.updateSession(surf, { agentState: info });
        if (!rec) return;
        this.broadcast({ t: 'meta', id: surf as RemoteSurfaceId, agentState: info });
        this.statusRev = Math.max(this.statusRev + 1, this.now());
        this.sink?.status({
          surf,
          incarnation: rec.incarnation ?? 0,
          revision: this.statusRev,
          state: info.state,
          since: info.since,
          ...(info.reason ? { reason: info.reason } : {}),
          ...(rec.agent ? { provider: rec.agent.provider, provider_session_id: rec.agent.sessionId } : {}),
          ...(this.permissionMode.has(surf) ? { effective_permission_mode: this.permissionMode.get(surf) } : {}),
        });
      },
    });
    this.turns = new TurnCapture({
      session: (id) => this.registry.session(id),
      update: (id, patch) => void this.registry.updateSession(id, patch),
      emit: (t) => this.sink?.turn(t),
      binding: (id) => {
        const b = this.registry.session(id)?.eridani;
        return b ? { runId: b.runId, generation: b.generation } : null;
      },
      now: this.now,
      log: (m) => this.log(m),
    });
  }

  setSink(sink: HubEventSink | null): void {
    this.sink = sink;
  }

  setEridani(hooks: HubEridaniHooks | null): void {
    this.eridani = hooks ?? {};
  }

  /** Every session the registry knows, for the Eridani reconcile snapshot. */
  snapshot(): SnapshotSurface[] {
    return this.registry.sessions().map((r) => ({
      surf: r.id,
      incarnation: r.incarnation ?? 0,
      state: r.state === 'live' && this.isLive(r.id) ? 'live' : r.state === 'exited' ? 'exited' : 'lost',
      agent_state: r.agentState?.state ?? null,
      since: r.agentState?.since ?? null,
      provider: r.agent?.provider ?? null,
      provider_session_id: r.agent?.sessionId ?? null,
      group: r.groupId ?? null,
      title: r.title ?? null,
      cwd: r.lastCwd ?? r.cwd,
      turn_seq: r.turnSeq ?? 0,
      run_id: r.eridani?.runId ?? null,
      generation: r.eridani?.generation ?? 0,
      ...(r.eridani ? {
        task_id: r.eridani.taskId,
        target: r.eridani.target,
        worktree: r.eridani.worktree,
        branch: r.eridani.branch,
        stop_requested: !!r.eridani.stopRequested,
      } : {}),
      ...this.eridani.snapshot?.(r.id),
    }));
  }

  private get registry(): Registry {
    return this.deps.registry;
  }

  // ── Connections ──────────────────────────────────────────────────────────

  connect(conn: HubConn): void {
    this.conns.set(conn.id, conn);
  }

  /** A dropped socket is a detach, never a kill: the processes keep running. */
  disconnect(conn: HubConn): void {
    this.conns.delete(conn.id);
    for (const s of this.sessions.values()) s.detach(conn.id);
  }

  broadcast(msg: ServerMsg): void {
    for (const c of this.conns.values()) if (c.device) c.sendJson(msg);
  }

  handle(conn: HubConn, msg: ClientMsg): void {
    if (msg.t === 'hello') return this.hello(conn, msg);
    if (!conn.device) {
      conn.sendJson({ t: 'error', code: 'no-hello', message: 'hello must be the first message' });
      conn.close(4002, 'no hello');
      return;
    }
    const device = conn.device.id;
    switch (msg.t) {
      case 'open': return this.open(conn, msg);
      case 'detach':
        for (const id of msg.ids) this.sessions.get(id)?.detach(conn.id);
        return;
      case 'close': return this.close(conn, msg.rid, msg.id);
      case 'resize': this.sessions.get(msg.id)?.resize(conn.id, msg.cols, msg.rows); return;
      case 'claim': this.sessions.get(msg.id)?.claim(conn.id); return;
      case 'deliver': this.sessions.get(msg.id)?.deliver(msg.commands); return;
      case 'probe': return this.probe(conn, msg);
      case 'groupUpsert': {
        const res = this.registry.upsertGroup(msg.group.id, msg.group, device);
        if (res?.changed) this.broadcast({ t: 'groupUpserted', group: res.group });
        conn.sendJson({ t: 'ack', rid: msg.rid, ok: !!res, error: res ? undefined : 'group closed' });
        return;
      }
      case 'groupClose': return this.groupClose(conn, msg.rid, msg.id);
      case 'sessionUpdate': return this.sessionUpdate(conn, msg);
      case 'hide':
      case 'unhide': return this.setHidden(conn, msg.rid, msg.id, msg.t === 'hide');
      case 'theme':
        this.theme = { fg: msg.fg, bg: msg.bg, cursor: msg.cursor };
        return;
      case 'ping':
        conn.sendJson({ t: 'pong', n: msg.n, serverAt: this.now() });
        return;
      case 'diag':
        this.deps.diag?.(conn.device, msg.events);
        return;
      case 'hooksInstall':
        return this.installHooks(conn, msg.rid);
      case 'fs':
        return void this.fsOp(conn, msg);
    }
  }

  private features(): ServerFeature[] {
    const f: ServerFeature[] = ['rpc'];
    if (this.deps.diag) f.push('diag');
    if (this.deps.hooks) f.push('hooks');
    if (this.deps.fs) f.push('fs');
    return f;
  }

  private hookStatus(): HookAgentStatus[] | undefined {
    try {
      return this.deps.hooks?.status();
    } catch (err) {
      this.log(`hooks status: ${(err as Error).message}`);
      return undefined;
    }
  }

  /**
   * A remote pane's explorer: run the operation in that session's folder —
   * where its process is now (the /proc probe), else where it started. Only for
   * a session this device may see.
   */
  private async fsOp(conn: HubConn, msg: Extract<ClientMsg, { t: 'fs' }>): Promise<void> {
    const rec = this.registry.session(msg.id);
    let result: unknown;
    if (!this.deps.fs) result = { error: 'This server has no file access for remote panes', code: 'read_failed' };
    else if (!rec || rec.hiddenBy.includes(conn.device!.id) || !this.isLive(msg.id)) result = { error: 'No working directory reported for this pane', code: 'no_root' };
    else {
      try {
        result = await this.deps.fs(rec.lastCwd ?? rec.cwd, msg);
      } catch (err) {
        result = { error: (err as Error).message, code: 'read_failed' };
      }
    }
    conn.sendJson({ t: 'fsResult', rid: msg.rid, result });
  }

  /** The user asked, in an app, for the agents' status hooks: install, and tell every device. */
  private installHooks(conn: HubConn, rid: number): void {
    if (!this.deps.hooks) {
      conn.sendJson({ t: 'ack', rid, ok: false, error: 'this server cannot install hooks' });
      return;
    }
    try {
      const hooks = this.deps.hooks.install();
      this.log(`agent hooks installed at the request of ${conn.device?.name}`);
      this.broadcast({ t: 'hooksStatus', hooks });
      conn.sendJson({ t: 'ack', rid, ok: true });
    } catch (err) {
      conn.sendJson({ t: 'ack', rid, ok: false, error: (err as Error).message });
    }
  }

  /**
   * An agent in session `id` reported status through the hook bridge: relay it
   * to every app showing that session, and keep it for apps that attach later.
   * Returns false when there is no such live session.
   */
  relayRpc(id: string, method: string, params: Record<string, unknown>): boolean {
    const session = this.sessions.get(id);
    if (!session || session.state !== 'live') return false;
    let relayed = params;
    if (method === 'hook.event' && SERVER_ONLY_PARAMS.some((k) => k in params)) {
      relayed = { ...params };
      for (const k of SERVER_ONLY_PARAMS) delete relayed[k];
    }
    session.relayRpc(method, relayed);
    // A hook's session id is the agent's own word for which conversation this
    // is — better than the /proc probe's inference, and it arrives at once.
    if (method === 'hook.event' && typeof params.sessionId === 'string' && params.event !== 'SessionEnd') {
      const provider = params.provider === 'codex' ? 'codex' : params.provider ? null : 'claude';
      if (provider) this.noteAgent(id, { provider, sessionId: params.sessionId, seenAt: this.now() });
    }
    if (method === 'hook.event' && typeof params.permissionMode === 'string' && /^[A-Za-z]{1,32}$/.test(params.permissionMode)) {
      this.permissionMode.set(id, params.permissionMode);
    }
    this.agentState.rpc(id, method, params);
    if (method === 'hook.event') {
      const captured = this.turns.hook(id, params);
      if (captured) this.sink?.turnCaptured?.(captured.provider, captured.sessionId);
      this.eridani.hook?.(id, params);
    }
    return true;
  }

  private hello(conn: HubConn, msg: Extract<ClientMsg, { t: 'hello' }>): void {
    if (msg.proto !== PROTO) {
      conn.sendJson({ t: 'error', code: 'incompatible', message: `server speaks protocol ${PROTO}, client ${msg.proto}` });
      conn.close(4003, 'incompatible protocol');
      return;
    }
    conn.device = { id: msg.device.id, name: msg.device.name };
    this.registry.touchDevice(msg.device.id, msg.device.name);
    conn.sendJson({
      t: 'welcome',
      proto: PROTO,
      serverId: this.deps.serverId,
      bootId: this.deps.bootId,
      epoch: this.registry.epoch,
      hostname: this.deps.hostname ?? os.hostname(),
      you: msg.device.id,
      groups: this.registry.groups(),
      sessions: this.registry.sessions(),
      features: this.features(),
      hooks: this.hookStatus(),
    });
    this.log(`hello from ${msg.device.name} (${msg.device.id}) ${msg.app.name} ${msg.app.version}`);
  }

  // ── Sessions ─────────────────────────────────────────────────────────────

  private open(conn: HubConn, msg: Extract<ClientMsg, { t: 'open' }>): void {
    const device = conn.device!.id;
    const tomb = this.registry.sessionTombstone(msg.id);
    if (tomb) {
      conn.sendJson({ t: 'openError', rid: msg.rid, id: msg.id, code: 'closed', by: tomb.by, message: `closed on ${this.registry.deviceName(tomb.by)}` });
      return;
    }
    const rec = this.registry.session(msg.id);
    if (rec?.hiddenBy.includes(device)) {
      conn.sendJson({ t: 'openError', rid: msg.rid, id: msg.id, code: 'hidden', message: 'hidden on this device' });
      return;
    }
    const attach = { rid: msg.rid, cols: msg.cols, rows: msg.rows, sinceSeq: msg.sinceSeq, bootId: msg.bootId };

    const live = this.sessions.get(msg.id);
    if (live) {
      live.attach(conn, { ...attach, created: false });
      return;
    }

    if (rec && rec.state === 'exited') {
      // Exited in a previous boot: nothing to run, but the tab still needs a terminal to show.
      const dead = this.makeSession(rec, null, msg.cols, msg.rows);
      dead.exitCode = rec.exitCode;
      dead.attach(conn, { ...attach, created: false });
      return;
    }

    if (rec && !msg.create) {
      // live-without-process cannot happen within a boot; both mean "lost".
      conn.sendJson({ t: 'openError', rid: msg.rid, id: msg.id, code: 'lost', last: this.registry.lostInfo(msg.id), message: 'session was lost when the server restarted' });
      return;
    }
    if (!rec && !msg.create) {
      conn.sendJson({ t: 'openError', rid: msg.rid, id: msg.id, code: 'lost', message: 'unknown session' });
      return;
    }

    // Create — brand new, or respawning a lost one in place.
    const spec = msg.create!;
    const wasLost = !!rec;
    const { groupId, created: newGroup } = this.registry.resolveGroup(spec.groupId ?? rec?.groupId ?? null, spec.group, device);
    if (newGroup) this.broadcast({ t: 'groupUpserted', group: newGroup });
    // A respawn keeps what the server knew about the session (where it was,
    // what it ran); the client's spec only fills gaps.
    const record: SessionRecord = {
      id: msg.id,
      groupId,
      title: rec?.title ?? spec.title,
      cwd: rec ? rec.lastCwd ?? rec.cwd : spec.cwd ?? '~',
      lastCwd: undefined,
      cmd: rec ? rec.cmd : spec.cmd,
      createdBy: rec?.createdBy ?? device,
      createdAt: rec?.createdAt ?? this.now(),
      bootId: this.deps.bootId,
      state: 'live',
      agent: rec?.agent,
      hiddenBy: rec?.hiddenBy ?? [],
      // A respawn is a new process on the same surface: a new incarnation, the same turn numbering.
      incarnation: (rec?.incarnation ?? 0) + 1,
      turnSeq: rec?.turnSeq,
      turnCursor: rec?.turnCursor,
      eridani: rec?.eridani,
    };
    this.agentState.reset(msg.id);
    // Resuming the agent that was running beats re-running the original
    // command: a lost Claude session comes back as `claude --resume <id>`
    // (an Eridani run's keeps its model and permission mode: dispatch.ts).
    // `null` from the Eridani hook means "do not resume": a login shell in the
    // worktree, never the original command (it would start the run over).
    const custom = wasLost && rec ? this.eridani.resumeCommand?.(rec) : undefined;
    const resume = custom !== undefined ? custom : wasLost && this.cfg.resumeAgents && rec?.agent ? resumeCommand(rec.agent) : null;
    const spawnCmd = custom !== undefined ? custom ?? undefined : resume && record.cmd ? resume : record.cmd;
    const startup = custom !== undefined ? undefined : resume && !record.cmd ? [resume] : spec.startupCommands;
    let session: TermSession;
    try {
      session = this.makeSession(record, this.deps.spawn, msg.cols, msg.rows, startup, spawnCmd, wasLost ? undefined : spec.env);
    } catch (err) {
      conn.sendJson({ t: 'openError', rid: msg.rid, id: msg.id, code: 'spawn-failed', message: err instanceof Error ? err.message : String(err) });
      return;
    }
    this.registry.addSession(record);
    this.broadcast({ t: wasLost ? 'sessionUpdated' : 'sessionAdded', session: record });
    session.attach(conn, { ...attach, created: !wasLost, wasLost });
    this.log(`${wasLost ? 'respawned' : 'created'} ${msg.id} for ${conn.device!.name}`);
  }

  /**
   * The environment: the client's spec.env (a new session only; it is not
   * persisted, so a respawn does not see it), then the run's ERIDANI_* (from
   * dispatch), then the hook identity, which nothing can override.
   */
  private makeSession(rec: SessionRecord, spawn: SpawnFn | null, cols: number, rows: number, startupCommands?: string[], cmd = rec.cmd, specEnv?: Record<string, string>): TermSession {
    const env = { ...specEnv, ...this.eridani.env?.(rec.id), ...this.deps.sessionEnv?.(rec.id) };
    const session = new TermSession({
      id: rec.id,
      bootId: this.deps.bootId,
      cols,
      rows,
      scrollback: this.cfg.scrollback,
      snapshotScrollback: this.cfg.snapshotScrollback,
      ringBytes: this.cfg.ringBytes,
      spawn,
      spawnRequest: { cmd, cwd: rec.cwd, env: Object.keys(env).length ? env : undefined },
      startupCommands,
      theme: () => this.theme,
      timers: this.deps.timers,
      log: (m) => this.log(`${rec.id}: ${m}`),
      onExit: (code) => this.onSessionExit(rec.id, code),
    });
    this.sessions.set(rec.id, session);
    return session;
  }

  private onSessionExit(id: RemoteSurfaceId, code: number): void {
    // A shutdown's hangups are not the program exiting on its own: the record
    // stays `live` with this boot's id, so the next boot reports it `lost`
    // and clients respawn (and resume) it.
    if (this.shuttingDown) return;
    const exitedAt = this.now();
    const updated = this.registry.updateSession(id, { state: 'exited', exitCode: code, exitedAt });
    if (updated) this.broadcast({ t: 'sessionUpdated', session: updated });
    this.agentState.exit(id, code);
    this.permissionMode.delete(id);
    if (updated) this.sink?.exit({ surf: id, incarnation: updated.incarnation ?? 0, code, exited_at: exitedAt });
    this.eridani.exited?.(id, code);
  }

  /**
   * Write to a live session's terminal on Eridani's behalf. Not a person's
   * input: it claims no size, and it never clears a question (C07).
   */
  inject(id: string, data: string): boolean {
    const s = this.sessions.get(id);
    if (!s || s.state !== 'live') return false;
    s.write(data);
    return true;
  }

  /** End a session's process tree (SIGHUP, SIGKILL after a grace) without closing the session. */
  killProcess(id: string): boolean {
    const s = this.sessions.get(id);
    if (!s || s.state !== 'live') return false;
    s.kill();
    return true;
  }

  /** Persist and announce a record change made outside a client request (dispatch.ts). */
  updateRecord(id: string, patch: Partial<SessionRecord>): SessionRecord | undefined {
    const updated = this.registry.updateSession(id, patch);
    if (updated) this.broadcast({ t: 'sessionUpdated', session: updated });
    return updated;
  }

  /** Close everywhere. Idempotent; a second close of the same id is acked without a broadcast. */
  private close(conn: HubConn, rid: number, id: RemoteSurfaceId): void {
    const device = conn.device!.id;
    const alreadyClosed = !!this.registry.sessionTombstone(id);
    this.killSession(id);
    this.registry.closeSession(id, device);
    if (!alreadyClosed) this.broadcast({ t: 'sessionClosed', id, by: device, reason: 'closed' });
    conn.sendJson({ t: 'ack', rid, ok: true });
  }

  private groupClose(conn: HubConn, rid: number, id: GroupId): void {
    const device = conn.device!.id;
    if (this.registry.groupTombstone(id)) {
      conn.sendJson({ t: 'ack', rid, ok: true });
      return;
    }
    const removed = this.registry.closeGroup(id, device);
    for (const sid of removed) this.killSession(sid);
    this.broadcast({ t: 'groupClosed', id, sessionIds: removed, by: device });
    conn.sendJson({ t: 'ack', rid, ok: true });
  }

  private killSession(id: string): void {
    const s = this.sessions.get(id);
    this.agentState.forget(id);
    if (!s) return;
    this.sessions.delete(id);
    s.kill();
    s.dispose();
  }

  private sessionUpdate(conn: HubConn, msg: Extract<ClientMsg, { t: 'sessionUpdate' }>): void {
    const device = conn.device!.id;
    const rec = this.registry.session(msg.id);
    if (!rec) {
      conn.sendJson({ t: 'ack', rid: msg.rid, ok: false, error: 'unknown session' });
      return;
    }
    const patch: Partial<SessionRecord> = {};
    if (msg.groupId !== undefined) {
      const { groupId, created } = this.registry.resolveGroup(msg.groupId, msg.group, device);
      if (created) this.broadcast({ t: 'groupUpserted', group: created });
      patch.groupId = groupId;
    }
    if (msg.title !== undefined) patch.title = msg.title ?? undefined;
    const updated = this.registry.updateSession(msg.id, patch)!;
    this.broadcast({ t: 'sessionUpdated', session: updated });
    conn.sendJson({ t: 'ack', rid: msg.rid, ok: true });
  }

  private setHidden(conn: HubConn, rid: number, id: RemoteSurfaceId, hidden: boolean): void {
    const device = conn.device!.id;
    const updated = this.registry.setHidden(id, device, hidden);
    if (!updated) {
      conn.sendJson({ t: 'ack', rid, ok: false, error: 'unknown session' });
      return;
    }
    if (hidden) {
      // Stop streaming to every connection of the device that hid it.
      const s = this.sessions.get(id);
      if (s) for (const c of this.conns.values()) if (c.device?.id === device) s.detach(c.id);
    }
    this.broadcast({ t: 'sessionUpdated', session: updated });
    conn.sendJson({ t: 'ack', rid, ok: true });
  }

  private probe(conn: HubConn, msg: Extract<ClientMsg, { t: 'probe' }>): void {
    const status: Record<string, ProbeStatus> = {};
    const last: Record<string, LostInfo> = {};
    for (const id of msg.ids) {
      const rec = this.registry.session(id);
      if (rec) {
        status[id] = rec.state;
        if (rec.state === 'lost') last[id] = this.registry.lostInfo(id)!;
      } else {
        status[id] = this.registry.sessionTombstone(id) ? 'closed' : 'unknown';
      }
    }
    let groupStatus: Record<string, 'live' | 'closed' | 'unknown'> | undefined;
    if (msg.groups) {
      groupStatus = {};
      for (const g of msg.groups) {
        groupStatus[g] = this.registry.group(g) ? 'live' : this.registry.groupTombstone(g) ? 'closed' : 'unknown';
      }
    }
    conn.sendJson({ t: 'probed', rid: msg.rid, status, last, groupStatus });
  }

  handleInput(conn: HubConn, id: string, data: string): void {
    if (!conn.device) return;
    const s = this.sessions.get(id);
    if (s && s.hasSubscriber(conn.id)) {
      s.input(conn.id, data);
      this.agentState.humanInput(id, data);
    }
  }

  // ── Periodic work ────────────────────────────────────────────────────────

  pumpLagging(): void {
    for (const s of this.sessions.values()) s.pumpLagging();
  }

  /** Refresh cwd / foreground command / agent identity from /proc and publish changes. */
  probeAgents(): void {
    const probe = this.deps.probe ?? ((pid, index) => probeSession(pid, { index }));
    let index: Map<number, number[]> | null = null;
    for (const s of this.sessions.values()) {
      const pid = s.pid;
      if (!pid) continue;
      index ??= this.deps.probe ? new Map() : childrenIndex();
      const res = probe(pid, index);
      const rec = this.registry.session(s.id);
      if (!rec) continue;
      // Activity is persisted coarsely: precise enough for "last active", cheap on disk.
      if (s.lastActivityAt - (rec.lastActivityAt ?? 0) >= ACTIVITY_PERSIST_MS) {
        this.registry.updateSession(s.id, { lastActivityAt: s.lastActivityAt });
      }
      const cwdChanged = !!res.cwd && res.cwd !== rec.lastCwd;
      const agentChanged = !!res.agent && res.agent.sessionId !== rec.agent?.sessionId;
      if (!cwdChanged && !agentChanged) continue;
      this.registry.updateSession(s.id, {
        lastCwd: res.cwd ?? rec.lastCwd,
        agent: agentChanged ? res.agent : rec.agent,
      });
      this.broadcast({ t: 'meta', id: s.id as RemoteSurfaceId, cwd: res.cwd, fg: res.fg, agent: agentChanged ? res.agent : undefined });
    }
  }

  /** A session whose process is running here now. */
  isLive(id: string): boolean {
    return this.sessions.get(id)?.state === 'live';
  }

  private noteAgent(id: string, agent: AgentHandle): void {
    const rec = this.registry.session(id);
    if (!rec || (rec.agent?.sessionId === agent.sessionId && rec.agent.provider === agent.provider)) return;
    this.registry.updateSession(id, { agent });
    this.broadcast({ t: 'meta', id: id as RemoteSurfaceId, agent });
  }

  prune(): void {
    for (const id of this.registry.prune()) {
      this.killSession(id);
      this.broadcast({ t: 'sessionClosed', id, by: 'server', reason: 'closed' });
    }
  }

  /** Server shutdown: tell clients, persist, and hang up every session. */
  shutdown(): void {
    this.shuttingDown = true;
    this.broadcast({ t: 'goingAway' });
    for (const s of this.sessions.values()) {
      s.kill();
      s.dispose();
    }
    this.sessions.clear();
    this.registry.saveNow();
  }
}
