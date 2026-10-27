/**
 * Every configured remote host, one RemoteHostClient each, plus the settings
 * IPC and the power hooks that make "close the lid, open it, keep working"
 * reconnect immediately instead of after a timeout.
 */
import path from 'path';
import WebSocket from 'ws';
import { GROUP_ID_RE, PROTO, SURFACE_ID_RE, parseServerMsg } from '../../shared/remote-host-protocol';
import { IPC_CHANNELS } from '../../shared/types';
import type { HostDTO, HostSaveRequest, HostStatus, HostTestResult, RegistryPayload, RemoteRegistryView } from '../../shared/remote-hosts-types';
import { HostStore, loadDevice, PendingIntents, validateHostUrl, type SecretBox, type StoredHost } from './host-config';
import { RemoteHostClient, type SocketFactory } from './host-client';

export interface RemoteHostsDeps {
  dataDir: string;
  box: SecretBox;
  appVersion: string;
  /** Send to every renderer window. */
  broadcast: (channel: string, ...args: unknown[]) => void;
  log?: (msg: string) => void;
  socket?: SocketFactory;
}


export class RemoteHosts {
  readonly device: { id: string; name: string };
  private readonly store: HostStore;
  private readonly intents: PendingIntents;
  private readonly clients = new Map<string, RemoteHostClient>();
  private readonly log: (msg: string) => void;
  private registryTimer: NodeJS.Timeout | null = null;
  private metaListener: ((surfaceId: string, meta: { cwd?: string }) => void) | undefined;
  /** Per renderer window: whether its layout is restored, and the remote tabs it shows. */
  private readonly windows = new Map<number, { ready: boolean; ids: Set<string>; send: (payload: RegistryPayload) => void }>();

  constructor(private readonly deps: RemoteHostsDeps) {
    this.log = deps.log ?? (() => {});
    this.device = loadDevice(path.join(deps.dataDir, 'remote-device.json'));
    this.store = new HostStore(path.join(deps.dataDir, 'remote-hosts.json'), deps.box);
    this.intents = new PendingIntents(path.join(deps.dataDir, 'remote-pending.json'));
  }

  /** Where a remote session's cwd reports go (the same path a shell's report_pwd takes). */
  setMetaListener(fn: (surfaceId: string, meta: { cwd?: string }) => void): void {
    this.metaListener = fn;
  }

  start(): void {
    for (const host of this.store.list()) this.ensureClient(host);
  }

  private ensureClient(host: StoredHost): RemoteHostClient {
    let client = this.clients.get(host.id);
    if (!client) {
      client = new RemoteHostClient({
        hostId: host.id,
        url: () => this.store.get(host.id)?.url ?? host.url,
        token: () => this.store.token(host.id),
        device: this.device,
        appVersion: this.deps.appVersion,
        pinnedServerId: () => this.store.get(host.id)?.serverId,
        pinServer: (serverId) => this.store.pinServer(host.id, serverId),
        intents: this.intents,
        onStatus: (status) => this.deps.broadcast(IPC_CHANNELS.RHOST_STATUS, status),
        onRegistry: () => this.registryChanged(),
        onMeta: (id, meta) => this.metaListener?.(id, meta),
        socket: this.deps.socket,
        log: this.log,
      });
      this.clients.set(host.id, client);
    }
    if (host.enabled) client.start();
    else client.stop();
    return client;
  }

  // ── Settings surface ─────────────────────────────────────────────────────

  private dto(host: StoredHost): HostDTO {
    const client = this.clients.get(host.id);
    const status: HostStatus = client?.status() ?? { hostId: host.id, state: 'disabled', attempt: 0 };
    return { id: host.id, name: host.name, url: host.url, enabled: host.enabled, hasToken: !!host.tokenEnc, serverId: host.serverId, status };
  }

  list(): HostDTO[] {
    return this.store.list().map((h) => this.dto(h));
  }

  save(req: HostSaveRequest): HostDTO {
    const { host, reconnect } = this.store.save(req);
    const client = this.ensureClient(host);
    if (reconnect && host.enabled) {
      client.stop();
      client.start();
    }
    return this.dto(host);
  }

  remove(id: string): boolean {
    const client = this.clients.get(id);
    client?.stop();
    this.clients.delete(id);
    return this.store.remove(id);
  }

  /** One-shot connection check for the Settings "Test" button; touches nothing. */
  test(req: { url: string; token?: string; id?: string }): Promise<HostTestResult> {
    let url: string;
    try {
      url = validateHostUrl(req.url);
    } catch (err) {
      return Promise.resolve({ ok: false, error: (err as Error).message });
    }
    const token = req.token?.trim() || (req.id ? this.store.token(req.id) : null);
    if (!token) return Promise.resolve({ ok: false, error: 'Enter the token (run `remotea token` on the server)' });
    return new Promise((resolve) => {
      let done = false;
      const finish = (r: HostTestResult) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try {
          ws.terminate();
        } catch {
          /* ignore */
        }
        resolve(r);
      };
      const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` }, handshakeTimeout: 6000, perMessageDeflate: false });
      const timer = setTimeout(() => finish({ ok: false, error: 'Timed out' }), 8000);
      ws.on('unexpected-response', (_req, res) => finish({ ok: false, error: res.statusCode === 401 ? 'The server rejected the token' : `HTTP ${res.statusCode}` }));
      ws.on('error', (err) => finish({ ok: false, error: `Cannot reach the server: ${err.message}` }));
      ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', proto: PROTO, device: this.device, app: { name: 'remotea', version: this.deps.appVersion } })));
      ws.on('message', (data, isBinary) => {
        if (isBinary) return;
        const msg = parseServerMsg(JSON.parse(String(data)));
        if (msg?.t === 'welcome') finish({ ok: true, serverHostname: msg.hostname, sessions: msg.sessions.length });
        else if (msg?.t === 'error') finish({ ok: false, error: msg.message });
      });
    });
  }

  // ── Power & lifecycle ────────────────────────────────────────────────────

  suspendAll(): void {
    for (const c of this.clients.values()) c.suspend();
  }

  wakeAll(): void {
    for (const c of this.clients.values()) c.wake();
  }

  /** Quit / session end: drop every socket synchronously. The server treats that as a detach. */
  detachAllNow(): void {
    for (const c of this.clients.values()) c.detachNow();
  }

  attachedCount(): number {
    let n = 0;
    for (const c of this.clients.values()) n += c.attachedCount();
    return n;
  }

  // ── Routing ──────────────────────────────────────────────────────────────

  client(hostId: string): RemoteHostClient | undefined {
    return this.clients.get(hostId);
  }

  clientOwning(surfaceId: string): RemoteHostClient | undefined {
    for (const c of this.clients.values()) if (c.owns(surfaceId)) return c;
    return undefined;
  }

  owns(surfaceId: string): boolean {
    return !!this.clientOwning(surfaceId);
  }

  // ── Registry views (phase 2 placement) ───────────────────────────────────

  views(): RemoteRegistryView[] {
    return [...this.clients.values()].map((c) => ({
      hostId: c.hostId,
      deviceId: this.device.id,
      connected: c.ready,
      bootId: c.bootId,
      groups: [...c.groups.values()],
      sessions: [...c.sessions.values()],
      closedIds: [...c.closedIds],
      lost: {},
    }));
  }

  private registryChanged(): void {
    // Coalesce bursts (a welcome, a group of sessionAdded) into one push.
    if (this.registryTimer) return;
    this.registryTimer = setTimeout(() => {
      this.registryTimer = null;
      this.pushAll();
    }, 100);
  }

  /**
   * Exactly one window places sessions this device does not show yet — the
   * oldest ready one — or two windows would each add the same tab. Every
   * window learns which remote tabs the OTHER windows already show.
   */
  private payloadFor(windowId: number): RegistryPayload {
    let placer = Infinity;
    for (const [id, w] of this.windows) if (w.ready && id < placer) placer = id;
    const elsewhere: string[] = [];
    for (const [id, w] of this.windows) if (id !== windowId) elsewhere.push(...w.ids);
    return { views: this.views(), placer: windowId === placer, elsewhere };
  }

  private pushAll(): void {
    const shown = new Set<string>();
    for (const w of this.windows.values()) for (const id of w.ids) shown.add(id);
    for (const c of this.clients.values()) c.probeUnknown(shown);
    for (const [id, w] of this.windows) if (w.ready) w.send(this.payloadFor(id));
  }

  /** A renderer reports its remote tabs (and, once restored, that it is ready). */
  report(windowId: number, send: (payload: RegistryPayload) => void, r: { ready: boolean; surfaceIds: string[] }): void {
    const prev = this.windows.get(windowId);
    const ids = new Set(r.surfaceIds.filter((x) => typeof x === 'string'));
    this.windows.set(windowId, { ready: !!r.ready, ids, send });
    if (r.ready && !prev?.ready) send(this.payloadFor(windowId));
    const changed = !prev || prev.ids.size !== ids.size || [...ids].some((id) => !prev.ids.has(id));
    if (changed) this.registryChanged();
  }

  forgetWindow(windowId: number): void {
    if (this.windows.delete(windowId)) this.registryChanged();
  }

  // ── Registry operations from the renderer ────────────────────────────────

  /** "Hide on this device": stop streaming here and record it on the server (queued if offline). */
  hide(hostId: string, surfaceId: string): void {
    const c = this.clients.get(hostId);
    if (!c || !SURFACE_ID_RE.test(surfaceId)) return;
    c.release(surfaceId);
    c.intent({ t: 'hide', id: surfaceId });
  }

  unhide(hostId: string, surfaceId: string): void {
    const c = this.clients.get(hostId);
    if (c && SURFACE_ID_RE.test(surfaceId)) c.intent({ t: 'unhide', id: surfaceId });
  }

  groupUpsert(hostId: string, group: { id: string; name: string; color?: string }): void {
    const c = this.clients.get(hostId);
    if (!c || !GROUP_ID_RE.test(group?.id ?? '') || typeof group.name !== 'string') return;
    c.intent({ t: 'groupUpsert', id: group.id, name: group.name.slice(0, 120), color: typeof group.color === 'string' ? group.color : undefined });
  }

  groupClose(hostId: string, groupId: string): void {
    const c = this.clients.get(hostId);
    if (c && GROUP_ID_RE.test(groupId)) c.intent({ t: 'groupClose', id: groupId });
  }
}
