import { useEffect, useState } from 'react';
import { reconnectRemoteHosts, startRemoteHostStatus, useRemoteHosts } from '../../remote-sessions/status';
import '../../styles/remote-hosts.css';

/**
 * remotea: a banner over a remote pane while its host is not connected.
 *
 * Absolutely positioned and narrow on purpose: the old output stays readable
 * underneath (the session is still running on the server; only the view is
 * stale), and nothing is typed while it shows — main drops input for a host
 * that is not connected rather than replaying it later.
 */
export default function RemoteOverlay({ hostId }: { hostId: string }) {
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
    text = `No remote host "${hostId}" is set up here. Add it in Settings → Remote hosts.`;
    tone = 'error';
  } else if (!status || status.state === 'ready') {
    return null;
  } else {
    switch (status.state) {
      case 'connecting':
        text = `Connecting to ${name}…`;
        break;
      case 'reconnecting': {
        const secs = status.nextRetryAt ? Math.max(0, Math.ceil((status.nextRetryAt - now) / 1000)) : 0;
        text = `Reconnecting to ${name}${secs ? ` in ${secs}s` : '…'}${status.error ? ` (${status.error})` : ''}. The session is still running there.`;
        action = 'retry';
        break;
      }
      case 'suspended':
        text = `Paused while this computer sleeps. ${name} keeps the session running.`;
        break;
      case 'auth-failed':
        text = `${name} rejected the token. Update it in Settings → Remote hosts (run "remotea token" on the server).`;
        tone = 'error';
        break;
      case 'wrong-server':
        text = `${name}'s address now reaches a different remotea server. Check the URL in Settings → Remote hosts.`;
        tone = 'error';
        break;
      case 'incompatible':
        text = `${name} runs an incompatible remotea server${status.error ? `: ${status.error}` : ''}. Update the app or the server.`;
        tone = 'error';
        break;
      case 'disabled':
        text = host.hasToken ? `${name} is switched off in Settings → Remote hosts.` : `Add ${name}'s token in Settings → Remote hosts.`;
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
          Retry now
        </button>
      )}
    </div>
  );
}
