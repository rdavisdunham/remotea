import crypto from 'crypto';
import { describe, expect, it } from 'vitest';
import {
  ERIDANI_LIMITS,
  STAGE_B_CAPS,
  assembleParts,
  commandShapeError,
  canonicalJson,
  chunkItems,
  parseDownFrame,
  parseEnvelope,
  parseUpFrame,
  semanticPayload,
  truncateText,
  utf8Length,
} from '../../src/shared/eridani-link-protocol';
import { digestOf } from '../src/eridani-link';

const env = (body: Record<string, unknown>) => ({ v: 1, id: 'id-1', conn_epoch: 3, at: 1, ...body });

describe('eridani link protocol', () => {
  it('canonical JSON matches Python json.dumps(sort_keys, compact, ensure_ascii=False)', () => {
    const frame = { t: 'turn', surf: 'surf-1', seq: 3, text: 'héllo ✓   "q"', truncated: false, run_id: null, part: { n: 1, i: 1 } };
    // Computed with python3: json.dumps(f, sort_keys=True, separators=(",",":"), ensure_ascii=False)
    expect(canonicalJson(frame)).toBe('{"part":{"i":1,"n":1},"run_id":null,"seq":3,"surf":"surf-1","t":"turn","text":"héllo ✓   \\"q\\"","truncated":false}');
    expect(crypto.createHash('sha256').update(canonicalJson(frame)).digest('hex')).toBe('210a98a9dcd75ac360c5da51e1d1094c400b797efe48e01c206280069c2d6b59');
  });

  it('the digest ignores the envelope and identity fields, and nothing else', () => {
    const body = { t: 'status', surf: 's', state: 'idle', since: 5, revision: 2 };
    const a = digestOf({ ...env(body), op_id: 'op-1', digest: 'x' });
    const b = digestOf({ ...body, v: 1, id: 'other', conn_epoch: null, at: 99, op_id: 'op-2' });
    expect(a).toBe(b);
    expect(digestOf({ ...body, state: 'working' })).not.toBe(a);
    expect(Object.keys(semanticPayload({ ...env(body), op_id: 'o', digest: 'd', extra: undefined })).sort()).toEqual(['revision', 'since', 'state', 'surf', 't']);
  });

  it('parses the frames Eridani sends', () => {
    expect(parseDownFrame(env({ t: 'welcome', host_id: 'h', conn_epoch: 4, server_time: 1 }))).toMatchObject({ t: 'welcome', conn_epoch: 4 });
    expect(parseDownFrame(env({ t: 'welcome', host_id: 'h', conn_epoch: null }))).toBeNull();
    // First-time probe: Eridani has no host row yet and answers host_id null (seen live on 2026-10-28).
    expect(parseDownFrame(env({ t: 'welcome', host_id: null, conn_epoch: 0, server_time: 1, probe: true }))).toMatchObject({ t: 'welcome', host_id: null });
    expect(parseDownFrame(env({ t: 'welcome', host_id: null, conn_epoch: 0, server_time: 1 }))).toBeNull();
    expect(parseDownFrame(env({ t: 'ack', acked_id: 'a', ok: true }))).toMatchObject({ ok: true });
    expect(parseDownFrame(env({ t: 'ack', acked_id: 'a' }))).toBeNull();
    expect(parseDownFrame(env({ t: 'bye', reason: 'x'.repeat(1000) }))).toMatchObject({ reason: 'x'.repeat(ERIDANI_LIMITS.reasonChars) });
    expect(parseDownFrame(env({ t: 'prompt.inject', op_id: 'o', digest: 'd' }))).toMatchObject({ op_id: 'o' });
    expect(parseDownFrame(env({ t: 'prompt.inject' }))).toBeNull();
    expect(parseEnvelope({ v: 2, id: 'x', t: 'ack' })).toBeNull();
    expect(parseEnvelope({ v: 1, id: 'x', t: 'ack', conn_epoch: 'nope' })).toBeNull();
    expect(parseEnvelope([1])).toBeNull();
  });

  it('validates the frames remotea sends', () => {
    const op = { op_id: 'o', digest: 'd' };
    expect(parseUpFrame(env({ t: 'hello', server_id: 's', boot_id: 'b', proto: 1, caps: [...STAGE_B_CAPS], harnesses: {} }))).not.toBeNull();
    expect(parseUpFrame(env({ t: 'turn', ...op, surf: 's', provider_turn_id: 'p', seq: 1, text: 'x', truncated: false }))).not.toBeNull();
    expect(parseUpFrame(env({ t: 'turn', ...op, surf: 's', provider_turn_id: 'p', seq: 1, text: 'x'.repeat(ERIDANI_LIMITS.turnTextChars + 1), truncated: true }))).toBeNull();
    expect(parseUpFrame(env({ t: 'status', ...op, surf: 's', state: 'needs_you', since: 1, revision: 1 }))).not.toBeNull();
    expect(parseUpFrame(env({ t: 'status', ...op, surf: 's', state: 'blocked', since: 1, revision: 1 }))).toBeNull();
    expect(parseUpFrame(env({ t: 'session.report', ...op, entity: 'claude_code:x', tool: 'claude_code', session_id: 'x', parity: true, report: {} }))).not.toBeNull();
    expect(parseUpFrame(env({ t: 'session.report', ...op, entity: 'claude_code:x', tool: 'claude_code', session_id: 'x', report: {} }))).toBeNull();
    expect(parseUpFrame(env({ t: 'turn', surf: 's', provider_turn_id: 'p', seq: 1, text: 'x', truncated: false }))).toBeNull();
    const prompt = { t: 'prompt', ...op, surf: 's', run_id: 'r', generation: 0, seq: 1, text: 'x', truncated: false, at: 1 };
    expect(parseUpFrame(env(prompt))).not.toBeNull();
    expect(parseUpFrame(env({ ...prompt, run_id: null }))).toBeNull();
    expect(parseUpFrame(env({ ...prompt, text: 'x'.repeat(ERIDANI_LIMITS.promptChars + 1), truncated: true }))).toBeNull();
    expect(parseUpFrame(env({ ...prompt, op_id: undefined }))).toBeNull();
  });

  it('truncates by code point and says so', () => {
    expect(truncateText('abc', 3)).toEqual({ text: 'abc', truncated: false });
    expect(truncateText('😀😀😀', 2)).toEqual({ text: '😀😀', truncated: true });
    expect(truncateText('😀😀', 2)).toEqual({ text: '😀😀', truncated: false });
  });

  it('measures UTF-8 like Buffer does', () => {
    for (const s of ['', 'abc', 'é', '✓', '😀', 'a😀é ']) expect(utf8Length(s)).toBe(Buffer.byteLength(s));
  });

  it('chunks under the frame budget and reassembles in order', () => {
    const items = Array.from({ length: 50 }, (_, i) => ({ i, pad: 'x'.repeat(100) }));
    const parts = chunkItems(items, 1200, 200);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(utf8Length(JSON.stringify(p)) + 200).toBeLessThanOrEqual(1200 + 10);
    const framed = parts.map((items, i) => ({ part: { of: 'w', i: i + 1, n: parts.length }, items }));
    expect(assembleParts(framed.slice(1))).toBeNull();
    expect(assembleParts([...framed].reverse())).toEqual(items);
    expect(chunkItems([], 100)).toEqual([[]]);
  });

  describe('stage C', () => {
    const exp = Date.now() + 60_000;
    const spawn = { t: 'spawn', op_id: 'o', digest: 'd', run_id: 'run-1', generation: 1, attempt: 1, harness: 'claude', model: 'sonnet', target: { id: 'p', branch: 'eri/x' }, prompt: 'hi', expires_at: exp };

    it('validates spawn: harness, model, branch, env keys, prompt, expiry', () => {
      expect(commandShapeError(spawn)).toBeNull();
      expect(commandShapeError({ ...spawn, harness: 'gemini' })).toBe('unsupported harness');
      expect(commandShapeError({ ...spawn, model: 'sonnet; rm -rf /' })).toBe('bad model');
      expect(commandShapeError({ ...spawn, target: { id: 'p', branch: '-x' } })).toBe('bad target');
      expect(commandShapeError({ ...spawn, env: { PATH: '/evil' } })).toMatch(/ERIDANI_\* only/);
      expect(commandShapeError({ ...spawn, env: { ERIDANI_X: 'a\nb' } })).toMatch(/one line/);
      expect(commandShapeError({ ...spawn, prompt: 'x'.repeat(ERIDANI_LIMITS.promptInChars + 1) })).toBe('bad prompt');
      expect(commandShapeError({ ...spawn, expires_at: 'soon' })).toBe('bad expires_at');
      expect(commandShapeError({ ...spawn, attempt: 0 })).toBe('bad generation/attempt');
    });

    it('validates input, stop, answer and verify fences', () => {
      const fence = { surf: 'surf-1', incarnation: 1, run_id: 'run-1', generation: 2, expires_at: exp };
      expect(commandShapeError({ t: 'input', mode: 'queue', text: 'go', ...fence })).toBeNull();
      expect(commandShapeError({ t: 'input', mode: 'shout', text: 'go', ...fence })).toBe('bad mode');
      expect(commandShapeError({ t: 'input', mode: 'queue', text: '   ', ...fence })).toBe('bad text');
      expect(commandShapeError({ t: 'input', mode: 'queue', text: 'x', ...fence, incarnation: 'one' })).toBe('bad fence');
      expect(commandShapeError({ t: 'stop', mode: 'kill', ...fence })).toBeNull();
      expect(commandShapeError({ t: 'stop', mode: 'nicely', ...fence })).toBe('bad mode');
      expect(commandShapeError({ t: 'answer', question_id: 'q', provider_request_id: 'toolu_1', answers: [{ item_id: 'q1', choice_ids: ['c1'] }], expires_at: exp })).toBeNull();
      expect(commandShapeError({ t: 'answer', question_id: 'q', provider_request_id: 'toolu_1', answers: [{ item_id: 'q1' }], expires_at: exp })).toBe('empty answer');
      expect(commandShapeError({ t: 'verify', attempt_id: 'a', run_id: 'r', generation: 1, turn_seq: 0, plan_revision: 0, verify_id: 'test', expires_at: exp })).toBeNull();
      expect(commandShapeError({ t: 'verify', attempt_id: 'a', run_id: 'r', generation: 1, turn_seq: 0, plan_revision: 0, verify_id: 'rm -rf', expires_at: exp })).toBe('bad verify');
    });

    it('parses context.response and runs.snapshot, refusing bad ones', () => {
      expect(parseDownFrame(env({ t: 'context.response', req_id: 'r', text: 'ctx', run_token: 'tok' }))).toMatchObject({ text: 'ctx' });
      expect(parseDownFrame(env({ t: 'context.response', req_id: 'r', text: 'x'.repeat(ERIDANI_LIMITS.contextChars + 1) }))).toBeNull();
      expect(parseDownFrame(env({ t: 'runs.snapshot', runs: [{ run_id: 'r', generation: 1, desired: 'stop', stop_mode: 'kill' }] }))).not.toBeNull();
      expect(parseDownFrame(env({ t: 'runs.snapshot', runs: [{ run_id: 'r', generation: 1, desired: 'explode' }] }))).toBeNull();
    });

    it('validates the stage C frames remotea sends', () => {
      const op = { op_id: 'o', digest: 'd' };
      const item = { id: 'q1', text: 'Which?', choices: [{ id: 'c1', label: 'A' }], multi: false };
      expect(parseUpFrame(env({ t: 'question', ...op, question_id: 'q', surf: 's', incarnation: 1, generation: 1, provider_request_id: 'toolu', group_id: 'toolu', items: [item] }))).not.toBeNull();
      expect(parseUpFrame(env({ t: 'question', ...op, question_id: 'q', surf: 's', generation: 1, provider_request_id: 'toolu', group_id: 'g', items: [] }))).toBeNull();
      expect(parseUpFrame(env({ t: 'question.resolved', ...op, question_id: 'q', generation: 1, outcome: 'timed_out', still_open: true }))).not.toBeNull();
      expect(parseUpFrame(env({ t: 'question.resolved', ...op, question_id: 'q', generation: 1, outcome: 'maybe', still_open: true }))).toBeNull();
      expect(parseUpFrame(env({ t: 'command.outcome', ...op, command_id: 'c', state: 'uncertain' }))).not.toBeNull();
      expect(parseUpFrame(env({ t: 'context.request', req_id: 'r', surf: 's', incarnation: 1, generation: 0 }))).not.toBeNull();
      expect(parseUpFrame(env({ t: 'verify.result', ...op, attempt_id: 'a', run_id: 'r', generation: 1, workspace_fingerprint: 'h:x', exit_code: null, tail: '', timed_out: true }))).not.toBeNull();
      expect(parseUpFrame(env({ t: 'verify.result', ...op, attempt_id: 'a', run_id: 'r', generation: 1, workspace_fingerprint: 'h:x', exit_code: 0, tail: 'x'.repeat(ERIDANI_LIMITS.verifyTailChars + 1), timed_out: false }))).toBeNull();
      expect(parseUpFrame(env({ t: 'worktrees.report', ...op, worktrees: [{ target: 't', path: '/p', candidate: false, reasons: ['dirty'] }] }))).not.toBeNull();
    });
  });
});
