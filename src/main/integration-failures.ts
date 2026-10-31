import type { IntegrationFailure, IntegrationProvider } from '../shared/integration-status';

let failures: IntegrationFailure[] = [];

/** Only stable error codes cross IPC; OS messages may contain credentials or file contents. */
export function integrationErrorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,39}$/.test(code) ? code : 'OPERATION_FAILED';
}

export function reportIntegrationFailure(
  provider: IntegrationProvider,
  operation: IntegrationFailure['operation'],
  error: unknown,
): void {
  const failure = { provider, operation, code: integrationErrorCode(error) };
  if (!failures.some(item => item.provider === provider && item.operation === operation && item.code === failure.code)) {
    failures.push(failure);
  }
}

export function clearIntegrationFailures(): void {
  failures = [];
}

export function integrationFailures(): IntegrationFailure[] {
  return failures.map(item => ({ ...item }));
}
