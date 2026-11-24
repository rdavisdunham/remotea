/**
 * /proc helpers: process trees, the terminal's foreground process, and
 * killing a session's descendants. Linux only (the server runs in WSL).
 */
import fs from 'fs';

export interface ProcStat {
  pid: number;
  comm: string;
  ppid: number;
  pgrp: number;
  /** Foreground process group of the controlling terminal. */
  tpgid: number;
}

export function readStat(pid: number): ProcStat | null {
  let raw: string;
  try {
    raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch {
    return null;
  }
  // comm is parenthesised and may itself contain spaces or parentheses.
  const open = raw.indexOf('(');
  const close = raw.lastIndexOf(')');
  if (open < 0 || close < open) return null;
  const comm = raw.slice(open + 1, close);
  const rest = raw.slice(close + 2).split(' ');
  // rest[0]=state [1]=ppid [2]=pgrp [3]=session [4]=tty_nr [5]=tpgid
  return {
    pid,
    comm,
    ppid: Number(rest[1]),
    pgrp: Number(rest[2]),
    tpgid: Number(rest[5]),
  };
}

/** Foreground process-group leader belonging to this terminal's process tree. */
export function paneForegroundPid(root: number): number | null {
  const pid = readStat(root)?.tpgid;
  if (!pid || pid <= 1) return null;
  const stat = readStat(pid);
  if (stat?.pgrp !== pid || stat.tpgid !== pid) return null;
  let ancestor = pid;
  for (let depth = 0; depth < 16 && ancestor > 1 && ancestor !== root; depth++) {
    ancestor = readStat(ancestor)?.ppid ?? 0;
  }
  return ancestor === root ? pid : null;
}

/** Map of ppid → child pids for every process visible right now. */
export function childrenIndex(): Map<number, number[]> {
  const index = new Map<number, number[]>();
  let entries: string[];
  try {
    entries = fs.readdirSync('/proc');
  } catch {
    return index;
  }
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    const st = readStat(Number(name));
    if (!st) continue;
    const list = index.get(st.ppid);
    if (list) list.push(st.pid);
    else index.set(st.ppid, [st.pid]);
  }
  return index;
}

/** Every descendant of `root` (not including root), breadth first. */
export function descendants(root: number, index: Map<number, number[]> = childrenIndex()): number[] {
  const out: number[] = [];
  const queue = [...(index.get(root) ?? [])];
  while (queue.length) {
    const pid = queue.shift()!;
    out.push(pid);
    queue.push(...(index.get(pid) ?? []));
  }
  return out;
}

export function readCwd(pid: number): string | null {
  try {
    return fs.readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    return null;
  }
}

/** Send `signal` to the process and every descendant; errors (already gone) ignored. */
export function signalTree(root: number, signal: NodeJS.Signals): void {
  if (!isSignalablePid(root)) return;
  const pids = [root, ...descendants(root)];
  for (const pid of pids.reverse()) {
    if (!isSignalablePid(pid)) continue;
    try {
      process.kill(pid, signal);
    } catch {
      /* already exited */
    }
  }
}

/**
 * Never signal pid 0 (our own process group), 1 (init) or a negative pid
 * (`kill(-1)` signals EVERY process we may signal). A real child pid is > 1.
 */
export function isSignalablePid(pid: number): boolean {
  return Number.isInteger(pid) && pid > 1;
}
