import { makeT, LANGUAGES } from '../../src/renderer/i18n/core';
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import {
  applyRemoteaHooks,
  buildChromeDevtoolsMcpServer,
  CHROME_DEVTOOLS_MCP_PACKAGE,
  isRemoteaAuthoredMcpEntry,
  removeRemoteaHooks,
  stripRemoteaBlock,
} from '../../src/main/claude-context';
import {
  parseConsent,
  INTEGRATION_CONSENT_DETAIL,
  INTEGRATION_FEATURES,
} from '../../src/main/agent-integration';

const HOOK = '/res/cli/remotea-hook.js';

// Issue #132: remotea wrote into ~/.claude on every launch with no prompt and no
// record of a decision, so deleting any of it was futile — the next launch put
// it straight back. These cover the two halves of the fix: an inverse for every
// write, and a consent record that fails toward asking rather than assuming.

describe('removeRemoteaHooks (issue #132)', () => {
  it('takes back exactly what applyRemoteaHooks installed', () => {
    const restored = removeRemoteaHooks(applyRemoteaHooks({}, HOOK));
    // Not merely "no remotea entries" — an empty `hooks: {}` left behind is still a
    // footprint in a file remotea was asked to stay out of.
    expect(restored.hooks).toBeUndefined();
  });

  it('leaves the user\'s own hooks in place', () => {
    const userHook = { matcher: 'Bash', hooks: [{ type: 'command', command: 'my-audit.sh' }] };
    const withBoth = applyRemoteaHooks({ hooks: { PostToolUse: [userHook] } }, HOOK);
    const restored = removeRemoteaHooks(withBoth);
    expect(restored.hooks.PostToolUse).toEqual([userHook]);
  });

  it('keeps every other setting untouched', () => {
    const settings = applyRemoteaHooks({ model: 'opus', env: { FOO: '1' } }, HOOK);
    const restored = removeRemoteaHooks(settings);
    expect(restored.model).toBe('opus');
    expect(restored.env).toEqual({ FOO: '1' });
  });

  it('is a no-op on settings that never had remotea hooks', () => {
    const settings = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'mine.sh' }] }] } };
    expect(removeRemoteaHooks(settings)).toEqual(settings);
  });

  it('survives settings with no hooks key at all', () => {
    expect(removeRemoteaHooks({ model: 'opus' })).toEqual({ model: 'opus' });
    expect(removeRemoteaHooks({})).toEqual({});
  });

  it('does not mutate the settings it was given', () => {
    const settings = applyRemoteaHooks({}, HOOK);
    const before = JSON.stringify(settings);
    removeRemoteaHooks(settings);
    expect(JSON.stringify(settings)).toBe(before);
  });

  it('is idempotent — a second launch after declining rewrites nothing', () => {
    const once = removeRemoteaHooks(applyRemoteaHooks({}, HOOK));
    expect(removeRemoteaHooks(once)).toEqual(once);
  });
});

describe('stripRemoteaBlock (issue #132)', () => {
  const BLOCK = '<!-- remotea:start -->\ninstructions here\n<!-- remotea:end -->';

  it('reports nothing to do when the document has no remotea block', () => {
    // null, not '' — the caller skips the write entirely rather than rewriting
    // a file it did not change.
    expect(stripRemoteaBlock('# My notes\n')).toBeNull();
  });

  it('empties a document that was nothing but the remotea block', () => {
    // '' is the signal to delete the file: remotea created it, so leaving an empty
    // CLAUDE.md behind is still a file the user never asked for.
    expect(stripRemoteaBlock(BLOCK)).toBe('');
  });

  it('keeps the user text that surrounded the block', () => {
    const out = stripRemoteaBlock(`# Mine\n\n${BLOCK}\n\n## Also mine\n`);
    expect(out).toContain('# Mine');
    expect(out).toContain('## Also mine');
    expect(out).not.toContain('remotea:start');
    expect(out).not.toContain('instructions here');
  });

  it('does not leave a growing gap where the block was', () => {
    const out = stripRemoteaBlock(`# Mine\n\n${BLOCK}\n\n## Also mine\n`);
    expect(out).toBe('# Mine\n\n## Also mine\n');
  });

  it('removes a block whose end marker was lost to a hand-edit', () => {
    // Matches how ensureClaudeContext repairs the same damage: an unterminated
    // block is taken to run to end-of-file.
    expect(stripRemoteaBlock('# Mine\n\n<!-- remotea:start -->\ndangling\n')).toBe('# Mine\n');
  });

  it('is idempotent', () => {
    const once = stripRemoteaBlock(`# Mine\n\n${BLOCK}\n`)!;
    expect(stripRemoteaBlock(once)).toBeNull();
  });
});

describe('parseConsent (issue #132)', () => {
  it('treats a missing record as unset, so the user is asked', () => {
    expect(parseConsent(undefined).decision).toBe('unset');
    expect(parseConsent(null).decision).toBe('unset');
  });

  it('falls back to asking — never to granting — on a corrupt record', () => {
    // The whole complaint in #132 is remotea writing without being asked. A
    // settings file that fails to parse must not become a silent yes.
    expect(parseConsent('garbage').decision).toBe('unset');
    expect(parseConsent({ decision: 'yes-please' }).decision).toBe('unset');
    expect(parseConsent(42).decision).toBe('unset');
  });

  it('round-trips a real decision', () => {
    expect(parseConsent({ decision: 'granted' }).decision).toBe('granted');
    expect(parseConsent({ decision: 'declined' }).decision).toBe('declined');
  });

  it('honours an explicitly disabled feature', () => {
    const c = parseConsent({ decision: 'granted', features: { hooks: false } });
    expect(c.features.hooks).toBe(false);
    expect(c.features.instructions).toBe(true);
  });

  it('defaults a feature added by a later version to on, not off', () => {
    // An older record simply lacks the key. Defaulting it to off would silently
    // withhold a feature the user granted wholesale.
    const c = parseConsent({ decision: 'granted', features: {} });
    for (const f of INTEGRATION_FEATURES) expect(c.features[f]).toBe(true);
  });

  it('ignores a non-boolean feature value rather than trusting it', () => {
    const c = parseConsent({ decision: 'granted', features: { hooks: 'nope' } });
    expect(c.features.hooks).toBe(true);
  });
});

describe('safe agent integration defaults', () => {
  it('pins chrome-devtools-mcp to an exact version', () => {
    expect(CHROME_DEVTOOLS_MCP_PACKAGE).toMatch(/^chrome-devtools-mcp@\d+\.\d+\.\d+$/);
    expect(CHROME_DEVTOOLS_MCP_PACKAGE).not.toContain('@latest');
    expect(buildChromeDevtoolsMcpServer()).toEqual({
      command: 'npx',
      args: ['-y', CHROME_DEVTOOLS_MCP_PACKAGE, '--browserUrl=http://127.0.0.1:9222'],
    });
  });

  // The pin is a migration: existing installs carry `@latest` and have to be
  // moved off it. What must NOT happen is the write path rewriting an entry the
  // user retuned — uninstall already takes care to leave those alone
  // (removeChromeDevtoolsConfig), and a plain "is this what I want" inequality
  // would clobber them on every single launch. That is the issue #132 mistake.
  it('recognises its own MCP entry across pins, so @latest can be migrated', () => {
    expect(isRemoteaAuthoredMcpEntry(buildChromeDevtoolsMcpServer())).toBe(true);
    expect(isRemoteaAuthoredMcpEntry({
      command: 'npx',
      args: ['-y', 'chrome-devtools-mcp@latest', '--browserUrl=http://127.0.0.1:9222'],
    })).toBe(true);
  });

  it("leaves an entry it did not write alone", () => {
    // A different port is the clearest "this is mine, not yours" signal: remotea
    // only ever aims at its own proxy.
    expect(isRemoteaAuthoredMcpEntry({
      command: 'npx',
      args: ['-y', 'chrome-devtools-mcp@1.7.0', '--browserUrl=http://127.0.0.1:9333'],
    })).toBe(false);
    // A global install rather than npx.
    expect(isRemoteaAuthoredMcpEntry({
      command: 'chrome-devtools-mcp',
      args: ['--browserUrl=http://127.0.0.1:9222'],
    })).toBe(false);
    // Something else entirely under the same key.
    expect(isRemoteaAuthoredMcpEntry({ command: 'node', args: ['./my-server.js'] })).toBe(false);
    for (const junk of [null, undefined, 'npx', 42, {}, { command: 'npx' }]) {
      expect(isRemoteaAuthoredMcpEntry(junk)).toBe(false);
    }
  });

  it('discloses every hook family and modified plugin path', () => {
    for (const event of [
      'PostToolUse', 'Notification', 'Stop', 'SubagentStop',
      'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'SessionEnd',
    ]) {
      expect(INTEGRATION_CONSENT_DETAIL).toContain(event);
    }
    expect(INTEGRATION_CONSENT_DETAIL).toContain('~/.config/opencode/plugin/remotea.js');
    expect(INTEGRATION_CONSENT_DETAIL).toContain('pinned chrome-devtools-mcp');
  });

  it('discloses the Grok files in the dialog AND beside the toggles that write them (#259)', () => {
    // The Settings path hint is the only place a user can see what a checkbox
    // touches after the first-launch dialog is gone. Grok's two files were in
    // the dialog and missing from the panel.
    const panel = fs.readFileSync(
      path.resolve(__dirname, '../../src/renderer/components/Settings/AgentIntegrationSettings.tsx'), 'utf-8',
    );
    for (const written of ['~/.grok/rules/remotea.md', '~/.grok/hooks/remotea.json']) {
      expect(INTEGRATION_CONSENT_DETAIL).toContain(written);
      expect(panel).toContain(written);
    }
  });

  it('discloses all providers and computer scope in every effective locale', () => {
    for (const { code } of LANGUAGES) {
      const t = makeT(code);
      expect(t('settings.integration.enable')).toContain('this computer');
      const detail = t('settings.integration.hint');
      for (const agent of ['Claude Code', 'OpenCode', 'Kiro', 'omp', 'pi', 'Grok', 'Qwen', 'Antigravity']) {
        expect(detail, `${code} should disclose ${agent}`).toContain(agent);
      }
      expect(detail).toContain('Eridani MCP');
      expect(detail).toContain('not a live readiness test');
    }
  });
});
