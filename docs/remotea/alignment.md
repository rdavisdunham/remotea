# Remotea alignment and preservation contract

Remotea is a desktop workspace for terminals, coding agents, files and browsers. Each terminal runs either on **this computer** or on a **connected execution host**. Eridani coordinates task/run decisions through a supported host; Phone access is a separate, desktop-hosted companion connection.

This alignment implements the product, language, settings and location work from phases 0–4 of the 2026-10-31 review. It stops before a native Windows Eridani executor, remote macOS executor or native macOS app. There is no new local background execution service and no promise that local terminals survive desktop exit.

[Task help](help.md) · [Complete settings reference](settings-reference.md)

## Vocabulary and ownership

| Concept | Meaning and owner |
|---|---|
| Workspace / pane / tab | Desktop organization; a workspace can contain different execution locations |
| This computer | Existing desktop PTY, local AgentManager, local files/Git/worktrees and OS integration |
| Remote host | A configured session server; transport health is independent of its terminal processes |
| Session | A process/session record at an execution location; an unreachable host makes current liveness unknown |
| Agent activity | Declared or detected working/idle/needs-you state; a presentation hint, not accepted task completion |
| Eridani run | Bound task/run identity, generation and target; task acceptance stays with Eridani |
| Verification | A separate reported attempt for the matching run and generation; disconnected results are last known |
| Phone access | Desktop-hosted viewer/control connection, separately paired and separately authorized |
| Snapshot / layout | Saved application structure and launch inputs; a named snapshot also restores terminal preferences |

Closing a local terminal ends its process. Hiding a host tab only hides it on this device. Ending a host session is a distinct action. Quitting the desktop ends local processes and detaches from host sessions; it also stops Phone access. A host on the same physical computer, including WSL, cannot keep executing while that machine sleeps; shutdown can end its processes. Optional server restart recovery is not a universal persistence guarantee.

## Implemented alignment

- Task-based help, onboarding and CLI instructions distinguish desktop, host, phone and Eridani contexts. Agent instructions discover endpoint capabilities; a status-only host bridge does not advertise desktop browser/window/query controls.
- Product destinations are centralized. Remotea's support links are primary and upstream MIT attribution remains.
- Settings retain their old IDs and values, gain grouped search and section-specific ownership/apply-time explanations, and move agent integration into a dedicated page. The full field inventory includes file-only and main-owned settings.
- Location selection is independent of shell text in the UI. Existing serialized forms are decoded, explicit local system-shell choices survive inherited remote defaults, and profile directories use the selected execution location's separator.
- Terminals and files identify location. Remote file read/write and change statistics remain supported. Desktop-only full Git/diff review, manual worktrees and OS-open actions explain their unavailable remote route instead of interpreting host paths locally.
- Profile/layout previews report missing hosts and incompatible paths without rewriting commands. A failed host-list read is not proof that a host was deleted.
- Connections and activity provides independent process/run/verification health, hidden-session recovery, pending actions and Eridani links outside Settings. Pending “Forget” is not rollback; an uncertain change may already have reached the host.
- Palette actions reuse the actual shortcut handlers independent of rebound keys. App and terminal theme entries apply real preferences. Keyboard selection cannot execute a row outside the visible result list.
- Integration diagnostics distinguish saved consent, observed managed files and unprobed runtime readiness. Configuration changes retain their existing consent boundary and do not enable native Eridani control.

## Preservation and migration map

| Existing foundation | Destination / compatibility contract |
|---|---|
| PtyManager and native shell discovery | Retained for standalone Windows use; router removes the explicit `local:` system-shell marker before local creation |
| Local AgentManager | Continues using its local PTY API; no local Eridani executor is assembled |
| TerminalRouter and host protocol | Existing `remote:<host> [command]` retained; missing/malformed hosts never fall back to local launch or termination |
| CLI and shell integration | The `remotea` command and shims, `REMOTEA_*` variables and named-pipe identities use remotea names; the move command carried old installs over once, with no aliases. `window.wmux` and other code-only names stay until the code-only renames |
| Settings and TOML | Settings keys are `remotea-*`, the config folder is `~/.remotea` and project files are `.remotea.json` and `remotea.workspace.json`; the move command carries the old `wmux-*` keys and `~/.wmux` over once, with no mass reset |
| Profiles, layouts, manifests | Existing records load; location UI interprets compatible shell fields and preserves commands |
| Local files/Git/worktrees | Retained; supplied source-aware IPC requests reject remote/unknown ownership; legacy cwd-only calls retain desktop-local semantics |
| Remote files | Source-bound file routing, optimistic save protection and change statistics retained |
| Prompt history, resume and detection | Retained; help describes what is saved, restarted or inferred |
| Browser engines and automation | Retained as desktop-owned services, including their existing capability boundaries |
| Legacy orchestration | Removed (2026-11-18). Its design is recorded in `docs/remotea/orchestrator-architecture.md`. The OpenCode status plugin keeps the `orchestrator` consent key |
| Phone console | Default-off listener, pairing, viewer/control permissions and separate input dispatch retained |

There is no new credential sharing: desktop-to-host tokens, host-to-Eridani link keys, agent MCP credentials, desktop CLI access and phone pairing still have different purposes. Read-only role labels do not imply universal OS isolation: provider restrictions, run modes and verifier sandbox policy are separate facts.

## Deliberate limits

The effective settings inspector does not invent per-field provenance that the existing load API does not retain. It shows the section's current renderer values and documents TOML precedence. Generic settings are not automatically broadcast to already-open desktop windows. Main-owned stores are described separately instead of exposed as renderer snapshots.

Integration file inspection does not establish that an agent executable is installed, authenticated or currently running. Likewise a connected host does not establish Eridani readiness. Full remote Git/worktree parity, selective settings import/export, local background execution and Mac platform support remain separate features.

## Morning acceptance checklist

CI covers Windows app tests, Linux server tests and packaged Windows smoke startup. The following checks exercise the installed app and the user's actual connections; they were not performed against live sessions during this implementation.

1. **Local only:** open a native Windows terminal without a host, run an installed agent, browse/edit a local file, open local Git/worktree views, save a layout and reopen with existing preferences intact.
2. **Remote:** reconnect to the Linux host, open and save a remote text file, inspect change statistics, hide/show a session, and separately test ending a disposable session. Full desktop Git/diff/worktree actions should explain their scope.
3. **Mixed locations:** choose This computer/system shell from a host workspace; choose a host profile from a local workspace. Confirm directory previews and terminal/file badges. Test existing profiles and manifests.
4. **Disconnected:** briefly disconnect a disposable host connection. Check last-known process/run/verification labels, hidden-session recovery and pending action results. Typing must not be presented as queued input.
5. **Eridani:** open the correct task/run link, compare agent activity with verification and task acceptance, and confirm no native Windows execution toggle has appeared.
6. **Phone:** inspect listener status, pair a viewer, verify that it cannot type, grant control separately, then revoke. Confirm that closing the desktop ends this companion connection.
7. **Settings:** search old and new terminology, inspect section scope, check existing TOML overrides and custom shortcuts. Verify snapshot restoration explains terminal preference changes.
8. **Navigation/accessibility:** exercise palette commands with rebound shortcuts, light/dark themes, modal Tab/Shift+Tab/Escape, and non-English host close/recovery prompts.

No live deployment, release publication, remote-server restart or user-session termination is part of this alignment.
