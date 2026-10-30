/**
 * Every configured remote host, one RemoteHostClient each, plus the settings
 * IPC and the power hooks that make "close the lid, open it, keep working"
 * reconnect immediately instead of after a timeout.
 */
import path from 'path';
import WebSocket from 'ws';
import { GROUP_ID_RE, LIMITS, PROTO, SURFACE_ID_RE, parseServerMsg } from '../../shared/remote-host-protocol';
import { IPC_CHANNELS } from '../../shared/types';
import type { HostDTO, HostSaveRequest, HostStatus, HostTestRequest, HostTestResult, RegistryPayload, RemoteRegistryView } from '../../shared/remote-hosts-types';
import { assertHostUrlAcknowledged, HostStore, loadDevice, PendingIntents, validateHostUrl, type SecretBox, type StoredHost } from './host-config';
import { RemoteHostClient, type SocketFactory } from './host-client';
import { diag, diagQueued, requeueDiag, takeDiag } from './diag';
import { remoteInsertionText } from '../remote-insert';
import type { InsertionResult } from '../../shared/types';

const DIAG_FLUSH_MS = 2000;

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
  private diagTimer: NodeJS.Timeout | null = null;
  /** Hosts whose agent-hooks prompt the user put off for this run ("Not now"). */
  private readonly hooksNotNow = new Set<string>();
  private metaListener: ((surfaceId: string, meta: { cwd?: string }) => void) | undefined;
  private rpcListener: ((surfaceId: string, method: string, params: Record<string, unknown>, replay: boolean) => void) | undefined;
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

  /** Where agent status relayed from a remote session goes (the same handlers the named pipe feeds). */
  setRpcListener(fn: (surfaceId: string, method: string, params: Record<string, unknown>, replay: boolean) => void): void {
    this.rpcListener = fn;
  }

  start(): void {
    this.seedFromEnv();
    for (const host of this.store.list()) this.ensureClient(host);
    if (!this.diagTimer) {
      this.diagTimer = setInterval(() => this.flushDiag(), DIAG_FLUSH_MS);
      this.diagTimer.unref?.();
    }
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
        onRpc: (id, method, params, replay) => this.rpcListener?.(id, method, params, replay),
        hooksPromptDeclined: () => this.hooksNotNow.has(host.id) || !!this.store.get(host.id)?.hooksPromptDeclined,
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
    return {
      id: host.id, name: host.name, url: host.url, enabled: host.enabled, hasToken: !!host.tokenEnc, serverId: host.serverId,
      unencryptedAcknowledged: !!host.unencryptedAckUrl && host.unencryptedAckUrl === host.url, status,
    };
  }

  list(): HostDTO[] {
    return this.store.list().map((h) => this.dto(h));
  }

  /**
   * REMOTEA_SEED_HOST={"name","url","token"}: add (or update) that host at
   * startup. For scripted setups — the desktop test harness starts a test
   * instance against a test server this way — since the stored token is
   * encrypted with this machine's secure storage and cannot be written from
   * outside. Matched by URL, so relaunching does not duplicate it.
   */
  private seedFromEnv(): void {
    const raw = process.env.REMOTEA_SEED_HOST;
    if (!raw) return;
    try {
      const seed = JSON.parse(raw) as { name?: unknown; url?: unknown; token?: unknown };
      if (typeof seed.name !== 'string' || typeof seed.url !== 'string' || typeof seed.token !== 'string') throw new Error('needs name, url and token');
      const existing = this.store.list().find((h) => h.url === seed.url);
      // A scripted setup chose its URL deliberately (the desktop test harness uses loopback anyway).
      this.store.save({ id: existing?.id, name: seed.name, url: seed.url, token: seed.token, enabled: true, acknowledgeUnencrypted: true });
      this.log(`seeded host ${seed.name} (${seed.url}) from REMOTEA_SEED_HOST`);
    } catch (err) {
      this.log(`ignoring REMOTEA_SEED_HOST: ${(err as Error).message}`);
    }
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

  /**
   * A paste or drop of local files onto a remote pane: upload them to that
   * pane's server and answer with the text to type (the server paths, quoted
   * for a POSIX shell), or the failure to show.
   */
  async insertionForFiles(surfaceId: string, localPaths: string[], signal?: AbortSignal): Promise<InsertionResult> {
    const client = this.clientOwning(surfaceId);
    if (!client) return { text: null, failure: { destination: 'remote host', detail: 'this pane is not connected to its host' } };
    const where = this.store.get(client.hostId)?.name ?? client.hostId;
    const r = await client.uploadFiles(surfaceId, localPaths, signal);
    if (signal?.aborted) return { text: null };
    if (!r.ok) return { text: null, failure: { destination: where, detail: r.error } };
    return { text: remoteInsertionText(r.paths) };
  }

  /** The explorer / code viewer on a remote pane (see RemoteHostClient.fs). */
  fs(surfaceId: string, req: Parameters<RemoteHostClient['fs']>[1]): Promise<unknown> {
    const client = this.clientOwning(surfaceId);
    return client ? client.fs(surfaceId, req) : Promise.resolve({ error: 'No working directory reported for this pane', code: 'no_root' });
  }

  /** The user said yes to the agent-hooks prompt: the server installs them. */
  async installHooks(hostId: string): Promise<{ ok: boolean; error?: string }> {
    const client = this.clients.get(hostId);
    if (!client?.ready) return { ok: false, error: 'not connected' };
    diag('hooks.install', { host: hostId });
    const res = await client.installHooks();
    diag('hooks.installed', { host: hostId, ok: res.ok, error: res.error ?? null });
    return res;
  }

  /** "Not now" (this run) or "Don't ask again" (remembered for this host). */
  dismissHooksPrompt(hostId: string, forever: boolean): void {
    if (forever) this.store.declineHooksPrompt(hostId);
    else this.hooksNotNow.add(hostId);
    diag('hooks.dismissed', { host: hostId, forever });
    this.clients.get(hostId)?.refreshStatus();
  }

  remove(id: string): boolean {
    const client = this.clients.get(id);
    client?.stop();
    this.clients.delete(id);
    return this.store.remove(id);
  }

  /** One-shot connection check for the Settings "Test" button; touches nothing. */
  test(req: HostTestRequest): Promise<HostTestResult> {
    let url: string;
    try {
      url = validateHostUrl(req.url);
      // Testing sends the token too: the same acknowledgement as saving.
      assertHostUrlAcknowledged(url, req.acknowledgeUnencrypted, req.id ? this.store.get(req.id)?.unencryptedAckUrl : undefined);
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
    diag('power.suspend');
    this.flushDiag();
    for (const c of this.clients.values()) c.suspend();
  }

  /** `why`: what woke us (power resume, unlock, window focus, a Retry click). */
  wakeAll(why = 'wake'): void {
    if (why !== 'focus') diag('power.wake', { why });
    for (const c of this.clients.values()) c.wake();
  }

  /**
   * Ship queued diagnostics to the first connected host that accepts them
   * (see ./diag). Runs on a timer from start(); cheap when nothing is queued.
   */
  flushDiag(): void {
    if (!diagQueued()) return;
    const client = [...this.clients.values()].find((c) => c.acceptsDiag);
    if (!client) return;
    for (let i = 0; i < 10 && diagQueued(); i++) {
      const batch = takeDiag(LIMITS.maxDiagEvents);
      if (!client.sendDiag(batch)) {
        requeueDiag(batch);
        return;
      }
    }
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

  /**
   * Each host's registry mirror with this device's unconfirmed changes laid
   * over it: a close or hide still in the outbox must not let the next
   * reconcile put the tab back.
   */
  views(): RemoteRegistryView[] {
    const me = this.device.id;
    return [...this.clients.values()].map((c) => {
      const o = c.outboxOverlay();
      const closedIds = new Set(c.closedIds);
      const sessions = [];
      for (const s of c.sessions.values()) {
        if (o.closing.has(s.id) || (s.groupId && o.groupsClosing.has(s.groupId))) {
          closedIds.add(s.id);
          continue;
        }
        const hidden = (s.hiddenBy as string[]).includes(me);
        if (o.hiding.has(s.id) && !hidden) sessions.push({ ...s, hiddenBy: [...s.hiddenBy, me as (typeof s.hiddenBy)[number]] });
        else if (o.unhiding.has(s.id) && hidden) sessions.push({ ...s, hiddenBy: s.hiddenBy.filter((d) => d !== me) });
        else sessions.push(s);
      }
      for (const id of o.closing) closedIds.add(id);
      return {
        hostId: c.hostId,
        deviceId: me,
        connected: c.ready,
        bootId: c.bootId,
        groups: [...c.groups.values()].filter((g) => !o.groupsClosing.has(g.id)),
        sessions,
        closedIds: [...closedIds],
        lost: {},
        restoring: c.restoringIds(),
      };
    });
  }

  /** Forget one unconfirmed change (Settings → Remote hosts, pending changes). */
  forgetIntent(hostId: string, iid: string): boolean {
    return this.clients.get(hostId)?.forgetIntent(iid) ?? false;
  }

  /** The user has seen a host's failed or expired changes (Settings). */
  dismissOutboxFailures(hostId: string): void {
    this.clients.get(hostId)?.dismissOutboxFailures();
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
