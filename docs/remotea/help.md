# Remotea task guide

[Complete settings reference](settings-reference.md) · [Alignment and morning acceptance checklist](alignment.md)


Remotea organizes terminals, coding agents and project tools on this computer and connected hosts.

## Start on this computer

<a id="start"></a>

Create a workspace and select a local shell in Settings → Workspace. New workspaces start with one terminal. Settings → Workspace and saved layout presets can specify a different arrangement. Local Windows terminals and installed coding agents work without a host or Eridani. Closing their owning window ends local processes.

## Connect a host

<a id="hosts"></a>

Settings → Remote hosts connects this desktop to a Remotea session server using its URL and token. Host terminals can survive desktop disconnection while the host and service remain available. WSL on this same PC is still a host; PC sleep or shutdown can stop it. Offline terminal status is unknown.

## Arrange workspaces, panes and tabs

<a id="workspace"></a>

A workspace groups panes and tabs; a pane can contain terminals, browsers or documents. Each device keeps its arrangement. Launch profiles supply location, shell, directory and startup commands; startup commands execute when a terminal starts.

## Work with coding agents

<a id="agents"></a>

Settings → Agent integration configures instructions, status hooks and optional plugins on this computer, with consent. Host integration is separate: run remotea hooks status on the host. Working, Needs you and Idle describe activity, not task acceptance. Prompt history records supported captured input, not system instructions. Resume continues a supported provider conversation in a new process.

Chat replies also have an unread state, independent of agent activity. Use the terminal status bar or tab menu to mark a chat unread or set a server reminder. See [chat attention and reminders](chat-attention.md).

## Find and organize terminals with Tea

<a id="tea"></a>

Open **Tea** in the sidebar footer and select a connected host. Tea shares its conversation, terminal summaries and settings across apps using that host. Ask where you were working, request a terminal rename, move a terminal into an existing workspace, mark it unread or set a reminder. Open buttons in Tea replies select matching terminals in this window.

Set up Tea under **Settings → Tea** and choose the host. **Configure Tea** opens this page for the host selected in the conversation panel. Choose the new provider type, add its connection, enter the base URL and API key, then save. The saved-key indicator confirms storage while the password field clears. **Test connection and find models** saves pending edits and shows its result beside the connection. It populates visible model dropdowns, with manual model-ID entry available. Switching API format clears model choices bound to that connection so you can choose models for the new provider. Choose a conversational model and a background model, then **Test selected models** to check tool calling, result replay and structured summaries. Enable Tea and save. Sonnet is suggested for conversation and Haiku for quick metadata. Native OpenAI Responses and explicitly selected OpenAI-compatible gateways are also supported.

Keys are write-only and stored in the host's private configuration directory. A blank key field preserves the stored key. Use **Remove saved key** and save to delete a credential, or remove the connection and save. Connection and model tests make real provider requests and may incur API usage charges.

Expand a workspace's terminal list to see quick work summaries alongside current activity. Tea generates names for terminals without custom names. A name you set takes precedence across devices. Use **Use automatic name** in a tab's context menu to clear your override. Summaries keep updating under custom names. The updating label identifies a summary awaiting newer captured evidence.

Tea saves accepted messages and action receipts before continuing. Closing the desktop leaves host work running. After a host restart or provider interruption, **Continue saved turn** reconciles confirmed actions. **Cancel turn** abandons the remaining work. Previously applied names and reminders remain recorded. If delivery is unconfirmed, refresh and retry the same message to reconcile its saved ID.

## Inspect Eridani work

<a id="eridani"></a>

Connect the desktop to a host separately from linking that host to Eridani with remotea eridani setup. Host link keys, agent MCP keys and desktop host tokens have different purposes. A task describes work; a run is one execution and may have no task. Open this run in Eridani to inspect verification, approval and recovery. Terminal exit or agent idle does not prove success. Native Windows Eridani execution is not available.

Supported managed runs keep questions and plans available for later answers in Eridani. The run header shows the workflow stage; the activity line above its message input shows current model or tool activity. Pause preserves the workspace and pending decisions. Resume reconciles interrupted work, while Cancel ends execution and retains its history. Queued, saved and delivered messages have separate receipts.

A managed terminal displays the conversation with separate user, assistant, and tool sections while Eridani controls it. A persistent notice and disabled input explain who has control. You can scroll, select, copy, and find text. Use **Take over** below the transcript, **Ctrl+Shift+Space** in the focused pane, or **Take over in terminal** in Host activity to continue the same conversation in its native terminal. A conflicting custom shortcut takes priority. Input stays disabled until the host confirms terminal ownership; uncertain confirmation can offer an explicit retry after a fresh connected registry update. The transfer persists across reconnects; Eridani displays **Terminal has control**.

Final acceptance, cancellation, failure, and a reached run limit close the run's server terminals after process exit is confirmed. Plan approval, questions, pauses, and disconnects leave terminals open. Worktrees, provider conversations, and Eridani history remain available. A live terminal you have taken over is protected from automatic closure. Cleanup requires updated API and server support; older hosts keep their existing behavior.

If a separate worker takes over after planning, the planner's terminal closes once that worker has successfully attached and is live. The worker continues in its own terminal. A failed or pending worker start leaves the planner available, and a planner continuing as the worker keeps the same terminal.

Legacy terminal sessions retain their native provider approval behavior. Model and effort choices come from the host's verified installed harness, and unsupported choices require correction instead of a silent substitution. An activity gap is shown as **No recent output · last reported …**, preserving the last observed activity without claiming the agent is still actively producing output.

### Managed Claude permissions

Managed planners and reviewers use Claude Plan mode with source-edit tools denied. Workers use Auto mode for routine development work. The host pre-approves role-authorized Eridani coordination calls through Claude's permission callback when the request is mode-driven and the run is bound. Planners can read their task, ask interview questions and submit drafts. Reviewers can read and submit reviews. Workers can read and update plan steps. Each role can link its session to the task.

The run approval card handles exceptional requests, including explicit permission rules and recovered unapproved actions. After a recovered action is explicitly allowed and the harness confirms consuming that decision, the session returns to its configured role mode. The separate plan approval card controls when implementation starts.

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


### Eridani runs in the desktop sidebar

Manual workspaces appear in the main list. Eridani task workspaces appear in the collapsible **Eridani runs** section above the sidebar footer. The section starts collapsed and remembers expansion across app restarts. Expand it to select a task workspace and read its run status. Settings → Remote hosts can group these rows under repository headings.

Host registry updates separate Eridani-originated tabs from manual workspaces using their saved run binding. Tab identities and live host sessions carry through the layout move. Manual workspace reordering and **Close others** operate within the manual section, with the corresponding behavior inside the Eridani section.
