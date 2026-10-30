/**
 * Remote-host data that crosses main <-> renderer. The token never does:
 * the renderer can set one (write-only) and learn whether one is stored.
 */
import type { GroupRecord, HookAgentStatus, LostInfo, SessionRecord } from './remote-host-protocol';

export type HostConnState =
  | 'disabled'      // no token yet, or switched off
  | 'connecting'
  | 'ready'
  | 'reconnecting'  // dropped; waiting out a backoff before the next attempt
  | 'auth-failed'   // wrong token: retried rarely, not in a tight loop
  | 'wrong-server'  // URL now points at a different server than the one pinned
  | 'incompatible'  // protocol mismatch: needs an update, not a retry
  | 'suspended';    // the machine is going to sleep

export interface HostStatus {
  hostId: string;
  state: HostConnState;
  attempt: number;
  /** Epoch ms of the next reconnect attempt, while reconnecting. */
  nextRetryAt?: number;
  error?: string;
  /** The server's own hostname, once connected. */
  serverHostname?: string;
  /** Agent status hooks on the server (servers that report them). */
  hooks?: {
    agents: HookAgentStatus[];
    /** Ask the user to install them: an agent there lacks them, and the user has not declined for this host. */
    prompt: boolean;
  };
  /** Registry changes made here (close, hide, rename, move, group edits) not yet confirmed by the server. */
  outbox?: OutboxSummary;
}

/** A host's outbox as the UI sees it. */
export interface OutboxSummary {
  /** Waiting to be sent, or sent and not acknowledged yet. */
  pending: number;
  /** Changes that will not be applied: refused by the server, or given up on. */
  failed: Array<{
    iid: string;
    t: 'close' | 'groupClose' | 'hide' | 'unhide' | 'sessionUpdate' | 'groupUpsert';
    /** The session or group it was about. */
    id: string;
    state: 'failed' | 'expired';
    error?: string;
    at: number;
  }>;
}

/** A remote terminal's size as its server has it; `owner`: this device sets it (the last one focused or typed in). */
export interface RemoteSize {
  cols: number;
  rows: number;
  owner: boolean;
  /** The device that does set it, when it is another one. */
  ownerName?: string;
}

export interface HostDTO {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  hasToken: boolean;
  serverId?: string;
  status: HostStatus;
}

export interface HostSaveRequest {
  id?: string;
  name: string;
  url: string;
  enabled?: boolean;
  /** Set or replace the token; omitted keeps the stored one. */
  token?: string;
}

export interface HostTestResult {
  ok: boolean;
  error?: string;
  serverHostname?: string;
  sessions?: number;
}

/** Why a remote terminal stopped, as the renderer sees it (PTY_EXIT's third argument). */
export interface PtyExitInfo {
  reason: 'exited' | 'closed' | 'hidden';
  /** Device name that closed it, for 'closed'. */
  by?: string;
}

export interface TerminalSnapshot {
  data: string;
  cols: number;
  rows: number;
}

/** The registry as one device sees it, pushed to renderers for placement (phase 2). */
export interface RemoteRegistryView {
  hostId: string;
  deviceId: string;
  connected: boolean;
  bootId: string | null;
  groups: GroupRecord[];
  sessions: SessionRecord[];
  /** Sessions closed while this device could not hear about it (from probes). */
  closedIds: string[];
  lost: Record<string, LostInfo>;
}

/** What each window receives: the registries, plus its role in placing sessions. */
export interface RegistryPayload {
  views: RemoteRegistryView[];
  /** This window adds sessions the device does not show yet (exactly one window is). */
  placer: boolean;
  /** Remote tabs the device's OTHER windows already show. */
  elsewhere: string[];
}
