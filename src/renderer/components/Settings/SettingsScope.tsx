import { useT, type TranslationKey } from '../../i18n';
import { useStore } from '../../store';
import type { SettingsSection } from './settings-navigation';

const SECTION_SCOPE_KEYS: Record<SettingsSection, TranslationKey> = {
  Tea: 'settings.alignment.scope.Tea',
  General: 'settings.alignment.scope.General',
  Sidebar: 'settings.alignment.scope.Sidebar',
  Workspace: 'settings.alignment.scope.Workspace',
  Profiles: 'settings.alignment.scope.Profiles',
  Terminal: 'settings.alignment.scope.Terminal',
  Prompts: 'settings.alignment.scope.Prompts',
  Agents: 'settings.alignment.scope.Agents',
  Hosts: 'settings.alignment.scope.Hosts',
  Remote: 'settings.alignment.scope.Remote',
  Browser: 'settings.alignment.scope.Browser',
  Notifications: 'settings.alignment.scope.Notifications',
  Shortcuts: 'settings.alignment.scope.Shortcuts',
  Help: 'settings.alignment.scope.Help',
  Changelog: 'settings.alignment.scope.Changelog',
};

export default function SettingsScope({ section }: { section: SettingsSection }) {
  const t = useT();
  const state = useStore();
  // These are renderer snapshots, not readbacks of main-owned stores or files.
  const snapshots: Partial<Record<SettingsSection, object>> = {
    General: { appearancePrefs: state.appearancePrefs, language: state.language },
    Sidebar: { sidebarPrefs: state.sidebarPrefs, uiMode: state.appearancePrefs.uiMode },
    Workspace: { workspacePrefs: state.workspacePrefs, savedLayouts: state.savedLayouts },
    Profiles: { quickLaunchProfiles: state.quickLaunchProfiles },
    Terminal: { terminalPrefs: state.terminalPrefs },
    Prompts: { promptPrefs: state.promptPrefs },
    Browser: { browserPrefs: state.browserPrefs },
    Notifications: { notificationPrefs: state.notificationPrefs },
    Shortcuts: { keyboardPrefs: state.keyboardPrefs, shortcuts: state.shortcuts },
  };
  const effective = snapshots[section];

  return (
    <div className="settings-scope">
      <p className="settings-scope__lead">{t(SECTION_SCOPE_KEYS[section])}</p>
      <details className="settings-scope__more">
        <summary>{t('settings.alignment.scopeDetails')}</summary>
        {effective ? (
          <>
            <p>{t('settings.alignment.scopePersistence')}</p>
            <p>{t('settings.alignment.configPrecedence')}</p>
            <details>
              <summary>{t('settings.alignment.inspectEffective')}</summary>
              <p>{t('settings.alignment.provenanceLimits')}</p>
              <pre className="settings-effective">{JSON.stringify(effective, null, 2)}</pre>
            </details>
          </>
        ) : (
          <p>{t('settings.alignment.noRendererSnapshot')}</p>
        )}
      </details>
    </div>
  );
}
