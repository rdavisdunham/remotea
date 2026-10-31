import { useT } from '../../i18n';
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
  const t = useT();
  const [result, setResult] = useState<'acknowledged' | 'failed' | 'unconfirmed' | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const total = host.items.length + host.unlisted;
  return (
    <div className="remote-pending" data-host={host.hostId}>
      <div className="remote-pending__title">
        {t('pending.title').replace('{count}', String(total)).replace('{host}', host.hostName)}
        {host.uncertain > 0 && ` (${t('pending.unanswered').replace('{count}', String(host.uncertain))})`}
      </div>
      {host.items.map((item) => (
        <div key={item.iid} className="remote-pending__item" data-state={item.state} data-iid={item.iid}>
          <div className="remote-pending__text">
            <div className="remote-pending__action">{item.action}</div>
            <div className="remote-pending__status">{item.status}</div>
          </div>
          <button
            className="settings-button"
            disabled={busy !== null}
            title={item.forgetEffect}
            onClick={async () => {
              setBusy(item.iid);
              setResult(null);
              try {
                const response = await onForget(item.hostId, item.iid);
                setResult(response === true ? 'acknowledged' : response === false ? 'failed' : 'unconfirmed');
              } catch {
                setResult('failed');
              } finally {
                setBusy(null);
              }
            }}
          >
            {t('pending.forget.action')}
          </button>
        </div>
      ))}
      {result && <p role="status" aria-live="polite">{result === 'acknowledged' ? t('pending.result.acknowledged') : result === 'failed' ? t('pending.result.failed') : t('pending.result.unconfirmed')}</p>}
      {host.unlisted > 0 && (
        <div className="remote-pending__item">
          <div className="remote-pending__text remote-pending__status">
            {t('pending.unlisted').replace('{count}', String(host.unlisted))}
          </div>
        </div>
      )}
    </div>
  );
}
