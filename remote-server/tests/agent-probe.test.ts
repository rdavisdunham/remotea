import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { codexThreadFromFds, codexThreadFromPath, codexThreadFromState, codexStateQuery, readClaudeSession, processStartMs, probeSession, resolveCodexResumeThread } from '../src/agent-probe';
import { codexFixture } from './codex-fixture';

const ROOT = '01a18b04-f39b-7cc3-a0f8-240c06733e01';
const CHILD = '01a19f29-def4-7771-88ed-c4953f1116c6';
const OTHER = '01a15fd1-ffc7-7b41-8e8f-f223d072883a';
const guardian = { source: { subagent: { other: 'guardian' } }, parent_thread_id: ROOT };
const fixtures: ReturnType<typeof codexFixture>[] = [];
function fixture() {
  const f = codexFixture();
  fixtures.push(f);
  return f;
}
afterEach(() => {
  for (const f of fixtures.splice(0)) f.dispose();
});

describe('agent-probe', () => {
  it('reads a Claude session id only from a well-formed <pid>.json', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'remotea-probe-'));
    fs.mkdirSync(path.join(home, '.claude', 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'sessions', '123.json'), JSON.stringify({ pid: 123, sessionId: 'b20634a6-656f-47f0-921d-fb11b36837bb' }));
    fs.writeFileSync(path.join(home, '.claude', 'sessions', '124.json'), JSON.stringify({ pid: 999, sessionId: 'b20634a6-656f-47f0-921d-fb11b36837bb' }));
    fs.writeFileSync(path.join(home, '.claude', 'sessions', '125.json'), '{ broken');
    expect(readClaudeSession(123, home)).toBe('b20634a6-656f-47f0-921d-fb11b36837bb');
    expect(readClaudeSession(124, home)).toBeNull();
    expect(readClaudeSession(125, home)).toBeNull();
    expect(readClaudeSession(126, home)).toBeNull();
  });

  it('takes the Codex thread id from a rollout path', () => {
    expect(codexThreadFromPath('/home/x/.codex/sessions/2026/10/21/rollout-2026-10-21T13-56-00-01a15fd1-ffc7-7b41-8e8f-f223d072883a.jsonl'))
      .toBe('01a15fd1-ffc7-7b41-8e8f-f223d072883a');
    expect(codexThreadFromPath('/home/x/.codex/logs_2.sqlite')).toBeNull();
    expect(codexThreadFromPath('/tmp/rollout-01a15fd1-ffc7-7b41-8e8f-f223d072883a.jsonl')).toBeNull();
  });

  it('uses the Codex state index only when exactly one thread fits', () => {
    const one = () => [{ id: '01a15fd1-ffc7-7b41-8e8f-f223d072883a', created_at_ms: 10 }];
    const two = () => [...one(), { id: '01a16021-4e06-7ff1-ba20-e1179117e722', created_at_ms: 20 }];
    expect(codexThreadFromState('/proj', 1, one)).toBe('01a15fd1-ffc7-7b41-8e8f-f223d072883a');
    expect(codexThreadFromState('/proj', 1, two)).toBeNull();
    expect(codexThreadFromState('/proj', 1, () => null)).toBeNull();
  });

  it('knows when this very process started', () => {
    const start = processStartMs(process.pid)!;
    expect(start).toBeLessThanOrEqual(Date.now());
    expect(Date.now() - start).toBeLessThan(10 * 60 * 1000);
  });

  it.each([true, false])('picks the root with a Guardian rollout open (child first: %s)', (childFirst) => {
    const f = fixture();
    const root = f.thread(ROOT, { source: 'vscode' });
    const child = f.thread(CHILD, guardian);
    for (const file of childFirst ? [child, root] : [root, child]) f.open(file);
    expect(codexThreadFromFds(process.pid)).toBe(ROOT);
  });

  it('does not detect a worker or Guardian as the terminal conversation', () => {
    const f = fixture();
    f.open(f.thread(CHILD, guardian));
    f.open(f.thread(OTHER, { source: { subagent: { thread_spawn: { parent_thread_id: ROOT } } } }));
    expect(codexThreadFromFds(process.pid)).toBeNull();
  });

  it('does not guess between two distinct roots, but tolerates duplicate root descriptors', () => {
    const f = fixture();
    const root = f.thread(ROOT);
    f.open(root);
    f.open(root);
    expect(codexThreadFromFds(process.pid)).toBe(ROOT);
    f.open(f.thread(OTHER));
    expect(codexThreadFromFds(process.pid)).toBeNull();
  });

  it('does not override child-only descriptor evidence with a cwd/time guess', () => {
    const f = fixture();
    f.open(f.thread(CHILD, guardian));
    const query = vi.fn(() => [{ id: ROOT, created_at_ms: Date.now() }]);
    const title = process.title;
    try {
      // Exercise the actual /proc path without launching Codex or an agent.
      process.title = 'codex';
      expect(probeSession(process.pid, { home: f.home, index: new Map(), codexQuery: query }).agent).toBeUndefined();
      expect(query).not.toHaveBeenCalled();
    } finally {
      process.title = title;
    }
  });

  it.each(['{ broken\n', JSON.stringify({ type: 'session_meta', payload: { id: ROOT, source: 'cli' } }), 'x'.repeat(1024 * 1024) + '\n'])(
    'refuses an unreadable, unfinished, or oversized metadata header (%#)', (header) => {
      const f = fixture();
      const file = f.thread(ROOT);
      fs.writeFileSync(file, header);
      f.open(file);
      expect(codexThreadFromFds(process.pid)).toBeNull();
    },
  );

  it('requires the metadata ID to match the rollout filename', () => {
    const f = fixture();
    f.open(f.thread(ROOT, { id: OTHER }));
    expect(codexThreadFromFds(process.pid)).toBeNull();
  });

  it('uses the state fallback only for roots, filtering children before its result limit', () => {
    const f = fixture();
    for (let i = 0; i < 6; i++) {
      f.thread(`00000000-0000-0000-0000-00000000000${i}`, guardian, 10_000 + i);
    }
    const query = codexStateQuery(f.home);
    expect(codexThreadFromState('/proj', 10_000, query)).toBeNull();
    f.thread(ROOT, {}, 10_010);
    expect(codexThreadFromState('/proj', 10_000, query)).toBe(ROOT);
    f.thread(OTHER, {}, 10_020);
    expect(codexThreadFromState('/proj', 10_000, query)).toBeNull();
    expect(codexThreadFromState('/elsewhere', 10_000, query)).toBeNull();
    expect(codexThreadFromState('/proj', 100_000, query)).toBeNull();
  });

  it('repairs a saved Guardian ID to its verified parent even when the parent is much older', () => {
    const f = fixture();
    f.thread(ROOT, { source: 'vscode' }, 1);
    const file = f.thread(CHILD, guardian);
    const before = fs.readFileSync(file);
    expect(resolveCodexResumeThread(CHILD, f.home)).toBe(ROOT);
    expect(resolveCodexResumeThread(ROOT, f.home)).toBe(ROOT);
    expect(fs.readFileSync(file)).toEqual(before);
    expect(f.db.prepare('SELECT count(*) AS n FROM threads').get()).toMatchObject({ n: 2 });
  });

  it('follows explicit internal parent chains, not nearby sessions in the same folder', () => {
    const f = fixture();
    f.thread(ROOT);
    f.thread(OTHER, { ...guardian, parent_thread_id: ROOT });
    f.thread(CHILD, { ...guardian, parent_thread_id: OTHER });
    expect(resolveCodexResumeThread(CHILD, f.home)).toBe(ROOT);
  });

  it.each([undefined, 'invalid; command', OTHER, CHILD])('does not resume a child with a missing, invalid, unknown, or cyclic parent (%s)', (parent) => {
    const f = fixture();
    f.thread(ROOT); // A nearby valid root must not be guessed.
    f.thread(CHILD, { ...guardian, parent_thread_id: parent });
    expect(resolveCodexResumeThread(CHILD, f.home)).toBeNull();
  });

  it('refuses recovery when a known child or its parent has unreadable metadata', () => {
    const f = fixture();
    const root = f.thread(ROOT);
    const child = f.thread(CHILD, guardian);
    fs.unlinkSync(root);
    expect(resolveCodexResumeThread(CHILD, f.home)).toBeNull();
    fs.writeFileSync(child, '{ broken\n');
    expect(resolveCodexResumeThread(CHILD, f.home)).toBeNull();
  });

  it('preserves existing resume behavior for an unindexed session or unavailable index', () => {
    const f = fixture();
    expect(resolveCodexResumeThread(ROOT, f.home)).toBe(ROOT);
    expect(resolveCodexResumeThread(ROOT, path.join(f.home, 'missing'))).toBe(ROOT);
    expect(resolveCodexResumeThread('invalid; command', f.home)).toBeNull();
  });
});
