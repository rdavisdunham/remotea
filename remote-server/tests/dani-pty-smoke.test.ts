/** Copy into an isolated, patched remote-server/tests checkout and run with Vitest on Linux. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as pty from 'node-pty';
import { it } from 'vitest';
import { foregroundAgent, promptIdentity } from '../src/glassface-input';
import { Hub } from '../src/hub';
import { readStat } from '../src/proc';
import { Registry } from '../src/registry';
import { FakeConn, waitFor } from './helpers';

it('submits one confirmed answer to an isolated Linux PTY and observes Enter in the child', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dani-pty-fixture-'));
  const script = path.join(directory, 'composer.py');
  const received = path.join(directory, 'received');
  fs.writeFileSync(script, String.raw`
import os, sys, tty
from pathlib import Path
tty.setraw(0)
def paint(text):
    border = "─" * 73
    sys.stdout.write("\x1b[?2004h\x1b[2J\x1b[H" + border + "\r\n❯\u00a0" + text +
                     "\r\n" + border + "\r\n? for shortcuts\x1b[2;3H")
    sys.stdout.flush()
paint("")
line = b""
while not line.endswith(b"\x1b[201~"):
    line += os.read(0, 1)
assert line.startswith(b"\x1b[200~")
answer = line[6:-6].decode("utf-8")
paint(answer)
assert os.read(0, 1) == b"\r"
Path("received").write_text(answer)
os.read(0, 1)
`);
  const registry = Registry.load({ file: null, bootId: 'fixture-boot' });
  const surf = 'surf-isolated-fixture', conversation = 'fixture-only-conversation';
  const hub = new Hub({ registry, bootId: 'fixture-boot', serverId: 'fixture-server',
    glassfaceDeviceId: 'fixture-glass', glassfaceGroupId: 'fixture-group',
    spawn: req => pty.spawn('/usr/bin/python3', ['-I', '-u', script], {
      cols: req.cols, rows: req.rows, cwd: directory, env: { LANG: 'C.UTF-8', TERM: 'xterm-256color' }
    }),
    // Stand-in provider identity on this in-memory hub only. The production verifier rejects this program.
    glassfaceForeground: (pid, provider, thread) => {
      const stat = readStat(pid);
      return stat?.pgrp === pid && stat.tpgid === pid && provider === 'claude' && thread === conversation &&
        fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8').split('\0').includes(script);
    }
  });
  function connect(n: number, id: string, name: string) {
    const conn = new FakeConn(n);
    hub.connect(conn);
    hub.handle(conn, { t: 'hello', proto: 1, device: { id, name: 'fixture' }, app: { name, version: '1' } });
    return conn;
  }
  try {
    const desktop = connect(1, 'fixture-desktop', 'remotea');
    hub.handle(desktop, { t: 'open', rid: 1, id: surf, cols: 80, rows: 24, create: { cwd: directory } });
    await waitFor(() => desktop.outputs(surf).map(x => x.data).join('').includes('for shortcuts'));
    const session = hub.sessions.get(surf)!;
    assert.ok(session.pid);
    assert.equal(foregroundAgent(session.pid, 'claude', conversation), false);
    registry.updateSession(surf, { groupId: 'fixture-group', agent: { provider: 'claude', sessionId: conversation, seenAt: 100 } });
    hub.relayRpc(surf, 'hook.event', { at: 101, sessionId: conversation, event: 'UserPromptSubmit', prompt: 'Check a fixture.' });
    hub.relayRpc(surf, 'hook.event', { at: 102, sessionId: conversation, event: 'Stop', lastAssistantMessage: 'It passed. Should I continue?' });
    const glass = connect(2, 'fixture-glass', 'googleglass');
    const rec = glass.json('welcome')[0].sessions.find(s => s.id === surf)!;
    const turn = rec.glassfaceDaniTurn!.id;
    hub.handle(glass, { t: 'glassfaceDaniRead', rid: 2, id: surf, turn });
    assert.equal(glass.json('glassfaceDaniReadResult')[0].turn?.question, 'Should I continue?');
    const answer = 'Continue with the fixture.';
    hub.handle(glass, { t: 'glassfaceDaniInput', rid: 3, id: surf, bootId: 'fixture-boot', incarnation: rec.incarnation!,
      provider: 'claude', conversation, expectedPrompt: promptIdentity(rec, session.inputRevision), turn,
      operationId: 'fixture-answer-once', text: answer });
    await waitFor(() => glass.json('glassfaceReceipt').length > 0);
    assert.equal(glass.json('glassfaceReceipt')[0].status, 'submitted');
    await waitFor(() => fs.existsSync(received));
    assert.equal(fs.readFileSync(received, 'utf8'), answer);
  } finally {
    await hub.shutdown();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
