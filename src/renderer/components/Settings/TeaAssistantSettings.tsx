import { useEffect, useState } from 'react';
import { useT } from '../../i18n';
import {
  startRemoteHostStatus,
  useRemoteHosts,
} from '../../remote-sessions/status';
import TeaSettings from './TeaSettings';

export default function TeaAssistantSettings({
  initialHostId,
  onManageHosts,
}: {
  initialHostId?: string;
  onManageHosts(): void;
}) {
  const t = useT();
  const hosts = useRemoteHosts((state) => state.hosts);
  const status = useRemoteHosts((state) => state.status);
  const loaded = useRemoteHosts((state) => state.loaded);
  const loadError = useRemoteHosts((state) => state.loadError);
  const [hostId, setHostId] = useState(initialHostId || '');
  const available = Object.values(hosts);
  const selected =
    hosts[hostId] ||
    available.find((host) => status[host.id]?.state === 'ready') ||
    available[0];

  useEffect(() => startRemoteHostStatus(), []);
  useEffect(() => {
    if (selected && selected.id !== hostId) setHostId(selected.id);
  }, [selected?.id, hostId]);

  return (
    <div className="settings-section">
      <h3 className="settings-section-title">{t('settings.tea.title')}</h3>
      <p className="settings-hint">{t('settings.tea.description')}</p>
      {!loaded || loadError ? (
        <p role="status">
          {t(loadError ? 'settings.tea.loadError' : 'settings.tea.loading')}
        </p>
      ) : !selected ? (
        <>
          <p>{t('settings.tea.noHosts')}</p>
        </>
      ) : (
        <>
          <div className="settings-row">
            <label className="settings-label" htmlFor="tea-settings-host">
              {t('settings.tea.host')}
            </label>
            <select
              id="tea-settings-host"
              className="settings-select"
              value={selected.id}
              onChange={(event) => setHostId(event.target.value)}
            >
              {available.map((host) => (
                <option key={host.id} value={host.id}>
                  {host.name}
                </option>
              ))}
            </select>
          </div>
          {status[selected.id]?.state !== 'ready' && (
            <p role="status">{t('settings.tea.disconnected')}</p>
          )}
          <TeaSettings
            key={selected.id}
            hostId={selected.id}
            connected={status[selected.id]?.state === 'ready'}
            expanded
          />
        </>
      )}
      <button type="button" className="settings-button" onClick={onManageHosts}>
        {t('settings.tea.manageHosts')}
      </button>
    </div>
  );
}
