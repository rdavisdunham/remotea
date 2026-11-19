// remotea-plugin-version: 3
// wmux plugin for the Antigravity CLI (agy) — tells wmux which conversation
// each pane holds, so a restored tab can reopen it with `agy --conversation`.
// Auto-installed by wmux to ~/.gemini/config/plugins/remotea/. Does nothing outside
// a wmux pane.
//
// agy runs it as `node remotea-agy-hook.cjs <Event>` from this directory (a hook's
// working directory is the folder holding its hooks.json). The command carries
// no path and no quotes on purpose: agy 1.4 hands a quoted argument to node with
// its quotes still on, so `node "C:\...\x.cjs"` cannot be found.
//
// Registered for two events, because neither alone covers both ways in:
//   SessionStart   a NEW conversation; does not fire on `--conversation <id>`
//   PreInvocation  before each model call — the first sign of life of a
//                  resumed conversation, and of one switched to with /resume
// agy waits for every hook and expects a JSON object on stdout, so this always
// prints `{}` and never takes long: one pipe round trip, bounded.
'use strict';

const net = require('net');

/** Mirrors AGY_CONVERSATION_ID_RE in wmux's src/main/agy-resume.ts. */
const CONVERSATION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** agy's payload is a few hundred bytes; anything past this is not one. */
const MAX_STDIN = 1024 * 1024;
const STDIN_DEADLINE_MS = 1000;
const PIPE_DEADLINE_MS = 1500;

const env = process.env;
const event = process.argv[2] || '';
let finished = false;

/** The answer agy expects, then leave — after the write has gone out. */
function finish() {
  if (finished) return;
  finished = true;
  process.stdout.write('{}', () => process.exit(0));
}

/**
 * Only a pane of THIS wmux: it always exports REMOTEA=1 and REMOTEA_PIPE beside the
 * surface id. Another app also named wmux sets a surface id and neither of
 * those (#282), and agy started anywhere else has no surface id at all.
 */
function inRemoteaPane(e) {
  return !!e.REMOTEA_SURFACE_ID && (e.REMOTEA === '1' || !!e.REMOTEA_PIPE);
}

/**
 * The conversation to report, or null. PreInvocation fires before EVERY model
 * call of a turn; only the first (`invocationNum` 0, or absent) says anything
 * the previous report did not.
 */
function conversationToReport(raw, fired) {
  let data;
  try { data = JSON.parse(raw); } catch { return null; }
  if (!data || typeof data !== 'object') return null;
  if (fired === 'PreInvocation' && Number(data.invocationNum || 0) > 0) return null;
  const id = data.conversationId;
  return typeof id === 'string' && CONVERSATION_ID_RE.test(id) ? id : null;
}

/**
 * Where to send the report: wmux's named pipe, or — in a pane whose shell runs
 * elsewhere (a devcontainer, a remotea session in WSL) — the TCP endpoint in
 * REMOTEA_REMOTE, with its own token, the transport remotea-hook.js also speaks.
 */
function endpoint(e) {
  const m = /^\[?([^\]]+?)\]?:(\d{1,5})$/.exec((e.REMOTEA_REMOTE || '').trim());
  if (m) return { connect: { host: m[1], port: Number(m[2]) }, token: e.REMOTEA_REMOTE_TOKEN || '' };
  const instance = (e.REMOTEA_INSTANCE || '').trim();
  return {
    connect: { path: e.REMOTEA_PIPE || '\\\\.\\pipe\\remotea' + (instance ? '-' + instance : '') },
    token: e.REMOTEA_PIPE_TOKEN || '',
  };
}

function report(conversationId) {
  const target = endpoint(env);
  const frame = JSON.stringify({
    method: 'pane.report_agent_session',
    params: { surfaceId: env.REMOTEA_SURFACE_ID, sessionId: conversationId, provider: 'agy' },
    id: 1,
    token: target.token,
  });
  const client = net.connect(target.connect, () => client.write(frame + '\n'));
  const deadline = setTimeout(() => { client.destroy(); finish(); }, PIPE_DEADLINE_MS);
  // The reply is the signal to leave; its content changes nothing here.
  client.on('data', () => { clearTimeout(deadline); client.destroy(); finish(); });
  client.on('error', () => { clearTimeout(deadline); finish(); });
}

if (require.main === module) {
  if (!inRemoteaPane(env) || (event !== 'SessionStart' && event !== 'PreInvocation')) {
    finish();
  } else {
    let raw = '';
    let ended = false;
    const onEnd = () => {
      if (ended) return;
      ended = true;
      clearTimeout(stdinTimer);
      process.stdin.pause();
      const id = conversationToReport(raw, event);
      if (id) report(id); else finish();
    };
    const stdinTimer = setTimeout(onEnd, STDIN_DEADLINE_MS);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { if (raw.length < MAX_STDIN) raw += chunk; });
    process.stdin.on('end', onEnd);
    process.stdin.on('error', onEnd);
  }
}

module.exports = { conversationToReport, inRemoteaPane, endpoint };
