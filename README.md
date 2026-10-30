# remotea

**Persistent remote terminals for AI coding agents.** A Windows GUI for organizing agents, attached to a session server in WSL that keeps every terminal alive, even when the laptop you're working from goes to sleep.

> remotea = the **wmux** desktop app + a **herdr**-style session server. See [CREDITS.md](CREDITS.md).

```
Laptop (Windows)                          Desktop
┌──────────────────────┐   Tailscale     ┌──────────── WSL (systemd user service) ────────────┐
│ remotea app          │  ws + token     │ remotea server                                      │
│  workspaces, splits, │ ─────────────── │  owns every PTY (node-pty) + a headless xterm each  │
│  agent status, ...   │                 │  replays screen + scrollback on reconnect           │
└──────────────────────┘                 │  session registry shared by every device            │
                                         └─────────────────────────────────────────────────────┘
        Desktop's Windows side runs the same app against ws://127.0.0.1
```

## Why

SSH-ing into the desktop from a laptop works until the laptop sleeps. Then the session dies, and you have to find it and restart it. herdr fixes the persistence but is a TUI. wmux has a rich Windows GUI but only runs local terminals. remotea combines them.

- **Terminals live on the server.** Closing the lid, losing Wi-Fi, or quitting the app only *detaches*. Agents keep running in WSL.
- **Automatic reconnect.** On wake (`powerMonitor` resume), after a dropped connection (heartbeat), or on relaunch, every pane reattaches. Short gaps replay only the bytes you missed; long ones get a full screen and scrollback snapshot.
- **Shared sessions, per-device layout.**
  - Sessions and workspaces (name and color) are shared by every device: a terminal opened on the desktop shows up on the laptop in the same workspace.
  - Each device keeps its own splits, windows and monitor layout.
  - **End sessions on this host** closes a session (or a whole workspace's sessions) everywhere. It always asks first, and lists what it would stop.
  - **Hide on this device** removes it from one machine only.
- **Survives server restarts, partly.** If WSL restarts, the processes are gone, but sessions come back in their saved directories, and Claude Code sessions are resumed (`claude --resume <id>`).
- **Everything wmux does** still works for remote panes: xterm scrollback and search, notifications, cwd tracking, and agent-state detection. The server streams raw PTY bytes, not repainted frames.

## Layout

| Path | What |
|---|---|
| `src/` | The Windows app (Electron + React + xterm.js), built on wmux |
| `remote-server/` | The WSL session server (Node + node-pty + `@xterm/headless`) |
| `src/shared/remote-host-protocol.ts` | Wire protocol shared by the app and the server |
| `docs/remotea/` | Design notes |
| `docs/upstream/` | wmux's original README |

## Install

### 1. Server (in WSL on the machine that runs your agents)

Requirements: systemd enabled in WSL (`[boot] systemd=true` in `/etc/wsl.conf`), **Node ≥ 22.13** (Node 22 LTS; `remote-server/.nvmrc`, so `nvm install` there picks it), `make`, `g++`, `python3`.

Node 22.13 is the floor because the session collector reads Codex's databases with `node:sqlite`, which Node 22 ships unflagged from 22.13. `remote-server/package.json` `engines` states it, CI runs the server on Node 22 from `.nvmrc`, and `install.sh` checks it (`scripts/check-node.sh`) and stops before building on anything older. The running service uses the `node` that was on PATH when you ran `install.sh`, so after upgrading Node, run `install.sh` again.

```bash
cd remote-server
./scripts/install.sh      # builds, creates ~/.config/remotea/{config.json,token}, enables remotea.service
remotea token             # the token the app needs
```

- The server listens on port **7717**, on `127.0.0.1` and WSL's Tailscale address only, never on every interface.
- Every connection must present the token. The token is effectively shell access to that machine, so treat it like an SSH key. A Tailscale ACL that limits port 7717 to your own devices is a good second fence.
- **Rotating the token revokes it.** `remotea rotate-token` replaces `~/.config/remotea/token`. The running server watches that file (and re-reads it on every handshake), so within a moment it closes every connection that was admitted with the old token, with WebSocket close code **4401** `token rotated`, and drops anything those sockets were still sending. No restart is needed. What clients experience:
  - Terminals and agents keep running. Only the connections are closed; the sessions and their scrollback stay on the server.
  - Each app goes straight to "rejected the token" (Settings → Remote hosts: **Token rejected**) on the 4401 close, without first trying to reconnect with the old token, which would only get HTTP 401. If a new token was already pasted there, it reconnects with that one instead.
  - Paste the new token (`remotea token`) into Settings → Remote hosts. The app retries at once and reattaches every pane where it was.
  - Not affected: agent status hooks on `127.0.0.1:7718` (per-session tokens from a separate secret), the outbound Eridani link (its own key), and server-side `remotea` commands, which read the file.
- Keep WSL from idling out, or the sessions die with it. In `%UserProfile%\.wslconfig`, set `vmIdleTimeout=-1` under `[wsl2]`.
- Logs: `journalctl --user -u remotea -f`
- Restart: `systemctl --user restart remotea`. A restart ends running processes. The apps respawn them, and Claude Code and Codex sessions are resumed.

**Eridani quick start (optional).** To let [Eridani](docs/remotea/eridani-link.md) start agents here, run `remotea eridani setup` in WSL and paste the setup code Eridani shows after **Enable** (Settings → Connections); it is read without echo. The wizard writes the link key and URL, offers the git repositories it finds as execution targets (with a launch config and a detected verify command), saves the MCP bot key that spawned agents use (`~/.config/remotea/eridani-mcp-token`, 0600, never the link key), offers a user-level `eridani` MCP entry for each installed harness (Claude Code, Codex, OpenCode; an existing entry is only replaced with `--replace`), reports whether the hooks are current, and ends with a per-target readiness table and a list of what it changed and what it skipped. It is safe to run again: a second run changes nothing. Every answer has a flag for scripts (`remotea eridani setup --help`), and `remotea eridani status` shows the same wiring and readiness later. Details: [Setup](docs/remotea/eridani-link.md#setup).

### 2. App (on each Windows machine)

Requirements: git and Node, with Node 22 LTS recommended (`winget install OpenJS.NodeJS.LTS`). Node 20.19+ also works (root `package.json` `engines`: `^20.19.0 || ^22.13.0 || >=24.0.0`). Clone to a path **without spaces**, then:

```powershell
git clone https://github.com/rdavisdunham/remotea C:\dev\remotea
cd C:\dev\remotea
npm ci
npm run build:main
npm run dev               # development run (Vite + Electron)
# npm run build           # installer, in release\
```

`node-pty` ships Windows prebuilds, so no compiler is needed.

The app's Node requirement is separate from the server's on purpose. Node here only runs the build tools (Vite, TypeScript, electron-builder, Vitest), and their floor is what the root `engines` states. CI and the release build use Node 20. The app itself runs on the Node that Electron bundles, and it never loads `node:sqlite`, so the server's 22.13 floor does not apply to it.

Then, in **Settings → Remote hosts → Add remote host**:

| Field | Value |
|---|---|
| URL from a laptop (over Tailscale) | `ws://<tailscale-name>:7717` |
| URL on the server PC's own Windows side | `ws://127.0.0.1:7717` |
| Token | output of `remotea token` |

Press **Test**, then **Save**. Tick **New terminals open here by default** to make every new terminal remote. The same choice is in **Settings → Workspace → Default shell** as `Remote: <host>`.

remotea uses its own named pipe and app-data folder (`%APPDATA%\remotea`), so it runs side by side with a stock wmux install.

## Using it

- **Opening terminals.** New terminals open on the host (when it's the default). A shell spec of `remote:<host>` or `remote:<host> claude` works anywhere a shell can be chosen: profiles, workspace shells, `wmux`-style CLI commands.
- **Sleep, Wi-Fi loss, quitting the app.** Panes show "Reconnecting…" and catch up on their own; nothing you type while disconnected is sent later. Quitting detaches the sessions, and reopening the app reattaches them.
- **A second device.** Every session shows up there in the same workspace (name and colour are shared). Arrange it however suits that screen; layouts are never synced.
- **Closing.** Closing a remote tab, pane or workspace (×, Ctrl+W, Ctrl+Shift+W, the context menu) always asks, whatever the "Confirm before closing a session" setting says. The dialog offers two commands:
  - **Hide on this device** removes it from this device only. The sessions keep running and stay on your other devices. Bring them back from Settings → Remote hosts → Hidden on this device. Also on the tab and workspace right-click menus.
  - **End sessions on this host** stops them on every device. For a workspace that means its whole shared group, including sessions hidden on this device and Eridani agent runs. The dialog lists the host, how many sessions are active, how many are hidden here, and the Eridani tasks and runs among them. When the host is offline, it says the counts may be stale.
  - Closes from the CLI or agents (`wmux close-workspace`) do not ask. Quitting the app only detaches.
- **Pasting and dropping files.** A screenshot pasted into a remote pane, or files dropped on it, are uploaded to the host and their paths there are typed in, so the agent in that pane can open them. They land in a private `/tmp/remotea-drop-…/` folder (200 MiB per file). All of them together are held to a budget, `uploadBudgetMiB` in `config.json` (default 2048, i.e. 2 GiB), and an age, `uploadMaxAgeDays` (default 7): the server removes expired files and then the oldest until a new upload fits, but never one of a live session's most recent drops (they also keep 10 minutes of grace after the upload and after the session ends). When the budget is held by such files, the upload is refused with "upload budget full …". `remotea status` shows the usage (`uploads {bytes, files, budget, …}` in `--json`, also written to `~/.config/remotea/uploads-status.json`), with a degraded note when the temp filesystem is under 5% free. A changed setting applies on the next server start.
- **Terminal size.** The device you're typing on, or whose window is focused on that pane, controls the size of a shared terminal.

Server-side CLI (in WSL):

```bash
remotea status [--json]                              # sessions, workspaces, agents (stable JSON, "version": 1)
remotea doctor [--json] [--probe]                    # redacted readiness report, exit 1 on any failure (below)
remotea open --group "Acme" --cwd ~/acme -- claude   # open a session in a workspace on every device
remotea close <surf-id>                              # end a session everywhere
remotea token | rotate-token                         # rotate-token revokes the old token: apps using it are disconnected
remotea hooks install | remove | status              # agent status hooks (see below)
remotea logs [-f] [--device laptop] [--since 10m]    # what the apps reported: connections, reattaches, agent state
remotea screen <surf-id>                             # what a session's screen shows right now
```

### Readiness check (`remotea doctor`)

```bash
remotea doctor [--json] [--probe]
```

One redacted report of whether this host is ready to serve apps and Eridani: the `remotea.service` unit (installed, running, its user and `PATH`), build identity (running vs on-disk sha, dirty, caps and hook versions), the listener on 7717 and the token file (presence and mode only), the collector (mode, last scan, `node:sqlite` available for Codex sessions), the Eridani link (configured, last welcome, backlog, rejected frames), the status hooks per agent (Claude Code, Codex, OpenCode: installed vs expected, Codex hook trust), each execution target (repo, launch readiness per harness, each verify command: binary resolvable under the service `PATH`, `node_modules`/`.venv` present, a database URL when the command looks like it needs one, isolation, MCP key), free disk for the config, temp and worktree roots, upload budget, and recovery warnings (worktrees with unmerged work, sessions still marked live from a previous server boot).

- Every line is `ok`, `warn` or `fail`, and every warn/fail has a one-line fix.
- Nothing secret is printed: no keys or tokens, no environment dumps, and paths under your home show as `~`.
- It only reads. It never starts, restarts or installs anything (not even the config file), and never fetches. `--probe` additionally runs each harness's launch probe (the same as `remotea eridani status --probe`).
- `--json` prints a stable object (`"version": 1`; shape in [docs/remotea/eridani-link.md](docs/remotea/eridani-link.md#doctor)).
- Exit code 0 when nothing fails, 1 otherwise, so it works as a CI or cron gate.

The running server computes the same report every 5 minutes (and after a reconfigure) and, when the link is up, sends Eridani its warn/fail lines (see [Doctor](docs/remotea/eridani-link.md#doctor)).

### Agent status (hooks)

Agents in remotea terminals report their state (working, needs you, done) the same way they do in wmux: through wmux's hook helper and plugins: Claude Code, Codex, OpenCode, pi, omp, Grok, Qwen Code and Antigravity, whichever are installed in WSL. In WSL the helper can't reach the app's named pipe, so it reports to the server instead, on `127.0.0.1:7718` (`hookPort` in `config.json`). The server relays it to every app showing that session and replays the latest state to an app that connects later, for example a laptop waking up after the turn ended.

- `install.sh` offers to install the hooks (yes/no; `--hooks` or `--no-hooks` to decide up front). `remotea hooks install` adds these entries next to any other hooks you have, and `remotea hooks remove` takes only its own back out. The first change to each file keeps a `.remotea-backup` copy.
- Each session gets its own token (`WMUX_REMOTE_TOKEN`), which can only report status for that session. The main token never enters a session's environment.
- Outside a remotea terminal the helper exits immediately.

### Eridani (optional)

The server can link to [Eridani](docs/remotea/eridani-link.md), which then starts Claude Code and Codex runs in managed worktrees here. `remotea eridani setup` does all of the below in one go (see the quick start under Install); the steps by hand: `remotea eridani connect` sets up the link key (`~/.config/remotea/eridani-token`). A run's agent reports its plan and steps through Eridani's MCP tools (`submit_plan`, `task_step`, `task_interview`, `session_link`), so it needs a **second** key, used only for MCP:

1. In Eridani, open Settings → Connections → Bot keys and create a bot key with the scopes **agents:session**, **tasks** (read/write) and **notes** (read/write). The owner does this once per machine.
2. Save it on this machine: `install -m 600 /dev/null ~/.config/remotea/eridani-mcp-token`, then paste the key into that file (one line, `eri_bot_…`). Do not reuse the link key; remotea refuses it.

Each spawn reads the file, so no restart is needed. Without it, agents still start but have no Eridani tools, and Eridani is told why (`mcp.configured: false`). `remotea eridani targets list` shows whether each target is ready. Details, including `mcpKeyFile` and `mcpUrl` in `eridani.json`: [docs/remotea/eridani-link.md](docs/remotea/eridani-link.md#eridani-mcp-for-spawned-agents).

### Diagnostics

Each app sends the server a stream of what happened: connection state, how each pane reattached (delta or snapshot), resyncs, sequence gaps, and agent-state verdicts. It never includes terminal content, keystrokes or prompts. It lands in `~/.local/state/remotea/diag/<device>.jsonl`, capped and rotated, and `remotea logs` reads it.

## Development

| Area | Command |
|---|---|
| Server tests (WSL) | `npm --prefix remote-server test` |
| Server end-to-end (WSL) | `npm --prefix remote-server run build && node remote-server/scripts/e2e.mjs` |
| App tests | `npm test` (some upstream tests need Windows: ConPTY, PowerShell) |
| Typecheck | `npm run typecheck` |
| Lint | `npm run lint` |

Design and phasing are in [docs/remotea/plan.md](docs/remotea/plan.md). Notes for agents working in this repo are at the top of [AGENTS.md](AGENTS.md).

## License

MIT. See [LICENSE](LICENSE). The original wmux copyright is kept, and herdr is credited in [CREDITS.md](CREDITS.md).
