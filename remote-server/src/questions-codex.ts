/**
 * Codex CLI's PermissionRequest, answered from Eridani as a `question` of kind
 * `approval` (task 7f9da9f3). The broker that holds it is questions-claude.ts
 * (`holdApproval`); this module is the Codex shape only.
 *
 * Verified on Codex CLI 0.166.0 (scripts/capability-codex.mjs drives the real
 * TUI in a PTY against a fake model; docs/remotea/eridani-link.md has the
 * record):
 *
 *   - PermissionRequest fires right before the approval prompt, with
 *     `session_id, turn_id, tool_name ("Bash"), tool_input {command,
 *     description}` and NO tool_use_id. The PreToolUse just before it carries
 *     the call's `tool_use_id` and the same command.
 *   - While the hook runs the TUI shows "Running hook", not the prompt.
 *   - `{"hookSpecificOutput":{"hookEventName":"PermissionRequest",
 *     "decision":{"behavior":"allow"}}}` runs the command with no prompt;
 *     `"behavior":"deny","message":…` blocks it ("Blocked by hook", the message
 *     goes to the model).
 *   - Printing nothing, or the hook timing out, shows the normal prompt in the
 *     terminal ("Would you like to run the following command?").
 *   - Esc while the hook runs interrupts the whole turn and kills the hook.
 *   - "Always" cannot be expressed: 0.166's schema reserves
 *     `updatedPermissions` and fails closed on it. Only allow once / deny.
 */
import { ERIDANI_LIMITS, type AnswerCommand, type QuestionItem } from '../../src/shared/eridani-link-protocol';

export const ALLOW_ONCE = 'allow_once';
export const DENY = 'deny';

export type ApprovalDecision = { behavior: 'allow' } | { behavior: 'deny'; message: string };

const TOOL_RE = /^[A-Za-z0-9_.:/-]{1,128}$/;
const MAX_NOTE = 1000;

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** PermissionRequest's tool → the one approval item, or null when the payload is not one we understand. */
export function approvalItems(toolName: unknown, toolInput: unknown): QuestionItem[] | null {
  if (typeof toolName !== 'string' || !TOOL_RE.test(toolName)) return null;
  const input = toolInput && typeof toolInput === 'object' && !Array.isArray(toolInput) ? (toolInput as Record<string, unknown>) : {};
  const room = ERIDANI_LIMITS.questionTextChars - 1200;
  let text: string;
  if (typeof input.command === 'string' && input.command.trim()) {
    text = `Codex wants to run:\n${clip(input.command, room)}`;
  } else {
    let shown = '';
    try {
      shown = JSON.stringify(toolInput ?? {});
    } catch {
      shown = '';
    }
    text = `Codex wants to use ${toolName}${shown && shown !== '{}' ? `:\n${clip(shown, room)}` : ''}`;
  }
  if (typeof input.description === 'string' && input.description.trim()) text += `\nReason: ${clip(input.description.trim(), 1000)}`;
  return [
    {
      id: 'q1',
      text,
      header: 'Approval',
      choices: [
        { id: ALLOW_ONCE, label: 'Allow once', description: 'Run it this time; Codex asks again next time' },
        { id: DENY, label: 'Deny', description: 'Codex is told it was not allowed (a note says why)' },
      ],
    },
  ];
}

/** An `answer` → the PermissionRequest decision. Exactly one choice; a note goes with Deny only. */
export function buildDecision(items: QuestionItem[], answers: AnswerCommand['answers']): { decision: ApprovalDecision; echo: Record<string, string> } | { error: string } {
  if (answers.length !== 1 || answers[0].item_id !== items[0]?.id) return { error: 'answer the one approval item' };
  const a = answers[0];
  const ids = [...new Set(a.choice_ids ?? [])];
  if (ids.length !== 1) return { error: 'choose Allow once or Deny' };
  const note = typeof a.text === 'string' ? a.text.replace(/\s+/g, ' ').trim() : '';
  const label = items[0].choices?.find((c) => c.id === ids[0])?.label;
  if (ids[0] === ALLOW_ONCE) {
    if (note) return { error: 'a note goes with Deny only' };
    return { decision: { behavior: 'allow' }, echo: { [items[0].text]: label ?? 'Allow once' } };
  }
  if (ids[0] === DENY) {
    const message = note ? clip(note, MAX_NOTE) : 'Denied from Eridani.';
    return { decision: { behavior: 'deny', message }, echo: { [items[0].text]: note ? `${label ?? 'Deny'}, ${message}` : (label ?? 'Deny') } };
  }
  return { error: `unknown choice ${ids[0]} for ${items[0].id}` };
}
