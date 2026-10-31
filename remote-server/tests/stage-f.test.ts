/**
 * Stage F (security fixes from the 2026-10-28 audit): the pieces that are
 * pure or local enough to pin without a hub. Dispatch fences (M6/M7) live in
 * dispatch.test.ts, inbound frame checks (L11, digest, epoch) in
 * eridani-link.test.ts, the hooks file mode (L12) in hook-bridge.test.ts.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { commandShapeError, isPasteSafe } from '../../src/shared/eridani-link-protocol';
import { SECRET_PATTERNS, redact } from '../src/collector/redact';
import { ContextService, UNBOUND_CHARS } from '../src/context';
import { linkUrlError } from '../src/config';
import { runVerify, verifyEnv } from '../src/verify-runner';
import { WorktreeManager } from '../src/worktrees';
import { targetError, type ExecutionTarget, type VerifySpec } from '../src/eridani-targets';
import { redactItem } from '../src/questions-claude';
import type { SessionRecord } from '../../src/shared/remote-host-protocol';

const cleanups: Array<() => unknown> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function tmp(prefix: string): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  cleanups.push(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

describe('M6: input text is a paste, never keystrokes', () => {
  const input = (text: string) => commandShapeError({ t: 'input', op_id: 'o', digest: 'd', surf: 's', incarnation: 1, run_id: 'r', generation: 1, mode: 'queue', text, expires_at: Date.now() + 1000 });

  it('refuses the nested bracketed-paste marker, Shift+Tab, CR, C1 CSI and other controls', () => {
    expect(input('hello\x1b[20\x1b[201~1~\r!touch /tmp/pwned\r')).toMatch(/control characters/);
    expect(input('please \x1b[Z')).toMatch(/control characters/);
    expect(input('line\rnext')).toMatch(/control characters/);
    expect(input('csi \x9b201~')).toMatch(/control characters/);
    expect(input('ctrl-c \x03')).toMatch(/control characters/);
    expect(input('nul \x00')).toMatch(/control characters/);
    expect(input('del \x7f')).toMatch(/control characters/);
  });

  it('accepts newlines and tabs, and refuses a leading slash command or shell escape', () => {
    expect(input('first\n\tsecond')).toBeNull();
    expect(input('use a/b paths and a ! in the middle')).toBeNull();
    expect(input('/clear')).toMatch(/may not start/);
    expect(input('  !rm -rf ~')).toMatch(/may not start/);
    expect(isPasteSafe('ok\n\t')).toBe(true);
    expect(isPasteSafe('\u0085')).toBe(false);
  });
});

describe('L6: redaction', () => {
  // The canonical vectors; docs/remotea/redaction.md lists the same ones for the Python side.
  const VECTORS: Array<[string, string]> = [
    ['auth eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U ok', 'auth [redacted] ok'],
    ['-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nabc\n-----END RSA PRIVATE KEY-----\nafter', '[redacted]\nafter'],
    ['-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk\ntruncat', '[redacted]'],
    ['-----BEGIN PRIVATE KEY-----\nAAA\n-----END PRIVATE KEY-----', '[redacted]'],
    ['postgres://app:s3cr3t-pw@db.internal:5432/x', 'postgres[redacted]db.internal:5432/x'],
    ['https://host:8443/path@x', 'https://host:8443/path@x'],
    ['PASSWORD=hunter2hunter2 next', '[redacted] next'],
    ['api_key: "abcd1234efgh"', '[redacted]'],
    ['Secret = 12345678', '[redacted]'],
    ['token=short', 'token=short'],
    ['max_tokens: 4096', 'max_tokens: 4096'],
    ['key sk-ant-' + 'a'.repeat(25), 'key [redacted]'],
  ];

  it('redacts every vector exactly as the shared list says', () => {
    for (const [input, out] of VECTORS) expect(redact(input), JSON.stringify(input)).toBe(out);
  });

  it('the pattern list is the one in docs/remotea/redaction.md', () => {
    const doc = fs.readFileSync(path.join(__dirname, '../../docs/remotea/redaction.md'), 'utf8');
    const listed = doc.split('```text\n')[1].split('\n```')[0].split('\n');
    expect(listed).toEqual([...SECRET_PATTERNS]);
    for (const [input, out] of VECTORS) expect(doc).toContain(`| ${JSON.stringify(input).replace(/\|/g, '\\|')} | ${JSON.stringify(out).replace(/\|/g, '\\|')} |`);
  });

  it('question items leave the machine redacted', () => {
    const it0 = redactItem({ id: 'q1', text: 'use token=abcdefgh123?', header: 'Bearer ' + 'x'.repeat(24), choices: [{ id: 'c1', label: 'password: correcthorse', description: 'eri_bot_' + 'z'.repeat(22) }] });
    expect(it0).toEqual({ id: 'q1', text: 'use [redacted]', header: '[redacted]', choices: [{ id: 'c1', label: '[redacted]', description: '[redacted]' }] });
  });
});

describe('D6: SessionStart context for unbound sessions', () => {
  const BOUND = { id: 'surf-b', incarnation: 1, cwd: '/w', eridani: { runId: 'run-1', generation: 1, taskId: null } } as unknown as SessionRecord;
  const FREE = { id: 'surf-f', incarnation: 1, cwd: '/w' } as unknown as SessionRecord;
  const svc = (answer: Record<string, unknown> | null, scoped: boolean) => new ContextService({
    session: (id) => (id === 'surf-b' ? BOUND : id === 'surf-f' ? FREE : undefined),
    enabled: () => true,
    request: async () => answer,
    scoped: () => scoped,
  });

  it('an unbound session gets only candidate text, bounded; run text is dropped', async () => {
    const long = 'candidate '.repeat(1000);
    const out = await svc({ text: long, scope: 'candidates' }, true).sessionStart('surf-f', { sessionId: 's' });
    expect(out.length).toBeLessThanOrEqual(UNBOUND_CHARS + 1);
    expect(out).toContain('candidate');
    expect(out).not.toContain('Execution location:');
    const short = await svc({ text: 'CANDIDATE TASK', scope: 'candidates' }, true).sessionStart('surf-f', { sessionId: 's' });
    expect(short).toBe('CANDIDATE TASK\n');
    expect(await svc({ text: 'FULL RUN CONTEXT', scope: 'run', run_token: 't' }, true).sessionStart('surf-f', { sessionId: 's' })).not.toContain('FULL RUN CONTEXT');
    expect(await svc({ text: 'FULL RUN CONTEXT', scope: 'run', run_token: 'tok' }, true).sessionStart('surf-f', { sessionId: 's' })).not.toContain('tok');
    // A scoping Eridani that sent no scope: dropped.
    expect(await svc({ text: 'UNSCOPED' }, true).sessionStart('surf-f', { sessionId: 's' })).not.toContain('UNSCOPED');
  });

  it('an older Eridani (no context.scope) is printed as before; a bound surface gets the full text', async () => {
    expect(await svc({ text: 'OLD STYLE' }, false).sessionStart('surf-f', { sessionId: 's' })).toBe('OLD STYLE\n');
    const bound = await svc({ text: 'FULL RUN CONTEXT', scope: 'run' }, true).sessionStart('surf-b', { sessionId: 's' });
    expect(bound).toContain('FULL RUN CONTEXT');
    expect(bound).toContain('status-only bridge does not expose desktop browser or workspace control');
    expect(bound).toContain('do not establish Eridani verification or task acceptance');
  });
});

describe('L10: link URLs', () => {
  it('ws:// only for loopback', () => {
    expect(linkUrlError('wss://app.eridani.app/api/v1/external/agents/link')).toBeNull();
    expect(linkUrlError('ws://127.0.0.1:8000/link')).toBeNull();
    expect(linkUrlError('ws://localhost/link')).toBeNull();
    expect(linkUrlError('ws://[::1]:8000/link')).toBeNull();
    expect(linkUrlError('ws://app.eridani.app/link')).toMatch(/only for localhost/);
    expect(linkUrlError('ws://127.0.0.1.evil.com/link')).toMatch(/only for localhost/);
    expect(linkUrlError('https://app.eridani.app')).toMatch(/wss/);
    expect(linkUrlError('nonsense')).toMatch(/not a URL/);
  });
});

describe('M8: verify runs with a minimal environment inside the worktree', () => {
  it('passes PATH, HOME, LANG, CI, TERM and the entry\'s own env only', () => {
    const env = verifyEnv({ id: 't', argv: ['x'], timeout: 1, env: { NODE_OPTIONS: '--max-old-space-size=4096' } }, { PATH: '/bin', HOME: '/h', LANG: 'en_US.UTF-8', AWS_SECRET_ACCESS_KEY: 'nope', ERIDANI_RUN_TOKEN: 'nope', SSH_AUTH_SOCK: '/s' });
    expect(env).toEqual({ PATH: '/bin', HOME: '/h', LANG: 'en_US.UTF-8', CI: '1', TERM: 'dumb', NODE_OPTIONS: '--max-old-space-size=4096' });
  });

  it('the real process sees only that environment', async () => {
    const wt = tmp('verify-env-');
    const spec: VerifySpec = { id: 't', argv: ['/usr/bin/env'], timeout: 10 };
    process.env.REMOTEA_STAGE_F_LEAK = 'leaked';
    try {
      const out = await runVerify({ spec, worktree: wt });
      expect(out.tail).toContain('CI=1');
      expect(out.tail).not.toContain('REMOTEA_STAGE_F_LEAK');
    } finally {
      delete process.env.REMOTEA_STAGE_F_LEAK;
    }
  });

  it('a symlinked cwd that leaves the worktree is refused', async () => {
    const wt = tmp('verify-wt-');
    const outside = tmp('verify-out-');
    fs.symlinkSync(outside, path.join(wt, 'tests'));
    const out = await runVerify({ spec: { id: 't', argv: ['/bin/true'], cwd: 'tests', timeout: 5 }, worktree: wt });
    expect(out).toMatchObject({ exit_code: null, error: 'cwd escapes the worktree' });
  });

  it('validates a verify entry\'s env', () => {
    const t = (env: unknown) => targetError({ id: 'x', repo: '/r', worktreeRoot: '/w', base: 'main', launch: { claude: {} }, verify: [{ id: 'v', argv: ['npm', 'test'], timeout: 5, env }] });
    expect(t({ NODE_ENV: 'test' })).toBeNull();
    expect(t({ 'BAD-KEY': 'x' })).toMatch(/env/);
    expect(t({ A: 'line\nbreak' })).toMatch(/env/);
    expect(t(['A=1'])).toMatch(/env/);
  });
});

describe('M8: a spawn base is a branch, tag or commit of the target repository', () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });

  it('refuses a remote-tracking ref other than the configured base, accepts branches, tags and shas', async () => {
    const root = tmp('base-');
    const r = path.join(root, 'repo');
    fs.mkdirSync(r);
    git(r, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(r, 'a'), '1');
    git(r, 'add', '.');
    git(r, 'commit', '-q', '-m', 'one');
    git(r, 'tag', 'v1');
    git(r, 'branch', 'dev');
    const sha = git(r, 'rev-parse', 'HEAD').trim();
    // Someone else's pushed work, visible only as a remote-tracking ref.
    git(r, 'update-ref', 'refs/remotes/origin/their-pr', sha);
    git(r, 'update-ref', 'refs/remotes/origin/main', sha);
    const target: ExecutionTarget = { id: 't', repo: r, worktreeRoot: path.join(root, 'wts'), base: 'main', launch: { claude: {} }, verify: [] };
    const m = new WorktreeManager({ dir: root });
    expect(await m.resolveBase(target, 'dev')).toBe(sha);
    expect(await m.resolveBase(target, 'v1')).toBe(sha);
    expect(await m.resolveBase(target, sha.slice(0, 10))).toBe(sha);
    expect(await m.resolveBase(target, 'origin/their-pr')).toBeNull();
    expect(await m.resolveBase(target, 'their-pr')).toBeNull();
    expect(await m.resolveBase(target, 'HEAD@{1}')).toBeNull();
    await expect(m.ensure(target, 'eri/x', 'origin/their-pr')).rejects.toThrow(/not a branch, tag or commit/);
    // The configured base may come from origin when it is not checked out locally.
    git(r, 'checkout', '-q', '-b', 'other');
    git(r, 'branch', '-D', 'main');
    expect(await m.resolveBase(target, 'main')).toBe(sha);
    expect((await m.ensure(target, 'eri/y')).baseSha).toBe(sha);
  });
});
