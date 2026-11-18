# Credits

remotea is a combination of two ideas from two open-source projects. It would not exist without them.

## wmux: the desktop app

**Author:** Amir Lehmam ([@amirlehmam](https://github.com/amirlehmam)) and the wmux contributors
**Project:** <https://github.com/amirlehmam/wmux> · <https://wmux.org>
**License:** MIT

remotea's Windows app **is** wmux: an Electron/React/xterm.js terminal multiplexer for AI agents with workspaces, splits, agent-state detection, notifications, session restore, and the rest of its organizational features. This repository started as a clone of wmux v2.45.0 (`29c1d52`). wmux's full commit history is preserved here, so every upstream contributor is credited for their work in `git log`. remotea no longer merges from wmux. Each wmux fix it takes later is copied with `git cherry-pick -x`, keeping its author, and listed in the [upstream ledger](docs/remotea/upstream-ledger.md).

remotea adds the following on top:

- a pluggable terminal backend
- a remote-host client that attaches terminals to the remotea server
- reconnect after sleep
- cross-device session sync
- "hide on this device"

wmux's original README is kept at [`docs/upstream/wmux-README.md`](docs/upstream/wmux-README.md). The wmux MIT copyright notice is kept in [`LICENSE`](LICENSE).

## herdr: the server architecture

**Author:** Ogulcan Celik ([@ogulcancelik](https://github.com/ogulcancelik)) and the herdr contributors
**Project:** <https://github.com/herdrdev/herdr> · <https://herdr.dev>
**License:** Apache-2.0

remotea's server (`remote-server/`) follows herdr's design:

- a long-lived server, not the client, owns every PTY and a terminal emulator for each one;
- clients attach and detach without disturbing the processes;
- state is persisted so agent sessions can be resumed after a restart;
- the size policy is "last interacting client controls the size".

herdr's source was used as a reference while designing the server (`src/server/`, `src/persist/`, the terminal session control protocol). remotea's server is a new TypeScript implementation and **contains no herdr source code**. If herdr code or agent-detection manifests are ever imported, they will keep their Apache-2.0 headers, and herdr's license will be added under `third_party/herdr/`.

If you just want a persistent, agent-aware terminal multiplexer that works over SSH, use herdr. It's excellent.

## Other open-source building blocks

- [xterm.js](https://github.com/xtermjs/xterm.js) (MIT), including `@xterm/headless` on the server
- [node-pty](https://github.com/microsoft/node-pty) (MIT)
- [ws](https://github.com/websockets/ws) (MIT)
- [Electron](https://github.com/electron/electron) (MIT)
