/** Explicit UI/runtime interpretation of the compatible persisted shell field.
 * Existing bare shells and remote:<hostId>[ command] forms are retained.
 * local: reserves an explicit local system-shell choice so a host workspace
 * cannot override an intentionally empty local shell via legacy || defaults.
 * The router removes it before PtyManager; AgentManager's local API is unchanged.
 */
import { parseRemoteShellSpec, remoteShellSpec } from './remote-shell-spec';

export type ExecutionLocation = { kind: 'local' } | { kind: 'remote'; hostId: string };
export type ExecutionCapability = 'terminal' | 'files' | 'diffStats' | 'gitReview' | 'worktrees' | 'osOpen' | 'agentLaunch' | 'eridani';
export interface CapabilitySupport { state: 'available' | 'unavailable' | 'unknown'; reason: string }
export function decodeLaunch(shell?: string | null): { location: ExecutionLocation; command: string } {
  const spec = parseRemoteShellSpec(shell);
  return spec ? { location: { kind: 'remote', hostId: spec.hostId }, command: spec.command ?? '' }
    : { location: { kind: 'local' }, command: shell === 'local:' ? '' : shell ?? '' };
}
export function encodeLaunch(location: ExecutionLocation, command: string): string {
  return location.kind === 'remote' ? remoteShellSpec(location.hostId, command) : command;
}
export function locationLabel(location: ExecutionLocation, hosts: Record<string, { name: string }> = {}): string {
  return location.kind === 'local' ? 'This computer' : hosts[location.hostId]?.name ?? `Remote host: ${location.hostId}`;
}
export function executionCapability(location: ExecutionLocation, capability: ExecutionCapability): CapabilitySupport {
  if (location.kind === 'local') {
    if (capability === 'eridani') return { state: 'unavailable', reason: 'Native desktop Eridani execution is not implemented. Configure an execution host.' };
    return { state: 'available', reason: capability === 'agentLaunch' ? 'Desktop AgentManager uses the local PTY manager; installed agent runtime required.' : 'Provided by desktop handlers. Installed tools and permissions still apply.' };
  }
  if (['gitReview', 'worktrees', 'osOpen'].includes(capability)) return { state: 'unavailable', reason: 'This desktop action is not routed to remote hosts. Remote file browsing, editing and change statistics remain available.' };
  if (capability === 'agentLaunch' || capability === 'eridani') return { state: 'unknown', reason: 'Requires reported host/runtime support. Desktop AgentManager launches locally; a host terminal command does not establish Eridani readiness.' };
  return { state: 'available', reason: 'Provided by the session host when connected and permitted.' };
}
export function remoteDirectoryIssue(cwd?: string): string | null {
  return cwd && !(cwd.startsWith('/') || cwd === '~' || cwd.startsWith('~/'))
    ? 'Remote directories must be host paths beginning with / or ~/. A desktop path cannot be used on the host.' : null;
}
export function launchWarnings(shell: string | undefined, cwd: string | undefined, hosts: Record<string, { name: string }>, loaded = true): string[] {
  const { location } = decodeLaunch(shell);
  if (location.kind === 'local') return [];
  const warnings: string[] = [];
  if (loaded && !hosts[location.hostId]) warnings.push(`Saved host “${location.hostId}” is missing. This launch will fail; it will not run on this computer.`);
  const issue = remoteDirectoryIssue(cwd);
  if (issue) warnings.push(issue);
  return warnings;
}

/** Resolve profile paths using the launch owner, never the desktop OS. */
export function resolveLaunchDirectory(cwd: string | undefined, base: string | undefined, shell: string | undefined): string | undefined {
  if (!cwd || !base || /^[a-zA-Z]:[\\/]/.test(cwd) || cwd.startsWith('\\\\') || cwd.startsWith('/') || cwd === '~' || cwd.startsWith('~/')) return cwd;
  const remote = decodeLaunch(shell).location.kind === 'remote';
  const separator = remote ? '/' : '\\';
  return base.replace(/[\\/]+$/, '') + separator + cwd.replace(/^\.[\\/]/, '').replace(/[\\/]/g, separator);
}
