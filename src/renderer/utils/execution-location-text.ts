import type { TranslationKey } from '../i18n';
import type { ExecutionLocation } from '../../shared/execution-location';
type Translate = (key: TranslationKey, fallback?: string) => string;
export function executionLocationText(t: Translate, location: ExecutionLocation, hosts: Record<string, { name: string }> = {}): string {
  return location.kind === 'local' ? t('execution.local') : hosts[location.hostId]?.name ?? t('execution.remote').replace('{host}', location.hostId);
}
export function executionWarningText(t: Translate, warning: string, location: ExecutionLocation): string {
  return warning.startsWith('Saved host') && location.kind === 'remote' ? t('execution.hostMissing').replace('{host}', location.hostId) : t('execution.invalidDirectory');
}
