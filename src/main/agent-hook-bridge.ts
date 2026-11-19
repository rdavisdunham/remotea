/**
 * Claude Code hooks → declared agent state (issue #128).
 *
 * The protocol in agent-state.ts is agent-agnostic: anything that can write a
 * line of JSON to the remotea pipe can drive it. But Claude Code is what most remotea
 * panes actually run, and remotea ALREADY configures four of its hooks in
 * ~/.claude/settings.json (see ensureClaudeHooks in claude-context.ts):
 *
 *   PostToolUse   — a tool just finished running
 *   Notification  — Claude Code wants the user's attention
 *   Stop          — the turn is over
 *   SubagentStop  — one parallel subagent finished
 *
 * Translating those into report_agent calls means the "which pane needs me?"
 * signal works for Claude Code with zero install: no plugin, no wrapper, no
 * opt-in. Other agents (OpenCode, custom harnesses) call the pipe directly.
 *
 * These hooks are lifecycle truth from the agent process itself, which is the
 * same reasoning that made hooks — not output parsing — authoritative for the
 * sidebar's agent lines (issue #81 class).
 */

import { SurfaceId } from '../shared/types';
import { getAgentState, getBlockSource, reportAgent, releaseAgent } from './agent-state';
import {
  KNOWN_EVENTS,
  hookEventName,
  hookToAgentReport,
  type ClaudeHookEvent,
  type HookTurnContext,
} from '../shared/agent-hook-rules';

// The rules live in src/shared so the remotea server applies the same ones.
export { hookEventName, hookToAgentReport, type ClaudeHookEvent, type HookTurnContext };

/** The events that prove the turn-opening hooks are installed and firing. */
const TURN_START_EVENTS: ClaudeHookEvent[] = ['SessionStart', 'UserPromptSubmit', 'PreToolUse'];

/**
 * Whether any pane has ever delivered one of the turn-opening hooks.
 *
 * Deliberately global rather than per-surface: what it is really asking is
 * "does ~/.claude/settings.json carry the 0.48.0 hook set", and that is one
 * file for every pane. A per-surface flag would answer the narrower "has THIS
 * pane opened a turn yet", which is false for a pane whose very first turn
 * opens with a permission prompt — and would then mis-gate it. One opening
 * event anywhere proves the hooks are live everywhere.
 *
 * Starts false, so a fresh main process parks the pane for every Notification
 * until it has that proof. Safe direction, and it self-corrects on the first
 * turn anyone starts.
 */
let turnStartTracked = false;

/**
 * The main thread's tool calls on one pane, for retracting a hook-raised block
 * once the agent has demonstrably moved past it (#399).
 *
 * The complaint: the user approves a permission prompt (or Claude Code's auto
 * mode approves it, with no keystroke at all), the tool runs, the turn goes on
 * for minutes, and the pane keeps saying "Needs you" until `Stop`. Clearing on
 * ANY later tool event is what #151 removed, rightly: subagents and parallel
 * calls report to the same surface while the question is still on screen. So
 * the evidence here is narrower, and is about the thread that asked:
 *
 * - a main-thread `PreToolUse` fired after the prompt, for a call that was not
 *   already in flight when it appeared: the agent started something new, so it
 *   is no longer waiting on that prompt;
 * - main-thread `PostToolUse` events, after the prompt, that finish every call
 *   that WAS in flight when it appeared: the prompting call is one of them, so
 *   it ran, so it was approved. Every one, not the first: a sibling call in the
 *   same batch finishing says nothing about the one waiting for permission.
 *
 * Subagent events (`agent_id`) and events without a `tool_use_id` (older
 * helpers, other agents) never count: remotea cannot tell whose they are. A denied
 * prompt produces neither event, so it ends the old way, on the human's
 * keystroke or the turn ending, which is the safe direction.
 */
export interface ToolLedger {
  /** Main-thread calls seen starting and not yet seen finishing. */
  inFlight: Set<string>;
  /** Calls seen finishing this turn, so a PreToolUse that lost the race to its own PostToolUse is not re-added. */
  finished: Set<string>;
  /** The hook block being watched: its Notification's stamp, and the calls in flight then. */
  block: { at: number | undefined; tools: Set<string> } | null;
}

const ledgers = new Map<SurfaceId, ToolLedger>();
/** Bounds for a reporter that never sends a turn end. */
const MAX_LEDGERS = 256;
const MAX_LEDGER_IDS = 512;

/** An empty ledger. Exported for the tests of noteToolEvent. */
export function newToolLedger(): ToolLedger {
  return { inFlight: new Set(), finished: new Set(), block: null };
}

function ledgerFor(surfaceId: SurfaceId): ToolLedger {
  let ledger = ledgers.get(surfaceId);
  if (!ledger) {
    if (ledgers.size >= MAX_LEDGERS) {
      const oldest = ledgers.keys().next().value;
      if (oldest !== undefined) ledgers.delete(oldest);
    }
    ledger = newToolLedger();
    ledgers.set(surfaceId, ledger);
  }
  return ledger;
}

function addBounded(set: Set<string>, id: string): void {
  if (set.size >= MAX_LEDGER_IDS) {
    const oldest = set.values().next().value;
    if (oldest !== undefined) set.delete(oldest);
  }
  set.add(id);
}

/** Fired no later than the block. A missing stamp is treated as later (arrival order). */
function firedBefore(hookAt: number | undefined, blockAt: number | undefined): boolean {
  return hookAt !== undefined && blockAt !== undefined && hookAt <= blockAt;
}

/**
 * Record one main-thread tool event; true when it is evidence that the agent
 * has moved past the prompt the watched block stands for. See ToolLedger.
 */
export function noteToolEvent(
  ledger: ToolLedger,
  event: 'PreToolUse' | 'PostToolUse',
  toolUseId: string,
  hookAt: number | undefined,
): boolean {
  const block = ledger.block;
  const beforeBlock = block !== null && firedBefore(hookAt, block.at);

  if (event === 'PreToolUse') {
    if (ledger.finished.has(toolUseId)) return false;
    addBounded(ledger.inFlight, toolUseId);
    if (!block) return false;
    // A start that fired before the prompt but reached the pipe after it: the
    // call was in flight when the prompt appeared, and may be the one asking.
    if (beforeBlock) {
      block.tools.add(toolUseId);
      return false;
    }
    return !block.tools.has(toolUseId);
  }

  ledger.inFlight.delete(toolUseId);
  addBounded(ledger.finished, toolUseId);
  if (!block) return false;
  const wasPending = block.tools.delete(toolUseId);
  // Finished before the prompt appeared, so it is not the call that asked.
  if (beforeBlock) return false;
  return wasPending && block.tools.size === 0;
}

/** Test seam: forget what this module has learned about the hook config. */
export function resetHookBridge(): void {
  turnStartTracked = false;
  ledgers.clear();
}

/** Who fired a hook, as far as the payload says (#399). */
export interface HookOrigin {
  /** Claude Code's `agent_id`: present only on a hook fired inside a subagent. */
  agentId?: string | null;
  /** Claude Code's `tool_use_id`, on the tool events. */
  toolUseId?: string | null;
}

/**
 * Apply a Claude Code hook event to the declared agent state for `surfaceId`.
 * Called from the hook.event pipe handler in index.ts.
 *
 * `hookAt` is the wall-clock the hook helper stamped at process start. Each hook
 * is its own node process and they race to the pipe, so without it a slow
 * `PostToolUse` can land after the `Stop` it preceded and re-assert a run that
 * has ended (issue #151).
 */
export function applyHookToAgentState(
  surfaceId: SurfaceId,
  event: string,
  message: string | null,
  hookAt?: number,
  notificationType?: string | null,
  origin: HookOrigin = {},
): void {
  if (!KNOWN_EVENTS.includes(event as ClaudeHookEvent)) return;
  const hookEvent = event as ClaudeHookEvent;

  if (TURN_START_EVENTS.includes(hookEvent)) turnStartTracked = true;
  // A turn boundary: nothing is in flight and no prompt is being watched.
  if (hookEvent === 'Stop' || hookEvent === 'SessionStart' || hookEvent === 'SessionEnd') ledgers.delete(surfaceId);

  // Claude Code exited. Forgetting the pane is right where clearing it is not:
  // a record set to `idle` is a CLAIM, and the sidebar ranks a declared state
  // above its own inference — so an ended session would pin the pane idle
  // forever. Dropping it hands the pane back to the shell's own state.
  if (hookEvent === 'SessionEnd') {
    releaseAgent(surfaceId);
    return;
  }

  const state = getAgentState(surfaceId);
  const params = hookToAgentReport(hookEvent, message, {
    known: state !== undefined,
    runDepth: state?.runDepth ?? 0,
    turnStartTracked,
    notificationType,
  });
  const toolEvent = mainThreadToolEvent(hookEvent, origin);
  const movedPast = toolEvent !== null
    && noteToolEvent(ledgerFor(surfaceId), toolEvent.event, toolEvent.toolUseId, hookAt);
  if (!params) return;

  const record = reportAgent(surfaceId, { ...params, hookAt, fromHook: true, clearHookBlock: movedPast || undefined });
  // The evidence was ordered against the block itself, so it stands even when
  // the report carrying it lost the wall-clock gate to a newer one.
  if (!record && movedPast) reportAgent(surfaceId, { fromHook: true, clearHookBlock: true });

  watchHookBlock(surfaceId, hookEvent, hookAt);
}

/** A tool event remotea can attribute to the main thread, or null (#399). */
function mainThreadToolEvent(
  event: ClaudeHookEvent,
  origin: HookOrigin,
): { event: 'PreToolUse' | 'PostToolUse'; toolUseId: string } | null {
  if (event !== 'PreToolUse' && event !== 'PostToolUse') return null;
  if (origin.agentId || !origin.toolUseId) return null;
  return { event, toolUseId: origin.toolUseId };
}

/** After a report: start watching a block a hook just raised, or stop watching one that ended. */
function watchHookBlock(surfaceId: SurfaceId, event: ClaudeHookEvent, hookAt: number | undefined): void {
  if (getAgentState(surfaceId)?.state !== 'blocked') {
    const ledger = ledgers.get(surfaceId);
    if (ledger) ledger.block = null;
    return;
  }
  if (event !== 'Notification' || getBlockSource(surfaceId) !== 'hook') return;
  const ledger = ledgerFor(surfaceId);
  ledger.block = { at: hookAt, tools: new Set(ledger.inFlight) };
}
