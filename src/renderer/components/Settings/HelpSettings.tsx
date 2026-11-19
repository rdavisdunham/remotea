import { useEffect, useState } from 'react';
import { useT } from '../../i18n';
import { PRODUCT } from '../../../shared/product';
import { HELP_TOPICS } from './help-topics';
import { useUpdate } from '../../hooks/useUpdate';

// Help / About panel — shows the running app version and quick links to the
// project's GitHub issues page and website. The version comes from the main
// process (Electron's app.getVersion()) so it always matches the packaged build
// rather than a hardcoded literal. The update button next to it drives the
// same in-app updater as the titlebar badge, so a zip extract can update in
// place without leaving the app for GitHub.
export default function HelpSettings() {
  const t = useT();
  const [query, setQuery] = useState('');
  const topics = HELP_TOPICS.filter((topic) => `${t(topic.title)} ${t(topic.body)}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const [version, setVersion] = useState('');
  const { update, state, upToDate, trigger } = useUpdate();

  useEffect(() => {
    let cancelled = false;
    Promise.resolve(window.remotea?.system?.getVersion?.())
      .then((v?: string) => {
        if (!cancelled && typeof v === 'string') setVersion(v);
      })
      .catch(() => {
        /* version unavailable — leave blank rather than crash the panel */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const openExternal = (url: string) => window.remotea?.system?.openExternal?.(url);

  const busy = state.phase === 'downloading' || state.phase === 'checking';
  const availableVersion = state.version ?? update?.version ?? '';
  let updateLabel = t('settings.help.checkUpdate');
  let updateTitle = t('settings.help.checkUpdate');
  let updateKind: 'secondary' | 'accent' = 'secondary';
  if (state.phase === 'checking') {
    updateLabel = t('titlebar.updateChecking', 'Checking…');
  } else if (state.phase === 'downloading') {
    updateLabel = `${t('settings.help.downloading')} ${state.percent}%`;
    updateTitle = `${t('titlebar.updateDownloading', 'Downloading update')} v${availableVersion} — ${state.percent}%`;
  } else if (state.phase === 'ready') {
    updateLabel = t('titlebar.updateRestart', 'Restart');
    updateTitle = t('titlebar.updateRestartHint', 'Click to restart into the new version');
    updateKind = 'accent';
  } else if (state.phase === 'error') {
    updateLabel = t('titlebar.updateRetry', 'Click to try again');
    updateTitle = state.message
      ? `${t('titlebar.updateFailed', 'Update failed')}: ${state.message}`
      : t('titlebar.updateFailed', 'Update failed');
  } else if (availableVersion) {
    updateLabel = `${t('settings.help.updateTo')} v${availableVersion}`;
    updateTitle = `${t('titlebar.updateAvailable')}: v${availableVersion}`;
    updateKind = 'accent';
  } else if (upToDate) {
    updateLabel = t('settings.help.upToDate');
    updateTitle = t('settings.help.upToDate');
  }

  return (
    <div className="settings-section">
      <h3 className="settings-section-title">{t('settings.help.about')}</h3>

      <div className="settings-row">
        <label className="settings-label">{t('settings.help.version')}</label>
        <div className="settings-help-version">
          <span>{PRODUCT.name}{version ? ` v${version}` : ''}</span>
          <button
            className={`settings-btn ${updateKind === 'accent' ? 'settings-btn--accent' : 'settings-btn--secondary'}`}
            onClick={() => { void trigger(); }}
            disabled={busy}
            title={updateTitle}
          >
            {updateLabel}
          </button>
        </div>
      </div>

      <div className="settings-row">
        <button
          className="settings-btn settings-btn--secondary"
          onClick={() => openExternal(PRODUCT.issuesUrl)}
        >
          {t('settings.help.reportIssue')}
        </button>
        <button
          className="settings-btn settings-btn--secondary"
          onClick={() => openExternal(PRODUCT.documentationUrl)}
        >
          {t('settings.help.website')}
        </button>
      </div>

      <p className="settings-hint">{t('settings.help.hint')}</p>
      <button className="settings-btn settings-btn--secondary" onClick={() => openExternal(PRODUCT.creditsUrl)}>
        {t('settings.help.credits')}
      </button>
      <h3 className="settings-section-title">{t('settings.help.tasks')}</h3>
      <input className="settings-input" type="search" value={query} onChange={(e) => setQuery(e.target.value)}
        aria-label={t('settings.help.search')} placeholder={t('settings.help.search')} />
      {topics.length === 0 && <p className="settings-hint">{t('settings.help.noResults')}</p>}
      {topics.map((topic) => (
        <details key={topic.title} className="settings-row" style={{ display: 'block' }}>
          <summary>{t(topic.title)}</summary>
          <p className="settings-hint">{t(topic.body)}</p>
          <button className="settings-btn settings-btn--secondary" onClick={() => openExternal(`${PRODUCT.repositoryUrl}/blob/main/docs/remotea/help.md#${topic.anchor}`)}>
            {t('settings.help.readMore')}
          </button>
        </details>
      ))}
    </div>
  );
}
