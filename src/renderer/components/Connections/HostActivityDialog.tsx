import { useEffect, useRef, useState } from 'react';
import type { RemoteConsoleBridge, RemoteConsoleStatus } from '../../../shared/remote-console-config';
import type { RemoteRegistryView } from '../../../shared/remote-hosts-types';
import type { SessionRecord } from '../../../shared/remote-host-protocol';
import { eridaniTabLink } from '../../../shared/eridani-deep-link';
import { useT } from '../../i18n';
import { useRemoteRegistry } from '../../remote-sessions/registry-cache';
import { reconnectRemoteHosts, startRemoteHostStatus, useRemoteHosts } from '../../remote-sessions/status';
import { forgetPendingChange, pendingChanges } from '../../remote-sessions/pending-changes';
import { unhideRemoteSession } from '../../remote-sessions/sync';
import { processHealth } from '../../remote-sessions/host-health';
import RemoteHostHealth from '../Settings/RemoteHostHealth';
import RemotePendingChanges from '../Settings/RemotePendingChanges';
import type { SettingsTab } from '../Settings/SettingsWindow';
import '../../styles/host-activity.css';
import '../../styles/remote-hosts.css';

/** Closed records never become actions; hidden records remain recoverable. */
export function activitySessions(view: RemoteRegistryView | undefined): SessionRecord[] {
  if (!view) return [];
  const closed = new Set(view.closedIds);
  return view.sessions.filter((session) => !closed.has(session.id));
}

export default function HostActivityDialog({ onClose, onSettings }: {
  onClose: () => void;
  onSettings: (tab: SettingsTab) => void;
}) {
  const t = useT();
  const hosts = useRemoteHosts((s) => s.hosts);
  const loaded = useRemoteHosts((s) => s.loaded);
  const status = useRemoteHosts((s) => s.status);
  const views = useRemoteRegistry((s) => s.views);
  const [now, setNow] = useState(Date.now);
  const [phone, setPhone] = useState<RemoteConsoleStatus | null>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const changes = pendingChanges(hosts, status, views);

  useEffect(() => {
    startRemoteHostStatus();
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    const timer = setInterval(() => setNow(Date.now()), 5000);
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        onClose();
      } else if (event.key === 'Tab') {
        const controls = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), [tabindex="0"]',
        ) ?? []);
        const current = controls.indexOf(document.activeElement as HTMLElement);
        const next = (current + (event.shiftKey ? -1 : 1) + controls.length) % controls.length;
        event.preventDefault();
        controls[next]?.focus();
      }
    };
    const containFocus = (event: FocusEvent) => {
      if (event.target instanceof Node && !dialogRef.current?.contains(event.target)) closeRef.current?.focus();
    };
    document.addEventListener('keydown', dismiss, true);
    document.addEventListener('focusin', containFocus);
    return () => {
      clearInterval(timer);
      document.removeEventListener('keydown', dismiss, true);
      document.removeEventListener('focusin', containFocus);
      if (previous?.isConnected) previous.focus();
    };
  }, [onClose]);

  useEffect(() => {
    const bridge = window.wmux?.remoteConsole as RemoteConsoleBridge | undefined;
    let live = true;
    const accept = (value: unknown) => {
      if (live && value && typeof value === 'object' && 'config' in value && 'running' in value) {
        setPhone(value as RemoteConsoleStatus);
      }
    };
    void bridge?.getState?.().then(accept, () => {});
    const off = bridge?.onState?.(accept);
    return () => { live = false; off?.(); };
  }, []);

  const settings = (tab: SettingsTab) => { onClose(); onSettings(tab); };
  return (
    <div className="host-activity__overlay" onClick={onClose}>
      <section ref={dialogRef} className="host-activity" role="dialog" aria-modal="true" aria-labelledby="host-activity-title" onClick={(e) => e.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
        <header className="host-activity__header">
          <h2 id="host-activity-title">{t('activity.title')}</h2>
          <button ref={closeRef} onClick={onClose} aria-label={t('activity.close')}>×</button>
        </header>
        <div className="host-activity__body">
          <section className="host-activity__card">
            <h3>{t('activity.local')}</h3>
            <p>{t('activity.localHint')}</p>
            <button onClick={() => settings('Workspace')}>{t('activity.launchSettings')}</button>
          </section>
          <section className="host-activity__card">
            <h3>{t('activity.phone')}</h3>
            <p>{phone ? (phone.running ? t('activity.phoneRunning') : phone.config.enabled ? t('activity.phoneStopped') : t('activity.phoneOff')) : t('activity.phoneUnknown')}</p>
            <p>{t('activity.phoneHint')}</p>
            <button onClick={() => settings('Remote')}>{t('activity.phoneSettings')}</button>
          </section>
          <div className="host-activity__actions">
            <h3>{t('activity.hosts')}</h3>
            <button onClick={() => settings('Hosts')}>{t('activity.manageHosts')}</button>
            {Object.keys(hosts).length > 0 && <button onClick={reconnectRemoteHosts}>{t('activity.retry')}</button>}
          </div>
          <p>{t('activity.lifetime')}</p>
          {!loaded && <p role="status">{t('activity.loadingHosts')}</p>}
          {loaded && Object.keys(hosts).length === 0 && <p>{t('activity.noHosts')}</p>}
          {Object.values(hosts).map((host) => {
            const view = views?.find((v) => v.hostId === host.id);
            const records = activitySessions(view);
            const hidden = records.filter((s) => view && s.hiddenBy.includes(view.deviceId as SessionRecord['createdBy']));
            const linked = records.flatMap((s) => {
              const link = eridaniTabLink(s);
              return link ? [{ session: s, link }] : [];
            });
            const pending = changes.find((c) => c.hostId === host.id);
            return (
              <section key={host.id} className="host-activity__card" data-host={host.id}>
                <h3>{host.name}</h3>
                <RemoteHostHealth status={status[host.id]} view={view} now={now} />
                {pending && <RemotePendingChanges host={pending} onForget={forgetPendingChange} />}
                {!!status[host.id]?.outbox?.failed.length && <p role="status">{t('activity.failed').replace('{count}', String(status[host.id].outbox!.failed.length))}</p>}
                {hidden.length > 0 && <div className="host-activity__hidden">
                  <h4>{t('activity.hidden')}</h4>
                  {hidden.map((session) => <div key={session.id} className="host-activity__actions">
                    <span>{session.title || session.agent?.provider || session.cmd || t('activity.terminal')}</span>
                    <span>{processHealth(session, view!, t).label}</span>
                    <button onClick={() => unhideRemoteSession(host.id, session.id)}>{t('activity.show')}</button>
                  </div>)}
                  <p>{t('activity.showHint')}</p>
                </div>}
                {linked.length > 0 && <div>
                  <h4>{t('activity.eridani')}</h4>
                  <p>{t('activity.eridaniHint')}</p>
                  {linked.map(({ session, link }) => <div key={session.id} className="host-activity__actions">
                    <span>{session.eridani?.target} · {link.taskTitle || link.taskId || t('activity.standalone')} · {link.runId.slice(0, 8)}</span>
                    <button onClick={() => void window.wmux?.system?.openExternal?.(link.url)}>{t('activity.openRun')}</button>
                  </div>)}
                </div>}
              </section>
            );
          })}
        </div>
      </section>
    </div>
  );
}
