import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { readFileSync } from 'node:fs';
import { SETTINGS_GROUPS, searchSettings } from '../../src/renderer/components/Settings/settings-navigation';
import { PREFERENCE_FIELDS } from '../../src/renderer/components/Settings/settings-search-index';
import { SHORTCUT_TABLE } from '../../src/renderer/shortcuts';
import { boundedInteger, canAddScheme, isValidStartUrl } from '../../src/renderer/components/Settings/settings-validation';

describe('settings navigation compatibility and discovery', () => {
  it('retains every legacy destination once, within nine groups', () => {
    expect(SETTINGS_GROUPS).toHaveLength(9);
    const sections = SETTINGS_GROUPS.flatMap(group => [...group.sections]);
    expect(new Set(sections).size).toBe(sections.length);
    expect(sections).toEqual(expect.arrayContaining(['General', 'Hosts', 'Sidebar', 'Workspace', 'Terminal', 'Prompts', 'Notifications', 'Browser', 'Profiles', 'Shortcuts', 'Remote', 'Changelog', 'Help', 'Agents']));
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
    expect(count).toBe(86);
  });
  it('finds all shortcuts by shared action ID and human label', () => {
    expect(Object.keys(SHORTCUT_TABLE)).toHaveLength(61);
    for (const [id, entry] of Object.entries(SHORTCUT_TABLE)) {
      expect(searchSettings(id)).toContain('Shortcuts');
      expect(searchSettings(entry.label)).toContain('Shortcuts');
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
