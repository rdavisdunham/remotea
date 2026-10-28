/**
 * Claude Code hooks → declared agent state (issue #128).
 *
 * The protocol in agent-state.ts is agent-agnostic: anything that can write a
 * line of JSON to the wmux pipe can drive it. But Claude Code is what most wmux
 * panes actually run, and wmux ALREADY configures four of its hooks in
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
import { getAgentState, reportAgent, releaseAgent } from './agent-state';
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

/** Test seam: forget what this module has learned about the hook config. */
export function resetHookBridge(): void {
  turnStartTracked = false;
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
): void {
  if (!KNOWN_EVENTS.includes(event as ClaudeHookEvent)) return;
  const hookEvent = event as ClaudeHookEvent;

  if (TURN_START_EVENTS.includes(hookEvent)) turnStartTracked = true;

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
  if (!params) return;
  reportAgent(surfaceId, { ...params, hookAt });
}
