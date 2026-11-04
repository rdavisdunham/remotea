/**
 * Astra review A-Q2, unified shortcut language: one table (src/renderer/
 * shortcuts.ts) that the F1 overlay, Settings, the command palette and every
 * tooltip read, one spelling for a key, one verb form for a label.
 */
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  CATEGORY_LABEL_KEY, CATEGORY_ORDER, FIXED_SHORTCUTS, SHORTCUT_TABLE, formatAccelerator, liveShortcutText, shortcutTooltip,
} from '../../src/renderer/shortcuts';
import { DEFAULT_SHORTCUTS, type ShortcutAction } from '../../src/renderer/store/settings-slice';
import { ACTION_LABELS, CATEGORY, formatBinding } from '../../src/renderer/components/Settings/KeyboardSettings';
import { en } from '../../src/renderer/i18n/locales/en';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** The action names the keyboard hook dispatches (keys of its `handlers` table). */
function handledActions(): string[] {
  const src = read('src/renderer/hooks/useKeyboardShortcuts.ts');
  const start = src.indexOf('const handlers: Partial<Record<ShortcutAction');
  const end = src.indexOf('function handleKeyDown', start);
  expect(start).toBeGreaterThan(0);
  const body = src.slice(start, end);
  return [...body.matchAll(/^ {6}(\w+)(?::|,)/gm)].map((m) => m[1]);
}

describe('the shortcut table', () => {
  it('has exactly one row per registered accelerator (every DEFAULT_SHORTCUTS action)', () => {
    expect(Object.keys(SHORTCUT_TABLE).sort()).toEqual(Object.keys(DEFAULT_SHORTCUTS).sort());
  });

  it('covers every action the keyboard hook dispatches', () => {
    const handled = handledActions();
    expect(handled.length).toBeGreaterThan(40);
    for (const action of handled) expect(SHORTCUT_TABLE, action).toHaveProperty(action);
    // find and copyMode are claimed by the pane, before the table lookup.
    expect(SHORTCUT_TABLE.find).toBeDefined();
    expect(SHORTCUT_TABLE.copyMode).toBeDefined();
  });

  it('puts every category in the overlay order with a label (the Agents shortcuts were missing from F1)', () => {
    for (const [action, e] of Object.entries(SHORTCUT_TABLE)) {
      expect(CATEGORY_ORDER, action).toContain(e.category);
      expect((en as Record<string, string>)[CATEGORY_LABEL_KEY[e.category]], e.category).toBeTruthy();
    }
    expect(SHORTCUT_TABLE.openAgentNavigator.category).toBe('Agents');
  });

  it('Settings and the overlay read it (no second copy of labels or categories)', () => {
    for (const action of Object.keys(DEFAULT_SHORTCUTS) as ShortcutAction[]) {
      expect(ACTION_LABELS[action]).toBe(SHORTCUT_TABLE[action].label);
      expect(CATEGORY[action]).toBe(SHORTCUT_TABLE[action].category);
    }
    const palette = read('src/renderer/components/CommandPalette/CommandPalette.tsx');
    expect(palette).not.toMatch(/parts\.push\('Ctrl'\)/);
  });

  it('the English dictionary says the same as the table', () => {
    for (const [action, e] of Object.entries(SHORTCUT_TABLE)) {
      expect((en as Record<string, string>)[`shortcutAction.${action}`], action).toBe(e.label);
    }
  });

  it('labels use one vocabulary: verb first, sentence case, "tab" never "surface"', () => {
    const verbs = new Set(['New', 'Close', 'Open', 'Go', 'Rename', 'Pin', 'Mark', 'Show', 'Reopen', 'Toggle', 'Split', 'Focus', 'Resize',
      'Find', 'Enter', 'Copy', 'Paste', 'Increase', 'Decrease', 'Refresh', 'Reset', 'Clear', 'Follow', 'Flash']);
    for (const [action, e] of Object.entries(SHORTCUT_TABLE)) {
      expect(verbs, `${action}: "${e.label}"`).toContain(e.label.split(' ')[0]);
      expect(e.label, action).not.toMatch(/surface/i);
      expect(e.label, action).not.toMatch(/ \/ /);
      expect(e.label.slice(1), action).toBe(e.label.slice(1).replace(/\b(Toggle|Open|Close|Go|Show)\b/g, (w) => w.toLowerCase()));
    }
  });
});

describe('one spelling for a key', () => {
  it('modifiers in a fixed order, the platform names, readable key names', () => {
    expect(formatAccelerator({ key: 't', ctrl: true, shift: true }, 'other')).toBe('Ctrl+Shift+T');
    expect(formatAccelerator({ key: 'd', ctrl: true, alt: true, shift: true }, 'other')).toBe('Ctrl+Alt+Shift+D');
    expect(formatAccelerator({ key: 'd', ctrl: true, alt: true }, 'mac')).toBe('Ctrl+Option+D');
    expect(formatAccelerator({ key: 'ArrowLeft', ctrl: true, alt: true }, 'other')).toBe('Ctrl+Alt+Left');
    expect(formatAccelerator({ key: 'PageDown', ctrl: true }, 'other')).toBe('Ctrl+Page Down');
    expect(formatAccelerator({ key: 'Escape' }, 'other')).toBe('Esc');
    expect(formatAccelerator({ key: 'F3', shift: true }, 'other')).toBe('Shift+F3');
    expect(formatAccelerator(undefined)).toBe('');
    expect(formatBinding({ key: 'b', ctrl: true })).toBe(formatAccelerator({ key: 'b', ctrl: true }));
  });

  it('every default and fixed binding formats to something', () => {
    for (const [action, b] of Object.entries(DEFAULT_SHORTCUTS)) expect(formatAccelerator(b, 'other'), action).not.toBe('');
    for (const [name, b] of Object.entries(FIXED_SHORTCUTS)) expect(formatAccelerator(b, 'other'), name).not.toBe('');
  });
});

describe('tooltips name the live binding', () => {
  it('"<label> (<shortcut>)", replacing a default spelled into a translated string', () => {
    expect(shortcutTooltip('Collapse sidebar (Ctrl+B)', { key: 'b', ctrl: true }, 'other')).toBe('Collapse sidebar (Ctrl+B)');
    expect(shortcutTooltip('Collapse sidebar (Ctrl+B)', { key: 'e', ctrl: true, alt: true }, 'other')).toBe('Collapse sidebar (Ctrl+Alt+E)');
    expect(shortcutTooltip('Barre latérale (Ctrl+B)', { key: 'e', ctrl: true, alt: true }, 'other')).toBe('Barre latérale (Ctrl+Alt+E)');
    expect(shortcutTooltip('Close (Esc)', FIXED_SHORTCUTS.dismiss, 'other')).toBe('Close (Esc)');
    expect(shortcutTooltip('Toggle file explorer', { key: 'x', ctrl: true, shift: true }, 'other')).toBe('Toggle file explorer (Ctrl+Shift+X)');
    // Unbound: the label alone, never "()".
    expect(shortcutTooltip('Collapse sidebar (Ctrl+B)', { key: '' }, 'other')).toBe('Collapse sidebar');
    // A parenthetical that is not a shortcut stays.
    expect(shortcutTooltip('Save (draft)', FIXED_SHORTCUTS.save, 'other')).toBe('Save (draft) (Ctrl+S)');
  });

  it('prose swaps whole default combinations only', () => {
    const live = { ...DEFAULT_SHORTCUTS, newSurface: { key: 'y', ctrl: true, alt: true } };
    expect(liveShortcutText('New tabs with Ctrl+T; cycle with Ctrl+Tab.', ['newSurface'], live, DEFAULT_SHORTCUTS, 'other'))
      .toBe('New tabs with Ctrl+Alt+Y; cycle with Ctrl+Tab.');
    expect(liveShortcutText('Ctrl+Alt+B to stop', ['broadcastInput'], DEFAULT_SHORTCUTS, DEFAULT_SHORTCUTS, 'other')).toBe('Ctrl+Alt+B to stop');
  });

  it('no tooltip or menu hint in the renderer hard-codes a shortcut', () => {
    const files = [
      'src/renderer/App.tsx',
      ...['Titlebar/Titlebar.tsx', 'Sidebar/AgentRosterBanner.tsx', 'CheatSheet/ShortcutCheatSheet.tsx', 'Terminal/PromptOutline.tsx',
        'Terminal/FindBar.tsx', 'Code/CodePane.tsx', 'Markdown/MarkdownPane.tsx', 'SplitPane/SurfaceTabBar.tsx'].map((f) => `src/renderer/components/${f}`),
    ];
    const offenders: string[] = [];
    for (const f of files) {
      const lines = read(f).split('\n');
      lines.forEach((line, i) => {
        if (/^\s*(\/\/|\*)/.test(line)) return; // comments
        const names = /\((?:Ctrl|Alt|Shift)\+[^)]*\)|\(Esc\)|>(?:Ctrl|Alt|Shift)\+[^<]*</.test(line);
        // The fallback string may sit on its own line inside the call that rewrites it.
        const statement = lines.slice(Math.max(0, i - 2), i + 3).join('\n');
        if (names && !/shortcutTooltip\(|liveShortcutText\(/.test(statement)) offenders.push(`${f}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
