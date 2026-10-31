import type { ReactNode } from 'react';
import { useT } from '../../i18n';
import type { HostStatus, RemoteRegistryView } from '../../../shared/remote-hosts-types';
import { connectionHealth, tabsHealth, type HealthTone } from '../../remote-sessions/host-health';

/**
 * Settings → Remote hosts, one host's health: the host connection, each tab's
 * terminal process, and the Eridani run in it, each with its own label (see
 * remote-sessions/host-health). Never one badge for all three.
 */

function Chip({ tone, children, kind }: { tone: HealthTone; children: ReactNode; kind: string }) {
  return (
    <span className={`remote-host-chip remote-host-chip--${tone}`} data-kind={kind}>
      <span className="remote-host-chip__dot" />
      {children}
    </span>
  );
}

export default function RemoteHostHealth({ status, view, now }: { status: HostStatus | undefined; view: RemoteRegistryView | undefined; now: number }) {
  const t = useT();
  const conn = connectionHealth(status, now, t);
  const tabs = tabsHealth(view, t);
  const anyRun = tabs.some((tab) => tab.run);
  return (
    <div className="remote-host-health">
      <div className="remote-host-health__row">
        <span className="remote-host-health__kind">{t('health.hostConnection')}</span>
        <Chip tone={conn.tone} kind="connection">{conn.label}</Chip>
        <span className="remote-host-health__detail">{conn.detail}</span>
      </div>
      {tabs.length > 0 && (
        <table className="remote-host-health__tabs">
          <thead>
            <tr>
              <th>{t('health.tab')}</th>
              <th>{t('health.terminalProcess')}</th>
              {anyRun && <><th>{t('activity.runActivity')}</th><th>{t('activity.verification')}</th></>}
            </tr>
          </thead>
          <tbody>
            {tabs.map((tab) => (
              <tr key={tab.id} data-surface={tab.id}>
                <td className="remote-host-health__title">{tab.title}</td>
                <td><Chip tone={tab.process.tone} kind="process">{tab.process.label}</Chip></td>
                {anyRun && (
                  <td>
                    {tab.run ? (
                      <>
                        <Chip tone={tab.run.tone} kind="run">{tab.run.label}</Chip>
                        <span className="remote-host-health__detail">
                          {' '}run {tab.run.runId.slice(0, 8)} · gen {tab.run.generation}
                        </span>
                      </>
                    ) : (
                      <span className="remote-host-health__detail">{t('health.none')}</span>
                    )}
                  </td>
                )}
                {anyRun && <td>{tab.run?.verify || t('activity.notReported')}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {anyRun && <p className="remote-host-health__detail">{t('activity.stateHint')}</p>}
    </div>
  );
}
