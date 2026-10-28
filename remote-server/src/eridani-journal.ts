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
}

export const FINAL_STATES: ReadonlySet<JournalState> = new Set(['executed', 'failed', 'rejected', 'uncertain']);

export class Journal {
  private readonly recs = new Map<string, JournalRecord>();
  private fd: number | null = null;
  private lines = 0;
  /** Ops a restart moved out of `executing` (settled by `recover`, or uncertain): reported once. */
  readonly settledOnLoad: JournalRecord[] = [];
  private readonly now: () => number;

  constructor(private readonly opts: {
    file: string | null;
    horizonMs: number;
    now?: () => number;
    log?: (m: string) => void;
    /** Settle an op found `executing` after a restart; null leaves it `uncertain`. */
    recover?: (rec: JournalRecord) => { state: 'executed' | 'failed' | 'rejected'; detail?: string; outcome?: unknown } | null;
  }) {
    this.now = opts.now ?? Date.now;
    this.load();
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

  /** Record a state change durably (fsync) before anything acts on it. */
  record(op: string, patch: { digest: string; t: string; state: JournalState; detail?: string; outcome?: unknown; body?: Record<string, unknown> }): JournalRecord {
    const prev = this.recs.get(op);
    const now = this.now();
    const rec: JournalRecord = { op_id: op, at: prev?.at ?? now, updatedAt: now, ...patch };
    this.recs.set(op, rec);
    this.append(rec);
    return rec;
  }

  private append(rec: JournalRecord): void {
    const file = this.opts.file;
    if (!file) return;
    if (this.fd === null) this.fd = fs.openSync(file, 'a', 0o600);
    fs.writeSync(this.fd, JSON.stringify(rec) + '\n');
    fs.fdatasyncSync(this.fd);
    if (++this.lines > Math.max(500, this.recs.size * 3)) this.compact();
  }

  compact(): void {
    const file = this.opts.file;
    const cutoff = this.now() - this.opts.horizonMs;
    for (const [op, r] of this.recs) if (r.updatedAt < cutoff && FINAL_STATES.has(r.state)) this.recs.delete(op);
    if (!file) return;
    const tmp = `${file}.tmp-${process.pid}`;
    const text = [...this.recs.values()].map((r) => JSON.stringify(r) + '\n').join('');
    const fd = fs.openSync(tmp, 'w', 0o600);
    try {
      fs.writeSync(fd, text);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    this.close();
    fs.renameSync(tmp, file);
    this.lines = this.recs.size;
  }

  close(): void {
    if (this.fd !== null) {
      fs.closeSync(this.fd);
      this.fd = null;
    }
  }

  private load(): void {
    const file = this.opts.file;
    if (!file) return;
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      return;
    }
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        const r = JSON.parse(line) as JournalRecord;
        if (typeof r.op_id === 'string') this.recs.set(r.op_id, r);
        this.lines++;
      } catch {
        /* a torn final line */
      }
    }
    // A restart in the middle of an effect: nobody knows whether it happened.
    for (const r of this.recs.values()) {
      if (r.state === 'executing') {
        let settled: ReturnType<NonNullable<typeof this.opts.recover>> = null;
        try {
          settled = this.opts.recover?.(r) ?? null;
        } catch {
          settled = null;
        }
        this.settledOnLoad.push(r);
        if (settled) {
          Object.assign(r, settled, { updatedAt: this.now() });
          this.opts.log?.(`eridani journal: ${r.op_id} (${r.t}) settled after a restart: ${settled.state}`);
        } else {
          r.state = 'uncertain';
          r.detail = 'the server restarted while this was running';
          this.opts.log?.(`eridani journal: ${r.op_id} (${r.t}) is uncertain after a restart`);
        }
      }
      if (FINAL_STATES.has(r.state)) delete r.body;
    }
    this.compact();
  }
}
