// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { ExplorerPanel } from '../../src/renderer/components/Explorer/ExplorerPanel';
import { useStore } from '../../src/renderer/store';
import type { PaneId, SurfaceId, WorkspaceId, WorkspaceInfo } from '../../src/shared/types';

const diff = vi.hoisted(() => ({ stats: new Map(), touched: new Set(), total: { files: 1, additions: 2, deletions: 0 }, baseline: 'git', refresh: () => {} }));
vi.mock('../../src/renderer/components/Explorer/use-explorer-diff', () => ({ useExplorerDiff: () => diff }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('remote explorer file activation', () => {
  it('opens remote code through the terminal-bound reader while refusing full desktop diff', async () => {
    const original = window.remotea;
    const readCode = vi.fn().mockResolvedValue({ filePath: '/host/repo/app.ts', content: 'const remote = true;', mtimeMs: 4 });
    const desktopRead = vi.fn();
    const desktopDiff = vi.fn();
    window.remotea = { explorer: { listDir: vi.fn().mockResolvedValue({ root: '/host/repo', relPath: '', entries: [{ name: 'app.ts', kind: 'file', size: 20, mtimeMs: 4, viewable: true }], truncated: false }) }, code: { readFile: readCode }, markdown: { readFile: desktopRead }, diff: { getFiles: desktopDiff } } as unknown as typeof window.remotea;
    const ws = 'ws-host-test' as WorkspaceId;
    const pane = 'pane-host-test' as PaneId;
    const terminal = 'surf-host-test' as SurfaceId;
    const workspace: WorkspaceInfo = { id: ws, title: 'Host', shell: 'remote:desk', cwd: '/host/repo', pinned: false, unreadCount: 0, splitTree: { type: 'leaf', paneId: pane, activeSurfaceIndex: 0, surfaces: [{ id: terminal, type: 'terminal', shell: 'remote:desk', cwd: '/host/repo' }] } };
    useStore.setState({ workspaces: [workspace], activeWorkspaceId: ws, language: 'en' });
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(createElement(ExplorerPanel, { onClose: () => {}, focusedPaneId: pane })));
      const row = container.querySelector<HTMLElement>('[role="treeitem"]');
      expect(row).not.toBeNull();
      await act(async () => row!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
      expect(readCode).toHaveBeenCalledWith(terminal, 'app.ts');
      const tree = useStore.getState().workspaces[0].splitTree;
      expect(tree.type === 'leaf' && tree.surfaces.find((surface) => surface.type === 'code')).toMatchObject({ codeRootSurfaceId: terminal, codeRelPath: 'app.ts', codeContent: 'const remote = true;' });
      expect(desktopRead).not.toHaveBeenCalled();
      await act(async () => container.querySelector<HTMLElement>('.explorer-panel__diffbar')!.click());
      expect(container.textContent).toContain('not routed to remote hosts');
      expect(desktopDiff).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
      container.remove();
      window.remotea = original;
      useStore.setState({ workspaces: [], activeWorkspaceId: null });
    }
  });
});
