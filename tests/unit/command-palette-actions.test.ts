// @vitest-environment jsdom
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ShortcutAction } from '../../src/renderer/store/settings-slice';
import CommandPalette from '../../src/renderer/components/CommandPalette/CommandPalette';
import { useKeyboardShortcuts } from '../../src/renderer/hooks/useKeyboardShortcuts';
import { dispatchAppAction } from '../../src/renderer/utils/app-action';
import { useStore } from '../../src/renderer/store';

vi.mock('../../src/renderer/i18n', async importOriginal => {
  const original = await importOriginal<typeof import('../../src/renderer/i18n')>();
  const labels: Record<string, string> = {
    'activity.appTheme': 'App theme',
    'activity.terminalTheme': 'Terminal theme',
    'activity.theme.system': 'Follow system',
    'activity.theme.dark': 'Dark',
    'activity.theme.light': 'Light',
  };
  const translate = (key: string, fallback?: string) => labels[key] ?? fallback ?? key;
  return { ...original, useT: () => translate };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;
let initial: ReturnType<typeof useStore.getState>;

beforeEach(() => {
  initial = useStore.getState();
  useStore.setState({
    workspaces: [],
    activeWorkspaceId: null,
    savedLayouts: [],
    sidebarVisible: true,
    shortcuts: { ...initial.shortcuts, toggleSidebar: { key: 'F8', alt: true } },
  });
  Object.defineProperty(window, 'remotea', {
    configurable: true,
    value: { config: { getThemeList: vi.fn().mockResolvedValue(['Solarized', 'Dracula']) } },
  });
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    configurable: true, value: vi.fn(),
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useStore.setState(initial, true);
  vi.restoreAllMocks();
  delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  delete (window as unknown as { remotea?: unknown }).remotea;
});

function input(): HTMLInputElement {
  return container.querySelector('input')!;
}

function search(value: string) {
  act(() => {
    // Use the native setter so React receives a real user edit rather than its tracked value.
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input(), value);
    input().dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function key(value: string) {
  act(() => input().dispatchEvent(new KeyboardEvent('keydown', {
    key: value, bubbles: true, cancelable: true,
  })));
}

async function renderPalette(onAction = vi.fn(), onClose = vi.fn()) {
  await act(async () => root.render(createElement(CommandPalette, { onAction, onClose })));
  return { onAction, onClose };
}

describe('command palette executable choices', () => {
  it('runs the named app action through the mounted shortcut hook after rebinding', async () => {
    function Harness() {
      const [open, setOpen] = useState(true);
      useKeyboardShortcuts(null);
      return open ? createElement(CommandPalette, {
        onClose: () => setOpen(false),
        onAction: action => {
          dispatchAppAction(action as ShortcutAction);
          setOpen(false);
        },
      }) : null;
    }
    await act(async () => root.render(createElement(Harness)));
    search('Toggle Sidebar');
    expect(container.querySelector('.command-palette__item-shortcut')?.textContent).toBe('Alt+F8');
    key('Enter');
    expect(useStore.getState().sidebarVisible).toBe(false);
    expect(container.querySelector('input')).toBeNull();
    // Unmounting the action owner removes the listener, preventing stale window actions.
    act(() => root.render(null));
    act(() => { expect(dispatchAppAction('toggleSidebar')).toBe(false); });
    expect(useStore.getState().sidebarVisible).toBe(false);
  });

  it('applies an app theme through the same persisted preference setter as Settings', async () => {
    const { onClose } = await renderPalette();
    search('App theme Light');
    expect(container.querySelectorAll('.command-palette__item')).toHaveLength(1);
    key('Enter');
    expect(useStore.getState().appearancePrefs.uiTheme).toBe('light');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('loads available terminal themes and applies the selected theme', async () => {
    const { onClose } = await renderPalette();
    search('Terminal theme Solarized');
    expect(container.textContent).toContain('Terminal theme: Solarized');
    key('Enter');
    expect(useStore.getState().terminalPrefs.theme).toBe('Solarized');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('lists every choice, moves selection past the tenth row and executes that row', async () => {
    const { onAction } = await renderPalette();
    expect(container.querySelectorAll('.command-palette__item').length).toBeGreaterThan(12);
    for (let index = 0; index < 12; index++) {
      key('ArrowDown');
      expect(container.querySelectorAll('.command-palette__item--selected')).toHaveLength(1);
    }
    const selected = container.querySelector('.command-palette__item--selected')!;
    const label = selected.querySelector('.command-palette__item-label')!.textContent;
    // Compare mouse and keyboard activation of the visible row, without assuming ordering.
    act(() => selected.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
    const mouseAction = onAction.mock.calls.at(-1)?.[0];
    expect(mouseAction).toBeDefined();
    onAction.mockClear();
    key('Enter');
    expect(onAction).toHaveBeenCalledExactlyOnceWith(mouseAction);
    expect(container.querySelector('.command-palette__item--selected')?.textContent).toContain(label);
  });

  it('jumps to a terminal in another workspace by its name', async () => {
    useStore.setState({
      workspaces: [{
        id: 'ws-fixture', title: 'Fixture workspace', pinned: false, shell: 'bash', unreadCount: 0,
        splitTree: {
          type: 'leaf', paneId: 'pane-fixture', activeSurfaceIndex: 0,
          surfaces: [{ id: 'surf-fixture', type: 'terminal', customTitle: 'Billing export fix' }],
        },
      }] as never,
    });
    const focused = vi.fn();
    document.addEventListener('remotea:focus-surface', focused);
    try {
      const { onClose } = await renderPalette();
      search('billing');
      const first = container.querySelector('.command-palette__item')!;
      expect(first.textContent).toContain('Billing export fix');
      expect(first.textContent).toContain('Fixture workspace');
      expect(container.querySelector('.command-palette__group-title')?.textContent).toBe('Terminals');
      key('Enter');
      expect(focused).toHaveBeenCalledOnce();
      expect((focused.mock.calls[0][0] as CustomEvent).detail).toEqual({ workspaceId: 'ws-fixture', surfaceId: 'surf-fixture' });
      expect(onClose).toHaveBeenCalledOnce();
    } finally {
      document.removeEventListener('remotea:focus-surface', focused);
    }
  });
});
