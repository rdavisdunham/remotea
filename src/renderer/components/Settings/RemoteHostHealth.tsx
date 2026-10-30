import type { ReactNode } from 'react';
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
  const conn = connectionHealth(status, now);
  const tabs = tabsHealth(view);
  const anyRun = tabs.some((t) => t.run);
  return (
    <div className="remote-host-health">
      <div className="remote-host-health__row">
        <span className="remote-host-health__kind">Host connection</span>
        <Chip tone={conn.tone} kind="connection">{conn.label}</Chip>
        <span className="remote-host-health__detail">{conn.detail}</span>
      </div>
      {tabs.length > 0 && (
        <table className="remote-host-health__tabs">
          <thead>
            <tr>
              <th>Tab</th>
              <th>Terminal process</th>
              {anyRun && <th>Eridani run</th>}
            </tr>
          </thead>
          <tbody>
            {tabs.map((t) => (
              <tr key={t.id} data-surface={t.id}>
                <td className="remote-host-health__title">{t.title}</td>
                <td><Chip tone={t.process.tone} kind="process">{t.process.label}</Chip></td>
                {anyRun && (
                  <td>
                    {t.run ? (
                      <>
                        <Chip tone={t.run.tone} kind="run">{t.run.label}</Chip>
                        <span className="remote-host-health__detail">
                          {' '}run {t.run.runId.slice(0, 8)} · gen {t.run.generation}{t.run.verify ? ` · ${t.run.verify}` : ''}
                        </span>
                      </>
                    ) : (
                      <span className="remote-host-health__detail">none</span>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
