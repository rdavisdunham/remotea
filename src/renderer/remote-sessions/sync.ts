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
import type { SplitNode, SurfaceRef, WorkspaceId, PaneId, SurfaceId } from '../../shared/types';
import type { RegistryPayload } from '../../shared/remote-hosts-types';
import { parseRemoteShellSpec } from '../../shared/remote-shell-spec';
import { INBOX_GROUP_ID } from '../../shared/remote-host-protocol';
import { planRemoteSync, type LocalIndex, type SyncAction } from './plan';
import { setLatestRemoteViews } from './registry-cache';


type Bridge = {
  onRegistry(cb: (p: RegistryPayload) => void): () => void;
  report(r: { ready: boolean; surfaceIds: string[] }): void;
  hide(hostId: string, surfaceId: string): void;
  unhide(hostId: string, surfaceId: string): void;
  close(hostId: string, surfaceId: string): void;
  groupUpsert(hostId: string, group: { id: string; name: string; color?: string }): void;
  groupClose(hostId: string, groupId: string): void;
};

function bridge(): Bridge | null {
  return (globalThis as { window?: { wmux?: { remoteSessions?: Bridge } } }).window?.wmux?.remoteSessions ?? null;
}

let ready = false;
let latest: RegistryPayload | null = null;
let applyQueued = false;
let reportTimer: ReturnType<typeof setTimeout> | null = null;
let lastReport = '';
/** groupId -> the name/colour we pushed and are waiting to see echoed. */
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
        if (host) index.surfaces.push({ id: s.id, hostId: host, workspaceId: ws.id });
      }
    });
    index.workspaces.push({
      id: ws.id,
      title: ws.title,
      color: ws.customColor,
      remoteGroups: ws.remoteGroups ? { ...ws.remoteGroups } : undefined,
      paneIds,
      focusedPaneId: st.activeWorkspaceId === ws.id ? focusedPane() ?? undefined : undefined,
      active: st.activeWorkspaceId === ws.id,
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
      case 'bind': {
        const ws = useStore.getState().workspaces.find((w) => w.id === a.workspaceId);
        if (!ws) break;
        useStore.getState().updateWorkspaceMetadata(ws.id, { remoteGroups: { ...(ws.remoteGroups ?? {}), [a.hostId]: a.groupId } });
        break;
      }
      case 'workspace-meta': {
        useStore.getState().updateWorkspaceMetadata(a.workspaceId as WorkspaceId, { title: a.title, titleIsDefault: false, customColor: a.color });
        const ws = useStore.getState().workspaces.find((w) => w.id === a.workspaceId);
        for (const host of Object.keys(ws?.remoteGroups ?? {})) agreedMeta.set(`${a.workspaceId}|${host}`, { name: a.title, color: a.color });
        break;
      }
    }
  }
}

function runSync(): void {
  applyQueued = false;
  if (!ready || !latest) return;
  const now = Date.now();
  for (const [g, p] of pendingMeta) {
    const confirmed = latest.views.some((v) => v.groups.some((x) => x.id === g && x.name === p.name && (x.color ?? undefined) === (p.color ?? undefined)));
    if (confirmed || now - p.at > PENDING_META_MS) pendingMeta.delete(g);
  }
  const actions = planRemoteSync({
    views: latest.views,
    local: buildLocalIndex(),
    placer: latest.placer,
    elsewhere: new Set(latest.elsewhere),
    pendingMeta: new Set(pendingMeta.keys()),
  });
  if (actions.length) applySyncActions(actions);
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

/** Push renames/recolours of bound workspaces to their groups. */
function pushLocalMeta(): void {
  if (!ready) return;
  for (const ws of useStore.getState().workspaces) {
    for (const [host, groupId] of Object.entries(ws.remoteGroups ?? {})) {
      const key = `${ws.id}|${host}`;
      const agreed = agreedMeta.get(key);
      const mine = { name: ws.title, color: ws.customColor };
      if (!agreed) {
        agreedMeta.set(key, mine);
        continue;
      }
      if (agreed.name === mine.name && (agreed.color ?? undefined) === (mine.color ?? undefined)) continue;
      agreedMeta.set(key, mine);
      if (groupId === INBOX_GROUP_ID && mine.name !== agreed.name) continue; // the inbox keeps its name
      pendingMeta.set(groupId, { ...mine, at: Date.now() });
      bridge()?.groupUpsert(host, { id: groupId, name: mine.name, color: mine.color });
    }
  }
}

/**
 * Start syncing once this window's saved layout is restored. Idempotent.
 */
export function markRemoteLayoutReady(): void {
  const b = bridge();
  if (ready || !b) return;
  ready = true;
  b.onRegistry((payload) => {
    latest = payload;
    setLatestRemoteViews(payload.views);
    queueSync();
  });
  useStore.subscribe(() => {
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
