// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
const mounted = vi.hoisted(() => ({ integration: vi.fn(), phone: vi.fn(), changelog: vi.fn() }));
vi.mock('../../src/renderer/components/Settings/AgentIntegrationSettings', () => ({ default: () => { mounted.integration(); return createElement('div', null, 'Integration controls'); } }));
vi.mock('../../src/renderer/components/Settings/RemoteConsoleSettings', () => ({ default: () => { mounted.phone(); return createElement('div', null, 'Phone controls'); } }));
vi.mock('../../src/renderer/components/Settings/ChangelogSettings', () => ({ default: () => { mounted.changelog(); return createElement('div', null, 'Release history'); } }));
vi.mock('../../src/renderer/components/Settings/GeneralSettings', () => ({ default: () => createElement('div', null, 'Appearance controls') }));
import SettingsWindow from '../../src/renderer/components/Settings/SettingsWindow';
let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); cleanup = undefined; vi.clearAllMocks(); });
it('preserves old initialTab links and mounts operational sections only when selected', async () => {
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  cleanup = () => { act(() => root.unmount()); container.remove(); };
  await act(async () => root.render(createElement(SettingsWindow, { initialTab: 'General', onClose: vi.fn() })));
  expect(container.textContent).toContain('Appearance controls');
  expect(mounted.integration).not.toHaveBeenCalled();
  expect(mounted.phone).not.toHaveBeenCalled();
  expect(mounted.changelog).not.toHaveBeenCalled();
  const buttons = [...container.querySelectorAll('button')];
  const agents = buttons.find(button => button.textContent === 'Agent integration');
  expect(agents).toBeDefined();
  await act(async () => agents!.click());
  expect(mounted.integration).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain('Integration controls');
  expect(container.textContent).not.toContain('Appearance controls');
  expect(mounted.phone).not.toHaveBeenCalled();
  expect(mounted.changelog).not.toHaveBeenCalled();
});

it('shows section-owned snapshots and separates host, phone and integration ownership', async () => {
  const { default: SettingsScope } = await import('../../src/renderer/components/Settings/SettingsScope');
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  cleanup = () => { act(() => root.unmount()); container.remove(); };

  await act(async () => root.render(createElement(SettingsScope, { section: 'Terminal' })));
  const snapshot = JSON.parse(container.querySelector('pre')!.textContent!);
  expect(Object.keys(snapshot)).toEqual(['terminalPrefs']);
  expect(container.textContent).toContain('cannot identify whether an individual value');

  await act(async () => root.render(createElement(SettingsScope, { section: 'Hosts' })));
  expect(container.querySelector('pre')).toBeNull();
  expect(container.textContent).toContain('connection definitions and credentials');
  expect(container.textContent).not.toContain('Ordinary preferences save immediately');

  await act(async () => root.render(createElement(SettingsScope, { section: 'Remote' })));
  expect(container.querySelector('pre')).toBeNull();
  expect(container.textContent).toContain('paired-device store');

  await act(async () => root.render(createElement(SettingsScope, { section: 'Agents' })));
  expect(container.querySelector('pre')).toBeNull();
  expect(container.textContent).toContain('immediately write or remove integration files');
});
