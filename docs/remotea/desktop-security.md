# Desktop app privileges (audit)

What the Electron app's windows, preload and sessions are allowed to do, what each setting was before the hardening pass of 2026-10-30 (Eridani task 927d6c3a, PRD_MISSION_CONTROL_RELIABILITY A-S4), what it is now, and what is left. The policy code is `src/main/security-policy.ts` (window preferences, `openExternal` allowlist, permission decision), `src/main/webview-prefs.ts` and `src/main/webview-navigation.ts` (browser panel), and `src/shared/renderer-csp.ts` (CSP). `tests/unit/desktop-security.test.ts` checks the main-window rows of the first table against this file, so change the code and this table together.

## What runs where

| Contents | Loads | Preload | Who can reach it |
|---|---|---|---|
| App window (`WindowManager.createWindow`) | `dist/renderer/index.html` over `file://` (dev: `http://localhost:5199`) | `dist/preload/index.js`, which exposes `window.wmux` | Our own UI. It also renders untrusted text: markdown from agents and files (through DOMPurify), release notes, OSC 8 links, and terminal output. |
| Browser panel `<webview>` | Any URL the user or an agent opens | None (removed in `will-attach-webview`) | Arbitrary web content |
| Popup from the panel (`window.open` with features, used for sign-in) | The provider's pages | None | Arbitrary web content |

## Main window

| Setting | Before | Now | Status | Why |
|---|---|---|---|---|
| `nodeIntegration` | `false` | `false` | unchanged | The renderer never needs Node. |
| `contextIsolation` | `true` | `true` | unchanged | `window.wmux` is reached only through `contextBridge`. |
| `sandbox` | `false` | `true` | done in this PR | The preload needed Node for two values only, `os.homedir()` and `os.release()`. Main now passes them as one `additionalArguments` entry (`--remotea-host-info=`, see `src/shared/host-info.ts`), and the preload reads it from `process.argv`. A sandboxed preload cannot `require` a relative path, so `npm run build:main` now bundles the preload into one file (`scripts/bundle-preload.mjs`). The build fails if the bundle requires anything except `electron`. |
| `nodeIntegrationInSubFrames` | default (`false`) | `false` | done in this PR (made explicit) | |
| `nodeIntegrationInWorker` | default (`false`) | `false` | done in this PR (made explicit) | |
| `webSecurity` | default (`true`) | `true` | done in this PR (made explicit) | |
| `allowRunningInsecureContent` | default (`false`) | `false` | done in this PR (made explicit) | |
| `webviewTag` | `true` | `true` | kept on purpose | The browser panel is a `<webview>`. Each guest is locked down again when it attaches (next table). Moving the panel to `WebContentsView` would let this go, but that rewrites the panel, so it is a follow-up. |
| `additionalArguments` | none | the host info | done in this PR | Holds the home directory and the OS release, which aren't secret. It replaces the preload's `os` import. |
| Remote module | not used | not used | n/a | `@electron/remote` isn't a dependency, and Electron removed `enableRemoteModule`. |

## Browser panel guests (`will-attach-webview`)

| Setting | Before | Now | Status |
|---|---|---|---|
| `preload` / `preloadURL` | stripped | stripped | unchanged |
| `nodeIntegration` | forced `false` | forced `false` | unchanged |
| `contextIsolation` | forced `true` | forced `true` | unchanged |
| `sandbox` | DOM attribute / default | forced `true` | done in this PR |
| `webSecurity` (`disablewebsecurity` attribute) | DOM attribute | forced `true`, attribute removed | done in this PR |
| `allowRunningInsecureContent` | DOM attribute | forced `false` | done in this PR |
| `nodeIntegrationInSubFrames` (attribute) | DOM attribute | forced `false`, attribute removed | done in this PR |
| `allowpopups` | on (#281) | on | kept on purpose. `setWindowOpenHandler` lets only sized popups open as sandboxed child windows with no preload. Everything else that is http(s) loads in the panel, and other schemes are dropped. |

## Navigation, new windows and `openExternal`

| Surface | Now | Status |
|---|---|---|
| `setWindowOpenHandler` (app window) | Always denied. An http(s) target opens in the OS browser, and anything else is dropped (`windowOpenPolicy`). | already in place (#9) |
| `setWindowOpenHandler` (webview) | `webviewWindowOpenPolicy`: a sized popup opens as a sandboxed child window, other http(s) URLs load in the panel, and every other scheme is dropped. | already in place (#281) |
| `will-navigate` (app window) | Allowed only for the app's own origin: `file:`, or `http://localhost:<port>` / `127.0.0.1:<port>` with no userinfo, parsed rather than prefix-matched. Anything else is prevented, and an http(s) target opens in the OS browser. | already in place |
| `system:openExternal` (renderer IPC) | Was `startsWith('http://' or 'https://')`. Now `isSafeExternalUrl` parses the URL, allows http(s) with a host or `mailto:`, and refuses whitespace and control characters. | done in this PR |
| `update:open-release` | `https://github.com/` URLs only | unchanged |
| Permission `openExternal` (a page following a link to a non-web scheme) | Was granted for any scheme, because Electron allows everything when no handler is set. That included `ms-msdt:`, `search-ms:` and custom protocol handlers. Now only `mailto:` is allowed. | done in this PR |

## Permissions (`session.defaultSession`)

The panel's webviews share the default session with the app. With no handler, Electron grants every request, so any page loaded in the panel got the camera, microphone, geolocation, notifications under remotea's name, MIDI and protocol launches without asking.

| Who | Granted | Everything else |
|---|---|---|
| App window showing the app's own origin | `clipboard-sanitized-write` (copy-on-select and Ctrl+C use `navigator.clipboard.writeText`), `fullscreen` | denied |
| Web content (panel, popups, an app window that somehow shows a remote page) | `clipboard-sanitized-write`, `fullscreen`, `pointerLock`. Chrome grants these without a prompt. | denied |
| Devices (WebHID, WebUSB, Web Serial) | none (`setDevicePermissionHandler(() => false)`) | |

`setPermissionRequestHandler` and `setPermissionCheckHandler` both use `decidePermission`. A denied request is logged to the diagnostics log as `permission-denied`, with the permission name and contents type only.

A web app that needs the camera or the microphone, such as a video call, won't work in the panel any more. Open it in the OS browser instead. Ctrl+click on a link does that, depending on `openLinksExternally`.

## Content-Security-Policy (app window)

Before this change there was none. The production `index.html` now carries this `<meta>`, which Vite injects at build time only, because the dev server's inline React-refresh preamble would be blocked:

```
script-src 'self' 'wasm-unsafe-eval'; object-src 'none'; base-uri 'none'; form-action 'none'; worker-src 'self' blob:
```

It backs up DOMPurify. Markup that gets past the sanitizer still cannot run inline script, event-handler attributes, `eval`, plugins or a `<base>` hijack. `'wasm-unsafe-eval'` is there for `@xterm/addon-image`'s WASM sixel decoder. It allows compiling WebAssembly, not JavaScript `eval`. The built bundles contain no `eval(` or `new Function(`, which was checked on the build.

The policy leaves these alone on purpose:
- `img-src`: markdown and release notes show remote images, such as README badges.
- `default-src`, `frame-src` and `child-src`: the `<webview>` uses an internal frame, and a default would apply this policy to whatever site the user opens.
- `style-src`: xterm and React set inline styles.

The phone Remote Console page (`src/renderer/remote/index.html`) is served by main over HTTP and is out of scope here.

## Preload surface

`window.wmux` is a fixed set of named functions. None of them takes a channel name from the renderer, and none exposes `ipcRenderer` itself. Every `ipcRenderer.*` call names its channel statically, either from `IPC_CHANNELS` or from 16 string literals listed in `tests/unit/desktop-security.test.ts`. The test fails on a channel chosen at run time, an unlisted literal, a stale list entry, or a Node import in the preload. Clipboard reads go through main (`clipboard:read-text`), so the renderer never needs `clipboard-read`.

`window.wmux.system.sandboxed` is new in this PR. It reports `process.sandboxed`, and the `--smoke` self-test fails if it is false.

## CDP proxy token (design note)

Requiring a per-launch secret on the CDP proxy was looked at (2026-10-30) and not done, because its main client can't get a token that changes on every launch through any channel it has today:

- **chrome-devtools-mcp**, the panel's main consumer, is started by the agent harness, not by remotea. `agent-integration.ts` writes it once into `~/.claude.json` (`claude-context.ts`, `--browserUrl=http://127.0.0.1:9222`) and into Qwen's settings (`qwen-context.ts`). Every running Claude/Qwen session reads that file when it starts and keeps the URL. A token that changed on every launch would have to be rewritten into the user's harness config on every start, and each app restart would break the browser tool for every agent session that was already open.
- **The user's own tools** (Playwright `connectOverCDP`, puppeteer `browserURL`, issue #233) are pointed at the port by hand, and their config has nothing remotea can update.
- The proxy does not always get 9222 (it walks 9222–9230 when busy), and the stored URL already fixes 9222. So the stored config is already a best-effort pointer, not a channel remotea controls.

What would work, if this becomes worth doing:

1. **A stable secret on the WebSocket, not a per-launch one.** The secret would be generated once, kept in the app's data folder (`0600`), and rotated only when the user asks. The existing `ensureChromeDevtoolsConfig` / `ensureQwenMcp` would write it into the harness configs. The proxy would accept the WebSocket upgrade only on a path that carries the secret, and `/json/version` / `/json/list` would stop advertising a usable `webSocketDebuggerUrl`, or they'd hand it to anyone. chrome-devtools-mcp can connect to a WebSocket directly (`--wsEndpoint`, and `--wsHeaders` for a header) instead of going through `--browserUrl` discovery. A secret in the `--browserUrl` path is probably not enough: puppeteer appears to build the discovery URL as `new URL("/json/version", browserURL)`, which drops the path. Check this and the flags against the pinned `CHROME_DEVTOOLS_MCP_PACKAGE` version before building it. The "any local process" exposure then shrinks to processes that can read `~/.claude.json`, and those can already drive the agent.
2. **A grace period:** accept tokenless clients for one release with a deprecation log line, so hand-configured Playwright setups get a warning before they stop working, and document the new URL in the browser panel's settings.
3. **Tests:** a WebSocket upgrade without the secret is refused the way a bad Origin is today (`isAllowedCdpOrigin`), and `/json/*` never contains the secret.

## Follow-ups (not in this PR)

| Item | Why not now |
|---|---|
| Validate `event.senderFrame` (main frame, app origin) in `ipcMain` handlers | Today only app windows have the preload, since webviews and popups have none, and the app has no iframes. Validating the sender is defence in depth across about 170 handlers, which needs its own change. |
| Electron fuses (`EnableNodeOptionsEnvironmentVariable`, `EnableNodeCliInspectArguments`, `EnableEmbeddedAsarIntegrityValidation`, `OnlyLoadAppFromAsar`) | The `RunAsNode` fuse must stay on, because the CLI shims (`src/cli-bin/remotea*`, `node-runtime.ts`) run `remotea.exe` with `ELECTRON_RUN_AS_NODE=1`. The others change packaging and need a Windows install test. The smoke workflow is now the place to try them. |
| CDP proxy on `127.0.0.1:9222`–`9230` | It is always on and drives the browser panel. It checks Host and Origin against DNS rebinding and web origins (`cdp-proxy.ts`), but there is no token, so any local process can drive the panel's page. A per-launch token would break its legitimate clients; see [CDP proxy token (design note)](#cdp-proxy-token-design-note). |
| Replace `<webview>` with `WebContentsView` | That would let `webviewTag` go off. It is a rewrite of the browser panel. |
| Per-site permission prompts in the panel | Today it's deny-by-default. A prompt UI would bring video calls back. |

## Verifying

- Unit tests: `npx vitest run tests/unit/desktop-security.test.ts tests/unit/renderer-csp.test.ts tests/unit/smoke.test.ts`.
- On the shipped binary: `.github/workflows/smoke.yml` runs `remotea.exe --smoke` on Windows. Its `renderer-bridge` step fails if the preload did not load or is not sandboxed.
- On Linux without a display (the app is Windows-first, so two environment variables stand in for Windows):
  ```bash
  npm run build:main && npx vite build
  S=$(mktemp -d); mkdir -p $S/home
  HOME=$S/home USERPROFILE=$S/home SHELL=/bin/bash APPDATA=$S/appdata LOCALAPPDATA=$S/local \
    npx electron . --ozone-platform=headless --smoke --smoke-out=$S/result.json; echo exit=$?
  ```
  `USERPROFILE` is the fallback working directory for a new terminal (`resolveSpawnCwd`). Without it, the shell's `chdir` fails on Linux.
