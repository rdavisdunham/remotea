#!/usr/bin/env node
/**
 * Bundle the preload into ONE CommonJS file: dist/preload/index.js.
 *
 * The app window runs with `sandbox: true` (docs/remotea/desktop-security.md).
 * A sandboxed preload's `require` only knows `electron`, `events`, `timers` and
 * `url` — not a relative path — so tsc's per-file output (which requires
 * ../shared/types.js and ../shared/host-info.js) would fail with "module not
 * found" and leave the renderer without `window.wmux`. Runs after
 * `tsc -p tsconfig.node.json` (part of `npm run build:main`) and overwrites
 * tsc's dist/preload/index.js with the bundle.
 *
 * Fails the build if anything but `electron` is left as a require.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(repo, 'dist', 'preload');

await build({
  configFile: false,
  root: repo,
  publicDir: false,
  logLevel: 'warn',
  build: {
    outDir,
    emptyOutDir: false,
    minify: false,
    sourcemap: false,
    target: 'es2022',
    copyPublicDir: false,
    reportCompressedSize: false,
    lib: {
      entry: path.join(repo, 'src', 'preload', 'index.ts'),
      formats: ['cjs'],
      fileName: () => 'index.js',
    },
    rolldownOptions: {
      external: ['electron'],
    },
  },
});

const out = fs.readFileSync(path.join(outDir, 'index.js'), 'utf8');
const requires = [...out.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
const foreign = requires.filter((r) => r !== 'electron');
if (foreign.length) {
  console.error(`bundle-preload: the sandboxed preload may only require "electron"; found: ${foreign.join(', ')}`);
  process.exit(1);
}
if (!out.includes('exposeInMainWorld')) {
  console.error('bundle-preload: dist/preload/index.js does not expose the bridge');
  process.exit(1);
}
console.log(`bundle-preload: dist/preload/index.js (${out.length} bytes, requires: ${[...new Set(requires)].join(', ') || 'none'})`);
