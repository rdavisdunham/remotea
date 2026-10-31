/** Diagnostics never include file contents, environment variables, tokens or error messages. */
export type IntegrationProvider = 'Claude Code' | 'OpenCode' | 'Kiro' | 'omp' | 'pi' | 'Grok' | 'Antigravity' | 'Qwen Code';
export type IntegrationFeatureName = 'instructions' | 'hooks' | 'orchestrator' | 'browserMcp';
export type IntegrationFileState = 'present' | 'missing' | 'modified' | 'error';

export interface IntegrationFailure {
  provider: IntegrationProvider;
  operation: 'write' | 'remove';
  code: string;
}

export interface IntegrationFileStatus {
  provider: IntegrationProvider;
  feature: IntegrationFeatureName;
  path: string;
  state: IntegrationFileState;
  code?: string;
}

export interface IntegrationStatus {
  environment: 'desktop-user';
  checkedAt: number;
  runtime: 'not-probed';
  files: IntegrationFileStatus[];
  failures: IntegrationFailure[];
}

/** Validate the bridge response before rendering enums as translation or feature keys. */
export function isIntegrationStatus(value: unknown): value is IntegrationStatus {
  if (!value || typeof value !== 'object') return false;
  const status = value as IntegrationStatus;
  const features = ['instructions', 'hooks', 'orchestrator', 'browserMcp'];
  const states = ['present', 'missing', 'modified', 'error'];
  return status.environment === 'desktop-user'
    && status.runtime === 'not-probed'
    && Number.isFinite(status.checkedAt)
    && Array.isArray(status.files)
    && status.files.every(file => file && typeof file.provider === 'string'
      && typeof file.path === 'string' && features.includes(file.feature)
      && states.includes(file.state) && (file.code === undefined || typeof file.code === 'string'))
    && Array.isArray(status.failures)
    && status.failures.every(failure => failure && typeof failure.provider === 'string'
      && (failure.operation === 'write' || failure.operation === 'remove')
      && typeof failure.code === 'string');
}
