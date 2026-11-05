import fs from 'fs';
import { ClaudeRuntimeAdapter, CodexRuntimeAdapter } from './managed-harness';
import type { ModelCatalogEntry } from '../../src/shared/eridani-link-protocol';
/** Use the installed harness's catalog, including model-specific effort levels. */
export function hostModelCatalog(codexCache: string): ModelCatalogEntry[] {
  try {
    const cache = JSON.parse(fs.readFileSync(codexCache, 'utf8'));
    if (!Array.isArray(cache.models)) return [];
    return cache.models.filter((m: any) => typeof m.slug === 'string' && m.visibility !== 'hidden').map((m: any) => ({ harness: 'codex' as const, model: m.slug, label: m.display_name ?? m.slug, default: m.default === true || m.is_default === true || m.slug === cache.default_model, efforts: (m.supported_reasoning_levels ?? []).map((x: any) => x.effort).filter((x: unknown) => typeof x === 'string'), default_effort: m.default_reasoning_level, permission_profiles: ['read-only', 'workspace-write'] }));
  } catch { return []; }
}

/** The CLI's initialize response is authoritative for Claude aliases and effort levels. No inference turn is started. */
export async function claudeModelCatalog(bin = 'claude'): Promise<ModelCatalogEntry[]> {
  const adapter = new ClaudeRuntimeAdapter({ harness: 'claude', bin, args: [], cwd: process.cwd(), env: {}, model: 'default', profile: 'read-only' }, 10_000);
  let catalog: ModelCatalogEntry[] = [];
  adapter.on('fault', () => {});
  adapter.on('catalog', (models: any[]) => { catalog = models.filter((m) => typeof m.value === 'string').map((m) => ({ harness: 'claude', model: m.value === 'default' && typeof m.resolvedModel === 'string' ? m.resolvedModel : m.value, label: m.value === 'default' && m.resolvedModel ? `${m.displayName} (${m.resolvedModel})` : m.displayName, default: m.value === 'default', efforts: Array.isArray(m.supportedEffortLevels) ? m.supportedEffortLevels : [], permission_profiles: ['read-only', ...(m.supportsAutoMode ? ['workspace-write'] : [])] })); });
  try { await adapter.start(); return catalog; } catch { return []; } finally { await adapter.stop().catch(() => {}); }
}

/** Claude Code 2.1.x patch levels verified for managed runs. 2.1.312 is the stage A spike floor (structured
 * questions); 318: CLI flags and the initialize / set_permission_mode / interrupt control responses match 317. */
export const CLAUDE_MANAGED_MIN = 312;
export const CLAUDE_MANAGED_MAX = 318;

/** The highest Claude Code 2.1.x patch managed runs accept: REMOTEA_MANAGED_CLAUDE_MAX (`320` or `2.1.320`) lets
 * the owner accept an auto-updated launcher without a release; it never goes below CLAUDE_MANAGED_MIN. Anything
 * unparseable keeps the built-in bound. */
export function claudeManagedMax(env: NodeJS.ProcessEnv = process.env): number {
  const match = /^(?:2\.1\.)?(\d{1,5})$/.exec(env.REMOTEA_MANAGED_CLAUDE_MAX?.trim() ?? '');
  return match ? Math.max(Number(match[1]), CLAUDE_MANAGED_MIN) : CLAUDE_MANAGED_MAX;
}

/** Verified structured transports; a newer untested protocol never silently becomes a native PTY. */
export function managedVersionSupported(harness: string, version: string | null, platform = process.platform, env: NodeJS.ProcessEnv = process.env): boolean {
  if (platform !== 'linux' || !version) return false;
  if (harness === 'codex') return /^0\.166\.\d+$/.test(version);
  const match = /^2\.1\.(\d+)$/.exec(version);
  return harness === 'claude' && !!match && Number(match[1]) >= CLAUDE_MANAGED_MIN && Number(match[1]) <= claudeManagedMax(env);
}

/** model/list performs no inference and reports the provider's authoritative default and supported efforts. */
export async function codexModelCatalog(bin = 'codex'): Promise<ModelCatalogEntry[]> {
  const adapter = new CodexRuntimeAdapter({ harness: 'codex', bin, args: [], cwd: process.cwd(), env: {}, model: '', profile: 'read-only' }, 10_000);
  adapter.on('fault', () => {});
  try { const models = await adapter.modelCatalog(); return models.filter((m) => !m.hidden && typeof m.model === 'string').map((m) => ({ harness: 'codex', model: m.model, label: m.displayName ?? m.model, default: m.isDefault === true, efforts: (m.supportedReasoningEfforts ?? []).map((e: any) => e.reasoningEffort).filter((e: unknown) => typeof e === 'string'), default_effort: m.defaultReasoningEffort, permission_profiles: ['read-only', 'workspace-write'] })); }
  catch { return []; } finally { await adapter.stop().catch(() => {}); }
}
