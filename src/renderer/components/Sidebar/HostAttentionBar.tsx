import { useT } from '../../i18n';
import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../../store';
import { startRemoteHostStatus, useRemoteHosts } from '../../remote-sessions/status';
import { useRemoteRegistry } from '../../remote-sessions/registry-cache';
import { hostAttention, type HostAttention } from '../../remote-sessions/host-attention';
import { buildLocalIndex } from '../../remote-sessions/sync';
import { requestFocusSurface } from '../Git/open-git';
import type { SurfaceId, WorkspaceId } from '../../../shared/types';
import '../../styles/remote-hosts.css';

/**
 * remotea: the host attention overview above the workspace list (Astra
 * review A-Q2). One compact row per remote host: its connection, the Eridani
 * runs on it waiting on you, terminals that exited non-zero, and changes made
 * here the host has not confirmed. The row goes to the first tab that needs
 * looking at; the "unconfirmed" chip opens Connections and activity, where
 * each change is listed with a Forget action.
 *
 * Renders nothing when no remote host is configured.
 */

/** Go to a remote tab this window shows. False when it is not here. */
export function focusRemoteTab(surfaceId: string): boolean {
  const surf = buildLocalIndex().surfaces.find((s) => s.id === surfaceId);
  if (!surf) return false;
  requestFocusSurface(surf.workspaceId as WorkspaceId, surfaceId as SurfaceId);
  return true;
}

export function HostAttentionRow({ row, onFocus, onOpenHosts }: {
  row: HostAttention;
  onFocus: (surfaceId: string) => void;
  onOpenHosts?: () => void;
}) {
  const t = useT();
  const firstTab = row.first ? [...row.needsYou, ...row.exitedNonZero].find((t) => t.id === row.first) : undefined;
  const hint = firstTab
    ? t('attention.goTo').replace('{title}', firstTab.title).replace('{detail}', firstTab.kind === 'needs_you' ? t('attention.needsYou') + (firstTab.detail ? `: ${firstTab.detail}` : '') : firstTab.detail ?? '')
    : `${row.hostName}: ${row.connection.label}, ${row.connection.detail}`;
  return (
    <div className="host-attention__row" data-host={row.hostId} data-tone={row.tone}>
      <button className="host-attention__main" disabled={!row.first} onClick={() => row.first && onFocus(row.first)} title={hint}>
        <span className={`remote-host-chip remote-host-chip--${row.connection.tone}`} data-kind="connection">
          <span className="remote-host-chip__dot" />
        </span>
        <span className="host-attention__name">{row.hostName}</span>
        <span className="host-attention__conn">{row.connection.state === 'ready' ? '' : row.connection.label}</span>
        {row.needsYou.length > 0 && (
          <span className="host-attention__count host-attention__count--error" data-kind="needs-you">
            {t(row.needsYou.length === 1 ? 'attention.needsOne' : 'attention.needCount').replace('{count}', String(row.needsYou.length))}
          </span>
        )}
        {row.exitedNonZero.length > 0 && (
          <span className="host-attention__count host-attention__count--pending" data-kind="exited">
            {t('attention.exitedCount').replace('{count}', String(row.exitedNonZero.length))}
          </span>
        )}
      </button>
      {row.unconfirmed > 0 && (
        <button
          className="host-attention__count host-attention__count--pending host-attention__pending"
          data-kind="unconfirmed"
          onClick={() => onOpenHosts?.()}
          title={t('attention.pendingHint').replace('{count}', String(row.unconfirmed)).replace('{host}', row.hostName).replace('{uncertain}', String(row.uncertain))}
        >
          {t('attention.pendingCount').replace('{count}', String(row.unconfirmed))}
        </button>
      )}
    </div>
  );
}

export default function HostAttentionBar({ onOpenHosts }: { onOpenHosts?: () => void }) {
  const t = useT();
  useEffect(() => startRemoteHostStatus(), []);
  const hosts = useRemoteHosts((s) => s.hosts);
  const status = useRemoteHosts((s) => s.status);
  const views = useRemoteRegistry((s) => s.views);
  const workspaces = useStore((s) => s.workspaces);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  const anyHost = Object.keys(hosts).length > 0;
  // buildLocalIndex reads the store; `workspaces` is what changes it.
  const shownHere = useMemo(() => (anyHost ? new Set(buildLocalIndex().surfaces.map((s) => s.id)) : new Set<string>()), [workspaces, anyHost]);
  const rows = useMemo(() => hostAttention(hosts, status, views, shownHere, now, t), [hosts, status, views, shownHere, now, t]);
  if (!rows.length) return null;
  return (
    <div className="host-attention" aria-label={t('settings.tab.hosts')}>
      {rows.map((row) => (
        <HostAttentionRow key={row.hostId} row={row} onFocus={focusRemoteTab} onOpenHosts={onOpenHosts} />
      ))}
    </div>
  );
}
