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
 *   - A torn final line (a crash mid-append) is cut off on load; disk full
 *     keeps the entry in memory, marks the spool degraded, and retries the
 *     file on the next compaction.
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
  degraded: string | null = null;
  evictedTotal = 0;
  private readonly now: () => number;

  constructor(private readonly opts: SpoolOptions) {
    this.now = opts.now ?? Date.now;
    this.load();
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
      this.degraded = 'spool-full';
      this.opts.log?.('eridani spool: full of protected events; refusing new ones');
      return { ok: false, reason: 'spool-full' };
    }
    if (!entry.ephemeral) this.write({ k: 'put', e: entry });
    return { ok: true, op_id: entry.op_id, evicted };
  }

  /** Acknowledged (or permanently refused): gone for good. */
  ack(op: string): SpoolEntry | undefined {
    const e = this.entries.get(op);
    if (!e) return undefined;
    this.remove(op);
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

  private write(line: Record<string, unknown>): void {
    const file = this.opts.file;
    if (!file) return;
    if (line.k !== 'put') this.deadLines++;
    if (this.degraded === 'disk-full' || this.deadLines > Math.max(1000, this.entries.size * 2)) {
      this.compact();
      if (this.degraded !== 'disk-full') return;
    }
    if (this.degraded === 'disk-full') return;
    try {
      this.appendLine(file, JSON.stringify(line) + '\n');
    } catch (err) {
      this.onWriteError(err);
    }
  }

  private appendLine(file: string, text: string): void {
    if (this.opts.append) return this.opts.append(file, text);
    if (this.fd === null) this.fd = fs.openSync(file, 'a', 0o600);
    fs.writeSync(this.fd, text);
    fs.fdatasyncSync(this.fd);
  }

  private onWriteError(err: unknown): void {
    const code = (err as NodeJS.ErrnoException).code ?? '';
    this.degraded = DISK_ERRORS.has(code) || code === 'TEST_DISK_FULL' ? 'disk-full' : `write-failed: ${code || (err as Error).message}`;
    this.opts.log?.(`eridani spool: cannot write (${this.degraded}); keeping events in memory`);
  }

  /** Rewrite the file with only the live entries and dirty marks. */
  compact(): void {
    const file = this.opts.file;
    if (!file) return;
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
          fs.writeSync(fd, text);
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
      }
      this.close();
      fs.renameSync(tmp, file);
      this.deadLines = 0;
      if (this.degraded === 'disk-full') this.degraded = null;
    } catch (err) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        /* nothing to clean */
      }
      this.onWriteError(err);
    }
  }

  private load(): void {
    const file = this.opts.file;
    if (!file) return;
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      return;
    }
    // A crash mid-append leaves a final line without its newline: cut it off.
    const lastNl = text.lastIndexOf('\n');
    if (lastNl !== text.length - 1) {
      const keep = text.slice(0, lastNl + 1);
      this.opts.log?.(`eridani spool: dropped a torn final line (${text.length - keep.length} bytes)`);
      fs.truncateSync(file, Buffer.byteLength(keep));
      text = keep;
    }
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
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      /* not ours to fix */
    }
  }
}
