import { describe, expect, it, vi } from 'vitest';
import { ClaudeRuntimeAdapter, claudeLaunchArgs, eridaniToolsForRole, type HarnessSpec } from '../src/managed-harness';

const tools = eridaniToolsForRole('planner').map(name => `mcp__eridani__${name}`);
function spec(extra: Partial<HarnessSpec> = {}): HarnessSpec {
  return { harness: 'claude', bin: 'claude', args: [], cwd: '/project', env: { ERIDANI_RUN_TOKEN: 'bound-run' },
    model: 'model', profile: 'read-only', preapprovedEridaniTools: tools, ...extra };
}
class PermissionAdapter extends ClaudeRuntimeAdapter {
  writes: any[] = [];
  modes: string[] = [];
  async call(_method: string, params: any) { this.modes.push(params.mode); return {}; }
  async send() {}
  protected write(message: unknown) { this.writes.push(message); }
  receiveEvent(message: unknown) { this.receive(message); }
}
function request(extra: Record<string, unknown> = {}) {
  return { type: 'control_request', request_id: 'permission-1', request: {
    subtype: 'can_use_tool', tool_name: 'mcp__eridani__submit_plan', tool_use_id: 'submit-1',
    decision_reason_type: 'mode', mcp_server: { name: 'eridani', source: 'dynamic' },
    input: { task_id: 'task', prd: 'Prepared plan' }, ...extra,
  } };
}

describe('managed Claude permissions', () => {
  it('pre-approves an owner-authorized coordination write while preserving the exact tool input', () => {
    const adapter = new PermissionAdapter(spec());
    const forwarded: unknown[] = [];
    adapter.on('event', event => forwarded.push(event));
    const message = request();
    adapter.receiveEvent(message);
    expect(adapter.writes).toEqual([{ type: 'control_response', response: { subtype: 'success', request_id: 'permission-1',
      response: { behavior: 'allow', updatedInput: message.request.input } } }]);
    expect(forwarded).toEqual([]);
    expect(claudeLaunchArgs(spec(), 'conversation')).toContain('plan');
  });

  it('applies the same role policy when resuming a saved conversation', () => {
    const resumed = spec({ sessionId: 'saved-conversation' });
    const adapter = new PermissionAdapter(resumed);
    adapter.receiveEvent(request());
    expect(adapter.writes[0].response.response.behavior).toBe('allow');
    expect(claudeLaunchArgs(resumed, 'unused')).toEqual(expect.arrayContaining(['--resume', 'saved-conversation']));
  });

  it.each([
    { decision_reason_type: 'rule' },
    { decision_reason_type: 'policy' },
    { decision_reason_type: 'hook' },
    { decision_reason_type: undefined },
    { mcp_server: { name: 'other' } },
    { tool_name: 'mcp__eridani__task_complete' },
    { tool_name: 'mcp__eridani__submit_plan_extra' },
    { tool_name: 'AskUserQuestion' },
    { tool_name: 'Bash' },
    { tool_name: 'Write' },
    { input: { run_token: 'another-run' } },
  ])('keeps the decision card path available for an exceptional request %j', extra => {
    const adapter = new PermissionAdapter(spec());
    const forwarded: unknown[] = [];
    adapter.on('event', event => forwarded.push(event));
    const message = request(extra);
    adapter.receiveEvent(message);
    expect(adapter.writes).toEqual([]);
    expect(forwarded).toEqual([message]);
  });

  it.each([{ env: {} }, { preapprovedEridaniTools: undefined }])('requires explicit run binding and role authorization %j', extra => {
    const adapter = new PermissionAdapter(spec(extra));
    const forwarded: unknown[] = [];
    adapter.on('event', event => forwarded.push(event));
    adapter.receiveEvent(request());
    expect(adapter.writes).toEqual([]);
    expect(forwarded).toHaveLength(1);
  });

  it('keeps planner, reviewer and worker coordination permissions scoped to their roles', () => {
    expect(eridaniToolsForRole('planner')).toEqual(['task_plan', 'task_interview', 'submit_plan', 'session_link']);
    expect(eridaniToolsForRole('reviewer')).toEqual(['task_plan', 'submit_plan_review', 'session_link']);
    expect(eridaniToolsForRole('worker')).toEqual(['task_plan', 'task_step', 'session_link']);
    const adapter = new PermissionAdapter(spec({ preapprovedEridaniTools: eridaniToolsForRole('reviewer').map(name => `mcp__eridani__${name}`) }));
    const forwarded: unknown[] = [];
    adapter.on('event', event => forwarded.push(event));
    adapter.receiveEvent(request());
    expect(adapter.writes).toEqual([]);
    expect(forwarded).toHaveLength(1);
  });

  it.each(['read-only', 'workspace-write'] as const)('restores %s permissions only after a recreated request has been reviewed and consumed', async profile => {
    const adapter = new PermissionAdapter(spec({ profile }));
    const original = { id: 'old', method: 'claude/permission', params: request().request };
    await adapter.recreate(original);
    const forwarded: unknown[] = [];
    adapter.on('event', event => forwarded.push(event));
    const message = request();
    adapter.receiveEvent(message);
    expect(adapter.writes).toEqual([]);
    expect(forwarded).toEqual([message]);
    await adapter.respond({ ...original, id: 'permission-1' }, { behavior: 'allow', updatedInput: message.request.input });
    expect(adapter.modes).toEqual(['manual']);
    adapter.receiveEvent({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'unrelated' }] } });
    expect(adapter.modes).toEqual(['manual']);
    adapter.receiveEvent({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'submit-1' }] } });
    await Promise.resolve();
    expect(adapter.modes).toEqual(['manual', profile === 'read-only' ? 'plan' : 'auto']);
    adapter.writes = [];
    forwarded.length = 0;
    adapter.receiveEvent(request());
    expect(adapter.writes[0].response.response.behavior).toBe('allow');
    expect(forwarded).toEqual([]);
  });

  it.each([['--permission-mode', 'acceptEdits'], ['--permission-mode=acceptEdits']])('preserves a fixed launcher mode override after reviewed recovery %j', async (...args) => {
    const adapter = new PermissionAdapter(spec({ args }));
    const original = { id: 'old', method: 'claude/permission', params: request().request };
    await adapter.recreate(original);
    await adapter.respond(original, { behavior: 'allow', updatedInput: original.params.input });
    adapter.receiveEvent({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'submit-1' }] } });
    await Promise.resolve();
    expect(adapter.modes).toEqual(['manual', 'acceptEdits']);
  });

  it('keeps the recovery gate until the exact interrupted action is reviewed, even after an approved context read', async () => {
    const adapter = new PermissionAdapter(spec());
    const original = { id: 'old', method: 'claude/permission', params: request().request };
    await adapter.recreate(original);
    await adapter.respond({ id: 'read', method: 'claude/permission', params: { tool_name: 'Read', tool_use_id: 'read-1', input: { file_path: '/project/file' } } },
      { behavior: 'allow', updatedInput: { file_path: '/project/file' } });
    adapter.receiveEvent({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'read-1' }] } });
    expect(adapter.modes).toEqual(['manual']);
    adapter.writes = [];
    adapter.receiveEvent(request());
    expect(adapter.writes).toEqual([]);
  });

  it('keeps the recovery gate and reports a failed mode restoration', async () => {
    const adapter = new PermissionAdapter(spec());
    const original = { id: 'old', method: 'claude/permission', params: request().request };
    await adapter.recreate(original);
    const faults: Error[] = [];
    adapter.on('fault', fault => faults.push(fault));
    vi.spyOn(adapter, 'call').mockRejectedValueOnce(new Error('Transport unavailable'));
    await adapter.respond(original, { behavior: 'allow', updatedInput: original.params.input });
    adapter.receiveEvent({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'submit-1' }] } });
    await vi.waitFor(() => expect(faults).toHaveLength(1));
    expect(faults[0].message).toContain('Could not restore');
    adapter.writes = [];
    adapter.receiveEvent(request());
    expect(adapter.writes).toEqual([]);
  });

  it('keeps recovered denials under explicit review', async () => {
    const adapter = new PermissionAdapter(spec());
    const original = { id: 'old', method: 'claude/permission', params: request().request };
    await adapter.recreate(original);
    await adapter.respond(original, { behavior: 'deny', message: 'Denied' });
    adapter.receiveEvent({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'submit-1', is_error: true }] } });
    expect(adapter.modes).toEqual(['manual']);
    adapter.writes = [];
    adapter.receiveEvent(request());
    expect(adapter.writes).toEqual([]);
  });
});
