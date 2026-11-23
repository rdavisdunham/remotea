import { expect, it } from 'vitest';
import { isTerminalInteraction } from '../../src/shared/remote-query-swallow';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildSharedTerminals } from '../../src/main/remote-console/shared-terminals';
import { TerminalVisits } from '../../src/main/terminal-visits';
import { sharedTerminalTabs } from '../../src/renderer/utils/shared-terminals';
import type { WorkspaceInfo, SurfaceId } from '../../src/shared/types';

const a: SurfaceId = 'surf-00000000-0000-4000-8000-000000000001';
const b: SurfaceId = 'surf-00000000-0000-4000-8000-000000000002';
const web: SurfaceId = 'surf-00000000-0000-4000-8000-000000000003';
const ws = (title: string, id: SurfaceId) => ({
  id: 'ws-' + title, title, splitTree: { type: 'leaf', paneId: 'pane-1',
    surfaces: [{ id, type: 'terminal', shell: '/private/unused', cwd: '/private/cwd' }, { id: web, type: 'browser' }] },
} as WorkspaceInfo);

it('lists ordinary shell tabs across workspaces and windows, leaving their private launch details on the desktop', () => {
  const entries = sharedTerminalTabs([ws('Desk', a), ws('Lab', b)], new Map(), [], {});
  expect(entries.map(r => r.s)).toEqual([a, b]);
  const metadata = (id: string) => ({ terminalIdentity: id, source: null, readable: true, lastInteractedAt: id === b ? 10 : null });
  const result = buildSharedTerminals([[entries[0]], [entries[0], { ...entries[1], writable: true, source: { serverId:'spoof' } }]], metadata);
  expect(result.map(r => r.s)).toEqual([b, a]);
  expect(result.every(r => !r.writable && r.source === null)).toBe(true);
  expect(JSON.stringify(result)).not.toContain('/private/');
  expect(buildSharedTerminals([entries], id => id === a ? null : metadata(id))).toHaveLength(1);
});

it('restores personal recency after restarting and keeps unknown history below visited panes', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'remotea-visits-'));
  try {
    const file = path.join(dir, 'visits.json');
    const visits = new TerminalVisits(file);
    expect(visits.get(b)).toBeNull();
    visits.note(a, 20); visits.note(b, 30); visits.note(a, 35);
    visits.flush();
    const restored = new TerminalVisits(file);
    expect(restored.get(a)).toBe(35);
    expect(restored.get(b)).toBe(30);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it('keeps xterm cursor, focus, color, and device replies out of the human visit clock', () => {
  for (const data of ['', '\x1b[I', '\x1b[O', '\x1b[?1;2c', '\x1b[>0;276;0c', '\x1b[34;8R',
    '\x1b[?1;1R', '\x1b[0n', '\x1b[?2026;1$y', '\x1b[8;30;90t', '\x1b]10;rgb:ffff/ffff/ffff\x1b\\',
    '\x1bP1$r0m\x1b\\']) expect(isTerminalInteraction(data)).toBe(false);
  for (const data of ['x', 'hello', '\r', '\x03', '\x1b[A', '\x1b[<64;3;4M', '\x1b[200~paste\x1b[201~'])
    expect(isTerminalInteraction(data)).toBe(true);
});
