import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { runInit } from '../src/init';
import { resolveTargets } from '../src/scan';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'breakhound-'));
}

describe('targets', () => {
  it('joins config routes to the base URL', () => {
    const t = resolveTargets(
      [],
      { baseUrl: 'http://localhost:3000', routes: ['/', '/pricing'] },
      '/',
    );
    expect(t).toEqual([
      { url: 'http://localhost:3000/', route: '/' },
      { url: 'http://localhost:3000/pricing', route: '/pricing' },
    ]);
  });

  it('accepts bare localhost and full URLs, and drops duplicates', () => {
    const t = resolveTargets(['localhost:5173/about', 'http://localhost:5173/about'], {}, '/');
    expect(t).toEqual([{ url: 'http://localhost:5173/about', route: '/about' }]);
  });

  it('explains what to do when there is nothing to scan', () => {
    expect(() => resolveTargets([], {}, '/')).toThrow(/breakhound init/);
  });
});

describe('config', () => {
  it('loads a TypeScript config file', async () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, 'breakhound.config.ts'),
      "const port: number = 4321;\nexport default { baseUrl: `http://localhost:${port}`, routes: ['/'] };\n",
    );
    const { config, file } = await loadConfig(dir);
    expect(file).toBe(join(dir, 'breakhound.config.ts'));
    expect(config.baseUrl).toBe('http://localhost:4321');
  });

  it('is optional', async () => {
    expect(await loadConfig(tempDir())).toEqual({ config: {}, file: null });
  });
});

describe('init', () => {
  it('writes a config using the dev port and ignores the report folder', () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ scripts: { dev: 'next dev -p 4000' } }),
    );
    writeFileSync(join(dir, '.gitignore'), 'node_modules\n');
    runInit(dir);
    expect(readFileSync(join(dir, 'breakhound.config.mjs'), 'utf8')).toContain(
      "baseUrl: 'http://localhost:4000'",
    );
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toContain('.breakhound/');
  });
});
