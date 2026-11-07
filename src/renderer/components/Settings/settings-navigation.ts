import { SETTINGS_SEARCH_TERMS, PREFERENCE_FIELDS } from './settings-search-index';
import { SHORTCUT_TABLE } from '../../shortcuts';
export const SETTINGS_GROUPS = [
  { label: 'General & appearance', sections: ['General', 'Sidebar'] },
  { label: 'Workspaces & launches', sections: ['Workspace', 'Profiles'] },
  { label: 'Terminal & input', sections: ['Terminal', 'Prompts'] },
  { label: 'Agents & Eridani', sections: ['Agents'] },
  { label: 'Connections', sections: ['Hosts', 'Remote'] },
  { label: 'Browser & files', sections: ['Browser'] },
  { label: 'Notifications & attention', sections: ['Notifications'] },
  { label: 'Keyboard shortcuts', sections: ['Shortcuts'] },
  { label: 'Help & about', sections: ['Help', 'Changelog'] },
] as const;
export type SettingsSection = typeof SETTINGS_GROUPS[number]['sections'][number];
const fieldSections: Record<keyof typeof PREFERENCE_FIELDS, SettingsSection> = {
  AppearancePrefs: 'General',
  SidebarPrefs: 'Sidebar',
  WorkspacePrefs: 'Workspace',
  TerminalPrefs: 'Terminal',
  NotificationPrefs: 'Notifications',
  BrowserPrefs: 'Browser',
  PromptPrefs: 'Prompts',
  KeyboardPrefs: 'Shortcuts',
};
const aliases: Partial<Record<SettingsSection, string>> = {
  Hosts: 'connection ssh server remote host eridani recovery activity tea assistant api provider model summary naming',
  Remote: 'phone access remote console pairing mobile',
  Agents: 'eridani integration consent hooks detection readiness manual status agent',
  Profiles: 'quick launch profiles commands shell location',
  Prompts: 'prompt history sticky outline',
  General: 'appearance theme language wmux transparency',
  Workspace: 'files explorer snapshots restore resume layouts shell directory keep awake',
};
/** AND matching, including translated labels, stable field IDs and compatibility aliases. */
export function searchSettings(
  query: string,
  translate: (key: string, fallback: string) => string = (_, fallback) => fallback,
) {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return SETTINGS_GROUPS.flatMap(group => group.sections).filter(section => {
    const labels = SETTINGS_SEARCH_TERMS[section].flatMap(term => [
      term.key,
      term.label,
      translate(term.key, term.label),
    ]);
    const fields = Object.entries(fieldSections)
      .filter(([, destination]) => destination === section)
      .flatMap(([name]) => PREFERENCE_FIELDS[name as keyof typeof PREFERENCE_FIELDS]);
    const shortcuts = section === 'Shortcuts'
      ? Object.entries(SHORTCUT_TABLE).flatMap(([id, entry]) => [id, entry.label])
      : [];
    const group = SETTINGS_GROUPS.find(group =>
      group.sections.some(candidate => candidate === section),
    );
    const haystack = [
      group?.label ?? '',
      section,
      aliases[section] ?? '',
      ...labels,
      ...fields,
      ...shortcuts,
    ].join(' ').toLocaleLowerCase();
    return words.every(word => haystack.includes(word));
  });
}
