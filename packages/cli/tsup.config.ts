import { copyFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

// The internal @breakhound/* packages are bundled in, and so is magic-string
// (small, and ESM/CommonJS interop would otherwise differ between the plugin
// builds). Only real npm deps stay external.
const shared = {
  format: ['esm'] as const,
  platform: 'node' as const,
  target: 'node20',
  noExternal: [/^@breakhound\//],
  external: ['playwright', 'jiti', '@babel/parser'],
  sourcemap: false,
  splitting: false,
};

export default defineConfig([
  {
    ...shared,
    entry: { cli: 'src/index.ts' },
    banner: { js: '#!/usr/bin/env node' },
    onSuccess: async () => {
      // The analyzer bundle is injected into scanned pages; it ships next to cli.js.
      copyFileSync('../analyzers/dist/inject.js', 'dist/inject.js');
    },
  },
  {
    // The public API is only defineConfig and types, so it ships for require() too.
    ...shared,
    format: ['esm', 'cjs'],
    entry: { index: 'src/lib.ts' },
  },
  {
    // Build plugins that mark elements with their source line in development.
    // shims gives the CommonJS build a working import.meta.url.
    ...shared,
    format: ['esm', 'cjs'],
    shims: true,
    entry: { vite: 'src/vite.ts', next: 'src/next.ts', webpack: 'src/webpack.ts' },
  },
  {
    // Webpack and Turbopack load this by path, with require().
    ...shared,
    format: ['cjs'],
    entry: { 'source-loader': 'src/source-loader.ts' },
    // It sets module.exports on purpose: this entry is only ever built as CommonJS, so esbuild's
    // warning about CommonJS in an ES module package doesn't apply.
    esbuildOptions(options) {
      options.logOverride = { ...options.logOverride, 'commonjs-variable-in-esm': 'silent' };
    },
  },
]);
