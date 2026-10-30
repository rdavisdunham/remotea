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
 *
 * With `groupEridani` (task 0ec167e4) a session Eridani started (one that
 * carries an `eridani` binding) is not placed by its server group (they all
 * share "Eridani") but into a local workspace per task on its execution
 * target — per run when it has no task — created on first need and marked
 * with `eridaniTask`. Such a workspace is never bound to a server group, so
 * a rename does not rename the shared group and closing it closes only its
 * own tabs.
 */
import { INBOX_GROUP_ID, type EridaniBinding, type SessionRecord } from '../../shared/remote-host-protocol';
import type { RemoteRegistryView } from '../../shared/remote-hosts-types';
import { remoteShellSpec } from '../../shared/remote-shell-spec';
import type { EridaniTaskRef } from '../../shared/types';

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
  /** Set: this workspace groups one Eridani task's sessions (never bound to a server group). */
  eridaniTask?: EridaniTaskRef;
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
  | { kind: 'create-task-workspace'; task: EridaniTaskRef; title: string; surfaces: SeedSurface[] }
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
  /** Place Eridani-started sessions in one workspace per task (Settings → Remote hosts). */
  groupEridani?: boolean;
}

/** Does workspace task `w` hold sessions of binding `b` on `hostId`? Same target and task (same run when there is no task). */
export function sameEridaniTask(w: EridaniTaskRef, hostId: string, b: Pick<EridaniBinding, 'target' | 'taskId' | 'runId'>): boolean {
  if (w.hostId !== hostId || w.target !== b.target) return false;
  return b.taskId ? w.taskId === b.taskId : !w.taskId && w.runId === b.runId;
}

function taskKey(b: EridaniBinding): string {
  return `${b.target}\u0000${b.taskId ? `task:${b.taskId}` : `run:${b.runId}`}`;
}

/** The pane new tabs go to: the focused one when the workspace is active, else its first. */
function targetPane(ws: LocalWorkspace): string {
  return ws.active && ws.focusedPaneId && ws.paneIds.includes(ws.focusedPaneId) ? ws.focusedPaneId : ws.paneIds[0];
}

/** A task workspace's title, from its earliest session: Eridani spawns with the task title as the session title. */
function taskTitle(first: SessionRecord): string {
  const b = first.eridani!;
  return first.title || `${b.harness} · ${b.branch}`;
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
      // A task workspace stands for a task, not for the server group its sessions share.
      if (ws && !ws.eridaniTask && !ws.remoteGroups?.[host] && !boundWs.has(groupId)) {
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
    const byTask = new Map<string, SessionRecord[]>();
    for (const s of view.sessions) {
      if (shownHere.has(s.id) || input.elsewhere.has(s.id)) continue;
      if (s.hiddenBy.includes(view.deviceId)) continue;
      if (input.groupEridani && s.eridani) {
        const k = taskKey(s.eridani);
        const list = byTask.get(k) ?? [];
        list.push(s);
        byTask.set(k, list);
        continue;
      }
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
        actions.push({ kind: 'insert', workspaceId: ws.id, paneId: targetPane(ws), surfaces: seeds });
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
    for (const list of byTask.values()) {
      list.sort((a, b) => a.createdAt - b.createdAt);
      const b = list[0].eridani!;
      const seeds = list.map((s) => seedFor(host, s));
      const ws = input.local.workspaces.find((w) => w.eridaniTask && w.paneIds.length && sameEridaniTask(w.eridaniTask, host, b));
      if (ws) {
        actions.push({ kind: 'insert', workspaceId: ws.id, paneId: targetPane(ws), surfaces: seeds });
        continue;
      }
      actions.push({
        kind: 'create-task-workspace',
        task: { hostId: host, target: b.target, taskId: b.taskId, runId: b.runId },
        title: taskTitle(list[0]),
        surfaces: seeds,
      });
    }
  }

  if (drops.length) actions.unshift({ kind: 'drop', surfaceIds: [...new Set(drops)] });
  return actions;
}

/** One move of the Eridani tab migration: into an existing task workspace's pane, or a new task workspace. */
export type EridaniMigrationMove =
  | { surfaceIds: string[]; workspaceId: string; paneId: string }
  | { surfaceIds: string[]; task: EridaniTaskRef; title: string };

export interface EridaniMigrationPlan {
  moves: EridaniMigrationMove[];
  /** Eridani tabs this push decided about (moved or left where they are): never looked at again. */
  decided: string[];
}

/**
 * The one-time move of Eridani tabs that predate task workspaces (task
 * 0ec167e4 placed only NEW sessions per task; tabs already shown sat on in
 * the shared "Eridani" workspace). A tab of a session with an `eridani`
 * binding that sits in its server group's workspace (bound to that group on
 * the host, or not bound there yet) moves to its task workspace, joining one
 * that exists or creating it as placement would. A tab already in a task
 * workspace, or one the user put in a workspace of another group, stays.
 *
 * Pure. `done` holds tabs decided before (the caller persists `decided`), so
 * each tab is considered once: a tab the user later drags back out of its
 * task workspace stays where they put it. Only connected hosts, and never a
 * tab whose session was closed or hidden (sync drops those).
 */
export function planEridaniMigration(views: RemoteRegistryView[], local: LocalIndex, done: ReadonlySet<string>): EridaniMigrationPlan {
  const decided: string[] = [];
  const wsById = new Map(local.workspaces.map((w) => [w.id, w]));
  const groups = new Map<string, { host: string; recs: SessionRecord[] }>();
  for (const view of views) {
    if (!view.connected) continue;
    const host = view.hostId;
    const sessions = new Map<string, SessionRecord>(view.sessions.map((s) => [s.id, s]));
    const closed = new Set(view.closedIds);
    for (const surf of local.surfaces) {
      if (surf.hostId !== host || done.has(surf.id) || closed.has(surf.id)) continue;
      const rec = sessions.get(surf.id);
      if (!rec?.eridani || rec.hiddenBy.includes(view.deviceId)) continue;
      const ws = wsById.get(surf.workspaceId);
      if (!ws) continue;
      decided.push(surf.id);
      const bound = ws.remoteGroups?.[host];
      if (ws.eridaniTask || (bound && bound !== (rec.groupId ?? INBOX_GROUP_ID))) continue;
      const k = `${host}\u0000${taskKey(rec.eridani)}`;
      const g = groups.get(k) ?? { host, recs: [] };
      g.recs.push(rec);
      groups.set(k, g);
    }
  }
  const moves: EridaniMigrationMove[] = [];
  for (const { host, recs } of groups.values()) {
    recs.sort((a, b) => a.createdAt - b.createdAt);
    const b = recs[0].eridani!;
    const surfaceIds = recs.map((r) => r.id as string);
    const ws = local.workspaces.find((w) => w.eridaniTask && w.paneIds.length && sameEridaniTask(w.eridaniTask, host, b));
    if (ws) moves.push({ surfaceIds, workspaceId: ws.id, paneId: targetPane(ws) });
    else moves.push({ surfaceIds, task: { hostId: host, target: b.target, taskId: b.taskId, runId: b.runId }, title: taskTitle(recs[0]) });
  }
  return { moves, decided };
}
