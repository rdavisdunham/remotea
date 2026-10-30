/**
 * remotea: the ONE shortcut table (Astra review A-Q2, "unified shortcut
 * language"). Every place that names a shortcut reads it from here: the
 * Settings → Shortcuts list, the F1 overlay, the command palette, and every
 * tooltip or menu hint that mentions a key. Before this, the same binding was
 * spelled three ways (a local formatBinding in the palette, hard-coded
 * "(Ctrl+B)" in tooltip strings that ignored a rebind, "Ctrl+D" literals in a
 * menu) and the labels mixed "surface" and "tab", nouns and verbs.
 *
 * The vocabulary, so a new entry cannot drift:
 *   - Modifiers in a fixed order with the platform's names: Ctrl, Alt
 *     (Option on macOS), Shift, then the key, joined by "+".
 *   - Keys: letters upper-case; Left/Right/Up/Down; Page Up/Page Down; Esc;
 *     Enter; Space; Tab; F-keys and punctuation as themselves.
 *   - Labels: imperative, verb first, sentence case ("Toggle sidebar",
 *     "Go to next tab", "Show all agents"). "New X" is the creation verb.
 *     A tab is a "tab", never a "surface".
 *   - A tooltip is "<label> (<shortcut>)", and only ever names the LIVE
 *     binding: a rebound key advertised at its default teaches a key that
 *     does nothing. Unbound: the label alone.
 */
import type { TranslationKey } from './i18n';
import type { ShortcutAction, ShortcutBinding } from './store/settings-slice';

export type ShortcutCategory = 'Workspaces' | 'Agents' | 'Tabs' | 'Panes' | 'Terminal' | 'View' | 'Other';

export interface ShortcutEntry {
  /** English label, verb first (the fallback for `shortcutAction.<action>`). */
  label: string;
  category: ShortcutCategory;
}

/** Every bindable action, its label and its category. Typed as a full Record: a new action does not compile without a row. */
export const SHORTCUT_TABLE: Record<ShortcutAction, ShortcutEntry> = {
  newWorkspace: { label: 'New workspace', category: 'Workspaces' },
  newWindow: { label: 'New window', category: 'Workspaces' },
  closeWorkspace: { label: 'Close workspace', category: 'Workspaces' },
  closeWindow: { label: 'Close window', category: 'Workspaces' },
  openFolder: { label: 'Open folder', category: 'Workspaces' },
  nextWorkspace: { label: 'Go to next workspace', category: 'Workspaces' },
  prevWorkspace: { label: 'Go to previous workspace', category: 'Workspaces' },
  renameWorkspace: { label: 'Rename workspace', category: 'Workspaces' },
  jumpToUnread: { label: 'Go to latest unread', category: 'Workspaces' },
  togglePinWorkspace: { label: 'Pin or unpin workspace', category: 'Workspaces' },
  markWorkspaceRead: { label: 'Mark workspace read', category: 'Workspaces' },

  jumpToBlocked: { label: 'Go to agent needing you', category: 'Agents' },
  openAgentNavigator: { label: 'Show all agents', category: 'Agents' },
  openHub: { label: 'Open agent office', category: 'Agents' },

  newSurface: { label: 'New tab', category: 'Tabs' },
  nextSurface: { label: 'Go to next tab', category: 'Tabs' },
  prevSurface: { label: 'Go to previous tab', category: 'Tabs' },
  reopenClosedSurface: { label: 'Reopen closed tab', category: 'Tabs' },
  renameSurface: { label: 'Rename tab', category: 'Tabs' },
  openMarkdownPanel: { label: 'New markdown tab', category: 'Tabs' },
  toggleMarkdownSource: { label: 'Toggle markdown source view', category: 'Tabs' },
  openDiffPanel: { label: 'Open diff view', category: 'Tabs' },
  openGitPanel: { label: 'Open Git view', category: 'Tabs' },
  toggleExplorer: { label: 'Toggle file explorer', category: 'Tabs' },

  splitRight: { label: 'Split pane right', category: 'Panes' },
  splitDown: { label: 'Split pane down', category: 'Panes' },
  splitBrowserRight: { label: 'Split browser right', category: 'Panes' },
  splitBrowserDown: { label: 'Split browser down', category: 'Panes' },
  focusLeft: { label: 'Focus pane left', category: 'Panes' },
  focusRight: { label: 'Focus pane right', category: 'Panes' },
  focusUp: { label: 'Focus pane up', category: 'Panes' },
  focusDown: { label: 'Focus pane down', category: 'Panes' },
  resizePaneLeft: { label: 'Resize pane left', category: 'Panes' },
  resizePaneRight: { label: 'Resize pane right', category: 'Panes' },
  resizePaneUp: { label: 'Resize pane up', category: 'Panes' },
  resizePaneDown: { label: 'Resize pane down', category: 'Panes' },
  toggleZoom: { label: 'Toggle pane zoom', category: 'Panes' },
  closeSurfaceOrPane: { label: 'Close tab or pane', category: 'Panes' },
  broadcastInput: { label: 'Toggle broadcast input to all panes', category: 'Panes' },

  find: { label: 'Find', category: 'Terminal' },
  findNext: { label: 'Find next', category: 'Terminal' },
  findPrevious: { label: 'Find previous', category: 'Terminal' },
  copyMode: { label: 'Enter copy mode', category: 'Terminal' },
  copy: { label: 'Copy', category: 'Terminal' },
  paste: { label: 'Paste', category: 'Terminal' },
  fontSizeIncrease: { label: 'Increase font size', category: 'Terminal' },
  fontSizeDecrease: { label: 'Decrease font size', category: 'Terminal' },
  fontSizeReset: { label: 'Reset font size', category: 'Terminal' },
  resetTerminal: { label: 'Reset terminal state', category: 'Terminal' },
  // Issue #207. Terminal rather than View: all three act on one pane's
  // scrollback, not on the window's chrome.
  togglePromptOutline: { label: 'Toggle prompt outline', category: 'Terminal' },
  togglePinnedPrompt: { label: 'Pin or unpin prompt', category: 'Terminal' },
  followOutput: { label: 'Follow output', category: 'Terminal' },

  toggleSidebar: { label: 'Toggle sidebar', category: 'View' },
  showNotifications: { label: 'Show notifications', category: 'View' },
  flashFocused: { label: 'Flash focused pane', category: 'View' },
  openBrowser: { label: 'Toggle browser panel', category: 'View' },
  browserDevTools: { label: 'Toggle browser DevTools', category: 'View' },
  browserConsole: { label: 'Toggle browser console', category: 'View' },
  openSettings: { label: 'Open settings', category: 'View' },
  commandPalette: { label: 'Open command palette', category: 'View' },
  toggleShortcutCheatSheet: { label: 'Show keyboard shortcuts', category: 'View' },
};

/**
 * Fixed keys: not rebindable, but named in tooltips, so spelled by the same
 * rules. (Esc closes every overlay; Ctrl+S saves an edited file.)
 */
export const FIXED_SHORTCUTS = {
  dismiss: { key: 'Escape' },
  save: { key: 's', ctrl: true },
  /** In a find bar's field. */
  nextMatch: { key: 'Enter' },
  previousMatch: { key: 'Enter', shift: true },
} as const satisfies Record<string, ShortcutBinding>;

/** Category order in the F1 overlay and Settings. Every category in SHORTCUT_TABLE appears here. */
export const CATEGORY_ORDER: ShortcutCategory[] = ['Workspaces', 'Agents', 'Tabs', 'Panes', 'Terminal', 'View', 'Other'];

/** Category → its translation key. */
export const CATEGORY_LABEL_KEY: Record<ShortcutCategory, TranslationKey> = {
  Workspaces: 'cheatSheet.category.workspaces',
  Agents: 'cheatSheet.category.agents',
  Tabs: 'cheatSheet.category.tabs',
  Panes: 'cheatSheet.category.panes',
  Terminal: 'cheatSheet.category.terminal',
  View: 'cheatSheet.category.view',
  Other: 'cheatSheet.category.other',
};

export type ShortcutPlatform = 'mac' | 'other';

/** The platform whose modifier names to use. */
export function shortcutPlatform(): ShortcutPlatform {
  const nav = (globalThis as { navigator?: { platform?: string; userAgent?: string } }).navigator;
  const p = `${nav?.platform ?? ''} ${nav?.userAgent ?? ''}`;
  return /Mac|iPhone|iPad/.test(p) ? 'mac' : 'other';
}

const KEY_NAMES: Record<string, string> = {
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  PageUp: 'Page Up',
  PageDown: 'Page Down',
  Escape: 'Esc',
  ' ': 'Space',
  Spacebar: 'Space',
};

/** One key's display name. */
export function keyName(key: string): string {
  if (KEY_NAMES[key]) return KEY_NAMES[key];
  return key.length === 1 ? key.toUpperCase() : key;
}

/** A binding as the user reads it: "Ctrl+Shift+T", "Ctrl+Alt+Left", "F3". '' when unbound. */
export function formatAccelerator(binding: ShortcutBinding | undefined | null, platform: ShortcutPlatform = shortcutPlatform()): string {
  // Tolerates a missing entry: `shortcuts` is DEFAULT_SHORTCUTS spread with
  // whatever was persisted, and a persisted null for an action must not throw.
  if (!binding?.key) return '';
  const parts: string[] = [];
  if (binding.ctrl) parts.push('Ctrl');
  if (binding.alt) parts.push(platform === 'mac' ? 'Option' : 'Alt');
  if (binding.shift) parts.push('Shift');
  parts.push(keyName(binding.key));
  return parts.join('+');
}

/** The English label of an action. */
export function shortcutLabel(action: ShortcutAction): string {
  return SHORTCUT_TABLE[action]?.label ?? action;
}

/** Translated label for an action, falling back to the table's English. */
export function actionLabel(action: ShortcutAction, t: (key: TranslationKey, fallback?: string) => string): string {
  return t(`shortcutAction.${action}` as TranslationKey, shortcutLabel(action));
}

/**
 * A trailing "(…)" that names a key combination, as older tooltip strings
 * (and their translations) carry: "Collapse sidebar (Ctrl+B)", "Close (Esc)".
 */
const TRAILING_SHORTCUT = /\s*\((?:[^()]*\+[^()]*|Esc|F\d{1,2})\)\s*$/;

/**
 * A tooltip: "<label> (<shortcut>)". A shortcut already spelled into the
 * (possibly translated) label is replaced by the live one, so translations
 * written with the default key stay right after a rebind.
 */
export function shortcutTooltip(label: string, binding: ShortcutBinding | undefined | null, platform?: ShortcutPlatform): string {
  const base = label.replace(TRAILING_SHORTCUT, '');
  const keys = formatAccelerator(binding, platform);
  return keys ? `${base} (${keys})` : base;
}

/**
 * Prose that names default shortcuts inline ("Create new ones with
 * Ctrl+N."): swap each default spelling for the live binding.
 */
export function liveShortcutText(
  text: string,
  actions: readonly ShortcutAction[],
  live: Partial<Record<ShortcutAction, ShortcutBinding>>,
  defaults: Partial<Record<ShortcutAction, ShortcutBinding>>,
  platform?: ShortcutPlatform,
): string {
  let out = text;
  for (const action of actions) {
    const was = formatAccelerator(defaults[action], 'other');
    const now = formatAccelerator(live[action] ?? defaults[action], platform);
    if (!was || !now || was === now) continue;
    // Whole combinations only: "Ctrl+T" must not rewrite the start of "Ctrl+Tab".
    const re = new RegExp(`(?<![\\w+])${was.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w+])`, 'g');
    out = out.replace(re, () => now);
  }
  return out;
}
