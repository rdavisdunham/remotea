/**
 * One `remotea` command (KTD11), desktop half: the verb list the host reads
 * matches the desktop CLI's own table, and a verb the desktop does not know
 * goes to the next `remotea` on PATH that is not one of this install's shims.
 */
import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { COMMAND_SPECS } from '../../src/cli/remotea';
import { DESKTOP_VERBS, FORWARDED_ENV, SHIM_MARKER } from '../../src/cli/verbs';
import { findNextRemotea, forwardUnknownVerb, unknownVerbMessage, type ForwardDeps } from '../../src/cli/forward';

const OWN = '/opt/remotea/resources/cli-bin';
const HOST = '/home/x/.local/bin';

function deps(files: Record<string, string>, over: Partial<ForwardDeps> = {}): ForwardDeps & { calls: Array<{ file: string; args: string[]; env: NodeJS.ProcessEnv }> } {
  const calls: Array<{ file: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
  return {
    calls,
    env: { PATH: [OWN, '/usr/bin', HOST].join(path.delimiter) },
    platform: 'linux',
    ownDirs: [OWN],
    isFile: (p) => p in files,
    readHead: (p) => files[p] ?? '',
    run: (file, args, env) => {
      calls.push({ file, args, env });
      return 0;
    },
    ...over,
  };
}

describe('the desktop verb list', () => {
  it('is exactly the desktop CLI\'s command table', () => {
    expect([...DESKTOP_VERBS].sort()).toEqual(Object.keys(COMMAND_SPECS).sort());
  });
});

describe('forwarding an unknown verb', () => {
  const hostCli = path.join(HOST, 'remotea');
  const ownShim = path.join(OWN, 'remotea');

  it('reaches the host remotea past this install\'s own shim', () => {
    const d = deps({ [ownShim]: `#!/usr/bin/env bash\n${SHIM_MARKER}\n`, [hostCli]: '#!/usr/bin/env node\n' });
    expect(forwardUnknownVerb(['doctor', '--json'], d)).toBe(0);
    expect(d.calls).toHaveLength(1);
    expect(d.calls[0].file).toBe(hostCli);
    expect(d.calls[0].args).toEqual(['doctor', '--json']);
    expect(d.calls[0].env[FORWARDED_ENV]).toBe('1');
  });

  it('skips another remotea shim found outside its own folders', () => {
    const otherShim = '/usr/bin/remotea';
    const d = deps({ [otherShim]: `#!/usr/bin/env bash\n${SHIM_MARKER}\n`, [hostCli]: '#!/usr/bin/env node\n' });
    expect(findNextRemotea(d)).toBe(hostCli);
  });

  it('does nothing without a host remotea, so the CLI prints its pointer', () => {
    const d = deps({ [ownShim]: SHIM_MARKER });
    expect(forwardUnknownVerb(['doctor'], d)).toBeNull();
    expect(d.calls).toHaveLength(0);
    expect(unknownVerbMessage('doctor')).toContain('host');
    expect(unknownVerbMessage('doctor')).toContain('remotea --help');
  });

  it('never forwards a call that was already handed over', () => {
    const d = deps({ [hostCli]: '#!/usr/bin/env node\n' }, { env: { PATH: HOST, [FORWARDED_ENV]: '1' } });
    expect(forwardUnknownVerb(['frobnicate'], d)).toBeNull();
    expect(d.calls).toHaveLength(0);
  });

  it('does not look on Windows, where no host CLI lives', () => {
    const d = deps({ [hostCli]: '' }, { platform: 'win32' });
    expect(findNextRemotea(d)).toBeNull();
  });
});
