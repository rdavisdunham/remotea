import { describe, it, expect } from 'vitest';
import { execFile } from 'child_process';
import net from 'net';
import os from 'os';
import path from 'path';

/**
 * Issue #399: a permission prompt is retracted once the main thread's tool
 * calls show the agent moved past it, which needs the hook helper to forward
 * Claude Code's `tool_use_id`, and only for calls remotea can attribute.
 */

const HOOK_SCRIPT = path.resolve(__dirname, '../../resources/cli/remotea-hook.js');

function runHook(args: string[], port: number, stdin: string): Promise<void> {
  const env = {
    ...process.env,
    REMOTEA_REMOTE: `127.0.0.1:${port}`,
    REMOTEA_REMOTE_TOKEN: 't',
    REMOTEA_SURFACE_ID: 'surf-tool-id',
  } as Record<string, string>;
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [HOOK_SCRIPT, ...args], { env, timeout: 15000 }, (err) => {
      if (err) reject(err);
      else resolve();
    });
    child.stdin?.end(stdin);
  });
}

/** One hook process → the `hook.event` params it sent. */
async function hookParams(args: string[], payload: unknown): Promise<Record<string, any>> {
  let deliver!: (frame: any) => void;
  const frame = new Promise<any>((r) => { deliver = r; });
  const server = net.createServer((socket) => {
    let data = '';
    socket.on('data', (chunk) => {
      data += chunk.toString();
      if (!data.includes('\n')) return;
      deliver(JSON.parse(data.trim()));
      socket.end();
    });
  });
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', () => ready()));
  const addr = server.address();
  try {
    await runHook(args, typeof addr === 'object' && addr ? addr.port : 0, JSON.stringify(payload));
    return (await frame).params;
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
}

describe('remotea-hook.js tool_use_id (#399)', () => {
  it('forwards it on a PreToolUse', async () => {
    const params = await hookParams(['--event', 'PreToolUse'], {
      hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'toolu_01AbC',
    });
    expect(params.toolUseId).toBe('toolu_01AbC');
  });

  it('forwards it on a bare-tool PostToolUse', async () => {
    const params = await hookParams(['Bash'], {
      hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'toolu_01AbC',
    });
    expect(params.toolUseId).toBe('toolu_01AbC');
  });

  it('drops a value that is not an identifier', async () => {
    const params = await hookParams(['--event', 'PreToolUse'], {
      hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'not an id\n',
    });
    expect(params.toolUseId).toBeUndefined();
  });

  it('still gives a remotea server the id from a Grok subagent session, which matches questions by it', async () => {
    const params = await hookParams(['--event', 'PreToolUse'], {
      hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'toolu_01AbC', subagentType: 'explore',
    });
    expect(params.toolUseId).toBe('toolu_01AbC');
  });
});

/**
 * The desktop path: a local pane reports over the pipe with no REMOTEA_REMOTE.
 * The ledger that retracts a stale permission block lives in the desktop's
 * agent-hook-bridge, so the id has to arrive here, not only at a server.
 */
async function pipeHookParams(payload: unknown): Promise<Record<string, any>> {
  const name = `remotea-tool-id-${process.pid}-${process.hrtime.bigint()}`;
  const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\${name}` : path.join(os.tmpdir(), `${name}.sock`);
  let deliver!: (frame: any) => void;
  const frame = new Promise<any>((r) => { deliver = r; });
  const server = net.createServer((socket) => {
    let data = '';
    socket.on('data', (chunk) => {
      data += chunk.toString();
      if (!data.includes('\n')) return;
      deliver(JSON.parse(data.trim()));
      socket.end('{"id":1,"result":true}\n');
    });
    socket.on('error', () => {});
  });
  await new Promise<void>((ready) => server.listen(pipe, () => ready()));
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('REMOTEA')));
  const env = { ...base, REMOTEA: '1', REMOTEA_PIPE: pipe, REMOTEA_PIPE_TOKEN: 't', REMOTEA_SURFACE_ID: 'surf-tool-id' } as Record<string, string>;
  try {
    await new Promise<void>((resolve, reject) => {
      const child = execFile(process.execPath, [HOOK_SCRIPT, '--event', 'PreToolUse'], { env, timeout: 15000 }, (err) => {
        if (err) reject(err);
        else resolve();
      });
      child.stdin?.end(JSON.stringify(payload));
    });
    return (await frame).params;
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
}

describe('remotea-hook.js tool_use_id over the local pipe (#399)', () => {
  it('forwards it to the desktop', async () => {
    const params = await pipeHookParams({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'toolu_01AbC' });
    expect(params.toolUseId).toBe('toolu_01AbC');
  });

  it('drops it inside a Grok subagent session, which carries no agent_id', async () => {
    const params = await pipeHookParams({
      hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'toolu_01AbC', subagentType: 'explore',
    });
    expect(params.toolUseId).toBeUndefined();
  });
});
