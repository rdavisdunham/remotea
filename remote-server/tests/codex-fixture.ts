import fs from 'fs';
import os from 'os';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';

/** Private scratch index/rollouts: these tests never read or launch the user's Codex. */
export function codexFixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'remotea-codex-'));
  const sessions = path.join(home, '.codex', 'sessions', '2026', '11', '02');
  fs.mkdirSync(sessions, { recursive: true });
  const db = new DatabaseSync(path.join(home, '.codex', 'state_5.sqlite'));
  db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, source TEXT, cwd TEXT, created_at_ms INTEGER)');
  const fds: number[] = [];
  return {
    home,
    db,
    thread(id: string, meta: Record<string, unknown> = {}, createdAt = 10_000): string {
      const file = path.join(sessions, `rollout-2026-11-02T20-08-03-${id}.jsonl`);
      const payload = { id, source: 'cli', cwd: '/proj', ...meta };
      fs.writeFileSync(file, JSON.stringify({ type: 'session_meta', payload }) + '\n');
      db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?)').run(
        id, file, typeof payload.source === 'string' ? payload.source : JSON.stringify(payload.source),
        String(payload.cwd), createdAt,
      );
      return file;
    },
    open(file: string): void {
      fds.push(fs.openSync(file, 'a'));
    },
    dispose(): void {
      for (const fd of fds) fs.closeSync(fd);
      db.close();
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}
