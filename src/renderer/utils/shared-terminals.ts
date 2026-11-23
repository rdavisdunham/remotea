import type { SurfaceRef, SplitNode, WorkspaceInfo, WorkspaceId } from '../../shared/types';
import type { ChatAttention } from '../../shared/remote-host-protocol';
import type { AgentRosterEntry } from '../store/agent-rollup';

function* terminals(tree: SplitNode): Generator<SurfaceRef> {
  if (tree.type === 'leaf') {
    for (const surface of tree.surfaces) if (surface.type === 'terminal') yield surface;
  } else {
    yield* terminals(tree.children[0]);
    yield* terminals(tree.children[1]);
  }
}

/** Include every terminal tab, including shells with no agent declaration.
 * Keep raw launch specs, directories, conversation IDs and prompt payloads off the wire. */
export function sharedTerminalTabs(workspaces: readonly WorkspaceInfo[], labels: ReadonlyMap<WorkspaceId, string>,
  roster: readonly AgentRosterEntry[], attention: Record<string, ChatAttention>) {
  const agents = new Map(roster.map(a => [a.surfaceId, a]));
  return workspaces.flatMap(workspace => Array.from(terminals(workspace.splitTree), surface => {
    const agent = agents.get(surface.id);
    return {
      s: surface.id, workspaceId: workspace.id, workspaceTitle: labels.get(workspace.id) || workspace.title,
      label: surface.customTitle || surface.automaticTitle || agent?.label || surface.defaultTitle || 'Terminal',
      kind: agent?.kind ?? null, state: agent?.state ?? 'unknown', attention: attention[surface.id] ?? null,
    };
  }));
}
