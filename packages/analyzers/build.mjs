import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// Bundles the analyzers into one script that gets injected into scanned pages.
const here = dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: [join(here, 'src/inject.ts')],
  outfile: join(here, 'dist/inject.js'),
  bundle: true,
  format: 'iife',
  target: 'chrome120',
  minify: false,
  legalComments: 'none',
  logLevel: 'warning',
});
