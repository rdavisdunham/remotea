# Remotea task guide

[Complete settings reference](settings-reference.md) · [Alignment and morning acceptance checklist](alignment.md)


Remotea organizes terminals, coding agents and project tools on this computer and connected hosts.

## Start on this computer

<a id="start"></a>

Create a workspace and select a local shell in Settings → Workspace. Local Windows terminals and installed coding agents work without a host or Eridani. Closing their owning window ends local processes.

## Connect a host

<a id="hosts"></a>

Settings → Remote hosts connects this desktop to a Remotea session server using its URL and token. Host terminals can survive desktop disconnection while the host and service remain available. WSL on this same PC is still a host; PC sleep or shutdown can stop it. Offline terminal status is unknown.

## Arrange workspaces, panes and tabs

<a id="workspace"></a>

A workspace groups panes and tabs; a pane can contain terminals, browsers or documents. Each device keeps its arrangement. Launch profiles supply location, shell, directory and startup commands; startup commands execute when a terminal starts.

## Work with coding agents

<a id="agents"></a>

Settings → Agent integration configures instructions, status hooks and optional plugins on this computer, with consent. Host integration is separate: run remotea hooks status on the host. Working, Needs you and Idle describe activity, not task acceptance. Prompt history records supported captured input, not system instructions. Resume continues a supported provider conversation in a new process.

## Inspect Eridani work

<a id="eridani"></a>

Connect the desktop to a host separately from linking that host to Eridani with remotea eridani setup. Host link keys, agent MCP keys and desktop host tokens have different purposes. A task describes work; a run is one execution and may have no task. Open this run in Eridani to inspect verification, approval and recovery. Terminal exit or agent idle does not prove success. Native Windows Eridani execution is not available.

Supported managed runs keep questions and plans available for later answers in Eridani. The run header shows the workflow stage; the activity line above its message input shows current model or tool activity. Pause preserves the workspace and pending decisions. Resume reconciles interrupted work, while Cancel ends execution and retains its history. Queued, saved and delivered messages have separate receipts.

A managed terminal displays the conversation while Eridani controls it. Open Host activity and choose **Take over in terminal** to stop managed control and continue the same conversation locally in that terminal. The transfer persists across reconnects; Eridani displays **Terminal has control**. Legacy terminal sessions retain their native provider approval behavior. Model and effort choices come from the host's verified installed harness, and unsupported choices require correction instead of a silent substitution.

## Use files, Git and browser tools

<a id="files"></a>

File and Git operations belong to a location and directory. Host filesystem access does not imply desktop worktree or Git feature parity. Git review is read-only; editing files can detect concurrent changes. The browser runs on this computer: localhost refers here, so use a reachable host URL or a configured tunnel. Browser engine settings affect desktop automation.

## Leave and return safely

<a id="return"></a>

Hide on this device removes a host view without requesting termination. End session on this host affects every attached device; inspect the close summary. Reconnect attaches to a reachable host session. Workspace snapshots save all workspaces, tabs and terminal preferences in this window; restoring applies those preferences and rebuilds local processes, not process memory. Layout presets create one workspace. Recovery decisions and provider conversation resume are separate.

## Pair a phone

<a id="phone"></a>

Settings → Phone access serves a browser console from this desktop. View only cannot type; Control permits input separately. Pairing credentials differ from host and Eridani credentials. The desktop must remain running and reachable; quitting it disconnects phone access even if host terminals continue.

## Automate the correct endpoint

<a id="cli"></a>

The desktop package exposes remotea and injects working wmux compatibility shims. On a host, remotea administers the server; wmux may reach only a status bridge. Run wmux identify and wmux capabilities before using a command family. A successful ping does not establish browser or workspace control. Desktop --remote addresses a desktop CLI bridge, not a session-server WebSocket.

## Customize and troubleshoot

<a id="customize"></a>

Settings search finds controls and their scope. User TOML configuration can override UI preferences after reload; custom locale files fall back to English. F1 shows live shortcuts; Settings → Shortcuts and the command palette reflect rebinding. TRACE, agent navigator/office, prompt outline, browser engines and snapshots remain available. Legacy local orchestration is wmux-orchestrator compatibility, separate from OpenCode integration and Eridani. Report desktop/host versions and redacted diagnostics; never include tokens. Windows desktop and Linux/WSL host are current support boundaries.
