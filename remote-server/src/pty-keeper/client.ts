/**
 * The server's side of the PTY keeper (docs/remotea/upgrade.md): one socket,
 * request/response by `rid`, output routed to a KeeperPty per session.
 *
 * A KeeperPty is a PtyLike (pty-spawn.ts), so TermSession drives it exactly
 * like an in-process node-pty. Output that arrives before the session has
 * subscribed (an adoption) is buffered, never dropped. `hold` and `release`
 * are the hand-over: stop taking output, give the keeper the emulator's
 * checkpoint, let go; the process keeps running.
 */
import net from 'net';
import type { PtyLike } from '../pty-spawn';
import {
  KEEPER_PROTO,
  LineReader,
  encodeLine,
  type ClientToKeeper,
  type KeeperAttached,
  type KeeperRole,
  type KeeperSessionInfo,
  type KeeperSpawnSpec,
  type KeeperToClient,
  type KeeperWelcome,
} from './protocol';

type Disposable = { dispose(): void };

export class KeeperPty implements PtyLike {
  pid: number;
  /** The last output sequence number taken (data at or below it is a duplicate). */
  lastSeq: number;
  private readonly dataCbs = new Set<(d: string) => void>();
  private readonly exitCbs = new Set<(e: { exitCode: number; signal?: number }) => void>();
  private pendingData: string[] = [];
  private pendingExit: { exitCode: number; signal?: number } | null = null;
  private held = false;
  private exited = false;

  constructor(private readonly client: KeeperClient, readonly id: string, pid: number, lastSeq: number) {
    this.pid = pid;
    this.lastSeq = lastSeq;
  }

  onData(cb: (data: string) => void): Disposable {
    this.dataCbs.add(cb);
    if (this.pendingData.length) {
      const data = this.pendingData.join('');
      this.pendingData = [];
      cb(data);
    }
    return { dispose: () => this.dataCbs.delete(cb) };
  }

  onExit(cb: (e: { exitCode: number; signal?: number }) => void): Disposable {
    this.exitCbs.add(cb);
    if (this.pendingExit) {
      const e = this.pendingExit;
      this.pendingExit = null;
      cb(e);
    }
    return { dispose: () => this.exitCbs.delete(cb) };
  }

  write(data: string): void {
    if (!this.exited) this.client.post({ t: 'write', id: this.id, data });
  }

  resize(cols: number, rows: number): void {
    if (!this.exited) this.client.post({ t: 'resize', id: this.id, cols, rows });
  }

  kill(signal?: string): void {
    if (!this.exited) this.client.post({ t: 'kill', id: this.id, signal: signal ?? 'SIGHUP' });
  }

  pause(): void {
    if (!this.exited) this.client.post({ t: 'pause', id: this.id });
  }

  resume(): void {
    if (!this.exited) this.client.post({ t: 'resume', id: this.id });
  }

  /** Stop taking output (it stays in the keeper's ring); the last sequence number taken. */
  hold(): number {
    this.held = true;
    return this.lastSeq;
  }

  /** Hand over the checkpoint and let go: the process keeps running in the keeper. */
  release(checkpoint: { seq: number; data: string } | null): void {
    this.held = true;
    if (checkpoint && !this.exited) this.client.post({ t: 'checkpoint', id: this.id, seq: checkpoint.seq, data: checkpoint.data });
    this.client.unroute(this);
  }

  /** @internal from the client */
  deliver(seq: number, data: string): void {
    if (this.held || this.exited || seq <= this.lastSeq) return;
    this.lastSeq = seq;
    if (!this.dataCbs.size) {
      this.pendingData.push(data);
      return;
    }
    for (const cb of this.dataCbs) cb(data);
  }

  /** @internal from the client */
  deliverExit(exitCode: number, signal?: number): void {
    if (this.exited) return;
    this.exited = true;
    const e = signal === undefined ? { exitCode } : { exitCode, signal };
    if (!this.exitCbs.size) this.pendingExit = e;
    else for (const cb of this.exitCbs) cb(e);
  }

  get isExited(): boolean {
    return this.exited;
  }
}

export interface KeeperConnectOptions {
  sock: string;
  role: KeeperRole;
  client?: string;
  version?: string;
  timeoutMs?: number;
  log?: (msg: string) => void;
}

/** Why the connection ended: another server took over, or the keeper went away. */
export type KeeperCloseReason = 'replaced' | 'closed';

export class KeeperClient {
  private readonly routes = new Map<string, KeeperPty>();
  private readonly pending = new Map<number, { resolve: (m: KeeperToClient) => void; reject: (err: Error) => void }>();
  private nextRid = 1;
  private closed = false;
  private replaced = false;
  private ending = false;
  private closeCbs: Array<(why: KeeperCloseReason) => void> = [];
  private readonly log: (msg: string) => void;

  private constructor(private readonly sock: net.Socket, readonly welcome: KeeperWelcome, log: (msg: string) => void) {
    this.log = log;
  }

  /** Connect and say hello; resolves with the welcome, rejects when nobody answers or the keeper refuses. */
  static connect(o: KeeperConnectOptions): Promise<KeeperClient> {
    const log = o.log ?? (() => {});
    return new Promise((resolve, reject) => {
      const sock = net.connect(o.sock);
      sock.setEncoding('utf8');
      let client: KeeperClient | null = null;
      let settled = false;
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        sock.destroy();
        reject(err);
      };
      const timer = setTimeout(() => fail(new Error('the pty keeper did not answer')), o.timeoutMs ?? 5000);
      const reader = new LineReader((line) => {
        let msg: KeeperToClient;
        try {
          msg = JSON.parse(line) as KeeperToClient;
        } catch {
          return;
        }
        if (client) return client.onMessage(msg);
        if (msg.t === 'welcome') {
          clearTimeout(timer);
          settled = true;
          client = new KeeperClient(sock, msg, log);
          resolve(client);
        } else if (msg.t === 'incompatible') {
          clearTimeout(timer);
          fail(new Error(`incompatible pty keeper: ${msg.message}`));
        }
      });
      sock.on('data', (d: string) => reader.push(d));
      sock.once('error', (err) => {
        clearTimeout(timer);
        fail(err);
      });
      sock.on('close', () => {
        clearTimeout(timer);
        if (client) client.onSocketClose();
        else fail(new Error('the pty keeper closed the connection'));
      });
      sock.once('connect', () => {
        const hello: ClientToKeeper = { t: 'hello', proto: KEEPER_PROTO, role: o.role, client: o.client, pid: process.pid, version: o.version };
        sock.write(encodeLine(hello));
      });
    });
  }

  get connected(): boolean {
    return !this.closed;
  }

  onClose(cb: (why: KeeperCloseReason) => void): void {
    this.closeCbs.push(cb);
  }

  /** Fire-and-forget request (no reply). */
  post(msg: ClientToKeeper): void {
    if (this.closed) return;
    this.sock.write(encodeLine(msg));
  }

  private request<T extends KeeperToClient>(msg: ClientToKeeper & { rid: number }, ms = 10_000): Promise<T> {
    if (this.closed) return Promise.reject(new Error('the pty keeper connection is closed'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(msg.rid);
        reject(new Error(`the pty keeper did not answer ${msg.t}`));
      }, ms);
      this.pending.set(msg.rid, {
        resolve: (m) => {
          clearTimeout(timer);
          if (m.t === 'error') reject(new Error(m.message));
          else resolve(m as T);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      this.post(msg);
    });
  }

  /** Start a process in the keeper. Returns at once; a failure arrives as output and an exit (-1). */
  spawn(id: string, spec: KeeperSpawnSpec): KeeperPty {
    if (this.closed) throw new Error('the pty keeper connection is closed');
    const pty = new KeeperPty(this, id, 0, 0);
    this.routes.set(id, pty);
    const rid = this.nextRid++;
    this.request<Extract<KeeperToClient, { t: 'spawned' }>>({ t: 'spawn', rid, id, ...spec }).then(
      (m) => {
        pty.pid = m.pid;
      },
      (err: Error) => {
        this.log(`${id}: the pty keeper could not start it: ${err.message}`);
        if (this.routes.get(id) === pty) this.routes.delete(id);
        pty.deliver(1, `\r\n[remotea: could not start this session: ${err.message}]\r\n`);
        pty.deliverExit(-1);
      },
    );
    return pty;
  }

  /** Attach a session the keeper holds: its replay, and a KeeperPty streaming everything after it. */
  async adopt(id: string): Promise<{ pty: KeeperPty; attached: KeeperAttached }> {
    const attached = await this.request<KeeperAttached>({ t: 'attach', rid: this.nextRid++, id });
    const pty = new KeeperPty(this, id, attached.pid, attached.seq);
    if (!attached.alive) pty.deliverExit(attached.exitCode ?? -1, attached.signal ?? undefined);
    else this.routes.set(id, pty);
    return { pty, attached };
  }

  async list(): Promise<KeeperSessionInfo[]> {
    const m = await this.request<Extract<KeeperToClient, { t: 'listed' }>>({ t: 'list', rid: this.nextRid++ });
    return m.sessions;
  }

  /** Hang up a session the server no longer wants (closed meanwhile); the keeper forgets it once it exited. */
  closeSession(id: string): void {
    this.routes.delete(id);
    this.post({ t: 'close', id });
  }

  forget(id: string): void {
    this.routes.delete(id);
    this.post({ t: 'forget', id });
  }

  /** @internal */
  unroute(pty: KeeperPty): void {
    if (this.routes.get(pty.id) === pty) this.routes.delete(pty.id);
  }

  /** Flush what was written and close; the keeper keeps every session. */
  end(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.ending = true;
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.sock.destroy();
        resolve();
      }, 3000);
      this.sock.once('close', () => {
        clearTimeout(t);
        resolve();
      });
      this.sock.end();
    });
  }

  private onMessage(msg: KeeperToClient): void {
    switch (msg.t) {
      case 'data':
        this.routes.get(msg.id)?.deliver(msg.seq, msg.data);
        return;
      case 'exit': {
        const pty = this.routes.get(msg.id);
        if (!pty) return;
        this.routes.delete(msg.id);
        pty.deliverExit(msg.exitCode, msg.signal ?? undefined);
        // The exit is ours now; the keeper need not remember it.
        this.post({ t: 'forget', id: msg.id });
        return;
      }
      case 'replaced':
        this.replaced = true;
        this.log('the pty keeper was taken over by another server');
        return;
      default: {
        const rid = (msg as { rid?: unknown }).rid;
        if (typeof rid !== 'number') {
          if (msg.t === 'error') this.log(`pty keeper: ${msg.message}`);
          return;
        }
        const p = this.pending.get(rid);
        if (!p) return;
        this.pending.delete(rid);
        p.resolve(msg);
      }
    }
  }

  private onSocketClose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) p.reject(new Error('the pty keeper connection closed'));
    this.pending.clear();
    const why: KeeperCloseReason = this.replaced ? 'replaced' : 'closed';
    if (why === 'closed' && !this.ending) {
      // The keeper went away: its processes went with it.
      for (const pty of this.routes.values()) pty.deliverExit(-1);
    }
    this.routes.clear();
    for (const cb of this.closeCbs) cb(why);
  }
}

/** One look at the keeper without taking it over (status, doctor, upgrade). Null when none answers. */
export async function observeKeeper(sock: string, timeoutMs = 1500): Promise<KeeperWelcome | null> {
  try {
    const c = await KeeperClient.connect({ sock, role: 'observer', client: 'remotea-cli', timeoutMs });
    void c.end();
    return c.welcome;
  } catch {
    return null;
  }
}
