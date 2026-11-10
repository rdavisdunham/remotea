/**
 * One terminal session: a PTY, a headless xterm mirroring its screen, and
 * the clients currently attached to it.
 *
 * ## Gap-free attach
 *
 * A client attaching mid-stream needs the screen as of some instant plus
 * every byte after that instant — no byte twice, none missed, or a TUI is
 * corrupted until its next full repaint. (Same argument as the phone
 * console's terminal-tap in src/main/remote-console/terminal-tap.ts, applied
 * to the server's own emulator.)
 *
 *   1. Output is numbered: each flushed chunk gets the next `seq` and is
 *      written to the headless terminal in that order.
 *   2. `attach` registers the subscriber as `snapshotting` FIRST, so every
 *      chunk flushed from now on is buffered for it, then queues an empty
 *      write as a fence. Both happen in the same tick.
 *   3. xterm runs a write's callback after parsing that write and before
 *      parsing the next, so inside the fence's callback the terminal holds
 *      exactly chunks 1..fence — and the subscriber's buffer holds exactly
 *      the chunks after it.
 *   4. The callback serializes, sends `opened{mode:'snapshot', seq: fence}`,
 *      then the buffered chunks, and only then flips the subscriber live.
 *
 * A client that missed only a little passes `sinceSeq`; when the ring still
 * holds every chunk after it, those chunks are replayed instead (`delta`).
 */
import { Terminal } from '@xterm/headless';
import { SerializeAddon } from '@xterm/addon-serialize';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import {
  encodeOutput,
  type OpenMode,
  type RemoteSurfaceId,
  type ServerMsg,
  type SessionState,
} from '../../src/shared/remote-host-protocol';
import { deliverStartupCommandsWhenReady } from '../../src/main/startup-commands';
import { applyMouseModeSequences, emptyMouseModeState, mouseModeReplaySequence, type MouseModeState } from '../../src/renderer/utils/mouse-modes';
import { Ring } from './ring';
import { installQueryResponders, type ThemeColors } from './queries';
import type { PtyLike, SpawnFn, SpawnRequest } from './pty-spawn';
import { descendants, isSignalablePid, signalTree } from './proc';

export interface ConnLike {
  readonly id: number;
  readonly deviceId: string;
  /** The device's display name (after hello). */
  readonly device?: { name: string } | null;
  sendJson(msg: ServerMsg): void;
  sendBinary(buf: Uint8Array): void;
  bufferedAmount(): number;
}

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
};

export const FLOW = Object.freeze({
  /** Output is coalesced for this long before it gets a seq and goes out. */
  batchMs: 4,
  /** ...or until this much is pending. */
  batchMaxChars: 64 * 1024,
  /** Pause the PTY when the headless parser falls this far behind. */
  parseHigh: 4 * 1024 * 1024,
  parseLow: 1024 * 1024,
  /** A client whose socket backlog passes this stops receiving live output... */
  lagHigh: 4 * 1024 * 1024,
  /** ...until it drains below this, then catches up by delta or snapshot. */
  lagLow: 128 * 1024,
  /** Grace between SIGHUP and SIGKILL when a session is closed. */
  killGraceMs: 2000,
});

type SubPhase = 'snapshotting' | 'live' | 'lagging';

interface Sub {
  conn: ConnLike;
  phase: SubPhase;
  buf: Array<[number, string]> | null;
  /** Last seq this subscriber was sent (for lag recovery). */
  lastSent: number;
}

export interface SessionOptions {
  id: RemoteSurfaceId;
  bootId: string;
  cols: number;
  rows: number;
  scrollback: number;
  snapshotScrollback: number;
  ringBytes: number;
  /** null = a session with no process (exited in a previous server boot). */
  spawn: SpawnFn | null;
  spawnRequest?: Omit<SpawnRequest, 'cols' | 'rows' | 'sessionId'>;
  startupCommands?: string[];
  theme: () => ThemeColors;
  onExit: (code: number, signal?: number) => void;
  timers?: Timers;
  log?: (msg: string) => void;
  /**
   * A process that outlived the previous server in the PTY keeper
   * (docs/remotea/upgrade.md): its PTY, whether it still runs, and the bytes
   * that rebuild its screen (the last checkpoint and the output after it).
   */
  adopt?: { pty: PtyLike; alive: boolean; exitCode?: number; replay: string };
}

export interface AttachRequest {
  rid?: number;
  cols: number;
  rows: number;
  sinceSeq?: number;
  bootId?: string;
  created: boolean;
  wasLost?: boolean;
}

export class TermSession {
  readonly id: RemoteSurfaceId;
  seq = 0;
  cols: number;
  rows: number;
  exitCode: number | undefined;
  /** Last output or input, in ms since epoch. */
  lastActivityAt = Date.now();
  /** Seq after which the last resize happened; -1 = never resized. A client at or before it missed the resize. */
  private lastSizeChangeSeq = -1;
  private readonly ring: Ring;
  private readonly term: Terminal;
  private readonly serializer: SerializeAddon;
  private mouse: MouseModeState = emptyMouseModeState();
  private pty: PtyLike | null = null;
  private alive = false;
  private readonly subs = new Map<number, Sub>();
  private sizeOwner: number | null = null;
  private readonly desired = new Map<number, { cols: number; rows: number }>();
  private readonly dataListeners = new Set<(d: string) => void>();
  private pending = '';
  private batchTimer: unknown = null;
  private parseBacklog = 0;
  private paused = false;
  private killTimer: unknown = null;
  private disposed = false;
  /** While a replay is parsed, the emulator's own query replies must not reach the process (it asked long ago). */
  private muted = false;
  /** Handed over to the PTY keeper: this server no longer drives it. */
  private released = false;
  private cancelStartup: (() => void) | null = null;
  private readonly timers: Timers;
  /** Latest agent-status RPC of each kind (see relayRpc), replayed to apps that attach later. */
  private readonly rpcState = new Map<string, { n: number; method: string; params: Record<string, unknown> }>();
  private rpcCounter = 0;

  constructor(private readonly opts: SessionOptions) {
    this.id = opts.id;
    this.cols = opts.cols;
    this.rows = opts.rows;
    this.timers = opts.timers ?? realTimers;
    this.ring = new Ring(opts.ringBytes);
    this.term = new Terminal({ cols: opts.cols, rows: opts.rows, scrollback: opts.scrollback, allowProposedApi: true });
    this.serializer = new SerializeAddon();
    this.term.loadAddon(this.serializer as never);
    this.term.loadAddon(new Unicode11Addon() as never);
    this.term.unicode.activeVersion = '11';
    // Query replies (DA, DSR/CPR, DECRQM, ...) from the headless terminal go
    // straight back to the PTY: the server answers whether or not anyone is attached.
    installQueryResponders(this.term, (d) => this.termReply(d), opts.theme);
    this.term.onData((d) => this.termReply(d));

    if (opts.adopt) {
      const a = opts.adopt;
      this.pty = a.pty;
      if (a.replay) {
        this.muted = true;
        this.mouse = applyMouseModeSequences(this.mouse, a.replay);
        this.term.write(a.replay, () => {
          this.muted = false;
        });
      }
      if (a.alive) {
        this.alive = true;
        this.pty.onData((d) => this.onPtyData(d));
        this.pty.onExit(({ exitCode, signal }) => this.onPtyExit(exitCode, signal));
      } else {
        this.exitCode = a.exitCode;
      }
    } else if (opts.spawn) {
      this.pty = opts.spawn({ ...opts.spawnRequest, sessionId: opts.id, cols: opts.cols, rows: opts.rows });
      this.alive = true;
      this.pty.onData((d) => this.onPtyData(d));
      this.pty.onExit(({ exitCode, signal }) => this.onPtyExit(exitCode, signal));
      if (opts.startupCommands?.length) this.deliver(opts.startupCommands);
    }
  }

  get state(): SessionState {
    return this.alive ? 'live' : 'exited';
  }

  get pid(): number | undefined {
    return this.alive ? this.pty?.pid : undefined;
  }

  get attachedCount(): number {
    return this.subs.size;
  }

  hasSubscriber(connId: number): boolean {
    return this.subs.has(connId);
  }

  // ── Output path ──────────────────────────────────────────────────────────

  private onPtyData(data: string): void {
    this.lastActivityAt = Date.now();
    this.pending += data;
    if (this.pending.length >= FLOW.batchMaxChars) {
      this.flush();
      return;
    }
    if (this.batchTimer === null) {
      this.batchTimer = this.timers.setTimeout(() => {
        this.batchTimer = null;
        this.flush();
      }, FLOW.batchMs);
    }
  }

  /** Give pending output its seq, feed the emulator, fan it out. */
  flush(): void {
    if (this.batchTimer !== null) {
      this.timers.clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
    if (!this.pending) return;
    const chunk = this.pending;
    this.pending = '';
    const seq = ++this.seq;
    this.ring.push(seq, chunk);
    this.mouse = applyMouseModeSequences(this.mouse, chunk);
    this.parseBacklog += chunk.length;
    this.term.write(chunk, () => {
      this.parseBacklog -= chunk.length;
      if (this.paused && this.parseBacklog < FLOW.parseLow) {
        this.paused = false;
        this.pty?.resume();
      }
    });
    if (!this.paused && this.parseBacklog > FLOW.parseHigh && this.alive) {
      this.paused = true;
      this.pty?.pause();
    }
    for (const sub of this.subs.values()) {
      if (sub.phase === 'live') {
        if (sub.conn.bufferedAmount() > FLOW.lagHigh) {
          sub.phase = 'lagging';
          continue;
        }
        this.sendOutput(sub, seq, chunk);
      } else if (sub.phase === 'snapshotting') {
        sub.buf!.push([seq, chunk]);
      }
      // lagging: nothing — recovered from the ring or a fresh snapshot in pumpLagging()
    }
    for (const listener of this.dataListeners) listener(chunk);
  }

  private sendOutput(sub: Sub, seq: number, chunk: string): void {
    sub.conn.sendBinary(encodeOutput(this.id, seq, chunk));
    sub.lastSent = seq;
  }

  private onPtyExit(code: number, signal?: number): void {
    this.flush();
    this.alive = false;
    this.exitCode = code;
    this.rpcState.clear();
    this.cancelStartup?.();
    this.cancelStartup = null;
    if (this.killTimer !== null) {
      this.timers.clearTimeout(this.killTimer);
      this.killTimer = null;
    }
    for (const sub of this.subs.values()) sub.conn.sendJson({ t: 'exit', id: this.id, code, signal });
    this.opts.onExit(code, signal);
  }

  // ── Attach / detach ──────────────────────────────────────────────────────

  attach(conn: ConnLike, req: AttachRequest): void {
    this.subs.delete(conn.id);
    this.desired.set(conn.id, { cols: req.cols, rows: req.rows });
    if (req.created || req.wasLost) this.sizeOwner = conn.id;

    const base = {
      t: 'opened' as const,
      rid: req.rid,
      id: this.id,
      created: req.created,
      wasLost: req.wasLost,
      state: this.state,
      exitCode: this.exitCode,
    };

    const canDelta = req.bootId === this.opts.bootId
      && req.sinceSeq !== undefined
      && this.ring.coversAfter(req.sinceSeq, this.seq)
      && this.lastSizeChangeSeq < req.sinceSeq;

    // A brand-new process (created, or respawned after a server restart) has no history: nothing to snapshot.
    if (canDelta || ((req.created || req.wasLost) && this.seq === 0)) {
      const mode: OpenMode = canDelta ? 'delta' : 'fresh';
      const sub: Sub = { conn, phase: 'live', buf: null, lastSent: this.seq };
      this.subs.set(conn.id, sub);
      conn.sendJson({ ...base, mode, seq: this.seq, fromSeq: canDelta ? req.sinceSeq : undefined, cols: this.cols, rows: this.rows, owner: this.sizeOwner === conn.id });
      if (canDelta) for (const [q, c] of this.ring.after(req.sinceSeq!)) this.sendOutput(sub, q, c);
      this.replayRpcs(conn);
      return;
    }

    const sub: Sub = { conn, phase: 'snapshotting', buf: [], lastSent: this.seq };
    this.subs.set(conn.id, sub);
    this.snapshotInto(sub, base);
  }

  /**
   * Serialize at a fence and stream everything after it (see the header).
   * `base` is the opened message to send; a lag recovery sends one without a
   * rid, which the client treats as a mid-stream resync.
   */
  private snapshotInto(sub: Sub, base: Omit<Extract<ServerMsg, { t: 'opened' }>, 'mode' | 'seq' | 'cols' | 'rows' | 'snapshot' | 'owner'>): void {
    sub.phase = 'snapshotting';
    sub.buf = [];
    const fence = this.seq;
    this.term.write('', () => {
      if (this.subs.get(sub.conn.id) !== sub || this.disposed) return;
      const snapshot = buildSnapshot(this.term, this.serializer, this.mouse, this.opts.snapshotScrollback);
      sub.conn.sendJson({ ...base, mode: 'snapshot', seq: fence, cols: this.cols, rows: this.rows, snapshot, owner: this.sizeOwner === sub.conn.id });
      sub.lastSent = fence;
      const buffered = sub.buf ?? [];
      sub.buf = null;
      sub.phase = 'live';
      for (const [q, c] of buffered) this.sendOutput(sub, q, c);
      // A lag recovery (no rid) is the same app, which already has the state.
      if (base.rid !== undefined) this.replayRpcs(sub.conn);
    });
  }

  /**
   * An agent in this session reported status (hook bridge). Sent to every app
   * attached now; the latest of each kind is kept for apps that attach later.
   * Hook events are kept per event name — the newest Stop, the newest
   * PreToolUse, … — and replayed in the order they arrived, which rebuilds
   * the current state (each report carries the time it fired, and the app
   * drops older ones) without the full history.
   */
  relayRpc(method: string, params: Record<string, unknown>): void {
    const event = method === 'hook.event' ? (typeof params.event === 'string' ? params.event : 'PostToolUse') : '';
    // A new conversation, or the agent letting go of the pane: what came before no longer describes it.
    if (event === 'SessionStart' || event === 'SessionEnd' || method === 'pane.release_agent') this.rpcState.clear();
    this.rpcState.set(event ? `${method}:${event}` : method, { n: ++this.rpcCounter, method, params });
    const msg = { t: 'rpc' as const, id: this.id, method, params };
    for (const sub of this.subs.values()) sub.conn.sendJson(msg);
  }

  private replayRpcs(conn: ConnLike): void {
    const latest = [...this.rpcState.values()].sort((a, b) => a.n - b.n);
    for (const r of latest) conn.sendJson({ t: 'rpc', id: this.id, method: r.method, params: r.params, replay: true });
  }

  /** The apps attached, at the size each asked for (Hub.reopenExited hands them to the new process). */
  attachments(): Array<{ conn: ConnLike; cols: number; rows: number }> {
    return [...this.subs.values()].map((sub) => ({ conn: sub.conn, ...(this.desired.get(sub.conn.id) ?? { cols: this.cols, rows: this.rows }) }));
  }

  detach(connId: number): void {
    this.subs.delete(connId);
    this.desired.delete(connId);
    if (this.sizeOwner === connId) this.sizeOwner = null;
  }

  /** Re-feed subscribers that fell behind once their socket has drained. */
  pumpLagging(): void {
    for (const sub of this.subs.values()) {
      if (sub.phase !== 'lagging' || sub.conn.bufferedAmount() > FLOW.lagLow) continue;
      if (this.ring.coversAfter(sub.lastSent, this.seq) && this.lastSizeChangeSeq < sub.lastSent) {
        sub.phase = 'live';
        for (const [q, c] of this.ring.after(sub.lastSent)) this.sendOutput(sub, q, c);
      } else {
        this.snapshotInto(sub, { t: 'opened', id: this.id, created: false, state: this.state, exitCode: this.exitCode });
      }
    }
  }

  // ── Input & size ─────────────────────────────────────────────────────────

  private writePty(data: string): void {
    if (this.alive && this.pty) this.pty.write(data);
  }

  private termReply(data: string): void {
    if (!this.muted) this.writePty(data);
  }

  /** Human input from a client. Typing at a device is the strongest "I'm here" signal: it claims the size. */
  /** Bytes for the process that come from no client (Eridani's input). */
  write(data: string): void {
    if (!this.alive) return;
    this.lastActivityAt = Date.now();
    this.writePty(data);
  }

  input(connId: number, data: string): void {
    if (!this.alive) return;
    this.lastActivityAt = Date.now();
    this.claim(connId);
    this.writePty(data);
  }

  resize(connId: number, cols: number, rows: number): void {
    this.desired.set(connId, { cols, rows });
    if (this.sizeOwner === connId) this.applySize(cols, rows);
  }

  /** Make `connId` the size owner (herdr's model: the last device to interact controls the size). */
  claim(connId: number): void {
    if (this.sizeOwner === connId) return;
    this.sizeOwner = connId;
    const d = this.desired.get(connId);
    if (d) this.applySize(d.cols, d.rows);
    else this.broadcastSize();
  }

  private applySize(cols: number, rows: number): void {
    if (cols === this.cols && rows === this.rows) {
      this.broadcastSize();
      return;
    }
    this.flush();
    this.cols = cols;
    this.rows = rows;
    this.term.resize(cols, rows);
    if (this.alive) {
      try {
        this.pty?.resize(cols, rows);
      } catch {
        /* exited between checks */
      }
    }
    this.lastSizeChangeSeq = this.seq;
    this.broadcastSize();
  }

  private broadcastSize(): void {
    const ownerName = this.sizeOwner === null ? undefined : this.subs.get(this.sizeOwner)?.conn.device?.name;
    for (const sub of this.subs.values()) {
      sub.conn.sendJson({ t: 'size', id: this.id, cols: this.cols, rows: this.rows, owner: this.sizeOwner === sub.conn.id, ownerName });
    }
  }

  /** Type commands once the shell looks ready (shared gate with the app, src/main/startup-commands.ts). */
  deliver(commands: string[]): void {
    if (!this.alive || !commands.length) return;
    this.cancelStartup?.();
    this.cancelStartup = deliverStartupCommandsWhenReady({
      onData: (cb) => {
        this.dataListeners.add(cb);
        return () => this.dataListeners.delete(cb);
      },
      write: (d) => this.writePty(d),
      isAlive: () => this.alive,
      setTimeout: (fn, ms) => this.timers.setTimeout(fn, ms),
      clearTimeout: (h) => this.timers.clearTimeout(h),
      log: this.opts.log,
    }, commands);
  }

  // ── Teardown ─────────────────────────────────────────────────────────────

  /** SIGHUP the whole process tree; SIGKILL whatever is left after a grace period. */
  kill(): void {
    if (!this.alive || !this.pty) return;
    const root = this.pty.pid;
    const tree = [root, ...descendants(root)];
    signalTree(root, 'SIGHUP');
    try {
      this.pty.kill('SIGHUP');
    } catch {
      /* already gone */
    }
    this.killTimer = this.timers.setTimeout(() => {
      this.killTimer = null;
      for (const pid of tree) {
        if (!isSignalablePid(pid)) continue;
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          /* gone */
        }
      }
    }, FLOW.killGraceMs);
  }

  /** The process can be handed over to the PTY keeper instead of being hung up. */
  get keepable(): boolean {
    return this.alive && !this.released && !!this.pty?.hold && !!this.pty.release;
  }

  /**
   * Hand-over on shutdown (PTY keeper): stop taking output, serialize the
   * emulator once it has parsed everything taken, give that checkpoint to the
   * keeper and let go. The process keeps running. False when not keepable.
   */
  async release(): Promise<boolean> {
    if (!this.keepable) return false;
    const pty = this.pty!;
    this.released = true;
    const seq = pty.hold!();
    this.cancelStartup?.();
    this.cancelStartup = null;
    this.flush();
    let data: string | null = null;
    try {
      data = await new Promise<string>((resolve) => this.term.write('', () => resolve(buildSnapshot(this.term, this.serializer, this.mouse, this.opts.scrollback))));
    } catch {
      data = null; // the keeper replays its ring instead
    }
    pty.release!(data === null ? null : { seq, data });
    this.alive = false;
    return true;
  }

  dispose(): void {
    this.disposed = true;
    this.cancelStartup?.();
    if (this.batchTimer !== null) this.timers.clearTimeout(this.batchTimer);
    this.subs.clear();
    this.dataListeners.clear();
    this.term.dispose();
  }
}

/**
 * The bytes that put a fresh xterm into `term`'s current state: screen,
 * scrollback, modes — plus the cursor details SerializeAddon cannot express.
 * Pure function of the emulator state, so tests can build the expected
 * snapshot for any byte prefix and compare it exactly.
 */
export function buildSnapshot(term: Terminal, serializer: SerializeAddon, mouse: MouseModeState, scrollback: number): string {
  return '\x1b[0m' + pinNormalCursor(term, serializer.serialize({ scrollback }))
    + savedCursorFixup(term)
    + cursorFixup(term)
    + mouseModeReplaySequence(mouse);
}

/**
 * SerializeAddon restores the cursor with relative moves, which land a
 * column off after some wide-character wraps. An absolute CUP from the
 * emulator's own state makes it exact. Skipped in the pending-wrap state
 * (x == cols), which no cursor move can express.
 */
function cursorFixup(term: Terminal): string {
  const buf = term.buffer.active;
  if (buf.cursorX >= term.cols) return '';
  return `\x1b[${buf.cursorY + 1};${buf.cursorX + 1}H`;
}

/**
 * Recreate the DECSC saved cursor (ESC 7 / CSI ?1049h store it; ESC 8 /
 * CSI ?1049l restore it). SerializeAddon cannot express it, and a restore
 * after attach would otherwise put the cursor somewhere else than on the
 * server. xterm exposes it only through private state, read defensively: if
 * the shape ever changes this quietly does nothing.
 */
function savedCursorFixup(term: Terminal): string {
  if (term.buffer.active.type !== 'normal') return ''; // alt: pinNormalCursor covers ?1049h's save
  try {
    const core = (term as unknown as { _core?: { buffers?: { normal?: { savedX?: unknown; savedY?: unknown; ybase?: unknown } } } })._core;
    const n = core?.buffers?.normal;
    if (!n || typeof n.savedX !== 'number' || typeof n.savedY !== 'number' || typeof n.ybase !== 'number') return '';
    const y = n.savedY - n.ybase;
    if (y < 0 || y >= term.rows || n.savedX >= term.cols) return '';
    return `\x1b[${y + 1};${n.savedX + 1}H\x1b7`;
  } catch {
    return '';
  }
}

/**
 * With the alternate screen active, the serialized form draws the normal
 * buffer, then enters the alt screen with `CSI ?1049h` — which SAVES the
 * cursor that leaving the alt screen later restores. Pin that saved cursor
 * absolutely too, or the shell prompt comes back a column off after the TUI exits.
 */
function pinNormalCursor(term: Terminal, serialized: string): string {
  if (term.buffer.active.type !== 'alternate') return serialized;
  const at = serialized.lastIndexOf('\x1b[?1049h');
  const normal = term.buffer.normal;
  if (at < 0 || normal.cursorX >= term.cols) return serialized;
  return `${serialized.slice(0, at)}\x1b[${normal.cursorY + 1};${normal.cursorX + 1}H${serialized.slice(at)}`;
}
