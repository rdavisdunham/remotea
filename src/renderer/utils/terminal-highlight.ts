import { create } from 'zustand';

/** A window-local pointer from Tea. Runtime-only and independent of unread state. */
export const useTerminalHighlight = create<{ surfaceId: string | null }>(() => ({
  surfaceId: null,
}));

export function highlightTerminal(surfaceId: string): void {
  useTerminalHighlight.setState({ surfaceId });
}

export function dismissTerminalHighlight(surfaceId: string): void {
  if (useTerminalHighlight.getState().surfaceId === surfaceId)
    useTerminalHighlight.setState({ surfaceId: null });
}
