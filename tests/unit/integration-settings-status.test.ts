// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import AgentIntegrationSettings from '../../src/renderer/components/Settings/AgentIntegrationSettings';
import type { IntegrationStatus } from '../../src/shared/integration-status';
import { useStore } from '../../src/renderer/store';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const consent = {
  decision: 'granted',
  features: { instructions: true, hooks: true, orchestrator: true, browserMcp: true },
};
const observed: IntegrationStatus = {
  environment: 'desktop-user', checkedAt: 1234, runtime: 'not-probed', failures: [],
  files: [{ provider: 'Kiro', feature: 'instructions', path: '/temporary-home/.kiro/steering/wmux.md', state: 'missing' }],
};
let root: Root;
let container: HTMLDivElement;
let api: { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn>; status: ReturnType<typeof vi.fn> };
let bridgeDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  useStore.setState({ language: 'en' });
  api = {
    get: vi.fn().mockResolvedValue(consent),
    set: vi.fn().mockResolvedValue(consent),
    status: vi.fn().mockResolvedValue(observed),
  };
  bridgeDescriptor = Object.getOwnPropertyDescriptor(window, 'wmux');
  Object.defineProperty(window, 'wmux', { configurable: true, value: { integration: api } });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  if (bridgeDescriptor) Object.defineProperty(window, 'wmux', bridgeDescriptor);
  else delete (window as unknown as { wmux?: unknown }).wmux;
});

async function mount() {
  await act(async () => root.render(createElement(AgentIntegrationSettings)));
}

async function click(label: string) {
  const button = [...container.querySelectorAll('button')].find(button => button.textContent?.includes(label));
  expect(button).toBeDefined();
  await act(async () => button!.click());
}

it('separates a granted choice from missing observed files and never applies on refresh', async () => {
  await mount();
  expect((container.querySelector('input[type="checkbox"]') as HTMLInputElement).checked).toBe(true);
  expect(container.textContent).toContain('Missing managed content');
  expect(container.textContent).toContain('Runtime not probed');
  await click('Refresh file status');
  expect(api.get).toHaveBeenCalledTimes(2);
  expect(api.status).toHaveBeenCalledTimes(2);
  expect(api.set).not.toHaveBeenCalled();
});

it('shows bridge read failure and recovers through refresh without writing', async () => {
  api.status.mockRejectedValueOnce(new Error('PRIVATE_ERROR_DETAIL'));
  await mount();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('Could not read');
  expect(container.textContent).not.toContain('PRIVATE_ERROR_DETAIL');
  await click('Refresh file status');
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.textContent).toContain('Kiro');
  expect(api.set).not.toHaveBeenCalled();
});

it('reports apply failures independently of saved consent and retries only on explicit action', async () => {
  await mount();
  api.status.mockResolvedValueOnce({ ...observed, failures: [{ provider: 'Kiro', operation: 'write', code: 'EACCES' }] });
  await click('Retry applying saved choice');
  expect(api.set).toHaveBeenCalledExactlyOnceWith({});
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('EACCES');
  expect((container.querySelector('input[type="checkbox"]') as HTMLInputElement).checked).toBe(true);
  await click('Retry applying saved choice');
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

it('retains previous configuration on a rejected write and shows an actionable error', async () => {
  await mount();
  api.set.mockRejectedValueOnce(new Error('PRIVATE_WRITE_DETAIL'));
  await act(async () => (container.querySelector('input[type="checkbox"]') as HTMLInputElement).click());
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('could not be saved or applied');
  expect(container.textContent).not.toContain('PRIVATE_WRITE_DETAIL');
  expect((container.querySelector('input[type="checkbox"]') as HTMLInputElement).checked).toBe(true);
});

it('rejects malformed observations without crashing or calling a write', async () => {
  api.status.mockResolvedValueOnce({ ...observed, files: [{ feature: 'unknown' }] });
  await mount();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('Could not read');
  expect(api.set).not.toHaveBeenCalled();
});

it('does not replace newer observations when an earlier read resolves after remount', async () => {
  let finishEarlier: (status: IntegrationStatus) => void = () => {};
  api.status.mockReturnValueOnce(new Promise<IntegrationStatus>(resolve => { finishEarlier = resolve; }));
  await mount();
  act(() => root.render(null));
  api.status.mockResolvedValueOnce({
    ...observed,
    files: [{ ...observed.files[0], state: 'present' }],
  });
  await mount();
  expect(container.textContent).toContain('Present');
  await act(async () => finishEarlier(observed));
  expect(container.textContent).not.toContain('Missing managed content');
});

it('exposes read errors without requiring the provider details to be expanded', async () => {
  api.status.mockResolvedValueOnce({
    ...observed,
    files: [{ ...observed.files[0], state: 'error', code: 'EACCES' }],
  });
  await mount();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('could not be read');
  expect(container.querySelector('summary')?.textContent).toContain('1 read errors');
  expect(container.textContent).toContain('EACCES');
});
