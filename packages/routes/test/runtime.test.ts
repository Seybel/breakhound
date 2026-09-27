import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Scanner } from '@breakhound/engine';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readLinks, readRuntimeRoutes, runtimeRoutes } from '../src/index';

const APPS = join(import.meta.dirname, '../../../fixtures/apps');
const out = mkdtempSync(join(tmpdir(), 'breakhound-apps-'));
const servers: Server[] = [];
const scanner = new Scanner();

/** Bundles a fixture app the way it ships (minified production build) and serves it as a single-page app. */
async function serve(entry: string, mount: string): Promise<string> {
  const outfile = join(out, `${entry}.js`);
  await build({
    entryPoints: [join(APPS, entry)],
    bundle: true,
    minify: true,
    format: 'esm',
    jsx: 'automatic',
    outfile,
    define: {
      'process.env.NODE_ENV': '"production"',
      __VUE_OPTIONS_API__: 'true',
      __VUE_PROD_DEVTOOLS__: 'false',
      __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false',
    },
    logLevel: 'silent',
  });
  const script = readFileSync(outfile);
  const server = createServer((req, res) => {
    if (req.url === '/app.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      res.end(script);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(
      `<!doctype html><html><head><meta name="viewport" content="width=device-width"></head><body><div id="${mount}"></div><script type="module" src="/app.js"></script></body></html>`,
    );
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function routesAt(url: string): Promise<{ from: string | undefined; paths: string[] }> {
  const found = await scanner.visit(url, (page) => page.evaluate(readRuntimeRoutes));
  const source = runtimeRoutes(found);
  return { from: source?.from, paths: (source?.routes ?? []).map((r) => r.path).sort() };
}

let reactApp: string;
let dataApp: string;
let vueApp: string;

beforeAll(async () => {
  [reactApp, dataApp, vueApp] = await Promise.all([
    serve('react-routes.jsx', 'root'),
    serve('react-data-router.jsx', 'root'),
    serve('vue-router.js', 'app'),
  ]);
});

afterAll(async () => {
  await scanner.close();
  for (const s of servers) s.close();
});

describe('reading the live router', () => {
  it('walks React Router elements, even in a minified production build', async () => {
    expect(await routesAt(`${reactApp}/`)).toEqual({
      from: 'the React Router tree',
      paths: ['/', '/about', '/products/[id]', '/settings/[[...rest]]'],
    });
  });

  it('finds routes a page declares in its own nested <Routes>', async () => {
    const { paths } = await routesAt(`${reactApp}/settings`);
    expect(paths).toEqual(
      expect.arrayContaining(['/settings', '/settings/profile', '/settings/billing/[[plan]]']),
    );
  });

  it('reads a data router', async () => {
    expect(await routesAt(`${dataApp}/`)).toEqual({
      from: 'the React Router tree',
      paths: ['/', '/blog', '/blog/[slug]', '/docs/[[...rest]]'],
    });
  });

  it('reads Vue Router, leaving out redirects and the catch-all', async () => {
    expect(await routesAt(`${vueApp}/`)).toEqual({
      from: 'the Vue router',
      paths: ['/', '/account', '/account/orders/[orderId]'],
    });
  });

  it('collects same-origin links', async () => {
    const links = await scanner.visit(`${reactApp}/about`, (page) => page.evaluate(readLinks));
    expect(links).toEqual(['/products/42']);
  });
});
