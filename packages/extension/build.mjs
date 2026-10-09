import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// Builds the unpacked extension into dist/, ready for "Load unpacked" or zipping for the store.
const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'dist');
const require = createRequire(import.meta.url);
const version = JSON.parse(readFileSync(join(here, '../cli/package.json'), 'utf8')).version;
const analyzerScript = readFileSync(require.resolve('@breakhound/analyzers/inject'), 'utf8');

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(join(here, 'static'), out, { recursive: true });

const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
// Chrome only takes plain dotted numbers, so a prerelease like 1.0.0-beta.2 ships as 1.0.0.
manifest.version = version.split('-')[0];
writeFileSync(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

await build({
  entryPoints: {
    panel: join(here, 'src/panel.ts'),
    devtools: join(here, 'src/devtools.ts'),
    background: join(here, 'src/background.ts'),
  },
  outdir: out,
  bundle: true,
  format: 'iife',
  target: 'chrome120',
  // Readable code, which store review asks for, and functions sent to the page keep their source.
  minify: false,
  legalComments: 'none',
  logLevel: 'warning',
  alias: { 'node:crypto': join(here, 'src/shims/crypto.ts') },
  define: {
    __ANALYZER_SCRIPT__: JSON.stringify(analyzerScript),
    __VERSION__: JSON.stringify(version),
  },
});
