/**
 * Verification attempts (stage D, C04): WHEN a verification runs on a
 * surface and under which attempt id. verify-runner.ts runs it.
 *
 *   automatic  After each root execution turn on a surface whose run carries
 *              a verify config (`EridaniBinding.verify`: from the spawn, a
 *              `verify` command or runs.snapshot), the configured verify id
 *              runs 2 s later (debounced: a newer turn inside the window
 *              replaces it). Its attempt id is minted here, `local:<uuid>`,
 *              and `verify.result` carries `initiator: "host"`. Not for an
 *              interim Stop (background tasks still running), a turn of an
 *              older generation, or a surface whose stop was requested.
 *   commanded  An Eridani `verify` command keeps Eridani's attempt id. When a
 *              host attempt for the SAME tuple (run, generation, turn_seq,
 *              plan_revision, verify_id) is waiting, it starts at once under
 *              Eridani's id; when it is running, Eridani's id adopts it (one
 *              run, one result, `adopted` naming the local id); when it has
 *              finished and the tree is unchanged, its result is sent again
 *              under Eridani's id. Same machinery, never two runs for one tuple.
 *   one at a time per surface. A newer root turn cancels the running attempt
 *              (its result says `canceled`), as do a stop and the process
 *              exiting. A command for an OLDER tuple than the running one is
 *              refused ("superseded"); any other command replaces it.
 *   fingerprint  Taken when the turn ends and again before and after the run
 *              (verify-runner.ts); any difference is `stale_workspace`.
 *
 * The latest attempt per surface is persisted on the session record
 * (`SessionRecord.verify`) for `remotea status --json`. After a restart a
 * pending or running attempt is `interrupted`: a host attempt is not rerun
 * (the next turn makes a new one), and a commanded one is settled by the
 * command journal (`failed`, interrupted by a server restart).
 */
import crypto from 'crypto';
import { ERIDANI_LIMITS, type VerifyCommand, type VerifyResultBody } from '../../src/shared/eridani-link-protocol';
import { redact } from './collector/redact';
import type { SessionRecord, VerifyAttemptStatus } from '../../src/shared/remote-host-protocol';
import type { TurnFields } from './turn-capture';
import type { VerifySpec } from './eridani-targets';
import type { VerifyOutcome, VerifyRunOptions } from './verify-runner';

export type VerifyResultFields = Omit<VerifyResultBody, 'op_id' | 'digest'>;

export interface VerifyTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
}

export interface VerifyAttemptsDeps {
  session(id: string): SessionRecord | undefined;
  /** Persist the surface's latest attempt. */
  setStatus(id: string, status: VerifyAttemptStatus): void;
  /** The target's verify spec for a binding, or undefined. */
  spec(rec: SessionRecord, verifyId: string): VerifySpec | undefined;
  run(o: VerifyRunOptions): Promise<VerifyOutcome>;
  fingerprint(dir: string): Promise<string>;
  emit(body: VerifyResultFields): void;
  timers: VerifyTimers;
  now: () => number;
  log: (m: string) => void;
  debounceMs: number;
  mintId?: () => string;
  automaticAllowed?: (runId: string, revision?: number) => boolean;
  automaticRevision?: (runId: string) => number;
}

interface Tuple {
  run_id: string;
  generation: number;
  turn_seq: number;
  plan_revision: number;
  verify_id: string;
}

interface Attempt {
  id: string;
  /** The host's id, when Eridani's command adopted a host attempt. */
  adopted?: string;
  initiator: 'host' | 'eridani';
  automationRevision?: number;
  surf: string;
  tuple: Tuple;
  state: 'pending' | 'running' | 'done';
  timer?: unknown;
  ac?: AbortController;
  promise?: Promise<VerifyResultFields>;
  startedAt: number | null;
}

interface Finished {
  tuple: Tuple;
  result: VerifyResultFields;
}

const sameTuple = (a: Tuple, b: Tuple) =>
  a.run_id === b.run_id && a.generation === b.generation && a.turn_seq === b.turn_seq && a.plan_revision === b.plan_revision && a.verify_id === b.verify_id;

/** Is `a` older work than `b` (an earlier generation, or an earlier turn of the same one)? */
const older = (a: Tuple, b: Tuple) => a.generation < b.generation || (a.generation === b.generation && a.turn_seq < b.turn_seq);

function stateOf(r: VerifyResultFields): VerifyAttemptStatus['state'] {
  if (r.canceled) return 'canceled';
  if (r.timed_out) return 'timed_out';
  if (r.exit_code === null) return 'error';
  return r.exit_code === 0 ? 'passed' : 'failed';
}

export type CommandedOutcome =
  | { state: 'executed'; result: Record<string, unknown> }
  | { state: 'rejected'; detail: string };

export class VerifyAttempts {
  private readonly current = new Map<string, Attempt>();
  private readonly last = new Map<string, Finished>();
  /** The fingerprint each surface's latest turn left, by turn_seq. */
  private readonly turnFp = new Map<string, { seq: number; fp: Promise<string | null> }>();

  constructor(private readonly deps: VerifyAttemptsDeps) {}

  /** What a running or pending attempt is, for tests and status. */
  attempt(surf: string): { id: string; state: Attempt['state']; tuple: Tuple; initiator: Attempt['initiator'] } | null {
    const a = this.current.get(surf);
    return a ? { id: a.id, state: a.state, tuple: a.tuple, initiator: a.initiator } : null;
  }

  // ── Automatic ────────────────────────────────────────────────────────────

  /** A root turn was captured on `t.surf`. */
  onTurn(t: TurnFields): void {
    if (!t.run_id || t.interim || this.deps.automaticAllowed?.(t.run_id) === false) return;
    const rec = this.deps.session(t.surf);
    const b = rec?.eridani;
    if (!rec || !b || b.runId !== t.run_id) return;
    const fp = this.deps.fingerprint(b.worktree).catch(() => null);
    this.turnFp.set(t.surf, { seq: t.seq, fp });
    // A newer turn: whatever ran for an earlier one no longer describes the tree.
    const cur = this.current.get(t.surf);
    if (cur && cur.tuple.turn_seq < t.seq) this.cancel(t.surf, `turn ${t.seq} arrived`);
    if (!b.verify || b.stopRequested || t.generation < b.generation) return;
    const spec = this.deps.spec(rec, b.verify.verifyId);
    if (!spec) {
      this.deps.log(`verify: ${t.surf}: target ${b.target} has no verify id ${b.verify.verifyId}; not run`);
      return;
    }
    const a: Attempt = {
      id: `local:${(this.deps.mintId ?? crypto.randomUUID)()}`,
      initiator: 'host',
      automationRevision: this.deps.automaticRevision?.(t.run_id),
      surf: t.surf,
      tuple: { run_id: t.run_id, generation: t.generation, turn_seq: t.seq, plan_revision: b.verify.planRevision, verify_id: b.verify.verifyId },
      state: 'pending',
      startedAt: null,
    };
    this.current.set(t.surf, a);
    a.timer = this.deps.timers.setTimeout(() => {
      a.timer = undefined;
      if (this.current.get(t.surf) === a) { if (this.deps.automaticAllowed?.(a.tuple.run_id, a.automationRevision) === false) this.cancel(t.surf, 'Eridani automation is held'); else void this.start(a); }
    }, this.deps.debounceMs);
    this.persist(a, 'pending');
  }

  // ── Commanded ────────────────────────────────────────────────────────────

  /** An Eridani `verify` command for the run bound to `surf` (fences already checked). */
  async command(surf: string, cmd: VerifyCommand): Promise<CommandedOutcome> {
    const blocked = () => cmd.origin === 'automation' && this.deps.automaticAllowed?.(cmd.run_id, cmd.automation_hold_revision) === false;
    if (blocked()) return {state:'rejected',detail:'Eridani automation is held or superseded'};
    const tuple: Tuple = { run_id: cmd.run_id, generation: cmd.generation, turn_seq: cmd.turn_seq, plan_revision: cmd.plan_revision, verify_id: cmd.verify_id };
    const cur = this.current.get(surf);
    if (cur && sameTuple(cur.tuple, tuple)) {
      if (cur.id !== cmd.attempt_id) {
        if (cur.initiator === 'host') cur.adopted = cur.id;
        cur.id = cmd.attempt_id;
        cur.initiator = 'eridani';
      }
      if (cur.state === 'pending') {
        if (cur.timer !== undefined) this.deps.timers.clearTimeout(cur.timer);
        cur.timer = undefined;
        return this.outcome(await this.start(cur));
      }
      this.persist(cur, 'running');
      return this.outcome(await cur.promise!);
    }
    if (cur && older(tuple, cur.tuple)) return { state: 'rejected', detail: `superseded by turn ${cur.tuple.turn_seq} (generation ${cur.tuple.generation})` };
    if (cur) this.cancel(surf, `replaced by attempt ${cmd.attempt_id}`);
    // Already verified this exact tuple, and nothing changed since: send that result under Eridani's id.
    const done = this.last.get(surf);
    // An incomplete fingerprint (S-S2) cannot prove the tree is unchanged: run again.
    if (done && sameTuple(done.tuple, tuple) && !done.result.canceled && !done.result.stale_workspace && done.result.workspace_fingerprint !== 'none:' && done.result.workspace_complete !== false) {
      const rec = this.deps.session(surf);
      const now = rec?.eridani ? await this.deps.fingerprint(rec.eridani.worktree).catch(() => null) : null;
      if (now && now === done.result.workspace_fingerprint && !this.current.has(surf)) {
        const copy: VerifyResultFields = { ...done.result, attempt_id: cmd.attempt_id, initiator: 'eridani', adopted: done.result.attempt_id };
        this.deps.emit(copy);
        return this.outcome(copy);
      }
    }
    if (blocked()) return {state:'rejected',detail:'Eridani automation is held or superseded'};
    const a: Attempt = { id: cmd.attempt_id, initiator: 'eridani', surf, tuple, state: 'pending', startedAt: null };
    this.current.set(surf, a);
    return this.outcome(await this.start(a));
  }

  private outcome(r: VerifyResultFields): CommandedOutcome {
    return {
      state: 'executed',
      result: {
        attempt_id: r.attempt_id,
        exit_code: r.exit_code,
        timed_out: r.timed_out,
        canceled: r.canceled,
        stale_workspace: !!r.stale_workspace,
        ...(r.adopted ? { adopted: r.adopted } : {}),
      },
    };
  }

  // ── Running ──────────────────────────────────────────────────────────────

  private start(a: Attempt): Promise<VerifyResultFields> {
    if (a.promise) return a.promise;
    a.state = 'running';
    a.ac = new AbortController();
    a.startedAt = this.deps.now();
    this.persist(a, 'running');
    a.promise = this.execute(a);
    return a.promise;
  }

  private async execute(a: Attempt): Promise<VerifyResultFields> {
    const rec = this.deps.session(a.surf);
    const b = rec?.eridani;
    const spec = rec && b ? this.deps.spec(rec, a.tuple.verify_id) : undefined;
    const tf = this.turnFp.get(a.surf);
    let out: VerifyOutcome;
    if (!rec || !b || !spec) {
      out = { workspace_fingerprint: 'none:', exit_code: null, tail: '', truncated: false, duration_ms: 0, timed_out: false, canceled: false, error: 'the run or its verify id is gone', stale_workspace: false };
    } else {
      try {
        out = await this.deps.run({
          spec,
          worktree: b.worktree,
          signal: a.ac!.signal,
          expectFingerprint: tf && tf.seq === a.tuple.turn_seq ? tf.fp : null,
        });
      } catch (err) {
        out = { workspace_fingerprint: 'none:', exit_code: null, tail: '', truncated: false, duration_ms: 0, timed_out: false, canceled: a.ac!.signal.aborted, error: (err as Error).message.slice(0, 200), stale_workspace: false };
      }
    }
    const turnFingerprint = tf && tf.seq === a.tuple.turn_seq ? await tf.fp : null;
    // L6: a failing test prints configs and headers; secrets never leave the machine.
    const tail = redact(out.tail);
    out = {
      ...out,
      tail: tail.slice(-ERIDANI_LIMITS.verifyTailChars),
      truncated: out.truncated || tail.length > ERIDANI_LIMITS.verifyTailChars,
      ...(out.error ? { error: redact(out.error) } : {}),
    };
    const result: VerifyResultFields = {
      t: 'verify.result',
      attempt_id: a.id,
      ...a.tuple,
      ...out,
      initiator: a.initiator,
      ...(turnFingerprint ? { turn_fingerprint: turnFingerprint } : {}),
      ...(a.adopted ? { adopted: a.adopted } : {}),
    };
    a.state = 'done';
    // A canceled attempt finishes after its replacement was recorded: keep the newer status.
    const superseded = this.current.has(a.surf) && this.current.get(a.surf) !== a;
    if (this.current.get(a.surf) === a) this.current.delete(a.surf);
    this.last.set(a.surf, { tuple: a.tuple, result });
    this.deps.emit(result);
    if (!superseded) this.persist(a, stateOf(result), result.stale_workspace);
    this.deps.log(`verify: ${a.surf} ${a.id} turn ${a.tuple.turn_seq}: ${stateOf(result)}${result.stale_workspace ? ' (stale workspace)' : ''}`);
    return result;
  }

  /** Cancel the surface's attempt: a waiting one silently, a running one is killed and reports `canceled`. */
  cancel(surf: string, why: string): void {
    const a = this.current.get(surf);
    if (!a) return;
    this.current.delete(surf);
    if (a.state === 'pending') {
      if (a.timer !== undefined) this.deps.timers.clearTimeout(a.timer);
      a.timer = undefined;
      a.state = 'done';
      this.persist(a, 'canceled');
      this.deps.log(`verify: ${surf} ${a.id} canceled before it ran (${why})`);
      return;
    }
    this.deps.log(`verify: ${surf} ${a.id} canceled (${why})`);
    a.ac?.abort();
  }

  /** After a restart: an attempt the record says was waiting or running did not survive. */
  recover(rec: SessionRecord): void {
    const v = rec.verify;
    if (!v || (v.state !== 'pending' && v.state !== 'running')) return;
    this.deps.setStatus(rec.id, { ...v, state: 'interrupted', finishedAt: this.deps.now() });
  }

  private persist(a: Attempt, state: VerifyAttemptStatus['state'], stale?: boolean): void {
    this.deps.setStatus(a.surf, {
      attemptId: a.id,
      state,
      startedAt: a.startedAt,
      ...(state !== 'pending' && state !== 'running' ? { finishedAt: this.deps.now() } : {}),
      runId: a.tuple.run_id,
      generation: a.tuple.generation,
      turnSeq: a.tuple.turn_seq,
      planRevision: a.tuple.plan_revision,
      verifyId: a.tuple.verify_id,
      initiator: a.initiator,
      ...(stale ? { staleWorkspace: true } : {}),
    });
  }
}
