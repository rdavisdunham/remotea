import { create } from 'zustand';
import { WorkspaceSlice, createWorkspaceSlice } from './workspace-slice';
import { SettingsSlice, createSettingsSlice } from './settings-slice';
import { NotificationSlice, createNotificationSlice } from './notification-slice';
import { SurfaceSlice, createSurfaceSlice } from './surface-slice';
import { AgentSlice, createAgentSlice } from './agent-slice';
import { ProgressSlice, createProgressSlice } from './progress-slice';
import { AgentStateSlice, createAgentStateSlice } from './agent-state-slice';
import { PromptSlice, createPromptSlice } from './prompt-slice';
import { OscTitleSlice, createOscTitleSlice } from './osc-title-slice';

export type WmuxStore = WorkspaceSlice & SettingsSlice & NotificationSlice & SurfaceSlice & AgentSlice & ProgressSlice & AgentStateSlice & PromptSlice & OscTitleSlice;

export const useStore = create<WmuxStore>()((...args) => ({
  ...createWorkspaceSlice(...args),
  ...createSettingsSlice(...args),
  ...createNotificationSlice(...args),
  ...createSurfaceSlice(...args),
  ...createAgentSlice(...args),
  ...createProgressSlice(...args),
  ...createAgentStateSlice(...args),
  ...createPromptSlice(...args),
  ...createOscTitleSlice(...args),
}));
