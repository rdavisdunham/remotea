import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../../store';
import { useT } from '../../i18n';
import type { TranslationKey } from '../../i18n';
import { ShortcutAction, ShortcutBinding } from '../../store/settings-slice';
import ShortcutRecorder from './ShortcutRecorder';
import { actionLabel, CATEGORY_LABEL_KEY, CATEGORY_ORDER, formatAccelerator, SHORTCUT_TABLE, type ShortcutCategory } from '../../shortcuts';
import ShortcutFilterCapture from './ShortcutFilterCapture';
import { bindingsEqual } from '../../utils/shortcut-binding';
import {
  INDEX_MODIFIER_CHOICES,
  IndexModifiers,
  formatIndexShortcut,
} from '../../utils/index-shortcuts';

// The labels, categories and key spelling live in ../../shortcuts.ts, the one
// shortcut table every view (this list, the F1 overlay, the command palette,
// tooltips) reads. Re-exported here for the callers that import them from
// Settings.
export { actionLabel, CATEGORY_ORDER, CATEGORY_LABEL_KEY } from '../../shortcuts';

/** English labels by action (from the shortcut table). */
export const ACTION_LABELS: Record<ShortcutAction, string> = Object.fromEntries(
  Object.entries(SHORTCUT_TABLE).map(([action, e]) => [action, e.label]),
) as Record<ShortcutAction, string>;

/** Category of each action (from the shortcut table). */
export const CATEGORY: Partial<Record<ShortcutAction, ShortcutCategory>> = Object.fromEntries(
  Object.entries(SHORTCUT_TABLE).map(([action, e]) => [action, e.category]),
) as Partial<Record<ShortcutAction, ShortcutCategory>>;

/** Render a binding as "Ctrl+Shift+T" (see shortcuts.ts for the vocabulary). '' when unbound. */
export function formatBinding(binding: ShortcutBinding | undefined): string {
  return formatAccelerator(binding);
}

type ShortcutRow = {
  action: ShortcutAction;
  label: string;
  binding: ShortcutBinding;
  category: string;
};

/** Translation key for each modifier mode's dropdown entry. */
const INDEX_MODIFIER_LABEL_KEY: Record<IndexModifiers, TranslationKey> = {
  'ctrl': 'settings.keyboard.indexMods.ctrl',
  'alt': 'settings.keyboard.indexMods.alt',
  'ctrl-alt': 'settings.keyboard.indexMods.ctrlAlt',
  'ctrl-shift': 'settings.keyboard.indexMods.ctrlShift',
  'alt-shift': 'settings.keyboard.indexMods.altShift',
  'off': 'settings.keyboard.indexMods.off',
};

/**
 * One index-shortcut family (issue #202).
 *
 * These are not `ShortcutAction`s and have no `ShortcutRecorder`: recording a
 * combo makes no sense for a binding that spans nine keys. A modifier dropdown
 * is the whole choice — everything else about the family is fixed.
 */
function IndexShortcutRow({ labelKey, labelFallback, value, onChange }: {
  labelKey: TranslationKey;
  labelFallback: string;
  value: IndexModifiers;
  onChange: (next: IndexModifiers) => void;
}) {
  const t = useT();
  return (
    <div className="settings-row">
      <label className="settings-label">{t(labelKey, labelFallback)}</label>
      <select
        className="settings-select"
        value={value}
        onChange={(e) => onChange(e.target.value as IndexModifiers)}
      >
        {INDEX_MODIFIER_CHOICES.map((mode) => (
          <option key={mode} value={mode}>
            {t(INDEX_MODIFIER_LABEL_KEY[mode], formatIndexShortcut(mode) ?? 'Disabled')}
          </option>
        ))}
      </select>
    </div>
  );
}

export default function KeyboardSettings() {
  const t = useT();
  const shortcuts = useStore((s) => s.shortcuts);
  const resetShortcuts = useStore((s) => s.resetShortcuts);
  const keyboardPrefs = useStore((s) => s.keyboardPrefs);
  const setKeyboardPrefs = useStore((s) => s.setKeyboardPrefs);
  const [query, setQuery] = useState('');
  const [bindingFilter, setBindingFilter] = useState<ShortcutBinding | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  // Group + filter, bucketed by category and sorted alphabetically within
  // each bucket, same as the shortcut cheat-sheet's (F1) behaviour. Unlike
  // the cheat sheet, name and shortcut are two independent filters (AND):
  // the text field matches only the translated label, the capture control
  // matches the binding exactly. The number-row families (issue #202) are not
  // ShortcutActions and have no ShortcutRecorder, so neither filter reaches
  // them — they get their own section below the list.
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows: ShortcutRow[] = (Object.entries(shortcuts) as [ShortcutAction, ShortcutBinding][])
      .map(([action, binding]) => ({
        action,
        label: actionLabel(action, t),
        binding,
        category: CATEGORY[action] ?? 'Other',
      }))
      .filter((r) => {
        if (q && !r.label.toLowerCase().includes(q)) return false;
        if (bindingFilter && !bindingsEqual(r.binding, bindingFilter)) return false;
        return true;
      });

    const byCategory = new Map<string, ShortcutRow[]>();
    for (const row of rows) {
      const list = byCategory.get(row.category) ?? [];
      list.push(row);
      byCategory.set(row.category, list);
    }

    return CATEGORY_ORDER
      .filter((c) => byCategory.has(c))
      .map((c) => ({ category: c, rows: byCategory.get(c)!.sort((a, b) => a.label.localeCompare(b.label)) }));
  }, [shortcuts, query, bindingFilter, t]);

  return (
    <div className="settings-section">
      <h3 className="settings-section-title">{t('settings.keyboard.title', 'Keyboard Shortcuts')}</h3>

      <div className="shortcut-search-row">
        <input
          ref={inputRef}
          className="settings-input shortcut-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('settings.keyboard.searchByName', 'Search by name…')}
          aria-label={t('settings.keyboard.searchByName', 'Search by name…')}
        />
        <ShortcutFilterCapture value={bindingFilter} onChange={setBindingFilter} />
      </div>

      {groups.length === 0 ? (
        <div className="shortcut-empty">
          {t('settings.keyboard.noMatch', 'No shortcuts match your search.')}
        </div>
      ) : (
        groups.map((group) => (
          <div key={group.category} className="shortcut-group">
            <h4 className="shortcut-group-title">
              {t(CATEGORY_LABEL_KEY[group.category] ?? 'cheatSheet.category.other', group.category)}
            </h4>
            <div className="shortcut-list">
              {group.rows.map((row) => (
                <div key={row.action} className="shortcut-row">
                  <span className="shortcut-action-label">
                    {row.label}
                  </span>
                  <ShortcutRecorder action={row.action} binding={row.binding} />
                </div>
              ))}
            </div>
          </div>
        ))
      )}

      <div className="settings-divider" />
      <h3 className="settings-section-title">
        {t('settings.keyboard.indexSection', 'Number-row shortcuts')}
      </h3>

      <IndexShortcutRow
        labelKey="settings.keyboard.workspaceIndex"
        labelFallback="Select workspace by number"
        value={keyboardPrefs.workspaceIndexModifiers}
        onChange={(workspaceIndexModifiers) => setKeyboardPrefs({ workspaceIndexModifiers })}
      />
      <IndexShortcutRow
        labelKey="settings.keyboard.surfaceIndex"
        labelFallback="Select tab by number"
        value={keyboardPrefs.surfaceIndexModifiers}
        onChange={(surfaceIndexModifiers) => setKeyboardPrefs({ surfaceIndexModifiers })}
      />

      <p className="settings-hint">
        {t(
          'settings.keyboard.indexHint',
          'The two families can never share the same modifiers — assigning one a combo the other holds swaps them. Number 9 always selects the last workspace or tab, however many there are.',
        )}
      </p>

      <div className="shortcut-footer">
        <button className="settings-btn settings-btn--danger" onClick={resetShortcuts}>
          {t('settings.keyboard.resetAll', 'Reset All')}
        </button>
      </div>
    </div>
  );
}
