import { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { SplitNode, SurfaceRef, WorkspaceInfo } from '../../../shared/types';
import { useStore } from '../../store';
import { useT } from '../../i18n';
import { chatActivityState, markChatRead, useChatAttention, useLocalChatAttention } from '../../remote-sessions/chat-attention';
import { terminalInsight } from '../../remote-sessions/insight';
import { useRemoteRegistry } from '../../remote-sessions/registry-cache';
import { chatIsUnread } from '../../../shared/chat-attention';
import { surfaceAgentState } from '../../store/agent-rollup';
import type { ClaudeSessionView, HookActivityEntry } from '../../store/claude-session-view';
import { requestFocusSurface } from '../Git/open-git';
import { getSurfaceLabel } from '../SplitPane/surface-label';
import { useOscTitleLookup } from '../SplitPane/use-osc-title';
import { toolChannel } from './trace-signals';

/** Tree order includes inactive tabs and excludes browsers, files and other panels. */
export function terminalSurfaces(tree: SplitNode): SurfaceRef[] {
  if (tree.type === 'leaf') return tree.surfaces.filter(surface => surface.type === 'terminal');
  return [...terminalSurfaces(tree.children[0]), ...terminalSurfaces(tree.children[1])];
}

function reportedState(session: ClaudeSessionView | undefined) {
  if (!session) return undefined;
  if (session.blocked || session.question) return 'needs_you' as const;
  return session.working ? 'working' as const : undefined;
}

function TerminalRow({
  workspace, surface, index, oscTitle, compact,
  sessionControl, activityDetail, answering, onAnswer,
}: {
  workspace: WorkspaceInfo;
  surface: SurfaceRef;
  index: number;
  oscTitle?: string;
  compact: boolean;
  sessionControl?: ClaudeSessionView;
  activityDetail?: string;
  answering: string | null;
  onAnswer(session: ClaudeSessionView, choiceId: string): void;
}) {
  const t = useT();
  const agentLabel = useStore(state => state.agentMeta.get(surface.id)?.label);
  const { host, session, state, unread, status, hasHarness } = useChatAttention(surface.id, reportedState(sessionControl));
  const uiMode = useStore(state => state.appearancePrefs.uiMode);
  const label = getSurfaceLabel(surface, agentLabel, workspace.shell, t, oscTitle);
  const activityLabel = sessionControl?.answerPending || (state === 'working' && sessionControl?.working)
    ? activityDetail || status.label : status.label;
  const statusLabel = `${activityLabel}${host && !host.connected ? ' · offline' : ''}`;
  const { summary, stale, generatedAt } = terminalInsight(host, session, surface.cwd);
  const detail = [label, summary, stale ? 'New exchanges since this summary' : undefined, generatedAt ? `Summary generated ${new Date(generatedAt).toLocaleString()}` : undefined, statusLabel, activityDetail, session?.agentState?.reason, surface.currentCwd || surface.cwd].filter(Boolean).join('\n');
  return <div className="workspace-terminal-entry">
    <button
    type="button"
    className={`workspace-terminal${compact ? ' workspace-terminal--preview' : ''}`}
    data-surface-id={surface.id}
    data-tone={status.tone}
    data-tr-live={uiMode === 'trace' && sessionControl?.working ? '1' : undefined}
    data-tr-chan={uiMode === 'trace' ? toolChannel(sessionControl?.tool ?? null) ?? undefined : undefined}
    title={detail}
    draggable={false}
    onClick={event => {
      event.stopPropagation();
      requestFocusSurface(workspace.id, surface.id);
      markChatRead(surface.id);
    }}
  >
    {!compact && <span className="workspace-terminal__number">{index + 1}</span>}
    <span className="workspace-terminal__content">
      <span className="workspace-terminal__name">{label}</span>
      {!compact && summary && <span className="workspace-terminal__summary">{summary}{stale ? ' · recent activity' : ''}</span>}
      {/* A plain shell has no state worth a line of its own; the tooltip keeps it. */}
      <span className="workspace-terminal__status" data-quiet={!hasHarness && status.tone === 'idle' && !unread && session?.state !== 'lost' && !(host && !host.connected) ? 'true' : undefined}>{statusLabel}</span>
    </span>
    {unread && <span className="workspace-terminal__unread" role="img" aria-label="Unread">●</span>}
    </button>
    {!compact && sessionControl && sessionControl.choices.length > 0 && (
      <div className="workspace-row__answers">
        {sessionControl.choices.map(choice => (
          <button
            key={choice.id}
            type="button"
            className="workspace-row__answer"
            disabled={answering === surface.id}
            title={t('workspaceRow.answerTitle', 'Answer without switching to this pane')}
            onClick={event => {
              event.stopPropagation();
              onAnswer(sessionControl, choice.id);
            }}
          >{choice.label}</button>
        ))}
      </div>
    )}
  </div>;
}

export default function WorkspaceTerminals({
  id, workspace, terminals, expanded, hookActivity, claudeActivity,
  sessions, activityDetails, answering, onAnswer,
}: {
  id: string;
  workspace: WorkspaceInfo;
  terminals: SurfaceRef[];
  expanded: boolean;
  hookActivity?: Record<string, HookActivityEntry>;
  claudeActivity?: Record<string, { lastUpdate?: number }>;
  sessions: ClaudeSessionView[];
  activityDetails: Record<string, string>;
  answering: string | null;
  onAnswer(session: ClaudeSessionView, choiceId: string): void;
}) {
  const t = useT();
  const oscTitleFor = useOscTitleLookup();
  const views = useRemoteRegistry(state => state.views);
  const localAttention = useLocalChatAttention(state => state.entries);
  const signals = useStore(useShallow(state => ({ declared: state.agentStates, detected: state.agentDetections })));
  const preview = useMemo(() => terminals.map(surface => {
    const host = views?.find(view => view.sessions.some(session => session.id === surface.id));
    const session = host?.sessions.find(session => session.id === surface.id);
    const attention = session ? session.chatAttention : localAttention[surface.id];
    const declared = signals.declared[surface.id];
    const detected = signals.detected[surface.id];
    const control = sessions.find(control => control.surfaceId === surface.id);
    const fallback = surfaceAgentState(declared, detected)?.state ?? (!session?.agentState ? reportedState(control) : undefined);
    const state = chatActivityState(session, fallback);
    const needsAttention = chatIsUnread(attention, host?.deviceId ?? 'local') || state === 'needs_you';
    const activityAt = Math.max(
      session?.createdAt ?? 0,
      session?.lastActivityAt ?? 0,
      session?.agentState?.since ?? 0,
      attention?.at ?? 0,
      declared?.idleSince ?? 0,
      declared?.blockedSince ?? 0,
      detected?.observedAt ?? 0,
      hookActivity?.[surface.id]?.lastSeen ?? 0,
      claudeActivity?.[surface.id]?.lastUpdate ?? 0,
    );
    return { surface, needsAttention, activityAt };
  }).sort((a, b) => Number(b.needsAttention) - Number(a.needsAttention) || b.activityAt - a.activityAt)[0]?.surface,
  [terminals, views, localAttention, signals, hookActivity, claudeActivity, sessions]);
  const shown = expanded ? terminals : preview ? [preview] : [];
  return <div id={id} className={expanded ? 'workspace-terminals' : 'workspace-terminal-preview'} role="group" aria-label={t('workspaceRow.terminals', 'Terminals')}>
    {shown.map(surface => <TerminalRow
      key={surface.id}
      workspace={workspace}
      surface={surface}
      index={terminals.indexOf(surface)}
      oscTitle={oscTitleFor(surface.id)}
      compact={!expanded}
      sessionControl={sessions.find(session => session.surfaceId === surface.id)}
      activityDetail={activityDetails[surface.id]}
      answering={answering}
      onAnswer={onAnswer}
    />)}
  </div>;
}
