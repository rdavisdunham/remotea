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

export function probeSession(
  rootPid: number,
  opts: { home?: string; index?: Map<number, number[]>; now?: number } = {},
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
      break;
    }
  }
  return result;
}
