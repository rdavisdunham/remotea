import { describe, it, expect } from 'vitest';
import {
  blockEmbeddedDirs,
  hookCommandScript,
  isRemoteaBlock,
  isRemoteaHookCommand,
  type OwnershipContext,
} from '../../src/shared/artifact-ownership';

const INSTALL_CLI = 'C:\\Users\\x\\AppData\\Local\\Programs\\remotea\\resources\\cli';
const INSTALL_BIN = 'C:\\Users\\x\\AppData\\Local\\Programs\\remotea\\resources\\cli-bin';
const HOST_CLI = '/home/x/.local/share/remotea/cli';

function ctx(files: Record<string, string> = {}): OwnershipContext {
  return {
    knownDirs: [INSTALL_CLI, INSTALL_BIN, HOST_CLI],
    readFile: (p) => (p in files ? files[p] : null),
  };
}

describe('hookCommandScript', () => {
  it('reads a quoted script path', () => {
    expect(hookCommandScript('node "C:/a b/wmux-hook.js" --event Stop')).toBe('C:/a b/wmux-hook.js');
  });
  it('reads a bare script path', () => {
    expect(hookCommandScript('node /x/wmux-hook.js Bash')).toBe('/x/wmux-hook.js');
  });
  it('accepts a quoted node path', () => {
    expect(hookCommandScript('"C:/n/node.exe" "C:/x/wmux-hook.js" Bash')).toBe('C:/x/wmux-hook.js');
  });
  it('returns null for another shape', () => {
    expect(hookCommandScript('bash -c "wmux-hook"')).toBeNull();
  });
});

describe('isRemoteaHookCommand', () => {
  it('does not claim a wmux install', () => {
    const cmd = 'node "C:\\Users\\x\\AppData\\Local\\Programs\\wmux\\resources\\cli\\wmux-hook.js" stop';
    expect(isRemoteaHookCommand(cmd, ctx())).toBe(false);
  });

  it('claims this install', () => {
    expect(isRemoteaHookCommand(`node "${INSTALL_CLI}\\wmux-hook.js" stop`, ctx())).toBe(true);
  });

  it('claims this install with forward slashes and other case', () => {
    const cmd = 'node "c:/users/x/appdata/local/programs/REMOTEA/resources/cli/wmux-hook.js" --event Stop';
    expect(isRemoteaHookCommand(cmd, ctx())).toBe(true);
  });

  it('claims the host helper folder', () => {
    expect(isRemoteaHookCommand(`node "${HOST_CLI}/wmux-hook.js" --event Stop`, ctx())).toBe(true);
  });

  it('does not claim some other folder named remotea', () => {
    expect(isRemoteaHookCommand('node "/home/x/remotea/wmux-hook.js" stop', ctx())).toBe(false);
  });

  it('does not claim a folder whose name only starts like a known one', () => {
    expect(isRemoteaHookCommand(`node "${HOST_CLI}-old/wmux-hook.js" stop`, ctx())).toBe(false);
  });

  it('claims a second remotea worktree by its package.json', () => {
    const files = { '/w/remotea-2/package.json': JSON.stringify({ name: 'remotea' }) };
    expect(isRemoteaHookCommand('node "/w/remotea-2/resources/cli/wmux-hook.js" stop', ctx(files))).toBe(true);
  });

  it('does not claim a wmux checkout with the same layout', () => {
    const files = { '/w/wmux/package.json': JSON.stringify({ name: 'wmux' }) };
    expect(isRemoteaHookCommand('node "/w/wmux/resources/cli/wmux-hook.js" stop', ctx(files))).toBe(false);
  });

  it('does not claim a checkout layout with no readable package.json', () => {
    expect(isRemoteaHookCommand('node "/w/gone/resources/cli/wmux-hook.js" stop', ctx())).toBe(false);
  });

  it('ignores non-string commands', () => {
    expect(isRemoteaHookCommand(undefined, ctx())).toBe(false);
  });
});

describe('isRemoteaBlock', () => {
  const block = (dir: string) =>
    `<!-- wmux:start -->\nRun:\n"${dir}/wmux" identify\n"${dir}/wmux" capabilities\n<!-- wmux:end -->`;

  it('lists the folders a block names', () => {
    expect(blockEmbeddedDirs(block('C:/p/resources/cli-bin'))).toEqual(['C:/p/resources/cli-bin']);
  });

  it('claims a block rendered with this install', () => {
    expect(isRemoteaBlock(block(INSTALL_BIN.replace(/\\/g, '/')), ctx())).toBe(true);
  });

  it('does not claim a block rendered with a wmux install', () => {
    expect(isRemoteaBlock(block('C:/Users/x/AppData/Local/Programs/wmux/resources/cli-bin'), ctx())).toBe(false);
  });

  it('claims a block rendered from a remotea checkout', () => {
    const files = { '/w/remotea/package.json': JSON.stringify({ name: 'remotea' }) };
    expect(isRemoteaBlock(block('/w/remotea/resources/cli-bin'), ctx(files))).toBe(true);
  });

  it('claims a block rendered by a source run (src/cli-bin)', () => {
    const files = { '/w/remotea/package.json': JSON.stringify({ name: 'remotea' }) };
    expect(isRemoteaBlock(block('/w/remotea/src/cli-bin'), ctx(files))).toBe(true);
  });

  it('does not claim a src/cli-bin block from a wmux checkout', () => {
    const files = { '/w/wmux/package.json': JSON.stringify({ name: 'wmux' }) };
    expect(isRemoteaBlock(block('/w/wmux/src/cli-bin'), ctx(files))).toBe(false);
  });

  it('does not claim a block with no path in it', () => {
    expect(isRemoteaBlock('<!-- wmux:start -->\nnotes\n<!-- wmux:end -->', ctx())).toBe(false);
  });
});
