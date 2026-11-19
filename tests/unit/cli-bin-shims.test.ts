import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * The `remotea` / `remotea.cmd` shims on PATH inside every pane.
 *
 * Both run `<a JS runtime> $REMOTEA_CLI "$@"`. Until #187 that runtime was the
 * bare name `node`, which assumes node is installed AND on the PATH the caller
 * inherited — neither guaranteed. They now prefer `$REMOTEA_NODE`, the runtime
 * remotea resolved in its own process.
 */
const ROOT = path.join(__dirname, '..', '..');
const BIN = path.join(ROOT, 'src', 'cli-bin');
const IS_WIN = process.platform === 'win32';
/** Absolute, like every other cmd.exe/tar.exe call in remotea — never off PATH. */
const CMD_EXE = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe');

/** A stand-in for remotea.js that reports what actually reached it. */
function probe(): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'remotea-shim-')), 'probe.js');
  fs.writeFileSync(file, 'console.log(JSON.stringify({exe: process.execPath, argv: process.argv.slice(2)}));');
  return file;
}

function runCmdShim(env: Record<string, string | undefined>, args: string[]) {
  // Invoked by bare name from cwd: Node's cmd.exe argument quoting cannot
  // survive both a script path containing spaces ("OneDrive - Pulsa") and
  // embedded quotes in the same command line, and it is the ARGUMENTS this
  // test is about.
  const out = execFileSync(CMD_EXE, ['/c', 'remotea.cmd', ...args], {
    encoding: 'utf8',
    cwd: BIN,
    env: { ...process.env, ...env },
  });
  return JSON.parse(out.trim().split(/\r?\n/).pop()!);
}

describe('remotea.cmd line endings', () => {
  it('is CRLF — cmd.exe parses a .cmd by byte offset (#187 follow-on)', () => {
    // Fed LF-only, cmd.exe resumes mid-token: `setlocal` runs as `tlocal`,
    // `REM` as `M`. It still limps to the last line, so the damage is visible
    // only as stderr noise and a `setlocal` that never took — meaning
    // ELECTRON_RUN_AS_NODE leaks into the caller's shell.
    const raw = fs.readFileSync(path.join(BIN, 'remotea.cmd'), 'latin1');
    expect(raw).not.toMatch(/[^\r]\n/);
  });

  it('.gitattributes pins that, rather than relying on core.autocrlf', () => {
    const attrs = fs.readFileSync(path.join(ROOT, '.gitattributes'), 'utf8');
    expect(attrs).toMatch(/src\/cli-bin\/remotea\.cmd\s+text\s+eol=crlf/);
  });

  it('the bash twin stays LF, or its shebang breaks', () => {
    expect(fs.readFileSync(path.join(BIN, 'remotea'), 'utf8')).not.toMatch(/\r/);
  });
});

describe.runIf(IS_WIN)('remotea.cmd runtime selection (#187)', () => {
  const cli = probe();

  it('falls back to bare `node` when remotea declared nothing', () => {
    // An older remotea, or a shell remotea did not spawn. Must keep working.
    const r = runCmdShim({ REMOTEA_CLI: cli, REMOTEA_NODE: undefined, REMOTEA_NODE_ELECTRON: undefined }, ['ping']);
    expect(path.basename(r.exe).toLowerCase()).toBe('node.exe');
  });

  it('uses $REMOTEA_NODE when remotea declared one', () => {
    const r = runCmdShim({ REMOTEA_CLI: cli, REMOTEA_NODE: process.execPath }, ['ping']);
    expect(r.exe).toBe(process.execPath);
  });

  it('preserves quoting — `--choices` is exact JSON bytes (#128)', () => {
    const r = runCmdShim({ REMOTEA_CLI: cli, REMOTEA_NODE: process.execPath }, [
      'report-agent',
      '--blocked',
      'Run the migration?',
      '--choices',
      '[{"id":"y","label":"Yes","key":"1"}]',
    ]);
    expect(r.argv).toEqual([
      'report-agent',
      '--blocked',
      'Run the migration?',
      '--choices',
      '[{"id":"y","label":"Yes","key":"1"}]',
    ]);
  });

  it('does not leak its scratch variables into the caller (setlocal)', () => {
    const out = execFileSync(
      CMD_EXE,
      ['/c', 'remotea.cmd ping >nul 2>&1 & echo [%REMOTEA_NODE_BIN%][%ELECTRON_RUN_AS_NODE%]'],
      {
        encoding: 'utf8',
        cwd: BIN,
        env: { ...process.env, REMOTEA_CLI: cli, REMOTEA_NODE: process.execPath, REMOTEA_NODE_ELECTRON: '1' },
      },
    );
    // cmd.exe leaves an UNSET variable as its own literal `%NAME%`, so this is
    // the shape of "nothing escaped". A leak would print the runtime path / `1`.
    expect(out.trim()).toBe('[%REMOTEA_NODE_BIN%][%ELECTRON_RUN_AS_NODE%]');
  });
});

describe.runIf(!IS_WIN)('remotea-open-url', () => {
  it('forwards `open` and the URL to the CLI', () => {
    const cli = probe();
    const out = execFileSync('bash', [path.join(BIN, 'remotea-open-url'), 'https://example.com'], {
      encoding: 'utf8',
      env: { ...process.env, REMOTEA_CLI: cli, REMOTEA_NODE: process.execPath },
    });
    expect(JSON.parse(out.trim())).toEqual({
      exe: process.execPath,
      argv: ['open', 'https://example.com'],
    });
  });
});
