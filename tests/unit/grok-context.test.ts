import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import {
  buildGrokHooks,
  claudeAgentsCompatOff,
  ensureGrokContext,
  ensureGrokHooks,
  getGrokHome,
  getGrokHooksPath,
  getGrokRulesPath,
  isRemoteaHooksFile,
  removeGrokContext,
  removeGrokHooks,
} from '../../src/main/grok-context';
import { applyRemoteaHooks, remoteaEventHookCommand } from '../../src/main/claude-context';

/**
 * Grok Build reads Claude Code's files by default, so what this suite pins is
 * the part that is Grok's own: a hooks file whose entries dedupe against the
 * Claude ones byte for byte, and a rules file that exists only when Grok would
 * otherwise miss the instructions. Temp HOME, as in the Kiro and pi suites.
 */
describe('grok context', () => {
  let tmp: string;
  let saved: Record<string, string | undefined>;
  const KEYS = ['USERPROFILE', 'HOME', 'GROK_HOME', 'GROK_CLAUDE_AGENTS_ENABLED'];

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-grok-'));
    saved = Object.fromEntries(KEYS.map(k => [k, process.env[k]]));
    process.env.USERPROFILE = tmp;
    process.env.HOME = tmp;
    delete process.env.GROK_HOME;
    delete process.env.GROK_CLAUDE_AGENTS_ENABLED;
    expect(os.homedir()).toBe(tmp);
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const grokHome = () => path.join(tmp, '.grok');
  const writeClaudeBlock = () => {
    fs.mkdirSync(path.join(tmp, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.claude', 'CLAUDE.md'), '<!-- remotea:start -->\nx\n<!-- remotea:end -->\n');
  };

  it('writes nothing on a machine that has never run Grok', () => {
    ensureGrokHooks();
    ensureGrokContext();
    expect(fs.existsSync(grokHome())).toBe(false);
  });

  it('hook entries match the Claude ones exactly, plus the Grok-only turn endings', () => {
    const script = 'C:/wmux/resources/cli/remotea-hook.js';
    const { hooks } = buildGrokHooks(script);
    // Grok dedupes on (event, command, matcher): any drift here runs every hook twice.
    for (const [event, entries] of Object.entries(applyRemoteaHooks({}, script).hooks)) {
      expect(hooks[event]).toEqual(entries);
    }
    expect(JSON.stringify(hooks.StopCancelled)).toContain(`"node \\"${script}\\" --event StopCancelled"`);
    expect(JSON.stringify(hooks.StopFailure)).toContain('--event StopFailure');
  });

  it('installs and removes the hooks file, and leaves a user file of the same name alone', () => {
    fs.mkdirSync(grokHome());
    ensureGrokHooks();
    const written = JSON.parse(fs.readFileSync(getGrokHooksPath(), 'utf-8'));
    expect(Object.keys(written.hooks)).toContain('StopCancelled');
    removeGrokHooks();
    expect(fs.existsSync(getGrokHooksPath())).toBe(false);

    fs.mkdirSync(path.dirname(getGrokHooksPath()), { recursive: true });
    fs.writeFileSync(getGrokHooksPath(), '{"hooks":{}}');
    ensureGrokHooks();
    removeGrokHooks();
    expect(fs.readFileSync(getGrokHooksPath(), 'utf-8')).toBe('{"hooks":{}}');
  });

  it('the shared command builder spells exactly what Claude Code has always been given', () => {
    // Extracted from applyRemoteaHooks so Grok's file carries the same bytes. A
    // change here rewrites every ~/.claude/settings.json on the next launch.
    expect(remoteaEventHookCommand('C:/wmux/resources/cli/remotea-hook.js', 'Stop'))
      .toBe('node "C:/wmux/resources/cli/remotea-hook.js" --event Stop');
    const { hooks } = applyRemoteaHooks({}, 'C:/w/remotea-hook.js');
    const flags = (event: string) => hooks[event].flatMap((g: any) => g.hooks.map((h: any) => h.async));
    for (const event of ['PreToolUse', 'PostToolUse', 'UserPromptSubmit']) {
      expect(flags(event).every((a: unknown) => a === true)).toBe(true);
    }
    for (const event of ['SessionStart', 'Stop', 'SessionEnd']) {
      expect(flags(event).every((a: unknown) => a === undefined)).toBe(true);
    }
  });

  it('owns a hooks file only when every handler in it is a remotea-hook command', () => {
    const ours = JSON.stringify(buildGrokHooks('C:/Program Files/wmux/resources/cli/remotea-hook.js'));
    expect(isRemoteaHooksFile(ours)).toBe(true);
    // Written by an install that has since moved: still ours, so it is refreshed.
    expect(isRemoteaHooksFile(JSON.stringify(buildGrokHooks('D:/old/remotea-hook.js')))).toBe(true);

    const remoteaCmd = { type: 'command', command: 'node "C:/x/remotea-hook.js" --event Stop' };
    const mixed = { hooks: { Stop: [{ hooks: [remoteaCmd, { type: 'command', command: 'bin/notify.sh' }] }] } };
    expect(isRemoteaHooksFile(JSON.stringify(mixed))).toBe(false);
    expect(isRemoteaHooksFile(JSON.stringify({ hooks: { Stop: [{ hooks: [remoteaCmd] }] }, note: 'mine' }))).toBe(false);
    expect(isRemoteaHooksFile(JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'http', url: 'https://x/remotea-hook.js' }] }] } }))).toBe(false);
    expect(isRemoteaHooksFile(JSON.stringify({ hooks: { Stop: 'node "remotea-hook.js" x' } }))).toBe(false);
    expect(isRemoteaHooksFile('{"hooks":{}}')).toBe(false);
    expect(isRemoteaHooksFile('// remotea-hook\n{')).toBe(false);
    expect(isRemoteaHooksFile('[]')).toBe(false);
  });

  it('never overwrites or deletes a hand-written remotea.json that also calls remotea-hook.js', () => {
    // The obvious name for a file someone writes to wire Grok into wmux by
    // hand. A substring test for "remotea-hook" called it wmux's and destroyed the
    // user's own hook beside it, on the next launch and again on toggle-off.
    fs.mkdirSync(path.dirname(getGrokHooksPath()), { recursive: true });
    const theirs = JSON.stringify({
      hooks: {
        Stop: [{ hooks: [
          { type: 'command', command: 'node "C:/wmux/resources/cli/remotea-hook.js" --event Stop' },
          { type: 'command', command: 'bin/ring-the-bell.sh' },
        ] }],
      },
    }, null, 2);
    fs.writeFileSync(getGrokHooksPath(), theirs);
    ensureGrokHooks();
    expect(fs.readFileSync(getGrokHooksPath(), 'utf-8')).toBe(theirs);
    removeGrokHooks();
    expect(fs.readFileSync(getGrokHooksPath(), 'utf-8')).toBe(theirs);
  });

  it('rewrites nothing when the hooks file is already current', () => {
    fs.mkdirSync(grokHome());
    ensureGrokHooks();
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(getGrokHooksPath(), past, past);
    ensureGrokHooks();
    expect(fs.statSync(getGrokHooksPath()).mtimeMs).toBe(past.getTime());
  });

  it('writes nothing, and does not throw, when ~/.grok is a file', () => {
    fs.writeFileSync(grokHome(), 'not a directory');
    expect(() => { ensureGrokHooks(); ensureGrokContext(); }).not.toThrow();
    expect(fs.readFileSync(grokHome(), 'utf-8')).toBe('not a directory');
  });

  it('ignores a relative GROK_HOME rather than resolving it against wmux\'s cwd', () => {
    process.env.GROK_HOME = 'grok-here';
    expect(getGrokHome()).toBe(grokHome());
    fs.mkdirSync(grokHome());
    ensureGrokHooks();
    expect(fs.existsSync(path.join(grokHome(), 'hooks', 'remotea.json'))).toBe(true);
    expect(fs.existsSync(path.resolve('grok-here'))).toBe(false);
  });

  it('removal also sweeps the default home, where wmux wrote before GROK_HOME was set', () => {
    fs.mkdirSync(grokHome());
    ensureGrokHooks();
    ensureGrokContext();
    const stale = [path.join(grokHome(), 'hooks', 'remotea.json'), path.join(grokHome(), 'rules', 'remotea.md')];
    for (const f of stale) expect(fs.existsSync(f)).toBe(true);

    const custom = path.join(tmp, 'elsewhere');
    fs.mkdirSync(custom);
    process.env.GROK_HOME = custom;
    ensureGrokHooks();
    removeGrokHooks();
    removeGrokContext();
    expect(fs.existsSync(path.join(custom, 'hooks', 'remotea.json'))).toBe(false);
    for (const f of stale) expect(fs.existsSync(f)).toBe(false);
  });

  it('honours GROK_HOME', () => {
    const custom = path.join(tmp, 'elsewhere');
    fs.mkdirSync(custom);
    process.env.GROK_HOME = custom;
    ensureGrokHooks();
    expect(fs.existsSync(path.join(custom, 'hooks', 'remotea.json'))).toBe(true);
  });

  it('skips the rules file while Grok reads the CLAUDE.md block, and removes a stale one', () => {
    fs.mkdirSync(grokHome());
    ensureGrokContext(); // no CLAUDE.md block yet: Grok would miss the instructions
    expect(fs.readFileSync(getGrokRulesPath(), 'utf-8')).toContain('<!-- remotea:start');

    writeClaudeBlock();
    ensureGrokContext();
    expect(fs.existsSync(getGrokRulesPath())).toBe(false);
  });

  it('writes the rules file when Claude compat is switched off', () => {
    fs.mkdirSync(grokHome());
    writeClaudeBlock();
    fs.writeFileSync(path.join(grokHome(), 'config.toml'), '[compat.claude]\nagents = false\n');
    ensureGrokContext();
    expect(fs.existsSync(getGrokRulesPath())).toBe(true);

    // env beats config.toml, as it does in Grok
    process.env.GROK_CLAUDE_AGENTS_ENABLED = 'true';
    ensureGrokContext();
    expect(fs.existsSync(getGrokRulesPath())).toBe(false);

    process.env.GROK_CLAUDE_AGENTS_ENABLED = '0';
    ensureGrokContext();
    removeGrokContext();
    expect(fs.existsSync(getGrokRulesPath())).toBe(false);
  });

  it('reads compat.claude.agents in each TOML spelling', () => {
    expect(claudeAgentsCompatOff('[compat.claude]\nagents = false')).toBe(true);
    expect(claudeAgentsCompatOff('[compat]\nclaude.agents = false # off')).toBe(true);
    expect(claudeAgentsCompatOff('compat.claude.agents = false\n[model]\nx = 1')).toBe(true);
    expect(claudeAgentsCompatOff('[ "compat" . "claude" ]\n"agents" = false')).toBe(true);
    expect(claudeAgentsCompatOff('[compat.claude]\nagents = true')).toBe(false);
    expect(claudeAgentsCompatOff('[compat.claude]\nhooks = false')).toBe(false);
    expect(claudeAgentsCompatOff('[compat.cursor]\nagents = false')).toBe(false);
    expect(claudeAgentsCompatOff('# [compat.claude]\n# agents = false')).toBe(false);
    expect(claudeAgentsCompatOff('')).toBe(false);
  });
});
