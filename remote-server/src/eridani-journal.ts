/**
 * The inbound command journal for the Eridani link (C01, F06):
 * `eridani-journal.jsonl` (0600), one line per state change of an operation,
 * keyed by its stable `op_id`.
 *
 *   accepted   written and fsynced BEFORE the ack goes out
 *   executing  the effect has started
 *   executed | failed | rejected   the recorded outcome, returned as-is when
 *              the same op arrives again
 *   uncertain  found `executing` after a restart: the effect may or may not
 *              have happened, and it is never replayed blindly
 *
 * A repeat of an op_id with a different digest is refused. Records older than
 * the replay horizon are dropped on compaction; a command whose own
 * `expires_at` has passed is rejected before it is journaled as accepted.
 *
 * An `accepted` record carries the command body: a restart between the ack and
 * the start of the effect re-runs it (its fences are checked again, so a
 * command for a process the restart lost is rejected, not replayed). An
 * `executing` record found after a restart is handed to `recover` (a spawn is
 * resolved by its run → surface mapping, a stop by whether the process is
 * gone); what `recover` cannot settle becomes `uncertain` and is never re-run.
 *
 * Durable first: what `get`, `unsettled` and `acceptedOps` return is only ever
 * what is on disk. A state change is appended and fdatasynced first and
 * reaches memory only after that succeeded. A failed open, write or sync
 * throws `JournalUnavailableError`, cuts the file back to its length before
 * the write (best effort) and marks the journal `degraded`. The file may then
 * disagree with memory (a torn or unsynced line), so the next write first
 * rewrites the whole file from memory (temp file, fsync, rename); the first
 * write that succeeds clears `degraded`. Settlements found on load
 * (`executing` → settled or `uncertain`) reach memory only once they are on
 * disk too. A journal that exists but cannot be read is never overwritten:
 * nothing is recorded until it can be read again.
 */
import fs from 'fs';
import path from 'path';

export type JournalState = 'accepted' | 'executing' | 'executed' | 'failed' | 'rejected' | 'uncertain';

export interface JournalRecord {
  op_id: string;
  digest: string;
  t: string;
  state: JournalState;
  detail?: string;
  outcome?: unknown;
  /** The command itself, kept while it is `accepted` (re-run after a restart). */
  body?: Record<string, unknown>;
  /** First seen, epoch ms. */
  at: number;
  updatedAt: number;
  durable?: boolean;
}

export const FINAL_STATES: ReadonlySet<JournalState> = new Set(['executed', 'failed', 'rejected', 'uncertain']);

/** The reason a command is refused while the journal cannot record (ack `error`, outcome `detail`). */
export const JOURNAL_UNAVAILABLE = 'journal_unavailable';

/** A state change could not be made durable; nothing about it reached memory. */
export class JournalUnavailableError extends Error {
  readonly code = 'JOURNAL_UNAVAILABLE';
  constructor(readonly reason: string) {
    super(`${JOURNAL_UNAVAILABLE}: ${reason}`);
    this.name = 'JournalUnavailableError';
  }
}

type Stage = 'open' | 'write' | 'sync' | 'compaction' | 'read';

function errCode(err: unknown): string {
  const e = err as NodeJS.ErrnoException | undefined;
  if (e && typeof e.code === 'string' && e.code) return e.code;
  if (e && typeof e.message === 'string' && e.message) return e.message.slice(0, 80);
  return String(err).slice(0, 80);
}

function shortWrite(n: number, len: number): Error {
  return Object.assign(new Error(`short write (${n} of ${len} bytes)`), { code: 'ESHORTWRITE' });
}

export class Journal {
  private readonly recs = new Map<string, JournalRecord>();
  private fd: number | null = null;
  private lines = 0;
  /** Ops a restart moved out of `executing` (settled by `recover`, or uncertain), once on disk: reported once. */
  readonly settledOnLoad: JournalRecord[] = [];
  private readonly now: () => number;
  /** Why the journal cannot record right now; null when healthy. */
  private why: string | null = null;
  /** The file may disagree with memory (a failed append, unwritten load settlements): rewrite before appending. */
  private needsRewrite = false;
  /** The file exists but could not be read. */
  private unread = false;
  /** Load-time settlements not yet on disk, by op. */
  private readonly pendingSettle = new Map<string, JournalRecord>();

  constructor(private readonly opts: {
    file: string | null;
    horizonMs: number;
    now?: () => number;
    log?: (m: string) => void;
    /** Settle an op found `executing` after a restart; null leaves it `uncertain`. */
    recover?: (rec: JournalRecord) => { state: 'executed' | 'failed' | 'rejected' | 'uncertain'; detail?: string; outcome?: unknown } | null;
  }) {
    this.now = opts.now ?? Date.now;
    this.load();
  }

  /** Why durable recording is unavailable (`write failed: ENOSPC`, `sync failed: EIO`, …), or null. */
  get degraded(): string | null {
    return this.why;
  }

  get(op: string): JournalRecord | undefined {
    return this.recs.get(op);
  }

  /** Ops accepted but not finished, and ops whose effect is unknown (for the reconcile snapshot). */
  unsettled(): { pending: string[]; uncertain: string[] } {
    const pending: string[] = [];
    const uncertain: string[] = [];
    for (const r of this.recs.values()) {
      if (r.state === 'accepted' || r.state === 'executing') pending.push(r.op_id);
      else if (r.state === 'uncertain') uncertain.push(r.op_id);
    }
    return { pending, uncertain };
  }

  /** Accepted before a restart and never started: the caller re-runs these. */
  acceptedOps(): JournalRecord[] {
    return [...this.recs.values()].filter((r) => r.state === 'accepted' && r.body);
  }

  /** Every record (tests, status). */
  all(): JournalRecord[] {
    return [...this.recs.values()];
  }

  /**
   * Record a state change durably (fdatasync) before anything acts on it.
   * Throws `JournalUnavailableError` when it could not be made durable;
   * memory is then unchanged.
   */
  record(op: string, patch: { digest: string; t: string; state: JournalState; detail?: string; outcome?: unknown; body?: Record<string, unknown>; durable?: boolean }): JournalRecord {
    const prev = this.recs.get(op);
    const now = this.now();
    const rec: JournalRecord = { op_id: op, at: prev?.at ?? now, updatedAt: now, ...(prev?.durable ? { durable: true } : {}), ...patch };
    if (this.opts.file) {
      this.ensureWritable();
      this.append(rec);
    }
    this.recs.set(op, rec);
    this.healthy();
    if (this.opts.file && this.lines > Math.max(500, this.recs.size * 3)) this.compact();
    return rec;
  }

  /** Try to make the journal writable again (rewrite it from memory). True when it is healthy. */
  probe(): boolean {
    if (!this.opts.file || (!this.why && !this.needsRewrite && !this.unread)) return true;
    try {
      this.ensureWritable();
    } catch {
      return false;
    }
    this.healthy();
    return true;
  }

  /** Drop settled records past the replay horizon and rewrite the file. A failure leaves the file as it was. */
  compact(): void {
    const file = this.opts.file;
    const cutoff = this.now() - this.opts.horizonMs;
    const drop = new Set([...this.recs.values()].filter((r) => !r.durable && r.updatedAt < cutoff && FINAL_STATES.has(r.state)).map((r) => r.op_id));
    if (!file) {
      for (const op of drop) this.recs.delete(op);
      return;
    }
    if (this.unread) return;
    try {
      this.rewrite(drop);
    } catch (err) {
      if (this.needsRewrite) {
        this.fail('compaction', err);
      } else {
        // Every line already in the append-only file is synced: only the cleanup failed.
        this.opts.log?.(`eridani journal: compaction failed (${errCode(err)}); the journal file is unchanged`);
      }
    }
  }

  close(): void {
    if (this.fd === null) return;
    const fd = this.fd;
    this.fd = null;
    try {
      fs.closeSync(fd);
    } catch {
      /* already closed */
    }
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private ensureWritable(): void {
    if (this.unread) {
      try {
        this.loadFile();
      } catch (err) {
        throw this.fail('read', err);
      }
    }
    if (this.needsRewrite) {
      try {
        this.rewrite(new Set());
      } catch (err) {
        throw this.fail('compaction', err);
      }
    }
  }

  private append(rec: JournalRecord): void {
    const buf = Buffer.from(JSON.stringify(rec) + '\n');
    let stage: Stage = 'open';
    let before = -1;
    try {
      if (this.fd === null) this.fd = fs.openSync(this.opts.file!, 'a', 0o600);
      before = fs.fstatSync(this.fd).size;
      stage = 'write';
      const n = fs.writeSync(this.fd, buf);
      if (n !== buf.length) throw shortWrite(n, buf.length);
      stage = 'sync';
      fs.fdatasyncSync(this.fd);
    } catch (err) {
      this.undo(before);
      throw this.fail(stage, err);
    }
    this.lines++;
  }

  /** After a failed append: cut the file back, so a restart does not find a line nobody acted on (best effort). */
  private undo(before: number): void {
    if (this.fd !== null && before >= 0) {
      try {
        fs.ftruncateSync(this.fd, before);
        fs.fdatasyncSync(this.fd);
      } catch {
        /* the rewrite before the next append fixes the file */
      }
    }
    this.close();
  }

  /**
   * Write memory (plus pending load settlements, minus `drop`) to a temp file,
   * fsync it and rename it over the journal. Memory changes only after that
   * succeeded.
   */
  private rewrite(drop: Set<string>): void {
    const file = this.opts.file!;
    const view = new Map(this.recs);
    for (const [op, r] of this.pendingSettle) view.set(op, r);
    for (const op of drop) view.delete(op);
    const buf = Buffer.from([...view.values()].map((r) => JSON.stringify(r) + '\n').join(''));
    const tmp = `${file}.tmp-${process.pid}`;
    try {
      const fd = fs.openSync(tmp, 'w', 0o600);
      try {
        const n = fs.writeSync(fd, buf);
        if (n !== buf.length) throw shortWrite(n, buf.length);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      this.close();
      fs.renameSync(tmp, file);
    } catch (err) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        /* nothing to clean */
      }
      throw err;
    }
    syncDir(path.dirname(file));
    for (const op of drop) this.recs.delete(op);
    for (const [op, r] of this.pendingSettle) {
      this.recs.set(op, r);
      this.settledOnLoad.push(r);
      this.opts.log?.(`eridani journal: ${r.op_id} (${r.t}) ${r.state === 'uncertain' ? 'is uncertain' : `settled: ${r.state}`} after a restart`);
    }
    this.pendingSettle.clear();
    this.lines = view.size;
    this.needsRewrite = false;
  }

  private fail(stage: Stage, err: unknown): JournalUnavailableError {
    const reason = `${stage} failed: ${errCode(err)}`;
    this.needsRewrite = true;
    if (this.why !== reason) this.opts.log?.(`eridani journal: cannot record (${reason}); commands are refused until a write succeeds`);
    this.why = reason;
    return new JournalUnavailableError(reason);
  }

  private healthy(): void {
    if (this.why === null) return;
    this.opts.log?.(`eridani journal: writable again (was: ${this.why})`);
    this.why = null;
  }

  private load(): void {
    const file = this.opts.file;
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    } catch {
      /* reading, or the first write, says what is wrong */
    }
    let existed: boolean;
    try {
      existed = this.loadFile();
    } catch (err) {
      // Never start from an empty memory over a journal that exists: a duplicate could run twice.
      this.unread = true;
      this.fail('read', err);
      return;
    }
    if (!existed) return;
    // Load settlements (and the horizon) are written by this compaction; until then they are not in memory.
    this.needsRewrite = true;
    this.compact();
  }

  /** Read the file into memory; `executing` records become pending settlements. False when there is no file. */
  private loadFile(): boolean {
    const file = this.opts.file!;
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      this.unread = false;
      return false;
    }
    this.unread = false;
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        const r = JSON.parse(line) as JournalRecord;
        if (typeof r.op_id === 'string') this.recs.set(r.op_id, r);
        this.lines++;
      } catch {
        /* a torn line */
      }
    }
    for (const r of this.recs.values()) {
      if (FINAL_STATES.has(r.state)) delete r.body;
      if (r.state !== 'executing') continue;
      // A restart in the middle of an effect: nobody knows whether it happened.
      let settled: ReturnType<NonNullable<typeof this.opts.recover>> = null;
      try {
        settled = this.opts.recover?.(r) ?? null;
      } catch {
        settled = null;
      }
      const next: JournalRecord = settled
        ? { ...r, ...settled, updatedAt: this.now() }
        : { ...r, state: 'uncertain', detail: 'the server restarted while this was running', updatedAt: this.now() };
      delete next.body;
      this.pendingSettle.set(r.op_id, next);
    }
    return true;
  }
}

/** fsync a directory so a rename in it is durable (best effort: not every filesystem allows it). */
function syncDir(dir: string): void {
  let fd: number | null = null;
  try {
    fd = fs.openSync(dir, 'r');
    fs.fsyncSync(fd);
  } catch {
    /* best effort */
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* closed */
      }
    }
  }
}
