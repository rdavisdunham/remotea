/**
 * Transport: HTTP + WebSocket listeners with authentication, wired to a Hub.
 *
 * Who may connect:
 *   - a bearer token (`Authorization: Bearer <token>`), compared in constant
 *     time on its SHA-256 digest;
 *   - no `Origin` header at all. Browsers always send one on a WebSocket
 *     handshake and the remotea app (Node `ws` in Electron main) never does,
 *     so this shuts out web pages, including DNS-rebinding tricks;
 *   - an IP that has not failed authentication 10 times in the last minute.
 * The listeners bind only the configured addresses (loopback + Tailscale by
 * default), never every interface.
 */
import http from 'http';
import crypto from 'crypto';
import type { Duplex } from 'stream';
import { WebSocketServer, type WebSocket, type RawData } from 'ws';
import { BIN_INPUT, decodeFrame, parseClientMsg, LIMITS, type ServerMsg } from '../../src/shared/remote-host-protocol';
import type { Hub, HubConn } from './hub';
import { MAX_UPLOAD_BYTES, receiveUpload } from './upload';

export const MAX_PAYLOAD = 16 * 1024 * 1024;
const HELLO_TIMEOUT_MS = 10_000;
const PING_MS = 15_000;
const BAN_WINDOW_MS = 60_000;
const BAN_THRESHOLD = 10;

const digest = (s: string) => crypto.createHash('sha256').update(s).digest();

export function tokenMatches(header: string | undefined, token: string): boolean {
  if (!header) return false;
  const m = /^Bearer\s+(\S+)$/.exec(header);
  if (!m) return false;
  return crypto.timingSafeEqual(digest(m[1]), digest(token));
}

export class FailureTracker {
  private readonly failures = new Map<string, number[]>();
  constructor(private readonly now: () => number = Date.now) {}

  banned(ip: string): boolean {
    return this.recent(ip).length >= BAN_THRESHOLD;
  }

  fail(ip: string): void {
    const list = this.recent(ip);
    list.push(this.now());
    this.failures.set(ip, list);
  }

  private recent(ip: string): number[] {
    const cutoff = this.now() - BAN_WINDOW_MS;
    const list = (this.failures.get(ip) ?? []).filter((t) => t > cutoff);
    if (list.length) this.failures.set(ip, list);
    else this.failures.delete(ip);
    return list;
  }
}

class WsConn implements HubConn {
  device: { id: string; name: string } | null = null;
  constructor(readonly id: number, private readonly ws: WebSocket) {}
  get deviceId(): string {
    return this.device?.id ?? '';
  }
  sendJson(msg: ServerMsg): void {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(msg));
  }
  sendBinary(buf: Uint8Array): void {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(buf, { binary: true });
  }
  bufferedAmount(): number {
    return this.ws.bufferedAmount;
  }
  close(code: number, reason: string): void {
    this.ws.close(code, reason);
  }
}

export interface RemoteaServerOptions {
  hub: Hub;
  token: () => string;
  log?: (msg: string) => void;
}

export class RemoteaServer {
  private readonly wss: WebSocketServer;
  private readonly servers = new Map<string, http.Server>();
  private readonly failures = new FailureTracker();
  private nextConnId = 1;
  private readonly log: (msg: string) => void;

  constructor(private readonly opts: RemoteaServerOptions) {
    this.log = opts.log ?? (() => {});
    this.wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD, perMessageDeflate: false });
  }

  /** Listen on one address. Resolves with the bound port (useful with port 0 in tests). */
  listen(host: string, port: number): Promise<number> {
    const server = http.createServer((req, res) => {
      if (req.url === '/healthz') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('ok\n');
        return;
      }
      if (req.method === 'POST' && req.url?.startsWith('/upload?')) {
        void this.onUpload(req, res);
        return;
      }
      res.writeHead(426, { 'content-type': 'text/plain' });
      res.end('remotea server: WebSocket only\n');
    });
    // A client that sends `Expect: 100-continue` (the app's uploader) is checked before it sends the body, so a
    // refusal reaches it as an answer instead of a connection closed under a write. Anything else is answered as usual.
    server.on('checkContinue', (req, res) => {
      if (req.method === 'POST' && req.url?.startsWith('/upload?')) void this.onUpload(req, res, true);
      else server.emit('request', req, res);
    });
    server.on('upgrade', (req, socket, head) => this.onUpgrade(req, socket, head));
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        this.servers.set(host, server);
        const addr = server.address();
        resolve(typeof addr === 'object' && addr ? addr.port : port);
      });
    });
  }

  listening(host: string): boolean {
    return this.servers.has(host);
  }

  /** Who may call: the same rules as the WebSocket handshake (see the header). */
  private admit(req: http.IncomingMessage): { ok: true } | { ok: false; status: number; text: string } {
    const ip = req.socket.remoteAddress ?? 'unknown';
    if (this.failures.banned(ip)) return { ok: false, status: 429, text: 'Too Many Requests' };
    if (req.headers.origin !== undefined) {
      this.log(`rejected ${ip}: browser origin ${String(req.headers.origin).slice(0, 80)}`);
      return { ok: false, status: 403, text: 'Forbidden' };
    }
    if (!tokenMatches(req.headers.authorization, this.opts.token())) {
      this.failures.fail(ip);
      this.log(`rejected ${ip}: bad token`);
      return { ok: false, status: 401, text: 'Unauthorized' };
    }
    return { ok: true };
  }

  /** A file pasted or dropped onto a remote pane (see upload.ts). */
  private async onUpload(req: http.IncomingMessage, res: http.ServerResponse, expectsContinue = false): Promise<void> {
    const reply = (status: number, body: object) => {
      res.writeHead(status, { 'content-type': 'application/json', connection: 'close' });
      res.end(JSON.stringify(body));
    };
    const refuse = (status: number, error: string) => {
      // A client waiting for 100 Continue sends no body, so there is nothing to read.
      if (!expectsContinue) req.resume();
      reply(status, { error });
    };
    const admitted = this.admit(req);
    if (!admitted.ok) return refuse(admitted.status, admitted.text);
    const q = new URL(req.url ?? '', 'http://x').searchParams;
    const surf = q.get('surf') ?? '';
    const name = q.get('name') ?? '';
    if (!/^surf-[A-Za-z0-9_-]{1,96}$/.test(surf) || !name || name.length > 255) return refuse(400, 'surf and name are required');
    // Only for a session that is running here: the file is for the program in it.
    if (!this.opts.hub.isLive(surf)) return refuse(404, 'no such live session');
    if (expectsContinue) {
      const declared = Number(req.headers['content-length']);
      if (!Number.isInteger(declared) || declared < 0) return refuse(411, 'Content-Length required');
      if (declared > MAX_UPLOAD_BYTES) return refuse(413, `larger than ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB`);
      res.writeContinue();
    }
    const r = await receiveUpload(req, name);
    if (!r.ok) return reply(r.status, { error: r.error });
    this.log(`upload: ${r.bytes} bytes for ${surf}`);
    reply(200, { path: r.path });
  }

  private onUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    const ip = req.socket.remoteAddress ?? 'unknown';
    const reject = (status: number, text: string) => {
      socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
    };
    const admitted = this.admit(req);
    if (!admitted.ok) return reject(admitted.status, admitted.text);
    this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, ip));
  }

  private onConnection(ws: WebSocket, ip: string): void {
    const conn = new WsConn(this.nextConnId++, ws);
    const hub = this.opts.hub;
    hub.connect(conn);
    this.log(`connection #${conn.id} from ${ip}`);

    const helloTimer = setTimeout(() => {
      if (!conn.device) ws.close(4001, 'hello timeout');
    }, HELLO_TIMEOUT_MS);

    let alive = true;
    ws.on('pong', () => {
      alive = true;
    });
    const pinger = setInterval(() => {
      if (!alive) {
        ws.terminate();
        return;
      }
      alive = false;
      ws.ping();
    }, PING_MS);

    ws.on('message', (data: RawData, isBinary: boolean) => {
      const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
      if (isBinary) {
        if (buf.length > LIMITS.maxInputBytes + 128) return;
        const frame = decodeFrame(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
        if (frame && frame.kind === BIN_INPUT) hub.handleInput(conn, frame.id, frame.data);
        return;
      }
      let raw: unknown;
      try {
        raw = JSON.parse(buf.toString('utf8'));
      } catch {
        conn.sendJson({ t: 'error', code: 'bad-json', message: 'unparseable message' });
        return;
      }
      const msg = parseClientMsg(raw);
      if (!msg) {
        const t = typeof (raw as { t?: unknown })?.t === 'string' ? (raw as { t: string }).t : '?';
        conn.sendJson({ t: 'error', code: 'bad-request', message: `rejected message "${t.slice(0, 32)}"` });
        return;
      }
      try {
        hub.handle(conn, msg);
      } catch (err) {
        this.log(`error handling ${msg.t} from #${conn.id}: ${(err as Error).stack ?? err}`);
        conn.sendJson({ t: 'error', code: 'internal', message: (err as Error).message });
      }
    });

    ws.on('close', () => {
      clearTimeout(helloTimer);
      clearInterval(pinger);
      hub.disconnect(conn);
      this.log(`connection #${conn.id} closed`);
    });
    ws.on('error', (err) => this.log(`connection #${conn.id} error: ${err.message}`));
  }

  async close(): Promise<void> {
    for (const client of this.wss.clients) client.terminate();
    await Promise.all([...this.servers.values()].map((s) => new Promise<void>((r) => s.close(() => r()))));
    this.servers.clear();
  }
}
