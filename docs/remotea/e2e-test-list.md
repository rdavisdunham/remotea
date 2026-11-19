# End-to-end test list

One pass on real machines after the wmux cleanup. It covers the UI refresh (never tested outside the isolated test app) and everything the cleanup changed. Run a packaged build, not the dev server, with a real mouse and keyboard, on a high-DPI display if you have one.

Tick items as you go. Anything that fails goes in an issue with the step number.

## 1. The move

Do these first, in this order. Quit remotea from the tray before starting.

1. On Windows, in your checkout: `git pull`, `npm ci`, then `npm run move`. Read what it reports.
2. On each host: `git pull`, `npm run build` in `remote-server`, then `remotea upgrade` and `remotea move`. The upgrade restarts the host server, which can end that host's running terminals.
3. Start remotea. Confirm your hosts, workspaces, layouts, launch profiles and shortcuts survived, and that no "old names" notice shows.
4. Reopen every host terminal that was open before the move. In each, start an agent and confirm it shows status (working, needs you, done).
5. Rename any `.wmux.json`, `wmux.workspace.json` or `.wmux/workspace.json` in your own repositories by hand (`.remotea.json`, `remotea.workspace.json`, `.remotea/workspace.json`). Open those projects and confirm the workspace loads.
6. From now on run only builds made after the move. An older build reads the old names.

## 2. Commands and hooks

1. On a host, run `remotea` inside a remotea terminal and in a plain SSH shell. Both show help. Inside the terminal, `remotea identify` answers too.
2. On a Windows machine that also has wmux installed, turn on Settings → Agent integration. Confirm wmux's own entries in `%USERPROFILE%\.claude\settings.json` are unchanged and remotea's sit beside them. Turn it off again: only remotea's entries go.
3. Agents report status from every integration you use: Claude Code, Codex, OpenCode, pi, Grok, Qwen, agy.

## 3. First launch (clean profile)

1. No hook-install prompt appears.
2. The seven-step tour appears. Arrow keys, Esc and the dots work. "Add a host" opens Settings on Remote hosts.
3. The agent office is off, and turning it on in Settings brings back its titlebar button.

## 4. Remote hosts

1. Add, pair, edit and remove a real host on the Remote hosts screen. The host health readout is correct.

## 5. Tea

1. A real conversation with a configured provider: replies render, terminal names replace `surf-…` ids, "Open <terminal>" chips jump to the right terminal, Stop turn works.
2. The three starter prompts, the "Tea off" and "model untested" empty states, and the host picker with two or more hosts.
3. Tea titles in tabs and the summary strip on real sessions. A plain shell shows no "No harness detected".

## 6. Command palette

1. Jump to a terminal in another workspace by name, by Tea summary and by folder. Status notes show with real agents running.
2. "Ask Tea about your terminals" with the sidebar hidden.

## 7. Titlebar

1. The update badge, in its right-hand position, through available, downloading and ready.
2. The notification panel with real notifications, including jump, and the keep-awake menu. Both open leftwards.
3. A window with transparency cleared (frameless): the caption buttons sit beside the right-hand cluster.
4. A narrow window: the title truncates and nothing overlaps.

## 8. Settings

1. Every section still saves. Switches flip, and so does clicking a row's label.
2. Escape closes the window, but not while recording a shortcut, typing in a field, or with the phone-pairing dialog open.
3. Search, Tea settings, the changelog fetch and the light theme.
4. Switch the language to Czech, Traditional Chinese and French in turn. Every screen you open says remotea, never wmux.

## 9. Phone console

1. Re-pair your phone (phones paired before the rename have to pair again).
2. Use the phone console once: see the agent list, answer a question an agent asks.

## 10. File explorer and Git

1. In a real repository with changes: +/- counts, the totals bar, the Git button, the hidden-files toggle, keyboard navigation and the right-click menu.
2. The explorer on a remote host session.
3. The Git view on a repository with several worktrees, a conflict and a long history: Branch compare, "Go to terminal", and a narrow split.
4. Light theme: the Git view and the Diff tab.

## 11. Browser panel

1. Open the browser panel. It starts on your Start page or a blank page, never on the wmux GitHub page.
2. Drag a browser tab to another pane.

## Dropped from this list

The legacy orchestrator was removed, so nothing here tests it.
