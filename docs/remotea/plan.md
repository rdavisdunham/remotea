# Status (2026-10-27)

| Area | State |
|---|---|
| Server: sessions, gap-free attach, query replies, size policy, registry/tombstones/lost-on-boot, auth, CLI (`status --json`, `open`, `close`, `token`), systemd install | **done**: unit, property, integration and e2e tests; installed and verified in WSL |
| App: router, host client, reconnect FSM, power hooks, offline intents, settings, overlay, remote panes in `useTerminal` | **done**: unit tests, plus the real client driven against the real server; needs a first run on Windows |
| Cross-device sync: groups, placement, closes, renames/colours, hide/unhide, Load-session hides, offline closes via probes | **done**: planner and store unit tests; needs a two-device run |
| Agent resume after server restart (Claude via `~/.claude/sessions`, Codex via rollout file / state db) | **done** |
| First Windows run (laptop): connects, survives sleep. Fixed: doubled output in remote panes (StrictMode's second `create()` wired a second forwarder) | **done** |
| Phase 4a: hook bridge. wmux-hook.js (Claude Code, Codex) reports to `127.0.0.1:7718` in WSL with a per-session token; the server relays status to every app showing the session and replays the latest state to apps that attach later. `remotea hooks install` | **done**: unit + real-helper + integration + e2e (hook fired in a real shell) |
| Diagnostics: apps send connection/reattach/agent-state events (no content) to the server; `remotea logs`, `remotea screen <id>` | **done** |
| Paste/drop into remote panes: files and pasted screenshots are uploaded to the host (`POST /upload`, same token, `/tmp/remotea-drop-<uuid>/<name>`) and their paths there typed in | **done**: route + uploader tests; real drop in the desktop test copy |
| Explorer, code viewer and markdown viewer on remote panes: wmux's own jail and readers run on the server (`fs` message), rooted at the session's directory; git change counts from the server; code-viewer write-back with the same grant + mtime guards | **done**: unit + hub tests; clicked through in the desktop test copy. Markdown viewer edit/save, re-stat and reload go back to the server for a file opened from a remote pane's tree (same grant, server-side mtime guard); checked in the desktop test copy. Not yet: reveal/open-in-app |
| A device that does not set a shared terminal's size shows it at the owner's size, scaled down to fit, with "Sized for <device> · C×R [Fit here]" | **done**: two-client integration test; checked in the desktop test copy against a simulated second device |
| Phase 3 (rest): deflate, snapshots persisted across restarts | open (low value: Tailscale links are fast; restarts respawn and resume by design) |
| After connecting, the app shows whether agent hooks are installed on that host's agents and offers to install them through the server (Install / Not now / Don't ask again per host) | **done**: hub + client integration tests; clicked through in the desktop test copy |
| Phase 4b: OpenCode in WSL — `remotea hooks install` (and the app's prompt) installs wmux's OpenCode plugin; sessions get `WMUX_CLI`/`WMUX_NODE`, so the plugin's `node $WMUX_CLI …` reports through the bridge | **done**: install tests; e2e runs the real CLI in a real shell |
| Phase 4b: pi, omp, Grok, Qwen Code, Antigravity — `remotea hooks install` writes wmux's own file or entries for each one installed (pi/omp extensions, ~/.grok/hooks/wmux.json, Qwen's settings.json, the agy plugin dir); the agy hook gained the `WMUX_REMOTE` transport | **done**: install/remove tests on a scratch home; the Qwen and agy hooks run through a real bridge. Not run against the real agents (none installed here) |
| Server-side agent detection | open |
| Server restarts that keep processes | declined: like herdr, a restart (even of the PC) respawns sessions in their directories and resumes their agents |
| Desktop test harness (`scripts/desktop-test/harness.mjs`): a test app instance on the Windows side driven over CDP from WSL, against a test server | **done** |
| Found with the harness: a remote pane was blank after a window reload (now asks the server for a snapshot); screen reads and agent detection looked at the blank bottom of panes taller than 40 rows (now read up to the last printed line) | **fixed** |
| UI copy says "remotea" (all 18 languages): product-name uses only. The in-pane `wmux` command, `~/.wmux/config.toml`, `.wmux.json` and other real names are unchanged | **done** |
| Pending changes (Settings → Remote hosts): each offline action still waiting for a host, or sent without an answer ("uncertain"), listed with what it would do, its age and attempts, and a Forget action (`rhost:outbox-forget`; each says what forgetting it means, e.g. an uncertain close may already have happened on the host) | **done**: outbox + helper unit tests |
| Host attention row (sidebar, top): per host, the Eridani runs that need you, terminals that exited non-zero, unconfirmed actions and the connection state; click goes to the first such tab | **done**: helper + render tests |
| One shortcut table (`src/renderer/shortcuts.ts`): the F1 overlay, Settings → Keyboard, the command palette and every tooltip read their labels and live bindings from it; a test fails when a registered accelerator has no entry, or a tooltip hard-codes a combination | **done**: unit tests. The overlay now also lists the Agents category |
| Recovery dialog ("While this device was away"): on start or reconnect, tabs that exited or were closed elsewhere while away, tabs restoring after a host restart, and ended Eridani runs with unmerged work (`SessionRecord.worktreeState`, see eridani-link.md), each with Reopen / Keep closed / Open worktree in a new terminal / Copy branch name. Reopen of a Claude or Codex session that reported its conversation (`SessionRecord.agent`) starts the new tab with `claude --resume <id>` / `codex resume <id>`, the same command a lost session respawns with (`agentResumeCommand`, shared with hub.ts); other sessions reopen as a shell. Offered once each; clean restores alone skip the dialog (Settings → Remote hosts → "Skip the recovery dialog when everything restores cleanly", on by default) | **done**: inventory, trigger and render tests; needs a click-through on Windows |
| Eridani task grouping: Eridani-spawned sessions open in one workspace per task (titled with the task), shown in the sidebar under their target with a run-state chip; manual sessions stay where they are. Setting: Settings → Remote hosts → "Group Eridani runs by repository and task" | **done**: planner, grouping and render tests. Tabs placed before this change are moved once to their task workspace on the first registry push with the setting on (`planEridaniMigration`, `moveSurfacesLocal`). Only tabs in their server group's workspace move, and only tabs move: no terminal or session is closed. Each tab is decided once (localStorage `remotea-eridani-task-migration`), so a tab dragged back out stays. The shared workspace is discarded locally when it empties. Needs a click-through on Windows |

---

# remotea: wmux GUI backed by a persistent terminal server in WSL

## Context

the user runs Claude Code and Codex agents in WSL on the home desktop (`<desktop>`) and works from a Windows laptop (`<laptop>`) over Tailscale. Plain SSH sessions die when the laptop sleeps, and then the session has to be found and restarted. herdr fixes that, because a server owns the terminals, but it is a TUI. wmux (an Electron multiplexer for Windows) has the organizing GUI, but it only runs local ConPTY terminals and has no reconnect logic.

**Goal:** a lightweight server in WSL that owns every terminal, herdr-style. wmux on both the laptop and the desktop's Windows side connects to it. After sleep, a network drop or a wmux restart, wmux reconnects automatically and repopulates every terminal with its screen and scrollback. New terminals default to this server.

**Decisions made with the user:**
1. **Own lightweight server, not herdr as the backend.** herdr only sends server-rendered repaint frames, which would degrade wmux's scrollback, search, OSC notifications, cwd tracking and agent detection. The new server streams raw PTY bytes and copies herdr's architecture: a daemon that owns the PTYs, detach and attach, and resume after a restart. herdr stays installed and untouched.
2. **Transport: WebSocket plus a bearer token over Tailscale.** The server binds only to WSL's Tailscale IP (<tailscale-ip>) and 127.0.0.1. `.wslconfig` uses mirrored networking, so the desktop's Windows side reaches it on localhost.
3. **Shared sessions, per-device layout.**
   - **The server owns:** the registry of sessions (which terminals exist) and workspaces as groups (id, name, color).
   - **Each device owns:** split trees, pane sizes, windows and monitor placement, kept in each wmux's local `session.json`.
   - **Placement:** a session opened on one machine appears on the other as a new tab in that machine's copy of the same workspace. The workspace is created there if it doesn't exist.
4. **Closing syncs.** Closing a session on either machine closes it on both. Closing a workspace closes all its sessions everywhere.
5. **"Hide on this device"** removes a session from one machine only. The hidden set is stored on the server, keyed by device id. Hidden sessions stay in a "Hidden sessions" menu where they can be unhidden or killed.

**Where the code lives:** a fork in `the repo root` (branch `remotea`), with the server as a sub-package in `remote-server/` that has its own `node_modules`. node-pty must be built for Linux Node there, not for Electron's ABI. Protocol types are shared from `src/shared/`. `a herdr checkout` is reference only.

---

## Architecture

```
Laptop (Windows)                          Desktop
┌──────────────────────┐   Tailscale     ┌──────────────── WSL (systemd user svc) ───────────────┐
│ wmux (Electron)      │  ws://<desktop>   │ remotea server (Node 22, port 7717)                   │
│  renderer: xterm.js  │ ─────────────── │  per session: node-pty + @xterm/headless + serialize  │
│  main: TerminalRouter│  token auth     │  registry.json: groups, sessions, tombstones, hidden  │
│   ├ LocalPtyBackend  │                 │  answers terminal queries even with no client attached│
│   └ RemoteHostClient │                 └───────────────────────────────────────────────────────┘
└──────────────────────┘                          ▲ ws://127.0.0.1:7717 (mirrored networking)
                                                  │
                                    Desktop Windows side: wmux (same build)
```

---

## A. Server: `remote-server/`

### Package and dependencies

- **Runtime:** node-pty 1.1.0, ws 8.21.0, @xterm/headless 6.0.0, @xterm/addon-serialize 0.14.0, @xterm/addon-unicode11 0.9.0.
- **xterm versions are pinned** to match wmux's renderer (xterm 6.0.0) so serialized snapshots replay identically.
- **Dev:** typescript, vitest, @types/ws.
- **tsconfig:** `rootDir: ".."` so it can import `../src/shared/*`.

### Files

| file | role |
|---|---|
| `src/main.ts` | load config, logging; SIGTERM: persist registry, send `goingAway`, SIGHUP the children |
| `src/server.ts` | http + `WebSocketServer({noServer})`; bind 127.0.0.1 and the `tailscale0` IPv4 (retry every 5 s on EADDRNOTAVAIL, never 0.0.0.0); auth on upgrade |
| `src/client-conn.ts` | per-connection dispatch, channel table, ping every 15 s, backpressure |
| `src/session.ts` | node-pty + headless terminal + seq ring buffer (1 MB) + subscribers + size owner + query responder + startup gate |
| `src/registry.ts` | groups, sessions, tombstones, devices; atomic persistence to `registry.json`; on boot, every live session becomes `lost` |
| `src/pty-spawn.ts` | login shell `-l`, `TERM=xterm-256color`, `WMUX_REMOTE_SESSION=<id>`; maps Windows paths to `/mnt/c/...`, falls back to `$HOME` |
| `src/agent-probe.ts` | every 5 s: walk `/proc` descendants and read `~/.claude/sessions/<pid>.json` to get the Claude `sessionId` (used for resume); report foreground cwd via `/proc/<pid>/cwd` |
| `src/flow.ts` | `pty.pause()` when the parse backlog exceeds 4 MB; mark a client lagging when `ws.bufferedAmount` exceeds 4 MB, then resnapshot it |
| `systemd/remotea.service` | same shape as `~/.config/systemd/user/cc-g2-backend.service`; `Restart=always`; `UMask=0077` |
| `scripts/install.sh` | check prerequisites → `npm ci && build && prune` → create `~/.config/remotea/{config.json,token}` (0600) → render the unit with `command -v node` → `systemctl --user enable --now` → print the token and URLs; warn before restarting if sessions are live |
| `scripts/e2e.mjs` | e2e against a real server on a random port with a temporary config directory |

### Authentication

- `Authorization: Bearer <token>`, compared with `timingSafeEqual` on SHA-256 digests.
- Reject any request that has an `Origin` header.
- Allow-list the `Host` header.
- Ban an IP for 60 s after 10 failures in a minute.
- `maxPayload` is 16 MiB.
- Recommend a Tailscale ACL that limits port 7717 to the user's own devices.

### Gap-free attach (core algorithm, synchronous on Node's single thread)

```
onPtyData(chunk): seq++; ring.push([seq,chunk]); term.write(chunk);
                  for sub: live → send OUTPUT(chan,seq,chunk); snapshotting → sub.buf.push
open(id, sinceSeq?, bootId?):
  if same bootId && ring covers sinceSeq+1 && no size change since → mode:'delta', replay ring, sub live
  else subs.add(sub as snapshotting); fence=seq;
       term.write('', () => { snap = serialize({scrollback:5000}) + mouseModeReplay;
                              send opened{mode:'snapshot', seq:fence, snapshot}; flush sub.buf; sub live })
```

xterm calls a write's callback after parsing that write and before parsing the next one. So the snapshot ends exactly at the fence, and the buffer starts exactly after it. This is the same argument as `src/main/remote-console/terminal-tap.ts` (facts 1 to 4), applied on the server.

### Terminal queries

- **The server always answers** DA1/DA2/DSR/CPR/DECRQM, and OSC 10/11/12 when the payload is `?`. It answers through the headless terminal's `onData`, plus an override that sends wmux's DA1 reply (moved from `pty-manager.ts:625`). This works with no client attached, so agents never hang while the laptop sleeps.
- **Clients swallow the same queries** with `installRemoteQuerySwallow(term)`, so no reply is ever sent twice.

### Size policy (herdr's model)

- A device claims a terminal's size only when it focuses that terminal in a focused window, or types into it. Attaching or reconnecting never claims.
- When the owner leaves, the size stays as it is.
- The server broadcasts `size{id, cols, rows, owner}`.

### Startup commands

`deliverStartupCommandsWhenReady` moves, pure and unchanged, from `src/main/startup-commands.ts` to `src/shared/startup-gate.ts`. It is reused server-side to type `claude --resume ...` once the shell prompt is ready.

---

## B. Wire protocol: `src/shared/remote-host-protocol.ts` (pure, shared)

**Name note.** "remote" already means the phone console (`remote-console-*`) and ssh uploads (`remote-insert.ts`), so the new terms are *remote host* and *remote session*.

**Binary frames:** `[u8 kind][u32 chan][f64 seq (output only)][utf8]`.
- Kinds: `OUTPUT=1`, `INPUT=2`.
- Everything else is JSON.

**Client to server:**
- `hello{proto, device{id,name}, app}`
- `open{rid, id, cols, rows, sinceSeq?, bootId?, create?{cmd, cwd, startupCommands, groupId, group{name,color}, title}}`
- `detach{ids}`
- `close{rid, id}`: idempotent, kills the session everywhere
- `resize`, `claim`, `deliver`
- `probe{rid, ids, groups}`
- `groupUpsert`, `groupClose`
- `sessionUpdate{groupId?, title?}`
- `hide`, `unhide`
- `theme{fg, bg, cursor}`
- `ping`

**Server to client:**
- `welcome{proto, serverId, bootId, epoch, you, groups[], sessions[]}`
- `opened{chan, mode:'fresh'|'delta'|'snapshot', seq, snapshot?, cols, rows, created, wasLost?, owner}`
- `openError{code:'closed'|'lost'|'spawn-failed'|..., last?}`
- `probed{status: live|exited|lost|closed|unknown, last}`
- `ack`
- `exit{id, code}`
- `size`
- `meta{id, cwd?, agent?}`
- `sessionAdded`, `sessionUpdated`, `sessionClosed{id, by, reason}`
- `groupUpserted`, `groupClosed{id, sessionIds}`
- `hiddenChanged`
- `goingAway`, `pong`, `error`

**Records:**
- `GroupRecord{id:'grp-…', name, color, order?}`
- `SessionRecord{id:'surf-…', groupId, title, cwd, lastCwd, cmd, createdBy, state:'live'|'exited'|'lost', exitCode, agent?{provider, sessionId}, hiddenBy: DeviceId[]}`
- `Tombstone{kind, at, by, reason}`, kept 30 days

**Exports:**
- strict `parseClientMsg` / `parseServerMsg` guards: id regexes, size caps, no `\n` in commands
- `TIMING = {pingMs:10000, deadMs:25000, backoffMinMs:250, backoffMaxMs:15000}`

**Also new in `src/shared/`:**
- `remote-shell-spec.ts`: `remote:<hostId>[ <cmd>]`, with `parseRemoteShellSpec` and `isRemoteShellSpec`.
- `terminal-queries.ts`
- `startup-gate.ts`
- `mouse-modes.ts`: moved from the renderer and re-exported there.
- `remote-backoff.ts`

---

## C. wmux main process

### 1. Extract the backend interface

New file `src/main/terminal-backend.ts`. `CreateOptions` and `CreateResult` move here from `pty-manager.ts:574-605`.

```ts
interface TerminalBackend {
  kind: 'local'|'remote';
  create(o): Promise<CreateResult>;  probe(id): Promise<ProbeResult>;
  write; resize; claim; kill /*remote: close everywhere*/; release /*detach, keep process*/;
  has; onData; onExit(cb(code, info:{reason:'exited'|'closed'|'lost', last?})); onResync(cb(snapshot));
  getPid /*remote: undefined*/; liveSurfaceIds; count; deliverCommands;
}
```

- `PtyManager` (`src/main/pty-manager.ts:628`) implements it and keeps a synchronous `createSync()` for `AgentManager`.
- **`TerminalRouter`** (`src/main/terminal-router.ts`) picks the backend:
  1. a cached route for the surface id;
  2. else the host that owns the id in the registry mirror;
  3. else the host from a `remote:` shell spec;
  4. else local.

### 2. Remote host client

`src/main/remote-hosts/`:

| file | role |
|---|---|
| `host-client.ts` | one `RemoteHostClient` per host, implementing `TerminalBackend`; checks seq continuity (a gap forces a snapshot re-open); holds output until a listener subscribes; **drops input while offline**, never queues it; `wantSnapshot` handles a renderer reload |
| `connection-fsm.ts` | pure reducer: `disabled → connecting → handshaking → READY`; backoff `min(15 s, 250 ms·2ⁿ)` with ±20% jitter; `auth-failed` retries every 5 min; `incompatible` stops; `suspended` |
| `power.ts` | `powerMonitor` `suspend` closes and pauses; `resume` / `unlock-screen` / window focus while in backoff reconnects **immediately** |
| `pending-intents.ts` | close, groupClose, hide and similar actions issued offline, persisted to `%APPDATA%\wmux\remote-pending.json` and flushed right after `welcome`, before reconcile |
| `host-config.ts` | hosts `[{id, name, url, serverId?, tokenEnc}]`; the token is encrypted with Electron `safeStorage`; the renderer never sees it; `serverId` is pinned so the client fails closed if the URL starts pointing at a different server |
| `registry-mirror.ts`, `reconcile.ts`, `placement.ts` | see section E |

**On entering READY:**
1. send `theme`;
2. flush pending intents;
3. re-open every mounted surface with `{sinceSeq, bootId}` (a delta for short gaps);
4. mirror the registry;
5. reconcile.

**Heartbeat:** `ping` every 10 s; the connection is dead after 25 s with no frame.

**Device id** lives in `%APPDATA%\wmux\remote-device.json`.

### 3. Rewire call sites

Every `ptyManager.*` use becomes `terminals.*`.

**`src/main/ipc-handlers.ts`:**
- `:90`: build the router: `localPty`, `RemoteHosts`, `TerminalRouter`. `AgentManager` keeps `localPty`.
- `:592-691` (`PTY_CREATE`):
  - For a remote spec, skip the Windows cwd and env resolution and `sshDetector`.
  - `await terminals.create`.
  - Pull the batcher, bind and exit logic out into `wireForwarder(id, window)`. It also subscribes `onResync`, which sends `PTY_RESYNC` and calls `remoteTaps.noteResize`.
  - `PTY_EXIT` gains an `info` argument.
- `:693-720`: `PTY_WRITE`, `PTY_RESIZE`, `PTY_KILL(id, shellSpec)` and `PTY_HAS` go through the router. New `PTY_PROBE`, plus `PTY_FOCUS` (calls `claim`).
- `:168-180`: a destroyed window `release`s its remote surfaces.
- `:254-264`: `sshDetector` uses local-only PIDs.
- `:1427`: OSC 7 is ignored for remote surfaces; cwd comes from the server's `meta`.
- `:1819-1845`: `setupAgentPtyForwarding` uses `wireForwarder`, which removes the duplicate forwarder.

**`src/main/index.ts`:**
- `:304, 646, 824, 892, 901, 1982, 2015`: go through the router.
- `:1546`: `remoteHosts.start()` plus the power hooks; route `meta.cwd` to `broadcastMetadataUpdate(report_pwd)`.
- `:1351`: `pruneRestoredClaudeSessions` skips remote surfaces, whose transcripts are in WSL.
- `:2449`: `closeGuard` counts local PTYs only.
- **`:2457` and `:2512` (session-end and will-quit):** `localPty.killAll(); remoteHosts.detachAllNow()`. `detachAllNow` is a synchronous `ws.terminate()`. Quitting **never** kills remote sessions.

**Other main-process files:**
- `agent-session-persistence.ts:17`: fall back to the server's `meta.agent` for remote surfaces.
- New IPC channels in `src/shared/types.ts:692` and the preload (`src/preload/index.ts:48`):
  - `PTY_PROBE`, `PTY_RESYNC`, `PTY_FOCUS`
  - `RHOST_*`: list, save, remove, test, reconnect, status
  - `RSESS_*`: apply, layout-ready, update, close-group, hide, unhide, list-hidden, kill

---

## D. wmux renderer and store

### `src/renderer/hooks/useTerminal.ts`

1. **Resolve the shell before creating the terminal.** Compute `effectiveShell` (currently at `:1774`) before `new Terminal`. For remote surfaces:
   - leave `windowsPty` unset at `:979` and set `reflowCursorLine:false`;
   - call `installRemoteQuerySwallow` next to `:1052`;
   - write `shell:'remote:<hostId>'` into the surface, so changing the default shell later never respawns it locally.
2. **Attach path (`:1803-1852`).** Refactor it into `openPty({lost?})`. Subscribe before opening, then branch on `pty.probe()`:

   | probe result | action |
   |---|---|
   | live or exited | attach and restore the snapshot |
   | lost or unknown | create, with `withClaudeResume` taking the session id from the server's `last.agent` |
   | closed | show a "closed on <device>" message |

3. **`onResync`.** In order, synchronously:
   1. `replayHold.hold()`;
   2. `write('', reset+resize)`;
   3. `write(snapshot, release+refit)`.

   Reuse `utils/replay-hold.ts`, `restoreSurfaceState` (`:1087`), `resetTerminalModes` and `mouse-modes`.
4. **`onExit` by reason:**
   - `closed`: silent, because reconcile removes the tab.
   - `lost`: show "[wmux] <desktop> restarted; session restored", then `resetResume(id)` and `openPty({lost})`.
   - `exited`: the existing `[process exited]` banner.
5. **Focus and input.**
   - Focus in a focused window calls `pty.focus(id)`, which claims size.
   - Input is dropped while the host isn't ready.

### Other renderer changes

- **Default to remote:** `components/Settings/WorkspaceSettings.tsx:443-455` gets a `Remote: <name>` option per host. Setting the default shell to `remote:<desktop>` makes every new terminal remote. Quick-launch profiles get remote shells for free.
- **New UI:**
  - `components/Settings/RemoteHostsSettings.tsx`: name, URL, write-only token, Test, status.
  - `components/Terminal/RemoteOverlay.tsx`: "Reconnecting to <desktop>… [Retry now]", "Auth failed", and "Viewing at 200×50, focus to resize".
  - A host badge on sidebar `WorkspaceRow`.
  - A "Remote sessions" menu: hidden and unplaced sessions.
- **Store slice:** `src/renderer/remote-sessions/status.ts` holds host status.
- **Apply and sync:** `src/renderer/remote-sessions/apply.ts` and `sync.ts` apply placement actions and push renames, recolors and moves, with echo suppression.

---

## E. Session registry sync

### Link between workspaces and groups

- `WorkspaceInfo.remoteGroups?: Record<HostId, GroupId>` links a workspace to a group.
- A workspace is bound lazily, when its first remote terminal is created (`ensureRemoteGroup`).
- `remoteGroups` must be added to:
  - `createWorkspace` (`workspace-slice.ts:174`)
  - the `replaceAllWorkspaces` copy list (`:344`)
  - the save field lists (`App.tsx:1187`, `:1377`)
- Mixed workspaces are fine: local Windows panes in a bound workspace aren't shared.

### Lifecycle

The server broadcasts every event to every connection, and applying an event is idempotent.

| event | effect on the other device |
|---|---|
| create session in W | placed as a new tab in its copy of W (created there if missing) |
| close tab or pane (`killSurfacePty`, `pty-teardown.ts:39`, gets `shellSpec`) → `close` | `dropSurfacesLocal`: removed with no kill |
| close workspace (`closeWorkspace` — the CLI, or "End sessions on this host" in the remote close dialog; user gestures reach it only through that dialog) → `groupClose` per host | all its sessions are dropped, hidden ones included; W is discarded if nothing local is left |
| process exits on its own | `[process exited]` banner on both; closing it on either one removes it from both |
| rename or recolor W | the server takes the last write, and every device updates |
| move a session between workspaces | `sessionUpdate{groupId}`; the other device moves it too |
| Hide here (a tab, or "Hide on this device" for a whole workspace: `hideWorkspaceOnDevice`) | dropped locally only; `hiddenBy` gets this device's id; never a `close` or `groupClose` |

### New store actions

None of these call `pty.kill`.
- `insertSurface(…, {activate:false})`
- `dropSurfacesLocal(ids)`
- `hideSurface`
- `ensureRemoteGroup`
- `discardWorkspaceLocal`
- `createWorkspaceFromGroup`: builds a **single leaf** holding only the placed surfaces. It must never use the default 3-pane layout, which would spawn sessions.

### Race safety

- A create for a tombstoned id fails with `openError{closed}`, so a closed session can't be resurrected.
- When two closes of the same session race, the first broadcasts and the second just gets an `ack`.
- Ctrl+Shift+T already mints a new id (`surface-slice.ts:660`).

### Reconcile

`reconcile.ts` is pure; it runs on (re)connect and for each incremental event. Its inputs are the registry mirror, the device id, the local remote surfaces in every window (via `__wmux_remoteLayoutIndex`), and probe results.

**For each local remote surface:**

| registry has it? | condition | action |
|---|---|---|
| yes | hidden by this device | drop |
| yes | group differs | move |
| yes | lost and mounted | respawn with resume |
| no | tombstoned | drop (it was closed while this device slept) |
| no | unknown (registry wiped) | respawn |

**For each registry session not in the local layout and not hidden here:** place it.

**For each bound workspace:**
- group tombstoned: drop its sessions and unbind;
- name or color differs: take the server's values.

**Lost versus closed is exact:** the server persists every session (a restart marks them `lost`, keeping cwd and agent id), and closes leave tombstones.

**Placement** (`placement.ts`, a small swappable pure policy):
1. If a workspace is bound to the session's group, put the session in its focused pane (only when the window is focused and the workspace is active), otherwise in its first pane.
2. Otherwise create the workspace in the focused or first window.
3. Sessions with no group go to the "Inbox" group.

`sessionAdded` events are batched for 100 ms, so a new 3-pane workspace arrives as one workspace.

**Startup gating:** the first reconcile waits for `RSESS_LAYOUT_READY` from every window, sent at the end of the restore effect at `App.tsx:780-796`, with a 10 s cap. Without this, sessions would be placed before local `session.json` restores, giving duplicates.

### Agent resume after a server restart

1. The registry keeps `agent.sessionId` (from `agent-probe`) through the restart.
2. The session shows up as `lost`.
3. `useTerminal` creates it again through the existing `withClaudeResume` path, which types `claude --resume <id>` in the saved cwd.
4. If two devices respawn at once, the server's idempotent `open{create}` spawns once and the other device attaches.

---

## Phasing

- **Phase 1: server plus reliable single-machine reconnect.** Test on the desktop's Windows side first, then the laptop.
  - Server: sessions, gap-free attach, queries, size claim, close and exit, registry with tombstones and lost-on-boot, auth, systemd and install.
  - wmux: backend extraction, router, host client with state machine, heartbeat, power hooks, pending intents; settings and `safeStorage`; the `remote:` default shell; `useTerminal` changes; detach on quit; overlay and badge.
  - Reconcile limited to this device's own surfaces: attach, drop closed, respawn lost.
- **Phase 2: cross-device registry sync.**
  - Groups and binding, placement, incremental events, rename, recolor, close and move.
  - Hide and unhide, and the Hidden menu.
  - Layout-ready gating.
  - Resume ids from `agent-probe`; cwd from `meta`.
- **Phase 3: polish.**
  - A device that doesn't own a terminal's size renders it at the owner's size, with an overlay.
  - permessage-deflate for snapshots.
  - Snapshots persisted on SIGTERM.
  - A `\\wsl.localhost` explorer for remote cwds.
  - Paste and drop uploads over the WebSocket.
  - A `remotea` CLI: `status`, `token`, `rotate-token`.
- **Phase 4: agent hooks.**
  - A per-session relay in WSL so Claude hooks, `wmux hook` and shell integration (`WMUX_REMOTE`/`WMUX_REMOTE_TOKEN`) reach wmux, restricted to a whitelist of methods.
  - Server-side agent detection that reuses `src/shared/detection`.

---

## Defaults for the plan agent's open questions

Each of these is a default the user can override when reviewing:
1. **Resume after a server restart:** a new pref "Resume agents when the server restarts", **on** by default for remote hosts. The local resume prefs default to off.
2. **Load session:** remote surfaces that loading a session drops are **hidden**, not killed.
3. **Retention:** exited sessions are kept 7 days, tombstones 30 days. The fallback group is named "Inbox".
4. **Agents spawned from the CLI** (`wmux agent spawn`) stay local until phase 4.
5. **Workspace order** stays per device and isn't synced.

---

## Verification

**Unit tests, root vitest (`tests/unit/`):**
- protocol round trip and guards
- `remote-shell-spec`
- `terminal-router`: routing; `detachAllNow` never sends `close`
- `connection-fsm` under a fake clock: backoff and jitter, immediate reconnect on resume, heartbeat death, auth-failed doesn't spin
- `host-client` with a fake ws:
  - creates queued offline
  - held output
  - a seq gap forces a snapshot
  - input dropped offline
  - pending intents persisted and flushed before reconcile
- `reconcile`: the full state table
- `placement`
- `apply`:
  - drop and hide never kill
  - `closeWorkspace` calls `closeGroup`
  - `remoteGroups` survives `replaceAllWorkspaces`
  - echo suppression
- `host-config`: the token never reaches the renderer DTO

**Unit tests, server vitest (`remote-server/tests/`, run in WSL):**
- **Gap-free attach property test:** random chunk streams with CSI, OSC, alt-screen and wide characters, attached at random points. Snapshot plus later chunks must equal a reference terminal. Also covers delta mode, size change forcing a snapshot, and lagging resnapshot.
- **xterm ordering:** `write(A); write('',reset); write(B)` leaves B only.
- **Query responder:** exactly one reply with zero or two clients attached; swallow is a superset of what the server answers.
- **Registry:**
  - idempotent and racing closes
  - a tombstoned create is rejected
  - `groupClose` kills hidden sessions too
  - lost-on-boot keeps agent and cwd
  - per-device hide
  - atomic persistence
- **Size policy, auth** (401, Origin, Host, ban) and **flow control.**

**E2E (`remote-server/scripts/e2e.mjs`):** two ws clients with distinct device ids, then:
1. create, echo, check output
2. detach, generate output, reattach: delta, then snapshot equal to a reference
3. both clients close the same session at once: one `sessionClosed`, both acked
4. group close
5. hide on A only
6. `kill -9` the server and restart: `lost` with agent intact; both clients respawn the same id and get one process
7. `printf '\e[c'` with no client attached gets a reply

**Manual checklist (desktop Windows side and laptop):**
1. Start a long Claude run in a remote pane, close the laptop lid for 10 minutes, open it. The overlay appears, reconnect is immediate, and the screen and scrollback are intact.
2. Turn off Wi-Fi for 2 minutes. Disconnect is detected within 25 s, input is blocked, and it recovers.
3. Quit wmux. `ps` in WSL shows the processes still running. Relaunch: every pane is back with its scrollback.
4. `systemctl --user restart remotea`. Panes show "restarted; session restored", and `claude --resume <id>` relaunches in the right cwd.
5. Two devices at once:
   - create on the desktop, and it appears on the laptop in the same workspace
   - close on the laptop, and it's gone on the desktop
   - close on both in the same second: no errors, no resurrection
   - rename or recolor a workspace syncs
   - closing a workspace closes it everywhere, while local pwsh panes survive
   - hide or unhide on the laptop leaves the desktop unaffected
   - focus decides who controls the size
   - layouts stay independent
6. A process exits: the banner shows on both; closing it on one removes it from both.
7. A bad token gives an auth-failed state with no retry loop. After a WSL cold boot, the server picks up the Tailscale IP once it appears.
8. The phone Remote Console still mirrors a remote pane.

**Gate commands:**
- WSL: `npm --prefix remote-server test` and `node remote-server/scripts/e2e.mjs`.
- wmux: `npm run typecheck && npm run lint && npm test`, in WSL where possible.
- Running the app needs Windows. Install Node on the desktop's Windows side (it has git but no Node), clone the fork to a Windows path with no spaces, then `npm ci && npm run build:main && npm run dev`.

---

## Risks

1. **WSL idle shutdown kills every session.** Set `vmIdleTimeout=-1` in `.wslconfig`, or run a logon task `wsl.exe --exec sleep infinity`. The install script prints this. When the desktop itself sleeps, it is unreachable by design.
2. **Restarting or upgrading the server loses processes.** Node can't hand PTYs over to a new process the way herdr's live handoff does. That's why resume matters, and why install warns before restarting.
3. **`~/.claude/sessions/<pid>.json` is private to Claude Code.** Parse it defensively and fall back to `claude --continue` in the saved cwd. Phase 4 hooks replace it.
4. **xterm parity.** The headless and renderer xterm versions must stay locked together. The swallow-superset test guards against double replies.
5. **The token gives a shell in WSL** (and, through interop, on the desktop's Windows side). It is encrypted with `safeStorage`, and a Tailscale ACL should limit who can reach the port.
6. **Windows-only side panels don't work for remote cwds.** Explorer, git, diff and file drop in bound workspaces read the local filesystem until phase 3.

---

## Eridani session ledger integration

The [Eridani](https://app.eridani.app) ledger indexes every agent session by `(tool, session id)` and files each one under a client, project or issue. These four additions let it link a session to the live remotea workspace and terminal it is running in. None of them blocks phase 1.

1. **Codex in `agent-probe`.** For a `codex` descendant process, look for something direct first: an environment variable, or an open rollout file under `/proc/<pid>/fd`. If there's nothing, match the thread in `~/.codex/state_5.sqlite` (opened read-only) that has the same cwd and the `created_at_ms` closest to the process start time. Leave `agent` unset when the match is ambiguous.
2. **`remotea status --json`** (done; server CLI). This is a stable, read-only contract, versioned with a top-level `version`. For each session it reports:
   - id, `groupId`/`groupName`, state
   - `cwd`/`lastCwd`, title, cmd
   - `agent{provider, sessionId}`
   - `createdAt`, `lastActivityAt`
   - the creating device
3. **`remotea open --group <name> [--cwd] [--title] [--id] -- <cmd…>`** (done; server CLI). It creates the group if it's missing and types the command once the shell is ready, using the server's startup gate. It is idempotent when `--id` is passed. The ledger's resume commands become `remotea open --group "<client>" --cwd … -- claude --resume <id>`.
4. **One shared Claude `SessionStart` hook** (phase 4 relay). It reports `session_id` and `$REMOTEA_SESSION` to remotea, and prints the ledger line (`~/jarvis/scripts/session_collector/session_hook.py`). herdr's existing hook entries stay untouched.
