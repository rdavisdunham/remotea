import { describe, expect, it } from 'vitest';
import { ContextService } from '../src/context';
import { handleBridgeRequest, hookToken } from '../src/hook-bridge';
import type { SessionRecord } from '../../src/shared/remote-host-protocol';

const REC = { id: 'surf-1', incarnation: 2, cwd: '/w', lastCwd: '/w/sub', eridani: { runId: 'run-1', generation: 3, taskId: 'task-9' } } as unknown as SessionRecord;

function svc(answer: (body: Record<string, unknown>) => Promise<Record<string, unknown> | null>, over: Partial<ConstructorParameters<typeof ContextService>[0]> = {}) {
  const sent: Array<Record<string, unknown>> = [];
  const s = new ContextService({
    session: (id) => (id === 'surf-1' ? REC : undefined),
    enabled: () => true,
    request: (b) => (sent.push(b), answer(b)),
    runToken: () => 'spawn-token',
    ...over,
  });
  return { s, sent };
}

describe('context', () => {
  it('asks Eridani with the session and run fences and prints its text plus the run token', async () => {
    const { s, sent } = svc(async () => ({ text: 'You are working on task 9.\n', run_token: 'fresh-token' }));
    const out = await s.sessionStart('surf-1', { sessionId: 'sess-1', source: 'startup' });
    expect(sent[0]).toMatchObject({ t: 'context.request', surf: 'surf-1', incarnation: 2, provider: 'claude', provider_session_id: 'sess-1', source: 'startup', cwd: '/w/sub', run_id: 'run-1', generation: 3, task_id: 'task-9' });
    expect(out).toContain('You are working on task 9.\n\nEridani run token: fresh-token (pass it as run_token to Eridani\'s task tools)\n');
  });

  it('no answer in time: one identifying line, with the spawn\'s token', async () => {
    const { s } = svc(async () => null);
    const out = await s.sessionStart('surf-1', { sessionId: 'sess-1', provider: 'codex' });
    expect(out).toContain('remotea: this is codex_cli session sess-1 on surf-1, Eridani run run-1 (generation 3).');
    expect(out).toContain('Eridani run token: spawn-token');
    expect(out).toContain('status-only bridge does not expose desktop browser or workspace control');
    expect(out).toContain('do not establish Eridani verification or task acceptance');
  });

  it('prints nothing when the link is off, for a subagent, or for an unknown surface', async () => {
    expect(await svc(async () => ({ text: 'x' }), { enabled: () => false }).s.sessionStart('surf-1', { sessionId: 's' })).toBe('');
    expect(await svc(async () => ({ text: 'x' })).s.sessionStart('surf-1', { sessionId: 's', agentId: 'a1' })).toBe('');
    expect(await svc(async () => ({ text: 'x' })).s.sessionStart('surf-2', { sessionId: 's' })).toBe('');
  });

  it('the bridge serves remotea.context to an authenticated helper only', async () => {
    const deps = { secret: 'sec', relay: () => true, context: async () => 'hello agent\n' };
    expect(await handleBridgeRequest(deps, { method: 'remotea.context', params: { surfaceId: 'surf-1' }, id: 1, token: hookToken('sec', 'surf-1') })).toEqual({ result: { text: 'hello agent\n' }, id: 1 });
    expect(await handleBridgeRequest(deps, { method: 'remotea.context', params: { surfaceId: 'surf-1' }, id: 1, token: 'wrong' })).toMatchObject({ error: { code: -32001 } });
  });

  it('the bridge holds remotea.question and passes the connection-close hook through', async () => {
    let fired = 0;
    const deps = {
      secret: 'sec',
      relay: () => true,
      question: async (_s: string, _p: Record<string, unknown>, closed: (cb: () => void) => void) => {
        closed(() => fired++);
        return { answers: { Q: 'A' }, questions: [] };
      },
    };
    const res = await handleBridgeRequest(deps, { method: 'remotea.question', params: { surfaceId: 'surf-1' }, id: 2, token: hookToken('sec', 'surf-1') }, (cb) => cb());
    expect(res).toEqual({ result: { answers: { Q: 'A' }, questions: [] }, id: 2 });
    expect(fired).toBe(1);
  });
});
