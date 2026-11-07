import { useState } from 'react';
import GeneralSettings from './GeneralSettings';
import SidebarSettings from './SidebarSettings';
import WorkspaceSettings from './WorkspaceSettings';
import TerminalSettings from './TerminalSettings';
import NotificationSettings from './NotificationSettings';
import BrowserSettings from './BrowserSettings';
import KeyboardSettings from './KeyboardSettings';
import PromptSettings from './PromptSettings';
import QuickLaunchSettings from './QuickLaunchSettings';
import HelpSettings from './HelpSettings';
import ChangelogSettings from './ChangelogSettings';
import RemoteConsoleSettings from './RemoteConsoleSettings';
import RemoteHostsSettings from './RemoteHostsSettings';
import TeaAssistantSettings from './TeaAssistantSettings';
import { useT, type TranslationKey } from '../../i18n';
import '../../styles/settings.css';
import AgentIntegrationSettings from './AgentIntegrationSettings';
import SettingsScope from './SettingsScope';
import { SETTINGS_GROUPS, searchSettings } from './settings-navigation';

// Historical section IDs remain valid for callers and deep links.
const TABS = ['General', 'Hosts', 'Sidebar', 'Workspace', 'Terminal', 'Prompts', 'Notifications', 'Browser', 'Profiles', 'Shortcuts', 'Remote', 'Changelog', 'Help', 'Agents', 'Tea'] as const;

// Map each tab to its i18n key (issue #56). Typed as TranslationKey, not
// string: the lookup is what reaches t(), so the keys are checked here.
const TAB_LABEL_KEYS: Record<typeof TABS[number], TranslationKey> = {
  Tea: 'settings.tab.tea',
  Agents: 'settings.integration.section',
  General: 'settings.tab.general',
  Hosts: 'settings.tab.hosts',
  Sidebar: 'settings.tab.sidebar',
  Workspace: 'settings.tab.workspace',
  Terminal: 'settings.tab.terminal',
  Prompts: 'settings.tab.prompts',
  Notifications: 'settings.tab.notifications',
  Browser: 'settings.tab.browser',
  Profiles: 'settings.tab.profiles',
  Shortcuts: 'settings.tab.shortcuts',
  Remote: 'settings.tab.remote',
  Changelog: 'settings.tab.changelog',
  Help: 'settings.tab.help',
};

export type SettingsTab = typeof TABS[number];

interface SettingsWindowProps {
  onClose: () => void;
  /** The tab to open on. Read once, at mount; the user can switch away freely. */
  initialTab?: SettingsTab;
  initialHostId?: string;
}

export default function SettingsWindow({ onClose, initialTab, initialHostId }: SettingsWindowProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab ?? 'Terminal');
  const t = useT();
  const [query, setQuery] = useState('');
  const matches = searchSettings(query, (key, fallback) => t(key as TranslationKey, fallback));

  return (
    <div
      className="settings-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="settings-window">
        <div className="settings-header">
          <h2>{t('settings.title')}</h2>
          <button className="settings-close" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="settings-body">
          <div className="settings-tabs">
            <input
              className="settings-input settings-global-search"
              aria-label={t('settings.alignment.searchLabel')}
              placeholder={t('settings.alignment.searchPlaceholder')}
              value={query}
              onChange={event => setQuery(event.target.value)}
            />
            {SETTINGS_GROUPS.map(group => {
              const sections = group.sections.filter(section => matches.includes(section));
              if (sections.length === 0) return null;
              const labelKey = `settings.alignment.group.${group.sections[0]}` as TranslationKey;
              return (
                <div key={group.label} className="settings-nav-group">
                  <h3>{t(labelKey, group.label)}</h3>
                  {sections.map(tab => (
                    <button
                      key={tab}
                      className={`settings-tab ${activeTab === tab ? 'settings-tab--active' : ''}`}
                      onClick={() => setActiveTab(tab)}
                    >
                      {t(TAB_LABEL_KEYS[tab])}
                    </button>
                  ))}
                </div>
              );
            })}
            {matches.length === 0 && (
              <p className="settings-hint" role="status">
                {t('settings.alignment.noMatch')}
              </p>
            )}
          </div>
          <div className="settings-content">
            <SettingsScope section={activeTab} />
            {activeTab === 'Agents' && (
              <div className="settings-section">
                <h3>{t('settings.alignment.agentsTitle')}</h3>
                <p className="settings-hint">{t('settings.alignment.integrationScope')}</p>
                <p className="settings-hint">{t('settings.alignment.eridaniAuthority')}</p>
                <p className="settings-hint">{t('settings.alignment.activityHints')}</p>
                <AgentIntegrationSettings />
              </div>
            )}
            {activeTab === 'General' && <GeneralSettings />}
            {activeTab === 'Hosts' && <RemoteHostsSettings />}
            {activeTab === 'Tea' && <TeaAssistantSettings initialHostId={initialHostId} onManageHosts={() => setActiveTab('Hosts')}/>}
            {activeTab === 'Sidebar' && <SidebarSettings />}
            {activeTab === 'Workspace' && <WorkspaceSettings />}
            {activeTab === 'Terminal' && <TerminalSettings />}
            {activeTab === 'Prompts' && <PromptSettings />}
            {activeTab === 'Notifications' && <NotificationSettings />}
            {activeTab === 'Browser' && <BrowserSettings />}
            {activeTab === 'Profiles' && <QuickLaunchSettings />}
            {activeTab === 'Shortcuts' && <KeyboardSettings />}
            {/* Mounted only while selected (#254): its getState/onState pair
                is a live subscription to main, and nobody reading the font
                settings needs remote-console pushes re-rendering this window. */}
            {activeTab === 'Remote' && <RemoteConsoleSettings />}
            {/* Mounted only while selected, so opening Settings never fires the
                GitHub fetch for a user who came here to change their font. */}
            {activeTab === 'Changelog' && <ChangelogSettings />}
            {activeTab === 'Help' && <HelpSettings />}
          </div>
        </div>
      </div>
    </div>
  );
}
