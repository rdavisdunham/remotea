import { describe, expect, it } from 'vitest';
import { Terminal } from '@xterm/headless';
import { TermSession } from '../src/session';
import { DA1_REPLY, DEFAULT_THEME, toXParseColor } from '../src/queries';
import { FakeConn, fakeSpawner, ManualTimers } from './helpers';
import { installRemoteQuerySwallow } from '../../src/shared/remote-query-swallow';

/**
 * Every query a terminal can be asked. The server answers these (from its
 * headless xterm or the overrides in queries.ts); clients must swallow the
 * same set so nothing is answered twice — see QUERIES_SERVER_ANSWERS, which
 * the app's swallow test imports via the protocol contract.
 */
const QUERIES: Record<string, string> = {
  DA1: '\x1b[c',
  DA1_0: '\x1b[0c',
  DA2: '\x1b[>c',
  DSR_status: '\x1b[5n',
  CPR: '\x1b[6n',
  DECXCPR: '\x1b[?6n',
  DECRQM_ansi: '\x1b[4$p',
  DECRQM_dec: '\x1b[?25$p',
  DECRQSS: '\x1bP$qm\x1b\\',
  OSC10: '\x1b]10;?\x1b\\',
  OSC11: '\x1b]11;?\x1b\\',
  OSC12: '\x1b]12;?\x1b\\',
};

async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 30));
}

/** The headless emulator parses asynchronously: wait for the reply rather than a fixed delay. */
async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) return;
    await new Promise((r) => setTimeout(r, 5));
  }
}

function session() {
  const sp = fakeSpawner();
  const s = new TermSession({
    id: 'surf-queries', bootId: 'b', cols: 80, rows: 24, scrollback: 100, snapshotScrollback: 100, ringBytes: 1 << 16,
    spawn: sp.spawn, theme: () => ({ fg: '#112233', bg: '#445566', cursor: '#778899' }), onExit: () => {}, timers: new ManualTimers(),
  });
  return { s, pty: sp.last() };
}

describe('server-side query replies', () => {
  it('answers with no client attached, exactly once each', async () => {
    const { s, pty } = session();
    for (const [name, q] of Object.entries(QUERIES)) {
      pty.written = [];
      pty.emit(q);
      s.flush();
      await until(() => pty.written.join('').length > 0);
      const replies = pty.written.join('');
      expect(replies.length, `${name} got a reply`).toBeGreaterThan(0);
    }
    s.dispose();
  });

  it('forwards negotiated focus reports without counting them as changes to reviewed input', async () => {
    const { s, pty } = session();
    const client = new FakeConn(1);
    s.attach(client, { cols: 80, rows: 24, created: true });
    try {
      pty.emit('\x1b[?1004h');
      await s.composerScreen();
      s.input(client.id, '\x1b[O');
      s.input(client.id, '\x1b[I');
      expect(s.inputRevision).toBe(0);
      expect(pty.written.slice(-2)).toEqual(['\x1b[O', '\x1b[I']);
      for (const input of ['x', '\x1b[Ochanged', '\x1b[I\r', '\x1b[1;1R']) s.input(client.id, input);
      expect(s.inputRevision).toBe(4);
      pty.emit('\x1b[?1004l');
      await s.composerScreen();
      s.input(client.id, '\x1b[I');
      expect(s.inputRevision).toBe(5);
    } finally {
      s.dispose();
    }
  });

  it('uses wmux DA1 and the theme colours', async () => {
    const { s, pty } = session();
    pty.emit(QUERIES.DA1);
    pty.emit(QUERIES.OSC11);
    s.flush();
    await until(() => pty.written.includes(DA1_REPLY) && pty.written.includes('\x1b]11;rgb:4444/5555/6666\x1b\\'));
    expect(pty.written).toContain(DA1_REPLY);
    expect(pty.written).toContain('\x1b]11;rgb:4444/5555/6666\x1b\\');
    s.dispose();
  });

  it('does not answer twice when clients are attached (replies come only from the server emulator)', async () => {
    const { s, pty } = session();
    s.attach(new FakeConn(1), { cols: 80, rows: 24, created: true });
    s.attach(new FakeConn(2), { cols: 80, rows: 24, created: false });
    pty.emit(QUERIES.CPR);
    s.flush();
    await until(() => pty.written.some((w) => /\x1b\[\d+;\d+R/.test(w)));
    // Then long enough for a second answer to show, if there were one.
    await settle();
    expect(pty.written.filter((w) => /\x1b\[\d+;\d+R/.test(w))).toHaveLength(1);
    s.dispose();
  });
});

describe('toXParseColor', () => {
  it('converts #rrggbb', () => {
    expect(toXParseColor('#1e1e1e')).toBe('rgb:1e1e/1e1e/1e1e');
    expect(toXParseColor('bogus')).toBeNull();
    expect(toXParseColor(DEFAULT_THEME.bg)).toBe('rgb:1e1e/1e1e/1e1e');
  });
});

describe('client swallow contract', () => {
  it('a plain xterm would also answer these, which is why the app must swallow them on remote panes', async () => {
    const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    const out: string[] = [];
    term.onData((d) => out.push(d));
    for (const q of Object.values(QUERIES)) term.write(q);
    await new Promise((r) => term.write('', () => r(undefined)));
    // OSC 10/11/12 are not answered by xterm itself (no theme service headless); the server's overrides cover them.
    expect(out.length).toBe(Object.keys(QUERIES).length - 3);
  });

  it('with the app\'s swallow installed, an xterm answers none of the queries the server answers', async () => {
    const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    installRemoteQuerySwallow(term as never);
    const out: string[] = [];
    term.onData((d) => out.push(d));
    for (const q of Object.values(QUERIES)) term.write(q);
    // A colour SET must still apply.
    term.write('\x1b]11;#102030\x1b\\');
    await new Promise((r) => term.write('', () => r(undefined)));
    expect(out).toEqual([]);
  });
});
