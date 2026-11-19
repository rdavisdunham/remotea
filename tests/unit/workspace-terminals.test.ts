// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WorkspaceRow from '../../src/renderer/components/Sidebar/WorkspaceRow';
import { useStore } from '../../src/renderer/store';
import { setLatestRemoteViews } from '../../src/renderer/remote-sessions/registry-cache';
import { useLocalChatAttention } from '../../src/renderer/remote-sessions/chat-attention';
import { FOCUS_SURFACE_EVENT } from '../../src/renderer/components/Git/open-git';
import type { RemoteRegistryView } from '../../src/shared/remote-hosts-types';
import type { PaneId, SurfaceId, WorkspaceId } from '../../src/shared/types';
import { DEFAULT_SIDEBAR_PREFS } from '../../src/renderer/store/settings-slice';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
let container: HTMLDivElement;
let workspaceId: WorkspaceId;
const onSelect = vi.fn();
const chatAttention = vi.fn();

function view(): RemoteRegistryView {
  return { hostId: 'desk', deviceId: 'device-me', bootId: 'b', connected: true, groups: [], closedIds: [], lost: {},
    sessions: ['surf-working', 'surf-waiting', 'surf-shell'].map((id, index) => ({
      id: id as `surf-${string}`, groupId: 'grp-test', cwd: '/repo', createdBy: 'device-me', createdAt: 1,
      bootId: 'b', state: 'live', hiddenBy: [],
      ...(index < 2 ? { agentState: { state: index === 0 ? 'working' as const : 'needs_you' as const, since: 1 } } : {}),
    })) };
}

function render(options: Partial<React.ComponentProps<typeof WorkspaceRow>> = {}) {
  const workspace = useStore.getState().workspaces.find(w => w.id === workspaceId)!;
  act(() => root.render(React.createElement(WorkspaceRow, { workspace, isActive: false, onSelect, onClose: () => {}, ...options })));
}
function toggle() {
  act(() => container.querySelector<HTMLButtonElement>('.workspace-row__terminal-toggle')!.click());
}
function terminal(id: string) {
  return container.querySelector<HTMLButtonElement>(`.workspace-terminal[data-surface-id='${id}']`)!;
}

beforeEach(() => {
  vi.useFakeTimers();
  onSelect.mockReset();
  chatAttention.mockReset().mockResolvedValue({ ok: true });
  window.remotea = { remoteSessions: { chatAttention } } as unknown as typeof window.remotea;
  useStore.setState({ workspaces: [], activeWorkspaceId: null, agentStates: {}, agentDetections: {}, agentIdentities: {}, agentMeta: new Map(), oscTitles: {}, sidebarPrefs: { ...DEFAULT_SIDEBAR_PREFS } });
  useLocalChatAttention.setState({ entries: {} });
  workspaceId = useStore.getState().createWorkspace({ title: 'Project', shell: 'remote:desk', splitTree: {
    type: 'branch', direction: 'horizontal', ratio: .5, children: [
      { type: 'leaf', paneId: 'pane-left' as PaneId, activeSurfaceIndex: 0, surfaces: [
        { id: 'surf-working' as SurfaceId, type: 'terminal', customTitle: 'API fix' },
        { id: 'surf-waiting' as SurfaceId, type: 'terminal', customTitle: 'Login fix' },
        { id: 'surf-browser' as SurfaceId, type: 'browser' },
      ] },
      { type: 'leaf', paneId: 'pane-right' as PaneId, activeSurfaceIndex: 0,
        surfaces: [{ id: 'surf-shell' as SurfaceId, type: 'terminal', customTitle: 'Shell' }] },
    ],
  } });
  setLatestRemoteViews([view()]);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount()); container.remove();
  setLatestRemoteViews(null); vi.clearAllTimers(); vi.useRealTimers();
});

describe('workspace terminal dropdown', () => {
  it('previews an unread finished terminal ahead of more recent working activity', () => {
    const snapshot = view();
    snapshot.sessions[0].lastActivityAt = 300;
    snapshot.sessions[1].agentState = { state: 'idle', since: 100 };
    snapshot.sessions[1].chatAttention = { revision: 3, at: 100, kind: 'finished', seenBy: {} };
    setLatestRemoteViews([snapshot]);
    render();
    expect(container.querySelectorAll('.workspace-terminal')).toHaveLength(1);
    expect(terminal('surf-waiting').textContent).toContain('Login fixFinished · unread');
    expect(container.querySelector('.workspace-row__status')).toBeNull();
    expect(chatAttention).not.toHaveBeenCalled();
    toggle();
    expect([...container.querySelectorAll('.workspace-terminal')].map(row => row.getAttribute('data-surface-id')))
      .toEqual(['surf-working', 'surf-waiting', 'surf-shell']);
    expect(container.querySelectorAll('.workspace-row__session')).toHaveLength(0);
  });

  it('chooses the latest actionable terminal and advances after its read receipt arrives', async () => {
    const snapshot = view();
    snapshot.sessions[0].lastActivityAt = 500;
    snapshot.sessions[0].chatAttention = { revision: 2, at: 200, kind: 'finished', seenBy: {} };
    snapshot.sessions[0].agentState = { state: 'idle', since: 200 };
    snapshot.sessions[1].lastActivityAt = 600;
    snapshot.sessions[1].chatAttention = { revision: 3, at: 300, kind: 'finished', seenBy: {} };
    snapshot.sessions[1].agentState = { state: 'idle', since: 300 };
    setLatestRemoteViews([snapshot]);
    render();
    expect(container.querySelector('.workspace-terminal')?.getAttribute('data-surface-id')).toBe('surf-waiting');
    const focus = vi.fn();
    document.addEventListener(FOCUS_SURFACE_EVENT, focus);
    try {
      await act(async () => terminal('surf-waiting').click());
      expect(chatAttention).toHaveBeenCalledExactlyOnceWith('desk', 'surf-waiting', { action: 'read', revision: 3 });
      expect((focus.mock.calls[0][0] as CustomEvent).detail).toEqual({ workspaceId, surfaceId: 'surf-waiting' });
      expect(container.querySelector('.workspace-terminal')?.getAttribute('data-surface-id')).toBe('surf-waiting');
      const acknowledged = structuredClone(snapshot);
      acknowledged.sessions[1].chatAttention!.seenBy['device-me'] = 3;
      act(() => setLatestRemoteViews([acknowledged]));
      expect(container.querySelector('.workspace-terminal')?.getAttribute('data-surface-id')).toBe('surf-working');
    } finally {
      document.removeEventListener(FOCUS_SURFACE_EVENT, focus);
    }
  });

  it('falls back to latest activity and uses tree order for ties', () => {
    const snapshot = view();
    snapshot.sessions[1].agentState = { state: 'idle', since: 1 };
    snapshot.sessions[0].lastActivityAt = 100;
    snapshot.sessions[2].lastActivityAt = 200;
    setLatestRemoteViews([snapshot]);
    render();
    expect(container.querySelector('.workspace-terminal')?.getAttribute('data-surface-id')).toBe('surf-shell');
    const tied = structuredClone(snapshot);
    tied.sessions[0].lastActivityAt = 200;
    act(() => setLatestRemoteViews([tied]));
    expect(container.querySelector('.workspace-terminal')?.getAttribute('data-surface-id')).toBe('surf-working');
  });

  it('keeps waiting terminals actionable after they have been read and identifies offline context', () => {
    const snapshot = view();
    snapshot.sessions[0].lastActivityAt = 300;
    snapshot.sessions[1].chatAttention = { revision: 2, at: 100, kind: 'needs_you', seenBy: { 'device-me': 2 } };
    snapshot.connected = false;
    setLatestRemoteViews([snapshot]);
    render();
    expect(terminal('surf-waiting').textContent).toContain('Login fixNeeds you · offline');
    expect(terminal('surf-waiting').querySelector('.workspace-terminal__unread')).toBeNull();
  });

  it('uses canonical custom and generated names in both collapsed and expanded readouts', () => {
    act(() => useStore.getState().updateSurface(workspaceId, 'pane-left' as PaneId, 'surf-waiting' as SurfaceId, {
      customTitle: undefined, automaticTitle: 'Generated login fix', currentCwd: '/fixture/folder',
    }));
    render();
    expect(terminal('surf-waiting').textContent).toContain('Generated login fix');
    expect(terminal('surf-waiting').textContent).not.toContain('/fixture/folder');
    toggle();
    expect(terminal('surf-waiting').textContent).toContain('Generated login fix');
    act(() => useStore.getState().renameSurface(workspaceId, 'pane-left' as PaneId, 'surf-waiting' as SurfaceId, 'Chosen login name'));
    render();
    expect(terminal('surf-waiting').textContent).toContain('Chosen login name');
    expect(terminal('surf-waiting').textContent).not.toContain('Generated login fix');
  });

  it('keeps branch and directory context in tooltips and respects the sidebar detail settings', () => {
    render({ workspace: { ...useStore.getState().workspaces.find(item => item.id === workspaceId)!, cwd: '/fixture/project', gitBranch: 'feature/fixture', gitDirty: true } });
    expect(container.querySelector('.workspace-row__context')).toBeNull();
    expect(container.querySelector('.workspace-row__title')?.getAttribute('title')).toContain('feature/fixture*');
    expect(container.querySelector('.workspace-row__title')?.getAttribute('title')).toContain('/fixture/project');
    act(() => useStore.getState().setSidebarPrefs({ hideAllDetails: true }));
    expect(container.querySelector('.workspace-row__title')?.getAttribute('title')).toBe('Project');
  });

  it('keeps declared answer buttons with the matching terminal in the expanded list', async () => {
    const answer = vi.fn().mockResolvedValue({ ok: true });
    window.remotea.agentState = { answer } as typeof window.remotea.agentState;
    const declared = { 'surf-waiting': { state: 'blocked', blockedReason: 'Fixture approval', choices: [{ id: 'allow', label: 'Allow fixture' }] } };
    render({ agentStates: declared });
    expect(container.querySelector('.workspace-row__answer')).toBeNull();
    toggle();
    const row = terminal('surf-waiting').closest('.workspace-terminal-entry')!;
    const choice = row.querySelector<HTMLButtonElement>('.workspace-row__answer')!;
    expect(choice.textContent).toBe('Allow fixture');
    await act(async () => choice.click());
    expect(answer).toHaveBeenCalledExactlyOnceWith('surf-waiting', 'allow');
    expect(chatAttention).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('opens the exact inactive terminal when a sidebar answer needs recovery', async () => {
    const answer = vi.fn().mockResolvedValue({ ok: false });
    window.remotea.agentState = { answer } as typeof window.remotea.agentState;
    const focusPane = vi.fn();
    render({ agentStates: { 'surf-waiting': { state: 'blocked', choices: [{ id: 'allow', label: 'Allow fixture' }] } }, onFocusAgentPane: focusPane });
    toggle();
    const focus = vi.fn();
    document.addEventListener(FOCUS_SURFACE_EVENT, focus);
    try {
      await act(async () => container.querySelector<HTMLButtonElement>('.workspace-row__answer')!.click());
      expect((focus.mock.calls[0][0] as CustomEvent).detail).toEqual({ workspaceId, surfaceId: 'surf-waiting' });
      expect(focusPane).toHaveBeenCalledExactlyOnceWith('pane-left');
    } finally {
      document.removeEventListener(FOCUS_SURFACE_EVENT, focus);
    }
  });

  it('shows concise generated work separately from observed activity and marks stale evidence', () => {
    const snapshot = view();
    snapshot.sessions[0].tea = { title: 'Generated work', summary: 'Repairing login settings.', source: 'claude:chat', version: 'v1', sourceAt: 1, generatedAt: 2 };
    snapshot.sessions[0].teaSourceVersion = 'v2';
    setLatestRemoteViews([snapshot]);
    render(); toggle();
    expect(terminal('surf-working').querySelector('.workspace-terminal__summary')?.textContent).toBe('Repairing login settings. · recent activity');
    expect(terminal('surf-working').textContent).toContain('API fix');
    expect(terminal('surf-working').textContent).toContain('Working on it');
  });

  it('starts collapsed and includes every terminal and its live state when expanded', () => {
    render();
    const button = container.querySelector<HTMLButtonElement>('.workspace-row__terminal-toggle')!;
    expect(button.getAttribute('aria-label')).toBe('Show terminals (3)');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('.workspace-terminals')).toBeNull();
    toggle();
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelectorAll('.workspace-terminal')).toHaveLength(3);
    expect(terminal('surf-working').textContent).toContain('API fixWorking on it…');
    expect(terminal('surf-waiting').textContent).toContain('Login fixNeeds you');
    expect(terminal('surf-shell').textContent).toContain('ShellNo harness detected');
    expect(container.querySelector(".workspace-terminal[data-surface-id='surf-browser']")).toBeNull();
    expect(onSelect).not.toHaveBeenCalled();
    expect(chatAttention).not.toHaveBeenCalled();
    toggle();
    expect(container.querySelector('.workspace-terminals')).toBeNull();
  });

  it('targets an inactive tab exactly and only acknowledges the clicked terminal', async () => {
    const snapshot = view();
    snapshot.sessions[1].chatAttention = { revision: 5, at: 1, kind: 'needs_you', seenBy: {} };
    snapshot.sessions[0].chatAttention = { revision: 6, at: 1, kind: 'unread', seenBy: {} };
    setLatestRemoteViews([snapshot]);
    render(); toggle();
    expect(chatAttention).not.toHaveBeenCalled();
    const focus = vi.fn(); document.addEventListener(FOCUS_SURFACE_EVENT, focus);
    try {
      await act(async () => terminal('surf-waiting').click());
      expect(focus).toHaveBeenCalledTimes(1);
      expect((focus.mock.calls[0][0] as CustomEvent).detail).toEqual({ workspaceId, surfaceId: 'surf-waiting' });
      expect(chatAttention).toHaveBeenCalledExactlyOnceWith('desk', 'surf-waiting', { action: 'read', revision: 5 });
      expect(onSelect).not.toHaveBeenCalled();
    } finally { document.removeEventListener(FOCUS_SURFACE_EVENT, focus); }
  });

  it('updates completion, unread and connection states while expanded', () => {
    render(); toggle();
    const finished = view();
    finished.sessions[0].agentState = { state: 'idle', since: Date.now() };
    finished.sessions[0].chatAttention = { revision: 1, at: Date.now(), kind: 'finished', seenBy: {} };
    act(() => setLatestRemoteViews([finished]));
    expect(terminal('surf-working').getAttribute('data-tone')).toBe('ready');
    act(() => vi.advanceTimersByTime(4_001));
    expect(terminal('surf-working').getAttribute('data-tone')).toBe('attention');
    expect(terminal('surf-working').textContent).toContain('Finished · unread');
    act(() => setLatestRemoteViews([{ ...finished, connected: false }]));
    expect(terminal('surf-working').textContent).toContain('offline');
    finished.sessions[2].state = 'exited';
    act(() => setLatestRemoteViews([finished]));
    expect(terminal('surf-shell').textContent).toContain('Session ended');
  });

  it('uses the tab’s chosen name and live program title, and handles workspaces without terminals', () => {
    render(); toggle();
    useStore.getState().renameSurface(workspaceId, 'pane-right' as PaneId, 'surf-shell' as SurfaceId, 'Deploy shell');
    render();
    expect(terminal('surf-shell').querySelector('.workspace-terminal__name')?.textContent).toBe('Deploy shell');
    act(() => {
      useStore.getState().renameSurface(workspaceId, 'pane-right' as PaneId, 'surf-shell' as SurfaceId, '');
      useStore.getState().setTerminalPrefs({ oscTitleTabs: true });
      useStore.getState().setOscTitle('surf-shell', 'Live shell title');
    });
    render();
    expect(terminal('surf-shell').querySelector('.workspace-terminal__name')?.textContent).toBe('Live shell title');
    const empty = useStore.getState().createWorkspace({ title: 'Browser', splitTree: { type: 'leaf', paneId: 'pane-browser' as PaneId,
      activeSurfaceIndex: 0, surfaces: [{ id: 'surf-browser' as SurfaceId, type: 'browser' }] } });
    workspaceId = empty; render();
    expect(container.querySelector('.workspace-row__terminal-toggle')).toBeNull();
  });
});
