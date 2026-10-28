/**
 * Server-side agent state per surface: working / needs_you / idle / exited.
 *
 * The apps have always derived this themselves from the hook events the
 * server relays (src/main/agent-hook-bridge.ts + agent-state.ts). Eridani is a
 * client with no app in the loop, so the server now derives the same state
 * with the SAME rules, lifted into src/shared/agent-hook-rules.ts:
 *
 *   - hook.event        → hookToAgentReport (the block-ownership rules: a tool
 *                         or subagent finishing never clears a question on screen)
 *   - pane.report_agent → the agent's own declaration
 *   - pane.release_agent / SessionEnd → the agent let go: idle
 *   - human input       → isAnsweringInput clears a block; a lone Escape ends a run.
 *                         Only input a person typed in an app counts; the server's
 *                         own startup commands (`deliver`) never reach here.
 *   - the process exits → exited
 *
 * Hook processes race to the bridge, so reports are ordered by the stamp the
 * helper took when the hook fired (`at`), exactly as the app does (#151).
 */
import {
  hookEventName,
  hookToAgentReport,
  isAnsweringInput,
  type ClaudeHookEvent,
} from '../../src/shared/agent-hook-rules';
import type { AgentStateInfo, AgentStateName } from '../../src/shared/remote-host-protocol';

const TURN_START_EVENTS: ClaudeHookEvent[] = ['SessionStart', 'UserPromptSubmit', 'PreToolUse'];
const MAX_REASON = 300;

interface Rec {
  awaitingHuman: boolean;
  runDepth: number;
  reason: string | null;
  lastHookAt: number;
  lastSeq: number;
  exited: boolean;
  /** The state last published, and since when. */
  state: AgentStateName;
  since: number;
  /** The reason last published. */
  published: string | null;
}

export interface AgentStateChange {
  surf: string;
  info: AgentStateInfo;
}

export interface AgentStateDeps {
  now?: () => number;
  /** Called once per real state change (never for a report that changes nothing). */
  onChange: (change: AgentStateChange) => void;
}

export function resolveState(rec: Pick<Rec, 'awaitingHuman' | 'runDepth' | 'exited'>): AgentStateName {
  if (rec.exited) return 'exited';
  if (rec.awaitingHuman) return 'needs_you';
  return rec.runDepth > 0 ? 'working' : 'idle';
}

export class AgentStateTracker {
  private readonly recs = new Map<string, Rec>();
  /**
   * Whether any surface has delivered a turn-opening hook: proof that the
   * installed hook set is new enough for the Notification depth heuristic.
   * Global on purpose, like the app's (it describes one settings.json).
   */
  private turnStartTracked = false;
  private readonly now: () => number;

  constructor(private readonly deps: AgentStateDeps) {
    this.now = deps.now ?? Date.now;
  }

  get(surf: string): AgentStateInfo | undefined {
    const r = this.recs.get(surf);
    return r ? this.info(r) : undefined;
  }

  /** Restore what the registry remembered (a server restart keeps the last known state). */
  seed(surf: string, info: AgentStateInfo): void {
    if (this.recs.has(surf)) return;
    this.recs.set(surf, {
      awaitingHuman: info.state === 'needs_you',
      runDepth: info.state === 'working' ? 1 : 0,
      reason: info.reason ?? null,
      lastHookAt: 0,
      lastSeq: -Infinity,
      exited: info.state === 'exited',
      state: info.state,
      since: info.since,
      published: info.reason ?? null,
    });
  }

  /** A relayed agent RPC. Returns true when it was one this tracker reads. */
  rpc(surf: string, method: string, params: Record<string, unknown>): boolean {
    switch (method) {
      case 'hook.event':
        this.hook(surf, params);
        return true;
      case 'pane.report_agent':
        this.report(surf, {
          seq: num(params.seq),
          awaitingHuman: typeof params.awaitingHuman === 'boolean' ? params.awaitingHuman : undefined,
          reason: typeof params.reason === 'string' ? params.reason : params.reason === null ? null : undefined,
          runDelta: num(params.runDelta),
          runDepth: num(params.runDepth),
        });
        return true;
      case 'pane.release_agent':
        this.release(surf, 'released');
        return true;
      default:
        return false;
    }
  }

  hook(surf: string, params: Record<string, unknown>): void {
    const event = hookEventName(params as { event?: unknown; tool?: unknown });
    if (!event) return;
    if (TURN_START_EVENTS.includes(event)) this.turnStartTracked = true;
    if (event === 'SessionEnd') {
      this.release(surf, 'session ended');
      return;
    }
    const rec = this.recs.get(surf);
    const live = rec && !rec.exited ? rec : undefined;
    const report = hookToAgentReport(event, typeof params.message === 'string' ? params.message : null, {
      known: live !== undefined,
      runDepth: live?.runDepth ?? 0,
      turnStartTracked: this.turnStartTracked,
      notificationType: typeof params.notificationType === 'string' ? params.notificationType : null,
    });
    if (!report) return;
    this.report(surf, { ...report, hookAt: num(params.at) });
  }

  report(
    surf: string,
    p: { seq?: number; hookAt?: number; awaitingHuman?: boolean; reason?: string | null; runDelta?: number; runDepth?: number },
  ): void {
    const rec = this.getOrCreate(surf);
    if (p.seq !== undefined) {
      if (p.seq <= rec.lastSeq) return;
      rec.lastSeq = p.seq;
    }
    if (p.hookAt !== undefined) {
      if (p.hookAt < rec.lastHookAt) return;
      rec.lastHookAt = p.hookAt;
    }
    rec.exited = false;
    if (p.awaitingHuman !== undefined) {
      rec.awaitingHuman = p.awaitingHuman;
      rec.reason = p.awaitingHuman ? clipReason(p.reason ?? null) : null;
    } else if (p.reason !== undefined && rec.awaitingHuman) {
      rec.reason = clipReason(p.reason);
    }
    if (p.runDepth !== undefined) rec.runDepth = Math.max(0, Math.trunc(p.runDepth));
    else if (p.runDelta !== undefined) rec.runDepth = Math.max(0, rec.runDepth + Math.trunc(p.runDelta));
    this.publish(surf, rec);
  }

  /** The agent let go of the pane (SessionEnd, `wmux release-agent`). */
  release(surf: string, reason: string): void {
    const rec = this.recs.get(surf);
    if (!rec || rec.exited) return;
    rec.awaitingHuman = false;
    rec.runDepth = 0;
    rec.reason = reason;
    this.publish(surf, rec);
  }

  /** A person typed into the pane from an app. See the app's noteHumanInput for the reasoning. */
  humanInput(surf: string, data: string): void {
    const rec = this.recs.get(surf);
    if (!rec || rec.exited) return;
    if (data === '\x1b' && rec.runDepth > 0) {
      rec.runDepth = 0;
      rec.awaitingHuman = false;
      rec.reason = null;
      this.publish(surf, rec);
      return;
    }
    if (!rec.awaitingHuman || !isAnsweringInput(data)) return;
    rec.awaitingHuman = false;
    rec.reason = null;
    this.publish(surf, rec);
  }

  /** The process ended. Recorded even for a surface no agent ever reported on. */
  exit(surf: string, code: number): void {
    const rec = this.getOrCreate(surf);
    rec.exited = true;
    rec.awaitingHuman = false;
    rec.runDepth = 0;
    rec.reason = `exit ${code}`;
    this.publish(surf, rec);
  }

  /** A respawned process starts with no agent state. */
  reset(surf: string): void {
    this.recs.delete(surf);
  }

  forget(surf: string): void {
    this.recs.delete(surf);
  }

  private getOrCreate(surf: string): Rec {
    let rec = this.recs.get(surf);
    if (!rec) {
      rec = { awaitingHuman: false, runDepth: 0, reason: null, lastHookAt: 0, lastSeq: -Infinity, exited: false, state: 'idle', since: 0, published: null };
      this.recs.set(surf, rec);
    }
    return rec;
  }

  private info(rec: Rec): AgentStateInfo {
    return rec.reason ? { state: rec.state, since: rec.since, reason: rec.reason } : { state: rec.state, since: rec.since };
  }

  private publish(surf: string, rec: Rec): void {
    const state = resolveState(rec);
    // `since` moves only on a real transition; a reworded question keeps its clock
    // but is still published so the reason is current.
    const changedState = state !== rec.state || rec.since === 0;
    if (!changedState && (state !== 'needs_you' || rec.reason === rec.published)) return;
    rec.published = rec.reason;
    if (changedState) {
      rec.state = state;
      rec.since = this.now();
    }
    this.deps.onChange({ surf, info: this.info(rec) });
  }
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function clipReason(r: string | null): string | null {
  if (!r) return null;
  const s = r.replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, MAX_REASON) : null;
}
