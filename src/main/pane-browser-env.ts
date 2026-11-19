/**
 * The `$BROWSER` wiring a pane gets, split out of pty-manager so it is testable
 * without loading node-pty's native module.
 */

/**
 * The `$BROWSER` target remotea installs into WSL panes.
 *
 * Deliberately the bare name, not a path: BROWSER parsers split the value on
 * whitespace, and an install path can contain spaces ("OneDrive - Pulsa"). The
 * shim lives in cli-bin, which is already prepended to PATH.
 */
export const BROWSER_SHIM_NAME = 'remotea-open-url';

/** Only WSL panes get the shim: native Windows tools cannot execute it. */
export function browserEnvFor(shellType: string): { BROWSER?: string } {
  return shellType === 'wsl' ? { BROWSER: BROWSER_SHIM_NAME } : {};
}

/**
 * Windows env vars WSL keeps. With no flag a variable crosses interop BOTH
 * ways; /u only from Windows into WSL; /p translates a Windows path to a WSL
 * mount (/mnt/c/...) on the way in and back on the way out.
 *
 * What a Windows helper started INSIDE the pane needs has no /u (#428): the
 * Claude Code hook and the bash integration's reports run Windows node.exe
 * from WSL, and with /u it never saw the surface, the pipe or the token, so
 * nothing it sent was heard. REMOTEA_CLI goes back out as its Windows path.
 *
 * The rest stays one-way on purpose. BROWSER is a POSIX shim Windows tools
 * cannot run. REMOTEA_REMOTE would send a Windows helper over the TCP bridge
 * instead of the local pipe. REMOTEA_WSL_NODE is the Windows runtime as a /mnt
 * path for the bash integration only: it is not REMOTEA_NODE, because the cli-bin
 * shim would then run node.exe on a /mnt script path it cannot open.
 */
export const WSL_ENV_PASSTHROUGH =
  'REMOTEA:REMOTEA_SURFACE_ID:REMOTEA_CLI/p:REMOTEA_PIPE:REMOTEA_PIPE_TOKEN:REMOTEA_INTEGRATION/u'
  + ':REMOTEA_WSL_NODE/up:REMOTEA_NODE_ELECTRON/u:REMOTEA_BASH_SCRIPT/up'
  + ':REMOTEA_REMOTE/u:REMOTEA_REMOTE_TOKEN/u:BROWSER/u';
