import { useState, useEffect, useRef, useMemo } from 'react';
import { useStore } from '../../store';
import { SurfaceId } from '../../../shared/types';
import { IN_APP_BROWSER_ACTIONS, ShortcutAction, ShortcutBinding } from '../../store/settings-slice';
import { actionLabel } from '../Settings/KeyboardSettings';
import { formatAccelerator } from '../../shortcuts';
import { useT } from '../../i18n';
import { RESET_TERMINAL_LEAVE_ALT_ACTION } from '../../utils/alt-screen-owner';
import { useOscTitleLookup, useWorkspaceLabels } from '../SplitPane/use-osc-title';
import { getSurfaceLabel } from '../SplitPane/surface-label';
import { terminalSurfaces } from '../Sidebar/WorkspaceTerminals';
import { requestFocusSurface } from '../Git/open-git';
import { toggleTea } from '../Tea/tea-events';
import { useRemoteRegistry } from '../../remote-sessions/registry-cache';
import { chatActivityState, markChatRead, useLocalChatAttention } from '../../remote-sessions/chat-attention';
import { terminalInsight } from '../../remote-sessions/insight';
import { chatIsUnread, chatStatus } from '../../../shared/chat-attention';
import { surfaceAgentState } from '../../store/agent-rollup';
import '../../styles/command-palette.css';

interface CommandPaletteProps {
  onClose: () => void;
  onAction: (action: string) => void;
}

interface PaletteItem {
  id: string;
  label: string;
  shortcut?: string;
  category: string;
  /** A second, quieter line: what a terminal is doing, where a workspace is. */
  detail?: string;
  /** Right-hand note when there is no shortcut, e.g. a terminal's status. */
  note?: string;
  tone?: string;
  action: () => void;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

// One spelling for every shortcut (shortcuts.ts); this palette used to carry
// its own copy of the formatter.
const formatBinding = (binding: ShortcutBinding): string => formatAccelerator(binding);

// Labels come from the same map Settings and the F1 cheat-sheet read, so the
// three views cannot drift and the palette is translated like everything else.
// It used to de-camelCase the action name locally, which produced English-only
// labels ("Reset Terminal") in every locale — invisible while the action names
// happened to read like prose, and wrong the moment one didn't.

/**
 * How well `needle` fits `haystack`; 0 is no match. A literal hit beats letters
 * scattered through the text, and a hit at the start of a word beats one inside
 * it, so typing a terminal's name puts that terminal first.
 */
function matchScore(needle: string, haystack: string): number {
  if (!needle) return 1;
  const n = needle.toLowerCase();
  const h = haystack.toLowerCase();
  const at = h.indexOf(n);
  if (at === 0) return 100;
  if (at > 0) return /[\s:/\-_.(]/.test(h[at - 1]) ? 80 : 60;
  let ni = 0;
  for (let hi = 0; hi < h.length && ni < n.length; hi++) {
    if (h[hi] === n[ni]) ni++;
  }
  return ni === n.length ? 20 : 0;
}

function itemScore(query: string, item: PaletteItem): number {
  const label = matchScore(query, item.label);
  if (label || !query) return label;
  // A summary or folder is searched literally: letters scattered through a
  // paragraph match nearly anything.
  if (item.detail?.toLowerCase().includes(query.toLowerCase())) return 30;
  return matchScore(query, item.category) ? 10 : 0;
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function CommandPalette({ onClose, onAction }: CommandPaletteProps) {
  const {
    shortcuts, workspaces, activeWorkspaceId, selectWorkspace,
    savedLayouts, createWorkspaceFromLayout, requestLayoutSave,
  } = useStore();
  const t = useT();
  const workspaceLabels = useWorkspaceLabels(workspaces);

  const [themes, setThemes] = useState<string[]>([]);
  useEffect(() => {
    let live = true;
    void window.remotea?.config?.getThemeList?.().then((names: unknown) => {
      if (live && Array.isArray(names)) setThemes(names.filter((name): name is string => typeof name === 'string'));
    }, () => {});
    return () => { live = false; };
  }, []);
  const userSchemes = useStore((state) => state.terminalPrefs.userColorSchemes);
  const oscTitleFor = useOscTitleLookup();
  const agentMeta = useStore((state) => state.agentMeta);
  const agentStates = useStore((state) => state.agentStates);
  const agentDetections = useStore((state) => state.agentDetections);
  const views = useRemoteRegistry((state) => state.views);
  const localAttention = useLocalChatAttention((state) => state.entries);
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Auto-focus input on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Build palette items from all categories
  const allItems = useMemo((): PaletteItem[] => {
    const items: PaletteItem[] = [];

    // Category: Actions — all shortcut actions
    const actionEntries = Object.entries(shortcuts) as [ShortcutAction, ShortcutBinding][];
    const hubEnabled = useStore.getState().appearancePrefs.hubEnabled;
    const inAppBrowser = useStore.getState().browserPrefs.inAppBrowser;
    for (const [action, binding] of actionEntries) {
      // The agent-office easter egg stays out of the palette until enabled, and
      // so do the browser panel's actions while the in-app browser is off.
      if (action === 'commandPalette' || (action === 'openHub' && !hubEnabled)) continue;
      if (!inAppBrowser && IN_APP_BROWSER_ACTIONS.has(action)) continue;
      items.push({
        id: `action:${action}`,
        label: actionLabel(action, t),
        shortcut: formatBinding(binding),
        category: t('palette.category.actions'),
        action: () => onAction(action),
      });
    }

    items.push({ id: 'command:host-activity', label: t('activity.title'), category: t('palette.category.commands'), action: () => onAction('openHostActivity') });
    items.push({
      id: 'command:ask-tea',
      label: t('palette.askTea', 'Ask Dani about your terminals'),
      category: t('palette.category.commands'),
      action: () => { onClose(); toggleTea(); },
    });

    // Sidebar mode has no shortcut; update the same preference as Settings.
    {
      const nextMode = useStore.getState().appearancePrefs.uiMode === 'trace' ? 'classic' : 'trace';
      items.push({
        id: 'command:toggle-ui-mode',
        label: nextMode === 'trace'
          ? t('palette.modeTrace', 'Mode: TRACE — live circuit sidebar')
          : t('palette.modeClassic', 'Mode: Classic sidebar'),
        category: t('palette.category.commands'),
        action: () => {
          useStore.getState().setAppearancePrefs({ uiMode: nextMode });
          onClose();
        },
      });
    }

    // Category: Commands — one-off actions not bound to a shortcut.
    // "Open Markdown File…" picks a file via a native dialog and renders it in a
    // new markdown view (issue #54) — the manual counterpart to `remotea markdown <file>`.
    items.push({
      id: 'command:open-markdown-file',
      label: t('palette.openMarkdown'),
      category: t('palette.category.commands'),
      action: () => {
        onClose();
        void (async () => {
          try {
            const res = await (window as any).remotea?.markdown?.openFile?.();
            if (!res || res.canceled || res.error || !res.content) return;
            const created = (window as any).__remotea_createSurface?.({ type: 'markdown' });
            const surfaceId = created?.surfaceId as string | undefined;
            if (surfaceId) {
              // Derive the basename for the tab label (renderer has no `path`),
              // and keep the full path so the surface is path-aware (issue #116).
              // A file picked from a native dialog is exactly the case where the
              // user may not know where it lives.
              const filePath = String(res.filePath || '') || undefined;
              const fileName = (filePath || '').replace(/\\/g, '/').split('/').pop() || undefined;
              useStore.getState().setMarkdownContent(surfaceId as SurfaceId, res.content, { fileName, filePath, mtimeMs: res.mtimeMs });
            }
          } catch {
            // Dialog/read failures are surfaced via the returned { error }; ignore here.
          }
        })();
      },
    });

    // A project's committed workspace file (#284): main picks the file, shows
    // the trust prompt and brings the panes up — the renderer only asks.
    items.push({
      id: 'command:open-workspace-file',
      label: t('palette.openWorkspaceFile', 'Open workspace file… (remotea.workspace.json)'),
      category: t('palette.category.commands'),
      action: () => {
        onClose();
        (window as any).remotea?.workspaceFile?.open?.()?.catch?.(() => {});
      },
    });

    // Reset terminal state keeps the alternate screen while a program may be
    // drawing on it (#347); this entry leaves it anyway, for a pane whose shell
    // emits no prompt marks (#357). Routed through onAction because the focused
    // terminal is App's to resolve, and App handles this id explicitly.
    items.push({
      id: 'command:reset-terminal-leave-alt',
      label: t('palette.resetTerminalLeaveAlt', 'Reset terminal state (leave alternate screen)'),
      category: t('palette.category.commands'),
      action: () => onAction(RESET_TERMINAL_LEAVE_ALT_ACTION),
    });

    // Category: Layouts — saved pane arrangements
    items.push({
      id: 'command:save-current-layout',
      label: t('palette.saveCurrentLayout', 'Save current layout as new preset'),
      category: t('palette.category.layouts', 'Layouts'),
      action: () => {
        onClose();
        const opened = requestLayoutSave(
          t('settings.workspacePanel.newLayoutName', 'Layout {n}').replace('{n}', String(savedLayouts.length + 1)),
        );
        // false means no active workspace to capture — an edge case, but a
        // silent no-op here would look identical to "worked" from the palette.
        if (!opened) {
          (window as any).remotea?.notification?.fire({
            surfaceId: '',
            text: t('palette.saveCurrentLayoutFailed', 'No active workspace to save as a layout.'),
            title: 'remotea',
          });
        }
      },
    });
    for (const layout of savedLayouts) {
      items.push({
        id: `layout:${layout.id}`,
        label: t('palette.newWorkspaceWithLayout', 'New Workspace: {name}').replace('{name}', layout.name),
        category: t('palette.category.layouts', 'Layouts'),
        action: () => {
          const newId = createWorkspaceFromLayout(layout.id, t);
          if (newId) selectWorkspace(newId);
          onClose();
        },
      });
    }

    // Category: Terminals — jump to any terminal in any workspace by its name,
    // by what Dani says it is doing, or by its folder.
    for (const ws of workspaces) {
      const workspaceName = workspaceLabels.get(ws.id) ?? ws.title;
      for (const surface of terminalSurfaces(ws.splitTree)) {
        const host = views?.find((view) => view.sessions.some((session) => session.id === surface.id));
        const session = host?.sessions.find((item) => item.id === surface.id);
        const declared = agentStates?.[surface.id];
        const detected = agentDetections?.[surface.id];
        const attention = session ? session.chatAttention : localAttention[surface.id];
        const unread = chatIsUnread(attention, host?.deviceId ?? 'local');
        const state = chatActivityState(session, surfaceAgentState(declared, detected)?.state);
        const hasHarness = !!(detected?.agent || declared?.sessionId || declared?.sessionProvider || session?.agent || session?.eridani);
        const status = chatStatus(state, unread, attention?.kind, false, hasHarness);
        const { summary } = terminalInsight(host, session, surface.cwd);
        const quiet = !hasHarness && status.tone === 'idle';
        items.push({
          id: `terminal:${surface.id}`,
          label: getSurfaceLabel(surface, agentMeta.get(surface.id)?.label, ws.shell, t, oscTitleFor(surface.id)),
          category: t('palette.category.terminals', 'Terminals'),
          detail: [workspaceName, summary || surface.currentCwd || surface.cwd].filter(Boolean).join(' — '),
          note: quiet ? undefined : status.label,
          tone: quiet ? undefined : status.tone,
          action: () => {
            requestFocusSurface(ws.id, surface.id);
            markChatRead(surface.id);
            onClose();
          },
        });
      }
    }

    // Category: Workspaces — switch to each workspace by name
    for (const ws of workspaces) {
      const isCurrent = ws.id === activeWorkspaceId;
      const currentSuffix = isCurrent ? ` (${t('palette.current')})` : '';
      items.push({
        id: `workspace:${ws.id}`,
        label: `${workspaceLabels.get(ws.id) ?? ws.title}${currentSuffix}`,
        category: t('palette.category.workspaces'),
        action: () => {
          selectWorkspace(ws.id);
          onClose();
        },
      });
    }

    // These entries update the same preferences as Settings; no placeholder commands.
    for (const mode of ['system', 'dark', 'light'] as const) {
      items.push({ id: `appearance:${mode}`, label: `${t('activity.appTheme')}: ${t(`activity.theme.${mode}`)}`,
        category: t('palette.category.themes'), action: () => { useStore.getState().setAppearancePrefs({ uiTheme: mode }); onClose(); } });
    }
    for (const theme of [...new Set([...themes, ...Object.keys(userSchemes)])].sort()) {
      items.push({ id: `theme:${theme}`, label: `${t('activity.terminalTheme')}: ${theme}`,
        category: t('palette.category.themes'), action: () => { useStore.getState().setTerminalPrefs({ theme }); onClose(); } });
    }

    return items;
  }, [
    shortcuts, workspaces, workspaceLabels, activeWorkspaceId, selectWorkspace, onAction, onClose, t,
    savedLayouts, createWorkspaceFromLayout, requestLayoutSave, themes, userSchemes,
    oscTitleFor, agentMeta, agentStates, agentDetections, views, localAttention,
  ]);

  // Rank against the query, then keep each category together under one heading.
  // With nothing typed the categories keep the order they were built in; once
  // there is a query the category holding the best hit comes first.
  const groups = useMemo(() => {
    const scored = allItems
      .map((item, order) => ({ item, order, score: itemScore(query.trim(), item) }))
      .filter((entry) => entry.score > 0);
    const byCategory = new Map<string, typeof scored>();
    for (const entry of scored) {
      const list = byCategory.get(entry.item.category);
      if (list) list.push(entry);
      else byCategory.set(entry.item.category, [entry]);
    }
    const best = (list: typeof scored) => Math.max(...list.map((entry) => entry.score));
    return [...byCategory.entries()]
      .map(([category, list]) => ({
        category,
        first: list[0].order,
        best: best(list),
        items: [...list].sort((x, y) => y.score - x.score || x.order - y.order).map((entry) => entry.item),
      }))
      .sort((x, y) => (query.trim() ? y.best - x.best : 0) || x.first - y.first);
  }, [allItems, query]);
  const visibleItems = useMemo(() => groups.flatMap((group) => group.items), [groups]);

  // Reset selection when filter changes
  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  // Scroll selected item into view
  useEffect(() => {
    if (!listRef.current) return;
    const selected = listRef.current.querySelector('.command-palette__item--selected');
    if (selected) {
      selected.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIndex]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const last = visibleItems.length - 1;
    if (e.key === 'Escape') {
      onClose();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((i) => (i >= last ? 0 : i + 1));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((i) => (i <= 0 ? Math.max(0, last) : i - 1));
      return;
    }
    if (e.key === 'PageDown' || e.key === 'PageUp') {
      e.preventDefault();
      const step = e.key === 'PageDown' ? 8 : -8;
      setSelectedIndex((i) => Math.max(0, Math.min(last, i + step)));
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const item = visibleItems[selectedIndex];
      if (item) item.action();
    }
  };

  const handleOverlayClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  let row = -1;
  return (
    <div className="command-palette-overlay" onMouseDown={handleOverlayClick}>
      <div className="command-palette" role="dialog" aria-label={t('palette.title', 'Command palette')}>
        <div className="command-palette__search">
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
            <circle cx="7" cy="7" r="4.5" />
            <path d="M10.5 10.5L14 14" />
          </svg>
          <input
            ref={inputRef}
            className="command-palette__input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t('palette.placeholder')}
            role="combobox"
            aria-expanded="true"
            aria-controls="command-palette-results"
            aria-activedescendant={visibleItems[selectedIndex] ? `palette-item-${selectedIndex}` : undefined}
          />
        </div>
        <div className="command-palette__results" id="command-palette-results" role="listbox" ref={listRef}>
          {visibleItems.length === 0 ? (
            <div className="command-palette__empty">{t('palette.empty')}</div>
          ) : (
            groups.map((group) => (
              <div className="command-palette__group" role="group" aria-label={group.category} key={group.category}>
                <div className="command-palette__group-title" aria-hidden="true">{group.category}</div>
                {group.items.map((item) => {
                  const index = ++row;
                  return (
                    <div
                      key={item.id}
                      id={`palette-item-${index}`}
                      role="option"
                      aria-selected={index === selectedIndex}
                      className={`command-palette__item${index === selectedIndex ? ' command-palette__item--selected' : ''}`}
                      onMouseDown={() => item.action()}
                      onMouseMove={() => { if (index !== selectedIndex) setSelectedIndex(index); }}
                    >
                      <span className="command-palette__item-text">
                        <span className="command-palette__item-label">{item.label}</span>
                        {item.detail && <span className="command-palette__item-detail">{item.detail}</span>}
                      </span>
                      {item.note && (
                        <span className="command-palette__item-note" data-tone={item.tone}>{item.note}</span>
                      )}
                      {item.shortcut && (
                        <span className="command-palette__item-shortcut">{item.shortcut}</span>
                      )}
                    </div>
                  );
                })}
              </div>
            ))
          )}
        </div>
        <div className="command-palette__footer">
          <span><kbd>↑</kbd><kbd>↓</kbd> {t('palette.hint.move', 'move')}</span>
          <span><kbd>Enter</kbd> {t('palette.hint.run', 'run')}</span>
          <span><kbd>Esc</kbd> {t('palette.hint.close', 'close')}</span>
        </div>
      </div>
    </div>
  );
}
