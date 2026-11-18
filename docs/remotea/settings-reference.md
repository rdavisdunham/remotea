# Remotea settings reference

Updated 2026-10-31 for the app alignment release. This catalogue covers all 86 existing fields in the eight renderer preference objects, all 61 rebindable actions, and separate host, phone, integration and file-owned configuration. Preferences, compatibility keys and factory defaults are preserved. This is a source reference, not an inspection of your installed settings or live hosts.

The detailed field inventory was reconciled against `b31f92c4a78b064b64f467200da3be2ac8f48b9c`. Source line citations below are pinned to that baseline and identify each field’s implementation origin, not its current line number or a guarantee that historical labels are unchanged. The behavior and labels in this document describe the alignment release unless explicitly marked as baseline observations. New controls and changed behavior are described here and in the relevant sections. Historical control-node counts are not preference counts.

[Task help](help.md) · [Alignment and preservation contract](alignment.md)

## Navigation and finding a setting

Search matches translated labels, compatibility aliases, field names and shortcut names. Existing section IDs and deep links remain valid; Settings still opens Terminal by default.

| Group | Section IDs and contents |
|---|---|
| General & appearance | `General`: app appearance and OS actions; `Sidebar`: sidebar and status presentation |
| Workspaces & launches | `Workspace`: defaults, lifecycle, files and layouts; `Profiles`: named launch profiles |
| Terminal & input | `Terminal`: font, rendering and input; `Prompts`: prompt history and presentation |
| Agents & Eridani | `Agents`: desktop integration consent/features, file effects and separate Eridani authority |
| Connections | `Hosts`: execution host definitions; `Remote`: Phone access, pairing and permissions |
| Browser & files | `Browser`: desktop browser engines and preferences; file-explorer preferences remain in Workspace and searchable there |
| Notifications & attention | `Notifications`: attention, sound and badges |
| Keyboard shortcuts | `Shortcuts`: action bindings and both number-row families |
| Help & about | `Help`: searchable task help, product links and updates; `Changelog`: release history |

Each section explains ownership and apply time. Renderer sections can show their effective in-memory values. The current load API does not record a per-field source chain: the inspector explicitly reports that it cannot distinguish default, saved setting, TOML override or snapshot provenance. Host credentials, phone pairing and integration files are not dumped into this inspector.

New/changed controls:

- Location and shell are separate choices for workspace defaults and terminal profiles. “This computer” can explicitly choose its system shell even inside a host workspace; the compatibility representation is `local:`. Existing bare shell strings and `remote:<host> [command]` remain supported.
- Profile and layout previews identify missing hosts and host-path incompatibilities. Commands are not rewritten for another operating system. Host list failure means unknown availability, not a deleted host.
- Font size and scrollback enforce their displayed bounds; duplicate color scheme names cannot overwrite an existing scheme through Add. Browser start URLs validate before persisting.
- Shortcut Reset All also resets the two number-row shortcut families; the recorder shares the same formatter as live hints.
- Connections and activity is available from the sidebar and command palette. It shows independent host connection, terminal process, agent activity, verification, hidden sessions and pending changes, with links to configuration and Eridani.
- Agent integration is its own page. Configuration consent and observed integration files are separate from runtime readiness; the page does not enable native desktop Eridani execution.


### New controls and operational entry points

These are actions, readouts or alternate editors for existing fields, not new renderer preference fields.

| Control | Location and behavior |
|---|---|
| Search settings / result navigation | Settings header; translated labels, field names, aliases and shortcut names lead to retained section IDs |
| Scope, apply time & effective preferences | Each section; expands persistence/precedence help. Renderer-backed sections also offer **Inspect effective preferences in this window**, a read-only JSON snapshot with explicit provenance limits |
| Execution location / Shell or Command | Workspace defaults and terminal launch profiles; separate editors for the existing shell representation. Profiles additionally offer inheritance. Local suggestions are fixed Windows choices; missing hosts and invalid host directories have compatibility warnings |
| Layout compatibility readouts | Saved layout entries identify each tab’s location/directory and missing-host/path warnings; commands are preserved |
| Search help / expandable task topics / Read task guide | Help; filters task descriptions and opens the matching published guide. Separate Remotea issue/documentation/credits links; installed version and updater remain available |
| Connections and activity | Sidebar action and command palette; separate desktop-local and Phone access summaries, host connection/process/activity/verification readouts, and configuration links |
| Manage hosts / Retry connections / Phone access settings / Launch settings | Connections and activity; configuration deep links and connection retry, not execution/readiness tests |
| Hidden sessions / Show here | Connections and activity and Remote hosts; source-bound host view recovery without starting a new task/run. Offline state remains last known |
| Pending changes / Forget | Both connection surfaces; per-intent consequences and acknowledged, failed or unconfirmed local removal. Already applied host effects are never undone by Forget |
| Failed change count | Connections and activity; refers users to the host settings detail. **Dismiss** in host settings clears the failure report rather than retrying execution |
| Open this run in Eridani | Connections and activity; only usable bound links are offered; verification, approval and task decisions remain in Eridani |
| Sidebar activity override | Workspace context menu; auto/running/idle affects presentation only, not process state or Eridani acceptance |
| App theme / Terminal scheme palette entries | Command palette; update the same appearance/terminal preferences as Settings. Rebound shortcut actions use semantic app-action handlers, not synthesized default keypresses |


## Scope, storage, and precedence

All relative paths below are relative to the reviewed source root. `S` means `src/renderer/store/settings-slice.ts`; `UI/<Name>` means `src/renderer/components/Settings/<Name>Settings.tsx`; line numbers are at the reviewed commit. Tables use **on/off** for booleans, with default shown first where appropriate. Defaults are source defaults for a new profile, not the user's current choices. Unless stated otherwise, a setting persists immediately when edited, affects the current renderer without an application restart, and is local to the desktop installation/user/instance; it does not configure Eridani or a remote server.

The 13 legacy internal section IDs remain, with `Agents` added for the moved integration panel. **Hosts renders “Remote hosts”** in English; Settings initially opens **Terminal**, unless its caller supplies an initial tab. Only the selected panel mounts (`SettingsWindow.tsx:23,27,52,82`). Remote hosts and Phone access have complete sections below; cross-tab preference fields are also identified where stored.

Settings are loaded once into each renderer from main's `settings.json`, with legacy localStorage fallback and migration. Writes update renderer state and send IPC to main (`S:49–126,1433–1552`; `src/preload/index.ts:285–294`; `src/main/ipc-handlers.ts:1302–1307`). Main stores under `getAppDataDir()/settings.json` (`src/main/settings-store.ts:14,18,29`); actual base name is **remotea**, not the stale remotea prose in that file. On Windows this is `%APPDATA%/remotea[-instance]`; current fallback on other OSs is `~/AppData/Roaming/remotea[-instance]`, not a native Mac Application Support path (`src/shared/instance.ts:27`). The file is installation/user/instance scoped, while each window has its own in-memory renderer preference snapshot; generic preference writes are not visibly broadcast by the `settings:set` handler. Keep-awake explicitly is main-owned and broadcast. Do not describe every setting as automatically synchronized across desktop windows, remote devices, or Eridani.

| Renderer store | settings.json key | Source |
|---|---|---|
| workspacePrefs | `remotea-workspace-prefs` | S:31,482,643 |
| terminalPrefs | `remotea-terminal-prefs` | S:32,687,743 |
| sidebarPrefs | `remotea-sidebar-prefs` | S:33,421,466 |
| notificationPrefs | `remotea-notification-prefs` | S:34,760,780 |
| browserPrefs | `remotea-browser-prefs` | S:35,795,845 |
| shortcuts | `remotea-shortcuts` | S:36,210 |
| shortcut-default migration metadata | `remotea-shortcut-defaults` | S:37,353 |
| quickLaunchProfiles | `remotea-quick-launch-profiles` | S:38,1540 |
| savedLayouts | `remotea-saved-layouts` | S:39,1545 |
| language | `remotea-language` | S:40,100,1550 |
| appearancePrefs | `remotea-appearance-prefs` | S:41,1150,1255 |
| keyboardPrefs | `remotea-keyboard-prefs` | S:42,1074,1081 |
| promptPrefs | `remotea-prompt-prefs` | S:43,871,950 |

Additional stores: `agentIntegration` in settings.json (`src/main/agent-integration.ts:94`); `remotea-keep-awake` in settings.json (`src/main/awake-manager.ts:29`); Windows Explorer registry entries rather than an application boolean; custom notification audio under `getAppDataDir()/notification-sounds/custom.<extension>`; TOML and locales in `~/.remotea/`; detection overrides under `getAppDataDir()/agent-detection`; project profiles in `<workspace cwd>/.remotea.json`. Remote hosts and phone access have separate stores documented below.

`~/.remotea/config.toml` wins for **present supported keys** at startup and `remotea reload-config`; subsequent UI changes win for the running session and also persist to settings.json. UI edits do not rewrite TOML. Deleting a TOML key does not generally undo the persisted value it previously applied. Runtime dev-port additions are reset from defaults on reload. Exact parser/application sources: `src/main/user-config.ts:58–60,162,631`; `src/renderer/App.tsx:93–114,140–180,871`. This precedence needs visible explanation before adding a generic import/export/sync feature.

### Additional preference writer: saved workspace snapshots

Named session save captures all workspaces in the current window **and a copy of terminalPrefs**. Loading that named session applies setTerminalPrefs and persists those terminal preferences. Restoring can therefore change font, colors and other terminal settings as well as the layout; it is not a layout-only operation. The last-named-session fallback also applies them. Sources: [save](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/App.tsx#L1433), [manual restore](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/App.tsx#L1447), [fallback restore](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/App.tsx#L236). A future restore preview should disclose these changes; changing that behavior requires a separate implementation decision.

## General

All rows use appearancePrefs unless another scope is named.

| English label / compatibility name / control | Field, default, choices / limits | Visibility and effect | Source |
|---|---|---|---|
| Interface language | `language`; detected from browser/OS language, fallback English | Immediate; persisted scalar. Bundled 18 languages plus valid user locales | UI/General:140; S:100; `i18n/core.ts:41–58` |
| App theme | `uiTheme='dark'`; Follow system (`system`), Dark, Light | App chrome; separate terminal color scheme | UI/General:165 |
| Dim unfocused panes — N% | `inactivePaneDim=20`; 0–60%, step 1 | Live dim overlay; 0 disables; ignored in Focus mode | UI/General:183; `shared/inactive-pane-dim.ts:12–18` |
| Add "Open in remotea" to the folder context menu | Registry state, initially read from system; on/off | Not settings.json. Applies/removes Windows shell integration immediately; busy disables control, error shown. UI is not platform-gated | [UI/General:55–100,200](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/components/Settings/GeneralSettings.tsx#L55) |
| Taskbar still showing the old remotea icon? / Refresh taskbar icons | Action, no preference | Main confirms Explorer restart; busy text “Explorer is restarting…”; not platform-gated in this component | [UI/General:62–73,215](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/components/Settings/GeneralSettings.tsx#L62) |
| Enable custom background | `customBackgroundEnabled=false` | Shows CSS and preset controls | UI/General:229 |
| Preset | Convenience action sets `customBackground` CSS; no independent preset key | Only when enabled. Choose a preset…, Lovely, Ember, Deep sea, Aurora, Graphite | UI/General:14–39,241 |
| Background (CSS) | `customBackground=''`; free-form CSS background value | Only when enabled; preview appears for nonempty value | UI/General:258 |
| Enable transparency | `windowTransparency=false` | Only when capability probe says transparency supported. Entering/leaving clear-alpha mode can require rebuilding/restarting window | UI/General:305–315; `hooks/useWindowTransparency.ts:15–21,37–55` |
| Style | `windowMaterial='clear'`; Clear, Acrylic, Mica | Only when transparency enabled and capability section visible. Acrylic/Mica disabled without Windows 11 material capability | UI/General:319–343 |
| Terminal opacity — N% | `terminalBgOpacity=88`; 15–100%, step 1 | Visible whenever transparency preference is on; can be shown while restart pending. Runtime clamps minimum | UI/General:355–369; `store/backdrop.ts:18–23` |
| Agent office | `hubEnabled=false` | Under “Easter eggs”; off by default since remotea's HUB_DEFAULT_REV 2, which switched every profile off once. On adds the titlebar office button and its live shortcut | UI/General:376–392 |

Language choices: English/en, Français/fr, Español/es, Deutsch/de, Português/pt, Italiano/it, Nederlands/nl, Polski/pl, Türkçe/tr, Русский/ru, Українська/uk, 中文/zh, 繁體中文/zh-TW, 日本語/ja, 한국어/ko, हिन्दी/hi, Svenska/sv, Čeština/cs. User JSON locale registration adds more. English text anchors for General are `src/renderer/i18n/locales/en.ts:36–97,880–884,955–957`.

## Agent integration (Agents)

Main-owned `agentIntegration={decision,features,decidedAt?}`. New installs default `decision='unset'`; all four features default true **but are ineffective until granted**. `decision` choices in storage are unset/granted/declined; Settings master checkbox grants/declines. Nothing asks at launch: `unset` writes and removes nothing until the Settings checkbox is used. `decidedAt` is bookkeeping. Changing settings writes/removes agent configuration files on **this desktop user's home**, not a remote server or Eridani installation (`agent-integration.ts:88–170`). Agent processes may need new sessions to consume changed files; this panel does not restart them.

| Label / compatibility name | Key / default after grant | Disclosure / behavior | Source |
|---|---|---|---|
| Configure coding-agent integrations on this computer | `decision`, effective off until granted | Loading/busy disables; details disclose Claude Code, OpenCode, Kiro, omp, pi, Grok, Qwen and Antigravity as supported per feature | UI/AgentIntegration:104 |
| Agent instructions | `features.instructions=true` | Marked instruction sections in Claude/OpenCode/omp/pi/Qwen docs; Kiro steering and Grok rules | UI/AgentIntegration:35–38 |
| Status hooks | `features.hooks=true` | Claude, omp, pi, Grok, Antigravity and Qwen; path hints include the omp extension | UI/AgentIntegration:41–44; `agent-integration.ts:126–129,187` |
| OpenCode status and task plugin | `features.orchestrator=true` | OpenCode plugin only, `~/.config/opencode/plugin/`. The key keeps its old name so a stored `false` stays off | UI/AgentIntegration:47–55 |
| Connect agent MCP tools to the desktop browser | `features.browserMcp=true` | `~/.claude.json`, `~/.qwen/settings.json`; configures browser panel access | UI/AgentIntegration:58–61 |

All four children remain visible but disabled/unchecked if master not granted; busy disables all. The corresponding component contains the full affected-file path hints. These are filesystem-changing operations presented as preferences and deserve clear ownership scope, not removal for a server-first workflow.

### Integration diagnostics

The diagnostics readout separates saved consent/configuration from observed managed files for each provider. File observations distinguish present, missing, modified and inspection errors; runtime readiness remains **unprobed**. File presence does not establish an installed/authenticated agent or active process, and a host connection does not establish Eridani execution readiness.

| Control / readout | Effect and boundary |
|---|---|
| Saved choice: Granted / Declined / Not decided | Reports persisted consent independently of file observations; does not infer runtime availability |
| Observed integration files on this desktop / provider details | Read-only inspection with per-provider counts and expandable feature/path/state/error-code rows. Present matches the managed content for this build; modified means different, not necessarily broken. Missing can be expected for disabled features or absent provider directories |
| Refresh file status (read only) / Checking… | Re-reads consent and observes files without applying configuration, starting processes or contacting services; read failure preserves prior observations as potentially stale |
| Retry applying saved choice | Enabled for saved granted/declined decisions. Reapplies that existing choice (including authorized removals) and refreshes observations; it does not grant consent. A failed consent save prevents home-file writes |
| Runtime not probed / Checked at | No executable, authentication or process probe is implied. Timestamp describes the observation; desktop-process environment overrides choose the inspected paths |
| Apply / removal errors and file-read alerts | Provider/operation/stable error code only; no credential values, file contents, environment dumps or raw OS error messages are returned through diagnostics. Failures are observations of the latest apply attempt, separate from saved consent |


## Sidebar

Persisted `sidebarPrefs`, except Sidebar mode in `appearancePrefs`. All apply live to local presentation, including display of remote workspaces; they do not change server workspace metadata.

| Exact label | Field / default | Values / dependency | UI source |
|---|---|---|---|
| Wrap long workspace titles | `wrapTitles=false` | on/off | Sidebar:14 |
| Give workspace titles the full row width | `fullWidthTitles=false` | on/off; moves status to separate row | Sidebar:24 |
| Eridani runs expanded | `sidebarPrefs.eridaniRunsExpanded=false` | Expand/collapse control at the bottom of the desktop sidebar. Saved in settings.json across restarts | Sidebar header |
| Show git branch | `showGitBranch=true` | on/off; workspace tooltip for terminal workspaces | Sidebar:40 |
| Show working directory | `showWorkingDir=true` | on/off; workspace tooltip for terminal workspaces | Sidebar:50 |
| Show PR status | `showPR=true` | on/off | Sidebar:60 |
| Show ports | `showPorts=true` | on/off | Sidebar:70 |
| Show notification message | `showNotificationMessage=true` | on/off | Sidebar:80 |
| Hide all details | `hideAllDetails=false` | on/off; other detail toggles remain editable | Sidebar:90 |
| Sidebar mode | `appearancePrefs.uiMode='trace'` | Classic / TRACE — live circuit | Sidebar:103 |
| Active tab indicator | `activeTabIndicator='leftRail'` | Left Rail / Solid Fill | Sidebar:126 |
| Background opacity | `backgroundOpacity=100` | range 10–100% | Sidebar:143 |
| Text size | `textScale=100` | range 90–150%, step 5; renderer clamps | Sidebar:158; S:452–462 |

## Workspace

`workspacePrefs` unless specified. Booleans apply to future relevant events, not retroactively to running processes. Saved layouts and local-agent restore are separate from remote-session reattachment/recovery.

| Exact label | Field / default | Options, scope, effect | UI source |
|---|---|---|---|
| New workspace placement | `newWorkspacePlacement='afterCurrent'` | After Current / Top / End | Workspace:187 |
| Auto-reorder on notification | `autoReorderOnNotification=false` | on/off; workspace list behavior | Workspace:204 |
| Show the first-use tour | `showWelcomeScreen=true` | on/off; first-use eligibility also depends on the tutorial-seen marker; this does not replay the tour on every launch | Workspace:214 |
| Confirm before closing a local workspace | `confirmWorkspaceClose=false` | on/off; local-workspace UI/shortcut closes, not CLI. Host workspaces/tabs have a separate mandatory Hide/End decision | Workspace:224–243 |
| Confirm before closing remotea | `confirmAppClose=false` | on/off; window X / Alt+F4. Updates/restarts/OS shutdown bypass. Local processes end; host views detach without requesting termination. Offline host liveness remains unknown | Workspace:246–258 |
| Save layout snapshots every | `sessionSnapshotMinutes=5` | Never/5/10/15/30/60 minutes in UI; TOML accepts 0–240. Retains last 3 distinct layouts, not terminal process checkpoint | Workspace:263–282 |
| Resume Claude Code sessions on restore | `restoreClaudeSessions=false` | Relaunch exact known conversation with claude --resume on local restored panes, skips clean exits/missing conversations | Workspace:287–298 |
| Resume local Codex conversations when restoring | `restoreCodexSessions=false` | Native Windows Codex, Node.js, PowerShell/Command Prompt; new terminal captures conversation | Workspace:303–312 |
| Resume local OpenCode conversations when restoring | `restoreOpencodeSessions=false` | Requires integration plugin; OpenCode 2 capture requires --standalone; deleted session may become new | Workspace:316–325 |
| Resume local Antigravity conversations when restoring | `restoreAgySessions=false` | agy --conversation; Status hooks + Node.js | Workspace:329–338 |
| Resume local Qwen Code conversations when restoring | `restoreQwenSessions=false` | qwen --resume; Status hooks + Qwen 0.14+, skips clean/missing | Workspace:342–351 |
| Resume omp sessions on restore | `restoreOmpSessions=false` | omp --resume path; Status hooks, missing file skips safely | Workspace:355–364 |
| Read agent screens to infer state | `detectAgentScreens=true` | Local screen matching; rules configurable in app-data/agent-detection. Declared state takes precedence | Workspace:368–379 |
| Show the file explorer by default | `explorerOpenByDefault=true` | Opens when cwd known, per-workspace closure retained; global off hides all | Workspace:384–395 |
| Auto-open diff tab on agent edits | `autoOpenDiffTab=true` | Opens diff for edit events | Workspace:400–411 |
| Keep computer awake | main `remotea-keep-awake.mode='smart'` | Smart (when agents are working) / Always (keep awake while remotea is open) / Off (system defaults). Affects desktop machine; smart working-claim expiry 15min | Workspace:416–430; `awake-manager.ts:29–31` |
| Keep display awake | main `remotea-keep-awake.preventDisplaySleep=false` | on/off; always editable even mode off, takes effect when keep-awake engages | Workspace:435–446 |
| Execution location and Shell / Command | `defaultShell=''` | Separate location picker (This computer or a configured host) and free-text local shell / host command. Local suggestions: powershell.exe, pwsh.exe, cmd.exe, bash.exe, wsl.exe. Explicit local system shell uses `local:`; host selection retains `remote:<host> [command]` | Workspace:454–468 |
| Starting directory | `defaultCwd=''` | Text on selected location; local ~ and %VARIABLES% expansion. Browse… is a local folder picker disabled for host launches. Host paths must begin / or ~/ (or be ~); incompatible saved paths warn and are rejected on launch. Splits/explicit cwd/restores keep own cwd | Workspace:473–489 |
| Terminal panes | `newWorkspacePanes=1` | 1–8 rounded/clamped on input. Legacy three-pane grid defaults migrate once to one pane. Saved layouts and subsequent explicit choices apply to new workspaces | Workspace:503–518 |
| Arrangement | `newWorkspaceLayout='grid'` | Grid (balanced rows) / Columns (side by side) / Rows (stacked) / Main pane left, rest stacked right / Main pane top, rest across the bottom; disabled for <=1 pane | Workspace:524–538 |

Local shell suggestions remain a fixed Windows list rather than runtime discovery, and the text field permits custom commands. Location is now chosen separately. Missing/malformed host specifications fail rather than launching locally; a failed host-list read shows uncertain configuration rather than claiming the host was removed. Native Mac shell discovery remains future work.

### Saved layouts (Workspace → Saved Layouts)

Default `savedLayouts=[]`; each `{id,name,splitTree,createdAt}` persists under `remotea-saved-layouts` (`shared/types.ts:405`). Tree snapshots preserve geometry and surface/shell/cwd/startup state; new instances remint IDs. `workspacePrefs.defaultLayoutId=null` means pane-count/arrangement default wins; a saved default supersedes those controls (`S:558`; UI/Workspace:498).

| Control / current label | Stored data or action | Conditional behavior/source |
|---|---|---|
| Name | `savedLayouts[].name`, free text | UI/Workspace:574 |
| Default | `defaultLayoutId=layout.id` or null | Checkbox; one selected ID across layouts, UI/Workspace:581 |
| Set to Current Layout | Replaces selected saved tree from current workspace | Action, [UI/Workspace:588](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/components/Settings/WorkspaceSettings.tsx#L588) |
| Remove | Deletes preset; clears default if matching | Action, [UI/Workspace:141–144,594](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/components/Settings/WorkspaceSettings.tsx#L141) |
| Startup commands | Expands/collapses editor, transient expanded IDs | Available if preset has panes, [UI/Workspace:600](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/components/Settings/WorkspaceSettings.tsx#L600) |
| Pane N / Command to run on start (optional) | First surface's `startupCommands[]` strings, per saved pane | Only expanded; every command has a row, updates on typing, UI/Workspace:19–88,162–179,611 |
| × / Remove this line | Deletes command | When actual commands array nonempty, [UI/Workspace:36–42](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/components/Settings/WorkspaceSettings.tsx#L36) |
| + Add line | Appends empty command | [UI/Workspace:86](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/components/Settings/WorkspaceSettings.tsx#L86) |
| + Save current layout as preset | Creates new preset via requestLayoutSave; default name Layout N | [UI/Workspace:145–148,626](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/components/Settings/WorkspaceSettings.tsx#L145) |
| Restore app default | Sets defaultLayoutId null | Only when a default is set, [UI/Workspace:630](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/components/Settings/WorkspaceSettings.tsx#L630) |

Additional fields stored in workspacePrefs but shown under **Remote hosts**: `groupEridaniRuns=true`, “Group Eridani runs by repository”; `recoverySkipClean=true`, “Skip the recovery dialog when everything restores cleanly”. The Remote hosts section below gives exact behavior and storage.

## Terminal

All in terminalPrefs. Typography, cursor, scrollback, input handling and title policies affect terminal views; changing a preference is distinct from restarting a shell. The terminal hook subscribes live to the resolved global/per-pane scheme and all font/cursor/scrollback fields (`hooks/useTerminal.ts:902–905,2248–2291`). Existing panes without an explicit scheme update too; panes with explicit overrides retain those. The aligned hint now describes this live behavior; the old “new panes” restriction has been removed.

| Exact label / control | Field / default | Available values / condition / effect | UI source |
|---|---|---|---|
| Font | `fontFamily='Consolas, Menlo, Monaco, monospace'` | Installed font names from main; choosing writes selected family + Consolas, monospace. Picker hidden if font enumeration empty | Terminal:36–50,218–235 |
| Font stack (advanced) | Same `fontFamily` | Free CSS font stack; live preview | Terminal:240 |
| Font size | `fontSize=13` | Integer input normalized to 8–72 by its change handler | Terminal:270–277 |
| Default scheme | `theme='Monokai'` | Bundled names from resources + user schemes, unique sorted | Terminal:38–53,285 |
| From Windows Terminal | Import action | Colors/font/opacity; stores custom scheme and selects it | [Terminal:136–210,309](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/components/Settings/TerminalSettings.tsx#L136) |
| From Ghostty | Import action | Same; opacity import may enable clear transparency/restart requirement | [Terminal:312](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/components/Settings/TerminalSettings.tsx#L312) |
| Undo | Action restores previous import keys, no persisted undo | Visible if importUndo exists; session-only; survives Settings tab switch | [Terminal:103–112,323](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/components/Settings/TerminalSettings.tsx#L103) |
| bg | `userColorSchemes[name].background`; newly added '#1e1e1e' | Color input per named scheme | Terminal:345–347 |
| fg | `.foreground`; newly added '#dddddd' | Color input | Terminal:350–352 |
| cursor | `.cursor`; newly added '#ffffff' | Color input | Terminal:355–357 |
| Remove | Deletes named custom scheme | Action; current theme name not cleared here | [Terminal:76–80,341](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/components/Settings/TerminalSettings.tsx#L76) |
| new scheme name (e.g. prod) / Add scheme | Adds `userColorSchemes[name]`, map default {} | Nonempty trimmed name; Enter also adds; duplicate names are rejected (case-insensitive) | Terminal:55–64,365–373 |
| Cursor style | `cursorStyle='block'` | Block / Underline / Bar | Terminal:380–390 |
| Cursor blink | `cursorBlink=true` | on/off | Terminal:395 |
| Use the window title as the tab label | `oscTitleTabs=true` | OSC0/2 title unless user-renamed | Terminal:409–421 |
| Use the window title as the workspace name | `oscTitleWorkspaces=true` | First title-producing terminal unless explicit workspace name | Terminal:427–439 |
| Terminal bell | `bellStyle='visual'` | Flash the pane / Soft beep / Silent; visible pane behavior; background uses Notifications | Terminal:447–461 |
| Right-click | `rightClick='copyPaste'` | Copy selection, otherwise paste / Always paste / Do nothing; mouse applications own click, Shift invokes clipboard override | Terminal:469–483 |
| Scrollback lines | `scrollbackLines=5000` | Integer input normalized to 100–100000 by its change handler; displayed step 100 | Terminal:491–499 |
| Touch pan gain | `touchPanGain=1` | 0.05–4, step0.05; normalized/clamped; full-screen mouse app drag, not wheel/flick/normal scrollback | Terminal:507–519; `utils/wheel-forward.ts:69–80` |

Custom scheme persistent fields beyond the three UI colors: `cursorText`, `selectionBackground`, `selectionForeground`, `palette` (up to 16 from TOML), all optional. Imports and TOML can populate them; no UI editors for them (`S:668–681`; `src/main/user-config.ts:70–77,296–312`). There is no UI rename for an existing scheme.

## Prompt history (Prompts)

`promptPrefs`; defaults enabled=true, highlight=true, color=#6ea8ff, ruler=true, pin=false, pinLines=2, anchor=true, anchorScope=agent, outline=true, outlineSide=right, outlineMode=overlay. All child controls dim/disable when recording prompt history is off. This is local prompt tracking/presentation, not a system prompt or Eridani prompt template editor.

| Exact label | Field | Choices / additional dependency | UI source |
|---|---|---|---|
| Record prompt history in terminal views | enabled | on/off; stops recording and consumers when off | [Prompt:64](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/components/Settings/PromptSettings.tsx#L64) |
| Highlight prompt lines | highlight | on/off | [Prompt:78](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/components/Settings/PromptSettings.tsx#L78) |
| Highlight color | highlightColor | Color input; remains editable if highlight off but master on | [Prompt:89](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/components/Settings/PromptSettings.tsx#L89) |
| Mark prompts on the scrollbar | ruler | on/off | [Prompt:105](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/components/Settings/PromptSettings.tsx#L105) |
| Pin the last prompt | pin | on/off; live manual pin shortcut in hint | [Prompt:119](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/components/Settings/PromptSettings.tsx#L119) |
| Header height (lines) | pinLines | 1–5 integer, store clamps; editable if pin off | [Prompt:130](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/components/Settings/PromptSettings.tsx#L130); S:1055,1529–1535 |
| Hold the view at the start of the answer | anchor | on/off; follow-output shortcut releases | [Prompt:152](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/components/Settings/PromptSettings.tsx#L152) |
| Apply it to | anchorScope | Agent answers only / Agent answers and shell commands; disabled if anchor off | [Prompt:163–171](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/components/Settings/PromptSettings.tsx#L163) |
| Prompt outline | outline | on/off; outline remains closed until shortcut | [Prompt:185](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/components/Settings/PromptSettings.tsx#L185) |
| Open the outline as | outlineMode | An overlay on the pane / A pane of its own; disabled if outline off | [Prompt:196–204](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/components/Settings/PromptSettings.tsx#L196) |
| Outline side | outlineSide | Right / Left; disabled for pane mode; not additionally disabled when outline off | [Prompt:215–226](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/components/Settings/PromptSettings.tsx#L215) |

`promptDefaultRev=0` is migration bookkeeping, not a supported end-user option.

## Notifications

`notificationPrefs`; all seven boolean controls default on, sound defaults `default`. Apply to future notifications locally. Terminal foreground bell is separate.

| Exact label | Field / values | Source |
|---|---|---|
| Show toast notifications | toast, on/off | [Notification:37](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/components/Settings/NotificationSettings.tsx#L37) |
| Taskbar flash | taskbarFlash, on/off | [Notification:47](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/components/Settings/NotificationSettings.tsx#L47) |
| Pane ring | paneRing, on/off | [Notification:57](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/components/Settings/NotificationSettings.tsx#L57) |
| Pane flash animation | paneFlashAnimation, on/off | [Notification:67](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/components/Settings/NotificationSettings.tsx#L67) |
| Notify when agent needs input | agentInputNotify, on/off | [Notification:80](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/components/Settings/NotificationSettings.tsx#L80) |
| Notify when agent finishes its turn | agentStopNotify, on/off | [Notification:90](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/components/Settings/NotificationSettings.tsx#L90) |
| Notify on a terminal bell in a background pane | bellNotify, on/off | [Notification:100](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/components/Settings/NotificationSettings.tsx#L100) |
| Notification sound | sound: Default / Chime / Ping / Marimba / Pop / Custom file / None | Notification:113–127; `renderer/notification-sound.ts:19–26` |
| Preview | Action, no preference; disabled for None or Custom without filename | [Notification:129–135](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/components/Settings/NotificationSettings.tsx#L129) |
| Custom sound file / Choose audio file | Action copies audio and sets sound=custom, `customSoundExtension`, `customSoundName` (both default null); previews | Notification:11–26,141–151 |

Audio accepts aac/flac/m4a/mp3/oga/ogg/opus/wav/webm, max10MiB (`main/ipc-handlers.ts:129–153,937`). Custom filename shown but no Settings remove-file action. Taskbar terminology is Windows-specific; native Mac should expose an appropriate app-attention capability rather than discard notification capability.

## Browser

`browserPrefs`; behavior belongs to desktop browser panel and opening links, not Eridani's browser or remote server's localhost.

| Exact label | Field/default | Choices / effect | UI source |
|---|---|---|---|
| Default search engine | `searchEngine='google'` | Google / DuckDuckGo / Bing / Brave Search | Browser:13–26 |
| Open browser panel on startup | `openOnStartup=false` | on/off; startup. Previously saved choices remain in effect | Browser:34 |
| Start page | `defaultUrl=''` | Draft text with inline validation; only valid trimmed values persist. Empty uses Remotea page; Explicit scheme:// or about: URLs accepted; http(s) additionally requires a hostname. Custom protocols remain supported. New workspace browser before navigation | Browser:45–60 |
| Auto-open dev servers in the browser panel | `autoOpenDevServer=true` | on/off; detection still shows ports while off | Browser:66–78 |
| Open links in the system browser | `openLinksExternally=false` | on/off; terminal/markdown clicked links, Ctrl+click inverse; in mouse-owning apps Ctrl+click uses configured preference | Browser:87–106 |
| DevTools icon | `devToolsIcon='default'` | Default / Compact / Hidden | Browser:114–126 |

File-only `browser.dev-ports` adds detection ports (below). No default browser engine or agent-browser executable-path setting is exposed in this UI or parsed UserConfig; `agentBrowserPath(configured?)` exists as an API but is not proof of a supported user setting. Per-browser-surface web/agent engine is a workspace/session surface state, not this preference block.

## Profiles

The navigation label is “Launch profiles” (internal `Profiles`); the panel heading remains “Quick-launch profiles”. Store defaults to empty array. New profile defaults generated UUID, name “New profile”, type terminal; optional values absent. Global profiles are local saved tab presets; project profiles are read separately from .remotea.json and not edited here.

| Exact label / placeholder | Stored field / allowed value | Condition / effect | UI source |
|---|---|---|---|
| Import from Windows Terminal | Action merges profiles by ID | Appends fresh IDs; not same as Terminal theme import | [QuickLaunch:25–40,54](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/components/Settings/QuickLaunchSettings.tsx#L25) |
| Name | name, unrestricted text | Every profile | [QuickLaunch:67–71](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/components/Settings/QuickLaunchSettings.tsx#L67) |
| icon; title Optional emoji/glyph | icon, optional string, maxlength2 UTF-16 units | Every profile | [QuickLaunch:73–79](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/components/Settings/QuickLaunchSettings.tsx#L73) |
| terminal / browser / markdown | type select | Raw lowercase type names, not translated | [QuickLaunch:7,81–86](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/components/Settings/QuickLaunchSettings.tsx#L7) |
| Remove | Delete profile action | Every profile | [QuickLaunch:88](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/components/Settings/QuickLaunchSettings.tsx#L88) |
| Execution location and Shell / Command | shell optional compatible string | Terminal only: inherit workspace/default, This computer, or a configured host; local shell and host command are edited separately. Explicit local system shell uses `local:` | [QuickLaunch:93–97](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/components/Settings/QuickLaunchSettings.tsx#L93) |
| Working directory (optional) | cwd optional free text | Terminal only in UI; schema also permits browser cwd | QuickLaunch:99–103; `shared/types.ts:426` |
| Startup commands (one per line) | startupCommands string array | Terminal only; handler splits, trims every line, drops empty lines on every keystroke | [QuickLaunch:105–116](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/components/Settings/QuickLaunchSettings.tsx#L105) |
| URL (e.g. https://localhost:3000) | url optional free text | Browser only | [QuickLaunch:124–128](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/components/Settings/QuickLaunchSettings.tsx#L124) |
| + Add profile | Adds new default row | Action | [QuickLaunch:136](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/components/Settings/QuickLaunchSettings.tsx#L136) |

Markdown profiles have no path/content editor. `id` not editable; `source` is provenance (`global`/`project`) not a user preference. Switching type retains irrelevant optional fields in storage because update is a partial merge. The location editor and compatibility preview now make the host/computer choice explicit. There is still no execution test, reorder, duplicate or export action here. Shell configuration remains available for local workflows.

## Shortcuts

61 app actions, each a recorder button. Persistent binding shape `{key,ctrl?,shift?,alt?}`; no Command/Meta field (`S:132–136`). Capture waits past bare modifiers; Escape cancels. Rebind writes immediately, including conflicts: it only shows a transient 3-second “Conflicts with …” warning (`UI/ShortcutRecorder.tsx:32–51`). Recorder's display still uses its own raw key spelling (`bindingToString`, lines11–17), whereas other UI uses shared platform-aware formatAccelerator; include this in wording alignment.

Search by name… text filter, “Search by shortcut…” capture button (title “Click, then press a shortcut to filter by it”), “Press keys...” capture state, and × / “Clear shortcut filter” when a filter is set are transient UI controls (`UI/ShortcutFilterCapture.tsx:21–53`); not preferences. List groups Workspaces / Agents / Tabs / Panes / Terminal / View / Other, alphabetical translated labels within group (`UI/Keyboard:98–129`). Number-row families are outside filters.

| Exact label / action | Field/default | Choices / effect | Source |
|---|---|---|---|
| Select workspace by number | `keyboardPrefs.workspaceIndexModifiers='ctrl'` | Ctrl+1…9, Alt+1…9, Ctrl+Alt+1…9, Ctrl+Shift+1…9, Alt+Shift+1…9, Disabled | UI/Keyboard:177; `utils/index-shortcuts.ts` |
| Select tab by number | `keyboardPrefs.surfaceIndexModifiers='ctrl-alt'` | Same choices; assigning occupied modifier family swaps the two; number9 selects last | UI/Keyboard:183–193; S:1092–1129 |
| Reset All | Action resets `shortcuts` and the number-row keyboard preferences | Also resets number-row keyboardPrefs to their factory defaults | UI/Keyboard:198; S:1464–1466 |

No clear/unbind or per-action reset button in recorder. Stored empty key can represent unbound where consumers handle it, but not offered as a Settings control. Fixed keys Escape dismiss, Ctrl+S save, Enter/Shift+Enter find navigation are outside rebindable table (`renderer/shortcuts.ts:109–115`). TOML terminal byte remaps are a separate system described below. Default actions are listed in appendix.

## Changelog and Help

These tabs have actions and information, **no user preference fields**.

Changelog: Refresh (disabled while loading), select release, Open on GitHub; selected version/loading are component state. Main owns cache; fetching starts on tab mount, chooses newest initially, refresh preserves selection. `UI/Changelog:55–70,87,107,131`. Help now uses `src/shared/product.ts`: Remotea issues and documentation are primary, with a separate upstream credits link. It also includes searchable task topics and lifecycle guidance.

Help: Version read from installed Electron app; update action states Check for updates / Checking… / Downloading N% / Update to vN / Restart / Click to try again / up-to-date text. Disabled during checking/downloading; button can restart app after update, so it is an operation rather than preference (`UI/Help:36–62,69–79`). English strings use the `settings.help.*` translation keys in the bundled English locale. Updater, changelog and Help support destinations consistently target rdavisdunham/remotea; upstream attribution remains separate.

## Supported advanced configuration outside Settings

### ~/.remotea/config.toml

This reference does not inspect or edit your configuration. Values omitted from TOML retain corresponding current/default preference. Supported fields below are exhaustive for `UserConfig` and mapping functions at this revision; arbitrary settings.json keys are not implicitly TOML options. Kebab-case keys listed here accept the shown camelCase aliases only where indicated. UI writes do not synchronize back to this file.

| Section/key (aliases) | Default / accepted values | UI counterpart / effect | `main/user-config.ts` |
|---|---|---|---|
| terminal.font-family (fontFamily) | standard terminal font default; any string incl empty | Font stack | 345 |
| terminal.font-size (fontSize) | 13; numeric, no parser bound | Font size | 348 |
| terminal.cursor-style (cursorStyle) | block; block/underline/bar | Cursor style; invalid warned | 351–357 |
| terminal.cursor-blink (cursorBlink) | true; bool | Cursor blink | 360 |
| terminal.scrollback-lines (scrollbackLines) | 5000; numeric, no parser bound | Scrollback | 363 |
| terminal.osc-title-tabs (oscTitleTabs) | true; bool | Tab window-title label | 366 |
| terminal.osc-title-workspaces (oscTitleWorkspaces) | true; bool | Workspace title | 369 |
| terminal.touch-pan-gain (touchPanGain) | 1; positive numeric; runtime normalization .05–4 | Touch pan | 372–375 |
| terminal.colors.default (theme) | Monokai; nonempty string | Default scheme | 329–336 |
| terminal.colors.schemes.NAME | Optional named table | Replaces/merges map by scheme name on apply | 315–336 |
| scheme.background, foreground | Optional strings | bg/fg UI; omitted inherits base | 298–301 |
| scheme.cursor (cursor-color) | Optional string | cursor UI | 302–303 |
| scheme.cursor-text (cursorText) | Optional string | No UI | 304–305 |
| scheme.selection-background (selectionBackground) | Optional string | No UI | 306–307 |
| scheme.selection-foreground (selectionForeground) | Optional string | No UI | 308–309 |
| scheme.palette | Optional string array, first16 | No UI | 310–311 |
| appearance.ui-theme (uiTheme) | dark; light/dark/system | App theme | 391–395 |
| appearance.inactive-pane-dim (inactivePaneDim) | 20; 0–60 percent; 0<value<1 rejected as likely alpha mistake | Dim unfocused | 398–407 |
| sidebar.wrap-titles (wrapTitles) | false; bool | Sidebar wrap | 419–424 |
| workspace.panes | 3; rounds/clamps1–8 with diagnostic | New terminal panes | 461–474 |
| workspace.layout | grid; grid/columns/rows/left/down/single | Arrangement; single sets pane count1 unless explicit panes wins | 450–457 |
| workspace.snapshot-minutes | 5; rounds/clamps0–240; no camelCase alias | UI offers only 0/5/10/15/30/60 | 481–491 |
| workspace.keep-awake.mode | smart; smart/always/off | Main awake manager; table spelling keep-awake only | 504–519 |
| workspace.keep-awake.prevent-display-sleep (preventDisplaySleep) | false; bool | Keep display awake | 522–526 |
| browser.dev-ports (devPorts) | Empty extra list; bundled ports 3000,3001,4000,4200,5000,5173,5174,8000,8080,8888 (`renderer/dev-ports.ts:11`); array integers1–65535, bad numeric entries dropped/warned | No UI; merged with bundled defaults, reset extras on reload | 540–552 |
| browser.auto-open (autoOpen) | true; bool | Auto-open dev servers | 555–556 |
| browser.default-url (defaultUrl) | ''; string with scheme:// or about:, empty allowed | Start page; Start-page text validates an explicit scheme:// or about: form before saving; http(s) additionally requires a hostname | 564–589 |
| remote.upload-on-paste (uploadOnPaste) | true; bool | No UI; legacy SSH image/file transfer preference, not remote-host transport or console enablement | 593–610 |
| remote.upload-on-drop (uploadOnDrop) | true; bool | No UI; legacy SSH dropped-file upload; Shift inverts per-drop | 593–610 |
| keys."CHORD" | No remaps; text sequence or empty string to swallow | No Settings editor; bytes to terminal, not app action binding | 617–627 |

TOML `[keys]` accepts `ctrl+shift+key` or vim-style `<C-S-key>`, Ctrl/Control, Shift, Alt/Option/Meta aliases, where **Meta means Alt**, not Mac Command. Supports literal characters, named Enter/CR/Return, Esc/Escape, Space, Tab, BS/Backspace, Del/Delete, Ins/Insert, Home/End, PgUp/PageUp, PgDn/PageDown, arrows, F1–F12, `<lt>`/`<gt>`. Sequence tokens emit VT bytes; Ctrl letters/punctuation and Alt ESC prefix; Shift+Tab special sequence; empty swallows. Actual Command/metaKey events are refused (`shared/key-sequence.ts:39–80,103–183,198–223`). Preserve byte remaps when modernizing app shortcuts, but label the distinction.

### User locales

`~/.remotea/locales/<code>.json`: `{label?: string, strings: {translationKey: string}}`, or flat key→string map; label defaults filename code. File codes two or three ASCII letters only; max50 files, max1MiB/file. Built-in `zh-TW` exists but user region-subtagged names are rejected. Strings for known keys override bundled language or add a language; renderer filters unknown keys. `remotea locales` diagnoses; reload-config reloads locale registry. Current language may fall back if its custom locale disappears (`main/user-locales.ts:4–12,54–61,83–128,141–165`; S:1555–1563). These user-controlled translations can override the exact English labels in this report; bundled source is authoritative baseline only.

### Agent detection manifests

`getAppDataDir()/agent-detection/*.json`; active manifest for same agent replaces bundled manifest, does not extend it. Cache reload is explicit (`remotea detect reload` path in detection RPC), not automatic per file edit (`main/detection-store.ts:51–72`). User manifest fields: `agent` known alias, numeric `version` default0, required valid `signatures[]`, `rules[]` (first128). Matcher `{kind,value,ignoreCase?}` uses contains/lineStartsWith/lineEndsWith only; value nonempty≤512 chars; ignoreCase false by default. User rules require id, state blocked/working/idle, region `{id,count?}`, and positive all[] or any[]; none[] optional; priority finite number/default500; count floored min1. Allowed regions whole_recent/bottom_lines/bottom_non_empty_lines/top_non_empty_lines/osc_title. **No user regex, anchored regions, matcher-specific regions, or question rules**; overrides turn that agent's bundled question detection off, with diagnostics. Engine bounds region200 lines/line1000 chars. (`main/user-manifests.ts:31–161`; `shared/detection/types.ts:188–201`). No GUI manifest editor, only global screen inference checkbox and help path.

### Project .remotea.json profiles

`<workspace cwd>/.remotea.json`, `{profiles:[...]}` or raw array. Required nonempty trimmed name; type terminal/browser/markdown, invalid type becomes terminal; optional id (generated `project-index-name` if absent), icon, shell, cwd, startupCommands array of nonempty strings, url. `source='project'` set while loading. Invalid/missing file gives empty list. Appears in tab-add menu, not global Profiles editor (`main/config-loader.ts:263–305`; `renderer/components/SplitPane/PaneWrapper.tsx:416`). Local project file reading must not be described as remote server profile synchronization.

## Hidden metadata and adjacent persisted state

Supported exposed settings are all accounted for above. The following are not additional preferences to advertise:

- `appearancePrefs.uiModeDefaultRev=1`, `hubDefaultRev=1`, `promptPrefs.promptDefaultRev=0`, plus `remotea-shortcut-defaults` revision: migration bookkeeping to promote old untouched defaults. Editing them can reapply promotions; do not include in human-facing settings export controls (`S:353,948,1235,1253,1298–1310`).
- Runtime only: `sidebarVisible=true`, `localeRevision`, `broadcastInputActive=false`, `transparencyNeedsRestart=false`, importStatus/importUndo=null. Import undo survives a Settings tab change, not restart; broadcast is deliberately not persisted (`S:1433–1454,1566–1579`).
- `wmux-focus-mode` localStorage (`'1'`/`'0'`, defaultoff) toggled outside Settings; affects pane dimming/layout presentation. `remotea-tutorial-seen` localStorage `'1'` records tutorial dismissal (`App.tsx:626–630,778–784`). Their storage differs from stable file-backed preferences and can be origin/path scoped.
- Saved workspace/session data (selected tab, split tree, explicit titles/colors, pinned state, cwd, shell, browser surface engine, explorer state, remote placements/hidden sessions) is user state and per-workspace overrides, not a global setting. The main analysis and connection sections distinguish remote placement and server scope. Do not conflate “restore settings”, “restore layout”, “resume local agent conversation”, “reattach remote session”, and “restart exited remote process”.
- Agent-browser API accepts an optional configured binary path, but no current parsed config setting or Browser Settings field supplies one; do not document a nonexistent path preference merely from comments in `agent-browser-cli.ts`.

## Alignment delivered and remaining follow-ups

The original review proposed location separation, grouped search, scope explanations, accurate lifecycle/support copy, integration disclosures, validation fixes and shortcut consistency. Those changes are implemented in this release: font/scrollback enforce bounds, duplicate scheme names are refused, start-page drafts validate before saving, the shortcut recorder uses the shared formatter, and Reset All includes both number-row families. The current settings inspector displays effective renderer values and explicitly discloses that per-field provenance is unavailable.

The following remain separate follow-ups rather than claims of implemented features:

- Native Windows Eridani execution, native Mac shells/app support and remote Mac execution require dedicated implementations. Existing local Windows tools remain available.
- A theme/settings import preview could disclose all changed preferences and restart requirements before applying them. Existing theme-import Undo remains session-only; named workspace snapshots also restore terminal preferences.
- The snapshot TOML interval accepts intermediate values absent from the UI select. The profile command editor still trims lines and drops empty lines as typed. Full editing/import/export of those formats is not added here.
- Shortcut conflict warnings remain advisory; no conflict-resolution workflow or new Mac Command support is introduced. Terminal byte remaps remain separate from app actions.
- Per-field default/settings.json/TOML/snapshot provenance requires additional load metadata. The current inspector does not infer a source chain it cannot prove.
- Full host Git/worktree parity and remote OS-open adapters remain unavailable; source-bound remote file editing and change statistics are preserved.

No installed user settings, live host sessions or paired devices were changed to produce this reference. Source inspection and automated tests do not certify a user's live runtime readiness.

## Remote hosts: configuration, recovery, and adjacent controls

This tab configures the desktop's connections to Remotea execution hosts. It does not configure the server's Eridani link, create an execution target, or enable phone access. The internal tab ID is `Hosts`; its current English label is **Remote hosts**.

Host records live in `getAppDataDir()/remote-hosts.json`, separate from `settings.json`. Tokens are encrypted by Electron safeStorage, decrypted only in main for use, and never read back into the settings form. Stable device identity is in `remote-device.json`; queued operations are separate operational state. Empty initial host list means no configured connections. The new-host draft is `{name:'',url:'ws://',token:'',enabled:true,ackUnencrypted:false}`.

| Label / compatibility name / field | Default and validation | Apply/scope/conditional behavior | Proposed wording |
|---|---|---|---|
| Name / `name` | Empty draft; UI Save requires nonempty trimmed name; main trims and caps at 80 characters (fallback Remote for direct callers) | Saved per host; stable generated host ID is not the display name | **Host name** |
| URL / `url` | New draft `ws://`; requires ws or wss, host, no username/password in URL | Saved per host. Editing URL resets acknowledgment unless returning to initial URL; changing stored URL clears pinned server identity and reconnects | **Host address** with explicit protocol help |
| Token / `token` | Empty draft; password field. Empty edit keeps existing token; nonempty input is trimmed/encrypted on save | Write-only. Shows whether stored; no ordinary “show token” control. Main API can clear with explicit empty token, but this form omits empty input, so that is not a visible clear-token action | **Host access token**; obtain it using the server CLI on the execution host |
| Enabled / `enabled` | On for new host | Applied on Save; enables/disables the connection, not the server or its sessions | **Connect to this host** |
| I understand this connection is unencrypted on this network / `acknowledgeUnencrypted` | Off in new draft | Only for plain ws outside approved loopback/Tailscale classification. Test and Save disabled until acknowledged. Stored as acknowledgment of this exact URL, not a universal trust preference | Preserve explicit transport acknowledgment |
| New terminals open here by default | Off unless `workspacePrefs.defaultShell` names this host; global default initially empty/system shell | Immediate change to `remotea-workspace-prefs.defaultShell = remote:<id>`; unchecking clears to system default, not the previously selected local shell. Existing tabs do not move | **Default execution location for new terminals** once location/shell are separated |
| Group Eridani runs by repository / `workspacePrefs.groupEridaniRuns` | On | Repository headings inside the separate Eridani runs section. Off displays a flat list inside that section | Display preference |
| Skip the recovery dialog when everything restores cleanly / `workspacePrefs.recoverySkipClean` | On | Affects startup/reconnect recovery presentation; exceptions still need attention | **Show recovery only when a decision is needed** |

Sources: [form/defaults/actions](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/components/Settings/RemoteHostsSettings.tsx#L65), [host storage/validation](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/main/remote-hosts/host-config.ts#L26), [save behavior](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/main/remote-hosts/host-config.ts#L115), [storage paths](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/main/remote-hosts/index.ts#L48), [transport acknowledgment](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/shared/host-url.ts#L29), [Eridani/recovery preferences](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/components/Settings/RemoteHostsSettings.tsx#L294).

### Actions and readouts, not additional settings

| Current action or information | Behavior / limitation | Alignment note |
|---|---|---|
| Add remote host / Edit | Opens a draft form | Preserve separate draft versus stored connection |
| Test | Uses draft address/token or existing stored token; reports server name/session count or failure; does not Save the host record | **Test connection**; distinguish transport success from Eridani execution readiness |
| Save / Cancel | Saves draft or abandons it; disabled while busy | **Save connection** |
| Remove | Confirmation states removal does not request termination, tabs stop updating and offline liveness is unknown. Clears matching default shell | **Remove connection**; not **Delete host** |
| Shell spec examples | Shows `remote:<id>` and `remote:<id> claude` | Retain in advanced help for existing profiles/automation; avoid teaching it as the only future location model |
| Host health and session rows | Separate connection/process/Eridani run information; last-seen data | Preserve separate status meanings; label stale/unknown observations |
| Changes made here not yet confirmed / Forget | Pending or sent-but-unanswered operations; per-item consequence tooltip and acknowledged / failed / unconfirmed removal result | Forget removes a local pending request only when acknowledged; it never rolls back a host effect. Failed requests stay available for review/retry |
| Not applied on this host / Dismiss | Failed/expired operations with error information | Dismiss is clearing a report, not retrying or undoing execution |
| Hidden on this device / Show here | Unhides a session view for this device | **Show on this device**; not a new task/run |
| End session on this host | Confirms requesting process termination for every attached device | Does not verify or accept the associated Eridani task |
| Retry now (terminal overlay) | Wakes/retries host connections from outside Settings | Connection recovery, not rerunning the terminal command |
| Agent status on {host}: Install | After host reports missing hooks, asks server to install status hooks there | **Install status hooks on {host}**; distinct from local agent integration consent |
| Agent status prompt: Not now | Suppresses this run's prompt | Transient choice; does not set permanent refusal |
| Agent status prompt: Don't ask again | Persists `hooksPromptDeclined` on this host | Host-specific suppression; no dedicated reset switch in this tab |

Stable generated host ID, pinned server ID, encrypted token, remembered acknowledgment URL, device ID/name, hook-prompt decline, outbox IDs/retry metadata and registry mirrors are administrative/security/operational state. They are not independent preference switches. Default selection and the two grouping/recovery toggles belong to `settings.json`; host credentials do not.

Sources: [hidden sessions](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/components/Settings/RemoteHostsSettings.tsx#L168), [host health](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/components/Settings/RemoteHostHealth.tsx#L25), [pending changes](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/components/Settings/RemotePendingChanges.tsx#L9), [remote hook prompt](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/components/RemoteHooksPrompt.tsx#L6), [host status/schema](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/shared/remote-hosts-types.ts#L7).

The host introduction and hidden-session help now distinguish ownership from liveness: desktop exit does not request host-process termination, host/service availability is required, same-PC WSL depends on that PC, and offline process status is unknown. Hiding alone is not evidence that a process is running.

### Dani (host assistant) settings

Dani has a dedicated **Settings → Dani** tab (internal section ID `Tea`) with a host selector and visible provider controls. **Configure Dani** opens that tab for the host selected in the conversation panel. Host cards also expose the same settings under **Dani assistant**. The host persists them in private `tea-state.json` alongside conversation checkpoints and redacted evidence. All connected apps share these values. Saving uses a configuration revision and rejects conflicting edits from another device.

| Setting | Default | Behavior |
|---|---|---|
| Enable Dani on this host | Off | Enables conversational and background work. Disabling interrupts pending turns and stops new capture |
| Automatic names for unnamed terminals | On | Generated names yield to custom names and explicit agent labels |
| Quick terminal summaries | On | Shows short work descriptions in expanded workspace terminal lists |
| Connection name | Anthropic suggestion | Display label for one of up to eight provider profiles |
| API format | Anthropic Messages suggestion | Anthropic Messages, native OpenAI Responses, or OpenAI-compatible Chat Completions |
| Base URL | Provider default | HTTPS endpoint, with HTTP supported for loopback gateways |
| API key | Empty | Write-only field. Blank preserves a saved key. Remove saved key clears it on Save. Removing the profile and saving also removes its key |
| Conversation connection and model | Sonnet 5.5 suggestion | Model for Dani replies and application actions |
| Background connection and model | Haiku 5.5 suggestion | Model for automatic names and summaries |
| Effort per role | Medium for Sonnet, low for Haiku | Model default, low, medium, high. Capability tests verify the chosen API options |
| Test connection and find models | Explicit action | Saves edits, authenticates and fetches the catalog into visible model dropdowns. Results appear beside the connection. Manual model IDs remain supported |
| Test selected models | Explicit action | Makes real schema and tool-result replay requests. Success is tied to the selected connection, credential, model and effort |
| Reload settings | Explicit action | Replaces local unsaved edits with current host settings |

Model tests and normal Dani work use the configured provider's API billing. The complete design and source research are in [Dani](tea.md).

## Phone access (Remote): pairing and device administration

This is the desktop-hosted **Remote Console**, not the remote execution server and not the Eridani connection. Navigation is **Connections → Phone access** (internal ID `Remote`). Every setting below belongs to the desktop instance on this computer. Closing that desktop ends phone access, even when its remote terminal sessions continue on a host.

Configuration is stored separately from ordinary preferences: `%APPDATA%/remotea[-instance]/remote-console.json`; paired device records in `remote-devices.json`. The six configuration fields below are the complete `RemoteConsoleConfig` schema. The device list and pairing controls are separate records/actions, not additional global preference fields. Defaults describe a new installation; this review did not inspect private user settings or tokens.

| Current label / field | Factory default | Choices, validation, and visibility | Effect and storage | Alignment proposal |
|---|---|---|---|---|
| Enable the remote console / `enabled` | Off | Boolean; enabling asks for confirmation, disabling applies directly | Starts/stops the desktop listener immediately; saved in console configuration | **Enable phone access**; explain that this shares terminals through this desktop, not through Eridani |
| Reachable from / `bind` | `loopback` / This computer only | This computer only; Local network (plain HTTP). LAN option unavailable when there is no usable local address | Reconfigures listener; loopback selection clears `lanHost` and insecure control | **Connection method**; describe a private tunnel versus direct LAN access |
| Network interface / `lanHost` | `null` | Appears only for LAN; one current IPv4 interface. An unavailable saved address remains visible with a warning; wildcard `0.0.0.0` is rejected | Selects the desktop address that listens; does not change the execution host | **Listen on this computer’s address** |
| Port / `port` | `9790` | Integer 1024–65535; draft requires **Apply** | Rebinds listener after validation; save errors are shown | **Phone access port**; keep under advanced connection details |
| Public URL / `publicUrl` | Empty | Appears only for loopback. Bare HTTPS origin; HTTP accepted only for loopback or permitted Tailscale names/addresses. No path, query, fragment, or credentials. Requires **Save** | Sets phone pairing address and permitted origin; it does not create a tunnel or publish the app | **Address opened on your phone**; explicitly state that the tunnel must already exist |
| Allow control over plain HTTP / `allowInsecureControl` | Off | LAN only; acknowledgment plus separate confirmation. Forced false for loopback | Allows control scope on the unencrypted LAN listener; disabling reduces effective access | Keep explicit wording and the existing two-step acknowledgment; do not turn this into a generic “Enable remote control” switch |
| Device name / pairing `name` | Localized “Phone” | Pair dialog; maximum 64 characters, blank falls back to default | Saved with the paired device, not with global configuration | **Device name** is already clear |
| Access / pairing `scope` | `viewer` / View only | View only; Control. Control unavailable on LAN unless insecure control is explicitly enabled | Selects permissions for this pairing. Displayed effective scope can be lower than recorded scope | **View only** and **Type and answer agents**; retain a clear explanation of effective restrictions |

Sources: [configuration schema/defaults/validation](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/shared/remote-console-config.ts#L29), [settings controls](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/components/Settings/RemoteConsoleSettings.tsx#L54), [pairing controls](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/components/Settings/PairDeviceDialog.tsx#L148), [storage filenames](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/main/remote-console/runtime.ts#L73), [English copy](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/i18n/locales/en.ts#L1045).

### Additional actions, status, and conditional content

| Current action or display | Availability / behavior | Proposed treatment |
|---|---|---|
| Off / Starting / Listening / connection count | Status, not a preference; connection count counts devices with live sockets | Keep visible above configuration; name the desktop providing access |
| Port busy, bind failed, phone page missing, saved interface missing | Distinct listener errors | Keep distinct recovery instructions instead of a generic connection failure |
| Rejected origin / Use as Public URL / Dismiss | Conditional status card; trusting a suggested origin has its own confirmation | **Use this phone address** only after showing the exact origin and existing trust explanation |
| Tailscale recipe / SSH tunnel recipe / Copy | Loopback only; command text uses the chosen port | Contextual connection help. Preserve explicit “run on this computer” versus “run on the device you connect from” |
| Pair a device | Requires a running listener | Keep as a human action; unavailable states must say whether access is off or failed to start |
| Make a pairing code / Make a new code | Creates a one-use offer valid for 120 seconds; at most 10 paired devices | **Create pairing code**; show expiry and destination address |
| QR code / pairing URL / copy / expiry / cancel | Offer cleared after success, expiry, cancellation, or unmount; another offer may invalidate it | Preserve transient handling; never put pairing secrets into exported settings or diagnostics |
| Paired devices: Name, Access, Paired, Last seen, Connected | Persisted device metadata plus live connection status | Keep a device management table; distinguish recorded access from access allowed on this connection |
| Control (view only on this network) | Operator record restricted by current LAN configuration | Explain why input is disabled beside the permission label |
| Control (view only until paired again) | Credentials previously crossed cleartext; re-pairing needed for control on the protected route | Preserve re-pairing requirement; rename action **Pair again for control** where a supported route exists |
| Rename / Save / Cancel | Changes paired-device display name, maximum 64 characters | Immediate device metadata action |
| Revoke / Revoke all | Confirmation followed by immediate sign-out; future use requires pairing again | **Remove access** / **Remove access for all devices**, keeping the immediate sign-out explanation |

The phone UI is a terminal/agent companion: roster, blocked/done attention, terminal mirror, text insertion/submission, key bar, and declared-choice answers. It is not a full desktop, a file editor, an execution host manager, or the Eridani approval interface. The phone does not resize the terminal. Viewer access cannot send input; control uses the separate console protocol and its input/confirmation checks. Sources: [protocol and permission map](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/shared/remote-console-protocol.ts#L81), [pair lifetime/device limit](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/main/remote-console/devices.ts#L34), [device access display](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/components/Settings/RemoteConsoleSettings.tsx#L522).

**Proposed lead help:** “Watch terminal sessions and answer agents from a paired phone or browser. Remotea must remain open on this computer. This connection is separate from remote execution hosts and Eridani. Start with view-only access; grant typing access to devices you trust.”

**Preservation requirement:** keep the desktop-hosted console, human-controlled pairing, default-off listener, default-viewer permission, separate credentials, and remote-terminal forwarding. These are useful for future local Windows and local Mac execution as well as today’s remote-host workflow. Future phone access to a background local executor is a separate capability; the present console must not be described as surviving desktop shutdown.

## Related execution-service configuration (reference, not desktop controls)


This section lists all ServerConfig defaults and summarizes related Eridani target/operator configuration; it is not an exhaustive catalogue of the separate Eridani application. These execution-service settings are not edited by the desktop Hosts panel. A future UI may show redacted readiness or provide a deliberate operator workflow, but must not pretend these controls already exist.

| Area | Current fields / operations | Ownership and distinction |
|---|---|---|
| Service network | `port` 7717; `bind` loopback + tailscale0; `hookPort` 7718 (zero disables) | `~/.config/remotea` or `REMOTEA_CONFIG_DIR`; different from desktop connection URL. |
| Managed runs (Claude, Codex) | Every launcher at or above the floor (Claude Code 2.1.312, Codex 0.166.0) is probed once per binary; the result is in `<config dir>/launcher-conformance.json`. Env (service unit): `REMOTEA_MANAGED_CLAUDE_FORCE` / `REMOTEA_MANAGED_CODEX_FORCE` = comma-separated versions admitted without a probe (logged); `REMOTEA_MANAGED_CLAUDE_BLOCK` / `REMOTEA_MANAGED_CODEX_BLOCK` = versions refused (wins over FORCE); `REMOTEA_LAUNCHER_PROBE_TURNS=off` skips the probe steps that drive a turn (they are local, against a fake model API, and never a paid call). `REMOTEA_MANAGED_CLAUDE_MAX` is no longer read. | A Claude Code or Codex update is probed automatically (about 2 s; within 10 minutes of the update, or at the next server start) and hello reports `conformance` per launcher (eridani-link.md, Launcher conformance). `remotea launcher probe [claude\|codex]` re-probes now; `remotea launcher status` shows the recorded steps. Set an override with `systemctl --user edit remotea` (`Environment=REMOTEA_MANAGED_CLAUDE_BLOCK=2.1.320`) and restart. The floor cannot be overridden. |
| Recovery/lifetime | `resumeAgents` true; `ptyKeeper` false by default; `ptyKeeperIdleMinutes` 10 | Server behavior; restart persistence is optional, not universal. |
| Inactivity watchdog | `stallMinutes` 15 (0 = off) | An agent session that reads working with no hook event and no terminal output for this long is flagged stalled, to the apps and to Eridani. |
| Terminal history/retention | `scrollback` and `snapshotScrollback` 5000; `ringBytes` 1 MiB; `exitedRetentionDays` 7; `tombstoneDays` 30 | Server storage/replay, distinct from renderer preferences. |
| Upload retention | `uploadBudgetMiB` 2048; `uploadMaxAgeDays` 7 | Host storage, distinct from SSH upload toggles. |
| Identity/access | Server ID, terminal token/rotation, hook secret | Operator CLI/files; secrets excluded from diagnostics. |
| Eridani link | `enabled`, `url`, optional `machine`, collector modes parity/authoritative/off in types; separate token file | `eridani.json` and CLI; outgoing execution link, not desktop host subscription. |
| Agent integration | `webUrl`, `mcpUrl`, global/per-target `mcpKeyFile`, separate MCP bot key | Runtime resolves operator config; do not combine credentials. |
| Target identity | `id`, `repo`, `worktreeRoot`, `base` | Host repository/worktree policy, not workspace title. |
| Launch permissions | `launch.claude` / `launch.codex` with optional `bin`/fixed `args` | Permission plus launcher readiness. Desktop provider visibility does not enable Eridani spawning. |
| Verification recipe | `id`, `argv`, `cwd`, `timeout`, `env` | Operator-controlled fixed commands; cwd scoped to worktree. |
| Verifier isolation | `isolation` bwrap/none; `network` false/loopback/true; `ports`; read-only `mounts` | Linux policy. Unspecified isolation uses working bwrap else none; explicit unavailable bwrap refuses. Native platforms require honest supported policy. |
| Preparation | Ordered `prepare`: id, argv, cwd, timeout, env | New managed worktree preparation, separate from verifier sandbox policy. |
| Resource limits | `maxRuns`, `minFreeMiB` | Scheduling/readiness; read-only participants count. |
| Migration conventions | `migrations.dir`, optional pattern | Enables target migration-number coordination. |
| Maintenance / diagnostics | `remotea doctor/status/upgrade/hooks/logs/screen`; Eridani connect/status/disconnect/collector/targets/worktrees | Operator CLI; help must identify which host/context runs it. |

Evidence: [ServerConfig/defaults:11](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/remote-server/src/config.ts#L11), [EridaniConfig:209](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/remote-server/src/config.ts#L209), [target schema:49](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/remote-server/src/eridani-targets.ts#L49), [MCP resolution:107](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/remote-server/src/eridani-mcp.ts#L107), [CLI usage:550](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/remote-server/src/cli.ts#L550).


## Appendix: every rebindable action and factory binding

Same storage, scope and recorder behavior for every row: `remotea-shortcuts`, this desktop renderer, effective immediately. Exact English action labels are resolved through current English translation dictionary; default binding values are from S, not user state.

| Group | English label / compatibility name | Key | Default binding | Source |
|---|---|---|---|---|
| Workspaces | New workspace | `newWorkspace` | Ctrl+N | [S:211](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/store/settings-slice.ts#L211) |
| Workspaces | New window | `newWindow` | Ctrl+Shift+N | [S:212](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/store/settings-slice.ts#L212) |
| Workspaces | Close workspace | `closeWorkspace` | Ctrl+Shift+W | [S:213](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/store/settings-slice.ts#L213) |
| Workspaces | Close window | `closeWindow` | Alt+F4 | [S:214](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/store/settings-slice.ts#L214) |
| Workspaces | Open folder | `openFolder` | Ctrl+O | [S:215](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/store/settings-slice.ts#L215) |
| View | Toggle sidebar | `toggleSidebar` | Ctrl+B | [S:216](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/store/settings-slice.ts#L216) |
| Workspaces | Go to next workspace | `nextWorkspace` | Ctrl+Page Down | [S:217](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/store/settings-slice.ts#L217) |
| Workspaces | Go to previous workspace | `prevWorkspace` | Ctrl+Page Up | [S:218](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/store/settings-slice.ts#L218) |
| Tabs | Rename tab | `renameSurface` | Ctrl+F2 | [S:219](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/store/settings-slice.ts#L219) |
| Workspaces | Rename workspace | `renameWorkspace` | Ctrl+Shift+F2 | [S:220](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/store/settings-slice.ts#L220) |
| Panes | Split pane right | `splitRight` | Ctrl+D | [S:221](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/store/settings-slice.ts#L221) |
| Panes | Split pane down | `splitDown` | Ctrl+Shift+D | [S:222](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/store/settings-slice.ts#L222) |
| Panes | Split browser right | `splitBrowserRight` | Ctrl+Alt+D | [S:223](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/store/settings-slice.ts#L223) |
| Panes | Split browser down | `splitBrowserDown` | Ctrl+Alt+Shift+D | [S:224](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/store/settings-slice.ts#L224) |
| Panes | Toggle pane zoom | `toggleZoom` | Ctrl+Shift+Enter | [S:225](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/store/settings-slice.ts#L225) |
| Panes | Focus pane left | `focusLeft` | Ctrl+Alt+Left | [S:226](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/store/settings-slice.ts#L226) |
| Panes | Focus pane right | `focusRight` | Ctrl+Alt+Right | [S:227](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/store/settings-slice.ts#L227) |
| Panes | Focus pane up | `focusUp` | Ctrl+Alt+Up | [S:228](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/store/settings-slice.ts#L228) |
| Panes | Focus pane down | `focusDown` | Ctrl+Alt+Down | [S:229](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/store/settings-slice.ts#L229) |
| Panes | Close tab or pane | `closeSurfaceOrPane` | Ctrl+W | [S:230](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/store/settings-slice.ts#L230) |
| Tabs | New tab | `newSurface` | Ctrl+T | [S:231](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/store/settings-slice.ts#L231) |
| Tabs | Go to next tab | `nextSurface` | Ctrl+Tab | [S:236](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/store/settings-slice.ts#L236) |
| Tabs | Go to previous tab | `prevSurface` | Ctrl+Shift+Tab | [S:237](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/store/settings-slice.ts#L237) |
| Workspaces | Go to latest unread | `jumpToUnread` | Ctrl+Shift+U | [S:238](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/store/settings-slice.ts#L238) |
| View | Show notifications | `showNotifications` | Ctrl+Alt+N | [S:239](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/store/settings-slice.ts#L239) |
| View | Flash focused pane | `flashFocused` | Ctrl+Alt+F | [S:240](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/store/settings-slice.ts#L240) |
| View | Toggle browser panel | `openBrowser` | Ctrl+Shift+I | [S:241](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/store/settings-slice.ts#L241) |
| View | Toggle browser DevTools | `browserDevTools` | Ctrl+F12 | [S:242](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/store/settings-slice.ts#L242) |
| View | Toggle browser console | `browserConsole` | Ctrl+Shift+J | [S:243](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/store/settings-slice.ts#L243) |
| Terminal | Find | `find` | Ctrl+F | [S:244](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/store/settings-slice.ts#L244) |
| Terminal | Enter copy mode | `copyMode` | Ctrl+Alt+[ | [S:245](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/store/settings-slice.ts#L245) |
| Terminal | Copy | `copy` | Ctrl+Shift+C | [S:246](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/store/settings-slice.ts#L246) |
| Terminal | Paste | `paste` | Ctrl+Shift+V | [S:247](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/store/settings-slice.ts#L247) |
| Terminal | Increase font size | `fontSizeIncrease` | Ctrl+= | [S:248](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/store/settings-slice.ts#L248) |
| Terminal | Decrease font size | `fontSizeDecrease` | Ctrl+- | [S:249](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/store/settings-slice.ts#L249) |
| Terminal | Reset font size | `fontSizeReset` | Ctrl+0 | [S:250](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/store/settings-slice.ts#L250) |
| View | Open settings | `openSettings` | Ctrl+, | [S:251](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/store/settings-slice.ts#L251) |
| View | Open command palette | `commandPalette` | Ctrl+Shift+P | [S:252](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/store/settings-slice.ts#L252) |
| Tabs | New markdown tab | `openMarkdownPanel` | Ctrl+Shift+M | [S:253](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/store/settings-slice.ts#L253) |
| Tabs | Open diff view | `openDiffPanel` | Ctrl+Shift+G | [S:254](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/store/settings-slice.ts#L254) |
| Tabs | Open Git view | `openGitPanel` | Ctrl+Alt+G | [S:258](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/store/settings-slice.ts#L258) |
| Tabs | Reopen closed tab | `reopenClosedSurface` | Ctrl+Shift+T | [S:263](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/store/settings-slice.ts#L263) |
| Terminal | Find next | `findNext` | F3 | [S:264](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/store/settings-slice.ts#L264) |
| Terminal | Find previous | `findPrevious` | Shift+F3 | [S:265](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/store/settings-slice.ts#L265) |
| Panes | Resize pane left | `resizePaneLeft` | Ctrl+Shift+Left | [S:266](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/store/settings-slice.ts#L266) |
| Panes | Resize pane right | `resizePaneRight` | Ctrl+Shift+Right | [S:267](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/store/settings-slice.ts#L267) |
| Panes | Resize pane up | `resizePaneUp` | Ctrl+Shift+Up | [S:268](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/store/settings-slice.ts#L268) |
| Panes | Resize pane down | `resizePaneDown` | Ctrl+Shift+Down | [S:269](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/store/settings-slice.ts#L269) |
| Panes | Toggle broadcast input to all panes | `broadcastInput` | Ctrl+Alt+B | [S:270](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/store/settings-slice.ts#L270) |
| Workspaces | Pin or unpin workspace | `togglePinWorkspace` | Ctrl+Alt+P | [S:271](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/store/settings-slice.ts#L271) |
| Workspaces | Mark workspace read | `markWorkspaceRead` | Ctrl+Alt+R | [S:272](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/store/settings-slice.ts#L272) |
| View | Show keyboard shortcuts | `toggleShortcutCheatSheet` | F1 | [S:273](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/store/settings-slice.ts#L273) |
| Tabs | Toggle markdown source view | `toggleMarkdownSource` | Ctrl+Shift+E | [S:278](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/store/settings-slice.ts#L278) |
| Terminal | Reset terminal state | `resetTerminal` | Ctrl+Shift+R | [S:285](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/store/settings-slice.ts#L285) |
| Tabs | Toggle file explorer | `toggleExplorer` | Ctrl+Shift+X | [S:291](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/store/settings-slice.ts#L291) |
| Agents | Go to agent needing you | `jumpToBlocked` | Ctrl+Shift+B | [S:301](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/store/settings-slice.ts#L301) |
| Agents | Show all agents | `openAgentNavigator` | Ctrl+Shift+A | [S:302](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/store/settings-slice.ts#L302) |
| Agents | Open agent office | `openHub` | Ctrl+Shift+O | [S:304](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/store/settings-slice.ts#L304) |
| Terminal | Toggle prompt outline | `togglePromptOutline` | Ctrl+Shift+L | [S:322](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/store/settings-slice.ts#L322) |
| Terminal | Pin or unpin prompt | `togglePinnedPrompt` | Ctrl+Shift+K | [S:323](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/store/settings-slice.ts#L323) |
| Terminal | Follow output | `followOutput` | Ctrl+Shift+End | [S:324](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/store/settings-slice.ts#L324) |

## Inventory verification

The baseline TypeScript inventory found eight preference objects with 86 fields, plus the four-field ShortcutBinding type, 61 action bindings and 191 control nodes (including repeated list templates and buttons). Every field and action is included here. The generated settings search catalogue is derived from source by `node scripts/generate-settings-search-index.cjs`; its tests check field coverage and section destinations. The implementation preserves persisted preference keys and defaults.

Automated validation belongs to the alignment PRs: typechecks, behavior tests, server tests and Windows packaged smoke CI. Live local/host/phone acceptance on the user's installed Windows app is deliberately left for the morning checklist in [alignment.md](alignment.md). macOS support and native Windows Eridani execution are not claimed.

## Source index for abbreviated references

- [S: settings types/defaults/persistence](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/store/settings-slice.ts)
- [English labels](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/i18n/locales/en.ts)
- [General controls](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/components/Settings/GeneralSettings.tsx)
- [Agent integration](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/components/Settings/AgentIntegrationSettings.tsx)
- [Sidebar controls](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/components/Settings/SidebarSettings.tsx)
- [Workspace/layout controls](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/components/Settings/WorkspaceSettings.tsx)
- [Terminal controls](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/components/Settings/TerminalSettings.tsx)
- [Prompt history controls](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/components/Settings/PromptSettings.tsx)
- [Notification controls](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/components/Settings/NotificationSettings.tsx)
- [Browser controls](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/components/Settings/BrowserSettings.tsx)
- [Profiles](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/components/Settings/QuickLaunchSettings.tsx)
- [Keyboard controls](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/renderer/components/Settings/KeyboardSettings.tsx)
- [Advanced TOML parser](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/main/user-config.ts)
- [User locales](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/main/user-locales.ts)
- [Detection manifest validation](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/main/user-manifests.ts)
- [Project profiles](https://github.com/rdavisdunham/remotea/blob/b31f92c4a78b064b64f467200da3be2ac8f48b9c/src/main/config-loader.ts)
