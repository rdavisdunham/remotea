/**
 * Remote-host data that crosses main <-> renderer. The token never does:
 * the renderer can set one (write-only) and learn whether one is stored.
 */
import type { GroupRecord, HookAgentStatus, LostInfo, SessionRecord } from './remote-host-protocol';
import type { TeaState } from './tea';

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
  /** Epoch ms of the welcome on the current connection, while ready. */
  connectedAt?: number;
  /** Epoch ms of the last traffic from the host (any message or pong), on this or an earlier connection. */
  lastSeenAt?: number;
  /** Agent status hooks on the server (servers that report them). */
  hooks?: {
    agents: HookAgentStatus[];
    /** Ask the user to install them: an agent there lacks them, and the user has not declined for this host. */
    prompt: boolean;
  };
  /** Registry changes made here (close, hide, rename, move, group edits) not yet confirmed by the server. */
  outbox?: OutboxSummary;
  /**
   * Connected, and the server's welcome lacks `remoteaNames`: it predates the
   * rename, so its agents won't report status until `remotea upgrade` runs there.
   */
  serverPredatesRename?: boolean;
}

/** A host's outbox as the UI sees it. */
export interface OutboxSummary {
  /** Waiting to be sent, or sent and not acknowledged yet (uncertain ones included). */
  pending: number;
  /**
   * Of those, sent but unanswered past the request deadline while connected:
   * maybe applied. Not resent until a registry snapshot settles them.
   */
  uncertain?: number;
  /**
   * Each still-open change (pending or uncertain), oldest first, so the UI can
   * say what it would do and offer to forget it. Absent when there are none
   * (and from builds before it existed: fall back to the counts).
   */
  open?: OutboxOpenItem[];
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

/** One unconfirmed registry change made on this device (mirrors main's PendingIntent). */
export type OutboxIntent =
  | { t: 'close'; id: string }
  | { t: 'groupClose'; id: string }
  | { t: 'hide'; id: string }
  | { t: 'unhide'; id: string }
  | { t: 'sessionUpdate'; id: string; groupId?: string | null; group?: { name: string; color?: string }; title?: string | null }
  | { t: 'groupUpsert'; id: string; name: string; color?: string };

export interface OutboxOpenItem {
  iid: string;
  /** `uncertain`: sent, unanswered past the deadline; maybe applied. */
  state: 'pending' | 'uncertain';
  intent: OutboxIntent;
  createdAt: number;
  /** Times it was written to a connected socket. */
  attempts: number;
  lastSentAt?: number;
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
  /** The user acknowledged this (plain ws://, non-Tailscale) URL as unencrypted on its network. */
  unencryptedAcknowledged?: boolean;
  status: HostStatus;
}

export interface HostSaveRequest {
  id?: string;
  name: string;
  url: string;
  enabled?: boolean;
  /** Set or replace the token; omitted keeps the stored one. */
  token?: string;
  /** "I understand this connection is unencrypted on this network" (needed for a plain ws:// that is not loopback or Tailscale). */
  acknowledgeUnencrypted?: boolean;
}

/** The Settings "Test" button's request. */
export interface HostTestRequest {
  url: string;
  token?: string;
  id?: string;
  acknowledgeUnencrypted?: boolean;
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
  tea?: TeaState;
  teaAvailable?: boolean;
  hostId: string;
  deviceId: string;
  connected: boolean;
  bootId: string | null;
  groups: GroupRecord[];
  sessions: SessionRecord[];
  /** Durable local renames still awaiting server confirmation, including uncertain delivery. */
  pendingTitles?: Record<string, string | null>;
  pendingGroups?: Record<string, { name: string; color?: string }>;
  /** Sessions closed while this device could not hear about it (from probes). */
  closedIds: string[];
  lost: Record<string, LostInfo>;
  /** Terminals open in this app whose re-open the server has not confirmed on the current connection. */
  restoring?: string[];
}

/** What each window receives: the registries, plus its role in placing sessions. */
export interface RegistryPayload {
  views: RemoteRegistryView[];
  /** This window adds sessions the device does not show yet (exactly one window is). */
  placer: boolean;
  /** Remote tabs the device's OTHER windows already show. */
  elsewhere: string[];
}
