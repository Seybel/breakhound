import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RouteResult } from '@breakhound/report';
import { vitePlugin } from '@breakhound/source';
import { createServer, type ViteDevServer } from 'vite';
import { afterAll, describe, expect, it } from 'vitest';
import { relativeSources, runScan } from '../src/scan';

const root = join(import.meta.dirname, '../../../fixtures/apps/vite-source');
const servers: ViteDevServer[] = [];

async function serve(withPlugin: boolean): Promise<string> {
  const server = await createServer({
    root,
    configFile: false,
    logLevel: 'silent',
    plugins: withPlugin ? [vitePlugin()] : [],
    server: { port: 0, host: '127.0.0.1' },
    // Scans write no files here, but keep Vite's cache out of the fixture too.
    cacheDir: join(root, '../../../node_modules/.vite-source-test'),
  });
  await server.listen();
  servers.push(server);
  return server.resolvedUrls?.local[0] ?? '';
}

afterAll(async () => {
  for (const s of servers) await s.close();
});

async function bannerSource(url: string) {
  const { result } = await runScan({
    targets: [url],
    config: {
      widths: { min: 320, max: 800 },
      screenshots: false,
      outDir: join(root, '../../../node_modules/.bh-source-out'),
    },
    cwd: root,
    version: 'test',
    quiet: true,
  });
  const issue = result.routes[0]?.issues.find((i) => i.element.selector.includes('banner'));
  return issue?.element.source;
}

describe('source locations', () => {
  it('points at the exact line with the Vite plugin', async () => {
    expect(await bannerSource(await serve(true))).toEqual({
      file: 'src/App.jsx',
      line: 11,
      column: 9,
      exact: true,
    });
  });

  it('still finds the file and component from React dev info without any setup', async () => {
    expect(await bannerSource(await serve(false))).toEqual({
      file: 'src/App.jsx',
      component: 'App',
      exact: false,
    });
  });
});

describe('source paths at the root of a monorepo', () => {
  it('are relative to where breakhound ran, not to the app it found there', () => {
    const root = mkdtempSync(join(tmpdir(), 'breakhound-sources-'));
    mkdirSync(join(root, 'apps/web/src'), { recursive: true });
    writeFileSync(join(root, 'apps/web/src/App.jsx'), '');
    const element = { selector: '.banner', source: { file: '/src/App.jsx', exact: true } };
    const routes = [{ issues: [{ element }] }] as unknown as RouteResult[];
    relativeSources(routes, join(root, 'apps/web'), '', join('apps', 'web'));
    expect(element.source).toEqual({ file: 'apps/web/src/App.jsx', exact: true });
  });
});
