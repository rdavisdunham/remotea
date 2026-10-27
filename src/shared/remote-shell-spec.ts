/**
 * The shell spec that makes a terminal remote: `remote:<hostId>[ <command>]`.
 *
 * It rides in the same `shell` field every other shell choice uses (surface,
 * workspace, Settings default, quick-launch profile), so "default every new
 * terminal to the desktop's WSL" is just the default-shell setting, and a
 * quick-launch profile can open `remote:desktop claude` like any other.
 *
 * A surface created this way keeps the spec on the surface itself, so
 * changing the default later never moves a live remote session to a local shell.
 */

export const REMOTE_SPEC_PREFIX = 'remote:';
export const HOST_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

export interface RemoteShellSpec {
  hostId: string;
  /** Command to run instead of an interactive login shell. */
  command?: string;
}

export function parseRemoteShellSpec(spec: string | undefined | null): RemoteShellSpec | null {
  if (!spec || !spec.startsWith(REMOTE_SPEC_PREFIX)) return null;
  const rest = spec.slice(REMOTE_SPEC_PREFIX.length).trim();
  const space = rest.search(/\s/);
  const hostId = (space < 0 ? rest : rest.slice(0, space)).toLowerCase();
  if (!HOST_ID_RE.test(hostId)) return null;
  const command = space < 0 ? '' : rest.slice(space).trim();
  return command ? { hostId, command } : { hostId };
}

export function isRemoteShellSpec(spec: string | undefined | null): boolean {
  return parseRemoteShellSpec(spec) !== null;
}

export function remoteShellSpec(hostId: string, command?: string): string {
  return command ? `${REMOTE_SPEC_PREFIX}${hostId} ${command}` : `${REMOTE_SPEC_PREFIX}${hostId}`;
}

/** A readable, stable host id from a display name ("Davis PC" -> "davis-pc"). */
export function hostIdFromName(name: string, taken: ReadonlySet<string> = new Set()): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'host';
  let id = /^[a-z0-9]/.test(base) ? base : `h-${base}`;
  for (let n = 2; taken.has(id); n++) id = `${base.slice(0, 28)}-${n}`;
  return id;
}
