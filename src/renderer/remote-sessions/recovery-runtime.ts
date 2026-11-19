/**
 * remotea: the impure half of the recovery inventory (see recovery.ts). sync.ts
 * hands it every registry push before applying it; on a host's first
 * connected push in this window (app start) or its first after a drop or a
 * server restart, it computes what happened while away and, when there is
 * something to decide, opens the recovery dialog (RecoveryDialog).
 *
 * "While away" is decided without comparing clocks across machines: every
 * exit, loss or ended run this window SAW while connected is remembered, and
 * only what it did not see is offered. Offered items are remembered across
 * restarts (localStorage), so an exited tab is asked about once.
 */
import { v4 as uuid } from 'uuid';
import { create } from 'zustand';
import { useStore } from '../store';
import type { PaneId, SplitNode, SurfaceId, WorkspaceId } from '../../shared/types';
import type { RemoteRegistryView } from '../../shared/remote-hosts-types';
import { parseRemoteShellSpec, remoteShellSpec } from '../../shared/remote-shell-spec';
import { mergeRecoveryItems, recoveryInventory, shouldShowRecovery, type RecoveryChoice, type RecoveryItem, type RecoveryLocalSurface } from './recovery';

/** Close a remote session everywhere (the same bridge call sync.ts makes; imported directly to keep sync → here one-way). */
function closeRemoteSession(hostId: string, surfaceId: string): void {
  (globalThis as { window?: { remotea?: { remoteSessions?: { close?(h: string, s: string): void } } } }).window?.remotea?.remoteSessions?.close?.(hostId, surfaceId);
}

export const useRecovery = create<{ items: RecoveryItem[] }>(() => ({ items: [] }));

const SEEN_KEY = 'remotea-recovery-seen';
const SEEN_MAX = 500;

/** Per host: connected at the last push, and the server boot it was. */
const hostSeen = new Map<string, { connected: boolean; bootId: string | null }>();
/** Item keys this window saw happen while connected (never offered). */
const observed = new Set<string>();

function loadSeen(): string[] {
  try {
    const raw = globalThis.localStorage?.getItem(SEEN_KEY);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function rememberSeen(keys: string[]): void {
  if (!keys.length) return;
  try {
    const list = [...loadSeen().filter((k) => !keys.includes(k)), ...keys].slice(-SEEN_MAX);
    globalThis.localStorage?.setItem(SEEN_KEY, JSON.stringify(list));
  } catch {
    /* storage unavailable: the item may be offered again next start */
  }
}

function walk(tree: SplitNode, visit: (leaf: Extract<SplitNode, { type: 'leaf' }>) => void): void {
  if (tree.type === 'leaf') visit(tree);
  else {
    walk(tree.children[0], visit);
    walk(tree.children[1], visit);
  }
}

/** The remote tabs this window shows, with what Reopen needs. */
export function localRecoverySurfaces(): RecoveryLocalSurface[] {
  const st = useStore.getState();
  const out: RecoveryLocalSurface[] = [];
  for (const ws of st.workspaces) {
    walk(ws.splitTree, (leaf) => {
      for (const s of leaf.surfaces) {
        if (s.type !== 'terminal') continue;
        const host = parseRemoteShellSpec(s.shell || ws.shell || st.workspacePrefs.defaultShell)?.hostId;
        if (host) out.push({ id: s.id, hostId: host, workspaceId: ws.id, title: s.customTitle || s.defaultTitle, cwd: s.cwd });
      }
    });
  }
  return out;
}

/** Test seam: forget what this window has seen. */
export function resetRecoveryForTests(): void {
  hostSeen.clear();
  observed.clear();
  useRecovery.setState({ items: [] });
}

/**
 * A registry push, before sync applies it. Offers what happened on hosts
 * that just (re)connected; remembers everything else as seen live.
 */
export function noteRegistryForRecovery(views: RemoteRegistryView[], local: RecoveryLocalSurface[] = localRecoverySurfaces()): void {
  const reconnected: Record<string, number> = {};
  const live: Record<string, number> = {};
  for (const v of views) {
    const prev = hostSeen.get(v.hostId);
    hostSeen.set(v.hostId, { connected: v.connected, bootId: v.bootId });
    if (!v.connected) continue;
    if (!prev || !prev.connected || prev.bootId !== v.bootId) reconnected[v.hostId] = 0;
    else live[v.hostId] = 0;
  }
  // Seen live: never offered later.
  if (Object.keys(live).length) {
    for (const i of recoveryInventory({ views, local, awaySince: live, seen: new Set() }).items) observed.add(i.key);
  }
  if (!Object.keys(reconnected).length) return;
  const seen = new Set([...loadSeen(), ...observed]);
  const inv = recoveryInventory({ views, local, awaySince: reconnected, seen });
  for (const i of inv.items) observed.add(i.key);
  if (!inv.items.length) return;
  rememberSeen(inv.items.map((i) => i.key));
  const skipClean = useStore.getState().workspacePrefs.recoverySkipClean !== false;
  if (!shouldShowRecovery(inv, skipClean)) return;
  useRecovery.setState((s) => ({ items: mergeRecoveryItems(s.items, inv.items) }));
}

// ── Choices ────────────────────────────────────────────────────────────────

/**
 * A new remote terminal in `cwd`, next to `near` (or in the workspace, else the active one); focused.
 * `command` runs instead of a login shell (Reopen: the agent's resume command).
 */
export function openRemoteTerminal(hostId: string, cwd: string | undefined, opts: { workspaceId?: string; near?: string; title?: string; command?: string } = {}): string | null {
  const st = useStore.getState();
  const id = `surf-${uuid()}`;
  const seed = { id: id as SurfaceId, shell: remoteShellSpec(hostId, opts.command), ...(cwd ? { cwd } : {}), ...(opts.title ? { customTitle: opts.title } : {}) };
  let ws = st.workspaces.find((w) => w.id === opts.workspaceId) ?? st.workspaces.find((w) => w.id === st.activeWorkspaceId);
  if (!ws) {
    const wsId = st.createWorkspace({
      title: opts.title || 'Recovered', titleIsDefault: false,
      splitTree: { type: 'leaf', paneId: `pane-${uuid()}` as PaneId, surfaces: [{ ...seed, type: 'terminal' }], activeSurfaceIndex: 0 },
    });
    st.selectWorkspace(wsId);
    return id;
  }
  let paneId: string | undefined;
  walk(ws.splitTree, (leaf) => {
    if (!paneId && opts.near && leaf.surfaces.some((s) => s.id === opts.near)) paneId = leaf.paneId;
  });
  if (!paneId) walk(ws.splitTree, (leaf) => { paneId ??= leaf.paneId; });
  st.insertRemoteSurfaces(ws.id, paneId as PaneId, [seed]);
  ws = useStore.getState().workspaces.find((w) => w.id === ws!.id);
  if (ws) {
    walk(ws.splitTree, (leaf) => {
      const index = leaf.surfaces.findIndex((s) => s.id === id);
      if (index >= 0) {
        useStore.getState().selectWorkspace(ws!.id as WorkspaceId);
        useStore.getState().selectSurface(ws!.id as WorkspaceId, leaf.paneId, index);
      }
    });
  }
  return id;
}

async function copyText(text: string): Promise<boolean> {
  const bridge = (globalThis as { window?: { remotea?: { clipboard?: { writeText?: (t: string) => unknown } } } }).window?.remotea?.clipboard;
  try {
    if (bridge?.writeText) {
      await bridge.writeText(text);
      return true;
    }
    await globalThis.navigator?.clipboard?.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Carry out one choice. Returns whether the item is settled (copying a
 * branch name leaves it on screen for another choice).
 */
export async function applyRecoveryChoice(item: RecoveryItem, choice: RecoveryChoice): Promise<boolean> {
  switch (choice) {
    case 'leave':
      return true;
    case 'keep-closed':
      // An exited or lost session: end its record; a closed one is gone already; a worktree is left alone.
      if (item.kind === 'exited' || item.kind === 'restored') {
        closeRemoteSession(item.hostId, item.surfaceId);
        useStore.getState().dropSurfacesLocal([item.surfaceId]);
      }
      return true;
    case 'reopen':
      if (item.kind === 'restored') return true; // its tab respawns it on open
      // An agent session comes back with its conversation (`claude --resume <id>`), as a lost one does on the host.
      openRemoteTerminal(item.hostId, item.cwd, { workspaceId: item.workspaceId, near: item.surfaceId, title: item.title, ...(item.resume ? { command: item.resume } : {}) });
      if (item.kind === 'exited') {
        // The new terminal takes the dead one's place.
        closeRemoteSession(item.hostId, item.surfaceId);
        useStore.getState().dropSurfacesLocal([item.surfaceId]);
      }
      return true;
    case 'open-worktree':
      openRemoteTerminal(item.hostId, item.worktree ?? item.cwd, { workspaceId: item.workspaceId, near: item.surfaceId, title: item.branch });
      return true;
    case 'copy-branch':
      if (item.branch) await copyText(item.branch);
      return false;
  }
}

export function settleRecoveryItem(key: string): void {
  useRecovery.setState((s) => ({ items: s.items.filter((i) => i.key !== key) }));
}

/** "Done": everything left gets its default (the first choice), which never acts. */
export function dismissRecovery(): void {
  useRecovery.setState({ items: [] });
}
