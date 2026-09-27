import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Scanner } from '@breakhound/engine';
import { parsePattern } from '@breakhound/routes';
import { describe, expect, it } from 'vitest';
import { applyFilters, planRoutes } from '../src/app';
import { KNOWN_KEYS, loadConfig, validateConfig } from '../src/config';
import { runInit, SCHEMA_URL } from '../src/init';
import { resolveTargets } from '../src/scan';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'breakhound-'));
}

describe('targets', () => {
  it('uses the routes from the config, as given, instead of discovering them', async () => {
    const plan = await planRoutes(
      { project: null, baseUrl: 'http://localhost:3000', server: null },
      { routes: ['/', 'pricing', '/blog/[slug]', 'https://example.com/landing'] },
      new Scanner(),
      [],
    );
    expect(plan.patterns.map((p) => [p.path, p.dynamic])).toEqual([
      ['/', false],
      ['/pricing', false],
      ['/blog/[slug]', true],
    ]);
    expect(plan.urls).toEqual(['https://example.com/landing']);
    expect(plan.crawl).toBe(false);
  });

  it('filters discovered routes with include, exclude and maxRoutes', () => {
    const patterns = ['/', '/admin', '/admin/users', '/blog', '/blog/[slug]'].map(parsePattern);
    const { kept, filtered } = applyFilters(patterns, { exclude: ['/admin/**'] }, 2);
    expect(kept.map((p) => p.path)).toEqual(['/', '/blog']);
    expect(filtered).toBe(3);
    expect(applyFilters(patterns, { include: ['/blog/*'] }, 100).kept.map((p) => p.path)).toEqual([
      '/blog/[slug]',
    ]);
  });

  it('accepts bare localhost and full URLs, and drops duplicates', () => {
    const t = resolveTargets(['localhost:5173/about', 'http://localhost:5173/about'], {}, '/');
    expect(t).toEqual([{ url: 'http://localhost:5173/about', route: '/about' }]);
  });

  it('labels local files by their path, so two index.html files stay apart', () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'a'));
    mkdirSync(join(dir, 'b'));
    writeFileSync(join(dir, 'a/index.html'), '');
    writeFileSync(join(dir, 'b/index.html'), '');
    const t = resolveTargets(['a/index.html', 'b/index.html'], {}, dir);
    expect(t.map((x) => x.route)).toEqual([join('a', 'index.html'), join('b', 'index.html')]);
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
      "const port: number = 4321;\nexport default { baseUrl: 'http://localhost:' + port, routes: ['/'] };\n",
    );
    const { config, file } = await loadConfig(dir);
    expect(file).toBe(join(dir, 'breakhound.config.ts'));
    expect(config.baseUrl).toBe('http://localhost:4321');
  });

  it('is optional', async () => {
    expect(await loadConfig(tempDir())).toEqual({ config: {}, file: null, warnings: [] });
  });

  it('resolves defineConfig from breakhound without it being installed', async () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, 'breakhound.config.ts'),
      "import { defineConfig } from 'breakhound';\nexport default defineConfig({ baseUrl: 'http://localhost:5173' });\n",
    );
    const { config } = await loadConfig(dir);
    expect(config.baseUrl).toBe('http://localhost:5173');
  });

  it('warns about typos and rejects values that would break the scan', async () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, 'breakhound.config.json'),
      JSON.stringify({
        baseUrl: 'http://localhost:3000',
        widht: {},
        detectors: { overlpa: false },
      }),
    );
    const { warnings } = await loadConfig(dir);
    expect(warnings).toEqual([
      expect.stringContaining('"widht"'),
      expect.stringContaining('"overlpa"'),
    ]);
    expect(() => validateConfig({ routes: '/' as unknown as string[] })).toThrow(/list of paths/);
    expect(() => validateConfig({ baseUrl: 'not a url' })).toThrow(/full URL/);
  });
});

describe('init', () => {
  it('writes a config using the dev port and ignores the report folder', () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        scripts: { dev: 'next dev -p 4000' },
        devDependencies: { breakhound: '^1' },
      }),
    );
    writeFileSync(join(dir, '.gitignore'), 'node_modules\n');
    runInit(dir);
    expect(readFileSync(join(dir, 'breakhound.config.mjs'), 'utf8')).toContain(
      "baseUrl: 'http://localhost:4000'",
    );
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toContain('.breakhound/');
  });

  it("writes a JSON config when breakhound isn't installed, so nothing fails to type-check", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }));
    writeFileSync(join(dir, 'tsconfig.json'), '{}');
    runInit(dir);
    expect(existsSync(join(dir, 'breakhound.config.ts'))).toBe(false);
    const { config, warnings } = await loadConfig(dir);
    expect((config as Record<string, unknown>).$schema).toBe(SCHEMA_URL);
    expect(warnings).toEqual([]);
  });
});

describe('config schema', () => {
  it('lists exactly the options the config accepts', async () => {
    const { buildSchema } = await import('../schema.mjs');
    expect(Object.keys(buildSchema().properties).sort()).toEqual([...KNOWN_KEYS].sort());
  });
});
