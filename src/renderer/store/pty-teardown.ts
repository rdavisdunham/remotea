/**
 * pty-teardown.ts — Central PTY reaping for destructive close transitions (issue #65).
 *
 * PTY lifetime is deliberately decoupled from React unmount so terminal tabs stay
 * alive across workspace/tab switches and split-tree restructures (see the note in
 * `useTerminal` and `App.tsx`). The cost of that design was that shell teardown had
 * been bolted onto only two `PaneWrapper` buttons, so every OTHER close route —
 * Ctrl+W, the CLI (`close-surface`/`close-pane`/`close-workspace`), and closing a
 * workspace from the sidebar — dropped the layout node without killing the shell,
 * leaking a wrapper PowerShell (plus anything it spawned) for the life of the app.
 *
 * The fix routes teardown through the store STATE TRANSITIONS (the single chokepoint
 * every close funnels through) instead of the UI. These helpers are those hooks.
 *
 * No-op for non-terminal surfaces (browser/markdown/diff have no PTY) and in
 * non-Electron contexts (unit tests, where `window` is undefined) so the store
 * stays testable in Node.
 */
import { SplitNode, SurfaceRef } from '../../shared/types';
import { isRemoteShellSpec, parseRemoteShellSpec } from '../../shared/remote-shell-spec';

/**
 * Announced for every surface that is destructively closed.
 *
 * A DOM event rather than a direct store call, purely to keep the module graph
 * acyclic: this file is imported BY the slices, so importing the composed store
 * back would close the loop. Everything that has to forget a surface listens for
 * this instead — it is the same chokepoint the PTY kill uses, so the two cannot
 * disagree about what "closed" means.
 *
 * Note this is close, NOT unmount. A tab that is merely re-parented by a
 * split-tree restructure must keep everything, which is why the React teardown
 * path deliberately does not do this.
 */
export const SURFACE_CLOSED_EVENT = 'wmux:surface-closed';

/** Kill the PTY backing a single terminal surface. Idempotent — the main-process
 *  `PtyManager.kill` no-ops on an unknown/already-dead id, so double-calls (e.g.
 *  a legacy UI kill + the store kill) are harmless. */
export function killSurfacePty(surface: Pick<SurfaceRef, 'id' | 'type'> & { shell?: string }): void {
  announceSurfaceClosed(surface.id);
  if (surface.type !== 'terminal') return;
  try {
    // A remote session's spec lets main close it on its server even when this
    // tab was never mounted (so main never wired it up). Local closes are unchanged.
    const kill = (globalThis as { window?: { remotea?: { pty?: { kill?: (id: string, shellSpec?: string) => void } } } }).window?.remotea?.pty?.kill;
    if (isRemoteShellSpec(surface.shell)) kill?.(surface.id, surface.shell);
    else kill?.(surface.id);
  } catch {
    /* preload/window unavailable (tests) — nothing to reap */
  }
}

/**
 * remotea: a tab removed from THIS device only — its remote session was closed
 * on another device, or hidden here. Per-surface state is dropped exactly as
 * for a close; the PTY is not touched (there is nothing local to kill, and
 * killing would close the session everywhere).
 */
export function forgetSurfaceLocally(surfaceId: string): void {
  announceSurfaceClosed(surfaceId);
}

/** Fired for every surface type: a browser or markdown tab has no PTY but may
 *  still own per-surface state somebody has to drop. */
function announceSurfaceClosed(surfaceId: string): void {
  try {
    (globalThis as { document?: Document }).document?.dispatchEvent(
      new CustomEvent(SURFACE_CLOSED_EVENT, { detail: { surfaceId } }),
    );
  } catch {
    /* no DOM (unit tests) — nothing is listening anyway */
  }
}

/** Walk a split (sub)tree and kill every terminal surface's PTY. Used when a whole
 *  pane or workspace is torn down and all its shells must die at once. */
export function killTreeTerminalPtys(tree: SplitNode): void {
  if (tree.type === 'leaf') {
    for (const surface of tree.surfaces) killSurfacePty(surface);
    return;
  }
  killTreeTerminalPtys(tree.children[0]);
  killTreeTerminalPtys(tree.children[1]);
}

/** Every surface id in a split (sub)tree, all types. */
function collectSurfaceIds(tree: SplitNode, into: Set<string>): Set<string> {
  if (tree.type === 'leaf') {
    for (const surface of tree.surfaces) into.add(surface.id);
  } else {
    collectSurfaceIds(tree.children[0], into);
    collectSurfaceIds(tree.children[1], into);
  }
  return into;
}

/** Close every surface of `outgoing` that `incoming` does not also hold (#361).
 *  Used when the whole layout is swapped at once (Load session): a surface the
 *  incoming layout keeps is re-parented by the keep-alive host (#346) and must
 *  keep its shell, everything else is closed like any other close path. */
export function killDroppedSurfaces(outgoing: SplitNode[], incoming: SplitNode[]): void {
  const kept = new Set<string>();
  for (const tree of incoming) collectSurfaceIds(tree, kept);
  const visit = (tree: SplitNode): void => {
    if (tree.type === 'leaf') {
      for (const surface of tree.surfaces) {
        if (kept.has(surface.id)) continue;
        // remotea: loading a layout on one device must not end sessions other
        // devices are using — a remote tab it drops is hidden here instead
        // (Settings → Remote hosts lists hidden sessions to bring back).
        const remote = parseRemoteShellSpec(surface.shell);
        if (remote && surface.type === 'terminal') {
          announceSurfaceClosed(surface.id);
          hideRemoteSessionHere(remote.hostId, surface.id);
          continue;
        }
        killSurfacePty(surface);
      }
      return;
    }
    visit(tree.children[0]);
    visit(tree.children[1]);
  };
  for (const tree of outgoing) visit(tree);
}

type RemoteSessionsBridge = { groupClose?: (hostId: string, groupId: string) => void; hide?: (hostId: string, surfaceId: string) => void };

function remoteSessions(): RemoteSessionsBridge | undefined {
  try {
    return (globalThis as { window?: { remotea?: { remoteSessions?: RemoteSessionsBridge } } }).window?.remotea?.remoteSessions;
  } catch {
    return undefined;
  }
}

/**
 * remotea: "Hide on this device" for one remote tab — the session keeps
 * running and stays on other devices; main stops streaming it here and
 * records the hide on the server (queued while offline). Never a close.
 * The caller drops the tab (and announces it) itself.
 */
export function hideRemoteSessionHere(hostId: string, surfaceId: string): void {
  remoteSessions()?.hide?.(hostId, surfaceId);
}

/**
 * remotea: close the shared groups a workspace stands for (the inbox is shared
 * by everyone and never closed whole). Ends every session in them on every
 * device, hidden ones and Eridani runs included — only ever reached through
 * closeWorkspace, which user gestures reach only via the remote close dialog.
 */
export function closeRemoteGroups(remoteGroups: Record<string, string>): void {
  for (const [hostId, groupId] of Object.entries(remoteGroups)) {
    if (groupId !== 'grp-inbox') remoteSessions()?.groupClose?.(hostId, groupId);
  }
}
