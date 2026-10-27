#!/usr/bin/env node
/**
 * Desktop test harness: a TEST copy of the remotea app on this PC's Windows
 * side, against a TEST server in WSL, driven from WSL over the Chrome DevTools
 * Protocol. For reproducing UI bugs and checking fixes without touching real
 * sessions. Run it from WSL on the machine that hosts the real server.
 *
 * Isolation:
 *   - app:    %USERPROFILE%\remotea-dev\app, portable Node in ...\remotea-dev\node,
 *             WMUX_INSTANCE=test (own pipe, %APPDATA%\remotea-test, own Electron
 *             profile), agent integration skipped (never touches ~\.claude),
 *             DevTools protocol on 127.0.0.1:9333 only while it runs.
 *   - server: transient systemd unit `remotea-test`, ports 7719 (+7720 hooks) on
 *             127.0.0.1 only, config ~/.config/remotea-test, logs
 *             ~/.local/state/remotea-test. Its sessions are real shells in WSL;
 *             agent hooks it installs go to ~/.local/state/remotea-test/hooks-home.
 *
 *   node scripts/desktop-test/harness.mjs <command>
 *     setup | sync          portable Node, copy the working tree, npm ci when the lockfile changed, build
 *     server start|stop     the test server (built from this checkout)
 *     app start|stop        launch / kill the test app (window appears on the desktop)
 *     up | down             sync + server + app / app + server off
 *     eval '<js>'           evaluate in the app window (awaits promises; prints JSON)
 *     shot <file.png>       screenshot of the app window
 *     type '<text>'         insert text into the focused element (a terminal, if one is focused)
 *     key <Enter|Escape|Tab|Backspace|ArrowUp|ArrowDown|ArrowLeft|ArrowRight> [n]
 *     drop <surfaceId> <C:\\path\\file>...   a real OS-style file drop onto that terminal
 *     screen [surfaceId]    what a terminal in the app shows (default: the active one)
 *     applog                tail of the app's main-process log
 *     diag [args...]        `remotea logs` against the test server
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const require = createRequire(path.join(repo, 'remote-server', 'package.json'));
const WebSocket = require('ws');

const NODE_VERSION = process.versions.node; // same Node as the WSL side
const CDP_PORT = 9333;
const VITE_PORT = 5299;
const SERVER = { port: 7719, hookPort: 7720 };
const HOST_NAME = 'test';
const cfgDir = path.join(os.homedir(), '.config', 'remotea-test');
const stateDir = path.join(os.homedir(), '.local', 'state', 'remotea-test');
const hooksHome = path.join(stateDir, 'hooks-home');

const say = (m) => console.error(`\x1b[1m${m}\x1b[0m`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Windows side ─────────────────────────────────────────────────────────

function winOut(file, args, opts = {}) {
  return execFileSync(file, args, { cwd: '/mnt/c', encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).replace(/\r/g, '').trim();
}

const winRoot = (() => {
  const profile = winOut('cmd.exe', ['/d', '/c', 'echo %USERPROFILE%']);
  return { win: `${profile}\\remotea-dev`, wsl: execFileSync('wslpath', ['-u', `${profile}\\remotea-dev`], { encoding: 'utf8' }).trim() };
})();
const W = {
  node: `${winRoot.win}\\node`,
  app: `${winRoot.win}\\app`,
  appWsl: path.join(winRoot.wsl, 'app'),
  nodeWsl: path.join(winRoot.wsl, 'node'),
};

/**
 * Run a command line in cmd.exe inside the Windows app dir, with the portable
 * Node first on PATH. No double quotes anywhere: WSL interop escapes them on
 * the way into cmd.exe, which then reads them literally (the paths involved
 * have no spaces, so nothing needs quoting).
 */
function winRun(cmdline, { env = {}, inherit = true } = {}) {
  if (cmdline.includes('"')) throw new Error(`no double quotes in Windows command lines: ${cmdline}`);
  const names = Object.keys(env);
  const res = spawnSync('cmd.exe', ['/d', '/c', `set PATH=${W.node};%PATH%&& cd /d ${W.app}&& ${cmdline}`], {
    cwd: '/mnt/c',
    stdio: inherit ? 'inherit' : 'pipe',
    env: { ...process.env, ...env, WSLENV: [process.env.WSLENV, ...names].filter(Boolean).join(':') },
    encoding: 'utf8',
  });
  if (res.status !== 0) throw new Error(`windows command failed (${res.status}): ${cmdline}\n${res.stderr ?? ''}`);
  return (res.stdout ?? '').replace(/\r/g, '');
}

/**
 * Start a .cmd in its own minimized window and return at once. Not `cmd /c
 * start`: under WSL interop that call waits for the started process to exit.
 * The environment (via WSLENV) is inherited by what Start-Process launches.
 */
function winStart(cmdFile, env) {
  const names = Object.keys(env);
  const res = spawnSync('powershell.exe', ['-NoProfile', '-Command', `Start-Process -WindowStyle Minimized -FilePath ${cmdFile}`], {
    cwd: '/mnt/c',
    stdio: 'ignore',
    env: { ...process.env, ...env, WSLENV: [process.env.WSLENV, ...names].filter(Boolean).join(':') },
  });
  if (res.status !== 0) throw new Error(`could not start ${cmdFile}`);
}

async function ensureNode() {
  if (fs.existsSync(path.join(W.nodeWsl, 'node.exe'))) return;
  const name = `node-v${NODE_VERSION}-win-x64`;
  const base = `https://nodejs.org/dist/v${NODE_VERSION}`;
  say(`downloading portable Node ${NODE_VERSION} for Windows`);
  const [zip, sums] = await Promise.all([
    fetch(`${base}/${name}.zip`).then((r) => { if (!r.ok) throw new Error(`${r.status} for ${name}.zip`); return r.arrayBuffer(); }),
    fetch(`${base}/SHASUMS256.txt`).then((r) => r.text()),
  ]);
  const want = sums.split('\n').find((l) => l.endsWith(`  ${name}.zip`))?.split(/\s+/)[0];
  const got = createHash('sha256').update(Buffer.from(zip)).digest('hex');
  if (!want || want !== got) throw new Error(`checksum mismatch for ${name}.zip`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'remotea-node-'));
  fs.writeFileSync(path.join(tmp, 'node.zip'), Buffer.from(zip));
  execFileSync('unzip', ['-q', path.join(tmp, 'node.zip'), '-d', tmp]);
  fs.mkdirSync(winRoot.wsl, { recursive: true });
  execFileSync('cp', ['-r', path.join(tmp, name), W.nodeWsl]);
  fs.rmSync(tmp, { recursive: true, force: true });
}

function sync() {
  say('building main (WSL) and copying the working tree to the Windows side');
  execFileSync('npm', ['run', 'build:main'], { cwd: repo, stdio: ['ignore', 'ignore', 'inherit'] });
  fs.mkdirSync(W.appWsl, { recursive: true });
  execFileSync('rsync', ['-a', '--delete',
    '--exclude=/node_modules', '--exclude=/.git', '--exclude=/release', '--exclude=/remote-server', '--exclude=/dist-renderer',
    `${repo}/`, `${W.appWsl}/`], { stdio: 'inherit' });
  const lock = createHash('sha256').update(fs.readFileSync(path.join(repo, 'package-lock.json'))).digest('hex');
  const stamp = path.join(winRoot.wsl, 'lock.sha256');
  const haveModules = fs.existsSync(path.join(W.appWsl, 'node_modules', 'electron'));
  if (!haveModules || (fs.existsSync(stamp) ? fs.readFileSync(stamp, 'utf8') : '') !== lock) {
    say('npm ci on Windows (dependencies changed)');
    winRun('npm ci --no-audit --no-fund');
    fs.writeFileSync(stamp, lock);
  }
  // Electron downloads its binary on first use; do it now rather than inside `app start`.
  winRun('node node_modules\\electron\\cli.js --version', { inherit: false });
}

// ── Test server (WSL) ────────────────────────────────────────────────────

function serverActive() {
  return spawnSync('systemctl', ['--user', 'is-active', '--quiet', 'remotea-test']).status === 0;
}

function serverStart() {
  if (serverActive()) return;
  fs.mkdirSync(cfgDir, { recursive: true, mode: 0o700 });
  const cfg = path.join(cfgDir, 'config.json');
  if (!fs.existsSync(cfg)) fs.writeFileSync(cfg, JSON.stringify({ port: SERVER.port, hookPort: SERVER.hookPort, bind: ['127.0.0.1'] }, null, 2) + '\n', { mode: 0o600 });
  execFileSync('npm', ['run', 'build'], { cwd: path.join(repo, 'remote-server'), stdio: ['ignore', 'ignore', 'inherit'] });
  // Agent hook installs from the test app land in a scratch home with empty
  // Claude Code and Codex settings, never in the real ~/.claude or ~/.codex.
  for (const [dir, file] of [['.claude', 'settings.json'], ['.codex', 'hooks.json']]) {
    fs.mkdirSync(path.join(hooksHome, dir), { recursive: true });
    if (!fs.existsSync(path.join(hooksHome, dir, file))) fs.writeFileSync(path.join(hooksHome, dir, file), '{}\n');
  }
  execFileSync('systemd-run', ['--user', '--unit=remotea-test', '--collect', '--quiet',
    `--setenv=REMOTEA_CONFIG_DIR=${cfgDir}`, `--setenv=REMOTEA_STATE_DIR=${stateDir}`, `--setenv=PATH=${process.env.PATH}`,
    `--setenv=REMOTEA_HOOKS_HOME=${hooksHome}`,
    `--working-directory=${path.join(repo, 'remote-server')}`,
    process.execPath, path.join(repo, 'remote-server', 'dist', 'remote-server', 'src', 'main.js')], { stdio: 'inherit' });
  for (let i = 0; i < 50 && !fs.existsSync(path.join(cfgDir, 'token')); i++) execFileSync('sleep', ['0.1']);
  say(`test server on ws://127.0.0.1:${SERVER.port} (journalctl --user -u remotea-test)`);
}

function serverStop() {
  spawnSync('systemctl', ['--user', 'stop', 'remotea-test'], { stdio: 'inherit' });
}

// ── App ──────────────────────────────────────────────────────────────────

function writeLaunchers() {
  // No secrets in these: the seed token reaches the app through the environment only.
  fs.writeFileSync(path.join(winRoot.wsl, 'vite.cmd'), [
    '@echo off', `set "PATH=${W.node};%PATH%"`, `cd /d ${W.app}`,
    `node node_modules\\vite\\bin\\vite.js --host 127.0.0.1 --port ${VITE_PORT} --strictPort > ${winRoot.win}\\vite.log 2>&1`, '',
  ].join('\r\n'));
  fs.writeFileSync(path.join(winRoot.wsl, 'app.cmd'), [
    '@echo off', `set "PATH=${W.node};%PATH%"`, `cd /d ${W.app}`,
    `node_modules\\electron\\dist\\electron.exe . --remote-debugging-port=${CDP_PORT} > ${winRoot.win}\\app.log 2>&1`, '',
  ].join('\r\n'));
}

async function cdpTargets() {
  try {
    const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(1500) });
    return r.ok ? await r.json() : [];
  } catch {
    return [];
  }
}

async function appStart() {
  serverStart();
  if ((await cdpTargets()).length) return say('test app already running');
  writeLaunchers();
  const token = fs.readFileSync(path.join(cfgDir, 'token'), 'utf8').trim();
  const env = {
    WMUX_INSTANCE: 'test',
    VITE_DEV_PORT: String(VITE_PORT),
    REMOTEA_NO_DEVTOOLS: '1',
    REMOTEA_SKIP_AGENT_INTEGRATION: '1',
    REMOTEA_SEED_HOST: JSON.stringify({ name: HOST_NAME, url: `ws://127.0.0.1:${SERVER.port}`, token }),
  };
  winStart(`${winRoot.win}\\vite.cmd`, env);
  for (let i = 0; i < 100; i++) {
    // Vite binds 127.0.0.1 on purpose: `localhost` is ::1 on Windows, which WSL's mirrored loopback does not reach.
    if (await fetch(`http://127.0.0.1:${VITE_PORT}/`, { signal: AbortSignal.timeout(1500) }).then((r) => r.ok, () => false)) break;
    await sleep(200);
  }
  winStart(`${winRoot.win}\\app.cmd`, env);
  // The first load can reload itself (Vite optimizing dependencies): retry until the app's hooks answer.
  const deadline = Date.now() + 90_000;
  for (;;) {
    try {
      if (await evaluate(await waitForPage(60_000), 'typeof window.__wmux_listWorkspaces === "function"')) break;
    } catch (err) {
      if (Date.now() > deadline) throw err;
    }
    if (Date.now() > deadline) throw new Error('the test app never became ready');
    await sleep(500);
  }
  say(`test app up (CDP 127.0.0.1:${CDP_PORT}); new terminals there: shell "remote:${HOST_NAME}"`);
}

function appStop() {
  const ps = `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like '${winRoot.win}\\*' -or $_.CommandLine -like '*${winRoot.win}\\*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
  spawnSync('powershell.exe', ['-NoProfile', '-Command', ps], { cwd: '/mnt/c', stdio: 'inherit' });
}

// ── CDP ──────────────────────────────────────────────────────────────────

async function waitForPage(ms = 10_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const page = (await cdpTargets()).find((t) => t.type === 'page' && t.url.startsWith(`http://localhost:${VITE_PORT}`));
    if (page) return page;
    if (Date.now() > deadline) throw new Error('the test app window is not up (harness app start)');
    await sleep(250);
  }
}

async function cdp(page, calls) {
  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  let id = 0;
  const pending = new Map();
  ws.on('message', (d) => {
    const m = JSON.parse(String(d));
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const n = ++id;
    pending.set(n, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  try {
    return await calls(send);
  } finally {
    ws.close();
  }
}

async function evaluate(page, expression) {
  return cdp(page, async (send) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  });
}

const KEYS = {
  Enter: [13, '\r'], Escape: [27, ''], Tab: [9, '\t'], Backspace: [8, ''],
  ArrowUp: [38, ''], ArrowDown: [40, ''], ArrowLeft: [37, ''], ArrowRight: [39, ''],
};

// ── CLI ──────────────────────────────────────────────────────────────────

const [cmd, ...rest] = process.argv.slice(2);
try {
  switch (cmd) {
    case 'setup':
    case 'sync':
      await ensureNode();
      sync();
      break;
    case 'server':
      if (rest[0] === 'start') serverStart();
      else if (rest[0] === 'stop') serverStop();
      else throw new Error('server start|stop');
      break;
    case 'app':
      if (rest[0] === 'start') await appStart();
      else if (rest[0] === 'stop') appStop();
      else throw new Error('app start|stop');
      break;
    case 'up':
      await ensureNode();
      sync();
      await appStart();
      break;
    case 'down':
      appStop();
      serverStop();
      break;
    case 'eval': {
      const v = await evaluate(await waitForPage(), rest.join(' '));
      console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));
      break;
    }
    case 'shot': {
      const file = path.resolve(rest[0] ?? 'remotea-test.png');
      const data = await cdp(await waitForPage(), async (send) => (await send('Page.captureScreenshot', { format: 'png' })).data);
      fs.writeFileSync(file, Buffer.from(data, 'base64'));
      console.log(file);
      break;
    }
    case 'type':
      await cdp(await waitForPage(), (send) => send('Input.insertText', { text: rest.join(' ') }));
      break;
    case 'key': {
      const [code, text] = KEYS[rest[0]] ?? (() => { throw new Error(`keys: ${Object.keys(KEYS).join(' ')}`); })();
      const n = Number(rest[1] ?? 1);
      await cdp(await waitForPage(), async (send) => {
        for (let i = 0; i < n; i++) {
          await send('Input.dispatchKeyEvent', { type: 'keyDown', key: rest[0], code: rest[0], windowsVirtualKeyCode: code, text: text || undefined });
          await send('Input.dispatchKeyEvent', { type: 'keyUp', key: rest[0], code: rest[0], windowsVirtualKeyCode: code });
        }
      });
      break;
    }
    case 'drop': {
      // A real drag-and-drop as the OS would deliver it, so the renderer gets
      // genuine File objects (webUtils.getPathForFile refuses anything else).
      const [surf, ...files] = rest;
      const page = await waitForPage();
      const at = await evaluate(page, `(async () => {
        // Terminals carry no surface id in the DOM: focus it, then use the one holding focus.
        window.__wmux_focusSurface(${JSON.stringify(surf)});
        await new Promise((r) => setTimeout(r, 300));
        const visible = [...document.querySelectorAll('.xterm-screen')]
          .map((e) => ({ e, r: e.getBoundingClientRect() }))
          .filter(({ r }) => r.width > 0 && r.height > 0)
          .sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height);
        const el = document.activeElement?.closest('.terminal-pane')?.querySelector('.xterm-screen') ?? visible[0]?.e;
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      })()`);
      if (!at) throw new Error(`no terminal on screen for ${surf}`);
      const data = { items: [], files, dragOperationsMask: 1 };
      await cdp(page, async (send) => {
        for (const type of ['dragEnter', 'dragOver', 'drop']) await send('Input.dispatchDragEvent', { type, x: at.x, y: at.y, data });
      });
      console.log(`dropped ${files.length} file(s) at ${at.x},${at.y}`);
      break;
    }
    case 'screen': {
      const id = rest[0] ? JSON.stringify(rest[0]) : 'undefined';
      const r = await evaluate(await waitForPage(), `window.__wmux_readScreen(${id}, 40)`);
      console.log(typeof r === 'string' ? r : JSON.stringify(r, null, 2));
      break;
    }
    case 'applog':
      console.log(fs.readFileSync(path.join(winRoot.wsl, 'app.log'), 'utf8').split(/\r?\n/).slice(-Number(rest[0] ?? 40)).join('\n'));
      break;
    case 'diag':
      execFileSync(process.execPath, [path.join(repo, 'remote-server', 'dist', 'remote-server', 'src', 'cli.js'), 'logs', ...rest], {
        stdio: 'inherit', env: { ...process.env, REMOTEA_CONFIG_DIR: cfgDir, REMOTEA_STATE_DIR: stateDir },
      });
      break;
    default:
      console.error(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 28).join('\n'));
      process.exit(cmd ? 2 : 0);
  }
} catch (err) {
  console.error(`harness: ${err.message}`);
  process.exit(1);
}
