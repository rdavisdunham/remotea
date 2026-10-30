/**
 * The PTY keeper's wire protocol (docs/remotea/upgrade.md): newline-delimited
 * JSON over a unix socket, one object per line.
 *
 * The keeper outlives server upgrades, so this protocol only grows. A newer
 * server must still speak every keeper version it may find; a keeper ignores
 * fields it does not know and answers `error` to a request it does not know.
 * KEEPER_PROTO goes up only for a change an older peer cannot ignore.
 */
import crypto from 'crypto';
import path from 'path';

export const KEEPER_PROTO = 1;

/** Longest unix socket path we use (sun_path is 108 bytes on Linux, including the NUL). */
const MAX_SOCK_PATH = 100;

export interface KeeperPaths {
  sock: string;
  pid: string;
  log: string;
}

/** Where the keeper of a config directory listens, and its pid and log files. */
export function keeperPaths(dir: string): KeeperPaths {
  let sock = path.join(dir, 'pty-keeper.sock');
  if (Buffer.byteLength(sock) > MAX_SOCK_PATH) {
    const h = crypto.createHash('sha256').update(path.resolve(dir)).digest('hex').slice(0, 16);
    sock = path.join('/tmp', `remotea-pty-${process.getuid?.() ?? 'u'}-${h}.sock`);
  }
  return { sock, pid: path.join(dir, 'pty-keeper.pid'), log: path.join(dir, 'pty-keeper.log') };
}

/** What the keeper knows about one session (welcome, list). */
export interface KeeperSessionInfo {
  id: string;
  pid: number;
  alive: boolean;
  exitCode: number | null;
  signal: number | null;
  cols: number;
  rows: number;
  startedAt: number;
  lastOutputAt: number | null;
  /** Newest output sequence number (0: no output yet). */
  seq: number;
  /** Bytes held in the ring. */
  ringBytes: number;
  /** The checkpoint's sequence number, or null. */
  checkpointSeq: number | null;
}

/** A process to start: computed by the server (pty-spawn.ts spawnSpec), run as given. */
export interface KeeperSpawnSpec {
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
  /** Output kept for a reattach, in characters (default 1 MiB). */
  ringBytes?: number;
}

export type KeeperRole = 'owner' | 'observer';

export type ClientToKeeper =
  | { t: 'hello'; proto: number; role: KeeperRole; client?: string; pid?: number; version?: string }
  | ({ t: 'spawn'; rid: number; id: string } & KeeperSpawnSpec)
  | { t: 'attach'; rid: number; id: string }
  | { t: 'list'; rid: number }
  | { t: 'write'; id: string; data: string }
  | { t: 'resize'; id: string; cols: number; rows: number }
  | { t: 'pause'; id: string }
  | { t: 'resume'; id: string }
  | { t: 'kill'; id: string; signal?: string }
  /** Hang up, SIGKILL the process group after a grace, forget once it exited. */
  | { t: 'close'; id: string }
  | { t: 'forget'; id: string }
  /** An opaque emulator snapshot taken after output `seq` (the server's, never parsed here). */
  | { t: 'checkpoint'; id: string; seq: number; data: string }
  | { t: 'ping'; rid: number };

export interface KeeperWelcome {
  t: 'welcome';
  proto: number;
  pid: number;
  version: string;
  startedAt: number;
  /** The owner attached before this hello (an observer sees who drives it). */
  owner: { pid: number | null; since: number } | null;
  sessions: KeeperSessionInfo[];
}

export interface KeeperAttached {
  t: 'attached';
  rid: number;
  id: string;
  pid: number;
  alive: boolean;
  exitCode: number | null;
  signal: number | null;
  cols: number;
  rows: number;
  /** Newest sequence number; data after this reply starts at seq + 1. */
  seq: number;
  /** Present when the ring still covers everything after it. */
  checkpoint?: { seq: number; data: string };
  /** Output after the checkpoint (or the whole ring without one), oldest first. */
  chunks: Array<[number, string]>;
  /** The ring had already dropped output that the replay would need. */
  truncated: boolean;
}

export type KeeperToClient =
  | KeeperWelcome
  | { t: 'incompatible'; proto: number; message: string }
  | { t: 'spawned'; rid: number; id: string; pid: number }
  | KeeperAttached
  | { t: 'listed'; rid: number; sessions: KeeperSessionInfo[] }
  | { t: 'pong'; rid: number }
  | { t: 'error'; rid?: number; id?: string; message: string }
  | { t: 'data'; id: string; seq: number; data: string }
  | { t: 'exit'; id: string; exitCode: number; signal: number | null }
  | { t: 'replaced' };

/** Splits a byte stream into lines; a line longer than `max` closes the stream (it is not a peer we speak with). */
export class LineReader {
  private buf = '';
  constructor(private readonly onLine: (line: string) => void, private readonly max = 256 * 1024 * 1024) {}

  push(chunk: string): boolean {
    if (!chunk.includes('\n')) {
      this.buf += chunk;
      return this.buf.length <= this.max;
    }
    const parts = (this.buf + chunk).split('\n');
    this.buf = parts.pop() ?? '';
    for (const line of parts) if (line) this.onLine(line);
    return this.buf.length <= this.max;
  }
}

export function encodeLine(msg: object): string {
  return JSON.stringify(msg) + '\n';
}
