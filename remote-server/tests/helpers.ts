import fs from 'fs';
import { Terminal } from '@xterm/headless';
import { decodeFrame, type ServerMsg } from '../../src/shared/remote-host-protocol';
import type { PtyLike, SpawnFn, SpawnRequest } from '../src/pty-spawn';
import type { Timers } from '../src/session';
import type { HubConn } from '../src/hub';

/** A pid above the kernel's pid_max, so a test can never signal a real process. */
export const IMPOSSIBLE_PID = (() => {
  try {
    return Number(fs.readFileSync('/proc/sys/kernel/pid_max', 'utf8').trim()) + 1000;
  } catch {
    return 2 ** 22 + 1000;
  }
})();

export class FakePty implements PtyLike {
  readonly pid = IMPOSSIBLE_PID;
  written: string[] = [];
  size: [number, number];
  killed: string[] = [];
  paused = false;
  private dataCbs = new Set<(d: string) => void>();
  private exitCbs = new Set<(e: { exitCode: number; signal?: number }) => void>();

  constructor(readonly req: SpawnRequest) {
    this.size = [req.cols, req.rows];
  }
  onData(cb: (d: string) => void) {
    this.dataCbs.add(cb);
    return { dispose: () => this.dataCbs.delete(cb) };
  }
  onExit(cb: (e: { exitCode: number; signal?: number }) => void) {
    this.exitCbs.add(cb);
    return { dispose: () => this.exitCbs.delete(cb) };
  }
  emit(data: string): void {
    for (const cb of this.dataCbs) cb(data);
  }
  exit(code = 0): void {
    for (const cb of this.exitCbs) cb({ exitCode: code });
  }
  write(data: string): void {
    this.written.push(data);
  }
  resize(cols: number, rows: number): void {
    this.size = [cols, rows];
  }
  kill(signal?: string): void {
    this.killed.push(signal ?? 'SIGHUP');
  }
  pause(): void {
    this.paused = true;
  }
  resume(): void {
    this.paused = false;
  }
}

export function fakeSpawner(): { spawn: SpawnFn; ptys: FakePty[]; last(): FakePty } {
  const ptys: FakePty[] = [];
  return {
    ptys,
    spawn: (req) => {
      const p = new FakePty(req);
      ptys.push(p);
      return p;
    },
    last: () => ptys[ptys.length - 1],
  };
}

/** Timers that only fire when the test says so. */
export class ManualTimers implements Timers {
  private next = 1;
  private pending = new Map<number, { fn: () => void; at: number }>();
  now = 0;
  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.next++;
    this.pending.set(id, { fn, at: this.now + ms });
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.pending.delete(handle as number);
  }
  advance(ms: number): void {
    this.now += ms;
    for (;;) {
      const due = [...this.pending.entries()].filter(([, t]) => t.at <= this.now).sort((a, b) => a[1].at - b[1].at);
      if (!due.length) return;
      const [id, t] = due[0];
      this.pending.delete(id);
      t.fn();
    }
  }
}

export type Received = { kind: 'json'; msg: ServerMsg } | { kind: 'out'; id: string; seq: number; data: string };

export class FakeConn implements HubConn {
  device: { id: string; name: string } | null = null;
  received: Received[] = [];
  backlog = 0;
  closed: { code: number; reason: string } | null = null;
  constructor(readonly id: number) {}
  get deviceId(): string {
    return this.device?.id ?? '';
  }
  sendJson(msg: ServerMsg): void {
    this.received.push({ kind: 'json', msg: JSON.parse(JSON.stringify(msg)) as ServerMsg });
  }
  sendBinary(buf: Uint8Array): void {
    const f = decodeFrame(buf)!;
    this.received.push({ kind: 'out', id: f.id, seq: f.seq!, data: f.data });
  }
  bufferedAmount(): number {
    return this.backlog;
  }
  close(code: number, reason: string): void {
    this.closed = { code, reason };
  }
  json<T extends ServerMsg['t']>(t: T): Array<Extract<ServerMsg, { t: T }>> {
    return this.received.filter((r): r is { kind: 'json'; msg: ServerMsg } => r.kind === 'json' && r.msg.t === t).map((r) => r.msg as Extract<ServerMsg, { t: T }>);
  }
  outputs(id?: string): Array<{ seq: number; data: string }> {
    return this.received.filter((r): r is Extract<Received, { kind: 'out' }> => r.kind === 'out' && (!id || r.id === id)).map((r) => ({ seq: r.seq, data: r.data }));
  }
  clear(): void {
    this.received = [];
  }
}

/** Wait until every queued write on a headless terminal has been parsed. */
export function drain(term: Terminal): Promise<void> {
  return new Promise((resolve) => term.write('', resolve));
}

/** Visible + scrollback text and cursor: what a person would see, independent of how it was encoded. */
export function screenText(term: Terminal): string {
  const buf = term.buffer.active;
  const lines: string[] = [];
  for (let i = 0; i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? '');
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return `${buf.type}|cursor=${buf.cursorX},${buf.cursorY}|${lines.join('\n')}`;
}

/** Deterministic PRNG so property tests are reproducible. */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const tick = () => new Promise((r) => setImmediate(r));

/** xterm parses on timers, so poll on the clock rather than counting ticks. */
export async function waitFor(pred: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 2));
  if (!pred()) throw new Error('timed out waiting');
}
