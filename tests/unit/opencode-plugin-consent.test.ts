import { describe, it, expect, vi, beforeEach } from 'vitest';

// The `orchestrator` consent key now controls only the OpenCode status plugin
// (KTD18, the legacy orchestrator removal). The key keeps its old name so a
// stored `false` keeps the plugin off; these pin that.
vi.mock('../../src/main/integration-failures', () => ({ clearIntegrationFailures: vi.fn() }));
vi.mock('../../src/main/settings-store', () => ({ loadSettings: vi.fn(() => ({})), saveSetting: vi.fn(() => true) }));
vi.mock('../../src/main/claude-context');
vi.mock('../../src/main/opencode-context');
vi.mock('../../src/main/kiro-context');
vi.mock('../../src/main/omp-context');
vi.mock('../../src/main/grok-context');
vi.mock('../../src/main/pi-context');
vi.mock('../../src/main/agy-context');
vi.mock('../../src/main/qwen-context');

import { applyConsent, parseConsent } from '../../src/main/agent-integration';
import { ensureOpencodePlugin, removeOpencodePlugin } from '../../src/main/opencode-context';

const ALL_ON = { instructions: true, hooks: true, orchestrator: true, browserMcp: true };

beforeEach(() => vi.clearAllMocks());

describe('the orchestrator consent key (OpenCode status plugin)', () => {
  it('keeps the OpenCode plugin off for a stored orchestrator: false', () => {
    const consent = parseConsent({ decision: 'granted', features: { ...ALL_ON, orchestrator: false } });
    expect(consent.features.orchestrator).toBe(false);
    applyConsent(consent);
    expect(removeOpencodePlugin).toHaveBeenCalledTimes(1);
    expect(ensureOpencodePlugin).not.toHaveBeenCalled();
  });

  it('installs the OpenCode plugin for orchestrator: true', () => {
    applyConsent(parseConsent({ decision: 'granted', features: ALL_ON }));
    expect(ensureOpencodePlugin).toHaveBeenCalledTimes(1);
    expect(removeOpencodePlugin).not.toHaveBeenCalled();
  });
});
