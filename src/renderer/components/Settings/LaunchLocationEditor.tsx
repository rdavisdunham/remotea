import { useT } from '../../i18n';
import { executionLocationText, executionWarningText } from '../../utils/execution-location-text';
import { useEffect, useId } from 'react';
import { decodeLaunch, encodeLaunch, launchWarnings } from '../../../shared/execution-location';
import { startRemoteHostStatus, useRemoteHosts } from '../../remote-sessions/status';

/** Edits separate launch concepts while retaining existing profiles/layout formats. */
export default function LaunchLocationEditor({ shell, cwd, inherit = false, onChange }: { shell?: string; cwd?: string; inherit?: boolean; onChange: (shell: string) => void }) {
  const t = useT();
  const shellListId = useId();
  useEffect(() => startRemoteHostStatus(), []);
  const { hosts, loaded, loadError } = useRemoteHosts();
  const { location, command } = decodeLaunch(shell);
  const value = inherit && !shell ? '__inherit' : location.kind === 'remote' ? location.hostId : '';
  return <>
    <label>{t('execution.location')} <select className="settings-select" value={value} onChange={(e) => onChange(e.target.value === '__inherit' ? '' : e.target.value ? encodeLaunch({ kind: 'remote', hostId: e.target.value }, '') : 'local:')}>
      {inherit && <option value="__inherit">{t('execution.inherit')}</option>}
      <option value="">{t('execution.local')}</option>
      {value && value !== '__inherit' && !hosts[value] && <option value={value}>{t(loaded && !loadError ? 'execution.missingHost' : 'execution.savedHost').replace('{host}', value)}</option>}
      {Object.values(hosts).map((host) => <option key={host.id} value={host.id}>{host.name}</option>)}
    </select></label>
    <label hidden={value === '__inherit'}>{t(location.kind === 'local' ? 'execution.shell' : 'execution.command')} <input className="settings-input" list={location.kind === 'local' ? shellListId : undefined} value={command} onChange={(e) => onChange(encodeLaunch(location, e.target.value) || 'local:')} /></label>
    <datalist id={shellListId}>{['powershell.exe', 'pwsh.exe', 'cmd.exe', 'bash.exe', 'wsl.exe'].map((command) => <option key={command} value={command} />)}</datalist>
    <p className="settings-hint">{value === '__inherit' ? t('execution.inheritHint') : t('execution.directoryScope').replace('{location}', executionLocationText(t, location, hosts))}</p>
    {value !== '__inherit' && <p className="settings-hint">{t(location.kind === 'local' ? 'execution.localReadiness' : 'execution.hostReadiness')}</p>}
    {launchWarnings(shell, cwd, hosts, loaded && !loadError).map((warning) => <p role="status" className="settings-hint" key={warning}>{executionWarningText(t, warning, location)}</p>)}
  </>;
}
