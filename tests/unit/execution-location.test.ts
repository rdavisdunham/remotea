import { describe, it, expect } from 'vitest';
import { decodeLaunch, encodeLaunch, launchWarnings, executionCapability, resolveLaunchDirectory } from '../../src/shared/execution-location';

describe('compatible launch locations', () => {
  it('round trips saved local shells and host commands without rewriting them', () => {
    for (const shell of ['', 'pwsh.exe -NoLogo', 'remote:desk', 'remote:desk claude --resume abc']) {
      const launch = decodeLaunch(shell);
      expect(encodeLaunch(launch.location, launch.command)).toBe(shell);
    }
  });
  it('resolves host profile paths with host separators and preserves home paths', () => {
    expect(resolveLaunchDirectory('./server', '/repo', 'remote:desk')).toBe('/repo/server');
    expect(resolveLaunchDirectory('~/server', '/repo', 'remote:desk')).toBe('~/server');
    expect(resolveLaunchDirectory('./server', 'C:\\repo', 'pwsh.exe')).toBe('C:\\repo\\server');
    expect(decodeLaunch('local:')).toEqual({ location: { kind: 'local' }, command: '' });
  });
  it('keeps a missing host remote and explains failure instead of local fallback', () => {
    expect(decodeLaunch('remote:removed codex').location).toEqual({ kind: 'remote', hostId: 'removed' });
    expect(launchWarnings('remote:removed codex', '/repo', {})).toEqual([expect.stringContaining('will not run on this computer')]);
    expect(launchWarnings('remote:removed', '', {}, false)).toEqual([]);
  });
  it('distinguishes host paths from desktop paths without rewriting either', () => {
    expect(launchWarnings('remote:desk', 'C:\\repo', { desk: { name: 'Desk' } })).toEqual([expect.stringContaining('host paths')]);
    for (const cwd of ['/repo', '~', '~/repo', '']) expect(launchWarnings('remote:desk', cwd, { desk: { name: 'Desk' } })).toEqual([]);
  });
  it('does not infer full Git or agent execution from remote file support', () => {
    const host = { kind: 'remote', hostId: 'desk' } as const;
    expect(executionCapability(host, 'files').state).toBe('available');
    expect(executionCapability(host, 'diffStats').state).toBe('available');
    for (const op of ['gitReview', 'worktrees', 'osOpen'] as const) expect(executionCapability(host, op).state).toBe('unavailable');
    expect(executionCapability(host, 'agentLaunch').state).toBe('unknown');
    expect(executionCapability({ kind: 'local' }, 'eridani').state).toBe('unavailable');
  });
});
