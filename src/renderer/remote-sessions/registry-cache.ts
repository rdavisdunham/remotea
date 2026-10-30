/**
 * remotea: the last remote registry views this window heard about.
 *
 * A leaf module (no store import) so the store's close routing and the close
 * dialog can read what sync.ts last received without an import cycle
 * (sync.ts imports the store).
 */
import type { RemoteRegistryView } from '../../shared/remote-hosts-types';

let latest: RemoteRegistryView[] | null = null;

export function setLatestRemoteViews(views: RemoteRegistryView[] | null): void {
  latest = views;
}

/** null until the first registry push (or after a test resets it). */
export function latestRemoteViews(): RemoteRegistryView[] | null {
  return latest;
}
