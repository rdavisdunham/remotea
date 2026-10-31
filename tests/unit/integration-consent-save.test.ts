import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { updateConsent } from '../../src/main/agent-integration';
import { saveSetting } from '../../src/main/settings-store';

vi.mock('../../src/main/settings-store', () => ({
  loadSettings: () => ({}),
  saveSetting: vi.fn(() => false),
}));

let home: string;
const environmentKeys = ['HOME', 'USERPROFILE', 'PI_CODING_AGENT_DIR', 'PI_CONFIG_DIR', 'QWEN_HOME', 'GROK_HOME'];
let previous: Array<string | undefined>;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'remotea-consent-save-'));
  previous = environmentKeys.map(key => process.env[key]);
  for (const key of environmentKeys) delete process.env[key];
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  expect(os.homedir()).toBe(home);
});
afterEach(() => {
  environmentKeys.forEach((key, index) => {
    if (previous[index] === undefined) delete process.env[key];
    else process.env[key] = previous[index];
  });
  fs.rmSync(home, { recursive: true, force: true });
});

it('rejects an integration change when persisting consent fails, before applying home-file writes', () => {
  expect(() => updateConsent({ decision: 'granted' })).toThrow('could not be saved');
  expect(fs.readdirSync(home)).toEqual([]);
  expect(saveSetting).toHaveBeenCalledWith('agentIntegration', expect.objectContaining({ decision: 'granted' }));
});
