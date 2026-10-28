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
 * Claude drops SessionStart output silently when the hook times out and does
 * not block input meanwhile (stage A); the hook's timeout is set to 10 s in
 * claude-hooks.ts, well above this budget plus node start-up.
 */
import crypto from 'crypto';
import { ERIDANI_LIMITS, ERIDANI_TIMING, truncateText } from '../../src/shared/eridani-link-protocol';
import type { SessionRecord } from '../../src/shared/remote-host-protocol';

const SESSION_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const SOURCES = new Set(['startup', 'resume', 'clear', 'compact']);

export interface ContextDeps {
  session(id: string): SessionRecord | undefined;
  /** The link is configured and enabled (it may still be disconnected). */
  enabled(): boolean;
  request(body: Record<string, unknown> & { t: string; req_id: string }, ms: number): Promise<Record<string, unknown> | null>;
  /** The run token the spawn carried, for a surface Eridani started. */
  runToken?(id: string): string | null;
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
    const token = (typeof res?.run_token === 'string' && /^[\x21-\x7e]{1,512}$/.test(res.run_token) ? res.run_token : null) ?? this.deps.runToken?.(surf) ?? null;
    const tool = provider === 'codex' ? 'codex_cli' : 'claude_code';
    const lines: string[] = [];
    if (res && typeof res.text === 'string' && res.text.trim()) {
      lines.push(truncateText(res.text, ERIDANI_LIMITS.contextChars).text.trimEnd());
    } else {
      this.deps.log?.(`context for ${surf}: no answer from Eridani in time`);
      lines.push(`remotea: this is ${tool} session ${sessionId || '(unknown)'} on ${surf}${b ? `, Eridani run ${b.runId} (generation ${b.generation})` : ''}. Eridani's context was not available.`);
    }
    if (token) lines.push(`Eridani run token: ${token} (pass it as run_token to Eridani's task tools)`);
    return lines.join('\n\n') + '\n';
  }
}
