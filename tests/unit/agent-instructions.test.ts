import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import {
  CLI_BIN_PLACEHOLDER,
  getInstructionsPath,
  renderInstructions,
} from '../../src/main/agent-instructions';

/**
 * Issue #158: the probe the block hands its reader could not tell "wmux is not
 * running" from "this session cannot reach the wmux CLI", and the block told
 * the reader to assume the first.
 *
 * That is the common case, not the exotic one. wmux only puts `wmux` on PATH
 * for PTYs it spawns itself — nothing is persisted to the user's PATH — so
 * every session wmux did not spawn (a desktop app, a plain terminal, SSH, a
 * scheduled run) hits "command not found" while wmux is running perfectly well.
 * Those are precisely the sessions the block is written GLOBALLY to reach.
 */
describe('agent instruction block (issue #158)', () => {
  const raw = fs.readFileSync(getInstructionsPath(), 'utf-8');

  it('separates "not found" from "did not answer"', () => {
    // The old text collapsed three symptoms into one conclusion:
    //   "command not found, no reply, or an error → wmux is not running"
    expect(raw).not.toMatch(/command not found, no reply, or an error/);
    // No FIRST answer is evidence of absence: not found is the normal state
    // off a wmux pane (#158), and a bare `wmux` may be another app's CLI
    // (#282). Anything but `pong` goes to the absolute probe first.
    expect(raw).toMatch(/anything else[^]*do not\s+conclude yet/i);
  });

  it('gives the reader a second probe that does not depend on PATH', () => {
    expect(raw).toContain(CLI_BIN_PLACEHOLDER);
    // The fallback probe must be the placeholder plus the discovery verbs, so a
    // session off PATH has something concrete to run rather than advice.
    expect(raw).toMatch(new RegExp(`${CLI_BIN_PLACEHOLDER.replace(/[{}]/g, '\\$&')}/wmux" capabilities`));
  });

  it('substitutes the install path, leaving no placeholder behind', () => {
    const out = renderInstructions(raw, 'C:\\Program Files\\wmux\\resources\\cli-bin');
    expect(out).not.toContain(CLI_BIN_PLACEHOLDER);
    expect(out).toContain('C:\\Program Files\\wmux\\resources\\cli-bin/wmux" capabilities');
  });

  it('substitutes every occurrence, not just the first', () => {
    const doubled = `a ${CLI_BIN_PLACEHOLDER} b ${CLI_BIN_PLACEHOLDER} c`;
    expect(renderInstructions(doubled, '/x')).toBe('a /x b /x c');
  });

  it('is a plain substitution, so a $-bearing install path survives intact', () => {
    // String.replace treats $& / $1 in the REPLACEMENT specially. A Windows
    // path can contain '$' (a hidden share, an env-expanded dir), and mangling
    // the path here would hand the reader a probe that cannot work.
    const weird = 'C:\\Users\\a$&b\\cli-bin';
    expect(renderInstructions(CLI_BIN_PLACEHOLDER, weird)).toBe(weird);
  });

  it('uses capabilities rather than ping to select command families', () => {
    expect(raw).toContain('A successful `wmux ping`');
    expect(raw).toContain('does **not** establish any');
    expect(raw).toContain('Host status bridge (`features: ["status"]`)');
    expect(raw).toContain('Missing browser');
    expect(raw).toContain('support does not disable status reporting');
    expect(raw).toContain('`wmux agent-state` is a desktop query');
    expect(raw).toContain('Use your\nnormal tools');
    expect(raw).toContain('Nothing here is a\nrestriction on what you may otherwise do');
  });

  it('preserves packaged source mapping and managed markers', () => {
    const builder = JSON.parse(fs.readFileSync('electron-builder.json', 'utf8'));
    expect(builder.extraResources).toContainEqual(expect.objectContaining({
      from: 'resources/claude-instructions.md', to: 'claude-instructions/claude-instructions.md',
    }));
    expect(fs.readFileSync('resources/claude-instructions/claude-instructions.md', 'utf8')).toBe(raw);
    expect(raw).toContain('<!-- wmux:start');
    expect(raw).toContain('<!-- wmux:end -->');
  });
});
