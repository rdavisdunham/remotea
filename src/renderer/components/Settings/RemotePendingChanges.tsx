import { useState } from 'react';
import type { HostPendingChanges } from '../../remote-sessions/pending-changes';

/**
 * Settings → Remote hosts, one host's changes not yet confirmed (Astra review
 * A-Q2): each with what it would do, where it stands, and a Forget action
 * that says what forgetting means. See remote-sessions/pending-changes.
 */
export default function RemotePendingChanges({ host, onForget }: {
  host: HostPendingChanges;
  onForget: (hostId: string, iid: string) => Promise<unknown> | void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const total = host.items.length + host.unlisted;
  return (
    <div className="remote-pending" data-host={host.hostId}>
      <div className="remote-pending__title">
        {total} change{total === 1 ? '' : 's'} made here not yet confirmed by {host.hostName}
        {host.uncertain ? ` (${host.uncertain} unanswered)` : ''}
      </div>
      {host.items.map((item) => (
        <div key={item.iid} className="remote-pending__item" data-state={item.state} data-iid={item.iid}>
          <div className="remote-pending__text">
            <div className="remote-pending__action">{item.action}</div>
            <div className="remote-pending__status">{item.status}</div>
          </div>
          <button
            className="settings-button"
            disabled={busy === item.iid}
            title={item.forgetEffect}
            onClick={async () => {
              setBusy(item.iid);
              try {
                await onForget(item.hostId, item.iid);
              } finally {
                setBusy(null);
              }
            }}
          >
            Forget
          </button>
        </div>
      ))}
      {host.unlisted > 0 && (
        <div className="remote-pending__item">
          <div className="remote-pending__text remote-pending__status">
            {host.unlisted} more not itemised by this build; they are sent when the host is reachable.
          </div>
        </div>
      )}
    </div>
  );
}
