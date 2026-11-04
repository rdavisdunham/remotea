import { remoteDirectoryIssue } from '../shared/execution-location';
/**
 * Every terminal operation in main goes through here: local surfaces to the
 * ConPTY-backed PtyManager, remote surfaces (shell `remote:<host>`) to that
 * host's RemoteHostClient.
 *
 * It keeps PtyManager's method names on purpose, so the dozens of existing
 * call sites (pipe verbs, the phone console, agent answers, startup commands)
 * work for remote panes without knowing they exist. The few places where the
 * two genuinely differ are explicit:
 *   - create() is async (a remote host may need to reconnect first);
 *   - killAll() kills LOCAL processes but only DETACHES remote ones — quitting
 *     the app must never end the work running on the server;
 *   - getPid()/liveSurfaceIds()/count() are local-only: they feed Win32
 *     process probes and the "N terminals will be closed" guard.
 */
import { v4 as uuidv4 } from 'uuid';
import type { PtyManager, CreateOptions, CreateResult } from './pty-manager';
import type { SurfaceId } from '../shared/types';
import type { GroupId } from '../shared/remote-host-protocol';
import type { PtyExitInfo, RemoteSize, TerminalSnapshot } from '../shared/remote-hosts-types';
import { parseRemoteShellSpec, remoteShellSpec } from '../shared/remote-shell-spec';
import type { RemoteHosts } from './remote-hosts';

export interface RouterCreateOptions extends CreateOptions {
  /** Workspace group and tab title for a remote session (phase 2 sync). */
  remote?: { groupId?: GroupId | null; group?: { name: string; color?: string }; title?: string };
}

export interface RouterCreateResult extends CreateResult {
  /** Screen + scrollback to paint before live output (remote session that already existed). */
  snapshot?: TerminalSnapshot;
  /** The remote session cannot be opened here (closed elsewhere / hidden on this device). */
  unavailable?: PtyExitInfo;
  remote?: boolean;
}

/** Only POSIX paths make sense on the server; a Windows path is this machine's, not the host's. */
function remoteCwd(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined;
  return cwd.startsWith('/') || cwd === '~' || cwd.startsWith('~/') ? cwd : undefined;
}

export class TerminalRouter {
  constructor(readonly local: PtyManager, readonly remote: RemoteHosts) {}

  isRemote(id: string): boolean {
    return this.remote.owns(id);
  }

  async create(options: RouterCreateOptions): Promise<RouterCreateResult> {
    const spec = parseRemoteShellSpec(options.shell);
    if (!spec) {
      if (options.shell?.startsWith('remote:')) throw new Error('Invalid remote host launch specification. Select a configured remote host.');
      return this.local.create(options.shell === 'local:' ? { ...options, shell: '' } : options);
    }
    const directoryIssue = remoteDirectoryIssue(options.cwd);
    if (directoryIssue) throw new Error(directoryIssue);
    const client = this.remote.client(spec.hostId);
    if (!client) throw new Error(`Unknown remote host "${spec.hostId}". Add it in Settings → Remote hosts.`);
    const id = (options.surfaceId ?? `surf-${uuidv4()}`) as SurfaceId;
    const res = await client.create({
      id,
      cols: options.cols ?? 120,
      rows: options.rows ?? 32,
      spec: {
        cmd: spec.command,
        cwd: remoteCwd(options.cwd),
        startupCommands: options.startupCommands?.length ? options.startupCommands : undefined,
        groupId: options.remote?.groupId,
        group: options.remote?.group,
        title: options.remote?.title,
      },
    });
    return {
      id,
      shell: options.shell,
      // The host, not the command: a split of `remote:desk claude --resume x`
      // opens a shell on desk rather than resuming the same session twice.
      launchShell: remoteShellSpec(spec.hostId),
      startupCommandsConsumed: !!options.startupCommands?.length,
      reused: res.reused,
      snapshot: res.snapshot,
      unavailable: res.unavailable,
      remote: true,
    };
  }

  write(id: SurfaceId, data: string): void {
    const c = this.remote.clientOwning(id);
    if (c) c.write(id, data);
    else this.local.write(id, data);
  }

  resize(id: SurfaceId, cols: number, rows: number): void {
    const c = this.remote.clientOwning(id);
    if (c) c.resize(id, cols, rows);
    else this.local.resize(id, cols, rows);
  }

  /**
   * Drop ConPTY's copy of the screen to match a renderer-side clear (#434).
   * Local only: a remote session has no ConPTY on this machine.
   */
  clear(id: SurfaceId): void {
    if (!this.remote.clientOwning(id)) this.local.clear(id);
  }

  /** The user is looking at this terminal: on a remote one, take control of its size. */
  claim(id: SurfaceId): void {
    this.remote.clientOwning(id)?.claim(id);
  }

  /**
   * Close a terminal. Remote: ends the session on the server for every device
   * (queued if offline). `shellSpec` reaches a remote surface this app never
   * mounted (closed from the sidebar before it was ever shown).
   */
  kill(id: SurfaceId, shellSpec?: string): void {
    const c = this.remote.clientOwning(id);
    if (c) {
      c.kill(id);
      return;
    }
    const spec = parseRemoteShellSpec(shellSpec);
    const byHost = spec ? this.remote.client(spec.hostId) : undefined;
    if (spec) {
      if (!byHost) throw new Error(`Unknown remote host \"${spec.hostId}\". The session was not ended locally.`);
      byHost.kill(id);
      return;
    }
    if (shellSpec?.startsWith('remote:')) throw new Error('Invalid remote host launch specification. The session was not ended locally.');
    this.local.kill(id);
  }

  /** A renderer lost its copy of a remote terminal (reload): send it the server's screen. Local: nothing to do. */
  requestResync(id: SurfaceId): void {
    this.remote.clientOwning(id)?.resnapshot(id);
  }

  /** Stop streaming a remote terminal to this app but keep it running (window closed, hidden here). */
  release(id: SurfaceId): void {
    this.remote.clientOwning(id)?.release(id);
  }

  /** Quit / session end: kill local processes, detach (never kill) remote ones. */
  killAll(): void {
    this.local.killAll();
    this.remote.detachAllNow();
  }

  has(id: SurfaceId): boolean {
    return this.local.has(id) || !!this.remote.clientOwning(id)?.has(id);
  }

  onData(id: SurfaceId, cb: (data: string) => void): () => void {
    const c = this.remote.clientOwning(id);
    return c ? c.onData(id, cb) : this.local.onData(id, cb);
  }

  onExit(id: SurfaceId, cb: (code: number, info: PtyExitInfo) => void): () => void {
    const c = this.remote.clientOwning(id);
    return c ? c.onExit(id, cb) : this.local.onExit(id, (code) => cb(code, { reason: 'exited' }));
  }

  /** A remote terminal's size and who sets it (remote only; local terminals always fit their pane). */
  onSize(id: SurfaceId, cb: (s: RemoteSize) => void): () => void {
    return this.remote.clientOwning(id)?.onSize(id, cb) ?? (() => {});
  }

  remoteSize(id: SurfaceId): RemoteSize | undefined {
    return this.remote.clientOwning(id)?.sizeOf(id);
  }

  onResync(id: SurfaceId, cb: (snap: TerminalSnapshot) => void): () => void {
    const c = this.remote.clientOwning(id);
    return c ? c.onResync(id, cb) : () => {};
  }

  getPid(id: SurfaceId): number | undefined {
    return this.remote.owns(id) ? undefined : this.local.getPid(id);
  }

  liveSurfaceIds(): SurfaceId[] {
    return this.local.liveSurfaceIds();
  }

  /** Local terminals only: remote ones survive quitting, so they never count toward the close guard. */
  count(): number {
    return this.local.count();
  }

  deliverCommands(id: SurfaceId, commands: string[]): boolean {
    const c = this.remote.clientOwning(id);
    return c ? c.deliverCommands(id, commands) : this.local.deliverCommands(id, commands);
  }
}
