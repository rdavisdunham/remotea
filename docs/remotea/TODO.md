# remotea — deferred work

Naming used here and from now on: the **server** is the Node process under `remotea.service` in WSL (`remote-server/`); the **app** is the Electron client (`src/`). Eridani is a second client of the server, so "client" is avoided.

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
