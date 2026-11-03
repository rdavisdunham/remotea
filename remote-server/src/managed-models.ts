import fs from 'fs';
import path from 'path';
import { ClaudeRuntimeAdapter } from './managed-harness';
import type { ModelCatalogEntry } from '../../src/shared/eridani-link-protocol';
/** Use the installed harness's catalog, including model-specific effort levels. */
export function hostModelCatalog(codexCache: string): ModelCatalogEntry[] {
  try {
    const cache = JSON.parse(fs.readFileSync(codexCache, 'utf8'));
    if (!Array.isArray(cache.models)) return [];
    let selectedModel: string | undefined;
    try { const top = fs.readFileSync(path.join(path.dirname(codexCache), 'config.toml'), 'utf8').split(/^\s*\[/m)[0]; const match = /^\s*model\s*=\s*(["'])([^"'\r\n]+)\1/m.exec(top); selectedModel = match?.[2]; } catch { /* catalog defaults still apply */ }
    return cache.models.filter((m: any) => typeof m.slug === 'string' && m.visibility !== 'hidden').map((m: any) => ({ harness: 'codex' as const, model: m.slug, label: m.display_name ?? m.slug, default: m.default === true || m.is_default === true || m.slug === cache.default_model || m.slug === selectedModel, efforts: (m.supported_reasoning_levels ?? []).map((x: any) => x.effort).filter((x: unknown) => typeof x === 'string'), default_effort: m.default_reasoning_level, permission_profiles: ['read-only', 'workspace-write'] }));
  } catch { return []; }
}

/** The CLI's initialize response is authoritative for Claude aliases and effort levels. No inference turn is started. */
export async function claudeModelCatalog(bin = 'claude'): Promise<ModelCatalogEntry[]> {
  const adapter = new ClaudeRuntimeAdapter({ harness: 'claude', bin, args: [], cwd: process.cwd(), env: {}, model: 'default', profile: 'read-only' }, 10_000);
  let catalog: ModelCatalogEntry[] = [];
  adapter.on('fault', () => {});
  adapter.on('catalog', (models: any[]) => { catalog = models.filter((m) => typeof m.value === 'string').map((m) => ({ harness: 'claude', model: m.value, label: m.displayName, default: m.value === 'default', efforts: Array.isArray(m.supportedEffortLevels) ? m.supportedEffortLevels : [], permission_profiles: ['read-only', ...(m.supportsAutoMode ? ['workspace-write'] : [])] })); });
  try { await adapter.start(); return catalog; } catch { return []; } finally { await adapter.stop().catch(() => {}); }
}

/** Verified structured transports; a newer untested protocol never silently becomes a native PTY. */
export function managedVersionSupported(harness: string, version: string | null, platform = process.platform): boolean {
  if (platform !== 'linux' || !version) return false;
  if (harness === 'codex') return /^0\.166\.\d+$/.test(version);
  const match = /^2\.1\.(\d+)$/.exec(version);
  return harness === 'claude' && !!match && Number(match[1]) >= 312 && Number(match[1]) <= 317;
}
