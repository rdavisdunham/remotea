# remotea — deferred work

The current Linux/WSL **server** is the Node process under `remotea.service` (`remote-server/`). The **app** is the Electron client (`src/`). These labels distinguish Remotea's app from Eridani, which also connects to the server.

## Requested roadmap work — 2026-11-05

The following requests are tracked here and in Eridani. Checked entries are implemented. Installation and native hosting are future milestones after the core workflows stabilize.

### Live terminal work summaries

- [ ] Show concise live descriptions of what each terminal is working on overall.

Eridani backlog task `20a8228c-cc1a-486a-9fb2-d78e26a451e5`.

Start with the expandable terminal list in the workspace sidebar and consider a detail view. Reuse captured turns, task/run metadata and existing session summaries where possible. Define refresh triggers, freshness, server persistence and reconnect behaviour so connected apps show consistent summaries. Preserve user-chosen names and show generated summaries separately from live activity and status. This is a later feature expansion.

### Easy installation and updates

- [ ] Make Remotea and Eridani easy to install and update.

Eridani backlog task `bc27457c-96f7-4ba5-8d6e-dcb70d89b810`.

Schedule this release milestone once development shifts from frequent major changes to stabilization and bug fixing.

Provide a Windows installer for Remotea, guided setup for its server and Eridani pairing, automatic updates, and a recovery/rollback path. Give Eridani an installable web app experience with guided connection and permission setup. Show clear app/server versions and connection diagnostics. Guide users through prerequisites, setup, and the first successful launch.

Build on the existing release and update pathway in docs/remotea/TODO.md.

### Native Windows hosting and future macOS support

- [ ] Let Remotea manage a native Windows server for local CLI harnesses.

Eridani backlog task `0093259a-b7cf-4fc5-b828-d5c127f69b81`.

Plan a Remotea installation that can install and manage a local server on Windows. That server owns harness sessions running directly on Windows and accepts Eridani connections. It should run in the background so agent sessions can continue after the desktop window closes.

Support both a local setup with app, server, and harnesses on the same machine, and a remote setup connecting the app to another host. Share the server core and connection protocol across platforms, with platform adapters for terminals, processes, paths, and credentials. Preserve the current Linux/WSL host workflow and the architecture needed for eventual native macOS hosting and Eridani control.

This is future platform work to plan alongside installation once the core workflows stabilize.

### Separate Eridani runs in the desktop sidebar

- [x] Separate Eridani runs from manual sessions in Remotea's sidebar.

Eridani backlog task `dbc8deae-11a3-4748-8fdc-f95c7a69d52d`.

Keep manual workspaces and sessions as the main selectable items in Remotea's left sidebar. Put all Eridani-originated runs in a dedicated collapsible section at the bottom, collapsed by default so delegated work stays unobtrusive.

Expand the section to see the task/run names and current states, then select a run to inspect its conversation. Keep Eridani runs in this section even when their repository matches an existing manual workspace. The final requested design is separation by run origin. Preserve that identity through reloads, reconnects, and run lifecycle changes. Collapsing the section only changes visibility. Implemented with saved expansion state, existing-tab separation through registry sync, and workspace controls scoped to each section.

### One terminal per new workspace

- [x] Default new Remotea workspaces to one terminal.

Eridani backlog task `0f01ad45-e247-459e-ba1c-1720cb0442fc`.

Create one terminal when opening a new Remotea workspace. Let the user add further terminals or split panes through the existing controls.

Apply the one-terminal default consistently across the normal workspace-creation entry points. Repeatedly creating new workspaces produces one initial terminal in each. The former three-pane grid default migrates once to one terminal. Saved layouts, custom arrangements, and subsequent explicit pane-count choices take precedence.

## Update pathway: `remotea update` and an Update button (2026-10-28)

Goal: push a tagged release and have both pieces update themselves, from the CLI (`remotea update`) or from the app (an Update button that updates the server and then the app).

What already exists (from wmux): `electron-updater` + zip fallback (`src/main/updater.ts`, `zip-updater.ts`), the GitHub changelog reader (`changelog.ts`), and `electron-builder.json` publishing to `rdavisdunham/remotea`. The app side only lacks releases to point at.

Work, in order:
1. **Releases.** One tag versions both pieces (`vX.Y.Z` bumps `package.json` and `remote-server/package.json` together). A GitHub Actions release workflow builds the Windows app on tag and publishes the release with the electron-builder update manifest (`latest.yml`) and a server tarball (or the server uses the tag directly). No secrets or local config in artifacts.
2. **Versions on the wire.** Server reports its version in the hub `hello`/`welcome` and in `remotea status --json` (additive); app shows "server vX, update available" using the same releases API the changelog already reads.
3. **`remotea update` (server).** Fetch the release tag into the service's checkout (`git fetch && git checkout vX.Y.Z` on `~/remotea/remotea`, or unpack the tarball), `npm ci`, build, run `remote-server/scripts/install.sh --yes` non-interactively, then restart. Care points:
   - The restart bounces every PTY. Default: refuse if any session is busy unless `--now`; always drain Eridani runs first (pause admission, let current turns finish or `stop`), announce via the link so Eridani shows "host updating".
   - Running from inside a remotea terminal: hand the restart to systemd as a detached unit (`systemd-run --user`) so the updater outlives its own PTY; print the unit name and how to tail it.
   - Rollback: keep the previous build directory; `remotea update --rollback` switches back and restarts.
4. **Update button (app).** Hub RPC `update.check` / `update.run` (token-authenticated like everything else); server runs step 3 detached and streams progress; app shows progress, reconnects after the bounce, then runs its own `checkForUpdates` → "restart to update". Laptop app updates itself; the desktop WSL server is updated from either place.
5. **Docs.** `README.md` install/update section; `eridani-link.md` note on what Eridani sees during an update (host offline briefly, runs resume server-side).

Estimate: one overnight worker session, two if the drain logic is done properly. The Eridani link already negotiates capabilities, so the server may lag the app by a release.

## Also deferred (from the 2026-10-28 security audit)
- Verify sandboxing on the host (bubblewrap / `codex sandbox linux`, no network) so agent-edited test scripts cannot escape the agent's sandbox. See `eridani-link.md` → "Not yet implemented".
- Claude workspace-trust dialog on fresh worktrees: opt-in config that pre-trusts paths under a target's `worktreeRoot` (recommended), or detect-and-accept on screen.
- Codex "installed but untrusted" hooks state is not detected.
- Codex/OpenCode structured question answering (Eridani roadmap task).
