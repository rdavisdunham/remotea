import type { SplitNode, SurfaceRef, WorkspaceInfo } from '../../../shared/types';
import { useStore } from '../../store';
import { useT } from '../../i18n';
import { markChatRead, useChatAttention } from '../../remote-sessions/chat-attention';
import { requestFocusSurface } from '../Git/open-git';
import { getSurfaceLabel } from '../SplitPane/surface-label';
import { useOscTitleLookup } from '../SplitPane/use-osc-title';

/** Tree order includes inactive tabs and excludes browsers, files and other panels. */
export function terminalSurfaces(tree: SplitNode): SurfaceRef[] {
  if (tree.type === 'leaf') return tree.surfaces.filter(surface => surface.type === 'terminal');
  return [...terminalSurfaces(tree.children[0]), ...terminalSurfaces(tree.children[1])];
}

function TerminalRow({ workspace, surface, index, oscTitle }: {
  workspace: WorkspaceInfo;
  surface: SurfaceRef;
  index: number;
  oscTitle?: string;
}) {
  const t = useT();
  const agentLabel = useStore(state => state.agentMeta.get(surface.id)?.label);
  const { host, session, unread, status } = useChatAttention(surface.id);
  const label = getSurfaceLabel(surface, agentLabel, workspace.shell, t, oscTitle);
  const statusLabel = `${status.label}${host && !host.connected ? ' · offline' : ''}`;
  const insight = !session?.agent || session.tea?.source === `${session.agent.provider}:${session.agent.sessionId}` ? session?.tea : undefined;
  const summary = host?.tea?.config.summaries === false ? undefined : insight?.summary || (host?.tea?.config.enabled && !session?.agent ? `Shell in ${session?.lastCwd || session?.cwd || surface.cwd || 'its current directory'}` : undefined);
  const stale = !!insight && insight.version !== session?.teaSourceVersion;
  const detail = [label, summary, stale ? 'New exchanges since this summary' : undefined, insight ? `Summary generated ${new Date(insight.generatedAt).toLocaleString()}` : undefined, statusLabel, session?.agentState?.reason, surface.currentCwd || surface.cwd].filter(Boolean).join('\n');
  return <button
    type="button"
    className="workspace-terminal"
    data-surface-id={surface.id}
    data-tone={status.tone}
    title={detail}
    draggable={false}
    onClick={event => {
      event.stopPropagation();
      requestFocusSurface(workspace.id, surface.id);
      markChatRead(surface.id);
    }}
  >
    <span className="workspace-terminal__number">{index + 1}</span>
    <span className="workspace-terminal__content">
      <span className="workspace-terminal__name">{label}</span>
      {summary && <span className="workspace-terminal__summary">{summary}{stale ? ' · recent activity' : ''}</span>}
      <span className="workspace-terminal__status">{statusLabel}</span>
    </span>
    {unread && <span className="workspace-terminal__unread" role="img" aria-label="Unread">●</span>}
  </button>;
}

export default function WorkspaceTerminals({ id, workspace, terminals }: {
  id: string;
  workspace: WorkspaceInfo;
  terminals: SurfaceRef[];
}) {
  const t = useT();
  const oscTitleFor = useOscTitleLookup();
  return <div id={id} className="workspace-terminals" role="group" aria-label={t('workspaceRow.terminals', 'Terminals')}>
    {terminals.map((surface, index) => <TerminalRow key={surface.id} workspace={workspace} surface={surface} index={index} oscTitle={oscTitleFor(surface.id)} />)}
  </div>;
}
