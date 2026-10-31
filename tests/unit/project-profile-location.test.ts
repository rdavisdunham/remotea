// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { desktopProjectProfileSource, useProjectProfiles } from '../../src/renderer/hooks/useProjectProfiles';
import type { PaneId, SurfaceId, SurfaceRef, WorkspaceId, WorkspaceInfo } from '../../src/shared/types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const profile = { id: 'project-test', type: 'terminal', name: 'Project task', shell: 'pwsh.exe' };
function workspace(shell: string, surfaces: SurfaceRef[] = [], cwd = '/home/repo'): WorkspaceInfo {
  return { id: 'ws-project-test' as WorkspaceId, title: 'Project', shell, cwd, pinned: false, unreadCount: 0, splitTree: { type: 'leaf', paneId: 'pane-test' as PaneId, activeSurfaceIndex: Math.max(0, surfaces.length - 1), surfaces } };
}
function terminal(id: string, shell: string, cwd = '/home/repo'): SurfaceRef {
  return { id: id as SurfaceId, type: 'terminal', shell, cwd };
}
function Preview({ value }: { value: WorkspaceInfo }) {
  return createElement('div', null, useProjectProfiles(value).map((item) => item.name).join(','));
}

describe('desktop project profile ownership', () => {
  let root: Root;
  let container: HTMLDivElement;
  let original: typeof window.wmux;
  const lookup = vi.fn();
  beforeEach(() => {
    original = window.wmux;
    lookup.mockReset().mockResolvedValue([profile]);
    window.wmux = { config: { getProjectProfiles: lookup } } as unknown as typeof window.wmux;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    window.wmux = original;
  });
  const render = async (value: WorkspaceInfo) => act(async () => root.render(createElement(Preview, { value })));

  it('never asks desktop files for a host-only workspace path, including before terminals mount', async () => {
    for (const value of [workspace('remote:desk'), workspace('pwsh.exe', [terminal('surf-host', 'remote:desk')])]) {
      await render(value);
      expect(desktopProjectProfileSource(value)).toBeNull();
      expect(lookup).not.toHaveBeenCalled();
      expect(container.textContent).toBe('');
    }
  });

  it('refuses same-path mixed ownership and unknown launch ownership', async () => {
    for (const value of [workspace('pwsh.exe', [terminal('surf-local', 'pwsh.exe'), terminal('surf-host', 'remote:desk')]), workspace('', [terminal('surf-unknown', '')]), workspace('remote:???')]) {
      await render(value);
      expect(lookup).not.toHaveBeenCalled();
      expect(container.textContent).toBe('');
    }
  });

  it('preserves local profiles with a focused browser and an inactive local cwd owner', async () => {
    const value = workspace('remote:desk', [terminal('surf-local', 'local:'), { id: 'surf-browser' as SurfaceId, type: 'browser' }]);
    await render(value);
    expect(lookup).toHaveBeenCalledExactlyOnceWith('/home/repo', { surfaceId: 'surf-local', shell: 'local:' });
    expect(container.textContent).toBe('Project task');
  });

  it('preserves explicit local browser-only workspaces and local shells awaiting cwd reports', async () => {
    const browser = { id: 'surf-browser' as SurfaceId, type: 'browser' as const };
    await render(workspace('pwsh.exe', [browser], 'C:\\repo'));
    expect(lookup).toHaveBeenLastCalledWith('C:\\repo', { surfaceId: undefined, shell: 'pwsh.exe' });
    expect(container.textContent).toBe('Project task');
    await render(workspace('pwsh.exe', [{ id: 'surf-local' as SurfaceId, type: 'terminal', shell: 'pwsh.exe' }], 'C:\\other'));
    expect(lookup).toHaveBeenLastCalledWith('C:\\other', { surfaceId: undefined, shell: 'pwsh.exe' });
  });

  it('clears local profiles immediately on a host transition and ignores an old local response', async () => {
    let finish!: (value: typeof profile[]) => void;
    lookup.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    await render(workspace('pwsh.exe', [terminal('surf-local', 'pwsh.exe')]));
    await render(workspace('remote:desk', [terminal('surf-host', 'remote:desk')]));
    await act(async () => finish([profile]));
    expect(lookup).toHaveBeenCalledOnce();
    expect(container.textContent).toBe('');
  });
});
