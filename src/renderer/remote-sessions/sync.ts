/**
 * remotea: keeps this window's layout in step with the remote session
 * registries (see plan.ts for the rules) and pushes this device's own
 * workspace renames/recolours up to the server.
 *
 * Main tells every window the registries, plus whether it is THE window that
 * places sessions this device does not show yet (only one may, or two
 * windows would both add the same tab) and which remote tabs the other
 * windows already show. In return each window reports its remote tabs.
 *
 * Nothing runs before markRemoteLayoutReady(): placing sessions into a layout
 * that is still being restored from disk would add every tab a second time.
 */
import { v4 as uuid } from 'uuid';
import { useStore } from '../store';
import { findLeaf } from '../store/split-utils';
import type { SplitNode, SurfaceRef, WorkspaceId, PaneId, SurfaceId } from '../../shared/types';
import type { RegistryPayload, RemoteRegistryView } from '../../shared/remote-hosts-types';
import { parseRemoteShellSpec } from '../../shared/remote-shell-spec';
import { LIMITS } from '../../shared/remote-host-protocol';
import { planEridaniSeparation, planRemoteSync, workspaceMetadataGroups, metadataKey, type LocalIndex, type SyncAction } from './plan';
import { setLatestRemoteViews } from './registry-cache';
import { noteRegistryForRecovery } from './recovery-runtime';
import { notifyChatReminders } from './chat-reminder-notifications';


type Bridge = {
  onRegistry(cb: (p: RegistryPayload) => void): () => void;
  report(r: { ready: boolean; surfaceIds: string[] }): void;
  hide(hostId: string, surfaceId: string): void;
  unhide(hostId: string, surfaceId: string): void;
  close(hostId: string, surfaceId: string): void;
  sessionUpdate(hostId: string, surfaceId: string, update: { title: string | null }): void;
  groupUpsert(hostId: string, group: { id: string; name: string; color?: string }): void;
  groupClose(hostId: string, groupId: string): void;
};

function bridge(): Bridge | null {
  return (globalThis as { window?: { remotea?: { remoteSessions?: Bridge } } }).window?.remotea?.remoteSessions ?? null;
}

let ready = false;
let latest: RegistryPayload | null = null;
let applyQueued = false;
let reportTimer: ReturnType<typeof setTimeout> | null = null;
let lastReport = '';
let applyingMetadata = false;
let metadataTimer: ReturnType<typeof setTimeout> | null = null;
const agreedTitles = new Map<string, string | undefined>();
const pendingTitles = new Map<string, { title: string | null; at: number; sent: boolean }>();
/** hostId + groupId -> the name/colour we pushed and are waiting to see echoed. */
const pendingMeta = new Map<string, { name: string; color?: string; at: number }>();
/** workspaceId|hostId -> the name/colour last agreed with the server. */
const agreedMeta = new Map<string, { name: string; color?: string }>();
const PENDING_META_MS = 8000;
/** The focused pane of the active workspace lives in App's React state; App registers a reader. */
let focusedPane: () => string | null = () => null;

export function setFocusedPaneReader(read: () => string | null): void {
  focusedPane = read;
}

function walkLeaves(tree: SplitNode, visit: (leaf: Extract<SplitNode, { type: 'leaf' }>) => void): void {
  if (tree.type === 'leaf') {
    visit(tree);
    return;
  }
  walkLeaves(tree.children[0], visit);
  walkLeaves(tree.children[1], visit);
}

/** Effective shell of a surface: its own, the workspace's, else the default. */
function surfaceHost(s: SurfaceRef, wsShell: string, defaultShell: string): string | null {
  if (s.type !== 'terminal') return null;
  return parseRemoteShellSpec(s.shell || wsShell || defaultShell)?.hostId ?? null;
}

export function buildLocalIndex(): LocalIndex {
  const st = useStore.getState();
  const defaultShell = st.workspacePrefs.defaultShell;
  const index: LocalIndex = { workspaces: [], surfaces: [] };
  for (const ws of st.workspaces) {
    const paneIds: string[] = [];
    walkLeaves(ws.splitTree, (leaf) => {
      paneIds.push(leaf.paneId);
      for (const s of leaf.surfaces) {
        const host = surfaceHost(s, ws.shell, defaultShell);
        if (host) index.surfaces.push({ id: s.id, hostId: host, workspaceId: ws.id, paneId: leaf.paneId, customTitle: s.customTitle });
      }
    });
    index.workspaces.push({
      id: ws.id,
      title: ws.title,
      titleIsDefault: ws.titleIsDefault,
      color: ws.customColor,
      remoteGroups: ws.remoteGroups ? { ...ws.remoteGroups } : undefined,
      paneIds,
      focusedPaneId: st.activeWorkspaceId === ws.id ? focusedPane() ?? undefined : undefined,
      active: st.activeWorkspaceId === ws.id,
      ...(ws.eridaniTask ? { eridaniTask: ws.eridaniTask } : {}),
    });
  }
  return index;
}

function leafNode(seeds: SurfaceRef[]): SplitNode {
  return { type: 'leaf', paneId: `pane-${uuid()}` as PaneId, surfaces: seeds, activeSurfaceIndex: 0 };
}

export function applySyncActions(actions: SyncAction[]): void {
  const st = useStore.getState();
  for (const a of actions) {
    switch (a.kind) {
      case 'drop':
        useStore.getState().dropSurfacesLocal(a.surfaceIds);
        break;
      case 'insert':
        useStore.getState().insertRemoteSurfaces(a.workspaceId as WorkspaceId, a.paneId as PaneId, a.surfaces.map((s) => ({ ...s, id: s.id as SurfaceId })));
        break;
      case 'create-workspace': {
        const surfaces: SurfaceRef[] = a.surfaces.map((s) => ({
          id: s.id as SurfaceId,
          type: 'terminal',
          shell: s.shell,
          ...(s.cwd ? { cwd: s.cwd } : {}),
          ...(s.customTitle ? { customTitle: s.customTitle } : {}),
        }));
        // A single pane holding exactly the placed sessions — never the default
        // layout, whose extra empty panes would each start a NEW session.
        const wsId = st.createWorkspace({
          title: a.title,
          titleIsDefault: false,
          customColor: a.color,
          splitTree: leafNode(surfaces),
          remoteGroups: { [a.hostId]: a.groupId },
        });
        agreedMeta.set(`${wsId}|${a.hostId}`, { name: a.title, color: a.color });
        break;
      }
      case 'create-task-workspace': {
        const surfaces: SurfaceRef[] = a.surfaces.map((s) => ({
          id: s.id as SurfaceId,
          type: 'terminal',
          shell: s.shell,
          ...(s.cwd ? { cwd: s.cwd } : {}),
          ...(s.customTitle ? { customTitle: s.customTitle } : {}),
        }));
        // Like create-workspace, one pane holding exactly the placed sessions;
        // unlike it, bound to no server group (see plan.ts).
        st.createWorkspace({ title: a.title, titleIsDefault: false, customColor: a.color, splitTree: leafNode(surfaces), eridaniTask: a.task });
        break;
      }
      case 'bind': {
        const ws = useStore.getState().workspaces.find((w) => w.id === a.workspaceId);
        if (!ws) break;
        useStore.getState().updateWorkspaceMetadata(ws.id, { remoteGroups: { ...(ws.remoteGroups ?? {}), [a.hostId]: a.groupId } });
        break;
      }
      case 'surface-title':
        useStore.getState().updateSurface(a.workspaceId as WorkspaceId, a.paneId as PaneId, a.surfaceId as SurfaceId, { customTitle: a.title });
        break;
      case 'workspace-meta': {
        useStore.getState().updateWorkspaceMetadata(a.workspaceId as WorkspaceId, { title: a.title, titleIsDefault: false, customColor: a.color });
        const ws = useStore.getState().workspaces.find((w) => w.id === a.workspaceId);
        for (const host of Object.keys(ws?.remoteGroups ?? {})) agreedMeta.set(`${a.workspaceId}|${host}`, { name: a.title, color: a.color });
        break;
      }
    }
  }
}

/** Keep delegated tabs separate using layout moves that preserve the existing host sessions. */
export function migrateEridaniTabs(views: RemoteRegistryView[]): void {
  const { moves } = planEridaniSeparation(views, buildLocalIndex());
  for (const m of moves) {
    if ('workspaceId' in m) useStore.getState().moveSurfacesLocal(m.surfaceIds, { workspaceId: m.workspaceId as WorkspaceId, paneId: m.paneId as PaneId });
    else useStore.getState().moveSurfacesLocal(m.surfaceIds, { create: { title: m.title, titleIsDefault: false, eridaniTask: m.task } });
  }
}

function runSync(): void {
  applyQueued = false;
  if (!ready || !latest) return;
  // Keep optimistic local choices until IPC has persisted them in the main outbox.
  // Main supplies durable overlays across reconnects and renderer restarts.
  seedLegacyNames(latest.views);
  const now = Date.now();
  const views = latest.views.map(view => {
    const pendingGroups = { ...view.pendingGroups };
    const titles = { ...view.pendingTitles };
    for (const [key, pending] of pendingMeta) {
      const group = view.groups.find(g => metadataKey(view.hostId, g.id) === key);
      if (!key.startsWith(`${view.hostId}\u0000`)) continue;
      if ((group?.name === pending.name && group.color === pending.color) || now - pending.at > PENDING_META_MS) pendingMeta.delete(key);
      else pendingGroups[key.slice(view.hostId.length + 1)] = { name: pending.name, color: pending.color };
    }
    for (const [key, pending] of pendingTitles) {
      if (!key.startsWith(`${view.hostId}\u0000`)) continue;
      const id = key.slice(view.hostId.length + 1);
      const session = view.sessions.find(s => s.id === id);
      // A rename can precede the terminal's first open. Send it once the host knows the session.
      if (!pending.sent && session) {
        pending.sent = true;
        pending.at = now;
        bridge()?.sessionUpdate(view.hostId, id, { title: pending.title });
        scheduleMetadataReconcile();
      }
      if ((session && (session.title || null) === pending.title) || (pending.sent && now - pending.at > PENDING_META_MS)) pendingTitles.delete(key);
      else titles[id] = pending.title;
    }
    return { ...view, pendingGroups, pendingTitles: titles };
  });
  noteRegistryForRecovery(views);
  applyingMetadata = true;
  try {
    migrateEridaniTabs(views);
    applySyncActions(planRemoteSync({
      views,
      local: buildLocalIndex(),
      placer: latest.placer,
      elsewhere: new Set(latest.elsewhere),
      pendingMeta: new Set(),
      groupEridani: true,
    }));
    for (const surface of buildLocalIndex().surfaces) {
      if (!surface.paneId) continue;
      const view = views.find(item => item.hostId === surface.hostId);
      const session = view?.sessions.find(item => item.id === surface.id);
      const sourceMatches = !session?.agent || session.tea?.source === `${session.agent.provider}:${session.agent.sessionId}`;
      const automaticTitle = view?.tea?.config.autoName === false || !sourceMatches ? undefined : session?.tea?.title || undefined;
      const state = useStore.getState();
      const workspace = state.workspaces.find(item => item.id === surface.workspaceId);
      const current = workspace && findLeaf(workspace.splitTree, surface.paneId as PaneId)?.surfaces.find(item => item.id === surface.id);
      if (current?.automaticTitle !== automaticTitle) state.updateSurface(surface.workspaceId as WorkspaceId, surface.paneId as PaneId, surface.id as SurfaceId, { automaticTitle });
    }
  } finally {
    rememberMetadata();
    applyingMetadata = false;
  }
  if (latest.placer) notifyChatReminders(latest.views);
}

function queueSync(): void {
  if (applyQueued) return;
  applyQueued = true;
  queueMicrotask(runSync);
}

/** Tell main which remote tabs this window shows (debounced, only on change). */
function scheduleReport(): void {
  if (reportTimer) return;
  reportTimer = setTimeout(() => {
    reportTimer = null;
    const ids = buildLocalIndex().surfaces.map((s) => s.id).sort();
    const key = `${ready}|${ids.join(',')}`;
    if (key === lastReport) return;
    lastReport = key;
    bridge()?.report({ ready, surfaceIds: ids });
  }, 150);
}

/** Baselines distinguish user edits from incoming registry changes. */
function rememberMetadata(local: LocalIndex = buildLocalIndex()): void {
  agreedMeta.clear();
  agreedTitles.clear();
  for (const ws of local.workspaces) {
    for (const host of Object.keys(workspaceMetadataGroups(ws))) agreedMeta.set(`${ws.id}|${host}`, { name: ws.title, color: ws.color });
  }
  for (const surface of local.surfaces) agreedTitles.set(metadataKey(surface.hostId, surface.id), surface.customTitle || undefined);
}

/** Expire the renderer-to-main handoff even when no further registry event arrives. */
function scheduleMetadataReconcile(): void {
  if (metadataTimer) clearTimeout(metadataTimer);
  metadataTimer = setTimeout(() => {
    metadataTimer = null;
    queueSync();
  }, PENDING_META_MS + 1);
}

function sendWorkspaceName(host: string, groupId: string, name: string, color?: string): void {
  const metadata = { name: name.slice(0, LIMITS.maxName), color };
  pendingMeta.set(metadataKey(host, groupId), { ...metadata, at: Date.now() });
  bridge()?.groupUpsert(host, { id: groupId, ...metadata });
  scheduleMetadataReconcile();
}

function sendTerminalName(host: string, id: string, title: string | undefined): void {
  const value = title?.slice(0, LIMITS.maxTitle) || null;
  const known = latest?.views.some(view => view.hostId === host && view.sessions.some(session => session.id === id)) ?? false;
  pendingTitles.set(metadataKey(host, id), { title: value, at: Date.now(), sent: known });
  if (known) bridge()?.sessionUpdate(host, id, { title: value });
  scheduleMetadataReconcile();
}

/** Preserve explicit names saved by app versions that only stored terminal/task names locally. */
function seedLegacyNames(views: RemoteRegistryView[]): void {
  const local = buildLocalIndex();
  for (const view of views) {
    if (!view.connected) continue;
    for (const surface of local.surfaces) {
      if (surface.hostId !== view.hostId || !surface.customTitle) continue;
      const session = view.sessions.find(s => s.id === surface.id);
      const key = metadataKey(view.hostId, surface.id);
      if (session && session.titleUpdatedAt === undefined && surface.customTitle !== session.title &&
          !pendingTitles.has(key) && !Object.hasOwn(view.pendingTitles ?? {}, surface.id)) {
        sendTerminalName(view.hostId, surface.id, surface.customTitle);
      }
    }
    for (const ws of local.workspaces) {
      if (ws.eridaniTask?.hostId !== view.hostId || ws.titleIsDefault !== undefined) continue;
      const groupId = workspaceMetadataGroups(ws)[view.hostId];
      if (!view.groups.some(g => g.id === groupId) && !view.pendingGroups?.[groupId] && !pendingMeta.has(metadataKey(view.hostId, groupId))) {
        sendWorkspaceName(view.hostId, groupId, ws.title, ws.color);
      }
    }
  }
}

/** Push only local edits. Server-driven store updates run with applyingMetadata set. */
function pushLocalMeta(): void {
  if (!ready || applyingMetadata) return;
  const local = buildLocalIndex();
  for (const ws of local.workspaces) {
    for (const [host, groupId] of Object.entries(workspaceMetadataGroups(ws))) {
      const agreed = agreedMeta.get(`${ws.id}|${host}`);
      if (!agreed || (agreed.name === ws.title && agreed.color === ws.color)) continue;
      sendWorkspaceName(host, groupId, ws.title, ws.color);
    }
  }
  for (const surface of local.surfaces) {
    const key = metadataKey(surface.hostId, surface.id);
    if (agreedTitles.has(key) && agreedTitles.get(key) !== (surface.customTitle || undefined)) {
      sendTerminalName(surface.hostId, surface.id, surface.customTitle);
    }
  }
  rememberMetadata(local);
}

/**
 * Start syncing once this window's saved layout is restored. Idempotent.
 */
export function markRemoteLayoutReady(): void {
  const b = bridge();
  if (ready || !b) return;
  ready = true;
  rememberMetadata();
  b.onRegistry((payload) => {
    latest = payload;
    setLatestRemoteViews(payload.views);
    queueSync();
  });
  useStore.subscribe((state, previous) => {
    if (state.workspaces === previous.workspaces && state.workspacePrefs.defaultShell === previous.workspacePrefs.defaultShell) return;
    scheduleReport();
    pushLocalMeta();
  });
  pushLocalMeta();
  scheduleReport();
}

/**
 * The group a remote terminal created in this workspace belongs to — binding
 * the workspace to a new group on first use. Synchronous, so several panes of
 * a new workspace mounting together share one group.
 */
export function ensureRemoteGroup(surfaceId: string, hostId: string): { groupId: string; group: { name: string; color?: string } } | null {
  const st = useStore.getState();
  let found: { id: WorkspaceId; title: string; customColor?: string; remoteGroups?: Record<string, string> } | undefined;
  for (const ws of st.workspaces) {
    let has = false;
    walkLeaves(ws.splitTree, (leaf) => {
      if (leaf.surfaces.some((s) => s.id === surfaceId)) has = true;
    });
    if (has) {
      found = ws;
      break;
    }
  }
  if (!found) return null;
  let groupId = found.remoteGroups?.[hostId];
  if (!groupId) {
    groupId = `grp-${uuid()}`;
    st.updateWorkspaceMetadata(found.id, { remoteGroups: { ...(found.remoteGroups ?? {}), [hostId]: groupId } });
    agreedMeta.set(`${found.id}|${hostId}`, { name: found.title, color: found.customColor });
  }
  return { groupId, group: { name: found.title, color: found.customColor } };
}

/** "Hide on this device": the session keeps running and stays on other devices. */
export function hideRemoteSurface(surfaceId: string): boolean {
  const index = buildLocalIndex();
  const surf = index.surfaces.find((s) => s.id === surfaceId);
  if (!surf) return false;
  bridge()?.hide(surf.hostId, surfaceId);
  useStore.getState().dropSurfacesLocal([surfaceId]);
  return true;
}

export function isRemoteSurface(surfaceId: string): boolean {
  return buildLocalIndex().surfaces.some((s) => s.id === surfaceId);
}

export function unhideRemoteSession(hostId: string, surfaceId: string): void {
  bridge()?.unhide(hostId, surfaceId);
}

export function closeRemoteSession(hostId: string, surfaceId: string): void {
  bridge()?.close(hostId, surfaceId);
}
