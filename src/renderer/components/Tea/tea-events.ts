/** The Dani panel (TeaPanel) belongs to the window, so the sidebar and the palette only ask for it. */
export const TOGGLE_TEA_EVENT = 'remotea:toggle-tea';
export const toggleTea = (): void => {
  document.dispatchEvent(new CustomEvent(TOGGLE_TEA_EVENT));
};
