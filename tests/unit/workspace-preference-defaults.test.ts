// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { create } from 'zustand';
import { createSettingsSlice, type SettingsSlice } from '../../src/renderer/store/settings-slice';
import { createWorkspaceSlice, type WorkspaceSlice } from '../../src/renderer/store/workspace-slice';
import { getAllPaneIds } from '../../src/renderer/store/split-utils';

const KEY = 'wmux-workspace-prefs';
function makeStore() {
  return create<SettingsSlice & WorkspaceSlice>()((...args) => ({
    ...createSettingsSlice(...args),
    ...createWorkspaceSlice(...args),
  }));
}

beforeEach(() => localStorage.clear());

describe('new workspace defaults across app upgrades', () => {
  it.each([{}, { newWorkspacePanes: 3 }, { newWorkspacePanes: 3, newWorkspaceLayout: 'grid' }])('creates one terminal from fresh or legacy defaults %j', saved => {
    localStorage.setItem(KEY, JSON.stringify(saved));
    const store = makeStore();
    store.getState().createWorkspace();
    store.getState().createWorkspace();
    expect(store.getState().workspaces.map(workspace => getAllPaneIds(workspace.splitTree).length)).toEqual([1, 1]);
    expect(JSON.parse(localStorage.getItem(KEY)!).newWorkspaceDefaultsRev).toBe(1);
  });

  it('keeps a later explicit choice of three panes across reload', () => {
    const store = makeStore();
    store.getState().setWorkspacePrefs({ newWorkspacePanes: 3 });
    const reloaded = makeStore();
    reloaded.getState().createWorkspace();
    expect(getAllPaneIds(reloaded.getState().workspaces[0].splitTree)).toHaveLength(3);
  });

  it.each([{ newWorkspacePanes: 4, newWorkspaceLayout: 'grid' }, { newWorkspacePanes: 3, newWorkspaceLayout: 'columns' }])('preserves a custom pane configuration %j', saved => {
    localStorage.setItem(KEY, JSON.stringify(saved));
    const store = makeStore();
    store.getState().createWorkspace();
    expect(getAllPaneIds(store.getState().workspaces[0].splitTree)).toHaveLength(saved.newWorkspacePanes);
  });

  it('persists whether the Eridani section is expanded', () => {
    const store = makeStore();
    expect(store.getState().sidebarPrefs.eridaniRunsExpanded).toBe(false);
    store.getState().setSidebarPrefs({ eridaniRunsExpanded: true });
    expect(makeStore().getState().sidebarPrefs.eridaniRunsExpanded).toBe(true);
  });
});
