/**
 * Content-Security-Policy for the DESKTOP renderer (src/renderer/index.html),
 * injected as a <meta> by vite.config.ts at BUILD time only — the dev server
 * needs an inline React-refresh preamble that `script-src 'self'` would block.
 *
 * The renderer holds the preload bridge (`window.wmux`, which can write into
 * any PTY), and renders untrusted markdown through DOMPurify. This policy is
 * the second wall behind DOMPurify: no inline script, no inline event
 * handlers, no eval, no plugins, no <base> hijack — so markup that slips past
 * the sanitizer still cannot run code.
 *
 * Deliberately NOT restricted (see docs/remotea/desktop-security.md):
 *  - img-src: markdown and release notes show remote images (README badges).
 *  - frame-src/child-src and default-src: the browser panel is a <webview>,
 *    implemented with an internal frame; a frame-src default would put arbitrary
 *    sites the user opens at the mercy of this policy.
 *  - style-src: xterm and React set inline styles.
 * 'wasm-unsafe-eval' is for @xterm/addon-image's WASM sixel decoder; it allows
 * compiling WebAssembly, not JavaScript eval.
 */
export const RENDERER_CSP = [
  "script-src 'self' 'wasm-unsafe-eval'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "worker-src 'self' blob:",
].join('; ');

const CSP_META = `<meta http-equiv="Content-Security-Policy" content="${RENDERER_CSP}" />`;

/** Insert the CSP meta into the document head, ahead of every script. Idempotent. */
export function injectRendererCsp(html: string): string {
  if (html.includes('http-equiv="Content-Security-Policy"')) return html;
  // After <meta charset> when there is one (it wants to stay first), else
  // straight after <head>; either way ahead of every <script>.
  const anchor = /<meta\s+charset[^>]*>/i.exec(html) ?? /<head[^>]*>/i.exec(html);
  if (!anchor) throw new Error('renderer-csp: index.html has no <head>');
  const at = anchor.index + anchor[0].length;
  return `${html.slice(0, at)}\n  ${CSP_META}${html.slice(at)}`;
}

/** Whether a Vite html entry is the desktop renderer (not the phone console). */
export function isDesktopRendererHtml(filename: string): boolean {
  const norm = filename.replace(/\\/g, '/');
  return norm.endsWith('/renderer/index.html');
}
