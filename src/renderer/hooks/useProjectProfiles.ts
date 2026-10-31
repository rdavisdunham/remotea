import { useEffect, useState } from 'react';
import type { QuickLaunchProfile, WorkspaceInfo } from '../../shared/types';
import { findLeaf, getAllPaneIds } from '../store/split-utils';

/** Workspace cwd is last-reporter-wins. Never interpret an unowned host path on the desktop. */
export function desktopProjectProfileSource(workspace: WorkspaceInfo | undefined): { cwd: string; surfaceId?: string; shell: string } | null {
  if (!workspace?.cwd) return null;
  const terminals = getAllPaneIds(workspace.splitTree).flatMap((id) => findLeaf(workspace.splitTree, id)?.surfaces ?? []).filter((surface) => surface.type === 'terminal');
  const owners = terminals.filter((surface) => (surface.currentCwd || surface.cwd) === workspace.cwd);
  const isLocal = (shell: string | undefined) => !!shell && !shell.startsWith('remote:');
  const shellFor = (surface: typeof terminals[number]) => surface.shell || surface.resolvedShell || workspace.shell;
  if (owners.length) {
    if (owners.some((surface) => !isLocal(shellFor(surface)))) return null;
    return { cwd: workspace.cwd, surfaceId: owners[0].id, shell: shellFor(owners[0]) };
  }
  // Browser-only local workspaces and local terminals which have not reported
  // cwd yet retain project profiles. Mixed or unknown ownership needs a report.
  if (!isLocal(workspace.shell) || terminals.some((surface) => !isLocal(shellFor(surface)))) return null;
  return { cwd: workspace.cwd, shell: workspace.shell };
}

export function useProjectProfiles(workspace: WorkspaceInfo | undefined): QuickLaunchProfile[] {
  const source = desktopProjectProfileSource(workspace);
  const key = source ? JSON.stringify([workspace?.id, source]) : '';
  const [result, setResult] = useState<{ key: string; profiles: QuickLaunchProfile[] }>({ key: '', profiles: [] });
  useEffect(() => {
    if (!key || !window.wmux?.config?.getProjectProfiles) return;
    let cancelled = false;
    const request = JSON.parse(key)[1] as NonNullable<ReturnType<typeof desktopProjectProfileSource>>;
    window.wmux.config.getProjectProfiles(request.cwd, { surfaceId: request.surfaceId, shell: request.shell }).then(
      (profiles: QuickLaunchProfile[]) => { if (!cancelled) setResult({ key, profiles: Array.isArray(profiles) ? profiles : [] }); },
      () => { if (!cancelled) setResult({ key, profiles: [] }); },
    );
    return () => { cancelled = true; };
  }, [key]);
  return key && result.key === key ? result.profiles : [];
}
