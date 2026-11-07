import type { TeaCommand, TeaReply } from '../../shared/tea';

export function requestTea(
  hostId: string,
  command: TeaCommand,
): Promise<TeaReply> {
  const api = window.wmux?.remoteHosts?.tea;
  if (!api)
    return Promise.resolve({
      ok: false,
      error: 'Update the Remotea desktop app to use Tea.',
    });
  return api(hostId, command).catch(() => ({
    ok: false,
    uncertain: true,
    error:
      'The host did not confirm this request. Refresh Tea before retrying.',
  }));
}
