import { useT } from '../../i18n';
import { useRemoteViews } from '../../remote-sessions/status';

/**
 * remotea: while another device sets a remote terminal's size, this pane shows
 * it at that size, scaled to fit (useTerminal's applyRemoteView). Says so, and
 * offers to take the size over — which focusing or typing in the pane does too.
 */
export default function RemoteSizeBadge({ surfaceId }: { surfaceId: string }) {
  const t = useT();
  const view = useRemoteViews((s) => s.views[surfaceId]);
  if (!view) return null;
  const who = view.ownerName ?? t('remoteView.anotherDevice', 'another device');
  return (
    <div className="remote-size-badge" role="status">
      <span className="remote-size-badge__text">
        {t('remoteView.sizedFor', 'Sized for {device} · {cols}×{rows}')
          .replace('{device}', who)
          .replace('{cols}', String(view.cols))
          .replace('{rows}', String(view.rows))}
      </span>
      <button className="remote-size-badge__fit" onClick={() => window.wmux.pty.focus(surfaceId)}>
        {t('remoteView.fitHere', 'Fit here')}
      </button>
    </div>
  );
}
