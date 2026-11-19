import { beforeEach, describe, expect, it } from 'vitest';
import { planRemoteSync, type LocalIndex, type PlanInput } from '../../src/renderer/remote-sessions/plan';
import { useStore } from '../../src/renderer/store';
import type { RemoteRegistryView } from '../../src/shared/remote-hosts-types';
import type { SessionRecord } from '../../src/shared/remote-host-protocol';
import type { SplitNode, SurfaceRef } from '../../src/shared/types';

const ME = 'dev-me000000';

function session(id: string, extra: Partial<SessionRecord> = {}): SessionRecord {
  return { id: id as `surf-${string}`, groupId: 'grp-work', cwd: '/home/me/proj', createdBy: 'dev-other000', createdAt: 1, bootId: 'b', state: 'live', hiddenBy: [], ...extra };
}

function view(sessions: SessionRecord[], extra: Partial<RemoteRegistryView> = {}): RemoteRegistryView {
  return {
    hostId: 'desk', deviceId: ME, connected: true, bootId: 'b',
    groups: [{ id: 'grp-work', name: 'Work', color: '#ff0000', createdBy: 'dev-other000', createdAt: 1, updatedAt: 1 }],
    sessions, closedIds: [], lost: {}, ...extra,
  };
}

function input(views: RemoteRegistryView[], local: LocalIndex, extra: Partial<PlanInput> = {}): PlanInput {
  return { views, local, placer: true, elsewhere: new Set(), pendingMeta: new Set(), ...extra };
}

const emptyLocal: LocalIndex = { workspaces: [], surfaces: [] };

describe('planRemoteSync', () => {
  it('creates one workspace per unseen group, holding exactly its sessions, oldest first', () => {
    const plan = planRemoteSync(input([view([session('surf-b', { createdAt: 2 }), session('surf-a', { createdAt: 1 })])], emptyLocal));
    expect(plan).toEqual([{
      kind: 'create-workspace', hostId: 'desk', groupId: 'grp-work', title: 'Work', color: '#ff0000',
      surfaces: [
        { id: 'surf-a', shell: 'remote:desk', cwd: '/home/me/proj' },
        { id: 'surf-b', shell: 'remote:desk', cwd: '/home/me/proj' },
      ],
    }]);
  });

  it('adds to the bound workspace, in the focused pane only when that workspace is active', () => {
    const local: LocalIndex = {
      workspaces: [{ id: 'ws-1', title: 'Work', color: '#ff0000', remoteGroups: { desk: 'grp-work' }, paneIds: ['pane-1', 'pane-2'], focusedPaneId: 'pane-2', active: true }],
      surfaces: [{ id: 'surf-a', hostId: 'desk', workspaceId: 'ws-1' }],
    };
    const v = view([session('surf-a'), session('surf-new', { title: 'agent' })]);
    expect(planRemoteSync(input([v], local))).toEqual([
      { kind: 'insert', workspaceId: 'ws-1', paneId: 'pane-2', surfaces: [{ id: 'surf-new', shell: 'remote:desk', cwd: '/home/me/proj', customTitle: 'agent' }] },
    ]);
    local.workspaces[0].active = false;
    expect(planRemoteSync(input([v], local))[0]).toMatchObject({ kind: 'insert', paneId: 'pane-1' });
  });

  it('drops tabs closed elsewhere or hidden here, and never places hidden ones', () => {
    const local: LocalIndex = {
      workspaces: [{ id: 'ws-1', title: 'Work', color: '#ff0000', remoteGroups: { desk: 'grp-work' }, paneIds: ['pane-1'], active: true }],
      surfaces: [
        { id: 'surf-closed', hostId: 'desk', workspaceId: 'ws-1' },
        { id: 'surf-hidden', hostId: 'desk', workspaceId: 'ws-1' },
        { id: 'surf-ok', hostId: 'desk', workspaceId: 'ws-1' },
      ],
    };
    const v = view([session('surf-hidden', { hiddenBy: [ME] }), session('surf-ok'), session('surf-also-hidden', { hiddenBy: [ME] })], { closedIds: ['surf-closed'] });
    expect(planRemoteSync(input([v], local))).toEqual([{ kind: 'drop', surfaceIds: ['surf-closed', 'surf-hidden'] }]);
  });

  it('leaves a tab the registry does not know yet (just created here) alone', () => {
    const local: LocalIndex = {
      workspaces: [{ id: 'ws-1', title: 'W', remoteGroups: { desk: 'grp-work' }, paneIds: ['pane-1'], active: true }],
      surfaces: [{ id: 'surf-just-made', hostId: 'desk', workspaceId: 'ws-1' }],
    };
    const plan = planRemoteSync(input([view([], { groups: [{ id: 'grp-work', name: 'W', createdBy: 'x', createdAt: 1, updatedAt: 1 }] })], local));
    expect(plan).toEqual([]);
  });

  it('does nothing at all from a registry it is not connected to', () => {
    const local: LocalIndex = { workspaces: [{ id: 'ws-1', title: 'W', paneIds: ['pane-1'], active: true }], surfaces: [{ id: 'surf-x', hostId: 'desk', workspaceId: 'ws-1' }] };
    expect(planRemoteSync(input([view([session('surf-y')], { connected: false, closedIds: ['surf-x'] })], local))).toEqual([]);
  });

  it('only the placer window adds; sessions shown in another window are not added again', () => {
    const v = view([session('surf-a'), session('surf-b')]);
    expect(planRemoteSync(input([v], emptyLocal, { placer: false }))).toEqual([]);
    const plan = planRemoteSync(input([v], emptyLocal, { elsewhere: new Set(['surf-a']) }));
    expect(plan[0]).toMatchObject({ kind: 'create-workspace', surfaces: [{ id: 'surf-b' }] });
  });

  it('binds an unbound workspace to its sessions\' group and takes the shared name and colour', () => {
    const local: LocalIndex = {
      workspaces: [{ id: 'ws-1', title: 'old name', paneIds: ['pane-1'], active: true }],
      surfaces: [{ id: 'surf-a', hostId: 'desk', workspaceId: 'ws-1' }],
    };
    expect(planRemoteSync(input([view([session('surf-a')])], local))).toEqual([
      { kind: 'bind', workspaceId: 'ws-1', hostId: 'desk', groupId: 'grp-work' },
      { kind: 'workspace-meta', workspaceId: 'ws-1', title: 'Work', color: '#ff0000' },
    ]);
  });

  it('a local rename still on its way to the server is not reverted', () => {
    const local: LocalIndex = {
      workspaces: [{ id: 'ws-1', title: 'Renamed here', color: '#ff0000', remoteGroups: { desk: 'grp-work' }, paneIds: ['pane-1'], active: true }],
      surfaces: [{ id: 'surf-a', hostId: 'desk', workspaceId: 'ws-1' }],
    };
    const v = view([session('surf-a')]);
    expect(planRemoteSync(input([v], local))).toEqual([{ kind: 'workspace-meta', workspaceId: 'ws-1', title: 'Work', color: '#ff0000' }]);
    expect(planRemoteSync(input([v], local, { pendingMeta: new Set(['grp-work']) }))).toEqual([]);
  });

  it('sessions without a group land in an Inbox workspace', () => {
    const plan = planRemoteSync(input([view([session('surf-a', { groupId: null })], { groups: [] })], emptyLocal));
    expect(plan[0]).toMatchObject({ kind: 'create-workspace', groupId: 'grp-inbox', title: 'Inbox' });
  });
});

function leaf(paneId: string, ids: string[]): SplitNode {
  return { type: 'leaf', paneId: paneId as `pane-${string}`, activeSurfaceIndex: ids.length - 1, surfaces: ids.map((id) => ({ id, type: 'terminal', shell: 'remote:desk' }) as SurfaceRef) };
}

describe('store: remote surfaces', () => {
  beforeEach(() => {
    useStore.setState({ workspaces: [], activeWorkspaceId: null });
  });

  it('dropSurfacesLocal collapses emptied panes and workspaces without killing anything', () => {
    const killed: string[] = [];
    (globalThis as { window?: unknown }).window = { remotea: { pty: { kill: (id: string) => killed.push(id) } } };
    const st = useStore.getState();
    const ws1 = st.createWorkspace({ title: 'A', splitTree: { type: 'branch', direction: 'horizontal', ratio: 0.5, children: [leaf('pane-1', ['surf-1', 'surf-2']), leaf('pane-2', ['surf-3'])] } });
    const ws2 = st.createWorkspace({ title: 'B', splitTree: leaf('pane-3', ['surf-4']) });
    useStore.setState({ activeWorkspaceId: ws2 });
    useStore.getState().dropSurfacesLocal(['surf-2', 'surf-3', 'surf-4']);
    const after = useStore.getState();
    expect(after.workspaces.map((w) => w.id)).toEqual([ws1]);
    expect(after.activeWorkspaceId).toBe(ws1);
    expect(after.workspaces[0].splitTree).toMatchObject({ type: 'leaf', paneId: 'pane-1', surfaces: [{ id: 'surf-1' }], activeSurfaceIndex: 0 });
    expect(killed).toEqual([]);
    delete (globalThis as { window?: unknown }).window;
  });

  it('insertRemoteSurfaces keeps session ids, skips ones already shown, and does not change the active tab', () => {
    const st = useStore.getState();
    const ws = st.createWorkspace({ title: 'A', splitTree: leaf('pane-1', ['surf-1']) });
    useStore.getState().insertRemoteSurfaces(ws, 'pane-1' as never, [
      { id: 'surf-1' as never, shell: 'remote:desk' },
      { id: 'surf-9' as never, shell: 'remote:desk', cwd: '/x', customTitle: 'agent' },
    ]);
    const tree = useStore.getState().workspaces[0].splitTree as Extract<SplitNode, { type: 'leaf' }>;
    expect(tree.surfaces.map((s) => s.id)).toEqual(['surf-1', 'surf-9']);
    expect(tree.surfaces[1]).toMatchObject({ shell: 'remote:desk', cwd: '/x', customTitle: 'agent' });
    expect(tree.activeSurfaceIndex).toBe(0);
  });

  it('createWorkspace and replaceAllWorkspaces carry the remote group binding', () => {
    const st = useStore.getState();
    st.createWorkspace({ title: 'A', splitTree: leaf('pane-1', ['surf-1']), remoteGroups: { desk: 'grp-1' } });
    expect(useStore.getState().workspaces[0].remoteGroups).toEqual({ desk: 'grp-1' });
    useStore.getState().replaceAllWorkspaces([{ title: 'A', splitTree: leaf('pane-1', ['surf-1']), remoteGroups: { desk: 'grp-1' } }]);
    expect(useStore.getState().workspaces[0].remoteGroups).toEqual({ desk: 'grp-1' });
  });
});
