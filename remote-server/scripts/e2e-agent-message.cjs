// Run after the server build, on a Linux host with an authenticated native Codex.
// Uses a NEW in-memory host, PTY and conversation. The cwd must already be trusted.
const {randomUUID} = require('node:crypto');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const {setTimeout: delay} = require('node:timers/promises');
const {Registry} = require('../dist/remote-server/src/registry');
const {Hub} = require('../dist/remote-server/src/hub');
const {spawnPty} = require('../dist/remote-server/src/pty-spawn');
const {readStat} = require('../dist/remote-server/src/proc');
const {codexThreadFromFds} = require('../dist/remote-server/src/agent-probe');
const {composerShows} = require('../dist/remote-server/src/glassface-input');

const cwd = process.argv[2];
assert.ok(cwd && path.isAbsolute(cwd), 'Pass an absolute, already trusted working directory.');
const id = 'surf-message-proof-' + randomUUID();
const bootId = randomUUID();
const registry = Registry.load({file: null, bootId});
const hub = new Hub({registry, spawn: spawnPty, bootId, serverId: 'disposable', glassfaceDeviceId: 'proof-glass', glassfaceSharedGroups: true});
let connId = 0;
let rid = 0;

function client(app, device) {
  const rows = [];
  const conn = {id: ++connId, rows, sendJson: m => rows.push(m), sendBinary() {}, bufferedAmount: () => 0, close() {}};
  hub.connect(conn);
  hub.handle(conn, {t:'hello', proto:1, device:{id:device, name:device}, app:{name:app, version:'1'}});
  assert.ok(rows[0].features.includes('agentMessage'));
  return conn;
}
async function until(action, reason, ms = 45000) {
  const end = Date.now() + ms;
  do {
    const value = await action();
    if (value) return value;
    await delay(250);
  } while (Date.now() < end);
  throw Error(reason);
}
async function request(conn, m, reply) {
  const n = ++rid;
  hub.handle(conn, {...m, rid:n, id});
  return until(() => conn.rows.find(row => row.t === reply && row.rid === n), 'Missing ' + reply, 15000);
}

(async () => {
  const desktop = client('remotea', 'proof-desktop');
  const glass = client('googleglass', 'proof-glass');
  try {
    hub.handle(desktop, {t:'open', rid:++rid, id, cols:120, rows:34, create:{cwd, title:'Disposable Codex conversation'}});
    const pane = hub.sessions.get(id);
    const shell = pane.pid;
    assert.equal(readStat(shell).comm, 'bash');
    await delay(700);
    const bin = path.join(os.homedir(), '.local/bin/codex');
    const q = s => "'" + s.replaceAll("'", "'\\''") + "'";
    const words = 'tawny dune';
    const command = [bin, '--model', process.env.REMOTEA_TEST_CODEX_MODEL || 'gpt-6.2-sol', '-c', 'check_for_update_on_startup=false',
      '-c', 'model_reasoning_effort="low"', '-s', 'read-only', 'Use no tools. Reply with only the words '+words+'.'];
    hub.handleInput(desktop, id, command.map(q).join(' ')+'\r');
    const see = async words => {
      const screen = await pane.composerScreen();
      return screen && screen.lines.some(line => new RegExp('^\\s*(?:•\\s*)?'+words+'[.!]?\\s*$', 'i').test(line)) &&
        composerShows('codex', screen, '');
    };
    await until(() => see(words), 'Codex did not reply to the seed and return to its empty composer.');
    hub.probeAgents();
    const processId = readStat(shell).tpgid;
    const thread = codexThreadFromFds(processId);
    assert.notEqual(shell, processId);
    assert.ok(thread && registry.session(id).agent.sessionId === thread);
    for (const [sender, answer] of [[glass, 'moss falcon'], [desktop, 'indigo raven']]) {
      const getTarget = async () => (await request(sender, {t:'agentMessageTarget'}, 'agentMessageTargetResult')).target;
      const target = await until(getTarget, 'No native shared target');
      assert.equal(target.conversation, thread);
      const msg = {t:'agentMessage', ...target, operationId:randomUUID(), text:'Use no tools. Reply with only the words '+answer+'.'};
      const before = pane.inputRevision;
      const receipt = await request(sender, msg, 'agentMessageReceipt');
      assert.equal(receipt.status, 'queued');
      assert.ok(receipt.providerMessageId);
      const retry = await request(sender, msg, 'agentMessageReceipt');
      assert.equal(retry.providerMessageId, receipt.providerMessageId);
      assert.equal(pane.inputRevision, before + 1);
      await until(() => see(answer), 'Missing same-pane reply: '+answer);
      assert.equal(readStat(shell).tpgid, processId);
      assert.equal(codexThreadFromFds(processId), thread);
      console.log(sender === glass ? 'Glass' : 'Desktop', 'received one provider receipt and the reply appeared on the original Bash-launched pane');
    }
    const rec = registry.session(id);
    const read = await request(glass, {t:'glassfaceRead', bootId, incarnation:rec.incarnation, conversation:thread, maxBytes:16384}, 'glassfaceReadResult');
    assert.ok(read.reader.replies.some(reply => /indigo raven/i.test(reply.text)));
    console.log('Glass read back the desktop follow-up from the original provider conversation.');
  } finally { await hub.shutdown(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
