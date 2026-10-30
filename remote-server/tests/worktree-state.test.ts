/**
 * SessionRecord.worktreeState (additive, for the desktop's recovery
 * inventory): each Eridani session's worktree facts from the same scan as
 * worktrees.report, written onto its registry record only when they change.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorktreeReport } from '../../src/shared/eridani-link-protocol';
import type { SessionRecord } from '../../src/shared/remote-host-protocol';
import { EridaniRuntime } from '../src/eridani-runtime';
import { Hub } from '../src/hub';
import { Registry } from '../src/registry';
import { sameWorktreeState, worktreeStateOf } from '../src/worktrees';
import { fakeSpawner, ManualTimers } from './helpers';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function row(patch: Partial<WorktreeReport> = {}): WorktreeReport {
  return {
    target: 'jarvis', path: '/wt/jarvis/eri-a', branch: 'eri/a', base: 'main', base_ref: 'origin/main', head: 'abc', active: false,
    ahead: 2, behind: 0, unpushed: null, upstream: null, merged: false, uncommitted: 1, untracked: 0, ignored: 3, candidate: false, reasons: ['x'],
    ...patch,
  };
}

function record(id: string, worktree: string | null): SessionRecord {
  return {
    id: id as SessionRecord['id'], groupId: null, cwd: '/wt', createdBy: 'dev-test00000' as SessionRecord['createdBy'], createdAt: 1, bootId: 'boot-1',
    state: 'exited', exitCode: 0, hiddenBy: [],
    ...(worktree ? {
      eridani: {
        runId: 'run-a', generation: 1, attempt: 1, taskId: 't', target: 'jarvis', harness: 'claude', model: 'm', worktree, branch: 'eri/a',
        base: 'main', baseSha: null, spawnOp: 'op',
      },
    } : {}),
  };
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remotea-wtstate-'));
  dirs.push(dir);
  const registry = Registry.load({ file: null, bootId: 'boot-1' });
  const hub = new Hub({ registry, spawn: fakeSpawner().spawn, bootId: 'boot-1', serverId: 'srv', hostname: 'box', timers: new ManualTimers(), probe: () => ({}) });
  const rt = new EridaniRuntime({ dir, hub, registry, serverId: 'srv', bootId: 'boot-1', hostname: 'box', version: '9.9.9', log: () => {}, windowsUsers: null });
  registry.addSession(record('surf-eri', '/wt/jarvis/eri-a'));
  registry.addSession(record('surf-plain', null));
  const stamp = (rows: WorktreeReport[]) => (rt as unknown as { stampWorktrees(r: WorktreeReport[]): void }).stampWorktrees(rows);
  return { registry, hub, stamp };
}

describe('worktreeState on Eridani session records', () => {
  it('carries the facts the desktop needs, not the whole report', () => {
    expect(worktreeStateOf(row())).toEqual({ uncommitted: 1, untracked: 0, ahead: 2, merged: false, unpushed: null, baseRef: 'origin/main' });
    expect(worktreeStateOf(row({ base_ref: undefined })).baseRef).toBe('main');
    expect(sameWorktreeState(undefined, worktreeStateOf(row()))).toBe(false);
    expect(sameWorktreeState({ ...worktreeStateOf(row()) }, worktreeStateOf(row({ ignored: 9, head: 'def' })))).toBe(true);
  });

  it('stamps the matching session, broadcasts only on change, and leaves other sessions alone', () => {
    const { registry, hub, stamp } = setup();
    const update = vi.spyOn(hub, 'updateRecord');
    stamp([row(), row({ path: '/wt/other', branch: 'eri/other' })]);
    expect(registry.session('surf-eri' as SessionRecord['id'])?.worktreeState).toMatchObject({ uncommitted: 1, ahead: 2, merged: false });
    expect(registry.session('surf-plain' as SessionRecord['id'])?.worktreeState).toBeUndefined();
    expect(update).toHaveBeenCalledTimes(1);

    stamp([row({ head: 'zzz' })]);
    expect(update).toHaveBeenCalledTimes(1);

    stamp([row({ uncommitted: 0, merged: true })]);
    expect(update).toHaveBeenCalledTimes(2);
    expect(registry.session('surf-eri' as SessionRecord['id'])?.worktreeState).toMatchObject({ uncommitted: 0, merged: true });
  });

  it('a detached worktree (no branch) is not stamped', () => {
    const { registry, stamp } = setup();
    stamp([row({ branch: null })]);
    expect(registry.session('surf-eri' as SessionRecord['id'])?.worktreeState).toBeUndefined();
  });
});
