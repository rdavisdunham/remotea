// The desktop privilege policy (docs/remotea/desktop-security.md): window
// webPreferences, the openExternal allowlist, the permission decision, webview
// hardening, the host-info hand-off to the sandboxed preload, and the preload's
// IPC surface. Pure — no Electron.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  APP_PERMISSIONS,
  WEB_CONTENT_PERMISSIONS,
  decidePermission,
  isSafeExternalUrl,
  mainWindowWebPreferences,
} from '../../src/main/security-policy';
import { hardenWebviewPreferences } from '../../src/main/webview-prefs';
import { HOST_INFO_ARG_PREFIX, decodeHostInfoArg, encodeHostInfoArg } from '../../src/shared/host-info';
import { IPC_CHANNELS } from '../../src/shared/types';

const repo = path.resolve(__dirname, '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(repo, rel), 'utf8');

describe('main window webPreferences', () => {
  const prefs = mainWindowWebPreferences('/app/dist/preload/index.js', { homeDir: 'C:\\Users\\me', osRelease: '10.0.26200' });

  it('matches the table in docs/remotea/desktop-security.md', () => {
    expect(prefs).toEqual({
      preload: '/app/dist/preload/index.js',
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: true,
      additionalArguments: [encodeHostInfoArg({ homeDir: 'C:\\Users\\me', osRelease: '10.0.26200' })],
    });
  });

  it('is what WindowManager actually builds windows with', () => {
    const src = read('src/main/window-manager.ts');
    expect(src).toMatch(/webPreferences:\s*mainWindowWebPreferences\(/);
    // No second, hand-written webPreferences block that could drift from the policy.
    expect(src.match(/webPreferences\s*:/g)).toHaveLength(1);
    expect(src).not.toMatch(/sandbox:\s*false/);
  });

  it('is documented with the same values', () => {
    const doc = read('docs/remotea/desktop-security.md');
    for (const [key, value] of Object.entries(prefs)) {
      if (key === 'preload' || key === 'additionalArguments') continue;
      // | `setting` | before | `now` | …  — the third column is the current value.
      expect(doc, `doc row for ${key}`).toMatch(new RegExp(`\\|\\s*\`${key}\`\\s*\\|[^|\\n]*\\|\\s*\`${String(value)}\``));
    }
  });
});

describe('host info for the sandboxed preload', () => {
  it('round-trips spaces, unicode and quotes through argv', () => {
    const info = { homeDir: 'C:\\Users\\Zoë "Q" Smith', osRelease: '10.0.22631' };
    const arg = encodeHostInfoArg(info);
    expect(arg.startsWith(HOST_INFO_ARG_PREFIX)).toBe(true);
    expect(arg).not.toMatch(/[\s"]/);
    expect(decodeHostInfoArg(['electron.exe', '--type=renderer', arg])).toEqual(info);
  });

  it('degrades to empty strings, never throws', () => {
    expect(decodeHostInfoArg(undefined)).toEqual({ homeDir: '', osRelease: '' });
    expect(decodeHostInfoArg(['x'])).toEqual({ homeDir: '', osRelease: '' });
    expect(decodeHostInfoArg([`${HOST_INFO_ARG_PREFIX}%E0%A4%A`])).toEqual({ homeDir: '', osRelease: '' });
    expect(decodeHostInfoArg([`${HOST_INFO_ARG_PREFIX}${encodeURIComponent('{"homeDir":5}')}`])).toEqual({ homeDir: '', osRelease: '' });
  });
});

describe('isSafeExternalUrl (system:openExternal)', () => {
  it.each([
    'https://github.com/rdavisdunham/remotea',
    'http://localhost:3000/',
    'HTTPS://EXAMPLE.COM/a?b=c#d',
    'mailto:someone@example.com',
  ])('allows %s', (url) => {
    expect(isSafeExternalUrl(url)).toBe(true);
  });

  it.each([
    'file:///C:/Windows/System32/calc.exe',
    'javascript:alert(1)',
    'data:text/html,<script>1</script>',
    'ms-msdt:/id PCWDiagnostic',
    'search-ms:query=x&crumb=location:\\\\evil\\share',
    'vscode://file/C:/x',
    'smb://evil/share',
    '\\\\evil\\share\\x.exe',
    'C:\\Windows\\notepad.exe',
    'https://example.com/a b',
    'https://example.com/\n',
    ' https://example.com',
    'https://',
    'not a url',
    '',
  ])('refuses %s', (url) => {
    expect(isSafeExternalUrl(url)).toBe(false);
  });

  it('refuses non-strings', () => {
    expect(isSafeExternalUrl(undefined)).toBe(false);
    expect(isSafeExternalUrl({ toString: () => 'https://x' })).toBe(false);
  });

  it('is what the system:openExternal handler checks', () => {
    const src = read('src/main/ipc-handlers.ts');
    const at = src.indexOf('IPC_CHANNELS.SYSTEM_OPEN_EXTERNAL');
    expect(at).toBeGreaterThan(-1);
    expect(src.slice(at, at + 200)).toMatch(/isSafeExternalUrl\(url\)/);
  });
});

describe('decidePermission', () => {
  const app = { isAppContents: true, requestingUrl: 'file:///C:/app/resources/app.asar/dist/renderer/index.html' };
  const dev = { isAppContents: true, requestingUrl: 'http://localhost:5199/' };
  const site = { isAppContents: false, requestingUrl: 'https://example.com/' };

  it('gives the app UI only what it uses', () => {
    expect(decidePermission({ ...app, permission: 'clipboard-sanitized-write' })).toBe(true);
    expect(decidePermission({ ...dev, permission: 'clipboard-sanitized-write' })).toBe(true);
    expect(decidePermission({ ...app, permission: 'fullscreen' })).toBe(true);
    for (const p of ['media', 'geolocation', 'notifications', 'clipboard-read', 'midi', 'hid', 'usb', 'serial', 'display-capture', 'unknown']) {
      expect(decidePermission({ ...app, permission: p }), p).toBe(false);
    }
  });

  it('gives a browser-panel page only what Chrome grants without a prompt', () => {
    expect(decidePermission({ ...site, permission: 'clipboard-sanitized-write' })).toBe(true);
    expect(decidePermission({ ...site, permission: 'fullscreen' })).toBe(true);
    expect(decidePermission({ ...site, permission: 'pointerLock' })).toBe(true);
    for (const p of ['media', 'geolocation', 'notifications', 'clipboard-read', 'midi', 'midiSysex', 'idle-detection',
      'storage-access', 'top-level-storage-access', 'window-management', 'keyboardLock', 'speaker-selection']) {
      expect(decidePermission({ ...site, permission: p }), p).toBe(false);
    }
  });

  it('does not give app privileges to an app window that is showing remote content', () => {
    expect(decidePermission({ isAppContents: true, requestingUrl: 'https://evil.example/', permission: 'clipboard-sanitized-write' }))
      .toBe(WEB_CONTENT_PERMISSIONS.has('clipboard-sanitized-write'));
    expect(decidePermission({ isAppContents: true, requestingUrl: 'http://localhost:5199@evil.com/', permission: 'media' })).toBe(false);
  });

  it('opens external protocols for mailto only', () => {
    expect(decidePermission({ ...site, permission: 'openExternal', externalUrl: 'mailto:a@b.c' })).toBe(true);
    for (const u of ['ms-msdt:/id x', 'search-ms:query=x', 'file:///C:/x.exe', 'vscode://x', 'zoommtg://x', undefined]) {
      expect(decidePermission({ ...site, permission: 'openExternal', externalUrl: u }), String(u)).toBe(false);
      expect(decidePermission({ ...app, permission: 'openExternal', externalUrl: u }), String(u)).toBe(false);
    }
  });

  it('keeps the allowlists small', () => {
    expect([...APP_PERMISSIONS].sort()).toEqual(['clipboard-sanitized-write', 'fullscreen']);
    expect([...WEB_CONTENT_PERMISSIONS].sort()).toEqual(['clipboard-sanitized-write', 'fullscreen', 'pointerLock']);
  });

  it('is installed for requests, checks and devices on the default session', () => {
    const src = read('src/main/index.ts');
    expect(src).toMatch(/setPermissionRequestHandler\(/);
    expect(src).toMatch(/setPermissionCheckHandler\(/);
    expect(src).toMatch(/setDevicePermissionHandler\(\(\) => false\)/);
    expect(src).toMatch(/restrictPermissions\(\);/);
  });
});

describe('webview hardening', () => {
  it('forces a sandboxed, isolated, same-origin guest whatever the DOM asked for', () => {
    const prefs: Record<string, unknown> = {
      preload: 'C:\\evil.js', preloadURL: 'file:///evil.js', nodeIntegration: true, nodeIntegrationInSubFrames: true,
      contextIsolation: false, sandbox: false, webSecurity: false, allowRunningInsecureContent: true,
    };
    const params: Record<string, unknown> = { nodeintegration: 'true', nodeintegrationinsubframes: 'true', disablewebsecurity: 'true', allowpopups: 'true' };
    hardenWebviewPreferences(prefs, params);
    expect(prefs).toMatchObject({
      nodeIntegration: false, nodeIntegrationInSubFrames: false, contextIsolation: true,
      sandbox: true, webSecurity: true, allowRunningInsecureContent: false,
    });
    expect(prefs).not.toHaveProperty('preload');
    expect(prefs).not.toHaveProperty('preloadURL');
    expect(params).toEqual({ nodeintegration: 'false', allowpopups: 'true' });
  });
});

// ─── The preload's IPC surface ───────────────────────────────────────────────
// The bridge is a fixed set of named functions; none takes a channel from the
// renderer. These keep it that way: every ipcRenderer call names its channel
// statically, from IPC_CHANNELS or the short list of literals below, and the
// preload imports nothing from Node.

/** Channels the preload names as string literals rather than via IPC_CHANNELS. */
const LITERAL_CHANNELS = new Set([
  'toggle-devtools',
  'config:getProjectProfiles',
  'config:importWindowsTerminalProfiles',
  'config:getUserConfigPath',
  'notification:focus-surface',
  'notification:play-sound',
  'clipboard:write-text',
  'clipboard:read-text',
  'integration:get',
  'integration:set',
  'settings:get-all-sync',
  'settings:set',
  'system:get-preferred-languages-sync',
  'locales:get-all-sync',
  'session:request',
  'session:save',
]);

/** The first argument of every ipcRenderer.<method>( call in a source file. */
function preloadChannelRefs(src: string): string[] {
  const refs: string[] = [];
  const re = /ipcRenderer\.(?:invoke|send|sendSync|on|once|off|removeListener|removeAllListeners|postMessage)\(\s*([^,)\s]+)/g;
  for (const m of src.matchAll(re)) refs.push(m[1]);
  return refs;
}

describe('preload IPC surface', () => {
  const src = read('src/preload/index.ts');
  const knownIpc = new Set(Object.keys(IPC_CHANNELS));

  it('names every channel statically, from the allowlist', () => {
    const refs = preloadChannelRefs(src);
    expect(refs.length).toBeGreaterThan(100);
    const bad = refs.filter((r) => {
      const named = /^IPC_CHANNELS\.([A-Z0-9_]+)$/.exec(r);
      if (named) return !knownIpc.has(named[1]);
      const literal = /^'([^']+)'$/.exec(r);
      if (literal) return !LITERAL_CHANNELS.has(literal[1]);
      return true; // a variable: a channel chosen at run time
    });
    expect(bad).toEqual([]);
  });

  it('every literal in the allowlist is still used (the list cannot rot)', () => {
    const used = new Set(preloadChannelRefs(src).map((r) => /^'([^']+)'$/.exec(r)?.[1]).filter(Boolean));
    expect([...LITERAL_CHANNELS].filter((c) => !used.has(c))).toEqual([]);
  });

  it('never exposes ipcRenderer itself or a generic invoke', () => {
    expect(src).not.toMatch(/exposeInMainWorld\([^)]*ipcRenderer/);
    expect(src).not.toMatch(/:\s*ipcRenderer\s*[,}]/);
    expect(src).not.toMatch(/\(\s*channel\b/);
    expect(src).not.toMatch(/ipcRenderer\.\w+\.bind\(/);
  });

  it('imports nothing from Node (it runs sandboxed and bundled)', () => {
    const imports = [...src.matchAll(/^import\s+(?:type\s+)?[^'"]*from\s+'([^']+)'/gm)].map((m) => m[1]);
    expect(imports.filter((m) => m !== 'electron' && !m.startsWith('../shared/'))).toEqual([]);
    expect(src).not.toMatch(/\brequire\(/);
  });

  it('is bundled by build:main', () => {
    const pkg = JSON.parse(read('package.json'));
    expect(pkg.scripts['build:main']).toMatch(/node scripts\/bundle-preload\.mjs/);
    expect(pkg.scripts.build).toMatch(/npm run build:main/);
  });
});
