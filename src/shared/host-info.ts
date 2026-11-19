/**
 * The two host facts the renderer needs synchronously at preload time
 * (`window.remotea.system.homeDir` / `.osRelease`), handed to a SANDBOXED preload.
 *
 * A sandboxed preload cannot `require('os')` (only `electron`, `events`,
 * `timers` and `url` are available there), so main reads them and passes them
 * in as one `webPreferences.additionalArguments` entry, which Electron appends
 * to the renderer's `process.argv` — still readable from a sandboxed preload,
 * with no IPC round-trip and no ordering dependency on a handler being
 * registered. URI-encoded JSON keeps a home directory with spaces or non-ASCII
 * characters intact through the Windows command line.
 *
 * See docs/remotea/desktop-security.md.
 */

export const HOST_INFO_ARG_PREFIX = '--remotea-host-info=';

export interface HostInfo {
  homeDir: string;
  osRelease: string;
}

export function encodeHostInfoArg(info: HostInfo): string {
  return HOST_INFO_ARG_PREFIX + encodeURIComponent(JSON.stringify({ homeDir: info.homeDir, osRelease: info.osRelease }));
}

/** The host info in an argv, or empty strings when absent or malformed (never throws). */
export function decodeHostInfoArg(argv: readonly string[] | undefined): HostInfo {
  const empty: HostInfo = { homeDir: '', osRelease: '' };
  const arg = argv?.find((a) => typeof a === 'string' && a.startsWith(HOST_INFO_ARG_PREFIX));
  if (!arg) return empty;
  try {
    const parsed = JSON.parse(decodeURIComponent(arg.slice(HOST_INFO_ARG_PREFIX.length))) as Partial<HostInfo>;
    return {
      homeDir: typeof parsed?.homeDir === 'string' ? parsed.homeDir : '',
      osRelease: typeof parsed?.osRelease === 'string' ? parsed.osRelease : '',
    };
  } catch {
    return empty;
  }
}
