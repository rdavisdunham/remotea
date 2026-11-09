/**
 * Stage E: the collector cutover. The mode switch (parity → authoritative and
 * back), the status --json v2 interlock (checked against the real Python
 * collector when ~/jarvis is on this machine), and the removal of the Python
 * collector's SessionStart hook, owned entries only.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Writable } from 'stream';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { parseUpFrame, type UpFrame } from '../../src/shared/eridani-link-protocol';
import { ERIDANI_FILE, loadEridaniConfig, saveEridaniConfig, writeEridaniToken } from '../src/config';
import { COLLECTOR_STATE_FILES, EridaniRuntime } from '../src/eridani-runtime';
import { EridaniLink } from '../src/eridani-link';
import { eridaniCommand } from '../src/eridani-cli';
import { buildStatus, fmtLegacyRemoval, STATUS_VERSION, STATUS_VERSION_PARITY, statusVersion } from '../src/cli';
import { isLegacyCollectorCommand, removeLegacyCollectorHooks, type HookPaths } from '../src/hooks-install';
import { Hub } from '../src/hub';
import { Registry } from '../src/registry';
import { fakeSpawner, ManualTimers } from './helpers';

const FIXTURE_HOME = path.join(__dirname, 'fixtures', 'collector', 'home');
const PY_COLLECTOR = path.join(os.homedir(), 'jarvis', 'scripts', 'session_collector', 'collector.py');

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function tmpDir(prefix = 'remotea-cutover-'): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

async function until(cond: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** A fake Eridani that acks every op, or refuses the ones `refuse` picks (once each). */
class FakeEridani {
  readonly wss: WebSocketServer;
  readonly frames: UpFrame[] = [];
  epoch = 0;
  refuse: (f: UpFrame) => boolean = () => false;
  /** Frames not acked yet (released with `release()`); acks for them go to the connection that is open then. */
  hold: (f: UpFrame) => boolean = () => false;
  held: UpFrame[] = [];
  private last: WebSocket | null = null;
  constructor() {
    this.wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    this.wss.on('connection', (ws: WebSocket) => {
      this.last = ws;
      ws.on('message', (data) => {
        const f = parseUpFrame(JSON.parse(String(data)));
        if (!f) return;
        this.frames.push(f);
        if (f.t === 'hello') this.send(ws, { t: 'welcome', host_id: 'host-1', conn_epoch: ++this.epoch, server_time: Date.now() });
        else if ('op_id' in f && this.hold(f)) this.held.push(f);
        else if ('op_id' in f) {
          const no = this.refuse(f);
          this.send(ws, { t: 'ack', acked_id: f.id, ok: !no, ...(no ? { error: 'refused for the test' } : {}) });
        }
      });
    });
  }
  release(): void {
    this.hold = () => false;
    for (const f of this.held.splice(0)) if (this.last) this.send(this.last, { t: 'ack', acked_id: f.id, ok: true });
  }
  get url(): string {
    return `ws://127.0.0.1:${(this.wss.address() as { port: number }).port}/link`;
  }
  send(ws: WebSocket, body: Record<string, unknown>): void {
    ws.send(JSON.stringify({ v: 1, id: `e-${Math.random()}`, conn_epoch: this.epoch, at: Date.now(), ...body }));
  }
  reports(parity: boolean): Array<UpFrame & { entity: string; revision: string }> {
    return this.frames.filter((f) => f.t === 'session.report' && (f as unknown as { parity: boolean }).parity === parity) as never;
  }
  close(): Promise<void> {
    for (const s of this.wss.clients) s.terminate();
    return new Promise((r) => this.wss.close(() => r()));
  }
}

async function runtimeSetup(mode: 'parity' | 'authoritative') {
  const eri = new FakeEridani();
  cleanups.push(() => eri.close());
  await new Promise((r) => eri.wss.once('listening', r));
  const dir = tmpDir();
  writeEridaniToken(dir, 'eri_bot_test0123456789');
  saveEridaniConfig(dir, { enabled: true, url: eri.url, machine: 'cutover-box', collector: mode, collector_scope: 'all' });
  const registry = Registry.load({ file: null, bootId: 'boot-1' });
  const hub = new Hub({ registry, spawn: fakeSpawner().spawn, bootId: 'boot-1', serverId: 'srv', hostname: 'box', timers: new ManualTimers(), probe: () => ({}) });
  const logs: string[] = [];
  const rt = new EridaniRuntime({
    dir, hub, registry, serverId: 'srv', bootId: 'boot-1', hostname: 'box', version: '9.9.9',
    log: (m) => logs.push(m),
    collectorHome: FIXTURE_HOME,
    windowsUsers: null,
    checkMs: 3_600_000,
    scanMs: 3_600_000,
    resumeAgents: false,
    // Never the real login shell from a test.
    probe: async () => ({ ok: true, version: '1.0.0' }),
  });
  cleanups.push(() => rt.stop());
  rt.start();
  return { eri, dir, rt, logs };
}

const stateFile = (dir: string, mode: 'parity' | 'authoritative') => path.join(dir, COLLECTOR_STATE_FILES[mode]);
const recorded = (dir: string, mode: 'parity' | 'authoritative'): Record<string, { fingerprint: string }> => {
  try {
    return JSON.parse(fs.readFileSync(stateFile(dir, mode), 'utf8')).sessions;
  } catch {
    return {};
  }
};

describe('collector mode switch', () => {
  it('parity → authoritative: every source is sent once more without the parity flag, under its own fingerprints', async () => {
    const { eri, dir, rt, logs } = await runtimeSetup('parity');
    await until(() => logs.some((l) => /report\(s\) queued/.test(l)));
    const queued = Number(/(\d+) report\(s\) queued/.exec(logs.find((l) => /report\(s\) queued/.test(l))!)![1]);
    expect(queued).toBeGreaterThan(2);
    await until(() => new Set(eri.reports(true).map((r) => r.entity)).size === queued && Object.keys(recorded(dir, 'parity')).length === queued);
    const parityEntities = new Set(eri.reports(true).map((r) => r.entity));
    expect(eri.reports(false)).toHaveLength(0);
    expect(fs.existsSync(stateFile(dir, 'authoritative'))).toBe(false);
    const hello1 = eri.frames.filter((f) => f.t === 'hello').at(-1) as unknown as { caps: string[] };
    expect(hello1.caps).not.toContain('collector.authoritative');

    saveEridaniConfig(dir, { ...loadEridaniConfig(dir)!, collector: 'authoritative' });
    rt.check();
    await until(() => new Set(eri.reports(false).map((r) => r.entity)).size === parityEntities.size);
    await until(() => Object.keys(recorded(dir, 'authoritative')).length === parityEntities.size);
    // Same sources, same fingerprints: only the flag (and where they are recorded) differs.
    const auth = new Map(eri.reports(false).map((r) => [r.entity, r.revision]));
    for (const r of eri.reports(true)) expect(auth.get(r.entity)).toBe(r.revision);
    const hello2 = eri.frames.filter((f) => f.t === 'hello').at(-1) as unknown as { caps: string[] };
    expect(hello2.caps).toContain('collector.authoritative');
    // The parity record is untouched, ready for a rollback; switching back sends nothing new.
    expect(Object.keys(recorded(dir, 'parity'))).toHaveLength(parityEntities.size);
    const sent = eri.frames.length;
    saveEridaniConfig(dir, { ...loadEridaniConfig(dir)!, collector: 'parity' });
    rt.check();
    await until(() => logs.filter((l) => l.includes('(collector parity,')).length === 2);
    await new Promise((r) => setTimeout(r, 300));
    expect(eri.frames.slice(sent).filter((f) => f.t === 'session.report')).toHaveLength(0);
  });

  it('authoritative: a refused report is not recorded and goes again on the next scan', async () => {
    let victim: string | null = null;
    const eriRefuse = (f: UpFrame) => {
      const e = (f as unknown as { entity?: string }).entity ?? null;
      if (f.t !== 'session.report' || victim !== null) return false;
      victim = e;
      return true;
    };
    const { eri, dir, rt, logs } = await runtimeSetup('authoritative');
    eri.refuse = eriRefuse;
    // The refusal may race the first scan's ack handling; force a known start: one scan, one refusal.
    await until(() => logs.some((l) => /report\(s\) queued/.test(l)));
    await until(() => victim !== null && Object.keys(recorded(dir, 'authoritative')).length === new Set(eri.reports(false).map((r) => r.entity)).size - 1);
    expect(Object.values(recorded(dir, 'authoritative')).map((r) => (r as { entity?: string }).entity)).not.toContain(victim);
    const before = eri.reports(false).filter((r) => r.entity === victim).length;
    fs.writeFileSync(path.join(dir, 'eridani-collect-request'), '1');
    rt.check();
    await until(() => eri.reports(false).filter((r) => r.entity === victim).length > before);
    await until(() => Object.values(recorded(dir, 'authoritative')).some((r) => (r as { entity?: string }).entity === victim));
    // Only the victim went again: everything else was recorded on its first ack.
    expect(eri.reports(false).length).toBe(new Set(eri.reports(false).map((r) => r.entity)).size + 1);
  });

  it('parity reports still unacked at the switch never count as stored', async () => {
    const eri0Hold = (f: UpFrame) => f.t === 'session.report';
    const { eri, dir, rt, logs } = await runtimeSetup('parity');
    eri.hold = eri0Hold;
    await until(() => logs.some((l) => /report\(s\) queued/.test(l)));
    const queued = Number(/(\d+) report\(s\) queued/.exec(logs.find((l) => /report\(s\) queued/.test(l))!)![1]);
    await until(() => eri.held.length >= 1);
    saveEridaniConfig(dir, { ...loadEridaniConfig(dir)!, collector: 'authoritative' });
    rt.check();
    await until(() => eri.frames.filter((f) => f.t === 'hello').length === 2);
    await until(() => new Set(eri.reports(false).map((r) => r.entity)).size === queued);
    // Acks for the old parity frames arrive now, on the new connection: they must advance nothing.
    eri.release();
    await until(() => Object.keys(recorded(dir, 'authoritative')).length === queued);
    const stored = Object.values(recorded(dir, 'authoritative')) as Array<{ entity?: string }>;
    expect(new Set(stored.map((r) => r.entity))).toEqual(new Set(eri.reports(false).map((r) => r.entity)));
    expect(Object.keys(recorded(dir, 'parity'))).toHaveLength(0);
  });

  it('an authoritative report replaces a parity one of the same fingerprint still in the outbox', () => {
    const link = new EridaniLink({
      url: 'ws://127.0.0.1:9/never', token: () => null, dir: null, serverId: 's', bootId: 'b', hostname: 'h', machine: 'h', version: '1',
      harnesses: () => ({}), snapshot: () => [],
    });
    cleanups.push(() => link.stop());
    const r = { entity: 'claude_code:abc', revision: 'fp1', tool: 'claude_code' as const, session_id: 'abc', report: {} as never };
    expect(link.report(r, true)).toBe(true);
    expect(link.report(r, false)).toBe(true);
    const pending = link.spool.pending();
    expect(pending).toHaveLength(1);
    expect(pending[0].body).toMatchObject({ parity: false, revision: 'fp1' });
  });
});

describe('remotea eridani collector', () => {
  function sink() {
    let text = '';
    const out = new Writable({ write(chunk, _enc, cb) { text += String(chunk); cb(); } });
    return { out: out as unknown as NodeJS.WriteStream, text: () => text };
  }

  it('switches the mode, keeps the rest of eridani.json, and prints the checklist or the rollback', async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, ERIDANI_FILE), JSON.stringify({ enabled: true, url: 'wss://e.example/link', collector: 'parity', targets: [{ id: 'keep-me' }] }));
    const a = sink();
    expect(await eridaniCommand(dir, ['collector', 'authoritative'], async () => false, a.out)).toBe(0);
    expect(loadEridaniConfig(dir)?.collector).toBe('authoritative');
    expect(JSON.parse(fs.readFileSync(path.join(dir, ERIDANI_FILE), 'utf8')).targets).toEqual([{ id: 'keep-me' }]);
    expect(a.text()).toContain('parity → authoritative');
    expect(a.text()).toContain('systemctl --user disable --now eridani-collector.timer');
    expect(a.text()).toContain('remotea hooks --remove-legacy-collector');
    expect(a.text()).toContain('ready for cutover');

    const b = sink();
    await eridaniCommand(dir, ['collector'], async () => false, b.out);
    expect(b.text()).toBe('collector authoritative\n');

    const c = sink();
    await eridaniCommand(dir, ['collector', 'parity'], async () => false, c.out);
    expect(loadEridaniConfig(dir)?.collector).toBe('parity');
    expect(c.text()).toContain('systemctl --user enable --now eridani-collector.timer');
  });

  it('refuses an unknown mode and a link that was never set up', async () => {
    const dir = tmpDir();
    await expect(eridaniCommand(dir, ['collector', 'authoritative'], async () => false, sink().out)).rejects.toThrow(/not set up/);
    fs.writeFileSync(path.join(dir, ERIDANI_FILE), JSON.stringify({ enabled: true, url: 'wss://e.example/link' }));
    await expect(eridaniCommand(dir, ['collector', 'store'], async () => false, sink().out)).rejects.toThrow(/usage/);
    expect(loadEridaniConfig(dir)?.collector).toBe('parity');
  });

  it('an unknown value in eridani.json reads as parity', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, ERIDANI_FILE), JSON.stringify({ enabled: true, url: 'wss://x', collector: 'AUTHORITATIVE' }));
    expect(loadEridaniConfig(dir)?.collector).toBe('parity');
  });
});

describe('status --json v2 interlock', () => {
  /** A config dir whose server port answers nothing (status never reaches a real server). */
  function statusDir(collector?: string): string {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ port: 1, hookPort: 2, bind: ['127.0.0.1'] }));
    if (collector) fs.writeFileSync(path.join(dir, ERIDANI_FILE), JSON.stringify({ enabled: true, url: 'wss://e.example/link', collector }));
    return dir;
  }

  it('v2 only while the collector is authoritative', async () => {
    expect(statusVersion('authoritative')).toBe(STATUS_VERSION);
    expect(STATUS_VERSION).toBe(2);
    for (const m of ['parity', 'off', null, undefined] as const) expect(statusVersion(m)).toBe(STATUS_VERSION_PARITY);
    expect(await buildStatus(statusDir())).toMatchObject({ version: 1, server: { collector: null } });
    expect(await buildStatus(statusDir('parity'))).toMatchObject({ version: 1, server: { collector: 'parity' } });
    expect(await buildStatus(statusDir('off'))).toMatchObject({ version: 1, server: { collector: 'off' } });
    expect(await buildStatus(statusDir('authoritative'))).toMatchObject({ version: 2, server: { collector: 'authoritative' } });
  });

  // The other half of the interlock is the Python collector's own check; run it when it is here.
  it.skipIf(!fs.existsSync(PY_COLLECTOR))('the Python collector reads v1 and refuses v2 (keeps its last terminals)', async () => {
    const work = tmpDir();
    const bin = path.join(work, 'remotea');
    const status = path.join(work, 'status.json');
    fs.writeFileSync(bin, `#!/bin/sh\ncat "${status}"\n`, { mode: 0o755 });
    const probe = [
      'import json, sys',
      `sys.path.insert(0, ${JSON.stringify(path.dirname(PY_COLLECTOR))})`,
      'import collector',
      'state = {"remotea": {"installed": False, "live": {"old": {}}, "groups": {}}}',
      'print(json.dumps(collector.remotea(state)))',
    ].join('\n');
    const read = async (collectorMode: string) => {
      const dir = statusDir(collectorMode);
      const s = await buildStatus(dir);
      s.sessions = [{ id: 'surf-1', groupName: 'G', state: 'live', lastActivityAt: 1, createdAt: 1, agent: { provider: 'claude', sessionId: 'sess-1' } } as never];
      fs.writeFileSync(status, JSON.stringify(s));
      return JSON.parse(execFileSync('python3', ['-I', '-c', probe], { env: { ...process.env, REMOTEA_BIN: bin }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
    };
    const v1 = await read('parity');
    expect(v1.installed).toBe(true);
    expect(Object.keys(v1.live)).toEqual(['sess-1']);
    const v2 = await read('authoritative');
    expect(v2.installed).toBe(false);
    expect(v2.live).toEqual({ old: {} });
  });
});

describe('remotea hooks --remove-legacy-collector', () => {
  function home(): { p: HookPaths; settings: string } {
    const h = tmpDir('remotea-legacy-hooks-');
    fs.mkdirSync(path.join(h, '.claude'));
    return { p: { home: h, cliDir: path.join(h, 'cli'), sourceDir: path.join(h, 'src') }, settings: path.join(h, '.claude', 'settings.json') };
  }

  it('matches the exact script path only', () => {
    const h = '/home/u';
    for (const ok of [
      '/home/u/jarvis/scripts/session_collector/session_hook.py',
      'python3 /home/u/jarvis/scripts/session_collector/session_hook.py',
      'python3 ~/jarvis/scripts/session_collector/session_hook.py',
      'python3 "$HOME/jarvis/scripts/session_collector/session_hook.py"',
      "/usr/bin/python3 '${HOME}/jarvis/scripts/session_collector/session_hook.py'",
      '/usr/bin/env python3 /home/u/jarvis/scripts/session_collector/session_hook.py',
      '  python3.12   /home/u/jarvis/scripts/session_collector/session_hook.py  ',
    ]) expect(isLegacyCollectorCommand(ok, h), ok).toBe(true);
    for (const no of [
      'python3 /home/u/other/session_hook.py',
      'python3 /home/u/jarvis/scripts/session_collector/session_hook.py --extra',
      'python3 /home/u/jarvis/scripts/session_collector/session_hook.py; rm -rf /',
      'python3 /home/u/jarvis/scripts/session_collector/session_hook.py | tee log',
      'node /home/u/jarvis/scripts/session_collector/session_hook.py',
      'python3 /home/other/jarvis/scripts/session_collector/session_hook.py',
      'python3 /home/u/jarvis/scripts/session_collector/session_hook.py.bak',
      'bash -c "python3 /home/u/jarvis/scripts/session_collector/session_hook.py"',
      'session_hook.py',
      'node "/home/u/.local/share/remotea/cli/wmux-hook.js" --event SessionStart',
      42,
      undefined,
    ]) expect(isLegacyCollectorCommand(no, h), String(no)).toBe(false);
  });

  it('strips only the owned handler from a group shared with unrelated hooks; everything else is byte-for-byte kept', () => {
    const { p, settings } = home();
    const legacy = `python3 ${p.home}/jarvis/scripts/session_collector/session_hook.py`;
    const original = {
      model: 'opus',
      hooks: {
        SessionStart: [
          {
            matcher: 'startup|resume',
            hooks: [
              { type: 'command', command: "'/home/u/.local/bin/moshi-hook' claude-hook", async: true },
              { type: 'command', command: legacy },
              { type: 'command', command: 'python3 /somewhere/else/session_hook.py' },
            ],
          },
          { hooks: [{ type: 'command', command: `${p.home}/jarvis/scripts/session_collector/session_hook.py` }] },
          { hooks: [{ type: 'command', command: 'node "/x/wmux-hook.js" --event SessionStart' }] },
        ],
        Stop: [{ hooks: [{ type: 'command', command: legacy }] }],
      },
    };
    fs.writeFileSync(settings, JSON.stringify(original, null, 2));

    const dry = removeLegacyCollectorHooks(p, { dryRun: true });
    expect(dry.removed).toHaveLength(2);
    expect(JSON.parse(fs.readFileSync(settings, 'utf8'))).toEqual(original);
    expect(fmtLegacyRemoval(dry)).toContain('would remove');

    const res = removeLegacyCollectorHooks(p);
    expect(res.removed).toEqual([legacy, `${p.home}/jarvis/scripts/session_collector/session_hook.py`]);
    const after = JSON.parse(fs.readFileSync(settings, 'utf8'));
    expect(after.model).toBe('opus');
    expect(after.hooks.SessionStart).toEqual([
      {
        matcher: 'startup|resume',
        hooks: [
          { type: 'command', command: "'/home/u/.local/bin/moshi-hook' claude-hook", async: true },
          { type: 'command', command: 'python3 /somewhere/else/session_hook.py' },
        ],
      },
      { hooks: [{ type: 'command', command: 'node "/x/wmux-hook.js" --event SessionStart' }] },
    ]);
    // Only SessionStart is the collector's: the same command under another event is someone else's choice.
    expect(after.hooks.Stop).toEqual(original.hooks.Stop);
    expect(JSON.parse(fs.readFileSync(`${settings}.remotea-backup`, 'utf8'))).toEqual(original);
    // Idempotent.
    expect(removeLegacyCollectorHooks(p).removed).toEqual([]);
    expect(fs.readFileSync(settings, 'utf8')).toBe(JSON.stringify(after, null, 2) + '\n');
  });

  it('drops SessionStart (and hooks) when the legacy hook was all there was; prints the timer step only when the unit exists', () => {
    const { p, settings } = home();
    fs.writeFileSync(settings, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `python3 ~/jarvis/scripts/session_collector/session_hook.py` }] }] } }));
    let res = removeLegacyCollectorHooks(p, { dryRun: true });
    expect(res.timerUnit).toBeNull();
    expect(fmtLegacyRemoval(res)).not.toContain('systemctl');
    const units = path.join(p.home, '.config', 'systemd', 'user');
    fs.mkdirSync(units, { recursive: true });
    fs.writeFileSync(path.join(units, 'eridani-collector.timer'), '[Timer]\n');
    res = removeLegacyCollectorHooks(p);
    expect(res.removed).toHaveLength(1);
    expect(res.timerUnit).toBe(path.join(units, 'eridani-collector.timer'));
    expect(fmtLegacyRemoval(res)).toContain('systemctl --user disable --now eridani-collector.timer');
    expect(JSON.parse(fs.readFileSync(settings, 'utf8'))).toEqual({});
  });

  it('no settings file, or no SessionStart: nothing written', () => {
    const { p, settings } = home();
    expect(removeLegacyCollectorHooks(p).removed).toEqual([]);
    expect(fs.existsSync(settings)).toBe(false);
    fs.writeFileSync(settings, '{"hooks":{"Stop":[]}}');
    expect(removeLegacyCollectorHooks(p).removed).toEqual([]);
    expect(fs.readFileSync(settings, 'utf8')).toBe('{"hooks":{"Stop":[]}}');
  });
});
