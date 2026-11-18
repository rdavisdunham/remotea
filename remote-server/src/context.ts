/**
 * SessionStart grounding (decision 14, plan "context.ts").
 *
 * The hook helper calls the bridge (`remotea.context`) at SessionStart and
 * prints whatever comes back to stdout, which Claude Code and Codex inject
 * into the agent's context (verified for both in stage A). This module asks
 * Eridani: `context.request {req_id, surf, incarnation, provider,
 * provider_session_id, source, cwd, run_id, generation, task_id}` over the
 * link, waits ERIDANI_TIMING.contextMs (2.5 s), and drops a later answer.
 *
 *   - Eridani answered: its text (bounded), then the run token line when there
 *     is one (from the response, else the spawn's ERIDANI_RUN_TOKEN).
 *   - No answer (link down, slow, refused): one line naming the tool and the
 *     session id, so the agent can still identify itself to Eridani's tools.
 *   - The link is not enabled at all: nothing. A machine that never set up
 *     Eridani sees no change in its agents' context.
 *
 * D6 (stage F): the full text goes only to a surface bound to a run. An
 * unbound session (Davin's own, in a ruled folder) gets the short candidate
 * list, which Eridani marks `scope: "candidates"`; remotea prints at most
 * UNBOUND_CHARS of it and drops anything marked `scope: "run"`. When the
 * welcome advertised `context.scope`, an unscoped answer to an unbound
 * surface is dropped too; an older Eridani's unscoped answer is printed as
 * before (it can lag one release).
 *
 * A run's surface also gets one line saying whether its agent was launched
 * with Eridani's MCP server (the tools it reports through), and why not.
 *
 * Claude drops SessionStart output silently when the hook times out and does
 * not block input meanwhile (stage A); the hook's timeout is set to 10 s in
 * claude-hooks.ts, well above this budget plus node start-up.
 */
import crypto from 'crypto';
import { ERIDANI_LIMITS, ERIDANI_TIMING, truncateText } from '../../src/shared/eridani-link-protocol';
import type { SessionRecord } from '../../src/shared/remote-host-protocol';
import { ERIDANI_MCP_TOOLS, MCP_SERVER_NAME } from './eridani-mcp';

const SESSION_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const SOURCES = new Set(['startup', 'resume', 'clear', 'compact']);
/** The most an unbound session is shown (the candidate task list). */
export const UNBOUND_CHARS = 4_000;

export interface ContextDeps {
  session(id: string): SessionRecord | undefined;
  /** The link is configured and enabled (it may still be disconnected). */
  enabled(): boolean;
  request(body: Record<string, unknown> & { t: string; req_id: string }, ms: number): Promise<Record<string, unknown> | null>;
  /** The run token the spawn carried, for a surface Eridani started. */
  runToken?(id: string): string | null;
  /** Eridani's welcome advertised `context.scope` (it scopes every answer). */
  scoped?(): boolean;
  timeoutMs?: number;
  log?: (m: string) => void;
}

export class ContextService {
  constructor(private readonly deps: ContextDeps) {}

  /** The text to print for a SessionStart on surface `surf`; '' prints nothing. */
  async sessionStart(surf: string, p: Record<string, unknown>): Promise<string> {
    if (!this.deps.enabled()) return '';
    if (typeof p.agentId === 'string' && p.agentId) return '';
    const rec = this.deps.session(surf);
    if (!rec) return '';
    const provider = p.provider === 'codex' ? 'codex' : p.provider ? null : 'claude';
    if (!provider) return '';
    const sessionId = typeof p.sessionId === 'string' && SESSION_RE.test(p.sessionId) ? p.sessionId : '';
    const source = typeof p.source === 'string' && SOURCES.has(p.source) ? p.source : 'startup';
    const b = rec.eridani;
    const reqId = crypto.randomUUID();
    const res = await this.deps.request({
      t: 'context.request',
      req_id: reqId,
      surf,
      incarnation: rec.incarnation ?? 0,
      provider,
      provider_session_id: sessionId,
      source,
      cwd: rec.lastCwd ?? rec.cwd,
      run_id: b?.runId ?? null,
      generation: b?.generation ?? 0,
      task_id: b?.taskId ?? null,
    }, this.deps.timeoutMs ?? ERIDANI_TIMING.contextMs);
    const scope = res?.scope === 'run' || res?.scope === 'candidates' ? res.scope : null;
    let text = res && typeof res.text === 'string' ? res.text : '';
    if (!b && text) {
      if (scope === 'candidates' || (scope === null && !this.deps.scoped?.())) {
        if (scope === 'candidates') text = truncateText(text, UNBOUND_CHARS).text;
      } else {
        this.deps.log?.(`context for ${surf}: dropped ${scope ?? 'unscoped'} text for a surface with no run`);
        text = '';
      }
    }
    const runToken = b && typeof res?.run_token === 'string' && /^[\x21-\x7e]{1,512}$/.test(res.run_token) ? res.run_token : null;
    const token = runToken ?? this.deps.runToken?.(surf) ?? null;
    const tool = provider === 'codex' ? 'codex_cli' : 'claude_code';
    const lines: string[] = [];
    if (text.trim()) {
      lines.push(truncateText(text, ERIDANI_LIMITS.contextChars).text.trimEnd());
    } else {
      if (!res) this.deps.log?.(`context for ${surf}: no answer from Eridani in time`);
      lines.push(`remotea: this is ${tool} session ${sessionId || '(unknown)'} on ${surf}${b ? `, Eridani run ${b.runId} (generation ${b.generation})` : ''}. Eridani's context was not available.`);
    }
    if (token) lines.push(`Eridani run token: ${token} (pass it as run_token to Eridani's task tools)`);
    // Whether the spawn gave the agent Eridani's MCP server (dispatch, eridani-mcp.ts).
    if (b?.mcp?.configured) {
      lines.push(`Eridani tools: ${ERIDANI_MCP_TOOLS.join(', ')} are available via the ${MCP_SERVER_NAME} MCP server.`);
    } else if (b?.mcp) {
      lines.push(`Eridani's MCP tools (${ERIDANI_MCP_TOOLS.join(', ')}) are not available in this session: ${b.mcp.reason ?? 'not configured on this host'}.`);
    }
    // Run guidance belongs only to bound sessions. Unbound candidate lists keep
    // their complete UNBOUND_CHARS budget; legacy unscoped output stays unchanged.
    if (b) lines.push('Execution location: this terminal runs on a Remotea host, not in the desktop local backend. Run remotea identify and remotea capabilities in this shell: inside a terminal, remotea reaches the status bridge, and a status-only bridge does not expose desktop browser or workspace control. Outside a terminal, remotea administers the host. Agent activity and process exit do not establish Eridani verification or task acceptance.');
    return lines.join('\n\n') + '\n';
  }
}
