/**
 * Which harness questions Eridani may answer, and on which versions (task
 * 7f9da9f3). One adapter per harness; an adapter is advertised (hello
 * `harnesses.<h>.question`) and allowed to hold a prompt only when:
 *
 *   1. the installed version is inside the range its capability test ran on
 *      (`tested` lists the exact versions; `min` is the lowest of them and
 *      `below` the first version that has not been tested: the next minor),
 *   2. its hook is wired the way the hold needs (a timeout above the hold).
 *
 * Anything else a harness asks stays in the terminal: the pane says needs_you
 * and Eridani shows "open the terminal". How each adapter was verified is in
 * docs/remotea/eridani-link.md ("Harness capability matrix").
 *
 *   claude / ask       AskUserQuestion held at PreToolUse; `updatedInput.answers`
 *                      (questions-claude.ts). Stage A, Claude Code 2.1.312.
 *   codex / approval   PermissionRequest held; prints
 *                      `{"hookSpecificOutput":{"hookEventName":"PermissionRequest",
 *                      "decision":{"behavior":"allow"|"deny","message"?}}}`.
 *                      Codex CLI 0.166.0, fake-model PTY test
 *                      (scripts/capability-codex.mjs). "Always" is not offered:
 *                      0.166's hook fails closed on `updatedPermissions`.
 *
 * Not adapters (verified, kept in the terminal):
 *   codex request_user_input  PreToolUse fires for it, but `updatedInput` does
 *                      not answer it (0.166.0: the TUI still asks), and the
 *                      tool is off in Default mode. The App Server's typed
 *                      `item/tool/requestUserInput` goes to the client that owns
 *                      the thread, which is the TUI remotea spawns, not remotea.
 *   claude permission  captured (needs_you); no keystroke shape is verified.
 *   opencode           observed only; Eridani cannot spawn it, so no session
 *                      of it is ever bound to a run, and nothing could be held.
 */
import type { HarnessName, QuestionKind } from '../../src/shared/eridani-link-protocol';

export interface QuestionAdapter {
  harness: HarnessName;
  kind: QuestionKind;
  /** Versions the capability test passed on. */
  tested: readonly string[];
  /** Advertised for min ≤ version < below. */
  min: string;
  below: string;
}

export const QUESTION_ADAPTERS: readonly QuestionAdapter[] = Object.freeze([
  { harness: 'claude', kind: 'ask', tested: ['2.1.312'], min: '2.1.312', below: '2.2.0' },
  { harness: 'codex', kind: 'approval', tested: ['0.166.0'], min: '0.166.0', below: '0.167.0' },
]);

/** Whether each adapter's hook is wired as its hold needs (hooks-install.ts reads the agents' settings). */
export interface AdapterHooks {
  /** ~/.claude/settings.json: the synchronous AskUserQuestion PreToolUse entry. */
  claudeAsk: boolean;
  /** ~/.codex/hooks.json: the PermissionRequest entry with a timeout above the hold. */
  codexApproval: boolean;
}

/** `2.1.314 (Claude Code)`, `codex-cli 0.166.0` → [2, 1, 314]; null when there is no x.y.z. */
export function parseVersion(v: string | null | undefined): number[] | null {
  const m = typeof v === 'string' ? v.match(/(\d+)\.(\d+)\.(\d+)/) : null;
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function cmp(a: number[], b: number[]): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

export function versionInRange(version: string | null | undefined, min: string, below: string): boolean {
  const v = parseVersion(version);
  const lo = parseVersion(min);
  const hi = parseVersion(below);
  return !!(v && lo && hi && cmp(v, lo) >= 0 && cmp(v, hi) < 0);
}

function hookReady(a: QuestionAdapter, hooks: AdapterHooks): boolean {
  if (a.harness === 'claude' && a.kind === 'ask') return hooks.claudeAsk;
  if (a.harness === 'codex' && a.kind === 'approval') return hooks.codexApproval;
  return false;
}

/** The question kinds Eridani may answer for this harness at this installed version. */
export function answerableKinds(harness: HarnessName, version: string | null, hooks: AdapterHooks): QuestionKind[] {
  return QUESTION_ADAPTERS.filter((a) => a.harness === harness && versionInRange(version, a.min, a.below) && hookReady(a, hooks)).map((a) => a.kind);
}
