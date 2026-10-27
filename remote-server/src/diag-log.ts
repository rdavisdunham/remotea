/**
 * App diagnostics, written where someone debugging on the server can read them:
 * ~/.local/state/remotea/diag/<device>.jsonl (or $REMOTEA_STATE_DIR/diag).
 *
 * Apps send what happened — connection state changes, opens and their mode,
 * resyncs, agent-state verdicts, errors — never terminal content or keystrokes
 * (the protocol caps every field to a short scalar). One file per device, cut
 * over to `.1` at MAX_BYTES, and a per-device rate cap so a looping app cannot
 * fill the disk.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { DiagEvent } from '../../src/shared/remote-host-protocol';

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_PER_MINUTE = 3000;

export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.REMOTEA_STATE_DIR) return env.REMOTEA_STATE_DIR;
  return path.join(env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'remotea');
}

export function diagDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(stateDir(env), 'diag');
}

export class DiagLog {
  private readonly windows = new Map<string, { start: number; count: number; dropped: number }>();

  constructor(private readonly dir: string, private readonly now: () => number = Date.now) {}

  write(device: { id: string; name: string }, events: DiagEvent[]): void {
    const safeId = device.id.replace(/[^A-Za-z0-9_-]/g, '_');
    const now = this.now();
    let w = this.windows.get(safeId);
    if (!w || now - w.start >= 60_000) {
      const dropped = w?.dropped ?? 0;
      w = { start: now, count: 0, dropped: 0 };
      this.windows.set(safeId, w);
      if (dropped) events = [{ at: now, src: 'main', kind: 'diag.dropped', data: { count: dropped } }, ...events];
    }
    const room = Math.max(0, MAX_PER_MINUTE - w.count);
    if (events.length > room) {
      w.dropped += events.length - room;
      events = events.slice(0, room);
    }
    w.count += events.length;
    if (!events.length) return;
    const lines = events.map((e) => JSON.stringify({ recv: now, device: device.name, ...e })).join('\n') + '\n';
    try {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      const file = path.join(this.dir, `${safeId}.jsonl`);
      try {
        if (fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, `${file}.1`);
      } catch {
        /* first write */
      }
      fs.appendFileSync(file, lines, { mode: 0o600 });
    } catch {
      /* diagnostics must never take the server down */
    }
  }
}
