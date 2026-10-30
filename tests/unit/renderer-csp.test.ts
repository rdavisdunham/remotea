import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RENDERER_CSP, injectRendererCsp, isDesktopRendererHtml } from '../../src/shared/renderer-csp';

const directives = Object.fromEntries(
  RENDERER_CSP.split(';').map((d) => d.trim().split(/\s+/)).map(([name, ...values]) => [name, values]),
);

describe('renderer CSP', () => {
  it('allows no inline script and no JavaScript eval', () => {
    expect(directives['script-src']).toEqual(["'self'", "'wasm-unsafe-eval'"]);
    expect(RENDERER_CSP).not.toContain("'unsafe-inline'");
    expect(RENDERER_CSP).not.toContain("'unsafe-eval'");
  });

  it('shuts plugins, <base> and form posts', () => {
    expect(directives['object-src']).toEqual(["'none'"]);
    expect(directives['base-uri']).toEqual(["'none'"]);
    expect(directives['form-action']).toEqual(["'none'"]);
  });

  it('leaves frames (the browser panel <webview>) to their default', () => {
    expect(directives).not.toHaveProperty('default-src');
    expect(directives).not.toHaveProperty('frame-src');
    expect(directives).not.toHaveProperty('child-src');
  });

  it('goes after <meta charset>, ahead of every script, once', () => {
    const html = '<!DOCTYPE html><html><head>\n<meta charset="UTF-8" />\n<script type="module" src="./a.js"></script></head></html>';
    const out = injectRendererCsp(html);
    const csp = out.indexOf('Content-Security-Policy');
    expect(csp).toBeGreaterThan(out.indexOf('charset'));
    expect(csp).toBeLessThan(out.indexOf('<script'));
    expect(injectRendererCsp(out)).toBe(out);
    expect(injectRendererCsp('<html><head><title>x</title></head></html>')).toMatch(/<head>\n {2}<meta http-equiv="Content-Security-Policy"/);
    expect(() => injectRendererCsp('<html></html>')).toThrow(/no <head>/);
  });

  it('applies to the desktop renderer only, not the phone console', () => {
    expect(isDesktopRendererHtml('/repo/src/renderer/index.html')).toBe(true);
    expect(isDesktopRendererHtml('C:\\dev\\remotea\\src\\renderer\\index.html')).toBe(true);
    expect(isDesktopRendererHtml('/repo/src/renderer/remote/index.html')).toBe(false);
  });

  it('is wired into the Vite build', () => {
    const cfg = fs.readFileSync(path.resolve(__dirname, '../../vite.config.ts'), 'utf8');
    expect(cfg).toMatch(/apply: 'build'/);
    expect(cfg).toMatch(/isDesktopRendererHtml\(ctx\.filename\) \? injectRendererCsp\(html\)/);
  });

  it('is in the built page when a build exists', () => {
    const built = path.resolve(__dirname, '../../dist/renderer/index.html');
    if (!fs.existsSync(built)) return;
    expect(fs.readFileSync(built, 'utf8')).toContain(RENDERER_CSP);
  });
});
