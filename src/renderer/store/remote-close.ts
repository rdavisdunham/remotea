/**
 * remotea: which tabs and workspaces stand for sessions on a remote host.
 *
 * Pure helpers shared by the close routing in the store slices and by the
 * close dialog. A tab is remote when its effective shell — its own, else the
 * workspace's, else the default — is a `remote:<host>` spec (the same rule
 * sync.ts uses to report remote tabs to main).
 */
import type { SplitNode, SurfaceRef, WorkspaceInfo } from '../../shared/types';
import { parseRemoteShellSpec } from '../../shared/remote-shell-spec';

/**
 * A close the user asked for that would end sessions on a remote host. It is
 * never carried out without the remote close dialog (see RemoteCloseDialog).
 *  - 'workspace': the workspace and every server group it is bound to — every
 *    session in those groups, on every device, including ones hidden here.
 *  - 'surfaces': just these tabs (the workspace keeps its other tabs).
 */
export interface RemoteCloseRequest {
  workspaceId: string;
  scope: 'workspace' | 'surfaces';
  /** For 'surfaces': the tabs the gesture targets (local ones included). Empty for 'workspace'. */
  surfaceIds: string[];
}

export function forEachSurface(tree: SplitNode, visit: (s: SurfaceRef, paneId: string) => void): void {
  if (tree.type === 'leaf') {
    for (const s of tree.surfaces) visit(s, tree.paneId);
    return;
  }
  forEachSurface(tree.children[0], visit);
  forEachSurface(tree.children[1], visit);
}

/** The host a terminal tab runs on, or null for a local tab / non-terminal. */
export function remoteHostOf(s: Pick<SurfaceRef, 'type' | 'shell'>, wsShell: string | undefined, defaultShell: string | undefined): string | null {
  if (s.type !== 'terminal') return null;
  return parseRemoteShellSpec(s.shell || wsShell || defaultShell)?.hostId ?? null;
}

/** Every remote tab in a workspace: surface id → host id. */
export function remoteSurfacesOf(ws: Pick<WorkspaceInfo, 'splitTree' | 'shell'>, defaultShell: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  forEachSurface(ws.splitTree, (s) => {
    const host = remoteHostOf(s, ws.shell, defaultShell);
    if (host) out.set(s.id, host);
  });
  return out;
}

/** Bound to a server group, or showing any remote tab: closing it ends work on a host. */
export function isRemoteWorkspace(ws: Pick<WorkspaceInfo, 'splitTree' | 'shell' | 'remoteGroups'>, defaultShell: string | undefined): boolean {
  if (ws.remoteGroups && Object.keys(ws.remoteGroups).length > 0) return true;
  return remoteSurfacesOf(ws, defaultShell).size > 0;
}

export function allSurfaceIds(tree: SplitNode): string[] {
  const ids: string[] = [];
  forEachSurface(tree, (s) => ids.push(s.id));
  return ids;
}
