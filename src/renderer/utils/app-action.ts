import type { ShortcutAction } from '../store/settings-slice';

/** A UI command, not a synthetic keypress: rebinding never changes its meaning. */
export const APP_ACTION_EVENT = 'remotea:app-action';

export function dispatchAppAction(action: ShortcutAction): boolean {
  const event = new CustomEvent(APP_ACTION_EVENT, { detail: { action }, cancelable: true });
  document.dispatchEvent(event);
  return event.defaultPrevented;
}

export function listenAppActions(handlers: Partial<Record<ShortcutAction, () => void>>): () => void {
  const listener = (event: Event) => {
    if (!(event instanceof CustomEvent) || event.defaultPrevented) return;
    const action = event.detail?.action;
    if (typeof action !== 'string' || !Object.hasOwn(handlers, action)) return;
    const handler = handlers[action as ShortcutAction];
    if (!handler) return;
    event.preventDefault();
    handler();
  };
  document.addEventListener(APP_ACTION_EVENT, listener);
  return () => document.removeEventListener(APP_ACTION_EVENT, listener);
}
