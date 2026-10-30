/**
 * Where a remote host URL leads, for the add/edit host guidance (Astra review
 * A-S3). The token gives a shell on the server, and everything typed crosses
 * this connection, so a plain `ws://` is only frictionless where the network
 * itself is private or encrypted:
 *
 *   loopback       this computer (localhost, 127.0.0.0/8, ::1);
 *   tailscale      a Tailscale address: 100.64.0.0/10, fd7a:115c:a1e0::/48,
 *                  or a MagicDNS name under *.ts.net (WireGuard-encrypted);
 *   tls            wss:// to anywhere else (TLS);
 *   plain-network  ws:// to anything else (a LAN IP, a bare machine name, a
 *                  public address): unencrypted on that network, saved only
 *                  after a deliberate acknowledgement.
 *
 * Pure: used by main (enforced on save and test) and the renderer (the hint
 * and the checkbox).
 */

export type HostUrlKind = 'loopback' | 'tailscale' | 'tls' | 'plain-network';

export interface HostUrlClass {
  kind: HostUrlKind;
  /** The host part, without IPv6 brackets or a trailing dot. */
  host: string;
  /** Saving needs the "unencrypted on this network" acknowledgement. */
  needsAck: boolean;
}

export const UNENCRYPTED_ACK_LABEL = 'I understand this connection is unencrypted on this network';

function ipv4(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((n) => n <= 255) ? parts : null;
}

export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  const v4 = ipv4(h);
  if (v4) return v4[0] === 127;
  // ::1, and an IPv4-mapped 127.x (the URL parser writes ::ffff:127.0.0.1 as ::ffff:7f00:1).
  return h === '::1' || /^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(h);
}

export function isTailscaleHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h.endsWith('.ts.net')) return true;
  const v4 = ipv4(h);
  // 100.64.0.0/10: 100.64.0.0 - 100.127.255.255 (Tailscale's CGNAT range).
  if (v4) return v4[0] === 100 && v4[1] >= 64 && v4[1] <= 127;
  return /^fd7a:115c:a1e0:/.test(h);
}

/** null when `raw` is not a ws:// or wss:// URL with a host. */
export function classifyHostUrl(raw: string): HostUrlClass | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if ((u.protocol !== 'ws:' && u.protocol !== 'wss:') || !u.hostname) return null;
  const host = u.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  let kind: HostUrlKind;
  if (isLoopbackHost(host)) kind = 'loopback';
  else if (isTailscaleHost(host)) kind = 'tailscale';
  else if (u.protocol === 'wss:') kind = 'tls';
  else kind = 'plain-network';
  return { kind, host, needsAck: kind === 'plain-network' };
}

/** One line for the editor, under the URL field. */
export function hostUrlHint(c: HostUrlClass): string {
  switch (c.kind) {
    case 'loopback': return 'This computer: the connection never leaves it.';
    case 'tailscale': return 'Tailscale address: the connection is encrypted by Tailscale.';
    case 'tls': return 'wss://: the connection is encrypted with TLS.';
    case 'plain-network':
      return `ws:// to ${c.host} is not encrypted: the token and everything you type cross this network in the clear. `
        + 'Prefer the host\'s Tailscale name (*.ts.net) or 100.x address, or wss://.';
  }
}
