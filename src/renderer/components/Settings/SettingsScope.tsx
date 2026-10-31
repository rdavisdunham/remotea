import { useT } from '../../i18n';
import { useStore } from '../../store';
import type { SettingsSection } from './settings-navigation';
export default function SettingsScope({ section }: { section: SettingsSection }) {
  const t = useT();
  const state = useStore();
  const effective = { appearancePrefs: state.appearancePrefs, sidebarPrefs: state.sidebarPrefs, workspacePrefs: state.workspacePrefs, terminalPrefs: state.terminalPrefs, notificationPrefs: state.notificationPrefs, browserPrefs: state.browserPrefs, promptPrefs: state.promptPrefs, keyboardPrefs: state.keyboardPrefs, shortcuts: state.shortcuts };
  return <div className="settings-scope"><p>{t('settings.alignment.scopeBrief')}</p><details><summary>{t("settings.alignment.scopeDetails")}</summary>
    <p>{t("settings.alignment.scopePersistence")}</p>
    <p>{t("settings.alignment.configPrecedence")}</p>
    <p>{t("settings.alignment.restoreAndRuntime")}</p>
    {(section === 'Hosts' || section === 'Remote' || section === 'Agents') && <p>{t("settings.alignment.separateStores")}</p>}
    <details><summary>{t("settings.alignment.inspectEffective")}</summary><p>{t("settings.alignment.provenanceLimits")}</p><pre className="settings-effective">{JSON.stringify(effective, null, 2)}</pre></details>
  </details></div>;
}
