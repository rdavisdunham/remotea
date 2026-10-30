// @vitest-environment jsdom
/**
 * remotea A-N2: closing a remote workspace must never end its server group
 * silently. The ordinary close gestures (sidebar ×, Ctrl+Shift+W, tab ×,
 * Ctrl+W, pane ×, Close others) park the close for the remote close dialog,
 * whatever `confirmWorkspaceClose` says; the dialog lists the host, the active
 * sessions, the ones hidden on this device and the Eridani runs; "Hide on
 * this device" never sends a server close; quitting still only detaches.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../src/renderer/store';
import { setLatestRemoteViews } from '../../src/renderer/remote-sessions/registry-cache';
import { describeHostSummary, summarizeRemoteClose } from '../../src/renderer/remote-sessions/close-summary';
import { useRemoteHosts } from '../../src/renderer/remote-sessions/status';
import RemoteCloseDialog from '../../src/renderer/components/RemoteCloseDialog';
import type { RemoteRegistryView } from '../../src/shared/remote-hosts-types';
import type { SessionRecord } from '../../src/shared/remote-host-protocol';
import type { SplitNode, SurfaceRef, WorkspaceId } from '../../src/shared/types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ME = 'dev-laptop0000';
const OTHER = 'dev-desktop000';
const GROUP = 'grp-eridani';

function session(id: string, extra: Partial<SessionRecord> = {}): SessionRecord {
  return { id: id as `surf-${string}`, groupId: GROUP, cwd: '/home/me', createdBy: OTHER, createdAt: 1, bootId: 'b', state: 'live', hiddenBy: [], ...extra };
}

const eridani = (runId: string, taskId: string | null) => ({
  runId, generation: 2, attempt: 1, taskId, target: 'wsl', harness: 'claude' as const, model: 'm',
  worktree: '/w', branch: 'b', base: 'main', baseSha: null, spawnOp: 'op-1',
});

/**
 * The group as the server has it, seen from this laptop: two tabs shown here,
 * one hidden here, one Eridani run only the desktop shows, one already
 * exited, and a session of another group that must not be counted.
 */
function registry(extra: Partial<RemoteRegistryView> = {}): RemoteRegistryView {
  return {
    hostId: 'desk', deviceId: ME, connected: true, bootId: 'b',
    groups: [{ id: GROUP, name: 'Eridani', createdBy: OTHER, createdAt: 1, updatedAt: 1 }],
    sessions: [
      session('surf-a', { createdBy: ME }),
      session('surf-b', { createdBy: ME, eridani: eridani('run-7', 'task-40f97bde') }),
      session('surf-hid', { hiddenBy: [ME] }),
      session('surf-desk', { eridani: eridani('run-9', null) }),
      session('surf-gone', { state: 'exited', exitCode: 0 }),
      session('surf-other', { groupId: 'grp-elsewhere' }),
    ],
    closedIds: [], lost: {}, ...extra,
  };
}

const term = (id: string, shell = 'remote:desk'): SurfaceRef => ({ id, type: 'terminal', shell }) as SurfaceRef;
const leaf = (paneId: string, surfaces: SurfaceRef[]): SplitNode =>
  ({ type: 'leaf', paneId: paneId as `pane-${string}`, surfaces, activeSurfaceIndex: 0 }) as SplitNode;

let calls: { groupClose: string[][]; hide: string[][]; close: string[][]; kill: Array<[string, string | undefined]> };

function installBridge(): void {
  calls = { groupClose: [], hide: [], close: [], kill: [] };
  (window as unknown as { wmux: unknown }).wmux = {
    pty: { kill: (id: string, spec?: string) => calls.kill.push([id, spec]) },
    remoteSessions: {
      groupClose: (h: string, g: string) => calls.groupClose.push([h, g]),
      hide: (h: string, s: string) => calls.hide.push([h, s]),
      close: (h: string, s: string) => calls.close.push([h, s]),
      views: () => Promise.resolve([registry()]),
    },
  };
}

/** True when anything was sent that ends a remote session. */
const serverCloseSent = () => calls.groupClose.length > 0 || calls.close.length > 0 || calls.kill.some(([, spec]) => spec?.startsWith('remote:'));

let wsId: WorkspaceId;

beforeEach(() => {
  installBridge();
  setLatestRemoteViews([registry()]);
  useStore.setState({ workspaces: [], activeWorkspaceId: null, pendingRemoteClose: [], pendingCloseWorkspaceIds: [] });
  // The shipped default: the local-close confirmation is OFF.
  useStore.getState().setWorkspacePrefs({ confirmWorkspaceClose: false, defaultShell: '' });
  wsId = useStore.getState().createWorkspace({
    title: 'Eridani',
    splitTree: { type: 'branch', direction: 'horizontal', ratio: 0.5, children: [leaf('pane-1', [term('surf-a'), term('surf-b')]), leaf('pane-2', [term('surf-loc', 'pwsh.exe')])] } as SplitNode,
    remoteGroups: { desk: GROUP },
  });
});

afterEach(() => {
  setLatestRemoteViews(null);
  delete (window as unknown as { wmux?: unknown }).wmux;
});

describe('ordinary close gestures on a remote workspace', () => {
  it('sidebar × / Ctrl+Shift+W parks the close for the dialog even with the confirm pref off', () => {
    useStore.getState().requestCloseWorkspace(wsId);
    expect(useStore.getState().workspaces.map((w) => w.id)).toEqual([wsId]);
    expect(useStore.getState().pendingRemoteClose).toEqual([{ workspaceId: wsId, scope: 'workspace', surfaceIds: [] }]);
    expect(useStore.getState().pendingCloseWorkspaceIds).toEqual([]);
    expect(serverCloseSent()).toBe(false);
  });

  it('Ctrl+W / tab × on a remote tab asks instead of ending the session', () => {
    useStore.getState().requestCloseSurface(wsId, 'pane-1' as never, 'surf-a' as never);
    expect(useStore.getState().pendingRemoteClose).toEqual([{ workspaceId: wsId, scope: 'surfaces', surfaceIds: ['surf-a'] }]);
    expect(serverCloseSent()).toBe(false);
  });

  it('closing the last tab of a remote workspace becomes a whole-workspace request, not a silent group close', () => {
    const solo = useStore.getState().createWorkspace({ title: 'Solo', splitTree: leaf('pane-9', [term('surf-z')]), remoteGroups: { desk: 'grp-solo' } });
    useStore.getState().requestCloseSurface(solo, 'pane-9' as never, 'surf-z' as never);
    expect(useStore.getState().pendingRemoteClose.at(-1)).toEqual({ workspaceId: solo, scope: 'workspace', surfaceIds: [] });
    expect(useStore.getState().workspaces.some((w) => w.id === solo)).toBe(true);
    expect(serverCloseSent()).toBe(false);
  });

  it('pane × with remote tabs, and Close others, ask too', () => {
    useStore.getState().requestClosePane(wsId, 'pane-1' as never);
    expect(useStore.getState().pendingRemoteClose[0]).toMatchObject({ scope: 'surfaces', surfaceIds: ['surf-a', 'surf-b'] });
    expect(useStore.getState().routeRemoteClose(wsId, ['surf-b'])).toBe(true);
    expect(serverCloseSent()).toBe(false);
  });

  it('a local tab in the same workspace still closes straight away', () => {
    useStore.getState().requestCloseSurface(wsId, 'pane-2' as never, 'surf-loc' as never);
    expect(useStore.getState().pendingRemoteClose).toEqual([]);
    // (closeSurface → closePane reaps the last tab of a pane twice; the kill is idempotent.)
    expect([...new Set(calls.kill.map(([id]) => id))]).toEqual(['surf-loc']);
    expect(serverCloseSent()).toBe(false);
  });

  it('a remote tab whose session already exited closes without asking', () => {
    setLatestRemoteViews([registry({ sessions: [...registry().sessions.filter((s) => s.id !== 'surf-a'), session('surf-a', { state: 'exited' })] })]);
    useStore.getState().requestCloseSurface(wsId, 'pane-1' as never, 'surf-a' as never);
    expect(useStore.getState().pendingRemoteClose).toEqual([]);
    expect(calls.kill).toEqual([['surf-a', 'remote:desk']]);
  });

  it('a purely local workspace is unchanged: closes immediately with the pref off', () => {
    const local = useStore.getState().createWorkspace({ title: 'Local', splitTree: leaf('pane-l', [term('surf-l1', 'pwsh.exe')]) });
    useStore.getState().requestCloseWorkspace(local);
    expect(useStore.getState().workspaces.some((w) => w.id === local)).toBe(false);
    expect(useStore.getState().pendingRemoteClose).toEqual([]);
  });

  it('a workspace whose remote tabs inherit the default shell counts as remote', () => {
    useStore.getState().setWorkspacePrefs({ defaultShell: 'remote:desk' });
    const inherit = useStore.getState().createWorkspace({ title: 'I', splitTree: leaf('pane-i', [{ id: 'surf-i', type: 'terminal' } as SurfaceRef]) });
    useStore.getState().requestCloseWorkspace(inherit);
    expect(useStore.getState().pendingRemoteClose.at(-1)).toMatchObject({ workspaceId: inherit, scope: 'workspace' });
  });
});

describe('the dialog answers', () => {
  it('Hide on this device never sends a server close', () => {
    useStore.getState().requestCloseWorkspace(wsId);
    useStore.getState().resolveRemoteClose('hide');
    expect(useStore.getState().workspaces).toEqual([]);
    expect(calls.hide).toEqual([['desk', 'surf-a'], ['desk', 'surf-b']]);
    expect(calls.groupClose).toEqual([]);
    expect(calls.close).toEqual([]);
    // Only the LOCAL shell is killed.
    expect(calls.kill).toEqual([['surf-loc', undefined]]);
  });

  it('hideWorkspaceOnDevice (context menu) never sends a server close either', () => {
    useStore.getState().hideWorkspaceOnDevice(wsId);
    expect(serverCloseSent()).toBe(false);
    expect(calls.hide.map(([, s]) => s)).toEqual(['surf-a', 'surf-b']);
  });

  it('Hide for a tab hides just that tab here', () => {
    useStore.getState().requestCloseSurface(wsId, 'pane-1' as never, 'surf-a' as never);
    useStore.getState().resolveRemoteClose('hide');
    expect(serverCloseSent()).toBe(false);
    expect(calls.hide).toEqual([['desk', 'surf-a']]);
    const ws = useStore.getState().workspaces[0];
    expect(JSON.stringify(ws.splitTree)).not.toContain('surf-a');
    expect(JSON.stringify(ws.splitTree)).toContain('surf-b');
  });

  it('End sessions on this host closes the server group', () => {
    useStore.getState().requestCloseWorkspace(wsId);
    useStore.getState().resolveRemoteClose('end');
    expect(calls.groupClose).toEqual([['desk', GROUP]]);
    expect(useStore.getState().workspaces).toEqual([]);
  });

  it('End for one tab closes only that session', () => {
    useStore.getState().requestCloseSurface(wsId, 'pane-1' as never, 'surf-a' as never);
    useStore.getState().resolveRemoteClose('end');
    expect(calls.groupClose).toEqual([]);
    expect(calls.kill).toEqual([['surf-a', 'remote:desk']]);
  });

  it('Cancel closes nothing', () => {
    useStore.getState().requestCloseWorkspace(wsId);
    useStore.getState().resolveRemoteClose('cancel');
    expect(useStore.getState().workspaces).toHaveLength(1);
    expect(useStore.getState().pendingRemoteClose).toEqual([]);
    expect(serverCloseSent()).toBe(false);
    expect(calls.hide).toEqual([]);
  });
});

describe('what the dialog lists', () => {
  const ws = () => useStore.getState().workspaces.find((w) => w.id === wsId)!;

  it('counts the whole group across devices: active, hidden here, and the Eridani runs', () => {
    const [h] = summarizeRemoteClose({ request: { workspaceId: wsId, scope: 'workspace', surfaceIds: [] }, workspace: ws(), views: [registry()], hostNames: { desk: 'Desktop' } });
    expect(h).toMatchObject({ hostName: 'Desktop', groupName: 'Eridani', active: 4, hiddenHere: 1, shownHere: 2, connected: true });
    expect(h.eridani).toEqual([
      { sessionId: 'surf-b', runId: 'run-7', taskId: 'task-40f97bde', generation: 2 },
      { sessionId: 'surf-desk', runId: 'run-9', taskId: null, generation: 2 },
    ]);
    const text = describeHostSummary(h).join('\n');
    expect(text).toContain('Host Desktop');
    expect(text).toContain('Active sessions: 4');
    expect(text).toContain('Hidden on this device: 1');
    expect(text).toContain('task task-40f97bde · run run-7');
    expect(text).toContain('task unknown · run run-9');
    expect(text).not.toMatch(/stale/);
  });

  it('a tab close counts just that session', () => {
    const [h] = summarizeRemoteClose({ request: { workspaceId: wsId, scope: 'surfaces', surfaceIds: ['surf-b'] }, workspace: ws(), views: [registry()] });
    expect(h).toMatchObject({ groupId: null, active: 1, hiddenHere: 0 });
    expect(h.eridani?.map((r) => r.runId)).toEqual(['run-7']);
  });

  it('offline: says the counts may be stale', () => {
    const [h] = summarizeRemoteClose({ request: { workspaceId: wsId, scope: 'workspace', surfaceIds: [] }, workspace: ws(), views: [registry({ connected: false })] });
    expect(describeHostSummary(h).join('\n')).toMatch(/may be stale/);
  });

  it('no registry at all: unknown, never a made-up zero', () => {
    const [h] = summarizeRemoteClose({ request: { workspaceId: wsId, scope: 'workspace', surfaceIds: [] }, workspace: ws(), views: null });
    const text = describeHostSummary(h).join('\n');
    expect(text).toContain('Active sessions: unknown');
    expect(text).toContain('Hidden on this device: unknown');
    expect(text).toContain('Eridani tasks/runs: unknown');
  });
});

describe('RemoteCloseDialog', () => {
  let root: Root;
  let host: HTMLDivElement;

  beforeEach(() => {
    useRemoteHosts.setState({ loaded: true, hosts: { desk: { id: 'desk', name: 'Desktop', url: 'ws://x', enabled: true, hasToken: true } }, status: {} });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it('renders for a remote workspace close with the pref off, lists counts and tasks, and Hide sends no server close', async () => {
    await act(async () => root.render(createElement(RemoteCloseDialog)));
    expect(host.textContent).toBe('');
    await act(async () => useStore.getState().requestCloseWorkspace(wsId));
    const text = host.textContent ?? '';
    expect(text).toContain('Close "Eridani"?');
    expect(text).toContain('Host Desktop, workspace "Eridani"');
    expect(text).toContain('Active sessions: 4');
    expect(text).toContain('Hidden on this device: 1');
    expect(text).toContain('task task-40f97bde');
    const buttons = [...host.querySelectorAll('button')].map((b) => b.textContent);
    expect(buttons).toEqual(['Cancel', 'Hide on this device', 'End sessions on this host']);
    // Cancel is focused: a stray Enter ends nothing.
    expect(document.activeElement?.textContent).toBe('Cancel');
    const hide = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Hide on this device')!;
    await act(async () => hide.click());
    expect(serverCloseSent()).toBe(false);
    expect(calls.hide).toHaveLength(2);
    expect(host.textContent).toBe('');
  });

  it('End sessions on this host closes the group', async () => {
    await act(async () => root.render(createElement(RemoteCloseDialog)));
    await act(async () => useStore.getState().requestCloseWorkspace(wsId));
    const end = [...host.querySelectorAll('button')].find((b) => b.textContent === 'End sessions on this host')!;
    await act(async () => end.click());
    expect(calls.groupClose).toEqual([['desk', GROUP]]);
  });
});

describe('quitting the desktop', () => {
  it('detaches remote sessions and never closes them', async () => {
    const { TerminalRouter } = await import('../../src/main/terminal-router');
    const { RemoteHosts } = await import('../../src/main/remote-hosts');
    const client = { detachNow: vi.fn(), kill: vi.fn(), intent: vi.fn() };
    // RemoteHosts.detachAllNow over a fake client map: detach only, no close / groupClose intent.
    const hosts = { clients: new Map([['desk', client]]) };
    const remote = { detachAllNow: () => RemoteHosts.prototype.detachAllNow.call(hosts as never) };
    const local = { killAll: vi.fn() };
    new TerminalRouter(local as never, remote as never).killAll();
    expect(local.killAll).toHaveBeenCalled();
    expect(client.detachNow).toHaveBeenCalled();
    expect(client.kill).not.toHaveBeenCalled();
    expect(client.intent).not.toHaveBeenCalled();
  });
});
