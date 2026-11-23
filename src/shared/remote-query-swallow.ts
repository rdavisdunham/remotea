/**
 * Terminal queries the remotea server answers for a remote session, and that
 * the app's xterm must therefore NOT answer too (a doubled reply leaks into the
 * shell as junk like `[?62;4;9;22c` on the command line).
 *
 * The server answers because it is the one terminal that is always there —
 * the app comes and goes with sleep and Wi-Fi, and an agent probing for its
 * cursor position must get an answer either way. See
 * remote-server/src/queries.ts; remote-server/tests/queries.test.ts proves a
 * terminal with this installed emits nothing for every query the server answers.
 *
 * Structural parser type so this compiles for both @xterm/xterm and @xterm/headless.
 */

interface ParserLike {
  registerCsiHandler(id: { prefix?: string; intermediates?: string; final: string }, cb: (params: unknown) => boolean): unknown;
  registerOscHandler(ident: number, cb: (data: string) => boolean): unknown;
  registerDcsHandler(id: { prefix?: string; intermediates?: string; final: string }, cb: (data: string, params: unknown) => boolean): unknown;
}

export function installRemoteQuerySwallow(term: { parser: ParserLike }): void {
  const swallow = () => true;
  const p = term.parser;
  p.registerCsiHandler({ final: 'c' }, swallow); // DA1
  p.registerCsiHandler({ prefix: '>', final: 'c' }, swallow); // DA2
  p.registerCsiHandler({ final: 'n' }, swallow); // DSR status, CPR
  p.registerCsiHandler({ prefix: '?', final: 'n' }, swallow); // DECXCPR, DEC DSRs
  p.registerCsiHandler({ intermediates: '$', final: 'p' }, swallow); // DECRQM (ANSI)
  p.registerCsiHandler({ prefix: '?', intermediates: '$', final: 'p' }, swallow); // DECRQM (DEC)
  p.registerDcsHandler({ intermediates: '$', final: 'q' }, swallow); // DECRQSS
  // Colour QUERIES only; a colour SET must still reach xterm.
  for (const code of [10, 11, 12]) p.registerOscHandler(code, (data) => data === '?');
}

/** Browser xterm sends automatic reports on the same data event as the keyboard.
 * A daemon querying its cursor or colors must never reorder someone's terminal list. */
export function isTerminalInteraction(data: string): boolean {
  if (!data) return false;
  const esc = String.fromCharCode(27);
  if (!data.startsWith(esc)) return true;
  const sequence = data.slice(1);
  if (sequence.startsWith(']') || sequence.startsWith('P')) return false;
  return !/^\[(?:[IO]|[?>][\d;]*c|\??\d+;\d+R|\d+n|\??\d+;\d+\$y|\d+(?:;\d+){2}t)$/.test(sequence);
}
