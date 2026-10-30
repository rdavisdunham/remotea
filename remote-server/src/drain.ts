/**
 * Draining for a restart (S-Q5, `remotea upgrade`; docs/remotea/upgrade.md).
 *
 * The CLI writes DRAIN_REQUEST_FILE and sends the server SIGUSR2. The server
 * then holds Eridani's new commands for the next boot and starts no queued
 * input (EridaniRuntime.setDraining), and waits until nothing it began is
 * still under way: a command past `begin()`, a steer or input write. It
 * writes DRAIN_STATUS_FILE `settled` (or `timeout`, naming what is left) for
 * the CLI, which then restarts the unit. A drain nobody follows up expires
 * after its timeout plus EXPIRE_GRACE_MS: draining stops and the held
 * commands run here after all.
 */
import fs from 'fs';
import path from 'path';

export const DRAIN_REQUEST_FILE = 'drain-request.json';
export const DRAIN_STATUS_FILE = 'drain-status.json';
export const DEFAULT_DRAIN_TIMEOUT_MS = 30_000;
const EXPIRE_GRACE_MS = 60_000;

export interface DrainRequest {
  /** Epoch ms; a request older than a minute is ignored. */
  at: number;
  timeoutMs: number;
  reason?: string;
}

export interface DrainInflight {
  commands: Array<{ op_id: string; t: string }>;
  writes: string[];
}

export interface DrainStatus {
  /** The boot that drained: the CLI ignores a file left by an earlier one. */
  bootId: string;
  state: 'draining' | 'settled' | 'timeout' | 'expired';
  startedAt: number;
  at: number;
  timeoutMs: number;
  waiting: DrainInflight;
}

export interface DrainTarget {
  setDraining(on: boolean, reason?: string): void;
  inflight(): DrainInflight;
}

export interface DrainerDeps {
  dir: string;
  bootId: string;
  /** The Eridani runtime (null: nothing to drain). */
  target: () => DrainTarget | null;
  /** Make what is in memory durable before the restart (the registry, the link status). */
  flush?: () => void;
  log: (msg: string) => void;
  now?: () => number;
  pollMs?: number;
  expireGraceMs?: number;
}

export function readDrainStatus(dir: string): DrainStatus | null {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(dir, DRAIN_STATUS_FILE), 'utf8')) as DrainStatus;
    return s && typeof s.bootId === 'string' && typeof s.state === 'string' ? s : null;
  } catch {
    return null;
  }
}

export function writeDrainRequest(dir: string, req: DrainRequest): void {
  const file = path.join(dir, DRAIN_REQUEST_FILE);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(req) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export class Drainer {
  private status: DrainStatus | null = null;
  private poll: NodeJS.Timeout | null = null;
  private expire: NodeJS.Timeout | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: DrainerDeps) {
    this.now = deps.now ?? Date.now;
  }

  get state(): DrainStatus | null {
    return this.status;
  }

  /** SIGUSR2: read the request and start (or restart) draining. */
  requested(): void {
    let req: DrainRequest | null = null;
    try {
      req = JSON.parse(fs.readFileSync(path.join(this.deps.dir, DRAIN_REQUEST_FILE), 'utf8')) as DrainRequest;
    } catch {
      /* no request file: use the defaults */
    }
    const fresh = req && typeof req.at === 'number' && this.now() - req.at < 60_000;
    const timeoutMs = fresh && typeof req!.timeoutMs === 'number' && req!.timeoutMs > 0 ? Math.min(req!.timeoutMs, 10 * 60_000) : DEFAULT_DRAIN_TIMEOUT_MS;
    this.start(timeoutMs, fresh && typeof req!.reason === 'string' ? req!.reason.slice(0, 40) : 'restart');
  }

  start(timeoutMs: number, reason = 'restart'): void {
    this.stopTimers();
    const startedAt = this.now();
    this.deps.target()?.setDraining(true, reason);
    this.status = { bootId: this.deps.bootId, state: 'draining', startedAt, at: startedAt, timeoutMs, waiting: { commands: [], writes: [] } };
    this.deps.log(`drain requested (${reason}): holding Eridani commands, waiting up to ${Math.round(timeoutMs / 1000)} s for work under way`);
    const tick = () => {
      const waiting = this.deps.target()?.inflight() ?? { commands: [], writes: [] };
      const idle = !waiting.commands.length && !waiting.writes.length;
      const late = this.now() - startedAt >= timeoutMs;
      if (!idle && !late) {
        this.write({ ...this.status!, at: this.now(), waiting });
        return;
      }
      this.stopPoll();
      try {
        this.deps.flush?.();
      } catch (err) {
        this.deps.log(`drain: flush failed: ${(err as Error).message}`);
      }
      this.write({ ...this.status!, state: idle ? 'settled' : 'timeout', at: this.now(), waiting });
      this.deps.log(idle ? 'drain settled: ready to restart' : `drain timed out with ${waiting.commands.length} command(s) and ${waiting.writes.length} write(s) under way`);
      this.expire = setTimeout(() => this.cancel('expired'), timeoutMs + (this.deps.expireGraceMs ?? EXPIRE_GRACE_MS));
      this.expire.unref?.();
    };
    this.poll = setInterval(tick, this.deps.pollMs ?? 100);
    this.poll.unref?.();
    tick();
  }

  /** Stop draining without a restart: run what was held. */
  cancel(why: 'expired' | 'canceled' = 'canceled'): void {
    this.stopTimers();
    if (!this.status) return;
    this.deps.target()?.setDraining(false);
    this.write({ ...this.status, state: 'expired', at: this.now() });
    this.deps.log(`drain ${why}: no restart followed; running held commands`);
  }

  dispose(): void {
    this.stopTimers();
  }

  private stopPoll(): void {
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
  }

  private stopTimers(): void {
    this.stopPoll();
    if (this.expire) clearTimeout(this.expire);
    this.expire = null;
  }

  private write(s: DrainStatus): void {
    this.status = s;
    const file = path.join(this.deps.dir, DRAIN_STATUS_FILE);
    try {
      const tmp = `${file}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (err) {
      this.deps.log(`drain: cannot write ${DRAIN_STATUS_FILE}: ${(err as Error).message}`);
    }
  }
}
