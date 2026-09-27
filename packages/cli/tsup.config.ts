import { copyFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

// The internal @breakhound/* packages are bundled in; only real npm deps stay external.
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
    clean: true,
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
]);
