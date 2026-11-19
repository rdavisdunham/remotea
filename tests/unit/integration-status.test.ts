import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readIntegrationStatus } from '../../src/main/integration-status';
import { applyConsent } from '../../src/main/agent-integration';
import { clearIntegrationFailures, integrationFailures, reportIntegrationFailure } from '../../src/main/integration-failures';
import { ensureKiroContext } from '../../src/main/kiro-context';
import { readRenderedInstructions } from '../../src/main/agent-instructions';
import { applyRemoteaHooks, getHookScriptPath } from '../../src/main/claude-context';

let home: string;
const envKeys = ['HOME', 'USERPROFILE', 'PI_CODING_AGENT_DIR', 'PI_CONFIG_DIR', 'QWEN_HOME', 'GROK_HOME'] as const;
let saved: Partial<Record<typeof envKeys[number], string | undefined>>;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'remotea-integration-status-'));
  saved = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  for (const key of envKeys) delete process.env[key];
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  expect(os.homedir()).toBe(home);
  clearIntegrationFailures();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  for (const key of envKeys) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
});

function write(relative: string, content: string) {
  const destination = path.join(home, relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, content);
}

function observation(provider: string, feature: string) {
  return readIntegrationStatus().files.find(file => file.provider === provider && file.feature === feature)!;
}

describe('read-only desktop integration observations', () => {
  it('reports missing files without creating directories or implying runtime readiness', () => {
    const status = readIntegrationStatus();
    expect(status.environment).toBe('desktop-user');
    expect(status.runtime).toBe('not-probed');
    expect(new Set(status.files.map(file => file.provider)).size).toBe(8);
    expect(status.files.every(file => file.state === 'missing')).toBe(true);
    expect(fs.readdirSync(home)).toEqual([]);
  });

  it('observes installed files from the existing installers without returning content or credentials', () => {
    for (const directory of ['.grok', '.qwen', '.gemini/antigravity-cli']) fs.mkdirSync(path.join(home, directory), { recursive: true });
    write('.claude/settings.json', '{}');
    write('.claude.json', JSON.stringify({ oauth: { token: 'PRIVATE_CREDENTIAL' } }));
    applyConsent({ decision: 'granted', features: {
      instructions: true, hooks: true, orchestrator: true, browserMcp: true,
    } });
    const status = readIntegrationStatus();
    expect(status.files.filter(file => file.state !== 'present')).toEqual([]);
    expect(JSON.stringify(status)).not.toContain('PRIVATE_CREDENTIAL');
    expect(JSON.stringify(status)).not.toContain(readRenderedInstructions()!.trim());
    expect(status.failures).toEqual([]);
  });

  it('distinguishes managed blocks, user text and modified content without rewriting anything', () => {
    const instructions = readRenderedInstructions()!;
    write('.claude/CLAUDE.md', `User notes\n${instructions}\nPrivate notes`);
    expect(observation('Claude Code', 'instructions').state).toBe('present');
    write('.claude/CLAUDE.md', instructions.replace('# remotea', '# custom-remotea'));
    expect(observation('Claude Code', 'instructions').state).toBe('modified');
    write('.claude/CLAUDE.md', 'Only user-owned notes');
    expect(observation('Claude Code', 'instructions').state).toBe('missing');
    expect(fs.readFileSync(path.join(home, '.claude/CLAUDE.md'), 'utf8')).toBe('Only user-owned notes');
  });

  it('detects partial hooks and invalid JSON while preserving user credentials', () => {
    const configured = applyRemoteaHooks({ secret: 'PRIVATE_CREDENTIAL' }, getHookScriptPath());
    write('.claude/settings.json', JSON.stringify(configured));
    expect(observation('Claude Code', 'hooks').state).toBe('present');
    delete configured.hooks.Stop;
    write('.claude/settings.json', JSON.stringify(configured));
    expect(observation('Claude Code', 'hooks').state).toBe('modified');
    write('.claude/settings.json', '{invalid PRIVATE_CREDENTIAL');
    expect(observation('Claude Code', 'hooks')).toMatchObject({ state: 'error', code: 'INVALID_JSON' });
    expect(JSON.stringify(readIntegrationStatus())).not.toContain('PRIVATE_CREDENTIAL');
  });

  it('reports actual filesystem failures from existing writers and clears them on a new apply', () => {
    const blocked = path.join(home, '.kiro/steering/remotea.md');
    fs.mkdirSync(blocked, { recursive: true });
    ensureKiroContext();
    expect(integrationFailures()).toEqual([{ provider: 'Kiro', operation: 'write', code: 'EISDIR' }]);
    expect(observation('Kiro', 'instructions')).toMatchObject({ state: 'error', code: 'EISDIR' });
    fs.rmdirSync(blocked);
    applyConsent({ decision: 'granted', features: {
      instructions: true, hooks: false, orchestrator: false, browserMcp: false,
    } });
    expect(observation('Kiro', 'instructions').state).toBe('present');
    expect(integrationFailures()).toEqual([]);
  });

  it('honors desktop environment overrides without probing agent executables', () => {
    process.env.QWEN_HOME = path.join(home, 'custom-qwen');
    process.env.PI_CODING_AGENT_DIR = path.join(home, 'custom-pi');
    const status = readIntegrationStatus();
    expect(status.files.find(file => file.provider === 'Qwen Code')?.path).toContain('custom-qwen');
    expect(status.files.find(file => file.provider === 'pi')?.path).toContain('custom-pi');
    expect(status.files.find(file => file.provider === 'omp')?.path).toContain('custom-pi');
    expect(fs.readdirSync(home)).toEqual([]);
    reportIntegrationFailure('Kiro', 'write', { code: 'EACCES', message: 'PRIVATE_CREDENTIAL' });
    expect(JSON.stringify(readIntegrationStatus())).not.toContain('PRIVATE_CREDENTIAL');
  });
});
