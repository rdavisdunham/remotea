/**
 * Terminal queries the SERVER answers on behalf of every client.
 *
 * Agents probe the terminal (DA1, cursor position, colours, mode reports)
 * and some block until they get an answer. The server's headless xterm is
 * the one terminal that is always present — clients come and go with sleep
 * and Wi-Fi — so it answers every query, attached client or not. Clients
 * swallow the same set (`installRemoteQuerySwallow` in the app) so a query
 * is never answered twice.
 *
 * Most replies come straight from headless xterm's own `onData`. Two need
 * help: DA1, where remotea advertises a richer attribute set than xterm's
 * default (see DA1 in src/main/pty-manager.ts), and OSC 10/11/12 colour
 * queries, which headless cannot answer because it has no theme service.
 */
import type { Terminal } from '@xterm/headless';

/** remotea's DA1 reply: VT220, Sixel, 9, ANSI colour — same as src/main/pty-manager.ts. */
export const DA1_REPLY = '\x1b[?62;4;9;22c';

export interface ThemeColors {
  fg: string;
  bg: string;
  cursor: string;
}

export const DEFAULT_THEME: ThemeColors = { fg: '#cccccc', bg: '#1e1e1e', cursor: '#ffffff' };

/** `#rrggbb` → `rgb:rrrr/gggg/bbbb`, the form xterm-compatible terminals reply with. */
export function toXParseColor(color: string): string | null {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color.trim());
  if (!m) return null;
  return `rgb:${m[1]}${m[1]}/${m[2]}${m[2]}/${m[3]}${m[3]}`.toLowerCase();
}

/**
 * Install the server's query overrides on a headless terminal. `reply` writes
 * to the PTY; `theme` is read at query time so a later theme message applies.
 */
export function installQueryResponders(
  term: Terminal,
  reply: (data: string) => void,
  theme: () => ThemeColors,
): void {
  // Plain DA1 only (no prefix): DA2 (`CSI > c`) and DA3 keep xterm's answers.
  term.parser.registerCsiHandler({ final: 'c' }, (params) => {
    if (params.length > 1 || (params.length === 1 && params[0] !== 0)) return false;
    reply(DA1_REPLY);
    return true;
  });
  const colorQuery = (code: 10 | 11 | 12, pick: (t: ThemeColors) => string) =>
    term.parser.registerOscHandler(code, (data) => {
      if (data !== '?') return false; // a colour SET falls through to xterm
      const value = toXParseColor(pick(theme())) ?? toXParseColor(pick(DEFAULT_THEME))!;
      reply(`\x1b]${code};${value}\x1b\\`);
      return true;
    });
  colorQuery(10, (t) => t.fg);
  colorQuery(11, (t) => t.bg);
  colorQuery(12, (t) => t.cursor);
}
