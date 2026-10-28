import crypto from 'crypto';
import { describe, expect, it } from 'vitest';
import {
  ERIDANI_LIMITS,
  STAGE_B_CAPS,
  assembleParts,
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
});
