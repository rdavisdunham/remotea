/**
 * The hook bridge: where agents running in remotea sessions report status.
 *
 * remotea's hook helper (`remotea-hook.js`, registered in Claude Code's and Codex's
 * hook settings) and its plugins talk to the app over a named pipe — which a
 * process in WSL cannot reach. They already know a second transport, built for
 * devcontainers (`REMOTEA_REMOTE` + `REMOTEA_REMOTE_TOKEN`, remotea issue #19): one line
 * of JSON-RPC over TCP, `{method, params, id, token}`, answered with one line.
 * This listener speaks that, on loopback, and hands what it accepts to the hub,
 * which relays it to every app showing the session.
 *
 * Every session is told the address and a token of its own,
 * HMAC(hook secret, session id). A request is accepted only for the session
 * its token was issued to (params.surfaceId), and only for the agent-status
 * methods in RELAYED_RPC_METHODS — reporting status for oneself is all a
 * session's token can do. The main server token, which is shell access, never
 * enters a session's environment.
 *
 * Two methods are answered later rather than at once, for the same session's
 * token only (stage C, Eridani):
 *   remotea.question  AskUserQuestion's PreToolUse hook HOLDS here until
 *                     Eridani answers (questions-claude.ts); the reply carries
 *                     the answers to print, or nothing. While a request is
 *                     held the connection is exempt from the idle timeout, and
 *                     its closing (Claude killed the hook) is reported.
 *   remotea.approval  Codex's PermissionRequest hook HOLDS here the same way
 *                     (questions-claude.ts holdApproval); the reply carries
 *                     the decision to print (allow / deny), or nothing.
 *   remotea.context   SessionStart's text for the agent (context.ts).
 */
import crypto from 'crypto';
import net from 'net';
import { RELAYED_RPC_METHODS } from '../../src/shared/remote-host-protocol';

/** Long enough for a UserPromptSubmit carrying a pasted file (remotea-hook caps the prompt itself). */
const MAX_LINE = 2 * 1024 * 1024;
/** A client that connects and says nothing is dropped after this. */
const IDLE_MS = 10_000;

export function hookToken(secret: string, sessionId: string): string {
  return crypto.createHmac('sha256', secret).update(`remotea-hook:${sessionId}`).digest('base64url').slice(0, 43);
}

function tokenMatches(given: string, expected: string): boolean {
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

export interface HookBridgeDeps {
  secret: string;
  /** Relay an accepted report; false when the session is not live here. */
  relay: (sessionId: string, method: string, params: Record<string, unknown>) => boolean;
  /** Hold an AskUserQuestion; `closed` registers a callback for the helper going away. */
  question?: (sessionId: string, params: Record<string, unknown>, closed: (cb: () => void) => void) => Promise<unknown>;
  /** Hold a Codex PermissionRequest; same contract as `question`. */
  approval?: (sessionId: string, params: Record<string, unknown>, closed: (cb: () => void) => void) => Promise<unknown>;
  /** SessionStart context text. */
  context?: (sessionId: string, params: Record<string, unknown>) => Promise<string>;
  log?: (msg: string) => void;
}

/** Methods answered asynchronously (see the header). */
export const HELD_METHODS: ReadonlySet<string> = new Set(['remotea.question', 'remotea.approval', 'remotea.context']);

export type BridgeReply = { result?: unknown; error?: { code: number; message: string }; id?: unknown };

/**
 * Decide one request. Pure apart from the deps, so it is tested without
 * sockets. Async for the held methods; everything else resolves at once.
 */
export async function handleBridgeRequest(deps: HookBridgeDeps, raw: unknown, closed: (cb: () => void) => void = () => {}): Promise<BridgeReply> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: { code: -32700, message: 'Parse error' } };
  const req = raw as { method?: unknown; params?: unknown; id?: unknown; token?: unknown };
  const id = typeof req.id === 'string' || typeof req.id === 'number' ? req.id : undefined;
  const method = typeof req.method === 'string' ? req.method : '';
  // Discovery, answered here: the remotea CLI identifies what it is talking to.
  if (method === 'system.identify') return { result: { name: 'remotea', platform: 'linux' }, id };
  if (method === 'system.capabilities') return { result: { protocols: ['v2'], features: ['status'] }, id };
  const held = HELD_METHODS.has(method);
  if (!RELAYED_RPC_METHODS.has(method) && !held) return { error: { code: -32601, message: `Method not relayed by remotea: ${method}` }, id };
  const params = req.params && typeof req.params === 'object' && !Array.isArray(req.params) ? (req.params as Record<string, unknown>) : null;
  const surfaceId = typeof params?.surfaceId === 'string' ? params.surfaceId : '';
  const token = typeof req.token === 'string' ? req.token : '';
  if (!params || !/^surf-[A-Za-z0-9_-]{1,96}$/.test(surfaceId) || !tokenMatches(token, hookToken(deps.secret, surfaceId))) {
    return { error: { code: -32001, message: 'Unauthorized' }, id };
  }
  if (held) {
    try {
      if (method === 'remotea.question') {
        if (!deps.question) return { result: { reason: 'unsupported' }, id };
        return { result: await deps.question(surfaceId, params, closed), id };
      }
      if (method === 'remotea.approval') {
        if (!deps.approval) return { result: { reason: 'unsupported' }, id };
        return { result: await deps.approval(surfaceId, params, closed), id };
      }
      if (!deps.context) return { result: { text: '' }, id };
      return { result: { text: await deps.context(surfaceId, params) }, id };
    } catch (err) {
      return { error: { code: -32000, message: (err as Error).message.slice(0, 200) }, id };
    }
  }
  if (!deps.relay(surfaceId, method, params)) return { error: { code: -32000, message: 'No such live session' }, id };
  return { result: { ok: true }, id };
}

export class HookBridge {
  private server: net.Server | null = null;

  constructor(private readonly deps: HookBridgeDeps) {}

  listen(port: number, host = '127.0.0.1'): Promise<number> {
    const server = net.createServer((sock) => this.serve(sock));
    this.server = server;
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        resolve((server.address() as net.AddressInfo).port);
      });
    });
  }

  close(): Promise<void> {
    const server = this.server;
    this.server = null;
    return new Promise((resolve) => (server ? server.close(() => resolve()) : resolve()));
  }

  private serve(sock: net.Socket): void {
    sock.setEncoding('utf8');
    let pending = 0;
    sock.setTimeout(IDLE_MS, () => {
      if (!pending) sock.destroy();
    });
    const onClose: Array<() => void> = [];
    sock.on('close', () => {
      for (const cb of onClose.splice(0)) cb();
    });
    let buf = '';
    sock.on('data', (chunk: string) => {
      buf += chunk;
      if (buf.length > MAX_LINE) {
        sock.destroy();
        return;
      }
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let raw: unknown;
        try {
          raw = JSON.parse(line);
        } catch {
          sock.write(JSON.stringify({ error: { code: -32700, message: 'Parse error' } }) + '\n');
          continue;
        }
        pending++;
        void handleBridgeRequest(this.deps, raw, (cb) => onClose.push(cb)).then((reply) => {
          pending--;
          if (reply.error && reply.error.code === -32001) this.deps.log?.('hook bridge: rejected a request with a bad token');
          if (!sock.destroyed) sock.write(JSON.stringify(reply) + '\n');
        });
      }
    });
    sock.on('error', () => sock.destroy());
  }
}

/**
 * The environment that points a session's hooks at the bridge. `cli`: where
 * the remotea CLI and a Node to run it are — the OpenCode plugin (and the other
 * remotea plugins) report through `node $REMOTEA_CLI <command>`.
 */
export function hookEnv(secret: string, port: number, sessionId: string, cli?: { cliPath: string; nodePath: string }): Record<string, string> {
  return {
    // remotea-hook.js and the remotea CLI read these (see the header).
    REMOTEA: '1',
    REMOTEA_SURFACE_ID: sessionId,
    REMOTEA_REMOTE: `127.0.0.1:${port}`,
    REMOTEA_REMOTE_TOKEN: hookToken(secret, sessionId),
    ...(cli ? { REMOTEA_CLI: cli.cliPath, REMOTEA_NODE: cli.nodePath } : {}),
  };
}
