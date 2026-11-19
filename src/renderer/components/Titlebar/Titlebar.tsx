import React from 'react';
// Imported straight from resources/ rather than a copy under src/renderer/assets/
// (issue #137). The copy was the whole bug: the brand moved to the split-pane
// icon in 0.37.0 and every shipped asset followed except this one, so the app
// kept showing its own previous logo in the titlebar. There is now one file —
// and since the mark became three solid bars on a plate, one file is also all
// the art there is: the ≤32px variant this used to point at no longer exists,
// because the current silhouette measures identically at 16px and at 512px.
import logoSrc from '../../../../resources/icons/icon.svg';
import NotificationBell from './NotificationBell';
import UpdateBadge from './UpdateBadge';
import KeepAwakeMenu from './KeepAwakeMenu';
import { IconHelp, IconCode, IconSettings, IconPixelAgent, IconFocus, IconFolder, IconSidebar, IconGitBranch } from './icons';
import WindowControls, { useIsFramelessWindow } from './WindowControls';
import { NotificationInfo, WorkspaceId, PaneId, SurfaceId } from '../../../shared/types';
import { useT } from '../../i18n';
import { useStore } from '../../store';
import { formatBinding } from '../Settings/KeyboardSettings';
import { shortcutTooltip } from '../../shortcuts';
import '../../styles/titlebar.css';

interface TitlebarProps {
  title?: string;
  sidebarVisible: boolean;
  onToggleSidebar: () => void;
  onHelpClick?: () => void;
  onDevToolsClick?: () => void;
  onSettingsClick?: () => void;
  onHubClick?: () => void;
  /** The agent-office easter egg (Settings, General). No pref, no button. */
  hubEnabled?: boolean;
  notifications: NotificationInfo[];
  workspaceNames: ReadonlyMap<string, string>;
  notificationPanelOpen: boolean;
  onToggleNotificationPanel: () => void;
  onNotificationJump: (workspaceId: WorkspaceId, surfaceId: SurfaceId, paneId?: PaneId) => void;
  onMarkAllNotificationsRead: () => void;
  /** Focus mode: every pane but the focused one is dimmed. */
  focusMode?: boolean;
  onToggleFocusMode?: () => void;
  /** File explorer of the active workspace (#324): a mouse way back to the
   *  panel once it has been closed. */
  explorerOpen?: boolean;
  onToggleExplorer?: () => void;
  /** Project Git view (#362) of the active workspace: open beside the focused
   *  pane, or close. Lit while the workspace shows one. */
  gitOpen?: boolean;
  onToggleGit?: () => void;
}

export default function Titlebar({
  title,
  sidebarVisible,
  onToggleSidebar,
  onHelpClick,
  onDevToolsClick,
  onSettingsClick,
  onHubClick,
  hubEnabled,
  notifications,
  workspaceNames,
  notificationPanelOpen,
  onToggleNotificationPanel,
  onNotificationJump,
  onMarkAllNotificationsRead,
  focusMode,
  onToggleFocusMode,
  explorerOpen,
  onToggleExplorer,
  gitOpen,
  onToggleGit,
}: TitlebarProps) {
  const t = useT();
  const shortcuts = useStore((s) => s.shortcuts);
  const sidebarLabel = shortcutTooltip(sidebarVisible
    ? t('sidebar.collapse', 'Collapse sidebar (Ctrl+B)')
    : t('app.expandSidebar', 'Expand sidebar (Ctrl+B)'), shortcuts.toggleSidebar);
  // The tooltip names the CONFIGURED key, not the default: a rebound shortcut
  // advertised as Ctrl+Shift+X would teach the user a key that does nothing.
  const explorerBinding = formatBinding(shortcuts.toggleExplorer);
  const explorerLabel = t('shortcutAction.toggleExplorer', 'Toggle file explorer');
  const gitBinding = formatBinding(shortcuts.openGitPanel);
  const gitLabel = t('titlebar.gitView', 'Toggle Git view');
  // Clear-transparency windows are frameless and have no native caption
  // buttons, so this is where they come from.
  const frameless = useIsFramelessWindow();

  return (
    <div className="titlebar">
      <div className="titlebar__left">
        <img
          src={logoSrc}
          alt="remotea"
          className="titlebar__logo"
          draggable={false}
          style={{ cursor: 'pointer' }}
          onClick={() => window.remotea?.system?.openExternal?.("https://github.com/rdavisdunham/remotea") }
          title="remotea on GitHub"
        />
        <button
          className="titlebar__btn"
          onClick={onToggleSidebar}
          title={sidebarLabel}
          aria-label={sidebarLabel}
          aria-pressed={sidebarVisible}
        >
          <IconSidebar />
        </button>
        <span className="titlebar__sep" aria-hidden="true" />
        {/* What the window shows: the panels beside the terminals. */}
        {onToggleExplorer && (
          <button
            className={`titlebar__btn${explorerOpen ? ' titlebar__btn--active' : ''}`}
            onClick={onToggleExplorer}
            title={explorerBinding ? shortcutTooltip(explorerLabel, shortcuts.toggleExplorer) : explorerLabel}
            aria-label={explorerLabel}
            aria-pressed={!!explorerOpen}
          >
            <IconFolder />
          </button>
        )}
        {onToggleGit && (
          <button
            className={`titlebar__btn${gitOpen ? ' titlebar__btn--active' : ''}`}
            onClick={onToggleGit}
            title={gitBinding ? `${gitLabel} (${t('titlebar.gitViewTab', 'as a tab')}: ${gitBinding})` : gitLabel}
            aria-label={gitLabel}
            aria-pressed={!!gitOpen}
          >
            <IconGitBranch />
          </button>
        )}
        <button
          className={`titlebar__btn${focusMode ? ' titlebar__btn--active' : ''}`}
          onClick={onToggleFocusMode}
          title={t('titlebar.focusMode', 'Focus mode: dim every pane but the focused one')}
          aria-label={t('titlebar.focusMode', 'Focus mode: dim every pane but the focused one')}
          aria-pressed={!!focusMode}
        >
          <IconFocus />
        </button>
      </div>
      <span className="titlebar__title">{title ?? ''}</span>
      {/* The app itself: status, alerts, help and settings. */}
      <div className="titlebar__actions">
        <UpdateBadge />
        <KeepAwakeMenu />
        <NotificationBell
          notifications={notifications}
          workspaceNames={workspaceNames}
          isOpen={notificationPanelOpen}
          onToggle={onToggleNotificationPanel}
          onJump={onNotificationJump}
          onMarkAllRead={onMarkAllNotificationsRead}
        />
        {hubEnabled && (
          <button
            className="titlebar__btn"
            onClick={onHubClick}
            title={t('titlebar.hub', 'Agent office')}
            aria-label={t('titlebar.hub', 'Agent office')}
          >
            <IconPixelAgent />
          </button>
        )}
        <span className="titlebar__sep" aria-hidden="true" />
        <button className="titlebar__btn" onClick={onDevToolsClick} title={t('titlebar.devtools')} aria-label={t('titlebar.devtools')}>
          <IconCode />
        </button>
        <button className="titlebar__btn" onClick={onHelpClick} title={t('titlebar.help')} aria-label={t('titlebar.help')}>
          <IconHelp />
        </button>
        <button
          className="titlebar__btn"
          onClick={onSettingsClick}
          title={shortcutTooltip(t('titlebar.settings'), shortcuts.openSettings)}
          aria-label={t('titlebar.settings')}
        >
          <IconSettings />
        </button>
      </div>
      <div className="titlebar__right">
        {frameless && <WindowControls />}
      </div>
    </div>
  );
}
