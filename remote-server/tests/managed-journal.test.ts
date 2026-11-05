import { it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Journal } from '../src/eridani-journal';
import { hostModelCatalog } from '../src/managed-models';
import { precheck } from '../src/launcher-conformance';

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

it('admits nothing below the floor or off Linux without a probe, and reads actual model-specific effort levels', () => {
  // Above the floor nothing is decided without a conformance probe (launcher-conformance.test.ts).
  expect(precheck('codex', '0.166.0', {}, 'linux')).toBeNull();
  expect(precheck('claude', '2.1.319', {}, 'linux')).toBeNull();
  expect(precheck('claude', '2.2.0', {}, 'linux')).toBeNull();
  expect(precheck('claude', '2.1.311', {}, 'linux')).toMatchObject({ managed: false, conformance: 'below_floor' });
  expect(precheck('claude', '2.1.1', {}, 'linux')).toMatchObject({ managed: false, conformance: 'below_floor' });
  expect(precheck('codex', '0.165.9', {}, 'linux')).toMatchObject({ managed: false, conformance: 'below_floor' });
  expect(precheck('codex', '0.166.0', {}, 'win32')).toMatchObject({ managed: false, conformance: 'unsupported' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-models-')); const file = path.join(dir, 'models.json');
  try {
    fs.writeFileSync(file, JSON.stringify({ models: [{ slug: 'model', display_name: 'Actual', default_reasoning_level: 'low', supported_reasoning_levels: ['low', 'ultra'].map((effort) => ({ effort })) }] }));
    expect(hostModelCatalog(file)).toMatchObject([{ model: 'model', default: false, efforts: ['low', 'ultra'], default_effort: 'low' }]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
