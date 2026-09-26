import { copyFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

// The internal @breakhound/* packages are bundled in; only real npm deps stay external.
const shared = {
  format: ['esm'] as const,
  platform: 'node' as const,
  target: 'node20',
  noExternal: [/^@breakhound\//],
  external: ['playwright', 'jiti'],
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
    ...shared,
    entry: { index: 'src/lib.ts' },
  },
]);
