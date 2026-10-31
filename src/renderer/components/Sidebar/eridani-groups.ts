/**
 * remotea (task 0ec167e4): the sidebar groups the workspaces sync made for
 * Eridani tasks (`WorkspaceInfo.eridaniTask`) under their execution target —
 * the repo the runs work in — with each task workspace labelled by its task
 * title and showing the run's state. Every other workspace stays exactly
 * where the user put it.
 *
 * Pure, so it can be tested without a window.
 */
import type { EridaniTaskRef, SplitNode } from '../../../shared/types';
import type { RemoteRegistryView } from '../../../shared/remote-hosts-types';
import type { SessionRecord } from '../../../shared/remote-host-protocol';
import { runHealth, type RunHealth } from '../../remote-sessions/host-health';

export interface GroupableWorkspace {
  id: string;
  eridaniTask?: EridaniTaskRef;
}

export type SidebarItem<W extends GroupableWorkspace> =
  | { kind: 'workspace'; workspace: W }
  | { kind: 'target'; key: string; hostId: string; target: string; label: string; workspaces: W[] };

/**
 * The sidebar's list: ordinary workspaces in their order, and one target
 * section per (host, target) holding its task workspaces, placed where the
 * first of them sits (so reordering still moves a section). With grouping
 * off, every workspace is its own item.
 */
export function groupSidebarWorkspaces<W extends GroupableWorkspace>(workspaces: W[], enabled: boolean): SidebarItem<W>[] {
  if (!enabled) return workspaces.map((workspace) => ({ kind: 'workspace', workspace }));
  const sections = new Map<string, Extract<SidebarItem<W>, { kind: 'target' }>>();
  const hosts = new Set(workspaces.filter((w) => w.eridaniTask).map((w) => w.eridaniTask!.hostId));
  const out: SidebarItem<W>[] = [];
  for (const w of workspaces) {
    const task = w.eridaniTask;
    if (!task) {
      out.push({ kind: 'workspace', workspace: w });
      continue;
    }
    const key = `${task.hostId}\u0000${task.target}`;
    let section = sections.get(key);
    if (!section) {
      section = { kind: 'target', key, hostId: task.hostId, target: task.target, label: hosts.size > 1 ? `${task.target} · ${task.hostId}` : task.target, workspaces: [] };
      sections.set(key, section);
      out.push(section);
    }
    section.workspaces.push(w);
  }
  return out;
}

function surfaceIds(tree: SplitNode, out: string[] = []): string[] {
  if (tree.type === 'leaf') {
    for (const s of tree.surfaces) out.push(s.id);
    return out;
  }
  surfaceIds(tree.children[0], out);
  surfaceIds(tree.children[1], out);
  return out;
}

/**
 * The state of the task's current run, from the registry: of the sessions in
 * this workspace that Eridani started, the newest (latest generation, then
 * attempt, then creation). null when the registry has none of them.
 */
export function taskRunHealth(workspace: { splitTree: SplitNode; eridaniTask?: EridaniTaskRef }, views: RemoteRegistryView[] | null | undefined): RunHealth | null {
  const task = workspace.eridaniTask;
  if (!task) return null;
  const view = views?.find((v) => v.hostId === task.hostId);
  if (!view) return null;
  const ids = new Set(surfaceIds(workspace.splitTree));
  const newer = (a: SessionRecord, b: SessionRecord) =>
    a.eridani!.generation - b.eridani!.generation || a.eridani!.attempt - b.eridani!.attempt || a.createdAt - b.createdAt;
  let best: SessionRecord | undefined;
  for (const s of view.sessions) {
    if (ids.has(s.id) && s.eridani && (!best || newer(s, best) > 0)) best = s;
  }
  return best ? runHealth(best, view.connected) : null;
}
