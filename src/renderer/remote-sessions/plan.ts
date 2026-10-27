/**
 * remotea: what this window must change so its layout agrees with the
 * remote session registries — computed purely, applied by sync.ts.
 *
 * The registry decides WHAT exists (sessions, and the workspace group each
 * belongs to); this device decides WHERE it is shown (splits, panes, tab
 * order, windows). So the plan only ever:
 *   - drops a tab whose session was closed elsewhere or hidden on this device;
 *   - adds a tab for a session this device does not show yet (placer window
 *     only), into the local workspace bound to its group — or a new one;
 *   - binds a workspace to the group its sessions already belong to;
 *   - takes the group's name and colour (server wins, except while one of
 *     our own edits is still on its way there).
 * It never rearranges anything that already exists.
 */
import { INBOX_GROUP_ID, type SessionRecord } from '../../shared/remote-host-protocol';
import type { RemoteRegistryView } from '../../shared/remote-hosts-types';
import { remoteShellSpec } from '../../shared/remote-shell-spec';

export interface LocalWorkspace {
  id: string;
  title: string;
  color?: string;
  remoteGroups?: Record<string, string>;
  /** Pane ids in tree order. */
  paneIds: string[];
  /** The pane to add tabs to when this workspace is the active one. */
  focusedPaneId?: string;
  active: boolean;
}

export interface LocalSurface {
  id: string;
  hostId: string;
  workspaceId: string;
}

export interface LocalIndex {
  workspaces: LocalWorkspace[];
  surfaces: LocalSurface[];
}

export interface SeedSurface {
  id: string;
  shell: string;
  cwd?: string;
  customTitle?: string;
}

export type SyncAction =
  | { kind: 'drop'; surfaceIds: string[] }
  | { kind: 'insert'; workspaceId: string; paneId: string; surfaces: SeedSurface[] }
  | { kind: 'create-workspace'; hostId: string; groupId: string; title: string; color?: string; surfaces: SeedSurface[] }
  | { kind: 'bind'; workspaceId: string; hostId: string; groupId: string }
  | { kind: 'workspace-meta'; workspaceId: string; title: string; color?: string };

export interface PlanInput {
  views: RemoteRegistryView[];
  local: LocalIndex;
  /** This window adds missing sessions (exactly one window does). */
  placer: boolean;
  /** Remote surface ids shown in this app's OTHER windows. */
  elsewhere: ReadonlySet<string>;
  /** Groups with a local name/colour edit not yet confirmed by the server. */
  pendingMeta: ReadonlySet<string>;
}

function seedFor(hostId: string, s: SessionRecord): SeedSurface {
  return {
    id: s.id,
    shell: remoteShellSpec(hostId),
    cwd: s.lastCwd ?? s.cwd,
    ...(s.title ? { customTitle: s.title } : {}),
  };
}

export function planRemoteSync(input: PlanInput): SyncAction[] {
  const actions: SyncAction[] = [];
  const drops: string[] = [];
  const wsById = new Map(input.local.workspaces.map((w) => [w.id, w]));

  for (const view of input.views) {
    // Act only on a registry this device has actually heard from the server
    // this time — a stale or empty mirror must never delete anything.
    if (!view.connected) continue;
    const host = view.hostId;
    const sessions = new Map<string, SessionRecord>(view.sessions.map((s) => [s.id, s]));
    const closed = new Set(view.closedIds);
    const boundWs = new Map<string, LocalWorkspace>(); // groupId -> workspace
    for (const w of input.local.workspaces) {
      const g = w.remoteGroups?.[host];
      if (g && !boundWs.has(g)) boundWs.set(g, w);
    }

    // 1. Local tabs against the registry.
    const shownHere = new Set<string>();
    for (const surf of input.local.surfaces) {
      if (surf.hostId !== host) continue;
      shownHere.add(surf.id);
      if (closed.has(surf.id)) {
        drops.push(surf.id);
        continue;
      }
      const rec = sessions.get(surf.id);
      if (!rec) continue; // just created here and not echoed yet, or registry wiped: leave it
      if (rec.hiddenBy.includes(view.deviceId)) {
        drops.push(surf.id);
        continue;
      }
      const ws = wsById.get(surf.workspaceId);
      const groupId = rec.groupId ?? INBOX_GROUP_ID;
      if (ws && !ws.remoteGroups?.[host] && !boundWs.has(groupId)) {
        // A workspace holding a session of group G, bound to nothing on this host: it IS G here.
        actions.push({ kind: 'bind', workspaceId: ws.id, hostId: host, groupId });
        ws.remoteGroups = { ...(ws.remoteGroups ?? {}), [host]: groupId };
        boundWs.set(groupId, ws);
      }
    }

    // 2. Shared workspace names and colours (server wins, unless our edit is in flight).
    for (const [groupId, ws] of boundWs) {
      if (input.pendingMeta.has(groupId)) continue;
      const g = view.groups.find((x) => x.id === groupId);
      if (!g) continue;
      if (g.name !== ws.title || (g.color ?? undefined) !== (ws.color ?? undefined)) {
        actions.push({ kind: 'workspace-meta', workspaceId: ws.id, title: g.name, color: g.color });
      }
    }

    // 3. Sessions this device does not show yet (placer window only).
    if (!input.placer) continue;
    const byGroup = new Map<string, SessionRecord[]>();
    for (const s of view.sessions) {
      if (shownHere.has(s.id) || input.elsewhere.has(s.id)) continue;
      if (s.hiddenBy.includes(view.deviceId)) continue;
      const g = s.groupId ?? INBOX_GROUP_ID;
      const list = byGroup.get(g) ?? [];
      list.push(s);
      byGroup.set(g, list);
    }
    for (const [groupId, list] of byGroup) {
      list.sort((a, b) => a.createdAt - b.createdAt);
      const seeds = list.map((s) => seedFor(host, s));
      const ws = boundWs.get(groupId);
      if (ws && ws.paneIds.length) {
        const paneId = ws.active && ws.focusedPaneId && ws.paneIds.includes(ws.focusedPaneId) ? ws.focusedPaneId : ws.paneIds[0];
        actions.push({ kind: 'insert', workspaceId: ws.id, paneId, surfaces: seeds });
        continue;
      }
      const g = view.groups.find((x) => x.id === groupId);
      actions.push({
        kind: 'create-workspace',
        hostId: host,
        groupId,
        title: g?.name ?? (groupId === INBOX_GROUP_ID ? 'Inbox' : 'Remote'),
        color: g?.color,
        surfaces: seeds,
      });
    }
  }

  if (drops.length) actions.unshift({ kind: 'drop', surfaceIds: [...new Set(drops)] });
  return actions;
}
