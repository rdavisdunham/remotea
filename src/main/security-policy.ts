// Main-window privileges and the permission/openExternal decisions, as pure
// functions so the policy is pinned by unit tests rather than by reading
// index.ts. The audit these implement — setting by setting, what it was, what
// it is now and why — is docs/remotea/desktop-security.md; change both together.
//
// No runtime `electron` import here on purpose: tests load this module in plain
// Node.

import { encodeHostInfoArg, type HostInfo } from '../shared/host-info';
import { isInternalAppUrl } from './webview-navigation';

/**
 * The webPreferences every app window (WindowManager.createWindow) is built
 * with. The preload is bundled into one file and needs no Node, so the renderer
 * runs in Chromium's OS sandbox; the two host facts it used `os` for arrive
 * through `additionalArguments` (shared/host-info.ts).
 *
 * `webviewTag` stays on: the browser panel IS a <webview>. Each guest is
 * hardened again in `will-attach-webview` (webview-prefs.ts).
 */
export function mainWindowWebPreferences(preloadPath: string, hostInfo: HostInfo): Electron.WebPreferences {
  return {
    preload: preloadPath,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    nodeIntegrationInWorker: false,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: true,
    additionalArguments: [encodeHostInfoArg(hostInfo)],
  };
}

/**
 * A url the app may hand to `shell.openExternal` on the RENDERER's behalf
 * (`system:openExternal`): http(s) and mailto only, parsed rather than
 * prefix-matched, and nothing with control characters or whitespace in it
 * (a url Windows' ShellExecute would split or reinterpret). Every other
 * scheme — file:, ms-*, search-ms:, a custom protocol handler — is a way to
 * launch local programs, which a page or a compromised renderer must not get.
 */
export function isSafeExternalUrl(url: unknown): url is string {
  if (typeof url !== 'string' || url.length === 0 || url.length > 8192) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000- \u007f]/.test(url)) return false;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol === 'mailto:') return true;
  return (u.protocol === 'http:' || u.protocol === 'https:') && u.hostname !== '';
}

/**
 * Which permissions are granted, by whom. Everything not listed is DENIED —
 * Electron's default with no handler is to grant every request, which for the
 * browser panel (arbitrary web pages on the default session) meant camera,
 * microphone, geolocation, notifications under the app's name, MIDI, and
 * launching any registered protocol handler.
 *
 *  - The app's own UI uses `navigator.clipboard.writeText` (copy-on-select,
 *    Ctrl+C) and nothing else; fullscreen is harmless.
 *  - A browser-panel page keeps what Chrome grants without a prompt: writing
 *    the clipboard after a gesture, fullscreen (video), pointer lock.
 *  - `openExternal` (a link to a non-web scheme) is granted for mailto: only.
 */
export const APP_PERMISSIONS: ReadonlySet<string> = new Set(['clipboard-sanitized-write', 'fullscreen']);
export const WEB_CONTENT_PERMISSIONS: ReadonlySet<string> = new Set(['clipboard-sanitized-write', 'fullscreen', 'pointerLock']);

export interface PermissionQuery {
  permission: string;
  /** The asking webContents is an app window (type 'window', no opener). */
  isAppContents: boolean;
  /** The URL (or origin) asking. */
  requestingUrl: string;
  /** For `openExternal`: the url the page wants opened. */
  externalUrl?: string;
}

export function decidePermission(q: PermissionQuery): boolean {
  if (q.permission === 'openExternal') {
    return typeof q.externalUrl === 'string' && /^mailto:/i.test(q.externalUrl) && isSafeExternalUrl(q.externalUrl);
  }
  // App privileges need BOTH: an app window, and that window still showing the
  // app's own UI (file:// packaged, localhost in dev).
  if (q.isAppContents && isInternalAppUrl(q.requestingUrl)) return APP_PERMISSIONS.has(q.permission);
  return WEB_CONTENT_PERMISSIONS.has(q.permission);
}
