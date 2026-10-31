import { useT } from '../../i18n';
import { useEffect, useState } from 'react';
import { reconnectRemoteHosts, startRemoteHostStatus, useRemoteHosts } from '../../remote-sessions/status';
import '../../styles/remote-hosts.css';

/**
 * remotea: a banner over a remote pane while its host is not connected.
 *
 * Absolutely positioned and narrow on purpose: the old output stays readable
 * underneath (host process status is unknown; the displayed output is stale).
 * Nothing is typed while it shows — main drops input for a host
 * that is not connected rather than replaying it later.
 */
export default function RemoteOverlay({ hostId }: { hostId: string }) {
  const t = useT();
  useEffect(() => startRemoteHostStatus(), []);
  const loaded = useRemoteHosts((s) => s.loaded);
  const host = useRemoteHosts((s) => s.hosts[hostId]);
  const status = useRemoteHosts((s) => s.status[hostId]);
  const [now, setNow] = useState(() => Date.now());

  const reconnecting = status?.state === 'reconnecting';
  useEffect(() => {
    if (!reconnecting) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [reconnecting]);

  if (!loaded) return null;
  const name = host?.name ?? hostId;
  let text: string;
  let action: 'retry' | null = null;
  let tone: 'info' | 'error' = 'info';
  if (!host) {
    text = t('remote.overlay.missing').replace('{host}', hostId);
    tone = 'error';
  } else if (!status || status.state === 'ready') {
    return null;
  } else {
    switch (status.state) {
      case 'connecting':
        text = t('remote.overlay.connecting').replace('{host}', name);
        break;
      case 'reconnecting': {
        const secs = status.nextRetryAt ? Math.max(0, Math.ceil((status.nextRetryAt - now) / 1000)) : 0;
        text = t('remote.overlay.reconnecting').replace('{host}', name).replace('{retry}', secs ? ` (${secs}s)` : '…');
        if (status.lastSeenAt) text += ' ' + t('remote.overlay.lastSeen').replace('{time}', new Date(status.lastSeenAt).toLocaleString());
        if (status.error) text += ` (${status.error})`;
        action = 'retry';
        break;
      }
      case 'suspended':
        text = t('remote.overlay.suspended').replace('{host}', name);
        break;
      case 'auth-failed':
        text = t('remote.overlay.auth').replace('{host}', name);
        tone = 'error';
        break;
      case 'wrong-server':
        text = t('remote.overlay.identity').replace('{host}', name);
        tone = 'error';
        break;
      case 'incompatible':
        text = t('remote.overlay.incompatible').replace('{host}', name).replace('{error}', status.error ?? '');
        tone = 'error';
        break;
      case 'disabled':
        text = host.hasToken ? t('remote.overlay.disabled').replace('{host}', name) : t('remote.overlay.token').replace('{host}', name);
        tone = 'error';
        break;
      default:
        return null;
    }
  }
  return (
    <div className={`remote-overlay remote-overlay--${tone}`} role="status">
      <span className="remote-overlay__dot" />
      <span className="remote-overlay__text">{text}</span>
      {action === 'retry' && (
        <button className="remote-overlay__button" onClick={() => reconnectRemoteHosts()}>
          {t('remote.retry')}
        </button>
      )}
    </div>
  );
}
