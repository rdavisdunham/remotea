import { describe, it, expect } from 'vitest';
import {
  countLegacyHookEntries,
  isLegacyRemoteaBlockFile,
  isLegacyRemoteaCommand,
  isLegacyRemoteaGrokHooksFile,
  isLegacyRemoteaQwenStub,
  stripLegacyBlocks,
  stripLegacyHookEntries,
} from '../../src/shared/legacy-cleanup';
import type { OwnershipContext } from '../../src/shared/artifact-ownership';

const OUR_CLI = 'C:/Users/x/AppData/Local/Programs/remotea/resources/cli';
const OUR_BIN = 'C:/Users/x/AppData/Local/Programs/remotea/resources/cli-bin';
const WMUX_CLI = 'C:/Users/x/AppData/Local/Programs/wmux/resources/cli';
const WMUX_BIN = 'C:/Users/x/AppData/Local/Programs/wmux/resources/cli-bin';

function ctx(files: Record<string, string> = {}): OwnershipContext {
  return { knownDirs: [OUR_CLI, OUR_BIN], readFile: (p) => files[p] ?? null };
}

const entry = (cli: string, event: string) => ({ hooks: [{ type: 'command', command: `node "${cli}/wmux-hook.js" --event ${event}` }] });
const userEntry = { hooks: [{ type: 'command', command: 'echo mine' }] };

describe('isLegacyRemoteaCommand', () => {
  it('takes this install\'s old helper', () => {
    expect(isLegacyRemoteaCommand(`node "${OUR_CLI}/wmux-hook.js" Bash`, ctx())).toBe(true);
  });
  it('never takes a wmux install\'s helper', () => {
    expect(isLegacyRemoteaCommand(`node "${WMUX_CLI}/wmux-hook.js" Bash`, ctx())).toBe(false);
  });
  it('never takes a new-named command', () => {
    expect(isLegacyRemoteaCommand(`node "${OUR_CLI}/remotea-hook.js" Bash`, ctx())).toBe(false);
  });
  it('takes a Qwen stub that requires this install\'s helper', () => {
    const stub = 'C:/Users/x/.qwen/wmux-qwen-hook.cjs';
    const files = { [stub]: `// wmux-qwen-hook: written by wmux.\nrequire(${JSON.stringify(`${OUR_CLI}/wmux-hook.js`)});\n` };
    expect(isLegacyRemoteaCommand(`node ${stub} --event Stop --provider qwen`, ctx(files))).toBe(true);
    expect(isLegacyRemoteaQwenStub(files[stub], ctx())).toBe(true);
  });
  it('does not take a Qwen stub that requires a wmux helper', () => {
    const stub = 'C:/Users/x/.qwen/wmux-qwen-hook.cjs';
    const files = { [stub]: `require(${JSON.stringify(`${WMUX_CLI}/wmux-hook.js`)});\n` };
    expect(isLegacyRemoteaCommand(`node ${stub} --event Stop --provider qwen`, ctx(files))).toBe(false);
    expect(isLegacyRemoteaQwenStub(files[stub], ctx())).toBe(false);
  });
});

describe('stripLegacyHookEntries', () => {
  it('removes only this install\'s old entries and keeps a wmux install\'s byte-identical', () => {
    const settings = {
      model: 'opus',
      hooks: {
        Stop: [entry(OUR_CLI, 'Stop'), entry(WMUX_CLI, 'Stop'), userEntry],
        SessionEnd: [entry(OUR_CLI, 'SessionEnd')],
      },
    };
    const before = JSON.stringify(settings.hooks.Stop[1]);
    const next = stripLegacyHookEntries(settings, ctx());
    expect(next.hooks.Stop).toHaveLength(2);
    expect(JSON.stringify(next.hooks.Stop[0])).toBe(before);
    expect(next.hooks.Stop[1]).toEqual(userEntry);
    expect('SessionEnd' in next.hooks).toBe(false);
    expect(next.model).toBe('opus');
  });

  it('returns the same object when nothing is ours', () => {
    const settings = { hooks: { Stop: [entry(WMUX_CLI, 'Stop')] } };
    expect(stripLegacyHookEntries(settings, ctx())).toBe(settings);
  });

  it('drops an emptied hooks object', () => {
    expect(stripLegacyHookEntries({ a: 1, hooks: { Stop: [entry(OUR_CLI, 'Stop')] } }, ctx())).toEqual({ a: 1 });
  });

  it('counts what it would remove', () => {
    expect(countLegacyHookEntries({ hooks: { Stop: [entry(OUR_CLI, 'Stop'), entry(WMUX_CLI, 'Stop')] } }, ctx())).toBe(1);
  });
});

describe('stripLegacyBlocks', () => {
  const block = (bin: string) =>
    `<!-- wmux:start — AUTO-MANAGED BY wmux. -->\n"${bin}/wmux" identify\n<!-- wmux:end -->`;

  it('removes this install\'s old block and keeps the user\'s text', () => {
    const out = stripLegacyBlocks(`# Mine\n\n${block(OUR_BIN)}\n\nmore of mine\n`, ctx());
    expect(out).not.toContain('wmux:start');
    expect(out).toContain('# Mine');
    expect(out).toContain('more of mine');
  });

  it('keeps a wmux install\'s block untouched', () => {
    const text = `# Mine\n\n${block(WMUX_BIN)}\n`;
    expect(stripLegacyBlocks(text, ctx())).toBe(text);
  });

  it('removes ours and keeps theirs when both are present', () => {
    const out = stripLegacyBlocks(`${block(OUR_BIN)}\n\n${block(WMUX_BIN)}\n`, ctx());
    expect(out.match(/wmux:start/g)).toHaveLength(1);
    expect(out).toContain(WMUX_BIN);
  });

  it('leaves an unterminated old block alone', () => {
    const text = '<!-- wmux:start\nno end\n';
    expect(stripLegacyBlocks(text, ctx())).toBe(text);
  });
});

describe('old whole files', () => {
  it('takes a steering or rules file holding only this install\'s block', () => {
    expect(isLegacyRemoteaBlockFile(`<!-- wmux:start -->\n"${OUR_BIN}/wmux" identify\n<!-- wmux:end -->\n`, ctx())).toBe(true);
    expect(isLegacyRemoteaBlockFile(`<!-- wmux:start -->\n"${WMUX_BIN}/wmux" identify\n<!-- wmux:end -->\n`, ctx())).toBe(false);
    expect(isLegacyRemoteaBlockFile('my own rules\n', ctx())).toBe(false);
  });

  it('takes a Grok hooks file only when every handler is this install\'s', () => {
    const ours = { hooks: { Stop: [entry(OUR_CLI, 'Stop')], SessionEnd: [entry(OUR_CLI, 'SessionEnd')] } };
    expect(isLegacyRemoteaGrokHooksFile(JSON.stringify(ours), ctx())).toBe(true);
    const mixed = { hooks: { Stop: [entry(OUR_CLI, 'Stop'), userEntry] } };
    expect(isLegacyRemoteaGrokHooksFile(JSON.stringify(mixed), ctx())).toBe(false);
    const extraKey = { ...ours, note: 'mine' };
    expect(isLegacyRemoteaGrokHooksFile(JSON.stringify(extraKey), ctx())).toBe(false);
    expect(isLegacyRemoteaGrokHooksFile('{ not json', ctx())).toBe(false);
  });
});
