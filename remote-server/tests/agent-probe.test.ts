import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { codexThreadFromPath, codexThreadFromState, readClaudeSession, processStartMs } from '../src/agent-probe';

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
});
