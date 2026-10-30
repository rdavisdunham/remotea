/**
 * The PTY keeper (docs/remotea/upgrade.md): owns the session processes so the
 * server can restart without hanging them up.
 *
 * Deliberately small. It starts what the server asks (file, args, cwd, env as
 * given), numbers and rings each session's output, stores an opaque
 * checkpoint, and streams output to one owner at a time. It never parses
 * terminal output and never decides anything about a session's life: only an
 * owner's `kill`/`close`, the process exiting, or the keeper being stopped
 * ends one.
 */
import fs from 'fs';
import net from 'net';
import type { PtyLike } from '../pty-spawn';
import { Ring } from '../ring';
import { descendants, isSignalablePid, signalTree } from '../proc';
import {
  KEEPER_PROTO,
  LineReader,
  encodeLine,
  type ClientToKeeper,
  type KeeperAttached,
  type KeeperSessionInfo,
  type KeeperSpawnSpec,
  type KeeperToClient,
} from './protocol';

export type KeeperSpawn = (spec: KeeperSpawnSpec) => PtyLike;

export interface KeeperOptions {
  sock: string;
  spawn: KeeperSpawn;
  version: string;
  /** Exit after this long with no owner and no live session. */
  idleMs: number;
  /** Called when idle long enough (the entry point exits). */
  onIdle: () => void;
  log?: (msg: string) => void;
  now?: () => number;
  /** How often idleness is checked. */
  checkMs?: number;
  /** Grace between the hangup and SIGKILL of `close`. */
  killGraceMs?: number;
}

const DEFAULT_RING = 1024 * 1024;
/** Owner socket backlog that pauses every PTY until it drains. */
const BACKLOG_HIGH = 4 * 1024 * 1024;

interface Sess {
  id: string;
  pty: PtyLike;
  pid: number;
  alive: boolean;
  exitCode: number | null;
  signal: number | null;
  cols: number;
  rows: number;
  startedAt: number;
  lastOutputAt: number | null;
  seq: number;
  ring: Ring;
  checkpoint: { seq: number; data: string } | null;
  /** The owner has attached it (spawned, or attach): its output and exit are streamed. */
  attached: boolean;
  ownerPaused: boolean;
  ptyPaused: boolean;
  forgetOnExit: boolean;
  killTimer: NodeJS.Timeout | null;
}

interface Client {
  sock: net.Socket;
  role: 'owner' | 'observer' | null;
  pid: number | null;
  since: number;
}

export class KeeperServer {
  readonly sessions = new Map<string, Sess>();
  private server: net.Server | null = null;
  private owner: Client | null = null;
  private readonly clients = new Set<Client>();
  private backlogPaused = false;
  private idleSince: number | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  readonly startedAt: number;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;

  constructor(private readonly opts: KeeperOptions) {
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => {});
    this.startedAt = this.now();
  }

  /** Listen on the socket. Refuses (throws) when another keeper already answers there. */
  async listen(): Promise<void> {
    const { sock } = this.opts;
    if (fs.existsSync(sock)) {
      if (await answers(sock)) throw new Error(`another pty keeper is listening on ${sock}`);
      fs.rmSync(sock, { force: true });
    }
    const server = net.createServer((s) => this.accept(s));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(sock, () => {
        server.off('error', reject);
        resolve();
      });
    });
    try {
      fs.chmodSync(sock, 0o600);
    } catch {
      /* the directory is 0700 anyway */
    }
    this.server = server;
    this.idleTimer = setInterval(() => this.checkIdle(), this.opts.checkMs ?? 30_000);
    this.idleTimer.unref?.();
  }

  /** Stop listening (the sessions keep running until `hangupAll`). */
  async close(): Promise<void> {
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.idleTimer = null;
    for (const c of this.clients) c.sock.destroy();
    this.clients.clear();
    this.owner = null;
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((r) => server.close(() => r()));
    try {
      fs.rmSync(this.opts.sock, { force: true });
    } catch {
      /* gone */
    }
  }

  /** Hang up every live session; resolves once all exited or after `ms`. */
  hangupAll(ms = 3000): Promise<void> {
    const live = [...this.sessions.values()].filter((s) => s.alive);
    for (const s of live) this.hangup(s);
    if (!live.length) return Promise.resolve();
    return new Promise((resolve) => {
      const t0 = this.now();
      const tick = setInterval(() => {
        if (live.every((s) => !s.alive) || this.now() - t0 >= ms) {
          clearInterval(tick);
          resolve();
        }
      }, 50);
    });
  }

  info(s: Sess): KeeperSessionInfo {
    return {
      id: s.id, pid: s.pid, alive: s.alive, exitCode: s.exitCode, signal: s.signal, cols: s.cols, rows: s.rows,
      startedAt: s.startedAt, lastOutputAt: s.lastOutputAt, seq: s.seq, ringBytes: s.ring.size, checkpointSeq: s.checkpoint?.seq ?? null,
    };
  }

  // ── Idleness ─────────────────────────────────────────────────────────────

  checkIdle(): void {
    const busy = this.owner !== null || [...this.sessions.values()].some((s) => s.alive);
    if (busy) {
      this.idleSince = null;
      return;
    }
    this.idleSince ??= this.now();
    if (this.now() - this.idleSince >= this.opts.idleMs) {
      this.log(`idle for ${Math.round((this.now() - this.idleSince) / 1000)} s with no owner and no live session; exiting`);
      this.opts.onIdle();
    }
  }

  // ── Connections ──────────────────────────────────────────────────────────

  private accept(sock: net.Socket): void {
    const c: Client = { sock, role: null, pid: null, since: this.now() };
    this.clients.add(c);
    sock.setEncoding('utf8');
    const reader = new LineReader((line) => {
      let msg: ClientToKeeper;
      try {
        msg = JSON.parse(line) as ClientToKeeper;
      } catch {
        sock.destroy();
        return;
      }
      try {
        this.onMessage(c, msg);
      } catch (err) {
        this.log(`request ${String((msg as { t?: unknown }).t)} failed: ${(err as Error).message}`);
        const rid = (msg as { rid?: unknown }).rid;
        this.send(c, { t: 'error', ...(typeof rid === 'number' ? { rid } : {}), message: (err as Error).message });
      }
    });
    sock.on('data', (d: string) => {
      if (!reader.push(d)) sock.destroy();
    });
    sock.on('drain', () => {
      if (c === this.owner && this.backlogPaused) {
        this.backlogPaused = false;
        for (const s of this.sessions.values()) this.applyPause(s);
      }
    });
    sock.on('error', () => {});
    sock.on('close', () => {
      this.clients.delete(c);
      if (this.owner === c) this.ownerGone('disconnected');
    });
  }

  private ownerGone(why: string): void {
    const pid = this.owner?.pid;
    this.owner = null;
    this.backlogPaused = false;
    for (const s of this.sessions.values()) {
      s.attached = false;
      s.ownerPaused = false;
      this.applyPause(s);
    }
    this.log(`owner${pid ? ` pid ${pid}` : ''} ${why}; ${[...this.sessions.values()].filter((s) => s.alive).length} live session(s) kept`);
  }

  private send(c: Client, msg: KeeperToClient): void {
    if (c.sock.destroyed) return;
    const ok = c.sock.write(encodeLine(msg));
    if (!ok && c === this.owner && c.sock.writableLength > BACKLOG_HIGH && !this.backlogPaused) {
      this.backlogPaused = true;
      for (const s of this.sessions.values()) this.applyPause(s);
    }
  }

  private welcome(prevOwner: Client | null): KeeperToClient {
    return {
      t: 'welcome',
      proto: KEEPER_PROTO,
      pid: process.pid,
      version: this.opts.version,
      startedAt: this.startedAt,
      owner: prevOwner ? { pid: prevOwner.pid, since: prevOwner.since } : null,
      sessions: [...this.sessions.values()].map((s) => this.info(s)),
    };
  }

  private onMessage(c: Client, msg: ClientToKeeper): void {
    if (c.role === null) {
      if (msg.t !== 'hello') {
        c.sock.destroy();
        return;
      }
      if (msg.proto !== KEEPER_PROTO) {
        // A newer server keeps speaking proto 1 to this keeper; only an incompatible change bumps it.
        this.send(c, { t: 'incompatible', proto: KEEPER_PROTO, message: `keeper speaks protocol ${KEEPER_PROTO}, client ${msg.proto}` });
        c.sock.end();
        return;
      }
      c.pid = typeof msg.pid === 'number' ? msg.pid : null;
      if (msg.role === 'observer') {
        c.role = 'observer';
        this.send(c, this.welcome(this.owner));
        c.sock.end();
        return;
      }
      const prev = this.owner;
      if (prev) {
        this.send(prev, { t: 'replaced' });
        prev.sock.end();
        this.clients.delete(prev);
        this.ownerGone(`replaced by pid ${c.pid ?? '?'}`);
      }
      c.role = 'owner';
      c.since = this.now();
      this.owner = c;
      this.idleSince = null;
      this.log(`owner pid ${c.pid ?? '?'} (${typeof msg.client === 'string' ? msg.client.slice(0, 60) : 'client'}) attached`);
      this.send(c, this.welcome(prev));
      return;
    }
    if (c !== this.owner) return;
    switch (msg.t) {
      case 'spawn': return this.spawn(c, msg);
      case 'attach': return this.attach(c, msg.rid, msg.id);
      case 'list':
        this.send(c, { t: 'listed', rid: msg.rid, sessions: [...this.sessions.values()].map((s) => this.info(s)) });
        return;
      case 'ping':
        this.send(c, { t: 'pong', rid: msg.rid });
        return;
      case 'write': {
        const s = this.sessions.get(msg.id);
        if (s?.alive && typeof msg.data === 'string') s.pty.write(msg.data);
        return;
      }
      case 'resize': {
        const s = this.sessions.get(msg.id);
        if (!s?.alive || !(msg.cols > 0 && msg.rows > 0)) return;
        try {
          s.pty.resize(msg.cols, msg.rows);
          s.cols = msg.cols;
          s.rows = msg.rows;
        } catch {
          /* exited between checks */
        }
        return;
      }
      case 'pause':
      case 'resume': {
        const s = this.sessions.get(msg.id);
        if (!s) return;
        s.ownerPaused = msg.t === 'pause';
        this.applyPause(s);
        return;
      }
      case 'kill': {
        const s = this.sessions.get(msg.id);
        if (!s?.alive) return;
        try {
          s.pty.kill(typeof msg.signal === 'string' ? msg.signal : 'SIGHUP');
        } catch {
          /* gone */
        }
        return;
      }
      case 'close': {
        const s = this.sessions.get(msg.id);
        if (!s) return;
        if (!s.alive) this.sessions.delete(s.id);
        else this.hangup(s);
        return;
      }
      case 'forget': {
        const s = this.sessions.get(msg.id);
        if (!s) return;
        if (s.alive) s.forgetOnExit = true;
        else this.sessions.delete(s.id);
        return;
      }
      case 'checkpoint': {
        const s = this.sessions.get(msg.id);
        if (s && typeof msg.data === 'string' && Number.isInteger(msg.seq) && msg.seq >= 0 && msg.seq <= s.seq) s.checkpoint = { seq: msg.seq, data: msg.data };
        return;
      }
      default: {
        const rid = (msg as { rid?: unknown }).rid;
        if (typeof rid === 'number') this.send(c, { t: 'error', rid, message: `unknown request ${String((msg as { t?: unknown }).t).slice(0, 40)}` });
      }
    }
  }

  // ── Sessions ─────────────────────────────────────────────────────────────

  private spawn(c: Client, msg: Extract<ClientToKeeper, { t: 'spawn' }>): void {
    const existing = this.sessions.get(msg.id);
    if (existing?.alive) {
      this.send(c, { t: 'error', rid: msg.rid, id: msg.id, message: 'a live session with this id exists' });
      return;
    }
    let pty: PtyLike;
    try {
      pty = this.opts.spawn(msg);
    } catch (err) {
      this.send(c, { t: 'error', rid: msg.rid, id: msg.id, message: (err as Error).message });
      return;
    }
    const s: Sess = {
      id: msg.id, pty, pid: pty.pid, alive: true, exitCode: null, signal: null, cols: msg.cols, rows: msg.rows,
      startedAt: this.now(), lastOutputAt: null, seq: 0, ring: new Ring(msg.ringBytes && msg.ringBytes > 0 ? msg.ringBytes : DEFAULT_RING),
      checkpoint: null, attached: true, ownerPaused: false, ptyPaused: false, forgetOnExit: false, killTimer: null,
    };
    this.sessions.set(s.id, s);
    pty.onData((d) => this.onData(s, d));
    pty.onExit(({ exitCode, signal }) => this.onExit(s, exitCode, signal));
    this.send(c, { t: 'spawned', rid: msg.rid, id: s.id, pid: s.pid });
    this.applyPause(s);
  }

  private attach(c: Client, rid: number, id: string): void {
    const s = this.sessions.get(id);
    if (!s) {
      this.send(c, { t: 'error', rid, id, message: 'no such session' });
      return;
    }
    const cp = s.checkpoint && s.ring.coversAfter(s.checkpoint.seq, s.seq) ? s.checkpoint : null;
    const reply: KeeperAttached = {
      t: 'attached', rid, id, pid: s.pid, alive: s.alive, exitCode: s.exitCode, signal: s.signal, cols: s.cols, rows: s.rows, seq: s.seq,
      ...(cp ? { checkpoint: cp } : {}),
      chunks: s.ring.after(cp ? cp.seq : 0),
      truncated: !cp && s.seq > 0 && !s.ring.coversAfter(0, s.seq),
    };
    s.attached = true;
    this.send(c, reply);
  }

  private onData(s: Sess, data: string): void {
    const seq = ++s.seq;
    s.ring.push(seq, data);
    s.lastOutputAt = this.now();
    if (s.attached && this.owner) this.send(this.owner, { t: 'data', id: s.id, seq, data });
  }

  private onExit(s: Sess, exitCode: number, signal?: number): void {
    s.alive = false;
    s.exitCode = exitCode;
    s.signal = signal ?? null;
    if (s.killTimer) clearTimeout(s.killTimer);
    s.killTimer = null;
    this.log(`${s.id}: exited ${exitCode}${signal ? ` (signal ${signal})` : ''}`);
    if (s.attached && this.owner) this.send(this.owner, { t: 'exit', id: s.id, exitCode, signal: s.signal });
    if (s.forgetOnExit && this.sessions.get(s.id) === s) this.sessions.delete(s.id);
  }

  /** SIGHUP the process tree, SIGKILL what is left after a grace; forget it once it exited. */
  private hangup(s: Sess): void {
    s.forgetOnExit = true;
    if (!s.alive || s.killTimer) return;
    const tree = isSignalablePid(s.pid) ? [s.pid, ...descendants(s.pid)] : [];
    signalTree(s.pid, 'SIGHUP');
    try {
      s.pty.kill('SIGHUP');
    } catch {
      /* gone */
    }
    s.killTimer = setTimeout(() => {
      s.killTimer = null;
      for (const pid of tree) {
        if (!isSignalablePid(pid)) continue;
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          /* gone */
        }
      }
    }, this.opts.killGraceMs ?? 2000);
    s.killTimer.unref?.();
  }

  private applyPause(s: Sess): void {
    const want = s.alive && ((this.owner !== null && s.attached && s.ownerPaused) || this.backlogPaused);
    if (want === s.ptyPaused) return;
    s.ptyPaused = want;
    try {
      if (want) s.pty.pause();
      else s.pty.resume();
    } catch {
      /* exited */
    }
  }
}

/** Does something accept connections on this unix socket? */
export function answers(sock: string, ms = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect(sock);
    const done = (v: boolean) => {
      s.destroy();
      resolve(v);
    };
    s.setTimeout(ms, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}
