import path from 'path';
import { expect, it } from 'vitest';
import { checkRepo, formatResult, repoRoot } from '../../tests/name-guard';

// The Linux CI job runs only these host tests, so the guard runs here too.
// The full guard and its own tests are in tests/unit/name-guard.test.ts.
it('the tree says wmux only where tests/name-guard-allowlist.json says why (R26)', () => {
  expect(formatResult(checkRepo(repoRoot(path.resolve(__dirname, '..'))))).toBe('');
});
