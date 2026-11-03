import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { Hub } from '../src/hub';
import { Registry } from '../src/registry';
import { resolveCodexResumeThread } from '../src/agent-probe';
import type { SessionRecord } from '../../src/shared/remote-host-protocol';
import { FakeConn, fakeSpawner, ManualTimers } from './helpers';
import { codexFixture } from './codex-fixture';

const ROOT = '01a18b04-f39b-7cc3-a0f8-240c06733e01';
const CHILD = '01a19f29-def4-7771-88ed-c4953f1116c6';
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

function setup(patch: Partial<SessionRecord> = {}, parentExists = true) {
  const f = codexFixture();
  if (parentExists) f.thread(ROOT, { source: 'vscode' }, 1);
  f.thread(CHILD, { source: { subagent: { other: 'guardian' } }, parent_thread_id: ROOT });
  const registryFile = path.join(f.home, 'registry.json');
  const registry = Registry.load({ file: registryFile, bootId: 'new-boot' });
  registry.addSession({
    id: 'surf-codex', groupId: 'grp-inbox', title: 'Codex', cwd: '/proj',
    createdBy: 'device-owner', createdAt: 1, bootId: 'old-boot', state: 'lost', hiddenBy: [],
    agent: { provider: 'codex', sessionId: CHILD, seenAt: 100 }, ...patch,
  });
  const sp = fakeSpawner();
  const timers = new ManualTimers();
  const resolve = vi.fn((id: string) => resolveCodexResumeThread(id, f.home));
  const hub = new Hub({ registry, spawn: sp.spawn, timers, bootId: 'new-boot', serverId: 'host', resolveCodexThread: resolve });
  const owner = new FakeConn(1);
  hub.connect(owner);
  hub.handle(owner, { t: 'hello', proto: 1, device: { id: 'device-owner', name: 'Owner' }, app: { name: 'test', version: '1' } });
  cleanups.push(() => { hub.shutdown(); registry.saveNow(); f.dispose(); });
  const open = () => hub.handle(owner, {
    t: 'open', id: 'surf-codex', rid: 1, cols: 80, rows: 24,
    create: { startupCommands: [`codex resume ${CHILD}`] },
  });
  return { f, hub, registry, registryFile, owner, sp, timers, open, resolve };
}

describe('native Codex recovery', () => {
  it.each([undefined, 'codex -m gpt-6.1-sol'])('repairs a persisted Guardian before recovery and resumes only its parent (cmd: %s)', (cmd) => {
    const { hub, registry, registryFile, owner, sp, timers, open } = setup({ cmd });
    expect(owner.json('welcome')[0].sessions[0].agent?.sessionId).toBe(ROOT);
    hub.handle(owner, { t: 'probe', rid: 2, ids: ['surf-codex'] });
    expect(owner.json('probed')[0].last['surf-codex'].agent?.sessionId).toBe(ROOT);
    open();
    open(); // A second device/retry still attaches to the existing process.
    timers.advance(6000);
    expect(sp.ptys).toHaveLength(1);
    const commands = [sp.last().req.cmd ?? '', ...sp.last().written].join('\n');
    expect(commands).toContain(`codex resume ${ROOT}`);
    expect(commands).not.toContain(CHILD);
    expect(registry.session('surf-codex')?.agent).toEqual({ provider: 'codex', sessionId: ROOT, seenAt: 100 });
    registry.saveNow();
    expect(JSON.parse(fs.readFileSync(registryFile, 'utf8')).sessions['surf-codex'].agent.sessionId).toBe(ROOT);
  });

  it('repairs exited entries used by the desktop recovery dialog without starting a process', () => {
    const { owner, sp, open } = setup({ state: 'exited', exitCode: 0 });
    expect(owner.json('welcome')[0].sessions[0].agent?.sessionId).toBe(ROOT);
    open();
    expect(sp.ptys).toHaveLength(0);
  });

  it('leaves an unresolved child lost and reports a useful error instead of rerunning the original command', () => {
    const { owner, registry, sp, open } = setup({ cmd: 'codex original-prompt' }, false);
    open();
    expect(sp.ptys).toHaveLength(0);
    expect(owner.json('openError')[0]).toMatchObject({ code: 'spawn-failed', message: expect.stringContaining('parent conversation could not be verified') });
    expect(registry.session('surf-codex')).toMatchObject({ state: 'lost', agent: { sessionId: CHILD } });
  });

  it('does not let a later Guardian hook overwrite a repaired native conversation', () => {
    const { hub, registry, owner, open } = setup();
    open();
    owner.clear();
    hub.relayRpc('surf-codex', 'hook.event', { provider: 'codex', event: 'SessionStart', sessionId: CHILD });
    expect(registry.session('surf-codex')?.agent?.sessionId).toBe(ROOT);
    expect(owner.json('meta').filter(m => m.agent?.sessionId === CHILD)).toHaveLength(0);
  });

  it('keeps Eridani provider identities and custom resume commands under Eridani control', () => {
    const { hub, registry, sp, open, resolve } = setup({ eridani: {
      runId: 'run', generation: 1, attempt: 1, taskId: 'task', target: 'repo',
      harness: 'codex', model: 'gpt-6.1-sol', worktree: '/proj', branch: 'task/work',
      base: 'main', baseSha: null, spawnOp: 'spawn',
    } });
    hub.setEridani({ resumeCommand: () => 'codex resume --model gpt-6.1-sol managed-thread' });
    open();
    expect(resolve).not.toHaveBeenCalled();
    expect(registry.session('surf-codex')?.agent?.sessionId).toBe(CHILD);
    expect(sp.last().req.cmd).toBe('codex resume --model gpt-6.1-sol managed-thread');
  });
});
