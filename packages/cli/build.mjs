// Builds the published package: bundles, type declarations and the config schema.
import { execFileSync } from 'node:child_process';
import { copyFileSync, rmSync } from 'node:fs';

const run = (cmd, args) =>
  execFileSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32' });

rmSync('dist', { recursive: true, force: true });
run('node', ['../analyzers/build.mjs']);
run('npx', ['tsup']);
// One declaration file per public entry, with the internal packages inlined.
for (const [entry, out] of [
  ['src/lib.ts', 'index'],
  ['src/vite.ts', 'vite'],
  ['src/next.ts', 'next'],
  ['src/webpack.ts', 'webpack'],
]) {
  run('npx', [
    'dts-bundle-generator',
    '--silent',
    '--no-banner',
    '--project',
    'tsconfig.dts.json',
    '--external-inlines',
    '@breakhound/engine',
    '@breakhound/analyzers',
    '@breakhound/source',
    '-o',
    `dist/${out}.d.ts`,
    entry,
  ]);
  copyFileSync(`dist/${out}.d.ts`, `dist/${out}.d.cts`);
}
run('node', ['schema.mjs']);
