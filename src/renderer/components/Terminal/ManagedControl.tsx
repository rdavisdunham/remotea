import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { getKeyRemaps, subscribeKeyRemaps } from '../../key-remaps';
import { useStore } from '../../store';
import { useT } from '../../i18n';
import type { RemoteRegistryView } from '../../../shared/remote-hosts-types';
import { useRemoteRegistry } from '../../remote-sessions/registry-cache';
import { isTakeoverShortcut, managedSession, takeoverShortcutAvailable, TAKEOVER_SHORTCUT } from '../../remote-sessions/managed-control';
import { isEditableTarget } from '../../hooks/shortcut-target';
import { formatAccelerator } from '../../shortcuts';

export default function ManagedControl({ surfaceId, hostId, active, onTakenOver }: {
  surfaceId: string; hostId: string; active: boolean; onTakenOver: () => void;
}) {
  const t = useT();
  const views = useRemoteRegistry(s => s.views);
  const managed = managedSession(views, surfaceId, hostId);
  const shortcuts = useStore(s => s.shortcuts);
  const remaps = useSyncExternalStore(subscribeKeyRemaps, getKeyRemaps);
  const shortcutAvailable = takeoverShortcutAvailable(shortcuts, remaps);
  const blocked = !!managed && managed.session.eridani?.controller !== 'terminal';
  const [handoff, setHandoff] = useState<'idle' | 'busy' | 'awaiting' | 'retry' | 'error'>('idle');
  const busy = useRef(false);
  const awaitingRegistry = useRef<RemoteRegistryView | undefined>(undefined);
  const registryHost = managed?.host;
  const footer = useRef<HTMLElement>(null);
  const priorBlocked = useRef(blocked);

  useEffect(() => {
    if (priorBlocked.current && managed && !blocked && active) onTakenOver();
    priorBlocked.current = blocked;
  }, [blocked, managed, active, onTakenOver]);

  const takeover = useCallback(async () => {
    if (busy.current || !blocked || !managed?.host.connected || managed.session.state === 'exited') return;
    busy.current = true;
    setHandoff('busy');
    try {
      const result = await window.wmux.remoteSessions.takeover(hostId, surfaceId);
      // Registry confirmation, not this response, removes the read-only gate.
      awaitingRegistry.current = useRemoteRegistry.getState().views?.find(view => view.hostId === hostId);
      setHandoff(result.ok || result.uncertain ? 'awaiting' : 'error');
    } catch {
      setHandoff('error');
    } finally {
      busy.current = false;
    }
  }, [blocked, managed, hostId, surfaceId]);

  useEffect(() => {
    // Only an update received after the RPC settled can resolve uncertainty.
    // An unchanged owner offers an explicit retry, never another automatic RPC
    // and never terminal input. Disconnected/stale snapshots cannot settle it.
    if (handoff === 'awaiting' && blocked && registryHost?.connected && registryHost !== awaitingRegistry.current) {
      setHandoff('retry');
    }
  }, [handoff, blocked, registryHost]);

  useEffect(() => {
    if (!active || !blocked || !shortcutAvailable) return;
    const keydown = (event: KeyboardEvent) => {
      if (!isTakeoverShortcut(event) || event.defaultPrevented) return;
      const pane = footer.current?.closest('.terminal-pane');
      if (!(event.target instanceof Node) || !pane?.contains(event.target)) return;
      if (isEditableTarget(event.target as HTMLElement)) return;
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat && handoff !== 'awaiting') void takeover();
    };
    // Capture before xterm can encode the space as terminal input.
    document.addEventListener('keydown', keydown, true);
    return () => document.removeEventListener('keydown', keydown, true);
  }, [active, blocked, shortcutAvailable, takeover, handoff]);

  if (!blocked || !managed) return null;
  const disabled = !managed.host.connected || managed.session.state === 'exited' || handoff === 'busy' || handoff === 'awaiting';
  const shortcut = shortcutAvailable ? formatAccelerator(TAKEOVER_SHORTCUT) : '';
  return <footer ref={footer} className="managed-control" aria-label={t('managedControl.label')}>
    <div className="managed-control__heading">
      <strong>{t('managedControl.label')}</strong>
      <span>{t('managedControl.browsing')}</span>
    </div>
    <div className="managed-control__row">
      <input disabled className="managed-control__input" aria-label={t('managedControl.input')} placeholder={t('managedControl.input')} />
      <button type="button" disabled={disabled} onClick={() => void takeover()} aria-keyshortcuts={shortcutAvailable ? 'Control+Shift+Space' : undefined} title={t('activity.takeoverHint')}>
        {t(handoff === 'retry' || handoff === 'error' ? 'managedControl.retryAction' : 'managedControl.takeover')}{shortcut && <kbd>{shortcut}</kbd>}
      </button>
    </div>
    <p className="managed-control__status" role="status">
      {!managed.host.connected ? t('managedControl.offline')
        : handoff === 'error' ? t('activity.takeoverFailed')
        : handoff === 'retry' ? t('managedControl.retry')
        : handoff === 'busy' || handoff === 'awaiting' ? t('managedControl.awaiting')
        : managed.session.state === 'exited' ? t('managedControl.ended')
        : t('activity.takeoverHint')}
    </p>
  </footer>;
}
