import fs from 'node:fs';
import path from 'node:path';
import { SURFACE_ID_RE } from '../shared/remote-console-protocol';

/** Personal selection history for this desktop. Host-backed visits are also
 * recorded on the host so authenticated clients can agree after a handoff. */
export class TerminalVisits {
  private readonly times = new Map<string, number>();
  private saveTimer?: ReturnType<typeof setTimeout>;
  private dirty = false;

  constructor(private readonly file: string) {
    try {
      const rows: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(rows)) for (const row of rows.slice(-8192)) {
        if (Array.isArray(row) && typeof row[0] === 'string' && SURFACE_ID_RE.test(row[0]) &&
            Number.isSafeInteger(row[1]) && row[1] > 0) this.times.set(row[0], row[1]);
      }
    } catch { /* A first run or an unreadable history starts with unknown recency. */ }
  }

  get(id: string): number | null { return this.times.get(id) ?? null; }

  note(id: string, now = Date.now()): void {
    if (!SURFACE_ID_RE.test(id)) return;
    this.times.delete(id);
    this.times.set(id, now);
    if (this.times.size > 8192) this.times.delete(this.times.keys().next().value!);
    this.dirty = true;
    if (!this.saveTimer) {
      this.saveTimer = setTimeout(() => this.flush(), 1500);
      this.saveTimer.unref();
    }
  }

  flush(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    if (!this.dirty) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file + '.tmp', JSON.stringify([...this.times]), { mode: 0o600 });
      fs.renameSync(this.file + '.tmp', this.file);
      this.dirty = false;
    } catch { /* Keep the in-memory order and retry after the next interaction. */ }
  }
}
