// @vitest-environment jsdom
/**
 * Task 0ec167e4, the render: the real Sidebar shows Eridani task workspaces
 * under a target heading, each with its run chip, and leaves the others in
 * place; with grouping off it is the old flat list.
 */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { create } from 'zustand';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EridaniTaskRef, PaneId, SurfaceId, WorkspaceId, WorkspaceInfo } from '../../src/shared/types';
import type { SessionRecord } from '../../src/shared/remote-host-protocol';
import Sidebar from '../../src/renderer/components/Sidebar/Sidebar';
import { setLatestRemoteViews } from '../../src/renderer/remote-sessions/registry-cache';

const store = create(() => ({
  activeWorkspaceId: 'ws-plain' as WorkspaceId,
  agentMeta: new Map(),
  agentStates: {},
  agentDetections: {},
  agentIdentities: {},
  surfaceProgress: {},
  oscTitles: {},
  terminalPrefs: { oscTitleTabs: false },
  sidebarPrefs: { activeTabIndicator: 'leftRail', eridaniRunsExpanded: false },
  setSidebarPrefs: (prefs: Record<string, unknown>) => store.setState(state => ({ sidebarPrefs: { ...state.sidebarPrefs, ...prefs } })),
  appearancePrefs: { uiMode: 'classic' },
  workspacePrefs: { groupEridaniRuns: true, defaultShell: '' },
  shortcuts: {},
  savedLayouts: [],
  workspaces: [] as WorkspaceInfo[],
}));
vi.mock('../../src/renderer/store', () => ({ get useStore() { return store; } }));
vi.mock('../../src/renderer/i18n', async () => {
  const { makeT } = await import('../../src/renderer/i18n/core');
  return { useT: () => makeT('en') };
});
vi.mock('../../src/renderer/components/Sidebar/AgentRosterBanner', () => ({ default: () => null }));

const TASK: EridaniTaskRef = { hostId: 'desk', target: 'jarvis', taskId: 'task-1', runId: 'run-a' };

function ws(id: string, title: string, surface: string, task?: EridaniTaskRef): WorkspaceInfo {
  return {
    id: id as WorkspaceId, title, shell: 'remote:desk', pinned: false, unreadCount: 0, shellState: 'idle',
    splitTree: { type: 'leaf', paneId: `pane-${id}` as PaneId, activeSurfaceIndex: 0, surfaces: [{ id: surface as SurfaceId, type: 'terminal' }] },
    ...(task ? { eridaniTask: task } : {}),
  };
}

const workspaces = [ws('ws-plain', 'Scratch', 'surf-plain'), ws('ws-task', 'Fix login', 'surf-task', TASK)];
const record = {
  id: 'surf-task', groupId: null, cwd: '/w', createdBy: 'dev-other000', createdAt: 1, bootId: 'b', state: 'live', hiddenBy: [],
  agentState: { state: 'working', since: 1 },
  eridani: { runId: 'run-a', generation: 1, attempt: 1, taskId: 'task-1', target: 'jarvis', harness: 'claude', model: 'm', worktree: '/w', branch: 'eri/a', base: 'main', baseSha: null, spawnOp: 'op' },
} as unknown as SessionRecord;

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  setLatestRemoteViews([{ hostId: 'desk', deviceId: 'dev-me000000', connected: true, bootId: 'b', groups: [], sessions: [record], closedIds: [], lost: {} }]);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  setLatestRemoteViews(null);
  store.setState({ workspacePrefs: { groupEridaniRuns: true, defaultShell: '' }, sidebarPrefs: { activeTabIndicator: 'leftRail', eridaniRunsExpanded: false } });
});

function render(overrides: Record<string, unknown> = {}): void {
  const noop = () => {};
  act(() => root.render(React.createElement(Sidebar, {
    workspaces, activeWorkspaceId: 'ws-plain' as WorkspaceId, sidebarWidth: 260,
    onWidthChange: noop, onSelect: noop, onClose: noop, onCreate: noop, onCreateFromLayout: noop, onManageLayouts: noop,
    onRename: noop, onReorder: noop, onUpdateMetadata: noop, ...overrides,
  })));
}

describe('Sidebar with Eridani task workspaces', () => {
  it('shows the task under its target heading, with the run state chip', () => {
    render();
    const group = container.querySelector<HTMLElement>('.sidebar__task-group');
    expect(group?.dataset.target).toBe('jarvis');
    expect(group?.querySelector('.sidebar__task-group-label')?.textContent).toBe('jarvis');
    expect(group?.textContent).toContain('Fix login');
    expect(group?.querySelector('[data-kind="run"]')?.textContent).toBe('Working');
    // The plain workspace is outside the group, and has no run chip.
    const rows = [...container.querySelectorAll<HTMLElement>('[data-workspace-id]')].map((r) => r.dataset.workspaceId);
    expect(rows).toEqual(['ws-plain', 'ws-task']);
    expect(container.querySelectorAll('[data-kind="run"]')).toHaveLength(1);
  });

  it('marks disconnected activity and verification as last known without implying acceptance', () => {
    setLatestRemoteViews([{
      hostId: 'desk', deviceId: 'dev-me000000', connected: false, bootId: 'b',
      groups: [], closedIds: [], lost: {},
      sessions: [{
        ...record,
        verify: {
          attemptId: 'verify-1', state: 'passed', startedAt: 1, finishedAt: 2,
          runId: 'run-a', generation: 1, turnSeq: 1, planRevision: 1,
          verifyId: 'checks', initiator: 'eridani',
        },
      }],
    }]);
    render();
    const chip = container.querySelector<HTMLElement>('[data-kind="run"]');
    expect(chip?.textContent).toBe('Working (last known)');
    expect(chip?.classList.contains('remote-host-chip--neutral')).toBe(true);
    expect(chip?.title).toContain('verify passed (last known)');
    expect(chip?.title).toContain('Verification does not imply task acceptance');
  });

  it('grouping off keeps a flat delegated list inside the separate section', () => {
    store.setState({ workspacePrefs: { groupEridaniRuns: false, defaultShell: '' } });
    render();
    expect(container.querySelector('.sidebar__task-group')).toBeNull();
    expect([...container.querySelectorAll<HTMLElement>('.sidebar__list [data-workspace-id]')].map((r) => r.dataset.workspaceId)).toEqual(['ws-plain']);
    expect(container.querySelector('.sidebar__eridani [data-workspace-id]')?.getAttribute('data-workspace-id')).toBe('ws-task');
  });
});


it('keeps delegated work at the bottom, collapsed by default, and persists expansion through remount', () => {
  const onSelect = vi.fn(), onClose = vi.fn(), onCreate = vi.fn();
  render({ workspaces: [workspaces[1], workspaces[0]], onSelect, onClose, onCreate });
  const section = container.querySelector<HTMLElement>('.sidebar__eridani')!;
  const toggle = section.querySelector<HTMLButtonElement>('button[aria-expanded]')!;
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  expect(section.querySelector<HTMLElement>('.sidebar__eridani-list')!.hidden).toBe(true);
  expect(container.querySelector('.sidebar__list')!.textContent).toContain('Scratch');
  expect(container.querySelector('.sidebar__list')!.textContent).not.toContain('Fix login');
  expect(section.nextElementSibling?.classList.contains('sidebar__footer')).toBe(true);
  act(() => toggle.click());
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
  expect(section.querySelector<HTMLElement>('.sidebar__eridani-list')!.hidden).toBe(false);
  act(() => section.querySelector<HTMLElement>('[data-workspace-id="ws-task"]')!.click());
  expect(onSelect).toHaveBeenCalledWith('ws-task');
  expect(onClose).not.toHaveBeenCalled(); expect(onCreate).not.toHaveBeenCalled();
  act(() => root.unmount());
  root = createRoot(container);
  render();
  expect(container.querySelector('.sidebar__eridani-toggle')!.getAttribute('aria-expanded')).toBe('true');
});

it('Close others in the manual section leaves delegated work available', () => {
  const onClose = vi.fn();
  render({ workspaces: [...workspaces, ws('ws-another', 'Another manual workspace', 'surf-another')], onClose });
  act(() => container.querySelector<HTMLElement>('[data-workspace-id="ws-plain"]')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })));
  const closeOthers = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(button => button.textContent?.toLowerCase().includes('close other'));
  expect(closeOthers).toBeDefined();
  act(() => closeOthers!.click());
  expect(onClose.mock.calls).toEqual([['ws-another']]);
});
