/**
 * What is running in a session, read from /proc — no hooks required.
 *
 * - cwd and command name of the terminal's FOREGROUND process group, so a
 *   `cd` inside the shell or an agent's own working directory shows up;
 * - the Claude Code session id of any `claude` process in the tree, read
 *   from `~/.claude/sessions/<pid>.json`. That id is what lets a session the
 *   server lost in a restart come back as `claude --resume <id>`.
 *
 * The sessions file is Claude Code's own private bookkeeping and may change
 * shape without notice, so every field is checked and anything unexpected
 * is simply "no agent". Only `<pid>.json` is ever read — never the `.key`
 * files beside it.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { AgentHandle } from '../../src/shared/remote-host-protocol';
import { childrenIndex, descendants, readCwd, readStat } from './proc';

export interface ProbeResult {
  cwd?: string;
  fg?: string;
  agent?: AgentHandle;
}

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function readClaudeSession(pid: number, home = os.homedir()): string | null {
  const file = path.join(home, '.claude', 'sessions', `${pid}.json`);
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as { pid?: unknown; sessionId?: unknown };
    if (parsed.pid !== undefined && parsed.pid !== pid) return null;
    return typeof parsed.sessionId === 'string' && SESSION_ID_RE.test(parsed.sessionId) ? parsed.sessionId : null;
  } catch {
    return null;
  }
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const ROLLOUT_RE = new RegExp(`/\\.codex/sessions/.*rollout-[^/]*-(${UUID})\\.jsonl$`, 'i');

/** The thread id in a Codex rollout path (`…/rollout-<time>-<thread uuid>.jsonl`), or null. */
export function codexThreadFromPath(p: string): string | null {
  return ROLLOUT_RE.exec(p)?.[1] ?? null;
}

/** An interactive Codex CLI (not the app-server the desktop app runs). */
export function isCodexCli(pid: number): boolean {
  if (readStat(pid)?.comm !== 'codex') return false;
  try {
    const argv = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
    return !argv.includes('app-server');
  } catch {
    return false;
  }
}

interface CodexSessionMeta {
  id: string;
  child: boolean;
  parent: string | null;
}

/** Read a bounded prefix and parse only the metadata header. */
function readCodexSessionMeta(file: string, id: string): CodexSessionMeta | null {
  let fd: number | undefined;
  try {
    // A stale/corrupt index must not hang the server by pointing at a FIFO.
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    if (!fs.fstatSync(fd).isFile()) return null;
    const chunks: Buffer[] = [];
    for (let offset = 0; offset < 1024 * 1024; offset += 8192) {
      const chunk = Buffer.alloc(8192);
      const size = fs.readSync(fd, chunk, 0, chunk.length, offset);
      if (!size) return null; // An unfinished header is not evidence of a root thread.
      const end = chunk.subarray(0, size).indexOf(10);
      chunks.push(chunk.subarray(0, end < 0 ? size : end));
      if (end < 0) continue;
      const row = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const meta = row?.payload;
      if (row?.type !== 'session_meta' || meta?.id !== id) return null;
      const source = meta.source;
      const child = !!meta.parent_thread_id || (source && typeof source === 'object' && 'subagent' in source)
        || (typeof source === 'string' && source.includes('subagent'));
      if (!child && (typeof source !== 'string' || !source)) return null;
      return {
        id,
        child: !!child,
        parent: typeof meta.parent_thread_id === 'string' && SESSION_ID_RE.test(meta.parent_thread_id) ? meta.parent_thread_id : null,
      };
    }
  } catch {
    // Codex's private format may change, or the file may close during a probe.
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return null;
}

/**
 * A Codex process can hold root, Guardian and worker rollouts at once. Only
 * one verified root is usable, irrespective of descriptor order. Undefined
 * means no rollout was open; null means ambiguous/unreadable/child-only, so
 * the weaker cwd/time fallback must not override that evidence.
 */
export function codexThreadFromFds(pid: number): string | null | undefined {
  let fds: string[];
  try {
    fds = fs.readdirSync(`/proc/${pid}/fd`);
  } catch {
    return undefined;
  }
  let found = false;
  let unreadable = false;
  const roots = new Set<string>();
  for (const fd of fds) {
    try {
      const file = fs.readlinkSync(`/proc/${pid}/fd/${fd}`);
      const id = codexThreadFromPath(file);
      if (!id) continue;
      found = true;
      const meta = readCodexSessionMeta(file, id);
      if (!meta) unreadable = true;
      else if (!meta.child) roots.add(meta.id);
    } catch {
      /* closed meanwhile */
    }
  }
  return !unreadable && roots.size === 1 ? [...roots][0] : found ? null : undefined;
}

/** Process start time in epoch ms (from /proc, clock ticks since boot). */
export function processStartMs(pid: number): number | null {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
    const ticks = Number(fields[19]);
    const btime = Number(/^btime (\d+)$/m.exec(fs.readFileSync('/proc/stat', 'utf8'))?.[1]);
    if (!Number.isFinite(ticks) || !Number.isFinite(btime)) return null;
    return btime * 1000 + Math.round((ticks / 100) * 1000);
  } catch {
    return null;
  }
}

interface ThreadRow {
  id: string;
  created_at_ms: number;
}
export type CodexThreadQuery = (cwd: string, sinceMs: number) => ThreadRow[] | null;

interface CodexStateDb {
  prepare(sql: string): { all(...args: unknown[]): unknown[]; get(...args: unknown[]): unknown };
  close(): void;
}

/**
 * Codex's own thread index, opened READ-ONLY. node:sqlite is loaded lazily:
 * needed only for fallback discovery and saved-session recovery.
 */
function withCodexState<T>(home: string, read: (db: CodexStateDb) => T): T | undefined {
  const file = path.join(home, '.codex', 'state_5.sqlite');
  if (!fs.existsSync(file)) return undefined;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: new (f: string, o: { readOnly: boolean }) => CodexStateDb };
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      return read(db);
    } finally {
      db.close();
    }
  } catch {
    return undefined;
  }
}

export function codexStateQuery(home = os.homedir()): CodexThreadQuery {
  return (cwd, sinceMs) => withCodexState(home, (db) => db.prepare(
    "SELECT id, created_at_ms FROM threads WHERE cwd = ? AND created_at_ms >= ? AND source NOT LIKE '%subagent%' ORDER BY created_at_ms LIMIT 5",
  ).all(cwd, sinceMs) as ThreadRow[]) ?? null;
}

/**
 * Repair IDs saved by older probes. Follow only explicit parent links, never
 * cwd/time guesses. Unknown IDs keep their existing resume behavior; a known
 * child with an unverifiable parent returns null and must not be auto-resumed.
 */
export function resolveCodexResumeThread(id: string, home = os.homedir()): string | null {
  if (!SESSION_ID_RE.test(id)) return null;
  let childFound = false;
  const resolved = withCodexState(home, (db) => {
    const seen = new Set<string>();
    let current = id;
    while (seen.size < 16 && !seen.has(current)) {
      seen.add(current);
      const row = db.prepare('SELECT rollout_path, source FROM threads WHERE id = ?').get(current) as { rollout_path?: unknown; source?: unknown } | undefined;
      if (!row) return childFound ? null : id;
      const indexedChild = typeof row.source === 'string' && row.source.includes('subagent');
      childFound ||= indexedChild;
      const meta = typeof row.rollout_path === 'string' ? readCodexSessionMeta(row.rollout_path, current) : null;
      if (!meta) return childFound ? null : id;
      if (!meta.child && !indexedChild) return current;
      childFound = true;
      if (!meta.parent) return null;
      current = meta.parent;
    }
    return null; // Cycle or an implausibly deep internal thread chain.
  });
  return resolved === undefined ? childFound ? null : id : resolved;
}

/**
 * Fallback when no rollout file is open: the ONE thread created in the
 * process's cwd since it started. Two or more candidates is ambiguous (two
 * Codex sessions side by side) — no answer is better than a wrong resume.
 */
export function codexThreadFromState(cwd: string, startMs: number, query: CodexThreadQuery): string | null {
  const rows = query(cwd, startMs - 5000);
  if (!rows || rows.length !== 1) return null;
  return SESSION_ID_RE.test(rows[0].id) ? rows[0].id : null;
}

export function probeSession(
  rootPid: number,
  opts: { home?: string; index?: Map<number, number[]>; now?: number; codexQuery?: CodexThreadQuery } = {},
): ProbeResult {
  const root = readStat(rootPid);
  if (!root) return {};
  const fgPid = root.tpgid > 0 ? root.tpgid : rootPid;
  const result: ProbeResult = {
    cwd: readCwd(fgPid) ?? readCwd(rootPid) ?? undefined,
    fg: readStat(fgPid)?.comm ?? root.comm,
  };
  const tree = [rootPid, ...descendants(rootPid, opts.index ?? childrenIndex())];
  for (const pid of tree) {
    const sessionId = readClaudeSession(pid, opts.home);
    if (sessionId) {
      result.agent = { provider: 'claude', sessionId, seenAt: opts.now ?? Date.now() };
      return result;
    }
  }
  for (const pid of tree) {
    if (!isCodexCli(pid)) continue;
    let thread = codexThreadFromFds(pid);
    if (thread === undefined) {
      const cwd = readCwd(pid);
      const start = processStartMs(pid);
      if (cwd && start) thread = codexThreadFromState(cwd, start, opts.codexQuery ?? codexStateQuery(opts.home));
    }
    if (thread) {
      result.agent = { provider: 'codex', sessionId: thread, seenAt: opts.now ?? Date.now() };
      return result;
    }
  }
  return result;
}
