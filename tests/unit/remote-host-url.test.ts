// @vitest-environment jsdom
/**
 * Astra review A-S3: adding a host expects a Tailscale address or wss://. A
 * plain ws:// to anything but loopback or Tailscale is saved (or tested) only
 * after "I understand this connection is unencrypted on this network";
 * loopback and Tailscale stay frictionless.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { assertHostUrlAcknowledged, HostStore, type SecretBox } from '../../src/main/remote-hosts/host-config';
import { RemoteHosts } from '../../src/main/remote-hosts/index';
import { HostUrlGuidance } from '../../src/renderer/components/Settings/RemoteHostsSettings';
import { classifyHostUrl, UNENCRYPTED_ACK_LABEL } from '../../src/shared/host-url';

const fakeBox: SecretBox = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(`enc:${s}`),
  decryptString: (b) => b.toString().slice(4),
};

const dirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'remotea-url-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('classifyHostUrl', () => {
  it.each([
    'ws://localhost:7717', 'ws://127.0.0.1:7717', 'ws://127.8.9.10:7717', 'ws://[::1]:7717', 'ws://desk.localhost:7717',
    'ws://[::ffff:127.0.0.1]:7717', 'wss://localhost:7717',
  ])('loopback: %s', (url) => {
    expect(classifyHostUrl(url)).toMatchObject({ kind: 'loopback', needsAck: false });
  });

  it.each([
    'ws://100.64.0.1:7717', 'ws://100.101.102.103:7717', 'ws://100.127.255.254:7717',
    'ws://desk.tail1234.ts.net:7717', 'ws://DESK.Tail1234.TS.NET.:7717', 'ws://[fd7a:115c:a1e0::1]:7717',
  ])('Tailscale: %s', (url) => {
    expect(classifyHostUrl(url)).toMatchObject({ kind: 'tailscale', needsAck: false });
  });

  it.each([
    'ws://192.168.1.10:7717', 'ws://10.0.0.5:7717', 'ws://172.20.1.1:7717', 'ws://desk:7717', 'ws://desk.lan:7717',
    'ws://100.63.255.255:7717', 'ws://100.128.0.1:7717', 'ws://ts.net.example.com:7717', 'ws://203.0.113.9:7717',
    'ws://[fe80::1]:7717',
  ])('plain ws:// on a network: %s', (url) => {
    expect(classifyHostUrl(url)).toMatchObject({ kind: 'plain-network', needsAck: true });
  });

  it('wss:// to a LAN or public name is TLS: no acknowledgement', () => {
    expect(classifyHostUrl('wss://192.168.1.10:7717')).toMatchObject({ kind: 'tls', needsAck: false });
    expect(classifyHostUrl('wss://remotea.example.com')).toMatchObject({ kind: 'tls', needsAck: false });
  });

  it('not a host URL: null', () => {
    expect(classifyHostUrl('ws://')).toBeNull();
    expect(classifyHostUrl('http://desk:7717')).toBeNull();
    expect(classifyHostUrl('nonsense')).toBeNull();
  });
});

describe('saving a host (HostStore)', () => {
  const store = () => new HostStore(path.join(tmp(), 'hosts.json'), fakeBox);

  it('loopback and Tailscale save without any acknowledgement', () => {
    const s = store();
    expect(() => s.save({ name: 'Local', url: 'ws://127.0.0.1:7717', token: 't' })).not.toThrow();
    expect(() => s.save({ name: 'Tail', url: 'ws://100.100.1.2:7717', token: 't' })).not.toThrow();
    expect(() => s.save({ name: 'Magic', url: 'ws://desk.tail1234.ts.net:7717', token: 't' })).not.toThrow();
    expect(() => s.save({ name: 'Tls', url: 'wss://192.168.1.10:7717', token: 't' })).not.toThrow();
    expect(s.list().every((h) => h.unencryptedAckUrl === undefined)).toBe(true);
  });

  it('plain LAN ws:// is refused until acknowledged, then remembered for that URL only', () => {
    const s = store();
    expect(() => s.save({ name: 'Lan', url: 'ws://192.168.1.10:7717', token: 't' })).toThrow(/unencrypted on this network/);
    expect(s.list()).toEqual([]);
    const { host } = s.save({ name: 'Lan', url: 'ws://192.168.1.10:7717', token: 't', acknowledgeUnencrypted: true });
    expect(host.unencryptedAckUrl).toBe('ws://192.168.1.10:7717');
    // Renaming keeps the same URL: not asked again.
    expect(() => s.save({ id: host.id, name: 'Lan 2', url: 'ws://192.168.1.10:7717' })).not.toThrow();
    // Another plain address is a new decision.
    expect(() => s.save({ id: host.id, name: 'Lan 2', url: 'ws://192.168.1.11:7717' })).toThrow(/unencrypted/);
    // Moving to Tailscale drops the acknowledgement.
    s.save({ id: host.id, name: 'Lan 2', url: 'ws://desk.tail1234.ts.net:7717' });
    expect(s.get(host.id)?.unencryptedAckUrl).toBeUndefined();
    expect(() => s.save({ id: host.id, name: 'Lan 2', url: 'ws://192.168.1.10:7717' })).toThrow(/unencrypted/);
  });

  it('the acknowledgement survives a reload from disk', () => {
    const file = path.join(tmp(), 'hosts.json');
    const { host } = new HostStore(file, fakeBox).save({ name: 'Lan', url: 'ws://desk:7717', token: 't', acknowledgeUnencrypted: true });
    expect(() => new HostStore(file, fakeBox).save({ id: host.id, name: 'Lan', url: 'ws://desk:7717', enabled: false })).not.toThrow();
  });

  it('assertHostUrlAcknowledged: the error names the address and the choices', () => {
    expect(() => assertHostUrlAcknowledged('ws://10.0.0.5:7717', false)).toThrow(/ws:\/\/ to 10\.0\.0\.5 .*Tailscale.*wss:\/\//);
    expect(() => assertHostUrlAcknowledged('ws://10.0.0.5:7717', true)).not.toThrow();
    expect(() => assertHostUrlAcknowledged('ws://10.0.0.5:7717', false, 'ws://10.0.0.5:7717')).not.toThrow();
  });
});

describe('Test button (RemoteHosts.test)', () => {
  it('refuses a plain LAN ws:// before sending the token anywhere', async () => {
    const hosts = new RemoteHosts({ dataDir: tmp(), box: fakeBox, appVersion: 't', broadcast: () => {} });
    const r = await hosts.test({ url: 'ws://192.168.1.10:7717', token: 'secret' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/unencrypted on this network/);
  });
});

describe('editor guidance (HostUrlGuidance)', () => {
  const render = (url: string, acknowledged = false) => {
    const el = document.createElement('div');
    el.innerHTML = renderToStaticMarkup(createElement(HostUrlGuidance, { url, acknowledged, onAcknowledge: () => {} }));
    return el;
  };

  it('plain LAN ws:// shows the warning and the acknowledgement checkbox', () => {
    const el = render('ws://192.168.1.10:7717');
    expect(el.querySelector('[role="alert"]')?.textContent).toContain('not encrypted');
    const box = el.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(box).not.toBeNull();
    expect(box.checked).toBe(false);
    expect(el.textContent).toContain(UNENCRYPTED_ACK_LABEL);
    expect((render('ws://192.168.1.10:7717', true).querySelector('input[type="checkbox"]') as HTMLInputElement).checked).toBe(true);
  });

  it.each(['ws://127.0.0.1:7717', 'ws://desk.tail1234.ts.net:7717', 'ws://100.70.1.1:7717', 'wss://desk.lan:7717'])(
    'no checkbox for %s',
    (url) => {
      const el = render(url);
      expect(el.querySelector('input[type="checkbox"]')).toBeNull();
      expect(el.querySelector('[role="alert"]')).toBeNull();
    },
  );
});
