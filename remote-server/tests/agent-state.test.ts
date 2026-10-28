/**
 * The server's agent state, driven through the same rules as the app's
 * (tests/unit/agent-hook-bridge.test.ts, ported: `blocked` is `needs_you` here,
 * and SessionEnd reads `idle` rather than "forgotten", since Eridani needs a
 * state to show).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { AgentStateTracker, type AgentStateChange } from '../src/agent-state';

const surf = 'surf-hook-1';
let clock = 0;
let changes: AgentStateChange[];
let t: AgentStateTracker;

beforeEach(() => {
  clock = 100;
  changes = [];
  t = new AgentStateTracker({ now: () => ++clock, onChange: (c) => changes.push(c) });
});

const h = (event: string, message: string | null = null, at?: number, notificationType?: string) =>
  t.hook(surf, { event, ...(message !== null ? { message } : {}), ...(at !== undefined ? { at } : {}), ...(notificationType ? { notificationType } : {}) });
const state = () => t.get(surf)?.state;

describe('AgentStateTracker: hook events', () => {
  it('ignores hook events that are not part of the model', () => {
    h('PreCompact');
    expect(t.get(surf)).toBeUndefined();
    expect(changes).toEqual([]);
  });

  it('a fresh session reads idle', () => {
    h('SessionStart');
    expect(state()).toBe('idle');
  });

  it('working from the moment the human hits Enter', () => {
    h('SessionStart');
    h('UserPromptSubmit');
    expect(state()).toBe('working');
  });

  it('replying to a blocked pane un-blocks it', () => {
    h('Notification', 'Claude needs your permission to use Bash');
    expect(t.get(surf)).toMatchObject({ state: 'needs_you', reason: 'Claude needs your permission to use Bash' });
    h('UserPromptSubmit');
    expect(t.get(surf)).toEqual({ state: 'working', since: expect.any(Number) });
  });

  it('a long tool reports working while it runs', () => {
    h('PreToolUse');
    expect(state()).toBe('working');
  });

  it('SessionEnd releases the pane to idle', () => {
    h('SessionStart');
    h('UserPromptSubmit');
    h('SessionEnd');
    expect(t.get(surf)).toMatchObject({ state: 'idle', reason: 'session ended' });
  });

  it('orders racing hook processes by fire time, not arrival', () => {
    h('Stop', null, 2000);
    h('PostToolUse', null, 1000);
    expect(state()).toBe('idle');
  });

  it('still applies hook events that arrive in order', () => {
    h('Stop', null, 1000);
    h('UserPromptSubmit', null, 2000);
    expect(state()).toBe('working');
  });

  it('drives a full turn: tool use → permission prompt → done', () => {
    h('PostToolUse');
    expect(state()).toBe('working');
    h('Notification', 'permission to use Bash');
    expect(t.get(surf)).toMatchObject({ state: 'needs_you', reason: 'permission to use Bash' });
    h('Stop');
    expect(t.get(surf)).toEqual({ state: 'idle', since: expect.any(Number) });
  });

  it('background work and subagents do not retract a live question', () => {
    h('UserPromptSubmit');
    h('Notification', 'Claude needs your permission');
    for (const event of ['PreToolUse', 'PostToolUse', 'SubagentStop']) {
      h(event);
      expect(t.get(surf)).toMatchObject({ state: 'needs_you', reason: 'Claude needs your permission' });
    }
    // The run is still in flight underneath: answering leaves a live turn.
    t.humanInput(surf, '1');
    expect(state()).toBe('working');
    h('Stop');
    expect(state()).toBe('idle');
  });

  it('hundreds of tool calls do not inflate the run depth', () => {
    for (let i = 0; i < 300; i++) h('PostToolUse');
    h('Stop');
    expect(state()).toBe('idle');
  });

  it('the idle nudge does not resurrect a finished turn', () => {
    h('SessionStart');
    h('UserPromptSubmit');
    h('Stop');
    h('Notification', 'Claude is waiting for your input');
    expect(t.get(surf)).toEqual({ state: 'idle', since: expect.any(Number) });
  });

  it('a subagent finishing does not end the outer turn', () => {
    h('UserPromptSubmit');
    for (let i = 0; i < 3; i++) {
      h('PostToolUse');
      h('SubagentStop');
      expect(state()).toBe('working');
    }
    h('Stop');
    expect(state()).toBe('idle');
  });

  it('a SubagentStop trailing the parent Stop does not resurrect the turn', () => {
    h('UserPromptSubmit', null, 1000);
    h('PostToolUse', null, 2000);
    h('Stop', null, 3000);
    h('SubagentStop', null, 5000);
    expect(state()).toBe('idle');
    h('Notification', 'Claude is waiting for your input', 65000);
    expect(state()).toBe('idle');
  });

  it('a background subagent finishing after Stop does not end in needs_you', () => {
    h('UserPromptSubmit', null, 1000);
    h('PreToolUse', null, 2000);
    h('Stop', null, 3000);
    h('PreToolUse', null, 4000);
    h('PostToolUse', null, 5000);
    h('SubagentStop', null, 6000);
    h('Notification', 'Claude is waiting for your input', 66000, 'idle_prompt');
    expect(state()).not.toBe('needs_you');
  });

  it('an idle reminder does not retract a block that is really there', () => {
    h('UserPromptSubmit', null, 1000);
    h('Notification', 'Claude needs your permission to use Bash', 2000, 'permission_prompt');
    h('Notification', 'Claude is waiting for your input', 62000, 'idle_prompt');
    expect(t.get(surf)).toMatchObject({ state: 'needs_you', reason: 'Claude needs your permission to use Bash' });
  });
});

describe('AgentStateTracker: everything else', () => {
  it('publishes only real changes, and `since` moves only on a transition', () => {
    h('UserPromptSubmit');
    h('PreToolUse');
    h('PostToolUse');
    expect(changes.map((c) => c.info.state)).toEqual(['working']);
    const since = changes[0].info.since;
    h('Notification', 'first question', undefined, 'permission_prompt');
    h('Notification', 'reworded question', undefined, 'permission_prompt');
    expect(changes.map((c) => c.info.state)).toEqual(['working', 'needs_you', 'needs_you']);
    expect(changes[2].info.since).toBe(changes[1].info.since);
    expect(changes[2].info.reason).toBe('reworded question');
    expect(since).toBeLessThan(changes[1].info.since);
  });

  it('pane.report_agent: declared state, ordered by seq', () => {
    t.rpc(surf, 'pane.report_agent', { seq: 2, awaitingHuman: true, reason: 'pick one', runDelta: 1 });
    expect(t.get(surf)).toMatchObject({ state: 'needs_you', reason: 'pick one' });
    t.rpc(surf, 'pane.report_agent', { seq: 1, awaitingHuman: false });
    expect(state()).toBe('needs_you');
    t.rpc(surf, 'pane.report_agent', { seq: 3, awaitingHuman: false, runDepth: 0 });
    expect(state()).toBe('idle');
    expect(t.rpc(surf, 'pane.unrelated', {})).toBe(false);
  });

  it('pane.release_agent goes idle', () => {
    t.rpc(surf, 'pane.report_agent', { runDelta: 1 });
    t.rpc(surf, 'pane.release_agent', {});
    expect(t.get(surf)).toMatchObject({ state: 'idle', reason: 'released' });
  });

  it('only answering input clears a block; an arrow key or a bare escape sequence does not', () => {
    h('UserPromptSubmit');
    h('Notification', 'pick one', undefined, 'permission_prompt');
    t.humanInput(surf, '\x1b[B');
    expect(state()).toBe('needs_you');
    t.humanInput(surf, '\r');
    expect(state()).toBe('working');
  });

  it('a lone Escape ends the run', () => {
    h('UserPromptSubmit');
    t.humanInput(surf, '\x1b');
    expect(state()).toBe('idle');
  });

  it('input into a pane with no agent changes nothing', () => {
    t.humanInput(surf, 'ls\r');
    expect(t.get(surf)).toBeUndefined();
  });

  it('exit is recorded, and a new report revives the surface', () => {
    t.exit(surf, 3);
    expect(t.get(surf)).toMatchObject({ state: 'exited', reason: 'exit 3' });
    t.humanInput(surf, '\r');
    expect(state()).toBe('exited');
    h('SessionStart');
    expect(state()).toBe('idle');
  });

  it('seed restores the remembered state without publishing it', () => {
    t.seed(surf, { state: 'needs_you', since: 42, reason: 'q' });
    expect(t.get(surf)).toEqual({ state: 'needs_you', since: 42, reason: 'q' });
    expect(changes).toEqual([]);
    t.humanInput(surf, 'y');
    expect(state()).toBe('idle');
  });

  it('reasons are clipped to 300 characters', () => {
    h('Notification', 'x'.repeat(1000), undefined, 'permission_prompt');
    expect(t.get(surf)?.reason).toHaveLength(300);
  });
});
