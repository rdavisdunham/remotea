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
  type ClientMsg,
  type GroupId,
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
import { childrenIndex } from './proc';

export interface HubConfig {
  scrollback: number;
  snapshotScrollback: number;
  ringBytes: number;
  defaultCols: number;
  defaultRows: number;
}

export const DEFAULT_HUB_CONFIG: HubConfig = {
  scrollback: 5000,
  snapshotScrollback: 5000,
  ringBytes: 1024 * 1024,
  defaultCols: 120,
  defaultRows: 32,
};

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

  constructor(private readonly deps: HubDeps) {
    this.cfg = { ...DEFAULT_HUB_CONFIG, ...deps.config };
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? (() => {});
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
    }
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
    const record: SessionRecord = {
      id: msg.id,
      groupId,
      title: spec.title ?? rec?.title,
      cwd: spec.cwd ?? rec?.lastCwd ?? rec?.cwd ?? '~',
      lastCwd: undefined,
      cmd: spec.cmd ?? rec?.cmd,
      createdBy: rec?.createdBy ?? device,
      createdAt: rec?.createdAt ?? this.now(),
      bootId: this.deps.bootId,
      state: 'live',
      agent: rec?.agent,
      hiddenBy: rec?.hiddenBy ?? [],
    };
    let session: TermSession;
    try {
      session = this.makeSession(record, this.deps.spawn, msg.cols, msg.rows, spec.startupCommands);
    } catch (err) {
      conn.sendJson({ t: 'openError', rid: msg.rid, id: msg.id, code: 'spawn-failed', message: err instanceof Error ? err.message : String(err) });
      return;
    }
    this.registry.addSession(record);
    this.broadcast({ t: wasLost ? 'sessionUpdated' : 'sessionAdded', session: record });
    session.attach(conn, { ...attach, created: !wasLost, wasLost });
    this.log(`${wasLost ? 'respawned' : 'created'} ${msg.id} for ${conn.device!.name}`);
  }

  private makeSession(rec: SessionRecord, spawn: SpawnFn | null, cols: number, rows: number, startupCommands?: string[]): TermSession {
    const session = new TermSession({
      id: rec.id,
      bootId: this.deps.bootId,
      cols,
      rows,
      scrollback: this.cfg.scrollback,
      snapshotScrollback: this.cfg.snapshotScrollback,
      ringBytes: this.cfg.ringBytes,
      spawn,
      spawnRequest: { cmd: rec.cmd, cwd: rec.cwd },
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
    const updated = this.registry.updateSession(id, { state: 'exited', exitCode: code, exitedAt: this.now() });
    if (updated) this.broadcast({ t: 'sessionUpdated', session: updated });
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
    if (s && s.hasSubscriber(conn.id)) s.input(conn.id, data);
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
