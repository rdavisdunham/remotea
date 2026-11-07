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

function render() {
  const workspace = useStore.getState().workspaces.find(w => w.id === workspaceId)!;
  act(() => root.render(React.createElement(WorkspaceRow, { workspace, isActive: false, onSelect, onClose: () => {} })));
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
  window.wmux = { remoteSessions: { chatAttention } } as unknown as typeof window.wmux;
  useStore.setState({ workspaces: [], activeWorkspaceId: null, agentStates: {}, agentDetections: {}, agentIdentities: {}, agentMeta: new Map(), oscTitles: {} });
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
  it('shows concise generated work separately from observed activity and marks stale evidence', () => {
    const snapshot = view();
    snapshot.sessions[0].tea = { title: 'Generated work', summary: 'Repairing login settings.', source: 'claude:chat', version: 'v1', sourceAt: 1, generatedAt: 2 };
    snapshot.sessions[0].teaSourceVersion = 'v2';
    setLatestRemoteViews([snapshot]);
    render(); toggle();
    expect(terminal('surf-working').querySelector('.workspace-terminal__summary')?.textContent).toBe('Repairing login settings. · updating');
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
    expect(terminal('surf-working').textContent).toContain('Unread · check this chat');
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
