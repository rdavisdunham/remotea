/**
 * remotea: the last remote registry views this window heard about.
 *
 * A leaf module (no store import) so the store's close routing and the close
 * dialog can read what sync.ts last received without an import cycle
 * (sync.ts imports the store). Also a tiny zustand store, so the host
 * attention row and the sidebar's run chips re-render on each push.
 */
import { create } from 'zustand';
import type { RemoteRegistryView } from '../../shared/remote-hosts-types';

export const useRemoteRegistry = create<{ views: RemoteRegistryView[] | null }>(() => ({ views: null }));

export function setLatestRemoteViews(views: RemoteRegistryView[] | null): void {
  useRemoteRegistry.setState({ views });
}

/** Called after every registry push (for useSyncExternalStore). Returns the unsubscribe. */
export function subscribeRemoteViews(fn: () => void): () => void {
  return useRemoteRegistry.subscribe(() => {
    try {
      fn();
    } catch {
      /* a listener's failure is its own */
    }
  });
}

/** null until the first registry push (or after a test resets it). */
export function latestRemoteViews(): RemoteRegistryView[] | null {
  return useRemoteRegistry.getState().views;
}
