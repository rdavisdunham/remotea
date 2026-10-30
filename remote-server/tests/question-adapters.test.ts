/**
 * Harness question adapters (task 7f9da9f3): the version/hook gate that decides
 * what hello advertises, and the Codex PermissionRequest adapter end to end:
 * the broker with fake timers, and the real wmux-hook.js helper (a fake Codex:
 * the payload Codex 0.166.0 sends, on stdin) through a real bridge.
 */
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { QuestionBroker, type ApprovalReply } from '../src/questions-claude';
import { approvalItems, buildDecision } from '../src/questions-codex';
import { answerableKinds, parseVersion, versionInRange } from '../src/harness-adapters';
import { CODEX_TIMEOUTS_S, adapterHooks, applyCodexHooks } from '../src/hooks-install';
import { HookBridge, hookEnv } from '../src/hook-bridge';
import { applyWmuxHooks } from '../../src/shared/claude-hooks';
import type { SessionRecord } from '../../src/shared/remote-host-protocol';
import type { AnswerCommand } from '../../src/shared/eridani-link-protocol';
import { ManualTimers } from './helpers';

const HOOK_JS = path.resolve(__dirname, '..', '..', 'resources', 'cli', 'wmux-hook.js');
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});
function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'remotea-qa-'));
  cleanup.push(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

// What Codex 0.166.0 sent in the capability test (scripts/capability-codex.mjs), trimmed.
const COMMAND = 'touch /tmp/marker';
const PERMISSION_PAYLOAD = {
  session_id: '01a18b9f-81c7-7933-bd46-8d90df990131',
  turn_id: '01a18b9f-8203-7f41-973c-079dd7912910',
  transcript_path: null,
  cwd: '/work',
  hook_event_name: 'PermissionRequest',
  model: 'gpt-5',
  permission_mode: 'default',
  tool_name: 'Bash',
  tool_input: { command: COMMAND, description: 'capability test' },
};
const SID = PERMISSION_PAYLOAD.session_id;
const TURN = PERMISSION_PAYLOAD.turn_id;

describe('harness-adapters: what is advertised', () => {
  it('reads versions the harnesses print and checks the tested range', () => {
    expect(parseVersion('codex-cli 0.166.0')).toEqual([0, 166, 0]);
    expect(parseVersion('2.1.314 (Claude Code)')).toEqual([2, 1, 314]);
    expect(parseVersion(null)).toBeNull();
    expect(versionInRange('0.166.0', '0.166.0', '0.167.0')).toBe(true);
    expect(versionInRange('0.166.3', '0.166.0', '0.167.0')).toBe(true);
    expect(versionInRange('0.165.9', '0.166.0', '0.167.0')).toBe(false);
    expect(versionInRange('0.167.0', '0.166.0', '0.167.0')).toBe(false);
  });

  it('a kind is answerable only on a tested version with its hook wired', () => {
    const wired = { claudeAsk: true, codexApproval: true };
    expect(answerableKinds('codex', '0.166.0', wired)).toEqual(['approval']);
    expect(answerableKinds('codex', '0.167.1', wired)).toEqual([]);
    expect(answerableKinds('codex', '0.166.0', { ...wired, codexApproval: false })).toEqual([]);
    expect(answerableKinds('claude', '2.1.314', wired)).toEqual(['ask']);
    expect(answerableKinds('claude', '2.2.0', wired)).toEqual([]);
    expect(answerableKinds('claude', '2.1.314', { ...wired, claudeAsk: false })).toEqual([]);
    expect(answerableKinds('opencode', '1.17.20', wired)).toEqual([]);
  });

  it('adapterHooks: the long synchronous entries count, the old 10 s Codex entry does not', () => {
    const home = tmpDir();
    expect(adapterHooks({ home })).toEqual({ claudeAsk: false, codexApproval: false });
    fs.mkdirSync(path.join(home, '.claude'));
    fs.mkdirSync(path.join(home, '.codex'));
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify(applyWmuxHooks({}, '/h/wmux-hook.js', { questions: true })));
    const old = applyCodexHooks({}, '/h/wmux-hook.js');
    old.hooks.PermissionRequest[0].hooks[0].timeout = 10; // what installs before this change wrote
    fs.writeFileSync(path.join(home, '.codex', 'hooks.json'), JSON.stringify(old));
    expect(adapterHooks({ home })).toEqual({ claudeAsk: true, codexApproval: false });
    fs.writeFileSync(path.join(home, '.codex', 'hooks.json'), JSON.stringify(applyCodexHooks({}, '/h/wmux-hook.js')));
    expect(adapterHooks({ home })).toEqual({ claudeAsk: true, codexApproval: true });
    // Claude settings without the question entry (the app's own install): not wired.
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify(applyWmuxHooks({}, '/h/wmux-hook.js')));
    expect(adapterHooks({ home }).claudeAsk).toBe(false);
  });

  it('Codex PermissionRequest is installed with the long timeout, everything else stays short', () => {
    const out = applyCodexHooks({}, '/h/wmux-hook.js');
    expect(out.hooks.PermissionRequest[0].hooks[0]).toMatchObject({ command: 'node "/h/wmux-hook.js" --event PermissionRequest --provider codex', timeout: 600 });
    expect(out.hooks.Stop[0].hooks[0].timeout).toBe(10);
    expect(CODEX_TIMEOUTS_S.PermissionRequest).toBeGreaterThan(570);
  });
});

describe('questions-codex: the approval shape', () => {
  it('one item, allow once or deny; never "always"', () => {
    const items = approvalItems('Bash', { command: COMMAND, description: 'why' })!;
    expect(items).toHaveLength(1);
    expect(items[0].text).toBe(`Codex wants to run:\n${COMMAND}\nReason: why`);
    expect(items[0].choices!.map((c) => c.id)).toEqual(['allow_once', 'deny']);
    expect(approvalItems('apply_patch', { patch: 'x' })![0].text).toMatch(/^Codex wants to use apply_patch:\n\{"patch":"x"\}/);
    expect(approvalItems('bad tool name!', {})).toBeNull();
    expect(approvalItems(undefined, {})).toBeNull();
  });

  it('builds the decision; a note only with deny; exactly one choice', () => {
    const items = approvalItems('Bash', { command: COMMAND })!;
    expect(buildDecision(items, [{ item_id: 'q1', choice_ids: ['allow_once'] }])).toMatchObject({ decision: { behavior: 'allow' } });
    expect(buildDecision(items, [{ item_id: 'q1', choice_ids: ['deny'], text: '  use  the test db ' }])).toMatchObject({ decision: { behavior: 'deny', message: 'use the test db' } });
    expect(buildDecision(items, [{ item_id: 'q1', choice_ids: ['deny'] }])).toMatchObject({ decision: { behavior: 'deny', message: 'Denied from Eridani.' } });
    expect(buildDecision(items, [{ item_id: 'q1', choice_ids: ['allow_once'], text: 'x' }])).toEqual({ error: 'a note goes with Deny only' });
    expect(buildDecision(items, [{ item_id: 'q1', choice_ids: ['allow_once', 'deny'] }])).toEqual({ error: 'choose Allow once or Deny' });
    expect(buildDecision(items, [{ item_id: 'q1', text: 'sure' }])).toEqual({ error: 'choose Allow once or Deny' });
    expect(buildDecision(items, [{ item_id: 'q1', choice_ids: ['always'] }])).toEqual({ error: 'unknown choice always for q1' });
    expect(buildDecision(items, [{ item_id: 'q2', choice_ids: ['deny'] }])).toEqual({ error: 'answer the one approval item' });
  });
});

const REC = {
  id: 'surf-1',
  incarnation: 2,
  eridani: { runId: 'run-1', generation: 4 },
  turnCursor: { sessionId: SID, generation: 3 },
} as unknown as SessionRecord;

function setup(opts: { canHold?: boolean; capable?: boolean } = {}) {
  const timers = new ManualTimers();
  const emitted: Array<Record<string, unknown>> = [];
  const needs: Array<string | null> = [];
  const broker = new QuestionBroker({
    session: (id) => (id === 'surf-1' ? REC : undefined),
    canHold: () => opts.canHold ?? true,
    capable: (provider, kind) => (opts.capable ?? true) && provider === 'codex' && kind === 'approval',
    emit: (b) => emitted.push(b as unknown as Record<string, unknown>),
    needsYou: (_id, r) => needs.push(r),
    timers,
    now: () => timers.now,
    holdMs: 570_000,
    hookTimeoutMs: 600_000,
  });
  let onClose: (() => void) | null = null;
  // The PreToolUse Codex fires just before PermissionRequest names the call.
  const pre = () => broker.hook('surf-1', { event: 'PreToolUse', provider: 'codex', tool: 'Bash', toolUseId: 'call_1', sessionId: SID });
  const hold = (p: Record<string, unknown> = {}) =>
    broker.holdApproval('surf-1', { provider: 'codex', sessionId: SID, turnId: TURN, toolName: 'Bash', toolInput: { command: COMMAND }, ...p }, (cb) => (onClose = cb));
  const question = () => emitted.filter((e) => e.t === 'question').at(-1)!;
  const answer = (over: Partial<AnswerCommand> = {}): AnswerCommand => ({
    t: 'answer', op_id: 'op-a', digest: 'd',
    question_id: question().question_id as string,
    provider_request_id: question().provider_request_id as string,
    answers: [{ item_id: 'q1', choice_ids: ['allow_once'] }],
    expires_at: 1e15,
    ...over,
  } as AnswerCommand);
  const resolved = () => emitted.filter((e) => e.t === 'question.resolved');
  return { broker, timers, emitted, needs, pre, hold, answer, question, resolved, close: () => onClose?.() };
}

describe('Codex approval broker', () => {
  it('round trip: held as a codex approval question, allow once reaches the hook, PostToolUse confirms', async () => {
    const { broker, needs, pre, hold, answer, question, resolved } = setup();
    pre();
    const p = hold();
    expect(question()).toMatchObject({
      t: 'question', surf: 'surf-1', incarnation: 2, run_id: 'run-1', generation: 3, provider: 'codex', provider_session_id: SID,
      provider_request_id: 'call_1', provider_turn_id: TURN, kind: 'approval', group_id: 'call_1',
      items: [{ id: 'q1', header: 'Approval', choices: [{ id: 'allow_once' }, { id: 'deny' }] }],
    });
    expect(needs[0]).toBe(`Approval: ${COMMAND}`);
    expect(broker.openIds('surf-1')).toEqual([question().question_id]);
    expect(broker.answer(answer(), () => {})).toMatchObject({ state: 'executed', result: { state: 'submitted' } });
    expect(await p).toEqual({ decision: { behavior: 'allow' } });
    expect(needs.at(-1)).toBeNull();
    broker.hook('surf-1', { event: 'PostToolUse', provider: 'codex', tool: 'Bash', toolUseId: 'call_1', sessionId: SID });
    expect(resolved()).toEqual([expect.objectContaining({ outcome: 'accepted', still_open: false, answer_echo: { [`Codex wants to run:\n${COMMAND}`]: 'Allow once' } })]);
    expect(broker.openIds('surf-1')).toEqual([]);
  });

  it('deny with a note; a blocked call has no PostToolUse, so the turn ending confirms it', async () => {
    const { broker, pre, hold, answer, resolved } = setup();
    pre();
    const p = hold();
    broker.answer(answer({ answers: [{ item_id: 'q1', choice_ids: ['deny'], text: 'not on prod' }] }), () => {});
    expect(await p).toEqual({ decision: { behavior: 'deny', message: 'not on prod' } });
    expect(resolved()).toHaveLength(0);
    broker.hook('surf-1', { event: 'Stop', provider: 'codex', sessionId: SID });
    expect(resolved()).toEqual([expect.objectContaining({ outcome: 'accepted' })]);
  });

  it('timeout: the hook prints nothing, the prompt is in the terminal (still open); answered there later', async () => {
    const { broker, timers, pre, hold, answer, resolved } = setup();
    pre();
    const p = hold();
    const a = answer();
    timers.advance(570_000);
    expect(await p).toEqual({ reason: 'timeout' });
    expect(resolved()).toEqual([expect.objectContaining({ outcome: 'timed_out', still_open: true, remote_answerable: false })]);
    expect(broker.answer(a, () => {})).toEqual({ state: 'rejected', detail: 'remote answering is off: the question is in the terminal' });
    broker.hook('surf-1', { event: 'PostToolUse', provider: 'codex', tool: 'Bash', toolUseId: 'call_1', sessionId: SID });
    expect(resolved().at(-1)).toMatchObject({ outcome: 'answered_locally', still_open: false });
  });

  it('a stale prompt id and a duplicate answer are refused; the first answer wins', async () => {
    const { broker, pre, hold, answer } = setup();
    pre();
    const p = hold();
    expect(broker.answer(answer({ provider_request_id: 'call_other' }), () => {})).toEqual({ state: 'rejected', detail: 'provider_request_id does not match' });
    expect(broker.answer(answer({ question_id: 'nope' }), () => {})).toEqual({ state: 'rejected', detail: 'unknown question' });
    let begun = 0;
    expect(broker.answer(answer(), () => begun++).state).toBe('executed');
    expect(broker.answer(answer({ answers: [{ item_id: 'q1', choice_ids: ['deny'] }] }), () => begun++)).toEqual({ state: 'rejected', detail: 'stale' });
    expect(begun).toBe(1);
    expect(await p).toEqual({ decision: { behavior: 'allow' } });
  });

  it('background tool events while it is held never resolve it', () => {
    const { broker, pre, hold, question, resolved } = setup();
    pre();
    void hold();
    const h = (p: Record<string, unknown>) => broker.hook('surf-1', { provider: 'codex', sessionId: SID, ...p });
    h({ event: 'PostToolUse', tool: 'Bash', toolUseId: 'call_bg' });
    h({ event: 'PostToolUse', tool: 'Bash', toolUseId: 'call_1' });
    h({ event: 'PreToolUse', tool: 'Bash', toolUseId: 'call_2' });
    h({ event: 'Stop', agentId: 'sub-1' });
    h({ event: 'Stop' });
    h({ event: 'UserPromptSubmit' });
    broker.hook('surf-1', { tool: 'AskUserQuestion', toolUseId: 'call_1' });
    expect(resolved()).toHaveLength(0);
    expect(broker.get(question().question_id as string)?.state).toBe('held');
  });

  it('a second request while one is held stays in the terminal; a new one after a submitted one confirms it', async () => {
    const { broker, pre, hold, answer, resolved, emitted } = setup();
    pre();
    const first = hold();
    expect(await hold()).toEqual({ reason: 'duplicate' });
    broker.answer(answer(), () => {});
    await first;
    // Same call asked again (e.g. retry without the sandbox): the earlier is settled, the new id is unique.
    void hold();
    expect(resolved()).toEqual([expect.objectContaining({ outcome: 'accepted' })]);
    const ids = emitted.filter((e) => e.t === 'question').map((e) => e.provider_request_id);
    expect(ids[0]).toBe('call_1');
    expect(ids[1]).toMatch(/^call_1_r[0-9a-f]{8}$/);
  });

  it('Esc (the hook killed early) cancels; the process exiting cancels', async () => {
    const { timers, pre, hold, close, resolved, broker } = setup();
    pre();
    void hold();
    timers.advance(10_000);
    close();
    expect(resolved().at(-1)).toMatchObject({ outcome: 'canceled', detail: 'the question was dismissed in the terminal' });
    void hold();
    broker.surfaceExited('surf-1');
    expect(resolved().at(-1)).toMatchObject({ outcome: 'canceled', detail: 'the process exited' });
  });

  it('never holds what is not advertised, not remote, a subagent\'s, or not Codex', async () => {
    expect(await setup({ capable: false }).hold()).toEqual({ reason: 'not-verified' });
    expect(await setup({ canHold: false }).hold()).toEqual({ reason: 'not-remote' });
    const s = setup();
    expect(await s.hold({ agentId: 'a1' })).toEqual({ reason: 'subagent' });
    expect(await s.hold({ provider: 'claude' })).toEqual({ reason: 'unsupported' });
    expect(await s.hold({ sessionId: '' })).toEqual({ reason: 'incomplete' });
    expect(await s.hold({ toolName: '' })).toEqual({ reason: 'unsupported-shape' });
    expect(s.emitted).toHaveLength(0);
    // Without a PreToolUse to name it, the request gets an id of its own.
    void s.hold();
    expect(s.question().provider_request_id).toMatch(/^perm_[0-9a-f]{32}$/);
  });

  it('Claude AskUserQuestion is not held when its adapter is not advertised', async () => {
    const s = setup(); // capable() says yes only for codex/approval
    expect(await s.broker.hold('surf-1', { toolUseId: 'toolu_1', sessionId: SID, questions: [{ question: 'Q?' }] }, () => {})).toEqual({ reason: 'not-verified' });
  });
});

/** The real helper, run the way Codex runs it: `--event PermissionRequest --provider codex`, payload on stdin. */
function runHelper(env: Record<string, string>, payload: object): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK_JS, '--event', 'PermissionRequest', '--provider', 'codex'], { env: { PATH: process.env.PATH ?? '', ...env }, stdio: ['pipe', 'pipe', 'inherit'] });
    let stdout = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code: code ?? -1, stdout }));
    child.stdin.end(JSON.stringify(payload));
  });
}

describe('wmux-hook.js PermissionRequest through a real bridge (fake Codex process)', () => {
  async function bridge(holdMs = 570_000) {
    const SECRET = 'qa-secret';
    const SURF = 'surf-1';
    const emitted: Array<Record<string, unknown>> = [];
    const relayed: Array<Record<string, unknown>> = [];
    const broker = new QuestionBroker({
      session: (id) => (id === SURF ? REC : undefined),
      canHold: () => true,
      capable: () => true,
      emit: (b) => emitted.push(b as unknown as Record<string, unknown>),
      needsYou: () => {},
      holdMs,
    });
    const b = new HookBridge({
      secret: SECRET,
      relay: (_id, _m, params) => (relayed.push(params), true),
      approval: (id, params, closed) => broker.holdApproval(id, params, closed),
    });
    const port = await b.listen(0);
    cleanup.push(() => b.close());
    return { env: hookEnv(SECRET, port, SURF), broker, emitted, relayed };
  }
  const waitFor = async (f: () => boolean) => {
    for (let i = 0; i < 200 && !f(); i++) await new Promise((r) => setTimeout(r, 10));
    expect(f()).toBe(true);
  };

  it('allow once: the helper prints the PermissionRequest decision Codex 0.166 accepts', async () => {
    const { env, broker, emitted, relayed } = await bridge();
    const run = runHelper(env, PERMISSION_PAYLOAD);
    await waitFor(() => emitted.some((e) => e.t === 'question'));
    const q = emitted.find((e) => e.t === 'question')!;
    expect(q).toMatchObject({ provider: 'codex', kind: 'approval', provider_session_id: SID, provider_turn_id: TURN });
    const out = broker.answer({ t: 'answer', op_id: 'o', digest: 'd', question_id: q.question_id, provider_request_id: q.provider_request_id, answers: [{ item_id: 'q1', choice_ids: ['allow_once'] }] } as AnswerCommand, () => {});
    expect(out.state).toBe('executed');
    const { code, stdout } = await run;
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
    // Answered remotely: no permission Notification for the pane.
    expect(relayed).toHaveLength(0);
  });

  it('deny: the decision carries the message', async () => {
    const { env, broker, emitted } = await bridge();
    const run = runHelper(env, PERMISSION_PAYLOAD);
    await waitFor(() => emitted.some((e) => e.t === 'question'));
    const q = emitted.find((e) => e.t === 'question')!;
    broker.answer({ t: 'answer', op_id: 'o', digest: 'd', question_id: q.question_id, provider_request_id: q.provider_request_id, answers: [{ item_id: 'q1', choice_ids: ['deny'], text: 'no' }] } as AnswerCommand, () => {});
    const { stdout } = await run;
    expect(JSON.parse(stdout)).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'no' } } });
  });

  it('timeout: nothing printed (Codex shows its prompt), and the pane is told as before', async () => {
    const { env, emitted, relayed } = await bridge(150);
    const { code, stdout } = await runHelper(env, PERMISSION_PAYLOAD);
    expect(code).toBe(0);
    expect(stdout).toBe('');
    expect(emitted.map((e) => e.t)).toEqual(['question', 'question.resolved']);
    expect(emitted[1]).toMatchObject({ outcome: 'timed_out', still_open: true });
    expect(relayed).toEqual([expect.objectContaining({ event: 'Notification', notificationType: 'permission_prompt', provider: 'codex' })]);
  });

  it('a subagent\'s request is never offered; it is reported as the permission Notification', async () => {
    const { env, emitted, relayed } = await bridge();
    const { stdout } = await runHelper(env, { ...PERMISSION_PAYLOAD, agent_id: 'sub-1' });
    expect(stdout).toBe('');
    expect(emitted).toHaveLength(0);
    expect(relayed).toHaveLength(1);
  });
});
