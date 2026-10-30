// @vitest-environment jsdom
/**
 * Task 0ec167e4: sessions Eridani starts are grouped by execution target and
 * task — a workspace per task, under its target in the sidebar, labelled by
 * the task title with the run's state — instead of all landing in the one
 * shared "Eridani" workspace. Manual sessions stay where they are; a setting
 * turns it off.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { planRemoteSync, type LocalIndex, type PlanInput } from '../../src/renderer/remote-sessions/plan';
import { groupSidebarWorkspaces, taskRunHealth } from '../../src/renderer/components/Sidebar/eridani-groups';
import TaskRunChip from '../../src/renderer/components/Sidebar/TaskRunChip';
import type { EridaniBinding, SessionRecord } from '../../src/shared/remote-host-protocol';
import type { RemoteRegistryView } from '../../src/shared/remote-hosts-types';
import type { EridaniTaskRef, PaneId, SplitNode, SurfaceId } from '../../src/shared/types';

const ME = 'dev-me000000';
const ERI_GROUP = 'grp-eri-0123456789abcdef';

function binding(patch: Partial<EridaniBinding> = {}): EridaniBinding {
  return {
    runId: 'run-a', generation: 1, attempt: 1, taskId: 'task-1', target: 'jarvis', harness: 'claude', model: 'm',
    worktree: '/w/jarvis/eri-a', branch: 'eri/a', base: 'main', baseSha: null, spawnOp: 'op-1', ...patch,
  };
}

function session(id: string, extra: Partial<SessionRecord> = {}): SessionRecord {
  return { id: id as `surf-${string}`, groupId: 'grp-work', cwd: '/home/me/proj', createdBy: 'dev-other000', createdAt: 1, bootId: 'b', state: 'live', hiddenBy: [], ...extra };
}

function eri(id: string, title: string, b: Partial<EridaniBinding> = {}, extra: Partial<SessionRecord> = {}): SessionRecord {
  return session(id, { groupId: ERI_GROUP as SessionRecord['groupId'], title, cwd: '/w/jarvis/eri-a', eridani: binding(b), ...extra });
}

function view(sessions: SessionRecord[]): RemoteRegistryView {
  return {
    hostId: 'desk', deviceId: ME, connected: true, bootId: 'b',
    groups: [
      { id: 'grp-work', name: 'Work', createdBy: 'dev-other000', createdAt: 1, updatedAt: 1 },
      { id: ERI_GROUP, name: 'Eridani', createdBy: 'dev-other000', createdAt: 1, updatedAt: 1 },
    ] as RemoteRegistryView['groups'],
    sessions, closedIds: [], lost: {},
  };
}

function input(views: RemoteRegistryView[], local: LocalIndex, extra: Partial<PlanInput> = {}): PlanInput {
  return { views, local, placer: true, elsewhere: new Set(), pendingMeta: new Set(), groupEridani: true, ...extra };
}

const emptyLocal: LocalIndex = { workspaces: [], surfaces: [] };
const TASK1: EridaniTaskRef = { hostId: 'desk', target: 'jarvis', taskId: 'task-1', runId: 'run-a' };

describe('placement: one workspace per Eridani task', () => {
  it('splits Eridani sessions by target and task, titled by the task; manual sessions keep their group workspace', () => {
    const plan = planRemoteSync(input([view([
      session('surf-manual'),
      eri('surf-a1', 'Fix login', {}, { createdAt: 2 }),
      eri('surf-a2', 'Fix login', { runId: 'run-a2', generation: 2 }, { createdAt: 5 }),
      eri('surf-b', 'Add search', { taskId: 'task-2', runId: 'run-b' }, { createdAt: 3 }),
      eri('surf-c', 'Remotea thing', { taskId: 'task-1', runId: 'run-c', target: 'remotea' }, { createdAt: 4 }),
      eri('surf-d', '', { taskId: null, runId: 'run-d', harness: 'codex', branch: 'eri/d' }, { createdAt: 6 }),
    ])], emptyLocal));
    expect(plan.map((a) => a.kind)).toEqual(['create-workspace', 'create-task-workspace', 'create-task-workspace', 'create-task-workspace', 'create-task-workspace']);
    expect(plan[0]).toMatchObject({ kind: 'create-workspace', groupId: 'grp-work', surfaces: [{ id: 'surf-manual' }] });
    const tasks = plan.slice(1) as Array<Extract<(typeof plan)[number], { kind: 'create-task-workspace' }>>;
    expect(tasks.map((a) => [a.title, a.task.target, a.task.taskId, a.surfaces.map((s) => s.id)])).toEqual([
      ['Fix login', 'jarvis', 'task-1', ['surf-a1', 'surf-a2']],
      ['Add search', 'jarvis', 'task-2', ['surf-b']],
      ['Remotea thing', 'remotea', 'task-1', ['surf-c']],
      // No task: grouped by run, titled harness · branch.
      ['codex · eri/d', 'jarvis', null, ['surf-d']],
    ]);
    // Never bound to the shared Eridani group: no remoteGroups anywhere in the action.
    expect(JSON.stringify(tasks)).not.toContain(ERI_GROUP);
  });

  it('a later run of the same task joins its workspace', () => {
    const local: LocalIndex = {
      workspaces: [{ id: 'ws-task', title: 'Fix login', paneIds: ['pane-1'], active: false, eridaniTask: TASK1 }],
      surfaces: [{ id: 'surf-a1', hostId: 'desk', workspaceId: 'ws-task' }],
    };
    const plan = planRemoteSync(input([view([eri('surf-a1', 'Fix login'), eri('surf-a2', 'Fix login', { runId: 'run-z', generation: 3 })])], local));
    expect(plan).toEqual([{ kind: 'insert', workspaceId: 'ws-task', paneId: 'pane-1', surfaces: [{ id: 'surf-a2', shell: 'remote:desk', cwd: '/w/jarvis/eri-a', customTitle: 'Fix login' }] }]);
  });

  it('a task workspace is never bound to the shared group its sessions belong to', () => {
    const local: LocalIndex = {
      workspaces: [{ id: 'ws-task', title: 'Fix login', paneIds: ['pane-1'], active: true, eridaniTask: TASK1 }],
      surfaces: [{ id: 'surf-a1', hostId: 'desk', workspaceId: 'ws-task' }],
    };
    expect(planRemoteSync(input([view([eri('surf-a1', 'Fix login')])], local))).toEqual([]);
    // Without the marker the same workspace would be bound to the Eridani group.
    const plain: LocalIndex = { workspaces: [{ ...local.workspaces[0], eridaniTask: undefined }], surfaces: local.surfaces };
    expect(planRemoteSync(input([view([eri('surf-a1', 'Fix login')])], plain))[0]).toMatchObject({ kind: 'bind', groupId: ERI_GROUP });
  });

  it('grouping off: Eridani sessions follow their server group as before', () => {
    const plan = planRemoteSync(input([view([eri('surf-a1', 'Fix login'), eri('surf-b', 'Add search', { taskId: 'task-2' })])], emptyLocal, { groupEridani: false }));
    expect(plan).toEqual([expect.objectContaining({ kind: 'create-workspace', groupId: ERI_GROUP, title: 'Eridani' })]);
    expect((plan[0] as { surfaces: unknown[] }).surfaces).toHaveLength(2);
  });
});

describe('sidebar: task workspaces under their target', () => {
  type W = { id: string; title: string; eridaniTask?: EridaniTaskRef };
  const ws = (id: string, task?: Partial<EridaniTaskRef>): W => ({ id, title: id, ...(task ? { eridaniTask: { ...TASK1, ...task } } : {}) });

  it('keeps ordinary workspaces in place and gathers task workspaces into one section per target, where the first sits', () => {
    const list = [ws('a'), ws('t1', {}), ws('b'), ws('r1', { target: 'remotea' }), ws('t2', { taskId: 'task-2' })];
    const items = groupSidebarWorkspaces(list, true);
    expect(items.map((i) => (i.kind === 'workspace' ? i.workspace.id : `${i.label}[${i.workspaces.map((w) => w.id).join(',')}]`)))
      .toEqual(['a', 'jarvis[t1,t2]', 'b', 'remotea[r1]']);
  });

  it('names the host when task workspaces come from more than one', () => {
    const items = groupSidebarWorkspaces([ws('t1', {}), ws('t2', { hostId: 'laptop' })], true);
    expect(items.map((i) => (i.kind === 'target' ? i.label : ''))).toEqual(['jarvis · desk', 'jarvis · laptop']);
  });

  it('grouping off: a flat list', () => {
    expect(groupSidebarWorkspaces([ws('a'), ws('t1', {})], false).map((i) => i.kind)).toEqual(['workspace', 'workspace']);
  });

  it('the run chip shows the newest run in the workspace, from the registry', () => {
    const tree: SplitNode = {
      type: 'leaf', paneId: 'pane-1' as PaneId, activeSurfaceIndex: 0,
      surfaces: ['surf-old', 'surf-new'].map((id) => ({ id: id as SurfaceId, type: 'terminal' as const })),
    };
    const v = view([
      eri('surf-old', 'Fix login', { generation: 1 }, { state: 'exited', exitCode: 0 }),
      eri('surf-new', 'Fix login', { generation: 2, runId: 'run-new' }, { agentState: { state: 'needs_you', since: 1 } }),
      eri('surf-elsewhere', 'Other', { generation: 9 }),
    ]);
    const run = taskRunHealth({ splitTree: tree, eridaniTask: TASK1 }, [v]);
    expect(run).toMatchObject({ runId: 'run-new', state: 'needs_you', label: 'Needs you' });
    const html = renderToStaticMarkup(createElement(TaskRunChip, { run }));
    expect(html).toContain('remote-host-chip--error');
    expect(html).toContain('data-state="needs_you"');
    expect(html).toContain('Needs you');
    expect(taskRunHealth({ splitTree: tree }, [v])).toBeNull();
    expect(renderToStaticMarkup(createElement(TaskRunChip, { run: null }))).toBe('');
  });
});
