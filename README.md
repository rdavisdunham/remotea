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
  - Closing a session anywhere closes it everywhere.
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

Requirements: systemd enabled in WSL (`[boot] systemd=true` in `/etc/wsl.conf`), Node ≥ 20, `make`, `g++`, `python3`.

```bash
cd remote-server
./scripts/install.sh      # builds, creates ~/.config/remotea/{config.json,token}, enables remotea.service
remotea token             # the token the app needs
```

- The server listens on port **7717**, on `127.0.0.1` and WSL's Tailscale address only, never on every interface.
- Every connection must present the token. The token is effectively shell access to that machine, so treat it like an SSH key. A Tailscale ACL that limits port 7717 to your own devices is a good second fence.
- Keep WSL from idling out, or the sessions die with it. In `%UserProfile%\.wslconfig`, set `vmIdleTimeout=-1` under `[wsl2]`.
- Logs: `journalctl --user -u remotea -f`
- Restart: `systemctl --user restart remotea`. A restart ends running processes. The apps respawn them, and Claude Code and Codex sessions are resumed.

### 2. App (on each Windows machine)

Requirements: Node 22 (`winget install OpenJS.NodeJS.LTS`) and git. Clone to a path **without spaces**, then:

```powershell
git clone https://github.com/rdavisdunham/remotea C:\dev\remotea
cd C:\dev\remotea
npm ci
npm run build:main
npm run dev               # development run (Vite + Electron)
# npm run build           # installer, in release\
```

`node-pty` ships Windows prebuilds, so no compiler is needed.

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
- **Closing.**
  - Closing a tab ends that session on every device.
  - Closing a workspace ends all of its sessions everywhere.
  - **Hide on this device** (tab right-click) removes a tab from one device only. Bring it back from Settings → Remote hosts → Hidden on this device.
- **Terminal size.** The device you're typing on, or whose window is focused on that pane, controls the size of a shared terminal.

Server-side CLI (in WSL):

```bash
remotea status [--json]                              # sessions, workspaces, agents (stable JSON, "version": 1)
remotea open --group "Acme" --cwd ~/acme -- claude   # open a session in a workspace on every device
remotea close <surf-id>                              # end a session everywhere
remotea token | rotate-token
```

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
