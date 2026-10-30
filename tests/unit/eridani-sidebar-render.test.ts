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
  sidebarPrefs: { activeTabIndicator: 'leftRail' },
  appearancePrefs: { uiMode: 'classic' },
  workspacePrefs: { groupEridaniRuns: true, defaultShell: '' },
  shortcuts: {},
  savedLayouts: [],
  workspaces: [] as WorkspaceInfo[],
}));
vi.mock('../../src/renderer/store', () => ({ get useStore() { return store; } }));
vi.mock('../../src/renderer/i18n', () => ({ useT: () => (_key: string, fallback: string) => fallback }));
vi.mock('../../src/renderer/components/Sidebar/OrchestrationPanel', () => ({ default: () => null }));
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
  store.setState({ workspacePrefs: { groupEridaniRuns: true, defaultShell: '' } });
});

function render(): void {
  const noop = () => {};
  act(() => root.render(React.createElement(Sidebar, {
    workspaces, activeWorkspaceId: 'ws-plain' as WorkspaceId, sidebarWidth: 260,
    onWidthChange: noop, onSelect: noop, onClose: noop, onCreate: noop, onCreateFromLayout: noop, onManageLayouts: noop,
    onRename: noop, onReorder: noop, onUpdateMetadata: noop,
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

  it('grouping off: no heading, a flat list', () => {
    store.setState({ workspacePrefs: { groupEridaniRuns: false, defaultShell: '' } });
    render();
    expect(container.querySelector('.sidebar__task-group')).toBeNull();
    expect([...container.querySelectorAll<HTMLElement>('[data-workspace-id]')].map((r) => r.dataset.workspaceId)).toEqual(['ws-plain', 'ws-task']);
  });
});
