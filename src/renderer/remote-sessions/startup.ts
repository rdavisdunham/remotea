/**
 * remotea: first launch on a new device. When the default shell is a remote
 * host that already has sessions, the window starts empty and sync places
 * them (in their shared workspaces) instead of opening a default workspace of
 * brand-new sessions next to them.
 */
import { useStore } from '../store';
import { parseRemoteShellSpec } from '../../shared/remote-shell-spec';
import type { RemoteRegistryView } from '../../shared/remote-hosts-types';

export async function remoteSessionsWillPopulate(timeoutMs = 4000): Promise<boolean> {
  const spec = parseRemoteShellSpec(useStore.getState().workspacePrefs.defaultShell);
  const views = (window as unknown as { wmux?: { remoteSessions?: { views(): Promise<RemoteRegistryView[]> } } }).wmux?.remoteSessions?.views;
  if (!spec || !views) return false;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const view = (await views()).find((v) => v.hostId === spec.hostId);
      if (view?.connected) return view.sessions.some((s) => !s.hiddenBy.includes(view.deviceId));
    } catch {
      return false;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}
