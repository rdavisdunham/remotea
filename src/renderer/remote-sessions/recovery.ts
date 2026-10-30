/**
 * remotea: the recovery inventory (task 2eeb1e23, Astra review A-Q3). When
 * this app starts, or reconnects to a host, what happened while it was away
 * used to be applied silently: a tab whose session was closed elsewhere
 * vanished, a terminal that exited sat there dead, a run that ended left its
 * worktree with unmerged work nobody was told about. This lists each such
 * thing once, with concrete choices, for one dialog (RecoveryDialog).
 *
 * Kinds, and their choices (the first is what happens if the user does
 * nothing, and never acts):
 *   exited     a tab here whose process exited while away:
 *              leave the tab / close it / reopen (a new terminal there, same
 *              directory), plus the worktree choices for an Eridani run;
 *   closed     a tab here whose session was closed on another device (sync
 *              drops it): keep closed / reopen;
 *   restored   a tab whose session the host lost in a restart; opening the
 *              tab respawns it (an agent resumes): reopen / keep closed.
 *              This is the one "clean" kind: nothing was lost;
 *   worktree   an ended Eridani run (not already listed) whose worktree has
 *              uncommitted or unmerged work (SessionRecord.worktreeState):
 *              keep closed / open the worktree in a new terminal / copy the
 *              branch name.
 *
 * Pure, so it can be tested without a window. Each item has a stable `key`
 * so an item the user has seen is not offered again (unless it changes).
 */
import type { SessionRecord, WorktreeStateInfo } from '../../shared/remote-host-protocol';
import type { RemoteRegistryView } from '../../shared/remote-hosts-types';

export type RecoveryKind = 'exited' | 'closed' | 'restored' | 'worktree';
export type RecoveryChoice = 'leave' | 'keep-closed' | 'reopen' | 'open-worktree' | 'copy-branch';

export interface RecoveryItem {
  key: string;
  kind: RecoveryKind;
  hostId: string;
  surfaceId: string;
  /** The workspace the tab is (or was) in, when it was shown here. */
  workspaceId?: string;
  title: string;
  /** Where Reopen starts the new terminal. */
  cwd?: string;
  /** One line: what happened. */
  detail: string;
  branch?: string;
  worktree?: string;
  /** In order; the first is the default. */
  choices: RecoveryChoice[];
  /** Nothing was lost: a session the host respawns when its tab opens. */
  clean: boolean;
}

export interface RecoveryLocalSurface {
  id: string;
  hostId: string;
  workspaceId: string;
  title?: string;
  cwd?: string;
}

export interface RecoveryState {
  views: RemoteRegistryView[];
  /** The remote tabs this window shows (before sync applies the registry). */
  local: RecoveryLocalSurface[];
  /** The hosts that just connected (or reconnected), and since when this window had not heard from each (0: app start). */
  awaySince: Record<string, number>;
  /** Keys already offered. */
  seen: ReadonlySet<string>;
}

export interface RecoveryInventory {
  items: RecoveryItem[];
  /** Every item is a clean restore (or there are none). */
  onlyClean: boolean;
}

export const CHOICE_LABEL: Record<RecoveryChoice, string> = {
  leave: 'Leave tab',
  'keep-closed': 'Keep closed',
  reopen: 'Reopen',
  'open-worktree': 'Open worktree in a new terminal',
  'copy-branch': 'Copy branch name',
};

function title(s: Pick<SessionRecord, 'title' | 'agent' | 'cmd'> | undefined, fallback?: string): string {
  return s?.title || fallback || s?.agent?.provider || s?.cmd || 'shell';
}

/** Uncommitted, untracked, unmerged or unpushed work in a worktree: what removing it would lose. Null when there is none. */
export function unmergedWork(w: WorktreeStateInfo | undefined): string | null {
  if (!w) return null;
  const parts: string[] = [];
  if (w.uncommitted) parts.push(`${w.uncommitted} uncommitted change${w.uncommitted === 1 ? '' : 's'}`);
  if (w.untracked) parts.push(`${w.untracked} untracked file${w.untracked === 1 ? '' : 's'}`);
  if (w.merged === false) parts.push(`not merged into ${w.baseRef}${w.ahead ? ` (${w.ahead} commit${w.ahead === 1 ? '' : 's'} ahead)` : ''}`);
  if (w.unpushed) parts.push(`${w.unpushed} unpushed commit${w.unpushed === 1 ? '' : 's'}`);
  return parts.length ? parts.join(', ') : null;
}

function clock(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function worktreeChoices(s: SessionRecord): RecoveryChoice[] {
  return s.eridani?.worktree ? ['open-worktree', 'copy-branch'] : [];
}

/** What happened while away on the hosts in `awaySince`, minus what was already offered. */
export function recoveryInventory(state: RecoveryState): RecoveryInventory {
  const items: RecoveryItem[] = [];
  const listed = new Set<string>();
  for (const view of state.views) {
    const since = state.awaySince[view.hostId];
    if (since === undefined || !view.connected) continue;
    const records = new Map(view.sessions.map((s) => [s.id as string, s]));
    const closed = new Set(view.closedIds);

    for (const tab of state.local) {
      if (tab.hostId !== view.hostId) continue;
      const rec = records.get(tab.id);
      if (closed.has(tab.id)) {
        items.push({
          key: `closed:${tab.id}`, kind: 'closed', hostId: view.hostId, surfaceId: tab.id, workspaceId: tab.workspaceId,
          title: tab.title || 'shell', cwd: tab.cwd, detail: 'Closed on another device while this one was away.',
          choices: ['keep-closed', 'reopen'], clean: false,
        });
        listed.add(tab.id);
        continue;
      }
      if (!rec || (rec.hiddenBy as string[]).includes(view.deviceId)) continue;
      if (rec.state === 'exited' && (rec.exitedAt ?? 0) > since) {
        const work = unmergedWork(rec.worktreeState);
        const code = rec.exitCode !== undefined ? ` with code ${rec.exitCode}` : '';
        items.push({
          key: `exited:${tab.id}:${rec.exitedAt ?? 0}`, kind: 'exited', hostId: view.hostId, surfaceId: tab.id, workspaceId: tab.workspaceId,
          title: title(rec, tab.title), cwd: rec.lastCwd ?? rec.cwd,
          detail: `Exited${code}${rec.exitedAt ? ` at ${clock(rec.exitedAt)}` : ''} while this device was away.${work ? ` Its worktree has ${work}.` : ''}`,
          ...(rec.eridani ? { branch: rec.eridani.branch, worktree: rec.eridani.worktree } : {}),
          choices: ['leave', 'keep-closed', 'reopen', ...worktreeChoices(rec)], clean: false,
        });
        listed.add(tab.id);
      } else if (rec.state === 'lost') {
        items.push({
          key: `restored:${tab.id}:${rec.bootId}`, kind: 'restored', hostId: view.hostId, surfaceId: tab.id, workspaceId: tab.workspaceId,
          title: title(rec, tab.title), cwd: rec.lastCwd ?? rec.cwd,
          detail: rec.agent || rec.eridani
            ? 'The host restarted; the session respawns and its agent resumes when the tab opens.'
            : 'The host restarted; a new shell starts in the same directory when the tab opens.',
          choices: ['reopen', 'keep-closed'], clean: true,
        });
        listed.add(tab.id);
      }
    }

    // Ended Eridani runs with work left in their worktree (one item per worktree).
    const worktrees = new Set<string>();
    for (const rec of view.sessions) {
      const b = rec.eridani;
      if (!b || listed.has(rec.id) || rec.state !== 'exited' || worktrees.has(b.worktree)) continue;
      if ((rec.hiddenBy as string[]).includes(view.deviceId) || closed.has(rec.id)) continue;
      const work = unmergedWork(rec.worktreeState);
      if (!work) continue;
      worktrees.add(b.worktree);
      const tab = state.local.find((t) => t.id === rec.id);
      items.push({
        key: `worktree:${view.hostId}:${b.worktree}:${work}`, kind: 'worktree', hostId: view.hostId, surfaceId: rec.id, workspaceId: tab?.workspaceId,
        title: title(rec), cwd: b.worktree, branch: b.branch, worktree: b.worktree,
        detail: `The run on ${b.branch} ended; its worktree has ${work}.`,
        choices: ['keep-closed', 'open-worktree', 'copy-branch'], clean: false,
      });
    }
  }
  const fresh = items.filter((i) => !state.seen.has(i.key));
  return { items: fresh, onlyClean: fresh.every((i) => i.clean) };
}

/** Show the dialog? Not for nothing, and not for clean restores alone when the setting says so. */
export function shouldShowRecovery(inv: RecoveryInventory, skipClean: boolean): boolean {
  if (!inv.items.length) return false;
  return !(skipClean && inv.onlyClean);
}

/** Merge newly found items into the ones already on screen (by key, newest last). */
export function mergeRecoveryItems(current: RecoveryItem[], found: RecoveryItem[]): RecoveryItem[] {
  const have = new Set(current.map((i) => i.key));
  return [...current, ...found.filter((i) => !have.has(i.key))];
}
