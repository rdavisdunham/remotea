/**
 * The outbox for the Eridani link: every upward event waits here, on disk,
 * until Eridani acknowledges it (C14).
 *
 *   eridani-outbox.jsonl (0600), append-only:
 *     {"k":"put","e":{…entry}}   an event to deliver
 *     {"k":"del","op":"…"}       acknowledged, replaced or evicted
 *     {"k":"dirty","entity":"…"} evicted before delivery: its source must be re-read
 *     {"k":"clean","entity":"…"} the dirty mark was consumed
 *   rewritten (temp file + rename) when dead lines outnumber live ones.
 *
 * Rules:
 *   - Coalescing: an entry with an `entity` (session.report, status) replaces
 *     the unacked entry for the same entity. Numeric revisions only move
 *     forward, so an older status can never override a newer one.
 *   - Lanes: 0 control (snapshots, command outcomes), 1 live (turn, status,
 *     exit), 2 bulk (collector reports). Delivery drains lanes in order.
 *   - Bounds: over `maxEntries`/`maxBytes` the oldest coalescable entry is
 *     evicted and its entity marked dirty — never silently dropped. Entries
 *     without an entity (turns, exits) are protected: they may run to
 *     `hardFactor` × the bounds, past which the spool refuses and reports
 *     itself degraded.
 *   - A torn final line (a crash mid-append) is cut off on load.
 *   - Any failed write (disk full, EIO, a permission change, a short write)
 *     keeps the entry in memory and marks the spool degraded. The file may
 *     then hold a torn line or miss one, so nothing more is appended to it:
 *     the next write rewrites it whole from memory (a compaction), and the
 *     first compaction that succeeds clears the degradation. Unlike the
 *     inbound journal, the outbox is memory-first by design: a degraded
 *     outbox only risks losing events across a restart, never running
 *     anything, and the status says so.
 *   - An outbox that exists but cannot be read is never overwritten: events
 *     stay in memory until a later read succeeds and the two are merged.
 *   - `ephemeral` entries (a connection's reconcile snapshot) never touch disk.
 */
import fs from 'fs';
import path from 'path';

export type Lane = 0 | 1 | 2;

export interface SpoolEntry {
  op_id: string;
  lane: Lane;
  entity?: string;
  revision?: string | number;
  /** The frame body without the envelope (t, op_id, digest, …). */
  body: Record<string, unknown>;
  bytes: number;
  /** Insertion order. */
  n: number;
  at: number;
  ephemeral?: boolean;
}

export interface SpoolOptions {
  file: string | null;
  maxEntries: number;
  maxBytes: number;
  hardFactor: number;
  onDirty?: (entity: string) => void;
  log?: (msg: string) => void;
  now?: () => number;
  /** Test seam for disk-full: replaces fs.appendFileSync + fsync. */
  append?: (file: string, text: string) => void;
}

export type PutResult = { ok: true; op_id: string; evicted: string[] } | { ok: false; reason: string };

const DISK_ERRORS = new Set(['ENOSPC', 'EDQUOT', 'EIO', 'EROFS']);

export class Spool {
  private readonly entries = new Map<string, SpoolEntry>();
  private readonly byEntity = new Map<string, string>();
  private readonly dirtySet = new Set<string>();
  private counter = 0;
  private bytesTotal = 0;
  private deadLines = 0;
  private fd: number | null = null;
  /** Why the file is behind memory (`disk-full`, `write-failed: EACCES`, `read-failed: …`); null when it is not. */
  private writeError: string | null = null;
  /** The file may disagree with memory: rewrite it whole before appending again. */
  private needsRewrite = false;
  /** The file exists but could not be read: never overwrite it. */
  private unread = false;
  /** Protected events are being refused (past the hard bound). */
  private full = false;
  evictedTotal = 0;
  private readonly now: () => number;

  constructor(private readonly opts: SpoolOptions) {
    this.now = opts.now ?? Date.now;
    this.load();
  }

  /** Why the outbox is not keeping up (a failed write wins over `spool-full`), or null. */
  get degraded(): string | null {
    return this.writeError ?? (this.full ? 'spool-full' : null);
  }

  get size(): number {
    return this.entries.size;
  }

  get bytes(): number {
    return this.bytesTotal;
  }

  /** How full the spool is, 0–1, against the soft bounds. */
  get fill(): number {
    return Math.max(this.entries.size / this.opts.maxEntries, this.bytesTotal / this.opts.maxBytes);
  }

  get dirty(): string[] {
    return [...this.dirtySet];
  }

  get(op: string): SpoolEntry | undefined {
    return this.entries.get(op);
  }

  /** Every unacked entry in delivery order: by lane, then oldest first. */
  pending(): SpoolEntry[] {
    return [...this.entries.values()].sort((a, b) => a.lane - b.lane || a.n - b.n);
  }

  put(e: Omit<SpoolEntry, 'n' | 'at' | 'bytes'>): PutResult {
    const bytes = Buffer.byteLength(JSON.stringify(e.body));
    const evicted: string[] = [];
    if (e.entity) {
      const prevOp = this.byEntity.get(e.entity);
      const prev = prevOp ? this.entries.get(prevOp) : undefined;
      if (prev) {
        if (prev.revision === e.revision) return { ok: true, op_id: prev.op_id, evicted };
        if (typeof prev.revision === 'number' && typeof e.revision === 'number' && e.revision < prev.revision) {
          return { ok: true, op_id: prev.op_id, evicted };
        }
        this.remove(prev.op_id);
      }
    }
    const protectedEntry = !e.entity;
    const hardEntries = this.opts.maxEntries * this.opts.hardFactor;
    const hardBytes = this.opts.maxBytes * this.opts.hardFactor;
    const entry: SpoolEntry = { ...e, bytes, n: ++this.counter, at: this.now() };
    this.insert(entry);
    // Make room: oldest coalescable first (bulk lane before live).
    while (this.entries.size > this.opts.maxEntries || this.bytesTotal > this.opts.maxBytes) {
      const victim = this.pending().filter((x) => x.entity && !x.ephemeral).sort((a, b) => b.lane - a.lane || a.n - b.n)[0];
      if (!victim) break;
      this.remove(victim.op_id);
      this.markDirty(victim.entity!);
      this.evictedTotal++;
      evicted.push(victim.op_id);
      if (victim.op_id === entry.op_id) {
        this.opts.log?.(`eridani spool: full, ${victim.entity} left dirty`);
        return { ok: false, reason: 'spool-full' };
      }
    }
    if (protectedEntry && (this.entries.size > hardEntries || this.bytesTotal > hardBytes)) {
      this.remove(entry.op_id);
      if (!this.full) this.opts.log?.('eridani spool: full of protected events; refusing new ones');
      this.full = true;
      return { ok: false, reason: 'spool-full' };
    }
    if (protectedEntry) this.full = false;
    if (!entry.ephemeral) this.write({ k: 'put', e: entry });
    return { ok: true, op_id: entry.op_id, evicted };
  }

  /** Acknowledged (or permanently refused): gone for good. */
  ack(op: string): SpoolEntry | undefined {
    const e = this.entries.get(op);
    if (!e) return undefined;
    this.remove(op);
    if (this.full && this.entries.size < this.opts.maxEntries * this.opts.hardFactor && this.bytesTotal < this.opts.maxBytes * this.opts.hardFactor) this.full = false;
    return e;
  }

  /** Drop entries that only make sense on one connection (the reconcile snapshot). */
  dropEphemeral(): void {
    for (const e of [...this.entries.values()]) if (e.ephemeral) this.remove(e.op_id, false);
  }

  /** Hand out the dirty marks (the collector re-reads those sources). */
  takeDirty(): string[] {
    const out = [...this.dirtySet];
    for (const entity of out) {
      this.dirtySet.delete(entity);
      this.write({ k: 'clean', entity });
    }
    return out;
  }

  close(): void {
    if (this.fd !== null) {
      try {
        fs.closeSync(this.fd);
      } catch {
        /* already closed */
      }
      this.fd = null;
    }
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private insert(e: SpoolEntry): void {
    this.entries.set(e.op_id, e);
    if (e.entity) this.byEntity.set(e.entity, e.op_id);
    this.bytesTotal += e.bytes;
  }

  private remove(op: string, persist = true): void {
    const e = this.entries.get(op);
    if (!e) return;
    this.entries.delete(op);
    if (e.entity && this.byEntity.get(e.entity) === op) this.byEntity.delete(e.entity);
    this.bytesTotal -= e.bytes;
    if (persist && !e.ephemeral) this.write({ k: 'del', op });
  }

  private markDirty(entity: string): void {
    if (!this.dirtySet.has(entity)) {
      this.dirtySet.add(entity);
      this.write({ k: 'dirty', entity });
    }
    this.opts.onDirty?.(entity);
  }

  /**
   * Persist one change already made in memory. After any failed write the file
   * is only ever rewritten whole (a compaction captures this change too), never
   * appended to, so a torn or missing line cannot corrupt the lines after it.
   */
  private write(line: Record<string, unknown>): void {
    const file = this.opts.file;
    if (!file) return;
    if (line.k !== 'put') this.deadLines++;
    if (this.unread || this.needsRewrite || this.deadLines > Math.max(1000, this.entries.size * 2)) {
      this.compact();
      return;
    }
    try {
      this.appendLine(file, JSON.stringify(line) + '\n');
    } catch (err) {
      this.onWriteError(err);
    }
  }

  private appendLine(file: string, text: string): void {
    if (this.opts.append) return this.opts.append(file, text);
    if (this.fd === null) this.fd = fs.openSync(file, 'a', 0o600);
    const buf = Buffer.from(text);
    const n = fs.writeSync(this.fd, buf);
    if (n !== buf.length) throw Object.assign(new Error(`short write (${n} of ${buf.length} bytes)`), { code: 'ESHORTWRITE' });
    fs.fdatasyncSync(this.fd);
  }

  private onWriteError(err: unknown): void {
    const code = (err as NodeJS.ErrnoException)?.code ?? '';
    const reason = DISK_ERRORS.has(code) || code === 'TEST_DISK_FULL' ? 'disk-full' : `write-failed: ${code || (err as Error)?.message || String(err)}`;
    this.needsRewrite = true;
    this.close();
    if (this.writeError !== reason) this.opts.log?.(`eridani spool: cannot write (${reason}); keeping events in memory`);
    this.writeError = reason;
  }

  /** Rewrite the file with only the live entries and dirty marks. */
  compact(): void {
    const file = this.opts.file;
    if (!file) return;
    if (this.unread && !this.reread(file)) return;
    const lines = [...this.entries.values()].filter((e) => !e.ephemeral).sort((a, b) => a.n - b.n).map((e) => JSON.stringify({ k: 'put', e }));
    for (const entity of this.dirtySet) lines.push(JSON.stringify({ k: 'dirty', entity }));
    const text = lines.length ? lines.join('\n') + '\n' : '';
    const tmp = `${file}.tmp-${process.pid}`;
    try {
      if (this.opts.append) {
        this.opts.append(tmp, text);
      } else {
        const fd = fs.openSync(tmp, 'w', 0o600);
        try {
          const buf = Buffer.from(text);
          const n = fs.writeSync(fd, buf);
          if (n !== buf.length) throw Object.assign(new Error(`short write (${n} of ${buf.length} bytes)`), { code: 'ESHORTWRITE' });
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
      }
      this.close();
      fs.renameSync(tmp, file);
    } catch (err) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        /* nothing to clean */
      }
      this.onWriteError(err);
      return;
    }
    this.deadLines = 0;
    this.needsRewrite = false;
    if (this.writeError) this.opts.log?.(`eridani spool: writing again (was: ${this.writeError})`);
    this.writeError = null;
  }

  private load(): void {
    const file = this.opts.file;
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    } catch {
      /* reading, or the first write, says what is wrong */
    }
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') this.markUnread(err);
      return;
    }
    // A crash mid-append leaves a final line without its newline: cut it off.
    const lastNl = text.lastIndexOf('\n');
    if (lastNl !== text.length - 1) {
      const keep = text.slice(0, lastNl + 1);
      this.opts.log?.(`eridani spool: dropped a torn final line (${text.length - keep.length} bytes)`);
      try {
        fs.truncateSync(file, Buffer.byteLength(keep));
      } catch {
        // Appending after the torn line would corrupt the next one: rewrite instead.
        this.needsRewrite = true;
      }
      text = keep;
    }
    this.parse(text);
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      /* not ours to fix */
    }
  }

  private parse(text: string): void {
    for (const line of text.split('\n')) {
      if (!line) continue;
      let rec: { k?: string; e?: SpoolEntry; op?: string; entity?: string };
      try {
        rec = JSON.parse(line);
      } catch {
        this.deadLines++;
        continue;
      }
      if (rec.k === 'put' && rec.e && typeof rec.e.op_id === 'string') {
        const prev = rec.e.entity ? this.byEntity.get(rec.e.entity) : undefined;
        if (prev) this.remove(prev, false);
        this.insert(rec.e);
        this.counter = Math.max(this.counter, rec.e.n ?? 0);
      } else if (rec.k === 'del' && rec.op) {
        this.remove(rec.op, false);
        this.deadLines++;
      } else if (rec.k === 'dirty' && rec.entity) this.dirtySet.add(rec.entity);
      else if (rec.k === 'clean' && rec.entity) this.dirtySet.delete(rec.entity);
    }
  }

  private markUnread(err: unknown): void {
    this.unread = true;
    const reason = `read-failed: ${(err as NodeJS.ErrnoException)?.code || (err as Error)?.message || String(err)}`;
    if (this.writeError !== reason) this.opts.log?.(`eridani spool: cannot read the outbox (${reason}); keeping events in memory and leaving the file alone`);
    this.writeError = reason;
  }

  /**
   * The outbox could not be read at start: try again, and merge what it holds
   * under what memory gathered since (memory is newer for the same entity;
   * the file's events go first). False while it still cannot be read.
   */
  private reread(file: string): boolean {
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.markUnread(err);
        return false;
      }
      text = '';
    }
    const mine = [...this.entries.values()];
    const myDirty = [...this.dirtySet];
    for (const e of mine) this.remove(e.op_id, false);
    this.counter = 0;
    const lastNl = text.lastIndexOf('\n');
    this.parse(text.slice(0, lastNl + 1));
    const base = this.counter;
    for (const e of mine.sort((a, b) => a.n - b.n)) {
      const prev = e.entity ? this.byEntity.get(e.entity) : undefined;
      if (prev) this.remove(prev, false);
      this.insert({ ...e, n: base + e.n });
    }
    this.counter = base + mine.reduce((m, e) => Math.max(m, e.n), 0);
    for (const entity of myDirty) this.dirtySet.add(entity);
    this.unread = false;
    this.opts.log?.('eridani spool: the outbox is readable again; merged it with the events kept in memory');
    return true;
  }
}
