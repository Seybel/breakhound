import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** The loader file, next to the built plugin (dist/source-loader.cjs), or the source in this repo. */
export function loaderPath(): string {
  for (const candidate of ['./source-loader.cjs', './webpack-loader.ts']) {
    const path = fileURLToPath(new URL(candidate, import.meta.url));
    if (existsSync(path)) return path;
  }
  throw new Error('breakhound: the source loader is missing from the package.');
}
