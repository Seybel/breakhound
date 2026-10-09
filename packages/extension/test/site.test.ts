import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { type Browser, chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Cdp } from '../src/cdp';
import { scanSite } from '../src/site';

const analyzerScript = readFileSync(
  createRequire(import.meta.url).resolve('@breakhound/analyzers/inject'),
  'utf8',
);

const page = (body: string) =>
  `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{margin:0;font:16px/1.4 Arial,sans-serif}main{padding:16px}</style></head><body><main>${body}</main></body></html>`;
const nav =
  '<a href="/about">About</a> <a href="/pricing">Pricing</a> <a href="/blog/a">A</a> <a href="/blog/b">B</a> <a href="/blog/c">C</a> <a href="/blog/d">D</a> <a href="/logout">Log out</a> <a href="/report.pdf">PDF</a> <a href="https://elsewhere.example/">Elsewhere</a>';

let server: Server;
let origin: string;
let browser: Browser;
const requests: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = req.url ?? '/';
    requests.push(path);
    if (path === '/old-pricing') {
      res.writeHead(302, { location: '/pricing' }).end();
      return;
    }
    const pages: Record<string, string> = {
      '/': page(`<h1>Home</h1>${nav} <a href="/old-pricing">Old pricing</a>`),
      '/about': page(`<h1>About</h1>${nav}`),
      // A planted bug: a banner that never shrinks.
      '/pricing': page(
        `<h1>Pricing</h1>${nav}<div style="width:600px;height:40px;background:#eee">Plans</div>`,
      ),
      '/blog/a': page(`<h1>A</h1>${nav}`),
      '/blog/b': page(`<h1>B</h1>${nav}`),
      '/blog/c': page(`<h1>C</h1>${nav}`),
      '/blog/d': page(`<h1>D</h1>${nav}`),
    };
    const body = pages[path];
    if (!body) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch({ args: ['--window-size=1000,700'] });
});

afterAll(async () => {
  await browser?.close();
  server?.close();
});

/** The Vue Router app from the route tests, built for production and served as a single-page app. */
async function serveVueApp(): Promise<{ url: string; close: () => void }> {
  const outfile = join(mkdtempSync(join(tmpdir(), 'breakhound-vue-')), 'app.js');
  await build({
    entryPoints: [join(import.meta.dirname, '../../../fixtures/apps/vue-router.js')],
    bundle: true,
    minify: true,
    format: 'esm',
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
  const app = createServer((req, res) => {
    if (req.url === '/app.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' }).end(script);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(
      '<!doctype html><html><head><meta name="viewport" content="width=device-width"></head><body><div id="app"></div><script type="module" src="/app.js"></script></body></html>',
    );
  });
  await new Promise<void>((r) => app.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${(app.address() as AddressInfo).port}`,
    close: () => app.close(),
  };
}

describe('scanning the whole site from the tab', () => {
  it("takes the pages from the app's own router when it has one", async () => {
    const app = await serveVueApp();
    const context = await browser.newContext({ viewport: null });
    const tab = await context.newPage();
    await tab.goto(`${app.url}/account`);
    await tab.waitForSelector('h1');
    const session = await context.newCDPSession(tab);
    const cdp: Cdp = {
      send: (method, params) =>
        session.send(method as 'Runtime.evaluate', params as never) as never,
    };
    try {
      const { routes, from } = await scanSite(cdp, {
        analyzerScript,
        minWidth: 320,
        maxWidth: 800,
      });
      expect(from).toBe('the Vue router');
      // The order page needs a real order id, and nothing links to one, so it is left out.
      expect(routes.map((r) => r.route).sort()).toEqual(['/', '/account']);
    } finally {
      await context.close();
      app.close();
    }
  }, 180_000);

  it('follows links the way the CLI does, and ends back on the page it started from', async () => {
    const context = await browser.newContext({ viewport: null });
    const tab = await context.newPage();
    await tab.goto(`${origin}/about`);
    const session = await context.newCDPSession(tab);
    const cdp: Cdp = {
      send: (method, params) =>
        session.send(method as 'Runtime.evaluate', params as never) as never,
    };
    const visited: string[] = [];
    try {
      const { routes, from } = await scanSite(cdp, {
        analyzerScript,
        minWidth: 320,
        maxWidth: 800,
        onPage: ({ route }) => visited.push(route),
      });
      expect(from).toBe('links on your pages');
      // The page the developer was on first, then home, then what links lead to.
      expect(visited.slice(0, 2)).toEqual(['/about', '/']);
      const scanned = routes.map((r) => r.route).sort();
      expect(scanned).toEqual(['/', '/about', '/blog/a', '/blog/b', '/blog/c', '/pricing']);
      expect(routes.every((r) => r.status === 'scanned')).toBe(true);
      // Only a few pages of the same kind, and never a logout, a file or another site.
      expect(requests).not.toContain('/blog/d');
      expect(requests).not.toContain('/logout');
      expect(requests).not.toContain('/report.pdf');
      // A redirect to a page scanned anyway isn't scanned twice.
      expect(scanned.filter((r) => r === '/pricing')).toHaveLength(1);

      const pricing = routes.find((r) => r.route === '/pricing');
      expect(pricing?.issues.map((i) => i.detector)).toContain('page-overflow');
      expect(routes.find((r) => r.route === '/about')?.issues).toEqual([]);

      expect(tab.url()).toBe(`${origin}/about`);
    } finally {
      await context.close();
    }
  }, 180_000);
});
