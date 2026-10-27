import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Registry } from '../src/registry';
import type { SessionRecord } from '../../src/shared/remote-host-protocol';

function rec(id: `surf-${string}`, extra: Partial<SessionRecord> = {}): SessionRecord {
  return { id, groupId: 'grp-a', cwd: '/tmp', createdBy: 'dev-aaaaaaaa', createdAt: 1, bootId: 'boot-1', state: 'live', hiddenBy: [], ...extra };
}

function tmpFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'remotea-reg-')), 'registry.json');
}

describe('Registry', () => {
  it('close is idempotent and leaves a tombstone even for unknown ids', () => {
    const r = Registry.load({ file: null, bootId: 'boot-1' });
    r.addSession(rec('surf-1'));
    expect(r.closeSession('surf-1', 'dev-aaaaaaaa')?.id).toBe('surf-1');
    expect(r.closeSession('surf-1', 'dev-bbbbbbbb')).toBeUndefined();
    expect(r.sessionTombstone('surf-1')?.by).toBe('dev-aaaaaaaa');
    r.closeSession('surf-never', 'dev-aaaaaaaa');
    expect(r.sessionTombstone('surf-never')).toBeDefined();
  });

  it('closing a group tombstones every session in it, including hidden ones', () => {
    const r = Registry.load({ file: null, bootId: 'boot-1' });
    r.upsertGroup('grp-a', { name: 'A' }, 'dev-aaaaaaaa');
    r.addSession(rec('surf-1'));
    r.addSession(rec('surf-2', { hiddenBy: ['dev-bbbbbbbb'] }));
    r.addSession(rec('surf-3', { groupId: 'grp-b' }));
    expect(r.closeGroup('grp-a', 'dev-aaaaaaaa').sort()).toEqual(['surf-1', 'surf-2']);
    expect(r.session('surf-3')).toBeDefined();
    expect(r.groupTombstone('grp-a')).toBeDefined();
    // A closed group is never resurrected; new sessions fall back to the inbox.
    expect(r.upsertGroup('grp-a', { name: 'A' }, 'dev-aaaaaaaa')).toBeNull();
    expect(r.resolveGroup('grp-a', { name: 'A' }, 'dev-aaaaaaaa').groupId).toBe('grp-inbox');
  });

  it('marks the previous boot\'s live sessions lost, keeping what a respawn needs', () => {
    const file = tmpFile();
    const r1 = Registry.load({ file, bootId: 'boot-1' });
    r1.addSession(rec('surf-1', { lastCwd: '/home/x/proj', agent: { provider: 'claude', sessionId: '11111111-2222-3333-4444-555555555555', seenAt: 1 } }));
    r1.addSession(rec('surf-2', { state: 'exited', exitCode: 0, exitedAt: Date.now() }));
    r1.saveNow();
    const epoch = r1.epoch;
    const r2 = Registry.load({ file, bootId: 'boot-2' });
    expect(r2.epoch).toBe(epoch);
    expect(r2.session('surf-1')?.state).toBe('lost');
    expect(r2.lostInfo('surf-1')).toEqual({ cwd: '/home/x/proj', title: undefined, cmd: undefined, agent: { provider: 'claude', sessionId: '11111111-2222-3333-4444-555555555555', seenAt: 1 } });
    expect(r2.session('surf-2')?.state).toBe('exited');
  });

  it('hide and unhide are per device and idempotent', () => {
    const r = Registry.load({ file: null, bootId: 'b' });
    r.addSession(rec('surf-1'));
    r.setHidden('surf-1', 'dev-aaaaaaaa', true);
    r.setHidden('surf-1', 'dev-aaaaaaaa', true);
    expect(r.session('surf-1')?.hiddenBy).toEqual(['dev-aaaaaaaa']);
    r.setHidden('surf-1', 'dev-aaaaaaaa', false);
    expect(r.session('surf-1')?.hiddenBy).toEqual([]);
  });

  it('prunes long-exited sessions and old tombstones', () => {
    let now = 1_000_000;
    const r = Registry.load({ file: null, bootId: 'b', now: () => now, exitedRetentionMs: 1000, tombstoneRetentionMs: 5000 });
    r.addSession(rec('surf-old', { state: 'exited', exitedAt: now }));
    now += 2000;
    expect(r.prune()).toEqual(['surf-old']);
    expect(r.sessionTombstone('surf-old')).toBeDefined();
    now += 10_000;
    r.prune();
    expect(r.sessionTombstone('surf-old')).toBeUndefined();
  });

  it('writes atomically and keeps an unreadable file aside', () => {
    const file = tmpFile();
    fs.writeFileSync(file, '{ not json');
    const r = Registry.load({ file, bootId: 'b' });
    r.saveNow();
    const dir = fs.readdirSync(path.dirname(file));
    expect(dir.some((f) => f.startsWith('registry.json.corrupt-'))).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).v).toBe(1);
    expect((fs.statSync(file).mode & 0o777).toString(8)).toBe('600');
  });
});
