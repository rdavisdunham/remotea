#!/usr/bin/env node
/**
 * Capability test for the Codex question adapters (harness-adapters.ts), run
 * against the INSTALLED Codex CLI. Re-run it after a Codex update before
 * widening the tested range in harness-adapters.ts.
 *
 *   node remote-server/scripts/capability-codex.mjs [--codex /path/to/codex] [--keep]
 *
 * Nothing real is touched: a scratch CODEX_HOME (fake model provider, test
 * hooks), a scratch work folder, and a local fake Responses API that scripts
 * the model. The real Codex TUI runs in a PTY exactly as a remotea session
 * runs it (`--disable daemon_auto_start`). No account, no network, no
 * ~/.codex. Each scenario is a short session that is killed at its end.
 *
 * Scenarios and what passes:
 *   approval-allow   the PermissionRequest hook prints decision allow → the command runs, no prompt
 *   approval-deny    decision deny + message → "Blocked by hook", the command does not run
 *   approval-none    the hook prints nothing → Codex shows its own approval prompt
 *   approval-timeout the hook outlives its timeout → Codex shows its own approval prompt
 *   held-screen      while the hook holds, the TUI shows "Running hook" and no prompt
 *   question-pre     request_user_input (Default mode, feature enabled): PreToolUse fires with
 *                    tool_input.questions, but updatedInput does NOT answer it (expected: still asks)
 */
import { spawn as cpSpawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const pty = require(path.join(here, '..', 'node_modules', 'node-pty'));
const { Terminal } = require(path.join(here, '..', 'node_modules', '@xterm', 'headless'));

const argv = process.argv.slice(2);
const CODEX = argv.includes('--codex') ? argv[argv.indexOf('--codex') + 1] : 'codex';
const KEEP = argv.includes('--keep');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'remotea-capability-codex-'));

const HOOK = `
const fs = require('fs');
let d = '';
process.stdin.on('data', (c) => (d += c));
process.stdin.on('end', () => {
  const ev = process.argv[2];
  let p = {};
  try { p = JSON.parse(d || '{}'); } catch {}
  fs.appendFileSync(process.env.HOOKLOG, JSON.stringify({ ev, t: Date.now(), p }) + '\\n');
  const hold = ev === 'PermissionRequest' ? +(process.env.HOLD_MS || 0) : 0;
  setTimeout(() => {
    const dec = process.env.DECISION;
    if (ev === 'PermissionRequest' && dec) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: dec === 'deny' ? { behavior: 'deny', message: 'denied by capability test' } : { behavior: 'allow' } } }));
    if (ev === 'PreToolUse' && process.env.PRE_ANSWER && p.tool_name === 'request_user_input') process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { ...p.tool_input, answers: { color: { answers: ['Blue'] } } } } }));
    process.exit(0);
  }, hold);
});`;

/** A fake Responses API: the first request gets the scripted tool call, the next a final message. */
function fakeModel(script, marker) {
  let n = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (!/responses/.test(req.url)) { res.writeHead(404); res.end('{}'); return; }
      n++;
      let j = {};
      try { j = JSON.parse(body); } catch {}
      const tools = (j.tools || []).map((t) => t.name || t.type);
      const outputs = (j.input || []).filter((i) => i.type === 'function_call_output');
      let item;
      if (!outputs.length && script === 'approval') {
        const name = tools.includes('shell_command') ? 'shell_command' : tools.includes('exec_command') ? 'exec_command' : 'shell';
        const cmd = `touch ${marker}`;
        const args = name === 'shell' ? { command: ['bash', '-lc', cmd] } : name === 'exec_command' ? { cmd } : { command: cmd };
        item = { type: 'function_call', id: 'fc_' + n, call_id: 'call_' + n, name, arguments: JSON.stringify({ ...args, sandbox_permissions: 'require_escalated', justification: 'capability test' }) };
      } else if (!outputs.length && script === 'question' && tools.includes('request_user_input')) {
        item = { type: 'function_call', id: 'fc_' + n, call_id: 'call_' + n, name: 'request_user_input', arguments: JSON.stringify({ questions: [{ id: 'color', header: 'Color', question: 'Which color?', options: [{ label: 'Red (Recommended)', description: 'warm' }, { label: 'Blue', description: 'cool' }] }] }) };
      } else {
        item = { type: 'message', role: 'assistant', id: 'msg_' + n, content: [{ type: 'output_text', text: outputs.length ? 'CAPABILITY DONE' : 'CAPABILITY NO TOOL', annotations: [] }] };
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const e of [
        { type: 'response.created', response: { id: 'resp_' + n } },
        { type: 'response.output_item.done', item },
        { type: 'response.completed', response: { id: 'resp_' + n, usage: { input_tokens: 1, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 2 } } },
      ]) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
      res.end();
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, port: server.address().port })));
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function scenario(name, o) {
  const dir = path.join(ROOT, name);
  const home = path.join(dir, 'codex-home');
  const work = path.join(dir, 'work');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(work, { recursive: true });
  const marker = path.join(dir, 'marker');
  const hookFile = path.join(dir, 'hook.cjs');
  const hookLog = path.join(dir, 'hooks.log');
  fs.writeFileSync(hookFile, HOOK);
  const { server, port } = await fakeModel(o.question ? 'question' : 'approval', marker);
  fs.writeFileSync(path.join(home, 'config.toml'), [
    'model = "fake-model"', 'model_provider = "fake"', 'approval_policy = "on-request"', 'sandbox_mode = "read-only"', 'check_for_update_on_startup = false',
    '[model_providers.fake]', 'name = "fake"', `base_url = "http://127.0.0.1:${port}/v1"`, 'wire_api = "responses"', 'requires_openai_auth = false', 'stream_max_retries = 0', 'request_max_retries = 0',
    `[projects."${work}"]`, 'trust_level = "trusted"', '',
  ].join('\n'));
  const entry = (ev, timeout) => [{ hooks: [{ type: 'command', command: `node "${hookFile}" ${ev}`, timeout }] }];
  fs.writeFileSync(path.join(home, 'hooks.json'), JSON.stringify({ hooks: {
    PermissionRequest: entry('PermissionRequest', o.hookTimeout ?? 60), PreToolUse: entry('PreToolUse', 30), PostToolUse: entry('PostToolUse', 30), Stop: entry('Stop', 30), UserPromptSubmit: entry('UserPromptSubmit', 30),
  } }));
  const env = { ...process.env, CODEX_HOME: home, HOOKLOG: hookLog, DECISION: o.decision ?? '', HOLD_MS: String(o.holdMs ?? 0), PRE_ANSWER: o.preAnswer ? '1' : '', TERM: 'xterm-256color' };
  delete env.OPENAI_API_KEY;
  const args = ['--disable', 'daemon_auto_start', ...(o.question ? ['--enable', 'default_mode_request_user_input'] : []), o.question ? 'Ask me which color I want.' : 'Please touch the marker file.'];
  const term = new Terminal({ cols: 120, rows: 40, allowProposedApi: true });
  const p = pty.spawn(CODEX, args, { name: 'xterm-256color', cols: 120, rows: 40, cwd: work, env });
  p.onData((d) => term.write(d));
  term.onData((d) => p.write(d));
  const screen = () => { const b = term.buffer.active; const out = []; for (let i = 0; i < b.length; i++) out.push(b.getLine(i).translateToString(true)); return out.join('\n'); };
  const seen = [];
  let trusted = false;
  for (let i = 0; i < (o.seconds ?? 25); i++) {
    await wait(1000);
    const s = screen();
    seen.push(s);
    // The test hooks are new to this scratch CODEX_HOME: trust them (0.166 asks once per changed hook).
    if (/Hooks need review/.test(s) && !trusted) { trusted = true; p.write('2'); await wait(300); p.write('\r'); }
    if (/CAPABILITY DONE|CAPABILITY NO TOOL|Would you like to run|Question 1\/1/.test(s) && i > 2) { await wait(1500); seen.push(screen()); break; }
  }
  try { p.kill('SIGKILL'); } catch {}
  server.close();
  const hooks = fs.existsSync(hookLog) ? fs.readFileSync(hookLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  return { last: seen.at(-1) ?? '', all: seen.join('\n'), marker: fs.existsSync(marker), hooks };
}

const results = [];
const check = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`); };

const version = await new Promise((r) => { const c = cpSpawn(CODEX, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] }); let s = ''; c.stdout.on('data', (d) => (s += d)); c.on('close', () => r(s.trim())); c.on('error', () => r('')); });
console.log(`codex: ${version || '(not found)'}; scratch: ${ROOT}`);
if (!version) process.exit(2);

{
  const r = await scenario('approval-allow', { decision: 'allow', holdMs: 3000 });
  const pr = r.hooks.find((h) => h.ev === 'PermissionRequest');
  check('approval-allow', r.marker && !/Would you like to run/.test(r.all) && !!pr, `ran=${r.marker} prompt_shown=${/Would you like to run/.test(r.all)}`);
  check('payload', !!pr && pr.p.tool_name === 'Bash' && typeof pr.p.tool_input?.command === 'string' && typeof pr.p.turn_id === 'string' && !('tool_use_id' in pr.p),
    `PermissionRequest keys: ${pr ? Object.keys(pr.p).sort().join(',') : 'none'}`);
  check('held-screen', /Running hook/.test(r.all), 'TUI says "Running hook" while the hook holds');
  const stop = r.hooks.find((h) => h.ev === 'Stop');
  check('stop-capture', !!stop && typeof stop.p.last_assistant_message === 'string' && stop.p.turn_id === pr?.p.turn_id, 'Stop has last_assistant_message and the turn_id');
}
{
  const r = await scenario('approval-deny', { decision: 'deny' });
  check('approval-deny', !r.marker && /Blocked by hook/.test(r.all), `ran=${r.marker} blocked=${/Blocked by hook/.test(r.all)}`);
}
{
  const r = await scenario('approval-none', {});
  check('approval-none', !r.marker && /Would you like to run the following command\?/.test(r.last), 'no decision → Codex prompt');
}
{
  const r = await scenario('approval-timeout', { decision: 'allow', holdMs: 30000, hookTimeout: 3, seconds: 30 });
  check('approval-timeout', !r.marker && /Would you like to run the following command\?/.test(r.last), 'hook timed out → Codex prompt');
}
{
  const r = await scenario('question-pre', { question: true, preAnswer: true });
  const pre = r.hooks.find((h) => h.ev === 'PreToolUse' && h.p.tool_name === 'request_user_input');
  check('question-pre (expected: not answerable)', !!pre && /Question 1\/1/.test(r.last), `PreToolUse fired=${!!pre}; still asking in the TUI=${/Question 1\/1/.test(r.last)}`);
}

if (!KEEP) fs.rmSync(ROOT, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\n${failed.length} FAILED on ${version}` : `\nall passed on ${version}`);
process.exit(failed.length ? 1 : 0);
