import { describe, it, expect, vi } from 'vitest';

const exit = vi.fn();
const whenReady = vi.fn(() => Promise.resolve());
vi.mock('electron', () => ({
  app: { exit, whenReady, isPackaged: false, getPath: () => '/tmp' },
  dialog: { showMessageBoxSync: vi.fn() },
}));

describe('move mode', () => {
  it('is selected by --move', async () => {
    const { isMoveRun } = await import('../../src/main/move-mode');
    expect(isMoveRun(['electron', '.', '--move'])).toBe(true);
    expect(isMoveRun(['electron', '.'])).toBe(false);
  });

  it('refuses while the app is open, before touching anything', async () => {
    const { runMoveMode } = await import('../../src/main/move-mode');
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await runMoveMode(false);
    expect(err.mock.calls.map((c) => String(c[0])).join('')).toContain('remotea is open');
    expect(exit).toHaveBeenCalledWith(1);
    expect(whenReady).not.toHaveBeenCalled();
    err.mockRestore();
  });
});
