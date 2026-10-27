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

/** Codex appends to its rollout file while it runs: the open file names the thread exactly. */
export function codexThreadFromFds(pid: number): string | null {
  let fds: string[];
  try {
    fds = fs.readdirSync(`/proc/${pid}/fd`);
  } catch {
    return null;
  }
  for (const fd of fds) {
    try {
      const id = codexThreadFromPath(fs.readlinkSync(`/proc/${pid}/fd/${fd}`));
      if (id) return id;
    } catch {
      /* closed meanwhile */
    }
  }
  return null;
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

/**
 * Codex's own thread index, opened READ-ONLY. node:sqlite is loaded lazily:
 * it is only needed when the rollout-file route found nothing.
 */
export function codexStateQuery(home = os.homedir()): CodexThreadQuery {
  return (cwd, sinceMs) => {
    const file = path.join(home, '.codex', 'state_5.sqlite');
    if (!fs.existsSync(file)) return null;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: new (f: string, o: { readOnly: boolean }) => { prepare(sql: string): { all(...a: unknown[]): unknown[] }; close(): void } };
      const db = new DatabaseSync(file, { readOnly: true });
      try {
        return db.prepare('SELECT id, created_at_ms FROM threads WHERE cwd = ? AND created_at_ms >= ? ORDER BY created_at_ms LIMIT 5').all(cwd, sinceMs) as ThreadRow[];
      } finally {
        db.close();
      }
    } catch {
      return null;
    }
  };
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
    if (!thread) {
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
