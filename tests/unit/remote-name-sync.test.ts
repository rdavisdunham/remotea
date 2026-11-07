// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RegistryPayload, RemoteRegistryView } from '../../src/shared/remote-hosts-types';
import type { PaneId, SurfaceId, WorkspaceId } from '../../src/shared/types';
import { metadataKey, taskMetadataGroup } from '../../src/renderer/remote-sessions/plan';

let workspaceId: WorkspaceId;
const paneId = 'pane-test' as PaneId;
const surfaceId = 'surf-test' as SurfaceId;
let useStore: typeof import('../../src/renderer/store')['useStore'];
let push: (payload: RegistryPayload) => void;
const groupUpsert = vi.fn();
const sessionUpdate = vi.fn();

function view(extra: Partial<RemoteRegistryView> = {}): RemoteRegistryView {
  return {
    hostId: 'desk', deviceId: 'dev-aaaaaaaa', connected: true, bootId: 'boot-1',
    groups: [{ id: 'grp-test', name: 'Work', createdBy: 'dev-aaaaaaaa', createdAt: 1, updatedAt: 1 }],
    sessions: [{ id: 'surf-test', groupId: 'grp-test', title: 'Original', titleUpdatedAt: 1,
      cwd: '/tmp', createdBy: 'dev-aaaaaaaa', createdAt: 1, bootId: 'boot-1', state: 'live', hiddenBy: [] }],
    closedIds: [], lost: {}, ...extra,
  };
}

async function receive(v: RemoteRegistryView) {
  push({ views: [v], placer: true, elsewhere: [] });
  await Promise.resolve();
}

function names() {
  const workspace = useStore.getState().workspaces.find(w => w.id === workspaceId)!;
  if (workspace.splitTree.type !== 'leaf') throw new Error('Expected a leaf');
  return { workspace: workspace.title, terminal: workspace.splitTree.surfaces[0]?.customTitle };
}

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  groupUpsert.mockClear();
  sessionUpdate.mockClear();
  (window as unknown as { wmux: unknown }).wmux = { remoteSessions: {
    onRegistry: (callback: typeof push) => { push = callback; return () => {}; },
    report: vi.fn(), groupUpsert, sessionUpdate,
  } };
  ({ useStore } = await import('../../src/renderer/store'));
  useStore.setState({ workspaces: [], activeWorkspaceId: null });
  workspaceId = useStore.getState().createWorkspace({ title: 'Work', titleIsDefault: false,
    remoteGroups: { desk: 'grp-test' }, shell: 'remote:desk',
    splitTree: { type: 'leaf', paneId, activeSurfaceIndex: 0,
      surfaces: [{ id: surfaceId, type: 'terminal', customTitle: 'Original' }] } });
  (await import('../../src/renderer/remote-sessions/sync')).markRemoteLayoutReady();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  delete (window as unknown as { wmux?: unknown }).wmux;
});

describe('shared workspace and terminal names through renderer sync', () => {
  it('syncs generated names without converting them to manual renames', async () => {
    const remote = view();
    remote.sessions[0].tea = { title: 'Generated login work', summary: 'Investigating login.', source: 'claude:chat', version: 'v1', sourceAt: 1, generatedAt: 2 };
    await receive(remote);
    const workspace = useStore.getState().workspaces.find(item => item.id === workspaceId)!;
    if (workspace.splitTree.type !== 'leaf') throw new Error('Expected a leaf');
    expect(workspace.splitTree.surfaces[0].automaticTitle).toBe('Generated login work');
    expect(names().terminal).toBe('Original');
    expect(sessionUpdate).not.toHaveBeenCalled();
    remote.sessions[0].agent = { provider: 'claude', sessionId: 'replacement', seenAt: 3 };
    await receive(remote);
    const updated = useStore.getState().workspaces.find(item => item.id === workspaceId)!;
    if (updated.splitTree.type !== 'leaf') throw new Error('Expected a leaf');
    expect(updated.splitTree.surfaces[0].automaticTitle).toBeUndefined();
    expect(names().terminal).toBe('Original');
    expect(sessionUpdate).not.toHaveBeenCalled();
  });

  it('sends user renames, receives another app’s renames without echo, and supports clearing a name', async () => {
    await receive(view());
    useStore.getState().renameWorkspace(workspaceId, 'abc');
    useStore.getState().renameSurface(workspaceId, paneId, surfaceId, 'andi fix');
    expect(groupUpsert).toHaveBeenLastCalledWith('desk', { id: 'grp-test', name: 'abc', color: undefined });
    expect(sessionUpdate).toHaveBeenLastCalledWith('desk', surfaceId, { title: 'andi fix' });
    const confirmed = view();
    confirmed.groups[0].name = 'abc';
    confirmed.sessions[0] = { ...confirmed.sessions[0], title: 'andi fix', titleUpdatedAt: 2 };
    await receive(confirmed);
    groupUpsert.mockClear(); sessionUpdate.mockClear();
    const remote = structuredClone(confirmed);
    remote.groups[0].name = 'Changed elsewhere';
    remote.sessions[0] = { ...remote.sessions[0], title: 'New name', titleUpdatedAt: 3 };
    await receive(remote);
    expect(names()).toEqual({ workspace: 'Changed elsewhere', terminal: 'New name' });
    expect(groupUpsert).not.toHaveBeenCalled();
    expect(sessionUpdate).not.toHaveBeenCalled();
    useStore.getState().renameSurface(workspaceId, paneId, surfaceId, '');
    expect(sessionUpdate).toHaveBeenLastCalledWith('desk', surfaceId, { title: null });
    remote.sessions[0] = { ...remote.sessions[0], title: undefined, titleUpdatedAt: 4 };
    await receive(remote);
    expect(names().terminal).toBeUndefined();
  });

  it('settles a competing server rename after the IPC handoff without needing another registry push', async () => {
    await receive(view());
    useStore.getState().renameWorkspace(workspaceId, 'First edit');
    useStore.getState().renameSurface(workspaceId, paneId, surfaceId, 'First terminal edit');
    const newer = view();
    newer.groups[0].name = 'Last server edit';
    newer.sessions[0] = { ...newer.sessions[0], title: 'Last terminal edit', titleUpdatedAt: 3 };
    await receive(newer);
    vi.advanceTimersByTime(8_001);
    await Promise.resolve();
    expect(names()).toEqual({ workspace: 'Last server edit', terminal: 'Last terminal edit' });
    expect(groupUpsert).toHaveBeenCalledTimes(1);
    expect(sessionUpdate).toHaveBeenCalledTimes(1);
  });

  it('keeps durable offline edits over a stale welcome after the renderer handoff expires', async () => {
    await receive(view());
    useStore.getState().renameWorkspace(workspaceId, 'Offline workspace');
    useStore.getState().renameSurface(workspaceId, paneId, surfaceId, 'Offline terminal');
    await receive(view({ connected: false }));
    vi.advanceTimersByTime(30_000);
    await receive(view({ pendingGroups: { 'grp-test': { name: 'Offline workspace' } },
      pendingTitles: { 'surf-test': 'Offline terminal' } }));
    expect(names()).toEqual({ workspace: 'Offline workspace', terminal: 'Offline terminal' });
    expect(groupUpsert).toHaveBeenCalledTimes(1);
    expect(sessionUpdate).toHaveBeenCalledTimes(1);
  });

  it('defers a terminal rename until its initial server open completes', async () => {
    await receive(view({ sessions: [] }));
    useStore.getState().renameSurface(workspaceId, paneId, surfaceId, 'Before first open');
    expect(sessionUpdate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(30_000);
    await receive(view());
    expect(sessionUpdate).toHaveBeenLastCalledWith('desk', surfaceId, { title: 'Before first open' });
    expect(names().terminal).toBe('Before first open');
  });

  it('imports old local-only terminal names once, then respects a server rename or reset', async () => {
    const legacy = view();
    legacy.sessions[0] = { ...legacy.sessions[0], title: undefined, titleUpdatedAt: undefined };
    await receive(legacy);
    expect(sessionUpdate).toHaveBeenLastCalledWith('desk', surfaceId, { title: 'Original' });
    const canonical = view();
    await receive(canonical); // confirms the migration
    sessionUpdate.mockClear();
    canonical.sessions[0] = { ...canonical.sessions[0], title: undefined, titleUpdatedAt: 10 };
    await receive(canonical);
    expect(names().terminal).toBeUndefined();
    expect(sessionUpdate).not.toHaveBeenCalled();
  });

  it('shares task workspace labels without binding their lifecycle to the host-wide Eridani group', async () => {
    const task = { hostId: 'desk', target: 'eri', taskId: 'task-1', runId: 'run-1' };
    useStore.getState().updateWorkspaceMetadata(workspaceId, { eridaniTask: task, remoteGroups: undefined });
    const taskView = view();
    taskView.sessions[0].eridani = { ...task, generation: 1, attempt: 1, harness: 'codex', model: 'test', branch: 'task/test', worktree: '/tmp', base: 'main', baseSha: null, spawnOp: 'op-1' };
    await receive(taskView);
    useStore.getState().renameWorkspace(workspaceId, 'My task');
    const groupId = taskMetadataGroup(task);
    expect(groupUpsert).toHaveBeenLastCalledWith('desk', { id: groupId, name: 'My task', color: undefined });
    expect(useStore.getState().workspaces[0].remoteGroups).toBeUndefined();
    taskView.groups.push({ ...taskView.groups[0], id: groupId as `grp-${string}`, name: 'My task' });
    await receive(taskView);
    groupUpsert.mockClear();
    taskView.groups[1].name = 'Task renamed elsewhere';
    await receive(taskView);
    expect(names().workspace).toBe('Task renamed elsewhere');
    expect(groupUpsert).not.toHaveBeenCalled();
    expect(taskMetadataGroup({ ...task, runId: 'another-run' })).toBe(groupId);
    expect(metadataKey('desk', groupId)).not.toBe(metadataKey('laptop', groupId));
  });
});
