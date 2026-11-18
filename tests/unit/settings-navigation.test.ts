import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { readFileSync } from 'node:fs';
import { SETTINGS_GROUPS, searchSettings } from '../../src/renderer/components/Settings/settings-navigation';
import { SETTINGS_SEARCH_TERMS, PREFERENCE_FIELDS } from '../../src/renderer/components/Settings/settings-search-index';
import { en } from '../../src/renderer/i18n/locales/en';
import { makeT } from '../../src/renderer/i18n/core';
import { SHORTCUT_TABLE } from '../../src/renderer/shortcuts';
import { boundedInteger, canAddScheme, isValidStartUrl } from '../../src/renderer/components/Settings/settings-validation';

describe('settings navigation compatibility and discovery', () => {
  it('retains every legacy destination once, within nine groups', () => {
    expect(SETTINGS_GROUPS).toHaveLength(9);
    const sections = SETTINGS_GROUPS.flatMap(group => [...group.sections]);
    expect(new Set(sections).size).toBe(sections.length);
    expect(sections).toEqual(expect.arrayContaining(['General', 'Hosts', 'Sidebar', 'Workspace', 'Terminal', 'Prompts', 'Notifications', 'Browser', 'Profiles', 'Shortcuts', 'Remote', 'Changelog', 'Help', 'Agents']));
  });
  it('finds the Dani section (section ID Tea) by its name, its old name, and provider and credential settings', () => {
    for (const query of ['Dani', 'Tea', 'API key', 'Anthropic', 'OpenAI', 'base URL', 'background models']) {
      expect(searchSettings(query)).toContain('Tea');
    }
  });
  it('says Dani, not Tea, in every English string a person reads', () => {
    expect(en['settings.tab.tea']).toBe('Dani');
    expect(en['palette.askTea']).toBe('Ask Dani about your terminals');
    expect(Object.entries(en).filter(([, value]) => /\bTea\b/.test(value))).toEqual([]);
  });
  it('indexes every current preference field from the interfaces', () => {
    const source = ts.createSourceFile('settings.ts', readFileSync('src/renderer/store/settings-slice.ts', 'utf8'), ts.ScriptTarget.Latest, true);
    let count = 0;
    for (const node of source.statements) {
      if (!ts.isInterfaceDeclaration(node) || !(node.name.text in PREFERENCE_FIELDS)) continue;
      const fields = node.members.filter(ts.isPropertySignature).map(member => member.name.getText(source));
      expect(PREFERENCE_FIELDS[node.name.text as keyof typeof PREFERENCE_FIELDS]).toEqual(fields);
      for (const field of fields) expect(searchSettings(field).length).toBeGreaterThan(0);
      count += fields.length;
    }
    expect(count).toBe(88);
  });
  it('finds all shortcuts by shared action ID and human label', () => {
    expect(Object.keys(SHORTCUT_TABLE)).toHaveLength(63);
    for (const [id, entry] of Object.entries(SHORTCUT_TABLE)) {
      expect(searchSettings(id)).toContain('Shortcuts');
      expect(searchSettings(entry.label)).toContain('Shortcuts');
    }
  });
  it('finds feature metadata by the actual English label rather than a translation-key fragment', () => {
    expect(searchSettings('OpenCode status and task plugin')).toContain('Agents');
    expect(searchSettings('Agent instructions')).toContain('Agents');
    expect(searchSettings('Modified differs from this build')).toContain('Agents');
    const plugin = SETTINGS_SEARCH_TERMS.Agents.find(term => term.key === 'settings.integration.orchestrator');
    expect(plugin?.label).toBe('OpenCode status and task plugin');
  });
  it('finds location controls inherited by both workspace defaults and profiles', () => {
    for (const label of ['Execution location', 'Inherit workspace launch', 'Host command empty for login shell']) {
      expect(searchSettings(label)).toEqual(expect.arrayContaining(['Workspace', 'Profiles']));
    }
    expect(searchSettings('changing selection future launches')).toEqual(
      expect.arrayContaining(['Workspace', 'Profiles']),
    );
  });
  it('finds pairing controls and Help topic text from their related components', () => {
    expect(searchSettings('Make a pairing code')).toContain('Remote');
    expect(searchSettings('Control also type and answer agents')).toContain('Remote');
    expect(searchSettings('Pairing QR code')).toContain('Remote');
    expect(searchSettings('Pair a phone')).toContain('Help');
    expect(searchSettings('Pairing credentials differ from host')).toContain('Help');
  });
  it('indexes actual localized labels from related components without losing English search', () => {
    const french = makeT('fr');
    const translate = (key: string, fallback: string) => french(key as keyof typeof en, fallback);
    expect(searchSettings('Lecture seule suivre les terminaux', translate)).toContain('Remote');
    expect(searchSettings('View only watch terminals and agents', translate)).toContain('Remote');
    for (const terms of Object.values(SETTINGS_SEARCH_TERMS)) {
      for (const term of terms) expect(term.label).toBe(en[term.key as keyof typeof en]);
    }
  });
  it('supports old names, translated control labels, AND queries and empty results', () => {
    expect(searchSettings('remote console')).toContain('Remote');
    expect(searchSettings('wmux')).toContain('General');
    expect(searchSettings('eridani integration')).toContain('Agents');
    expect(searchSettings('police géante', (key, fallback) => key === 'settings.terminalPanel.fontSize' ? 'Police géante' : fallback)).toContain('Terminal');
    expect(searchSettings('no-such-preference')).toEqual([]);
  });
});

describe('settings edits validate before replacing preferences', () => {
  it('bounds numeric edits including paste, empty and nonfinite values', () => {
    expect(boundedInteger('999999', 100, 100000)).toBe(100000);
    expect(boundedInteger('-10', 8, 72)).toBe(8);
    expect(boundedInteger('12.7', 8, 72)).toBe(13);
    expect(boundedInteger('Infinity', 8, 72)).toBe(8);
    expect(boundedInteger('', 8, 72)).toBe(8);
  });
  it('does not overwrite bundled or custom schemes when adding a name', () => {
    expect(canAddScheme(' PROD ', ['prod'])).toBe(false);
    expect(canAddScheme('Dark', ['dark'])).toBe(false);
    expect(canAddScheme(' ', [])).toBe(false);
    expect(canAddScheme('staging', ['prod'])).toBe(true);
  });
  it('requires explicit valid start URL while retaining empty/about/custom compatibility', () => {
    for (const url of ['', 'http://localhost:3000', 'https://example.com/a', 'about:blank', 'custom://page']) expect(isValidStartUrl(url)).toBe(true);
    for (const url of ['localhost:3000', 'example.com', 'https://', 'https://[bad']) expect(isValidStartUrl(url)).toBe(false);
  });
});
