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
import crypto from 'node:crypto';
import WebSocket, { WebSocketServer } from 'ws';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const MAIN = path.join(root, 'dist/remote-server/src/main.js');
const CLI = path.join(root, 'dist/remote-server/src/cli.js');
const proto = await import(path.join(root, 'dist/src/shared/remote-host-protocol.js'));
const { decodeFrame, encodeInput } = proto.default ?? proto;
const linkProto = await import(path.join(root, 'dist/src/shared/eridani-link-protocol.js'));
const { canonicalJson, semanticPayload } = linkProto.default ?? linkProto;
const digestOf = (body) => crypto.createHash('sha256').update(canonicalJson(semanticPayload(body))).digest('hex');

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
const HOOK_JS = path.resolve(here, '..', '..', 'resources', 'cli', 'remotea-hook.js');
const CLI_JS = path.resolve(here, '..', '..', 'resources', 'cli', 'remotea.js');
const FIXTURE_HOME = path.join(root, 'tests', 'fixtures', 'collector', 'home');
// The collector reads the fixture home, never the real ~/.claude or /mnt/c.
const env = { ...process.env, REMOTEA_CONFIG_DIR: dir, REMOTEA_COLLECTOR_HOME: FIXTURE_HOME };

/**
 * A fake Eridani link endpoint, speaking the plan's protocol: welcome on hello,
 * ack every op (unless `hold` says not yet), record everything.
 */
class FakeEridani {
  constructor() {
    this.frames = [];
    this.upgrades = [];
    this.sockets = [];
    this.epoch = 0;
    this.hold = () => false;
    this.held = [];
    this.wss = new WebSocketServer({ host: '127.0.0.1', port: 0, verifyClient: (info) => (this.upgrades.push(info.req.headers), true) });
    this.wss.on('connection', (ws) => {
      this.sockets.push(ws);
      ws.on('message', (data) => {
        const f = JSON.parse(String(data));
        this.frames.push(f);
        if (f.t === 'hello') this.send(ws, { t: 'welcome', host_id: 'host-e2e', conn_epoch: ++this.epoch, server_time: Date.now(), replay_horizon: 604800 });
        else if (f.t === 'context.request') {
          const text = this.contextText?.(f);
          if (text) this.send(ws, { t: 'context.response', req_id: f.req_id, text, run_token: 'e2e-run-token' });
        }
        else if (f.op_id && f.t !== 'ack') {
          if (this.hold(f)) this.held.push({ ws, f });
          else this.send(ws, { t: 'ack', acked_id: f.id, op_id: f.op_id, ok: true });
        }
      });
    });
  }
  ready() {
    return new Promise((r) => this.wss.once('listening', r));
  }
  get url() {
    return `ws://127.0.0.1:${this.wss.address().port}/api/v1/external/agents/link`;
  }
  send(ws, body) {
    if (ws.readyState === 1) ws.send(JSON.stringify({ v: 1, id: `eri-${Math.random().toString(36).slice(2)}`, conn_epoch: this.epoch, at: Date.now(), ...body }));
  }
  /** Send a command as Eridani does: stable op_id + digest, the envelope around it. */
  command(body) {
    const full = { expires_at: Date.now() + 10 * 60_000, ...body };
    const digest = digestOf(full);
    this.send(this.sockets.at(-1), { ...full, digest });
    return { ...full, digest };
  }
  of(t, pred = () => true) {
    return this.frames.filter((f) => f.t === t && pred(f));
  }
  async waitFor(t, pred = () => true, ms = 10_000) {
    const deadline = Date.now() + ms;
    for (;;) {
      const f = this.of(t, pred)[0];
      if (f) return f;
      if (Date.now() > deadline) throw new Error(`fake Eridani: no ${t} frame`);
      await sleep(25);
    }
  }
  close() {
    for (const s of this.wss.clients) s.terminate();
    this.wss.close();
  }
}
const eri = new FakeEridani();
await eri.ready();
const LINK_KEY = 'eri_bot_e2eTestKey0123456789abcdef';

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
/** The CLI, asynchronously (the fake Eridani lives in this process and must keep answering). */
const cliIn = (input, ...args) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [CLI, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (err += d));
  child.on('exit', (code) => (code === 0 ? resolve(out) : reject(new Error(`exit ${code}: ${err}`))));
  child.stdin.end(input);
});
/** Run the real hook helper inside a session, the way an agent does. */
const hookIn = (client, id, args, payload, tag) => {
  client.input(id, `printf '%s' '${JSON.stringify(payload).replace(/'/g, `'\\''`)}' | '${process.execPath}' '${HOOK_JS}' ${args}; echo ${tag}_$?_DONE\r`);
  return client.waitText(id, `${tag}_0_DONE`);
};

try {
  // 0. Eridani link set up through the CLI: a bad key is refused, a good one is probed and stored.
  let refused = false;
  try {
    await cliIn('not-a-key\n', 'eridani', 'connect', '--url', eri.url);
  } catch {
    refused = true;
  }
  ok(refused && !fs.existsSync(path.join(dir, 'eridani-token')), 'remotea eridani connect refuses a key that is not eri_bot_');
  const connectOut = await cliIn(`${LINK_KEY}\n`, 'eridani', 'connect', '--url', eri.url, '--machine', 'e2e-box');
  ok(/accepted the key/.test(connectOut) && !connectOut.includes(LINK_KEY), 'connect probes with hello/welcome and never prints the key');
  ok((fs.statSync(path.join(dir, 'eridani-token')).mode & 0o777) === 0o600, 'the link key is stored 0600');
  ok(eri.upgrades[0]?.authorization === `Bearer ${LINK_KEY}` && /^remotea-server\//.test(eri.upgrades[0]?.['user-agent'] ?? '') && !eri.upgrades[0]?.origin,
    'the link sends the bearer key and an explicit User-Agent, no Origin');

  await startServer();
  const hello = await eri.waitFor('hello', (f) => !String(f.boot_id).startsWith('probe-'));
  ok(hello.conn_epoch === null && hello.caps.includes('turn') && hello.machine === 'e2e-box', 'the server says hello with its caps');
  const snap0 = await eri.waitFor('sessions.snapshot');
  // epoch 1 was the CLI's probe
  ok(snap0.conn_epoch === 2 && snap0.part.n >= 1, 'after welcome the server sends sessions.snapshot');
  const parity = await eri.waitFor('session.report', () => true, 15_000).catch(() => null);
  ok(parity?.parity === true && parity.tool && parity.report?.machine === 'e2e-box', 'the collector reports in parity mode');
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
  // The wmux CLI, as the OpenCode plugin runs it (`node $REMOTEA_CLI report-agent …`).
  A.input(S1, `'${process.execPath}' '${CLI_JS}' report-agent --run-start; echo CLI_$?_DONE\r`);
  await A.waitText(S1, 'CLI_0_DONE');
  const cliRpc = await A.wait((m) => m.t === 'rpc' && m.id === S1 && m.method === 'pane.report_agent', 5000).catch(() => null);
  ok(cliRpc?.params?.runDelta === 1 && cliRpc.params.surfaceId === S1, 'the wmux CLI inside the session reports through the bridge');
  const metaAgent = await A.wait((m) => m.t === 'meta' && m.id === S1 && m.agent, 5000).catch(() => null);
  ok(metaAgent?.agent?.sessionId === '0f8fad5b-d9cb-469f-a165-70867728950e', 'the hook\'s session id becomes the session\'s agent');

  // 1c. A turn: the prompt and the final response travel through the real helper to Eridani.
  const SID = '0f8fad5b-d9cb-469f-a165-70867728950e';
  await hookIn(A, S1, '--event UserPromptSubmit', { session_id: SID, prompt: 'what is 6*7?' }, 'UPS');
  await hookIn(A, S1, '--event Stop', { session_id: SID, last_assistant_message: 'E2E final answer: 42' }, 'STOP');
  const turn = await eri.waitFor('turn', (f) => f.text === 'E2E final answer: 42').catch(() => null);
  ok(turn && turn.prompt === 'what is 6*7?' && turn.surf === S1 && turn.provider_session_id === SID && turn.root === true, 'a Stop through the real helper reaches Eridani as a turn');
  const rpcStop = A.msgs.filter((m) => m.t === 'rpc' && m.params?.event === 'Stop').at(-1);
  ok(rpcStop && rpcStop.params.lastAssistantMessage === undefined, 'apps get the Stop event without the turn text');
  const st = await eri.waitFor('status', (f) => f.surf === S1 && f.state === 'idle').catch(() => null);
  ok(st && typeof st.since === 'number', 'agent state goes up as status events');
  await sleep(1500); // status file write is coalesced to 1 s
  const est = JSON.parse(cli('eridani', 'status', '--json'));
  ok(est.state === 'ready' && est.link?.unacked === 0 && est.link?.lastAckAt, 'remotea eridani status --json: connected, everything acked');
  ok(!JSON.stringify(est).includes(LINK_KEY), 'the status never carries the key');

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
  ok(status.server.eridani?.enabled === true && status.server.eridani.state === 'ready', 'status --json carries server.eridani');
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
  await sleep(1500); // let the shell draw its prompt
  // An unacknowledged turn when the server dies: it must come back with the same op_id.
  eri.hold = (f) => f.t === 'turn';
  const SID3 = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
  await hookIn(B, S3, '--event Stop', { session_id: SID3, last_assistant_message: 'unacked before the crash' }, 'S3STOP');
  const pending = await eri.waitFor('turn', (f) => f.text === 'unacked before the crash');
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
  eri.hold = () => false;
  const replayed = await eri.waitFor('turn', (f) => f.op_id === pending.op_id && f.id !== pending.id).catch(() => null);
  ok(replayed && replayed.digest === pending.digest && replayed.conn_epoch > pending.conn_epoch, 'the unacked turn is replayed after the restart with the same op_id');
  const snap2 = await eri.waitFor('sessions.snapshot', (f) => f.conn_epoch === replayed?.conn_epoch).catch(() => null);
  ok(snap2?.surfaces?.some((s) => s.surf === S3 && s.state === 'lost'), 'the reconnect snapshot reports the lost session');
  await sleep(300);
  ok(eri.of('turn', (f) => f.op_id === pending.op_id).length === 2, 'the replay happens exactly once');
  A3.send({ t: 'open', rid: 1, id: S3, cols: 80, rows: 24, create: { startupCommands: ['echo RESPAWNED'] } });
  B3.send({ t: 'open', rid: 1, id: S3, cols: 80, rows: 24, create: { startupCommands: ['echo RESPAWNED'] } });
  const ra = await A3.wait((m) => m.t === 'opened' && m.id === S3);
  const rb = await B3.wait((m) => m.t === 'opened' && m.id === S3);
  ok([ra, rb].filter((m) => m.wasLost).length === 1, 'two devices respawning at once start one process');
  ok(w3.sessions.find((s) => s.id === S3)?.groupId === 'grp-two', 'the respawned session keeps its group');
  A3.close();
  B3.close();

  // 10. Stage C: Eridani starts and steers work (dispatch.ts), with a stub `claude`.
  await stageC();
  await stageD();
  await stageE();
  if (process.env.E2E_REAL_CLAUDE === '1') await realQuestion();
} catch (err) {
  failures++;
  console.error(`FAIL ${err.stack ?? err}`);
} finally {
  server?.kill('SIGTERM');
  await sleep(300);
  // E2E_FRAMES=<file>: keep every frame the fake Eridani received (protocol review).
  if (process.env.E2E_FRAMES) fs.writeFileSync(process.env.E2E_FRAMES, JSON.stringify(eri.frames, null, 1));
  eri.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} failure(s)` : '\nall e2e checks passed');

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'e2e', GIT_AUTHOR_EMAIL: 'e2e@x', GIT_COMMITTER_NAME: 'e2e', GIT_COMMITTER_EMAIL: 'e2e@x' } });
}

/** A throwaway repo with one commit; `.claude/settings.json` committed when hooks are given. */
function throwawayRepo(at, claudeSettings) {
  fs.mkdirSync(at, { recursive: true });
  git(at, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(at, 'README.md'), '# e2e\n');
  if (claudeSettings) {
    fs.mkdirSync(path.join(at, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(at, '.claude', 'settings.json'), JSON.stringify(claudeSettings, null, 2));
  }
  git(at, 'add', '.');
  git(at, 'commit', '-q', '-m', 'init');
  return at;
}

function outcome(op, pred = () => true) {
  return eri.waitFor('command.outcome', (f) => f.command_id === op && pred(f), 30_000);
}

/** The command as sent: its envelope id is what remotea's ack names. */
function sendCommand(body) {
  const before = new Set(eri.frames.map((f) => f.id));
  const cmd = eri.command(body);
  return { cmd, waitAck: () => eri.waitFor('ack', (f) => f.op_id === cmd.op_id && !before.has(f.id), 15_000) };
}

async function stageC() {
  const repo = throwawayRepo(path.join(dir, 'repo'));
  const wtRoot = path.join(dir, 'worktrees');
  const starts = path.join(dir, 'stub-starts.log');
  // A post-checkout hook that makes `git worktree add` slow for one branch,
  // so the server can be killed between accept and outcome.
  fs.writeFileSync(path.join(repo, '.git', 'hooks', 'post-checkout'), '#!/bin/sh\ncase "$(git rev-parse --abbrev-ref HEAD)" in *slow*) sleep 4;; esac\n', { mode: 0o755 });

  // The stub agent: shows its argv and ERIDANI_* env, runs the real hook helper
  // (SessionStart prints Eridani's context, Stop marks it idle), echoes input,
  // and leaves on Ctrl-C.
  const stub = path.join(dir, 'bin', 'claude');
  fs.mkdirSync(path.dirname(stub), { recursive: true });
  const hook = (ev, json) => `printf '%s' "${json}" | '${process.execPath}' '${HOOK_JS}' --event ${ev}`;
  fs.writeFileSync(stub, `#!/bin/bash
echo "start $*" >> '${starts}'
for a in "$@"; do echo "STUB ARG [$a]"; done
env | grep '^ERIDANI_' | grep -v '^ERIDANI_PROMPT=' | sort | sed 's/^/STUB ENV /'
SID=$(cat /proc/sys/kernel/random/uuid)
[ "$1" = "--resume" ] && SID="$2"
${hook('SessionStart', '{\\"session_id\\":\\"$SID\\",\\"source\\":\\"startup\\"}')}
${hook('Stop', '{\\"session_id\\":\\"$SID\\",\\"last_assistant_message\\":\\"stub ready\\"}')}
trap 'echo STUB_INTERRUPTED; exit 130' INT
while IFS= read -r line; do
  echo "GOT:$line"
  ${hook('UserPromptSubmit', '{\\"session_id\\":\\"$SID\\",\\"prompt\\":\\"typed by eridani\\"}')}
  ${hook('Stop', '{\\"session_id\\":\\"$SID\\",\\"last_assistant_message\\":\\"echoed\\"}')}
done
`, { mode: 0o755 });

  cli('eridani', 'targets', 'add', '--json', JSON.stringify({
    id: 'e2e', repo, worktreeRoot: wtRoot, base: 'main',
    launch: { claude: { bin: stub } },
    verify: [{ id: 'ls', argv: ['ls', '-1'], timeout: 30 }, { id: 'slowls', argv: ['sh', '-c', 'sleep 3; ls -1'], timeout: 30 }],
  }));
  ok(/e2e .*harnesses claude/.test(cli('eridani', 'targets', 'list')), 'remotea eridani targets add/list');
  eri.contextText = (f) => `ERIDANI CONTEXT for ${f.surf} run ${f.run_id} g${f.generation}`;

  const A = new Client('alpha-c');
  await A.connect();

  // spawn → accepted (ack carries surf + incarnation) → executed; the stub shows argv and env.
  const prompt = 'Fix it; echo "$HOME" && rm -rf / # not a shell';
  const sp = sendCommand({ t: 'spawn', op_id: 'op-e2e-spawn-1', run_id: 'run-e2e-1', generation: 1, attempt: 1, harness: 'claude', model: 'sonnet', target: { id: 'e2e', branch: 'eri/e2e-1' }, task_id: 'task-e2e', prompt, env: { ERIDANI_EXTRA: 'yes' }, run_token: 'tok-e2e' });
  const spAck = await sp.waitAck();
  ok(spAck.ok && spAck.outcome?.state === 'accepted' && /^surf-eri-/.test(spAck.outcome.surf) && spAck.outcome.incarnation >= 0, 'spawn is acked accepted with its surf and incarnation');
  const surf = spAck.outcome.surf;
  const spOut = await outcome('op-e2e-spawn-1');
  ok(spOut.state === 'executed' && spOut.kind === 'spawn' && spOut.result?.branch === 'eri/e2e-1' && spOut.result?.worktree === path.join(fs.realpathSync(wtRoot), 'eri--e2e-1'), 'spawn executed in the managed worktree for its branch');
  await A.wait((m) => m.t === 'sessionAdded' && m.session.id === surf);
  A.send({ t: 'open', rid: A.rid++, id: surf, cols: 120, rows: 40 });
  const op = await A.wait((m) => m.t === 'opened' && m.id === surf);
  const screen = () => (op.snapshot ?? '') + A.text(surf);
  const waitScreen = async (needle, ms = 10_000) => {
    const end = Date.now() + ms;
    while (!screen().includes(needle)) {
      if (Date.now() > end) throw new Error(`no "${needle}" on ${surf}:\n${screen().slice(-800)}`);
      await sleep(30);
    }
  };
  await waitScreen('STUB ARG [auto]');
  ok(screen().includes('STUB ARG [--model]') && screen().includes('STUB ARG [sonnet]') && screen().includes('STUB ARG [--permission-mode]'), 'the harness gets --model sonnet --permission-mode auto');
  ok(screen().includes(`STUB ARG [${prompt}]`), 'the prompt arrives as one argv word, never parsed by the shell');
  ok(screen().includes('STUB ENV ERIDANI_RUN_ID=run-e2e-1') && screen().includes('STUB ENV ERIDANI_EXTRA=yes') && screen().includes('STUB ENV ERIDANI_RUN_TOKEN=tok-e2e'), 'ERIDANI_* env and the run token reach the agent');
  await waitScreen('ERIDANI CONTEXT for');
  ok(screen().includes(`ERIDANI CONTEXT for ${surf} run run-e2e-1 g1`) && screen().includes('Eridani run token: e2e-run-token'), 'SessionStart: context.request → context.response printed for the agent');
  const ctxReq = eri.of('context.request', (f) => f.surf === surf)[0];
  ok(ctxReq?.provider === 'claude' && ctxReq.task_id === 'task-e2e' && ctxReq.incarnation >= 1, 'context.request carries the session and run fences');

  // input (queue): delivered once the agent is idle.
  const inc = spAck.outcome.incarnation;
  const fence = { surf, incarnation: inc, run_id: 'run-e2e-1', generation: 1 };
  const stale = sendCommand({ t: 'input', op_id: 'op-e2e-in-stale', mode: 'queue', text: 'never', ...fence, incarnation: inc + 5 });
  ok((await stale.waitAck()).outcome?.state === 'rejected', 'input with a stale incarnation is rejected');
  // Stage F: text is a paste, never keystrokes; and every effectful command expires.
  const escaped = sendCommand({ t: 'input', op_id: 'op-e2e-in-esc', mode: 'queue', text: 'hi\x1b[20\x1b[201~1~\r!touch /tmp/pwned', ...fence });
  ok((await escaped.waitAck()).outcome?.state === 'rejected', 'input carrying control characters (a nested paste end) is rejected');
  const slash = sendCommand({ t: 'input', op_id: 'op-e2e-in-slash', mode: 'queue', text: '/clear', ...fence });
  ok((await slash.waitAck()).outcome?.state === 'rejected', 'input starting with a slash command is rejected');
  const noExp = sendCommand({ t: 'input', op_id: 'op-e2e-in-noexp', mode: 'queue', text: 'late', ...fence, expires_at: undefined });
  ok((await noExp.waitAck()).outcome?.detail === 'expires_at required', 'input without expires_at is rejected');
  sendCommand({ t: 'input', op_id: 'op-e2e-in-1', mode: 'queue', text: 'hello from eridani', ...fence });
  const inOut = await outcome('op-e2e-in-1');
  ok(inOut.state === 'executed', 'queued input executed');
  await waitScreen('GOT:');
  ok(screen().includes('hello from eridani') && !screen().includes('GOT:never'), 'the input bytes reach the agent');

  // A turn from the stub's Stop is bound to the run.
  const t1 = await eri.waitFor('turn', (f) => f.surf === surf && f.text === 'echoed', 10_000).catch(() => null);
  ok(t1?.run_id === 'run-e2e-1' && t1.generation === 1, 'turns from an Eridani session carry run_id and generation');

  // verify: a configured id, run in the worktree.
  sendCommand({ t: 'verify', op_id: 'op-e2e-verify', attempt_id: 'att-1', run_id: 'run-e2e-1', generation: 1, turn_seq: 1, plan_revision: 1, verify_id: 'ls' });
  const vr = await eri.waitFor('verify.result', (f) => f.attempt_id === 'att-1', 15_000).catch(() => null);
  ok(vr?.exit_code === 0 && vr.tail.includes('README.md') && /^[0-9a-f]{40}:[0-9a-f]{64}$/.test(vr.workspace_fingerprint), 'verify runs the allowlisted command in the worktree and reports a fingerprint');

  // status --json: the additive fields.
  const st = JSON.parse(cli('status', '--json')).sessions.find((x) => x.id === surf);
  ok(st?.eridani?.runId === 'run-e2e-1' && st.eridani.generation === 1 && st.eridani.taskId === 'task-e2e' && st.branch === 'eri/e2e-1' && st.worktree && st.stopRequested === null, 'status --json: eridani, worktree, branch, stopRequested');

  // stop → Ctrl-C → exit observed → outcome; never resumed afterwards.
  sendCommand({ t: 'stop', op_id: 'op-e2e-stop', mode: 'interrupt', ...fence });
  const stOut = await outcome('op-e2e-stop');
  ok(stOut.state === 'executed' && stOut.result?.exited === true, 'stop: Ctrl-C, the exit is observed, then the outcome');
  await waitScreen('STUB_INTERRUPTED');
  const ex = await eri.waitFor('exit', (f) => f.surf === surf, 5000).catch(() => null);
  ok(!!ex, 'the exit reaches Eridani');

  // worktrees.report lists the managed worktree (never removed).
  const wr = await eri.waitFor('worktrees.report', (f) => f.worktrees.some((w) => w.branch === 'eri/e2e-1'), 15_000).catch(() => null);
  ok(!!wr, 'worktrees.report lists the managed worktree');
  ok(/eri\/e2e-1/.test(cli('eridani', 'worktrees')), 'remotea eridani worktrees lists it');

  // A second run stays running across the crash below (resume on boot).
  const sp3 = sendCommand({ t: 'spawn', op_id: 'op-e2e-spawn-3', run_id: 'run-e2e-3', generation: 1, attempt: 1, harness: 'claude', model: 'sonnet', target: { id: 'e2e', branch: 'eri/e2e-3' }, prompt: 'keep going' });
  const surf3 = (await sp3.waitAck()).outcome.surf;
  await outcome('op-e2e-spawn-3');
  // Its SessionStart reports the session id the resume needs.
  const t3 = Date.now();
  while (!JSON.parse(cli('status', '--json')).sessions.find((x) => x.id === surf3)?.agent && Date.now() - t3 < 10_000) await sleep(100);

  // SIGKILL between accept and outcome: the slow worktree holds the spawn open.
  const sp2 = sendCommand({ t: 'spawn', op_id: 'op-e2e-spawn-2', run_id: 'run-e2e-2', generation: 1, attempt: 1, harness: 'claude', model: 'sonnet', target: { id: 'e2e', branch: 'eri/slow-2' }, prompt: 'slow one' });
  const ack2 = await sp2.waitAck();
  ok(ack2.outcome?.state === 'accepted', 'the slow spawn is accepted');
  await sleep(600);
  A.close();
  await sleep(700); // registry save debounce
  server.kill('SIGKILL');
  await sleep(4500); // let the orphaned git finish
  await startServer();
  const settled = await outcome('op-e2e-spawn-2').catch(() => null);
  ok(settled?.state === 'failed', `the interrupted spawn is settled from the journal (${settled?.state}: ${settled?.detail})`);
  // Eridani resends the same spawn: the recorded outcome, and no process.
  const dup = sendCommand({ ...sp2.cmd });
  const dupAck = await dup.waitAck();
  ok(dupAck.ok && dupAck.outcome?.state === 'failed', 'a duplicate spawn returns the recorded outcome');
  await sleep(1500);
  const lines = fs.readFileSync(starts, 'utf8').trim().split('\n');
  ok(!lines.some((l) => l.includes('slow one')), 'no process was started for the interrupted spawn');
  ok(lines.filter((l) => l.includes('Fix it')).length === 1, 'the stopped run was not started again');
  const t4 = Date.now();
  while (!fs.readFileSync(starts, 'utf8').includes('start --resume') && Date.now() - t4 < 10_000) await sleep(100);
  ok(/start --resume \S+ --model sonnet --permission-mode auto/.test(fs.readFileSync(starts, 'utf8')), 'the running run is resumed on boot with its model and permission mode');
  const snap = await eri.waitFor('sessions.snapshot', (f) => f.surfaces?.some((x) => x.surf === surf3 && x.run_id === 'run-e2e-3'), 10_000).catch(() => null);
  ok(!!snap, 'the reconnect snapshot carries the run binding');
}

/**
 * Stage D: a run spawned with a verify config verifies after every root turn
 * on its own (`local:` attempt ids), and a newer turn cancels a running attempt.
 */
async function stageD() {
  const surfOf = (op) => eri.waitFor('ack', (f) => f.op_id === op, 15_000).then((a) => a.outcome);
  sendCommand({ t: 'spawn', op_id: 'op-e2e-spawn-4', run_id: 'run-e2e-4', generation: 1, attempt: 1, harness: 'claude', model: 'sonnet', target: { id: 'e2e', branch: 'eri/e2e-4' }, prompt: 'verify me', verify: { verify_id: 'slowls', plan_revision: 5 } });
  const { surf, incarnation } = await surfOf('op-e2e-spawn-4');
  await outcome('op-e2e-spawn-4');
  // The stub's first Stop is turn 1: 2 s later the configured verify runs.
  const v1 = await eri.waitFor('verify.result', (f) => f.run_id === 'run-e2e-4' && f.turn_seq === 1, 20_000).catch(() => null);
  ok(v1 && /^local:[0-9a-f-]{36}$/.test(v1.attempt_id) && v1.generation === 1 && v1.plan_revision === 5 && v1.verify_id === 'slowls' && v1.initiator === 'host'
    && v1.exit_code === 0 && v1.tail.includes('README.md') && v1.stale_workspace === false && v1.workspace?.branch === 'eri/e2e-4', `a root turn triggers verify → verify.result with the turn's tuple (${JSON.stringify(v1 && { ...v1, tail: undefined })})`);
  const st1 = JSON.parse(cli('status', '--json')).sessions.find((x) => x.id === surf);
  ok(st1?.verify?.attemptId === v1?.attempt_id && st1.verify.state === 'passed' && typeof st1.verify.startedAt === 'number', 'status --json: verify {attemptId, state, startedAt}');

  // Turn 2 → its attempt starts; turn 3 arrives while it runs and cancels it.
  const fence = { surf, incarnation, run_id: 'run-e2e-4', generation: 1 };
  sendCommand({ t: 'input', op_id: 'op-e2e-d-in-1', mode: 'queue', text: 'second turn', ...fence });
  await outcome('op-e2e-d-in-1');
  const t0 = Date.now();
  let running = null;
  while (Date.now() - t0 < 15_000) {
    const v = JSON.parse(cli('status', '--json')).sessions.find((x) => x.id === surf)?.verify;
    if (v?.state === 'running' && v.attemptId !== v1?.attempt_id) {
      running = v;
      break;
    }
    await sleep(100);
  }
  ok(!!running, 'the second turn\'s attempt is running');
  sendCommand({ t: 'input', op_id: 'op-e2e-d-in-2', mode: 'queue', text: 'third turn', ...fence });
  const canceled = await eri.waitFor('verify.result', (f) => f.run_id === 'run-e2e-4' && f.turn_seq === 2, 15_000).catch(() => null);
  ok(canceled?.canceled === true && canceled.attempt_id === running?.attemptId, 'a newer turn cancels the running attempt (verify.result canceled:true)');
  const v3 = await eri.waitFor('verify.result', (f) => f.run_id === 'run-e2e-4' && f.turn_seq === 3, 20_000).catch(() => null);
  ok(v3?.exit_code === 0 && v3.canceled === false && v3.attempt_id !== canceled?.attempt_id, 'the newer turn is verified');
  const turns = [...new Map(eri.of('turn', (f) => f.surf === surf).map((f) => [f.op_id, f.seq])).values()];
  ok(JSON.stringify(turns) === '[1,2,3]', `one turn per logical turn (${turns})`);

  // An Eridani verify for the turn just verified, tree unchanged: the result again under Eridani's id, no second run.
  sendCommand({ t: 'verify', op_id: 'op-e2e-d-verify', attempt_id: 'att-d-3', run_id: 'run-e2e-4', generation: 1, turn_seq: 3, plan_revision: 5, verify_id: 'slowls' });
  const again = await eri.waitFor('verify.result', (f) => f.attempt_id === 'att-d-3', 15_000).catch(() => null);
  ok(again?.adopted === v3?.attempt_id && again.initiator === 'eridani' && again.duration_ms === v3?.duration_ms, 'an Eridani verify for the same tuple reuses the host attempt');

  sendCommand({ t: 'stop', op_id: 'op-e2e-d-stop', mode: 'interrupt', ...fence });
  await outcome('op-e2e-d-stop');
}

/**
 * E2E_REAL_CLAUDE=1: one short real `claude --model sonnet` session, started
 * by a spawn, asks AskUserQuestion; the fake Eridani answers it. Project-level
 * hooks only (the throwaway repo's .claude/settings.json); the repo lives under
 * the stage A spike's trusted folder so no trust dialog is needed.
 */
/** Stage E: the collector cutover through the CLI, against the running server (config watch, ≤30 s). */
async function stageE() {
  ok(JSON.parse(cli('status', '--json')).version === 1, 'status --json is v1 while the collector is in parity mode');
  const before = eri.frames.length;
  const out = cli('eridani', 'collector', 'authoritative');
  ok(/parity → authoritative/.test(out) && out.includes('systemctl --user disable --now eridani-collector.timer'), 'remotea eridani collector authoritative switches and prints the checklist');
  const st = JSON.parse(cli('status', '--json'));
  ok(st.version === 2 && st.server.collector === 'authoritative', 'status --json turns v2 (the Python collector refuses it)');
  const hello = await eri.waitFor('hello', (f) => eri.frames.indexOf(f) >= before, 40_000).catch(() => null);
  ok(hello?.caps.includes('collector.authoritative'), 'the server reconnects advertising collector.authoritative');
  const stored = await eri.waitFor('session.report', (f) => eri.frames.indexOf(f) >= before && f.parity === false, 20_000).catch(() => null);
  ok(stored?.report?.machine === 'e2e-box', 'every source is sent again without the parity flag');
  cli('eridani', 'collector', 'parity');
  ok(JSON.parse(cli('status', '--json')).version === 1, 'back to parity: status --json v1');
}

async function realQuestion() {
  const { applyWmuxHooks } = await import(path.join(root, 'dist/src/shared/claude-hooks.js'));
  const base = process.env.E2E_REAL_ROOT || '/home/davin/remotea/spike-stage-a/testrepo';
  const at = fs.mkdtempSync(path.join(base, 'stagec-e2e-'));
  try {
    const repo = throwawayRepo(path.join(at, 'repo'), applyWmuxHooks({}, HOOK_JS, { questions: true }));
    cli('eridani', 'targets', 'add', '--json', JSON.stringify({ id: 'real', repo, worktreeRoot: path.join(at, 'wt'), base: 'main', launch: { claude: {} }, verify: [] }));
    const prompt = 'Use the AskUserQuestion tool exactly once to ask me "Which colour should we use?" with the options Red and Blue (single choice). After I answer, reply with only the colour I chose, then stop.';
    const sp = sendCommand({ t: 'spawn', op_id: 'op-real-1', run_id: 'run-real-1', generation: 1, attempt: 1, harness: 'claude', model: 'sonnet', target: { id: 'real', branch: 'eri/real-1' }, prompt });
    const surf = (await sp.waitAck()).outcome.surf;
    const so = await outcome('op-real-1');
    ok(so.state === 'executed', 'real: claude spawned');
    // Watch the screen; accept a workspace-trust dialog once if the folder is new to Claude.
    const W = new Client('watch-real');
    await W.connect();
    W.send({ t: 'open', rid: W.rid++, id: surf, cols: 120, rows: 40 });
    await W.wait((m) => m.t === 'opened' && m.id === surf);
    let trusted = false;
    const watcher = setInterval(() => {
      // The screen is drawn with cursor moves, so spaces may be missing; "No, exit" is preselected.
      if (!trusted && /Yes,\s*I\s*trust\s*this\s*folder/i.test(W.text(surf).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''))) {
        trusted = true;
        W.input(surf, '\x1b[B');
        setTimeout(() => W.input(surf, '\r'), 300);
      }
    }, 500);
    const q = await eri.waitFor('question', (f) => f.surf === surf, 120_000).catch(() => null);
    ok(q?.provider === 'claude' && q.items?.[0]?.choices?.length >= 2, 'real: AskUserQuestion held and sent as question');
    if (!q) {
      clearInterval(watcher);
      console.log(`real: screen tail:\n${W.text(surf).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').slice(-2500)}`);
      return;
    }
    const blue = q.items[0].choices.find((c) => /blue/i.test(c.label)) ?? q.items[0].choices[1];
    sendCommand({ t: 'answer', op_id: 'op-real-ans', question_id: q.question_id, provider_request_id: q.provider_request_id, answers: [{ item_id: q.items[0].id, choice_ids: [blue.id] }] });
    const ao = await outcome('op-real-ans');
    ok(ao.state === 'executed' && ao.result?.state === 'submitted', 'real: answer submitted to the held hook');
    const res = await eri.waitFor('question.resolved', (f) => f.question_id === q.question_id, 60_000).catch(() => null);
    ok(res?.outcome === 'accepted', `real: PostToolUse confirmed the answer (${res?.outcome})`);
    const turn = await eri.waitFor('turn', (f) => f.surf === surf && /blue/i.test(f.text), 120_000).catch(() => null);
    ok(!!turn, 'real: the final answer names the chosen colour');
    sendCommand({ t: 'stop', op_id: 'op-real-stop', mode: 'interrupt', surf, incarnation: (await sp.waitAck()).outcome.incarnation, run_id: 'run-real-1', generation: q.generation });
    const stopped = await outcome('op-real-stop').catch(() => null);
    if (stopped?.state !== 'executed') sendCommand({ t: 'stop', op_id: 'op-real-kill', mode: 'kill', surf, incarnation: (await sp.waitAck()).outcome.incarnation, run_id: 'run-real-1', generation: q.generation });
    clearInterval(watcher);
    if (process.env.E2E_REAL_SCREEN) fs.writeFileSync(process.env.E2E_REAL_SCREEN, W.text(surf));
    W.close();
  } finally {
    // The worktree is git-registered in the throwaway repo, which goes with it.
    fs.rmSync(at, { recursive: true, force: true });
  }
}
process.exit(failures ? 1 : 0);
