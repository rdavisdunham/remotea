// @vitest-environment jsdom
/**
 * Task 2eeb1e23, Astra review A-Q3: after a start or a reconnect, what
 * happened on a host while this device was away is listed once, with
 * concrete choices, instead of being restored or dropped silently.
 */
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it } from 'vitest';
import { mergeRecoveryItems, recoveryInventory, shouldShowRecovery, unmergedWork, type RecoveryLocalSurface, type RecoveryState } from '../../src/renderer/remote-sessions/recovery';
import { noteRegistryForRecovery, resetRecoveryForTests, useRecovery } from '../../src/renderer/remote-sessions/recovery-runtime';
import RecoveryDialog, { RecoveryItemRow } from '../../src/renderer/components/RecoveryDialog';
import { useStore } from '../../src/renderer/store';
import type { EridaniBinding, SessionRecord, WorktreeStateInfo } from '../../src/shared/remote-host-protocol';
import type { RemoteRegistryView } from '../../src/shared/remote-hosts-types';

const ME = 'dev-me000000';

function session(id: string, extra: Partial<SessionRecord> = {}): SessionRecord {
  return { id: id as `surf-${string}`, groupId: 'grp-work', cwd: '/home/me/proj', createdBy: 'dev-other000', createdAt: 1, bootId: 'b', state: 'live', hiddenBy: [], ...extra };
}

function binding(patch: Partial<EridaniBinding> = {}): EridaniBinding {
  return {
    runId: 'run-a', generation: 1, attempt: 1, taskId: 'task-1', target: 'jarvis', harness: 'claude', model: 'm',
    worktree: '/w/jarvis/eri-a', branch: 'eri/a', base: 'main', baseSha: null, spawnOp: 'op-1', ...patch,
  };
}

const DIRTY: WorktreeStateInfo = { uncommitted: 2, untracked: 0, ahead: 3, merged: false, unpushed: null, baseRef: 'origin/main', at: 1 };
const CLEAN: WorktreeStateInfo = { uncommitted: 0, untracked: 0, ahead: 3, merged: true, unpushed: 0, baseRef: 'origin/main', at: 1 };

function view(sessions: SessionRecord[], extra: Partial<RemoteRegistryView> = {}): RemoteRegistryView {
  return { hostId: 'desk', deviceId: ME, connected: true, bootId: 'b', groups: [], sessions, closedIds: [], lost: {}, ...extra };
}

const tab = (id: string, extra: Partial<RecoveryLocalSurface> = {}): RecoveryLocalSurface => ({ id, hostId: 'desk', workspaceId: 'ws-1', title: id, ...extra });

function state(views: RemoteRegistryView[], local: RecoveryLocalSurface[], extra: Partial<RecoveryState> = {}): RecoveryState {
  return { views, local, awaySince: { desk: 0 }, seen: new Set(), ...extra };
}

describe('recoveryInventory', () => {
  it('lists each kind with its own choices, the do-nothing choice first', () => {
    const v = view([
      session('surf-exit', { state: 'exited', exitCode: 2, exitedAt: 500, title: 'build' }),
      session('surf-lost', { state: 'lost', agent: { provider: 'claude', sessionId: 'x', seenAt: 1 } }),
      session('surf-live'),
      session('surf-run', { state: 'exited', exitCode: 0, exitedAt: 600, title: 'Fix login', eridani: binding(), worktreeState: DIRTY }),
      session('surf-gone-run', { state: 'exited', exitCode: 0, exitedAt: 700, title: 'Add search', eridani: binding({ worktree: '/w/jarvis/eri-b', branch: 'eri/b' }), worktreeState: DIRTY }),
    ], { closedIds: ['surf-closed'] });
    const inv = recoveryInventory(state([v], [tab('surf-exit'), tab('surf-lost'), tab('surf-live'), tab('surf-run'), tab('surf-closed', { cwd: '/srv' })]));
    expect(inv.items.map((i) => [i.kind, i.surfaceId, i.choices])).toEqual([
      ['exited', 'surf-exit', ['leave', 'keep-closed', 'reopen']],
      ['restored', 'surf-lost', ['reopen', 'keep-closed']],
      ['exited', 'surf-run', ['leave', 'keep-closed', 'reopen', 'open-worktree', 'copy-branch']],
      ['closed', 'surf-closed', ['keep-closed', 'reopen']],
      // An ended run not shown here, with work left in its worktree.
      ['worktree', 'surf-gone-run', ['keep-closed', 'open-worktree', 'copy-branch']],
    ]);
    expect(inv.items[0].detail).toMatch(/^Exited with code 2 at \d\d:\d\d while this device was away\.$/);
    expect(inv.items[1].detail).toMatch(/agent resumes/);
    expect(inv.items[2]).toMatchObject({ branch: 'eri/a', worktree: '/w/jarvis/eri-a' });
    expect(inv.items[2].detail).toContain('2 uncommitted changes, not merged into origin/main (3 commits ahead)');
    expect(inv.items[3]).toMatchObject({ cwd: '/srv', workspaceId: 'ws-1' });
    expect(inv.items[4]).toMatchObject({ cwd: '/w/jarvis/eri-b', branch: 'eri/b' });
    expect(inv.onlyClean).toBe(false);
  });

  it('a clean worktree, an older exit, a hidden or a disconnected host are not listed', () => {
    const v = view([
      session('surf-old', { state: 'exited', exitedAt: 50 }),
      session('surf-clean-run', { state: 'exited', eridani: binding(), worktreeState: CLEAN }),
      session('surf-unknown-run', { state: 'exited', eridani: binding({ worktree: '/w/x' }) }),
      session('surf-hidden', { state: 'exited', exitedAt: 900, hiddenBy: [ME as SessionRecord['hiddenBy'][number]] }),
    ]);
    expect(recoveryInventory(state([v], [tab('surf-old'), tab('surf-hidden')], { awaySince: { desk: 100 } })).items).toEqual([]);
    expect(recoveryInventory(state([view([session('surf-x', { state: 'exited', exitedAt: 9 })], { connected: false })], [tab('surf-x')])).items).toEqual([]);
    // A host that did not just (re)connect: nothing.
    expect(recoveryInventory(state([view([session('surf-x', { state: 'exited', exitedAt: 9 })])], [tab('surf-x')], { awaySince: {} })).items).toEqual([]);
  });

  it('skips what was already offered, and the setting skips clean restores only', () => {
    const v = view([session('surf-lost', { state: 'lost' }), session('surf-exit', { state: 'exited', exitedAt: 5 })]);
    const all = recoveryInventory(state([v], [tab('surf-lost'), tab('surf-exit')]));
    expect(all.items).toHaveLength(2);
    const restoredOnly = recoveryInventory(state([v], [tab('surf-lost'), tab('surf-exit')], { seen: new Set([all.items[1].key]) }));
    expect(restoredOnly.items.map((i) => i.kind)).toEqual(['restored']);
    expect(restoredOnly.onlyClean).toBe(true);
    expect(shouldShowRecovery(restoredOnly, true)).toBe(false);
    expect(shouldShowRecovery(restoredOnly, false)).toBe(true);
    expect(shouldShowRecovery(all, true)).toBe(true);
    expect(shouldShowRecovery({ items: [], onlyClean: true }, false)).toBe(false);
    expect(mergeRecoveryItems(all.items.slice(0, 1), all.items).map((i) => i.key)).toEqual(all.items.map((i) => i.key));
  });

  it('describes unmerged work in words, and nothing for a clean or unknown worktree', () => {
    expect(unmergedWork({ ...CLEAN, untracked: 1, unpushed: 2 })).toBe('1 untracked file, 2 unpushed commits');
    expect(unmergedWork(CLEAN)).toBeNull();
    expect(unmergedWork(undefined)).toBeNull();
  });
});

describe('when the dialog opens (noteRegistryForRecovery)', () => {
  beforeEach(() => {
    resetRecoveryForTests();
    localStorage.clear();
    useStore.getState().setWorkspacePrefs({ recoverySkipClean: true });
  });

  it('on the first connected push (start), not again for the same thing', () => {
    const v = view([session('surf-exit', { state: 'exited', exitedAt: 5, title: 'build' })]);
    noteRegistryForRecovery([v], [tab('surf-exit')]);
    expect(useRecovery.getState().items.map((i) => i.surfaceId)).toEqual(['surf-exit']);
    resetRecoveryForTests();
    // Next app start: already offered (remembered on disk).
    noteRegistryForRecovery([v], [tab('surf-exit')]);
    expect(useRecovery.getState().items).toEqual([]);
  });

  it('what happened while connected is never offered; what happened during a drop is', () => {
    noteRegistryForRecovery([view([session('surf-a'), session('surf-b')])], [tab('surf-a'), tab('surf-b')]);
    expect(useRecovery.getState().items).toEqual([]);
    // surf-a exits while connected: seen live.
    noteRegistryForRecovery([view([session('surf-a', { state: 'exited', exitedAt: 10 }), session('surf-b')])], [tab('surf-a'), tab('surf-b')]);
    expect(useRecovery.getState().items).toEqual([]);
    // The connection drops; surf-b exits meanwhile; it comes back.
    noteRegistryForRecovery([view([session('surf-a', { state: 'exited', exitedAt: 10 }), session('surf-b')], { connected: false })], [tab('surf-a'), tab('surf-b')]);
    noteRegistryForRecovery([view([session('surf-a', { state: 'exited', exitedAt: 10 }), session('surf-b', { state: 'exited', exitedAt: 20 })])], [tab('surf-a'), tab('surf-b')]);
    expect(useRecovery.getState().items.map((i) => i.surfaceId)).toEqual(['surf-b']);
  });

  it('a server restart (new boot) with only respawning tabs: no dialog by default, one with the setting off', () => {
    noteRegistryForRecovery([view([session('surf-a')])], [tab('surf-a')]);
    noteRegistryForRecovery([view([session('surf-a', { state: 'lost' })], { bootId: 'b2' })], [tab('surf-a')]);
    expect(useRecovery.getState().items).toEqual([]);
    resetRecoveryForTests();
    localStorage.clear();
    useStore.getState().setWorkspacePrefs({ recoverySkipClean: false });
    noteRegistryForRecovery([view([session('surf-a')])], [tab('surf-a')]);
    noteRegistryForRecovery([view([session('surf-a', { state: 'lost' })], { bootId: 'b2' })], [tab('surf-a')]);
    expect(useRecovery.getState().items.map((i) => i.kind)).toEqual(['restored']);
  });
});

describe('the dialog', () => {
  beforeEach(() => resetRecoveryForTests());

  it('one row per item with its choices as buttons, the default first', () => {
    const [item] = recoveryInventory(state([view([session('surf-run', { state: 'exited', exitCode: 1, exitedAt: 9, title: 'Fix login', eridani: binding(), worktreeState: DIRTY })])], [tab('surf-run')])).items;
    const html = renderToStaticMarkup(createElement(RecoveryItemRow, { item, hostName: 'Desktop', onChoose: () => {} }));
    expect(html).toContain('Exited while away');
    expect(html).toContain('Fix login');
    expect(html).toContain('eri/a');
    expect([...html.matchAll(/data-choice="([a-z-]+)"/g)].map((m) => m[1])).toEqual(['leave', 'keep-closed', 'reopen', 'open-worktree', 'copy-branch']);
    expect(html).toContain('>Open worktree in a new terminal<');
    expect(html).toContain('>Copy branch name<');
  });

  it('renders nothing when there is nothing to decide, and the list when there is', () => {
    expect(renderToStaticMarkup(createElement(RecoveryDialog))).toBe('');
    const inv = recoveryInventory(state([view([session('surf-x', { state: 'exited', exitedAt: 3 })], { closedIds: ['surf-y'] })], [tab('surf-x'), tab('surf-y')]));
    useRecovery.setState({ items: inv.items });
    // A live root: zustand's server snapshot is the initial state, so static rendering would not see the items.
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(createElement(RecoveryDialog)));
    const html = host.innerHTML;
    act(() => root.unmount());
    host.remove();
    expect(html).toContain('While this device was away');
    expect(html).toContain('Closed elsewhere');
    expect(html.match(/class="recovery__item"/g)).toHaveLength(2);
    expect(html).toContain('>Done<');
  });
});
