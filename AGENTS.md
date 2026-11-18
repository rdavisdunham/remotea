# remotea

remotea is a desktop terminal app for running coding agents, on this computer and on remote hosts. It splits terminals into workspaces, panes and tabs, and shows what each agent is doing. A session server (`remote-server/`, modeled on [herdr](https://github.com/herdrdev/herdr)) owns remote terminals so they outlive the app. TypeScript, Electron, React 19, Zustand, xterm.js, node-pty.

## remotea is a hard fork of wmux

remotea started as a fork of [wmux](https://github.com/amirlehmam/wmux) (MIT, by Amir Lehmam) at `29c1d52`. It does not merge from wmux.

- **Taking a wmux fix:** cherry-pick it on its own with `git cherry-pick -x`, and add a row to `docs/remotea/upstream-ledger.md` with the ruling and the remotea commit. Rename any wmux name it brings in to the remotea name already used for that thing.
- **Names:** much of the code still says wmux: `window.wmux`, `WMUX_*` variables, `__wmux_*` test hooks, `wmux*.ts` files, CSS classes. The wmux cleanup renames these one kind of name per change. Until a kind is renamed, keep using its existing name where code has to match it, and add no new wmux names. Text people see says remotea.
- **Identity:** the pipe, the APPDATA folder and the AppUserModelId use the base name `remotea` (`src/shared/instance.ts`), so remotea runs beside a stock wmux install.

## Where things are

| Path | Role |
|---|---|
| `remote-server/` | WSL session server. It has its own `package.json` and `node_modules` (node-pty built for Linux Node, not Electron). Run its tests from WSL with `npm --prefix remote-server test`. |
| `src/shared/remote-host-protocol.ts` | Wire protocol shared by the server and app main. Pure: no Node or DOM imports. |
| `src/main/terminal-router.ts` | Every terminal operation in main goes through it: local surfaces to `PtyManager` (`pty-manager.ts`), remote ones to that host's `RemoteHostClient`. |
| `src/main/remote-hosts/` | Remote host client: connection state machine, registry mirror, reconcile, placement, pending intents. |
| `src/renderer/remote-sessions/` | Applies server-driven placement to the store and syncs workspace metadata back. |
| `docs/remotea/architecture.md` | What each main, renderer and preload file does, the design decisions the code depends on, and the pipe methods. Read it before changing a part you don't know. |
| `docs/remotea/plan.md` | The session server's design and phasing plan. |
| `docs/remotea/help.md` | What users can do, and where local and host features differ. |
| `src/renderer/remote/AGENTS.md`, `src/main/remote-console/AGENTS.md` | Rules for the phone Remote Console. Read them before changing anything there. |

Naming: "remote" already means the phone **Remote Console** (`remote-console-*`) and ssh uploads (`remote-insert.ts`). The remote-host feature uses **remote host** and **remote session**. `CONTEXT.md` has the rest of the glossary.

## Build and test

```bash
npm run dev            # Vite (port 5199) + Electron hot-reload
npm run build:main     # tsc main/preload/cli + bundle the sandboxed preload (fast iteration)
npm run build:renderer # Vite production build: BOTH entries (desktop index.html + remote/index.html), writes dist/renderer/remote-manifest.json (the console server refuses to serve without it)
npm run build          # Full: tsc + vite + electron-builder
npm run typecheck      # tsc for the renderer and for main/preload/cli
npm test               # Vitest unit tests
npx vitest run tests/unit/pty-manager.test.ts  # one file
npm run lint           # ESLint src/
npm --prefix remote-server test                # session server, from WSL
```

`resources/cli/` holds the built CLI that ships with the app. After changing `src/cli/`, run `npm run build:main` and copy `dist/cli/*.js` over it; `npm run verify:resources` checks the copy (only the release workflow runs it, so run it yourself). `resources/shell-integration/` mirrors `src/shell-integration/` byte for byte, so edit both.

Testing in the real app (from WSL, on the PC that runs the server): `node scripts/desktop-test/harness.mjs up` runs a **test copy** of the app on this PC's Windows side, against a **test server** (port 7719), and drives it over the Chrome DevTools Protocol.
- `eval`, `shot`, `type`, `key` and `screen` drive the app; `diag` reads its diagnostics; `down` stops both.
- The renderer's `window.__wmux_*` automation hooks (`src/renderer/pipe-bridge.ts`) do most of the work.
- It never touches the real server, its sessions, or `~/.claude`.

Debugging the real setup: `remotea logs` shows what each app reported (no content), and `remotea screen <id>` shows a pane's screen.

## Conventions

- **State:** Zustand slices in `src/renderer/store/`, composed in `index.ts`.
- **IPC:** channels are defined in `IPC_CHANNELS` in `src/shared/types.ts`; never use a string literal.
- **CSS:** `src/renderer/styles/`, a class prefix per component (`.pane-wrapper__*`, `.surface-tab__*`).
- **Immutable trees:** split tree changes always produce new objects; use the helpers in `src/renderer/store/split-utils.ts`.
- **PTY IDs are surface IDs:** always pass `surfaceId` when creating a PTY, so it can be reattached.
- **Shortcuts:** every action in `DEFAULT_SHORTCUTS` has a default key, and its label in `src/renderer/shortcuts.ts` starts with a verb.

## Agent skills

Task procedures live in repo skills, loaded only when a task matches. `.agents/skills/<name>/SKILL.md` is the source of truth, and Codex reads it there. `.claude/skills/` is a generated copy for Claude Code: edit `.agents/skills/`, then run `npm run sync:skills`. `npm test` fails while the two differ, and when a `SKILL.md` uses frontmatter outside the Agent Skills spec (`name`, `description`, `license`, `compatibility`, `metadata`, `allowed-tools`), since the same file has to load in both agents.
