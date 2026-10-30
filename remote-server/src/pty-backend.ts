/**
 * Where a session's process lives (docs/remotea/upgrade.md).
 *
 *   in process   node-pty in this server (spawnPty): ends with the server.
 *   keeper       the PTY keeper (pty-keeper/): outlives a server restart.
 *
 * `ptyKeeper: true` in config.json spawns new sessions in the keeper (in
 * process when the keeper cannot be reached, with a log line). With it off,
 * sessions spawn in process as before, but a keeper still running from
 * before is attached anyway and its sessions adopted, so no process is ever
 * owned by nobody, or by two servers.
 */
import type { SpawnFn, SpawnRequest } from './pty-spawn';
import { spawnPty, spawnSpec } from './pty-spawn';
import { KeeperClient, observeKeeper, type KeeperCloseReason } from './pty-keeper/client';
import { answers } from './pty-keeper/keeper';
import { ensureKeeper, type KeeperLaunch } from './pty-keeper/launch';
import { keeperPaths, type KeeperWelcome } from './pty-keeper/protocol';
import type { AdoptedPty } from './hub';

export interface PtyBackendOptions {
  dir: string;
  /** config.json `ptyKeeper`: spawn new sessions in the keeper. */
  enabled: boolean;
  /** The keeper exits after this long with no owner and no live session. */
  idleMs: number;
  /** Output each keeper session keeps for a reattach. */
  ringBytes: number;
  version: string;
  log: (msg: string) => void;
  /** Tests: the in-process spawn, and how the keeper is started. */
  spawnLocal?: SpawnFn;
  launch?: { mode?: KeeperLaunch; script?: string; node?: string };
}

/** What `remotea status` and the server log say about the keeper from inside the server. */
export interface PtyBackendStatus {
  enabled: boolean;
  connected: boolean;
  pid: number | null;
  version: string | null;
  started: KeeperLaunch | null;
  lastError: string | null;
}

export class PtyBackend {
  private keeper: KeeperClient | null = null;
  private connecting: Promise<void> | null = null;
  private started: KeeperLaunch | null = null;
  private lastError: string | null = null;
  private stopped = false;
  private readonly sock: string;
  private readonly spawnLocal: SpawnFn;

  constructor(private readonly o: PtyBackendOptions) {
    this.sock = keeperPaths(o.dir).sock;
    this.spawnLocal = o.spawnLocal ?? spawnPty;
  }

  /**
   * Boot: attach to the keeper as its owner (starting one when enabled and
   * none runs) and return what it holds, ready for Hub.adopt. Never throws:
   * without a keeper the server runs everything in process.
   */
  async start(): Promise<AdoptedPty[]> {
    if (!this.o.enabled && !(await answers(this.sock))) return [];
    try {
      await this.connect();
    } catch (err) {
      this.lastError = (err as Error).message;
      this.o.log(`pty keeper unavailable (${this.lastError}); sessions run in this server and end with it`);
      return [];
    }
    return this.adoptAll();
  }

  /** The SpawnFn the hub uses. */
  readonly spawn: SpawnFn = (req: SpawnRequest) => {
    const k = this.keeper;
    if (this.o.enabled && k?.connected) return k.spawn(req.sessionId, { ...spawnSpec(req), ringBytes: this.o.ringBytes });
    if (this.o.enabled && !this.stopped) {
      this.o.log(`${req.sessionId}: pty keeper not connected; this session runs in the server and ends with it`);
      void this.reconnect();
    }
    return this.spawnLocal(req);
  };

  /** Hang up a keeper session the server does not take over. */
  discard = (id: string): void => {
    this.keeper?.closeSession(id);
  };

  status(): PtyBackendStatus {
    const w: KeeperWelcome | undefined = this.keeper?.welcome;
    return {
      enabled: this.o.enabled,
      connected: !!this.keeper?.connected,
      pid: this.keeper?.connected ? w?.pid ?? null : null,
      version: this.keeper?.connected ? w?.version ?? null : null,
      started: this.started,
      lastError: this.lastError,
    };
  }

  /** Shutdown, after Hub.shutdown handed the sessions over: close the socket; the keeper keeps them. */
  async stop(): Promise<void> {
    this.stopped = true;
    const k = this.keeper;
    this.keeper = null;
    if (k) await k.end();
  }

  private async connect(): Promise<void> {
    if (this.o.enabled) {
      const r = await ensureKeeper(this.o.dir, { idleMs: this.o.idleMs, log: this.o.log, ...this.o.launch });
      if (r.started) this.started = r.mode;
    }
    const k = await KeeperClient.connect({ sock: this.sock, role: 'owner', client: `remotea-server ${this.o.version}`, version: this.o.version, log: this.o.log });
    this.keeper = k;
    this.lastError = null;
    k.onClose((why) => this.onClose(k, why));
    const alive = k.welcome.sessions.filter((s) => s.alive).length;
    this.o.log(`pty keeper pid ${k.welcome.pid} ${k.welcome.version} (proto ${k.welcome.proto}): ${k.welcome.sessions.length} session(s), ${alive} running`);
  }

  private async adoptAll(): Promise<AdoptedPty[]> {
    const k = this.keeper;
    if (!k) return [];
    const out: AdoptedPty[] = [];
    for (const info of k.welcome.sessions) {
      try {
        const { pty, attached } = await k.adopt(info.id);
        const replay = (attached.checkpoint?.data ?? '') + attached.chunks.map(([, d]) => d).join('');
        out.push({ id: info.id, pty, alive: attached.alive, exitCode: attached.exitCode, cols: attached.cols, rows: attached.rows, replay });
        if (attached.truncated) this.o.log(`${info.id}: no checkpoint covers the keeper's ring; the screen is rebuilt from the last ${attached.chunks.length} output chunk(s)`);
      } catch (err) {
        this.o.log(`${info.id}: cannot attach in the pty keeper: ${(err as Error).message}`);
      }
    }
    return out;
  }

  private onClose(k: KeeperClient, why: KeeperCloseReason): void {
    if (this.keeper !== k) return;
    this.keeper = null;
    if (this.stopped) return;
    if (why === 'replaced') {
      this.lastError = 'another server took the pty keeper over';
      this.o.log('pty keeper: another server took it over; this server no longer drives its sessions');
      return;
    }
    this.lastError = 'the pty keeper went away';
    this.o.log('pty keeper: connection lost; its sessions ended');
    if (this.o.enabled) void this.reconnect();
  }

  /** After a lost keeper: start or reach one again for new sessions. What it still holds was already reported ended here, so it is hung up. */
  private reconnect(): Promise<void> {
    if (this.connecting || this.stopped) return this.connecting ?? Promise.resolve();
    this.connecting = (async () => {
      try {
        await this.connect();
        for (const s of this.keeper?.welcome.sessions ?? []) this.keeper?.closeSession(s.id);
      } catch (err) {
        this.lastError = (err as Error).message;
        this.o.log(`pty keeper: cannot reconnect (${this.lastError})`);
      } finally {
        this.connecting = null;
      }
    })();
    return this.connecting;
  }
}

/** `remotea status` / `doctor` / `upgrade`: the keeper as an observer sees it (never takes it over). */
export interface KeeperObservation {
  /** config.json `ptyKeeper`. */
  enabled: boolean;
  running: boolean;
  socket: string;
  pid: number | null;
  version: string | null;
  proto: number | null;
  startedAt: number | null;
  /** The server attached as owner (pid), or null when none is. */
  owner: { pid: number | null; since: number } | null;
  /** Sessions it holds, and how many of them still run. */
  sessions: number;
  alive: number;
  ids: string[];
  aliveIds: string[];
}

export async function observeKeeperStatus(dir: string, enabled: boolean, observe: (sock: string) => Promise<KeeperWelcome | null> = observeKeeper): Promise<KeeperObservation> {
  const socket = keeperPaths(dir).sock;
  const w = await observe(socket);
  const alive = w?.sessions.filter((s) => s.alive) ?? [];
  return {
    enabled,
    running: !!w,
    socket,
    pid: w?.pid ?? null,
    version: w?.version ?? null,
    proto: w?.proto ?? null,
    startedAt: w?.startedAt ?? null,
    owner: w?.owner ?? null,
    sessions: w?.sessions.length ?? 0,
    alive: alive.length,
    ids: w?.sessions.map((s) => s.id) ?? [],
    aliveIds: alive.map((s) => s.id),
  };
}

/** One line for `remotea status`. */
export function fmtKeeper(k: KeeperObservation): string {
  if (!k.running) return `pty keeper ${k.enabled ? 'enabled but NOT running (it starts with the server)' : 'off (ptyKeeper: false): a restart ends every session'}`;
  const owner = k.owner ? `server pid ${k.owner.pid ?? '?'} attached` : 'no server attached';
  return `pty keeper pid ${k.pid} ${k.version ?? ''} ${k.enabled ? '' : '(ptyKeeper is off; kept for its sessions) '}holding ${k.sessions} session(s), ${k.alive} running; ${owner}`.replace(/ {2,}/g, ' ');
}
