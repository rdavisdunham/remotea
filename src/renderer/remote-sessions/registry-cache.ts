/**
 * remotea: the last remote registry views this window heard about.
 *
 * A leaf module (no store import) so the store's close routing and the close
 * dialog can read what sync.ts last received without an import cycle
 * (sync.ts imports the store).
 */
import type { RemoteRegistryView } from '../../shared/remote-hosts-types';

let latest: RemoteRegistryView[] | null = null;
const listeners = new Set<() => void>();

export function setLatestRemoteViews(views: RemoteRegistryView[] | null): void {
  latest = views;
  for (const fn of [...listeners]) {
    try {
      fn();
    } catch {
      /* a listener's failure is its own */
    }
  }
}

/** Called after every registry push (for useSyncExternalStore). Returns the unsubscribe. */
export function subscribeRemoteViews(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** null until the first registry push (or after a test resets it). */
export function latestRemoteViews(): RemoteRegistryView[] | null {
  return latest;
}
