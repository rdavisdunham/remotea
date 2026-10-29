/**
 * The pure rules that turn agent hooks and keystrokes into declared agent
 * state, shared by the app (agent-hook-bridge.ts, agent-state.ts) and the
 * remotea server (remote-server/src/agent-state.ts), so a pane reads the same
 * "working / needs you / idle" on the desktop and in Eridani.
 *
 * Lifted verbatim from src/main; the app re-exports them so its tests and
 * callers did not move. Pure: no Node, Electron or DOM imports.
 */
import { classifyClaudeNotification } from './claude-notification';

/**
 * The declared-state change one hook asks for: the subset of the app's
 * ReportAgentParams (agent-state.ts) that hooks ever set.
 */
export interface HookReport {
  awaitingHuman?: boolean;
  reason?: string | null;
  runDepth?: number;
}

/** The hook events wmux registers. */
export type ClaudeHookEvent =
  | 'SessionStart'
  | 'UserPromptSubmit'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'Notification'
  | 'Stop'
  | 'SubagentStop'
  | 'SessionEnd';

export const KNOWN_EVENTS: ClaudeHookEvent[] = [
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse',
  'Notification', 'Stop', 'SubagentStop', 'SessionEnd',
];

/**
 * Which event a `hook.event` wire payload denotes, or null for one outside the
 * model.
 *
 * This exists because the payload does not always say. `wmux-hook.js` is
 * invoked two ways (see its usage block): `--event <Event>` for the lifecycle
 * hooks, and a bare `<tool-name>` for the per-tool PostToolUse entries
 * claude-context.ts installs — and the bare form sends `{ tool }` with NO
 * `event` field. Reading `params.event` directly therefore admits every
 * lifecycle event while silently dropping every PostToolUse, which makes the
 * `case 'PostToolUse'` below unreachable.
 *
 * Since 0.48.0 that is no longer catastrophic — matcher-less `PreToolUse`
 * declares the run at the START of every tool, so a pane still reads `working`.
 * What is lost is the other end: PostToolUse is the event that says a tool
 * FINISHED without the turn ending, and it is the one report that arrives
 * during the stretch between approving a permission prompt and the turn
 * closing. Dropping it also drops the freshness stamp that keeps a long turn
 * inside the trust window, so a turn spent in tracked tools ages out of
 * `working` on nothing but the clock.
 *
 * Resolved here rather than by teaching the hook helper to send `event`: hooks
 * are written into settings.json once at install, so the bare-tool form is
 * already out in every existing config and will keep arriving from helper
 * vintages this build does not control. The main process is the single place
 * that sees every payload regardless of who produced it.
 */
export function hookEventName(
  params: { event?: unknown; tool?: unknown } | null | undefined,
): ClaudeHookEvent | null {
  const explicit = typeof params?.event === 'string' ? params.event.trim() : '';
  if (explicit) {
    return KNOWN_EVENTS.includes(explicit as ClaudeHookEvent) ? (explicit as ClaudeHookEvent) : null;
  }
  // No event named, but a tool did run — that is PostToolUse by construction,
  // since it is the only hook wmux registers by bare tool name.
  const tool = typeof params?.tool === 'string' ? params.tool.trim() : '';
  return tool ? 'PostToolUse' : null;
}

/**
 * What the pane had already declared when a hook arrived.
 *
 * Only `Notification` reads it, and only to tell a real prompt from the ~60s
 * idle nudge — see that case for why the discriminator is state and not text.
 */
export interface HookTurnContext {
  /**
   * Whether this pane has a declared record at all. Absent means wmux has
   * observed nothing about the turn — a main process restarted mid-turn sees
   * exactly this — so `runDepth` is a default, not an observation.
   */
  known: boolean;
  /** The pane's current declared run refcount. */
  runDepth: number;
  /**
   * The Notification payload's `notification_type`, when the hook helper
   * forwarded one (issue #253). Ignored by every other event.
   */
  notificationType?: string | null;
  /**
   * Whether the turn-opening hooks are known to be firing at all. False means
   * `runDepth` carries no information about turn boundaries, so nothing may be
   * concluded from it.
   */
  turnStartTracked: boolean;
}

/**
 * Map one Claude Code hook event to a report_agent payload, or null to ignore it.
 *
 * The original four events (issue #128) were all *terminal* — a tool finished, a
 * turn finished, a subagent finished. Nothing said when work STARTED, so the
 * entire stretch between the user pressing Enter and the first tool completing
 * resolved to `idle`, which for a turn that thinks for a minute or runs one long
 * command is most of the turn (issue #151). The three opening events below are
 * the missing half of the lifecycle.
 *
 * ## Who owns the block
 *
 * `runDepth` and `awaitingHuman` are two independent facts, and the tool
 * lifecycle only speaks to the first. A tool starting, finishing, or a subagent
 * finishing says a turn is in flight; NONE of them is evidence that a question
 * already on screen has been answered.
 *
 * That distinction is not academic, because every hook a pane's agent fires —
 * including its background shells and its parallel subagents — carries the same
 * WMUX_SURFACE_ID and lands on the one surface. So an agent that kicks off a
 * background command and then asks the user a question is, from wmux's side,
 * a pane that is blocked AND busy at the same time. That is a legitimate state,
 * and `resolveState` in agent-state.ts already renders it correctly: `blocked`
 * outranks `runDepth > 0`, so the pane says "needs you" while the work continues
 * underneath. What broke it was these events retracting the flag on the way past.
 *
 * So a block is ended only by something that actually knows a human dealt with it:
 *
 *   - `UserPromptSubmit`  — the human replied
 *   - `Stop`              — the turn ended, so there is nothing left to answer
 *   - `noteHumanInput`    — the human typed in the pane (agent-state.ts)
 *   - an explicit `report-agent --unblocked` from the agent
 *   - the MAIN thread's own tool lifecycle moving past the prompt (#399) — see
 *     `noteToolEvent` in the desktop's agent-hook-bridge.ts. Not any tool
 *     event: only one that carries Claude Code's `tool_use_id` and no
 *     `agent_id`, so the thread that asked can be told from a subagent or a
 *     sibling call, and only for a block a hook raised.
 *
 * The cost is that a prompt answered through `wmux answer-agent` — a relay, not
 * a local keystroke — keeps saying "needs you" until the turn ends rather than
 * until the next tool. That is answerAgent's rule 3 working as designed: the
 * agent confirms, wmux does not assume. `answeredAt` is what the UI shows in the
 * meantime ("sent — waiting for the agent"). A block that lingers is visible and
 * self-correcting; one that vanishes while the agent is still stuck is the bug.
 */
export function hookToAgentReport(
  event: ClaudeHookEvent,
  message: string | null,
  ctx: HookTurnContext,
): HookReport | null {
  switch (event) {
    // Claude Code just started (launch, resume, /clear, /compact). Nothing is
    // running yet, and that is precisely the point: registering the pane as a
    // known agent session at depth 0 is what makes it read `idle` instead of
    // inheriting the shell's verdict. `claude` is a foreground command, so shell
    // integration correctly calls the pane "running" for the entire life of the
    // session — a brand-new session that has done nothing showed "Running" with
    // no session state to outrank it (issue #151).
    case 'SessionStart':
      return { awaitingHuman: false, runDepth: 0 };

    // The human just sent a message. Two facts in one event, and both matter:
    // the turn is now in flight (no tool has run yet, so nothing else would say
    // so), and whatever the pane was waiting to be told, it has now been told.
    // This is the event that ends a "needs you" the moment the user replies,
    // rather than whenever the next tool happens to finish.
    case 'UserPromptSubmit':
      return { awaitingHuman: false, runDepth: 1 };

    // A tool is about to run. Fires BEFORE the permission check, so it cannot
    // clear a prompt that has not appeared yet — its job is the long tool: a
    // three-minute test run reported nothing at all until it finished.
    //
    // It says nothing about `awaitingHuman` for the same reason, in the other
    // direction: a tool STARTING is not evidence that a question already on
    // screen was answered. See the block-ownership note above.
    case 'PreToolUse':
      return { runDepth: 1 };

    // Claude Code wants the user. This fires for two different situations: a
    // permission/question prompt, and the ~60s "Claude is waiting for your
    // input" idle nudge it arms when a turn ends.
    //
    // Only the first is `blocked`. "Needs you" claims there is something to
    // answer, and after a turn has ended there is nothing — the pane is idle,
    // and saying otherwise is how a pane nobody has touched starts asking for
    // attention a minute after it goes quiet. Observed exactly that way: Stop
    // at T, nudge at T+60s, on a session that had just been /clear'd and left
    // alone. /clear wipes the transcript but not Claude Code's idle timer, so
    // the nudge landed on an empty conversation and the pane said "Needs you".
    //
    // The two are told apart by STATE, not by the message text. Sniffing the
    // text was considered and rejected: it would stop working the day Claude
    // Code rewords a prompt, and would fail in the dangerous direction (a real
    // permission prompt read as "not blocked"). Run depth cannot drift that way
    // — a prompt can only occur inside a live turn, and both UserPromptSubmit
    // and PreToolUse declare depth 1 before Claude Code can ask anything, so
    // depth 0 at Notification time means the turn is over, which means nudge.
    //
    // Gated on `turnStartTracked` because that argument only holds while the
    // opening hooks are firing. A settings.json written before 0.48.0 carries
    // only the four terminal hooks, sits at depth 0 through an entire turn, and
    // would read every real prompt as a nudge — the dangerous direction again.
    // Until wmux has seen one opening event it declines to draw the distinction
    // and parks the pane for both, exactly as it did before.
    //
    // Gated on `known` for the same reason at the pane level. A pane wmux holds
    // no record for has a depth of 0 by DEFAULT, not by observation — which is
    // what a main process restarted in the middle of someone's turn sees, and
    // what a prompt arriving before any other hook on that pane sees. Reading
    // that as "the turn is over" would swallow a real prompt.
    //
    // This is the other half of noteHumanInput's bargain in agent-state.ts.
    // That code clears a block when the human types, and leans on "if the
    // keystroke didn't satisfy the agent, the 60-second nudge puts the pane
    // back to asking" — which is only sound if the nudge cannot ALSO invent a
    // block on a pane that is simply idle. It now cannot.
    //
    // ...except that the depth argument has a hole, and #253 found it: a
    // BACKGROUND subagent keeps firing PreToolUse/PostToolUse on the parent's
    // surface after the parent's Stop, which puts the depth back at 1, and the
    // idle nudge that follows once everything has gone quiet was read as a
    // prompt — "Needs you" on a pane nobody had asked anything. So the payload's
    // own word comes first: Claude Code labels the nudge `idle_prompt` (and the
    // text fallback matches the nudge's exact wording, for payloads that carry no
    // type). Neither is a question, so neither blocks — and neither retracts a
    // block either, since an idle reminder is no evidence that anything was
    // answered. The depth heuristic above stays as the fallback for a payload
    // that says nothing, where it is still the best information there is.
    case 'Notification': {
      const kind = classifyClaudeNotification(ctx.notificationType, message);
      if (kind === 'idle' || kind === 'info') return null;
      if (kind === 'unknown' && ctx.known && ctx.turnStartTracked && ctx.runDepth === 0) return null;
      return { awaitingHuman: true, reason: message };
    }

    // A tool finished, so a turn is in flight.
    //
    // It used to also clear the block, on the premise that "a pending permission
    // dialog would have stopped the tool from running at all". That premise
    // holds only for an agent doing one thing at a time, and it is false for the
    // two things agents do most: a BACKGROUND shell, and PARALLEL SUBAGENTS.
    // Both carry the pane's WMUX_SURFACE_ID, so their tool lifecycle reports to
    // the surface that is asking the question — and the pane snapped back to
    // "Running" with the prompt still on screen and no event left to correct it
    // (Claude Code arms the 60s idle nudge only after a turn ENDS, and the turn
    // is still open). See the block-ownership note above.
    //
    // A MAIN-thread call, paired with its start by `tool_use_id`, can still end
    // a block a hook raised — that decision is applyHookToAgentState's, through
    // `noteToolEvent` (#399), because it needs the calls seen so far, not just
    // this one event.
    //
    // Absolute runDepth rather than a delta: this fires on EVERY tool call and
    // nothing decrements per-call, so `runDelta: +1` would climb forever. An
    // absolute value is idempotent — five hundred tool calls still leave the
    // depth at 1.
    case 'PostToolUse':
      return { runDepth: 1 };

    // One parallel subagent finished. It may SUSTAIN a turn; it may never START
    // one.
    //
    // This used to decrement the refcount, which was wrong in the way that
    // produced the loudest half of issue #151. Subagent hooks inherit the
    // parent's WMUX_SURFACE_ID, so all of them report to ONE pane: three
    // subagents' PostToolUse events each pin the depth to the absolute value 1,
    // and then the FIRST SubagentStop drains it to 0 — the pane reads `idle`
    // with the parent and two siblings still working. A refcount only survives
    // contact with reality when every increment is paired, and these are not
    // paired; the parent's `Stop` is the pairing, and it is already decisive.
    //
    // Fixing that by asserting an unconditional depth of 1 rested on a premise
    // that measurement does not support: that Claude Code fires the parent's
    // `Stop` only after every subagent has stopped. It does not. Traced at the
    // hook helper on two independent panes, the wire order is `Stop` first and
    // `SubagentStop` 1.8-2.2s LATER — so the unconditional form resurrected the
    // very run `Stop` had just ended, and the pane sat on "Running" until the
    // 15-minute trust window with the agent idle at its prompt.
    //
    // The wall-clock gate in agent-state.ts cannot catch it, and that is the
    // point worth remembering: it drops reports that are OLDER than what has
    // been accepted, which is the right defence against two hook processes
    // racing to the pipe. This is not a race. The trailing report is genuinely
    // newer; it is the EVENT ORDER that is counter-intuitive, and no amount of
    // timestamp discipline fixes a report that is late by design.
    //
    // Reading the current depth is what separates the two situations, using the
    // one fact that distinguishes them: the parent's `Stop` has already zeroed
    // it. So a subagent finishing inside a live turn holds that turn open, and
    // a subagent finishing after the turn ended says nothing at all. Declining
    // to report also leaves the freshness stamp alone, so the 60s idle
    // `Notification` that follows still sees depth 0 and is correctly read as a
    // nudge rather than a prompt — the resurrection defeated that gate too, and
    // the pane went on to claim "Needs you" with nothing to answer.
    //
    // `known` is checked for the same reason `Notification` checks it: a pane
    // wmux holds no record for has a depth of 0 by DEFAULT, not by observation.
    // Nothing is lost by staying quiet there — a turn wmux never saw begin is
    // not one a subagent's completion should invent.
    case 'SubagentStop':
      if (!ctx.known || ctx.runDepth === 0) return null;
      return { runDepth: 1 };

    // The turn is over: nothing can still be running and nothing can still be
    // waiting on the user. Decisive on purpose — this is the backstop that
    // guarantees no ghost state survives a turn even if an earlier event was
    // dropped, the same role Stop already plays for the sidebar's agent lines
    // (issue #81 class).
    case 'Stop':
      return { awaitingHuman: false, runDepth: 0 };

    // The session is over — handled by release, not by a report. See below.
    case 'SessionEnd':
      return null;

    default:
      return null;
  }
}

/**
 * Does this chunk of PTY input constitute *answering* something? (issue #151)
 *
 * Arrow keys, page-up and the mouse are how a human READS a pane they were sent
 * to; they must not be mistaken for a reply. Anything that commits — a printable
 * character, Enter, or a bare Escape — is one. So: strip the CSI (`ESC [ … `)
 * and SS3 (`ESC O x`) sequences the navigation keys are made of, and judge what
 * is left.
 *
 * Exported for the tests, because the difference between "scrolled up to look"
 * and "typed 2 and hit Enter" is the entire correctness of noteHumanInput.
 */
export function isAnsweringInput(data: string): boolean {
  const ESC = 0x1b;
  let i = 0;
  while (i < data.length) {
    const code = data.charCodeAt(i);

    if (code === ESC) {
      const skipped = skipEscapeSequence(data, i);
      // A bare Escape is not navigation — it dismisses, denies, or cancels.
      if (skipped === i) return true;
      i = skipped;
      continue;
    }

    // Enter/newline submits; Backspace, Delete and Tab are edits of an answer in
    // progress. All are deliberate acts on whatever the pane is showing.
    if (code === 0x0d || code === 0x0a || code === 0x08 || code === 0x7f || code === 0x09) return true;
    // Anything printable, including non-ASCII: the human is typing a reply.
    if (code > 0x1f && code !== 0x7f) return true;
    i++;
  }
  return false;
}

/**
 * Index just past the escape sequence starting at `i`, or `i` itself when this
 * ESC does not begin one (a bare Escape keypress).
 *
 * Only the two shapes the navigation keys and the mouse actually arrive in:
 * CSI (`ESC [` params, intermediates, final byte `@`–`~`) and SS3 (`ESC O x`).
 */
function skipEscapeSequence(data: string, i: number): number {
  const next = data[i + 1];
  if (next === 'O') return i + 3 <= data.length ? i + 3 : data.length;
  if (next !== '[') return i;

  let j = i + 2;
  while (j < data.length) {
    const code = data.charCodeAt(j);
    // Parameter and intermediate bytes run 0x30–0x3f and 0x20–0x2f; the first
    // byte outside those ends the sequence.
    if (code > 0x3f) return j + 1;
    j++;
  }
  return data.length;
}
