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

### 1. Server (in WSL on the desktop)

Requirements: systemd enabled in WSL, Node ≥ 20, `make`, `g++`, `python3`.

```bash
cd remote-server
./scripts/install.sh      # builds, creates ~/.config/remotea/{config.json,token}, enables remotea.service
```

The server listens on port **7717**, on `127.0.0.1` and on WSL's Tailscale address only. Every connection must present the token from `~/.config/remotea/token`, which is effectively shell access: treat it like an SSH key.

Keep WSL from idling out, or the sessions die with it: set `vmIdleTimeout=-1` under `[wsl2]` in `%UserProfile%\.wslconfig`.

### 2. App (on each Windows machine)

```powershell
npm ci
npm run build:main
npm run dev               # or: npm run build  (installer)
```

Then in **Settings → Remote hosts**, add the host:
- **URL:** `ws://<tailscale-name>:7717` from the laptop, or `ws://127.0.0.1:7717` on the desktop itself.
- **Token:** paste the token.

To make every new terminal remote, set **Default shell** to `Remote: <host>`.

## Status

Under active development. See the plan in `docs/remotea/plan.md`.

## License

MIT. See [LICENSE](LICENSE). The original wmux copyright is kept, and herdr is credited in [CREDITS.md](CREDITS.md).
