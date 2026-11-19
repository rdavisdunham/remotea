/**
 * Claude Code hook entries for remotea-hook.js — pure, so both the app (which
 * installs them on Windows, claude-context.ts) and the remotea server (which
 * installs them inside WSL) build exactly the same entries.
 */

// The helper's file name, not a bare prefix: a path such as /tmp/remotea-hooks-x/
// would otherwise make anyone's command look like ours.
const HOOK_MARKER = 'remotea-hook.js';

/** Tools tracked via PostToolUse hooks for the sidebar/diff view. */
// PowerShell is Claude Code's other shell tool; like Bash it can run in the
// background, and its PostToolUse is where that is reported (issue #276).
const TRACKED_TOOLS = ['Bash', 'PowerShell', 'Read', 'Write', 'Edit', 'Grep', 'Glob', 'Agent', 'WebSearch', 'WebFetch', 'Skill'];

/** Drop any wmux entry from one hook array, preserving the user's own hooks. */
const stripRemotea = (entries: any): any[] =>
  (Array.isArray(entries) ? entries : []).filter((e: any) => {
    if (!Array.isArray(e.hooks)) return true;
    return !e.hooks.some((h: any) => h.command?.includes(HOOK_MARKER));
  });

/**
 * The hook arrays wmux installs into, and therefore the ones it may remove from.
 *
 * The first four are the original set (issue #128). The four added for issue
 * #151 are the *opening* half of the lifecycle: without them the only thing
 * wmux ever heard was work ending, so a turn spent thinking, or one spent inside
 * a single long command, read as `idle` from start to finish.
 *
 * Anything added here must also be added to removeRemoteaHooks' reach — which is
 * this same list — or declining the integration would leave orphans behind
 * (issue #132).
 */
export const REMOTEA_HOOK_EVENTS = [
  'PostToolUse', 'Notification', 'Stop', 'SubagentStop',
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'SessionEnd',
  'SubagentStart',
] as const;

/**
 * Inverse of {@link applyRemoteaHooks}: returns a settings object with every wmux
 * hook entry removed and every user hook left alone (issue #132).
 *
 * A hook array that ends up empty is deleted rather than left as `[]`, and a
 * `hooks` object with nothing left in it goes too — so declining the
 * integration restores the file to something indistinguishable from one wmux
 * had never touched, instead of leaving its footprints behind as empty shells.
 */
export function removeRemoteaHooks(settings: any): any {
  const next = { ...(settings || {}) };
  if (!next.hooks || typeof next.hooks !== 'object') return next;
  const hooks = { ...next.hooks };
  for (const event of REMOTEA_HOOK_EVENTS) {
    if (!(event in hooks)) continue;
    const kept = stripRemotea(hooks[event]);
    if (kept.length > 0) hooks[event] = kept;
    else delete hooks[event];
  }
  if (Object.keys(hooks).length === 0) delete next.hooks;
  else next.hooks = hooks;
  return next;
}

/**
 * Pure builder for the wmux hook blocks. Given the parsed settings object and
 * the absolute path to remotea-hook.js, returns a new settings object whose
 * `hooks` contains fresh wmux PostToolUse/Notification/Stop/SubagentStop
 * entries, with any prior wmux entries replaced and all non-wmux (user) hooks
 * preserved. Extracted so the merge logic is unit-testable without touching
 * the fs (issue #53).
 */
export interface RemoteaHookOptions {
  /**
   * Hold AskUserQuestion for Eridani (remotea stage C): a SYNCHRONOUS
   * PreToolUse entry matched on that tool, whose helper may wait for a remote
   * answer. Only the remotea server installs it; the app's own panes have no
   * one to ask, and a sync hook there would only add node's start-up to every
   * question.
   */
  questions?: boolean;
}

/**
 * Claude Code's timeout per entry, in seconds, written explicitly so nothing
 * depends on its default (600 s for a command hook). The question hold is the
 * one long wait: remotea gives the question back to the terminal at 570 s,
 * before Claude would kill the hook (questions-claude.ts).
 */
export const HOOK_TIMEOUTS_S = {
  /** Observers: report and leave. */
  observer: 10,
  /** SessionStart may print Eridani's context (context.ts waits 2.5 s for it). */
  sessionStart: 10,
  question: 600,
} as const;

export function applyRemoteaHooks(settings: any, hookScript: string, opts: RemoteaHookOptions = {}): any {
  const next = { ...(settings || {}) };
  next.hooks = { ...(next.hooks || {}) };

  // PostToolUse passes the tool name as a positional arg; Notification/Stop
  // pass an --event flag so the helper reports an event type instead.
  //
  // Bare `node …` — not `2>/dev/null || true`. The helper already exits 0
  // when the pipe is absent, so the shell wrapper never kept a downed wmux
  // from blocking the agent. It DID break every consumer that is not bash:
  // Grok (and anything else that honours ~/.claude/settings.json) runs these
  // commands in PowerShell on Windows, where `>/dev/null` is Out-File of
  // `C:\dev\null` and every hook fails with exit 1. Claude Code on Windows
  // may still use Git Bash, so a PowerShell-only spelling (`2>$null`) is
  // equally wrong. No redirect is valid in bash, cmd and pwsh.
  const makeToolCmd = (tool: string) => `node "${hookScript}" ${tool}`;
  const makeEventCmd = (event: string) => remoteaEventHookCommand(hookScript, event);

  // The per-tool-call hooks run in the BACKGROUND. Every wmux hook is a pure
  // observer: it reports to the pipe and never blocks a tool or injects
  // context, so there is nothing for Claude Code to wait on — and it did wait,
  // a measured 125-145 ms per hook process (Git Bash wrapper + node boot + the
  // pipe round trip) on the critical path of EVERY tool call. `async: true` is
  // honoured since Claude Code 2.1.x; older versions ignore the field.
  //
  // Ordering is not a concern: each report carries the wall-clock it fired at,
  // and agent-state.ts drops a report older than the one it already accepted,
  // so a slow PostToolUse landing after the Stop it preceded cannot resurrect a
  // finished turn (issue #151). SessionStart, Stop and SessionEnd stay
  // synchronous: they fire once per turn or session, and SessionEnd runs while
  // the process is leaving.
  const ASYNC = { async: true, timeout: HOOK_TIMEOUTS_S.observer } as const;
  const SYNC = { timeout: HOOK_TIMEOUTS_S.observer } as const;

  // PostToolUse — one entry per tracked tool for specific sidebar tracking.
  next.hooks.PostToolUse = [
    ...stripRemotea(next.hooks.PostToolUse),
    ...TRACKED_TOOLS.map(tool => ({
      matcher: tool,
      hooks: [{ type: 'command', command: makeToolCmd(tool), ...ASYNC }],
    })),
    // The confirmation of a held question: the answers as the agent received them.
    ...(opts.questions
      ? [{ matcher: 'AskUserQuestion', hooks: [{ type: 'command', command: makeToolCmd('AskUserQuestion'), ...ASYNC }] }]
      : []),
  ];

  // Notification — Claude Code is asking for input/permission (waiting on you).
  next.hooks.Notification = [
    ...stripRemotea(next.hooks.Notification),
    { hooks: [{ type: 'command', command: makeEventCmd('Notification'), ...SYNC }] },
  ];

  // Stop — Claude Code finished its turn and is back at the prompt.
  next.hooks.Stop = [
    ...stripRemotea(next.hooks.Stop),
    { hooks: [{ type: 'command', command: makeEventCmd('Stop'), ...SYNC }] },
  ];

  // SubagentStop — one parallel subagent finished (drives sidebar agent lines).
  next.hooks.SubagentStop = [
    ...stripRemotea(next.hooks.SubagentStop),
    { hooks: [{ type: 'command', command: makeEventCmd('SubagentStop'), ...SYNC }] },
  ];

  // SubagentStart — a subagent was spawned (issue #272). Its `agent_id` is what
  // lets the sidebar keep a BACKGROUND subagent's line alive after the parent's
  // Stop, and end exactly that line on its own SubagentStop. Async: the line is
  // display only, and a subagent launch should not wait on node booting.
  next.hooks.SubagentStart = [
    ...stripRemotea(next.hooks.SubagentStart),
    { hooks: [{ type: 'command', command: makeEventCmd('SubagentStart'), ...ASYNC }] },
  ];

  // ── Turn-opening events (issue #151) ───────────────────────────────────────
  // Everything above reports work FINISHING. These report it starting, which is
  // the difference between a sidebar you can read at a glance and one that says
  // "Idle" through the whole first half of every turn.

  // SessionStart — Claude Code launched, resumed, /clear'd or /compact'd. Marks
  // the pane a known agent session at depth 0, so a brand-new session reads
  // "Idle" instead of borrowing the shell's "Running" (claude is a foreground
  // command, so the shell says running for the session's whole life).
  next.hooks.SessionStart = [
    ...stripRemotea(next.hooks.SessionStart),
    { hooks: [{ type: 'command', command: makeEventCmd('SessionStart'), timeout: HOOK_TIMEOUTS_S.sessionStart }] },
  ];

  // UserPromptSubmit — the human just sent a message: the turn is in flight, and
  // anything the pane was waiting to be told, it has now been told.
  next.hooks.UserPromptSubmit = [
    ...stripRemotea(next.hooks.UserPromptSubmit),
    { hooks: [{ type: 'command', command: makeEventCmd('UserPromptSubmit'), ...ASYNC }] },
  ];

  // PreToolUse — a tool is starting. Deliberately matcher-less, unlike
  // PostToolUse: PostToolUse is per-tool because it drives the sidebar's tool
  // LABEL and the diff view, which only make sense for the tracked tools. This
  // one drives "is anything happening at all", and a turn spent entirely in
  // untracked tools is still a turn. The helper reads the tool name off stdin.
  next.hooks.PreToolUse = [
    ...stripRemotea(next.hooks.PreToolUse),
    { hooks: [{ type: 'command', command: makeEventCmd('PreToolUse'), ...ASYNC }] },
    ...(opts.questions
      ? [{ matcher: 'AskUserQuestion', hooks: [{ type: 'command', command: makeEventCmd('AskUserQuestion'), timeout: HOOK_TIMEOUTS_S.question }] }]
      : []),
  ];

  // SessionEnd — Claude Code exited but the shell lives on. Releases the pane so
  // it stops claiming any agent state at all, rather than freezing on whatever
  // it last said.
  next.hooks.SessionEnd = [
    ...stripRemotea(next.hooks.SessionEnd),
    { hooks: [{ type: 'command', command: makeEventCmd('SessionEnd'), ...SYNC }] },
  ];

  return next;
}

/**
 * The command line a lifecycle hook entry runs. Shared with grok-context.ts,
 * whose hook file has to carry these exact bytes: Grok dedupes a hook it finds
 * in both ~/.grok/hooks and ~/.claude/settings.json only when the command
 * strings are identical.
 */
export function remoteaEventHookCommand(hookScript: string, event: string): string {
  return `node "${hookScript}" --event ${event}`;
}
