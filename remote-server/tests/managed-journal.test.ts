import { it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Journal } from '../src/eridani-journal';
import { managedVersionSupported, hostModelCatalog } from '../src/managed-models';

it('retains durable operation IDs and digests after finalization and beyond the legacy replay horizon', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-journal-')); const file = path.join(dir, 'journal'); let now = 1;
  const journal = new Journal({ file, horizonMs: 10, now: () => now });
  try {
    journal.record('durable', { t: 'answer', digest: 'exact', state: 'accepted', durable: true });
    journal.record('durable', { t: 'answer', digest: 'exact', state: 'executed' });
    journal.record('legacy', { t: 'answer', digest: 'old', state: 'executed' });
    now = 100; journal.compact(); journal.close();
    const loaded = new Journal({ file, horizonMs: 10, now: () => now });
    try { expect(loaded.get('durable')).toMatchObject({ state: 'executed', digest: 'exact', durable: true }); expect(loaded.get('legacy')).toBeUndefined(); } finally { loaded.close(); }
  } finally { journal.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

it('advertises only verified Linux provider versions and actual model-specific effort levels', () => {
  expect(managedVersionSupported('codex', '0.166.0', 'linux')).toBe(true);
  expect(managedVersionSupported('claude', '2.1.317', 'linux')).toBe(true);
  expect(managedVersionSupported('claude', '2.1.1', 'linux')).toBe(false);
  expect(managedVersionSupported('claude', '2.1.318', 'linux', {})).toBe(true);
  expect(managedVersionSupported('claude', '2.1.319', 'linux', {})).toBe(false);
  expect(managedVersionSupported('claude', '2.1.311', 'linux', {})).toBe(false);
  expect(managedVersionSupported('claude', '2.2.0', 'linux', {})).toBe(false);
  // REMOTEA_MANAGED_CLAUDE_MAX raises the ceiling without a release; it never lowers the floor.
  expect(managedVersionSupported('claude', '2.1.321', 'linux', { REMOTEA_MANAGED_CLAUDE_MAX: '2.1.321' })).toBe(true);
  expect(managedVersionSupported('claude', '2.1.322', 'linux', { REMOTEA_MANAGED_CLAUDE_MAX: '321' })).toBe(false);
  expect(managedVersionSupported('claude', '2.1.311', 'linux', { REMOTEA_MANAGED_CLAUDE_MAX: '300' })).toBe(false);
  expect(managedVersionSupported('claude', '2.1.312', 'linux', { REMOTEA_MANAGED_CLAUDE_MAX: '300' })).toBe(true);
  expect(managedVersionSupported('claude', '2.1.319', 'linux', { REMOTEA_MANAGED_CLAUDE_MAX: 'latest' })).toBe(false);
  expect(managedVersionSupported('codex', '0.167.0', 'linux')).toBe(false);
  expect(managedVersionSupported('codex', '0.166.0', 'win32')).toBe(false);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-models-')); const file = path.join(dir, 'models.json');
  try {
    fs.writeFileSync(file, JSON.stringify({ models: [{ slug: 'model', display_name: 'Actual', default_reasoning_level: 'low', supported_reasoning_levels: ['low', 'ultra'].map((effort) => ({ effort })) }] }));
    expect(hostModelCatalog(file)).toMatchObject([{ model: 'model', default: false, efforts: ['low', 'ultra'], default_effort: 'low' }]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
