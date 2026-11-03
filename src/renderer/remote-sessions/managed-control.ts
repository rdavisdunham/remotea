import type { RemoteRegistryView } from '../../shared/remote-hosts-types';
import type { ShortcutBinding } from '../store/settings-slice';
import type { KeyRemap } from '../../shared/key-sequence';
import { latestRemoteViews } from './registry-cache';
import { bindingsEqual } from '../utils/shortcut-binding';

export const TAKEOVER_SHORTCUT = { key: ' ', ctrl: true, shift: true } as const;

/** Registry ownership is authoritative; RPC success alone never enables input. */
export function managedSession(views: RemoteRegistryView[] | null, surfaceId?: string, hostId?: string) {
  if (!surfaceId) return undefined;
  for (const view of views ?? []) {
    if (hostId && view.hostId !== hostId) continue;
    const session = view.sessions.find(s => s.id === surfaceId);
    if (session?.eridani?.execution === 'managed') return { host: view, session };
  }
  return undefined;
}

export function managedInputBlocked(views: RemoteRegistryView[] | null, surfaceId?: string): boolean {
  const managed = managedSession(views, surfaceId);
  return !!managed && managed.session.eridani?.controller !== 'terminal';
}

export function takeoverShortcutAvailable(shortcuts: Readonly<Record<string, ShortcutBinding | undefined>>, remaps: readonly KeyRemap[] = []): boolean {
  return !Object.values(shortcuts).some(binding => binding && bindingsEqual(binding, TAKEOVER_SHORTCUT))
    && !remaps.some(remap => bindingsEqual(remap.chord, TAKEOVER_SHORTCUT));
}

export function isTakeoverShortcut(event: KeyboardEvent): boolean {
  return (event.key === ' ' || event.key === 'Spacebar') && event.ctrlKey && event.shiftKey
    && !event.altKey && !event.metaKey && !event.isComposing && event.keyCode !== 229;
}

/** All input, including broadcast targets, checks the latest registry at write time. */
export function forwardTerminalInput(source: string | undefined, targets: string[], data: string, write: (id: string, data: string) => void): void {
  const views = latestRemoteViews();
  if (managedInputBlocked(views, source)) return;
  for (const target of targets) {
    if (!managedInputBlocked(views, target)) write(target, data);
  }
}
