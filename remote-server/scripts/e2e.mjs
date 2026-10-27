#!/usr/bin/env node
// End-to-end check of a real remotea-server (built dist/, real PTYs) with two
// simulated devices. Uses a throwaway config dir and a random port; never
// touches ~/.config/remotea or a running service.
//
//   npm run build && node scripts/e2e.mjs
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const MAIN = path.join(root, 'dist/remote-server/src/main.js');
const CLI = path.join(root, 'dist/remote-server/src/cli.js');
const proto = await import(path.join(root, 'dist/src/shared/remote-host-protocol.js'));
const { decodeFrame, encodeInput } = proto.default ?? proto;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remotea-e2e-'));
const freePort = () => new Promise((r) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => {
    const p = s.address().port;
    s.close(() => r(p));
  });
});
const port = await freePort();
const hookPort = await freePort();
fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ port, hookPort, bind: ['127.0.0.1'] }));
const HOOK_JS = path.resolve(here, '..', '..', 'resources', 'cli', 'wmux-hook.js');
const CLI_JS = path.resolve(here, '..', '..', 'resources', 'cli', 'wmux.js');
const env = { ...process.env, REMOTEA_CONFIG_DIR: dir };

let failures = 0;
const ok = (cond, what) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${what}`);
  if (!cond) failures++;
};

let server;
async function startServer() {
  server = spawn(process.execPath, [MAIN], { env, stdio: ['ignore', 'pipe', 'inherit'] });
  let log = '';
  server.stdout.on('data', (d) => {
    log += d;
    if (process.env.E2E_VERBOSE) process.stdout.write(`[server] ${d}`);
  });
  const deadline = Date.now() + 10_000;
  while (!log.includes('listening on') && Date.now() < deadline) await sleep(50);
  if (!log.includes('listening on')) throw new Error(`server did not start:\n${log}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const token = () => fs.readFileSync(path.join(dir, 'token'), 'utf8').trim();

class Client {
  constructor(name) {
    this.name = name;
    this.device = { id: `device-${name}-e2e`, name };
    this.msgs = [];
    this.out = new Map();
    this.rid = 1;
  }
  async connect() {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { Authorization: `Bearer ${token()}` } });
    this.ws.on('message', (data, isBinary) => {
      if (isBinary) {
        const f = decodeFrame(new Uint8Array(data));
        const list = this.out.get(f.id) ?? [];
        list.push(f);
        this.out.set(f.id, list);
      } else this.msgs.push(JSON.parse(String(data)));
    });
    await new Promise((res, rej) => {
      this.ws.once('open', res);
      this.ws.once('error', rej);
    });
    this.send({ t: 'hello', proto: 1, device: this.device, app: { name: 'e2e', version: '0' } });
    return this.wait((m) => m.t === 'welcome');
  }
  send(m) {
    this.ws.send(JSON.stringify(m));
  }
  input(id, data) {
    this.ws.send(encodeInput(id, data));
  }
  text(id) {
    return (this.out.get(id) ?? []).map((f) => f.data).join('');
  }
  lastSeq(id) {
    return (this.out.get(id) ?? []).at(-1)?.seq ?? 0;
  }
  async wait(pred, ms = 10_000) {
    const deadline = Date.now() + ms;
    for (;;) {
      const m = this.msgs.find(pred);
      if (m) return m;
      if (Date.now() > deadline) throw new Error(`${this.name}: timed out waiting`);
      await sleep(20);
    }
  }
  async waitText(id, needle, ms = 10_000) {
    const deadline = Date.now() + ms;
    while (!this.text(id).includes(needle)) {
      if (Date.now() > deadline) throw new Error(`${this.name}: no "${needle}" in output of ${id}:\n${this.text(id).slice(-500)}`);
      await sleep(20);
    }
  }
  close() {
    this.ws.close();
  }
}

const cli = (...args) => execFileSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8' });

try {
  await startServer();
  const A = new Client('alpha');
  const B = new Client('bravo');
  const welcome = await A.connect();
  await B.connect();
  ok(welcome.sessions.length === 0, 'fresh registry is empty');

  // 1. Create, type, see output; B learns about it.
  const S1 = 'surf-e2e-one';
  A.send({ t: 'open', rid: A.rid++, id: S1, cols: 100, rows: 30, create: { cwd: os.tmpdir(), groupId: 'grp-e2e', group: { name: 'E2E' } } });
  const opened = await A.wait((m) => m.t === 'opened' && m.id === S1);
  ok(opened.mode === 'fresh' && opened.created, 'create opens fresh');
  await B.wait((m) => m.t === 'sessionAdded' && m.session.id === S1);
  ok(true, 'other device is told about the new session');
  await sleep(1500); // let the login shell draw its prompt
  A.input(S1, 'echo E2E_$((40+2))\r');
  await A.waitText(S1, 'E2E_42');
  ok(true, 'typed command runs and its output streams back');

  // 1b. An agent hook fired inside the session reaches the attached app (phase 4).
  A.input(S1, `echo '{"session_id":"0f8fad5b-d9cb-469f-a165-70867728950e"}' | '${process.execPath}' '${HOOK_JS}' --event Stop; echo HOOK_$?_DONE\r`);
  await A.waitText(S1, 'HOOK_0_DONE');
  const rpc = await A.wait((m) => m.t === 'rpc' && m.id === S1, 5000).catch(() => null);
  ok(rpc?.method === 'hook.event' && rpc.params.event === 'Stop' && rpc.params.surfaceId === S1, 'a hook inside the session reaches the app through the bridge');
  // The wmux CLI, as the OpenCode plugin runs it (`node $WMUX_CLI report-agent …`).
  A.input(S1, `'${process.execPath}' '${CLI_JS}' report-agent --run-start; echo CLI_$?_DONE\r`);
  await A.waitText(S1, 'CLI_0_DONE');
  const cliRpc = await A.wait((m) => m.t === 'rpc' && m.id === S1 && m.method === 'pane.report_agent', 5000).catch(() => null);
  ok(cliRpc?.params?.runDelta === 1 && cliRpc.params.surfaceId === S1, 'the wmux CLI inside the session reports through the bridge');
  const metaAgent = await A.wait((m) => m.t === 'meta' && m.id === S1 && m.agent, 5000).catch(() => null);
  ok(metaAgent?.agent?.sessionId === '0f8fad5b-d9cb-469f-a165-70867728950e', 'the hook\'s session id becomes the session\'s agent');

  // 2. A drops; B keeps working; A comes back with sinceSeq -> delta.
  const sinceSeq = A.lastSeq(S1);
  const bootId = welcome.bootId;
  A.close();
  B.send({ t: 'open', rid: B.rid++, id: S1, cols: 100, rows: 30 });
  await B.wait((m) => m.t === 'opened' && m.id === S1);
  B.input(S1, 'echo WHILE_AWAY\r');
  await B.waitText(S1, 'WHILE_AWAY');
  const A2 = new Client('alpha');
  await A2.connect();
  A2.send({ t: 'open', rid: 1, id: S1, cols: 100, rows: 30, sinceSeq, bootId });
  const reopened = await A2.wait((m) => m.t === 'opened' && m.id === S1);
  ok(reopened.mode === 'delta' && reopened.fromSeq === sinceSeq, `reconnect within the ring replays a delta (mode=${reopened.mode})`);
  await A2.waitText(S1, 'WHILE_AWAY');
  ok(true, 'delta contains exactly what was missed');

  // 3. A fresh attach without sinceSeq gets a snapshot with the whole history.
  const C = new Client('charlie');
  await C.connect();
  C.send({ t: 'open', rid: 1, id: S1, cols: 100, rows: 30 });
  const snap = await C.wait((m) => m.t === 'opened' && m.id === S1);
  ok(snap.mode === 'snapshot' && snap.snapshot.includes('E2E_42') && snap.snapshot.includes('WHILE_AWAY'), 'snapshot carries screen + scrollback');
  C.close();

  // 4. Queries are answered with nobody attached.
  const S2 = 'surf-e2e-query';
  A2.send({ t: 'open', rid: A2.rid = 5, id: S2, cols: 80, rows: 24, create: { cwd: os.tmpdir(), groupId: 'grp-e2e', group: { name: 'E2E' }, cmd: `sleep 1; printf '\\033[c'; IFS= read -r -s -t 4 -d c r; echo "DA:\${r#?}"; sleep 60` } });
  await A2.wait((m) => m.t === 'opened' && m.id === S2);
  A2.send({ t: 'detach', ids: [S2] });
  await sleep(2500);
  A2.send({ t: 'open', rid: 6, id: S2, cols: 80, rows: 24 });
  const qsnap = await A2.wait((m) => m.t === 'opened' && m.id === S2 && m.rid === 6);
  ok(/DA:\[\?62;4;9;22/.test(qsnap.snapshot ?? ''), 'DA1 answered by the server while no client was attached');

  // 5. Both devices close the same session at once.
  A2.send({ t: 'close', rid: 10, id: S2 });
  B.send({ t: 'close', rid: 11, id: S2 });
  await A2.wait((m) => m.t === 'ack' && m.rid === 10);
  await B.wait((m) => m.t === 'ack' && m.rid === 11);
  await sleep(200);
  ok(B.msgs.filter((m) => m.t === 'sessionClosed' && m.id === S2).length === 1, 'racing closes broadcast exactly one sessionClosed');
  B.send({ t: 'open', rid: 12, id: S2, cols: 80, rows: 24, create: {} });
  const err = await B.wait((m) => m.t === 'openError' && m.rid === 12);
  ok(err.code === 'closed', 'a closed session cannot be re-created');

  // 6. Hide on one device only.
  A2.send({ t: 'hide', rid: 20, id: S1 });
  await A2.wait((m) => m.t === 'ack' && m.rid === 20);
  const hidden = await B.wait((m) => m.t === 'sessionUpdated' && m.session.id === S1 && m.session.hiddenBy.length === 1);
  ok(hidden.session.hiddenBy[0] === A.device.id, 'hide is recorded for that device only');
  A2.send({ t: 'unhide', rid: 21, id: S1 });
  await A2.wait((m) => m.t === 'ack' && m.rid === 21);

  // 7. CLI: status --json and open.
  const status = JSON.parse(cli('status', '--json'));
  ok(status.version === 1 && status.server.running === true, 'remotea status --json reports a running server');
  const s1 = status.sessions.find((s) => s.id === S1);
  ok(s1 && s1.groupName === 'E2E' && s1.state === 'live', 'status lists the session with its group name');
  const opened3 = JSON.parse(cli('open', '--group', 'E2E', '--cwd', os.tmpdir(), '--json', '--', 'echo', 'FROM CLI'));
  ok(opened3.groupId === 'grp-e2e', 'remotea open reuses the group found by name');
  await B.wait((m) => m.t === 'sessionAdded' && m.session.id === opened3.id);
  ok(true, 'a CLI-opened session is announced to every device');
  B.send({ t: 'open', rid: 30, id: opened3.id, cols: 80, rows: 24 });
  await B.wait((m) => m.t === 'opened' && m.id === opened3.id);
  await B.waitText(opened3.id, 'FROM CLI').catch(async () => {
    const again = await B.wait((m) => m.t === 'opened' && m.id === opened3.id);
    if (!(again.snapshot ?? '').includes('FROM CLI')) throw new Error('CLI command output missing');
  });
  ok(true, 'the CLI command ran once the shell was ready');

  // 8. Group close.
  B.send({ t: 'groupClose', rid: 40, id: 'grp-e2e' });
  const gc = await A2.wait((m) => m.t === 'groupClosed' && m.id === 'grp-e2e');
  ok(gc.sessionIds.includes(S1) && gc.sessionIds.includes(opened3.id), 'closing a group closes all of its sessions');

  // 9. Server dies hard; sessions come back as lost and respawn exactly once.
  const S3 = 'surf-e2e-survivor';
  B.send({ t: 'open', rid: 50, id: S3, cols: 80, rows: 24, create: { cwd: os.tmpdir(), groupId: 'grp-two', group: { name: 'Two' } } });
  await B.wait((m) => m.t === 'opened' && m.id === S3);
  await sleep(600); // registry save debounce
  A2.close();
  B.close();
  server.kill('SIGKILL');
  await sleep(300);
  await startServer();
  const A3 = new Client('alpha');
  const B3 = new Client('bravo');
  const w3 = await A3.connect();
  await B3.connect();
  ok(w3.sessions.find((s) => s.id === S3)?.state === 'lost', 'after a crash the session is reported lost, not closed');
  A3.send({ t: 'open', rid: 1, id: S3, cols: 80, rows: 24, create: { startupCommands: ['echo RESPAWNED'] } });
  B3.send({ t: 'open', rid: 1, id: S3, cols: 80, rows: 24, create: { startupCommands: ['echo RESPAWNED'] } });
  const ra = await A3.wait((m) => m.t === 'opened' && m.id === S3);
  const rb = await B3.wait((m) => m.t === 'opened' && m.id === S3);
  ok([ra, rb].filter((m) => m.wasLost).length === 1, 'two devices respawning at once start one process');
  ok(w3.sessions.find((s) => s.id === S3)?.groupId === 'grp-two', 'the respawned session keeps its group');
  A3.close();
  B3.close();
} catch (err) {
  failures++;
  console.error(`FAIL ${err.stack ?? err}`);
} finally {
  server?.kill('SIGTERM');
  await sleep(300);
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} failure(s)` : '\nall e2e checks passed');
process.exit(failures ? 1 : 0);
