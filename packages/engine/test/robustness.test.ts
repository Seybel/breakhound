import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Scanner } from '../src/index';

const HEAD =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{margin:0;font:16px/1.4 Arial,sans-serif}main{padding:16px}</style></head>';

const PAGES: Record<string, { body: string; headers?: Record<string, string> }> = {
  '/csp': {
    headers: { 'content-security-policy': "style-src 'self'; script-src 'self'" },
    body: `${HEAD}<body><main><h1>Strict content security policy</h1><p>Inline styles and scripts are blocked here.</p></main></body></html>`,
  },
  '/shadow': {
    body: `${HEAD}<body><main><h1>Components</h1><promo-card></promo-card></main>
<script>
customElements.define('promo-card', class extends HTMLElement {
  connectedCallback() {
    this.attachShadow({ mode: 'open' }).innerHTML =
      '<style>.banner{width:600px;padding:8px;background:#eef}</style><div class="banner">Spring offer, this week only</div>';
  }
});
</script></body></html>`,
  },
  '/feed': {
    body: `${HEAD}<body><main id="feed"></main>
<script>
const feed = document.getElementById('feed');
let n = 0;
const more = () => { for (let i = 0; i < 5; i++) { const d = document.createElement('p'); d.style.height = '300px'; d.textContent = 'Post ' + n++; feed.append(d); } };
more(); more();
addEventListener('scroll', () => { if (scrollY + innerHeight > document.documentElement.scrollHeight - 400) more(); });
</script></body></html>`,
  },
  '/restless': {
    body: `${HEAD}<body><main><div id="grid" style="display:grid;gap:8px"><div>One</div><div>Two</div><div>Three</div></div></main>
<script>
let cols = 1;
setInterval(() => { cols = cols % 3 + 1; document.getElementById('grid').style.gridTemplateColumns = 'repeat(' + cols + ', 1fr)'; }, 7);
</script></body></html>`,
  },
};

let server: Server;
let base: string;
const scanner = new Scanner();

beforeAll(async () => {
  server = createServer((req, res) => {
    const page = PAGES[req.url ?? ''];
    if (!page) {
      res.writeHead(404, { 'content-type': 'text/html' });
      res.end(`${HEAD}<body><h1>Not found</h1></body></html>`);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html', ...page.headers });
    res.end(page.body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await scanner.close();
  server.close();
});

const QUICK = { minWidth: 320, maxWidth: 1024 };

describe('pages that used to trip the scanner', () => {
  it('reports a 404 instead of scanning the error page', async () => {
    const result = await scanner.scanPage(`${base}/pricng`, QUICK);
    expect(result.status).toBe('error');
    expect(result.error).toMatch(/HTTP 404/);
  });

  it('scans pages with a strict content security policy', async () => {
    const result = await scanner.scanPage(`${base}/csp`, QUICK);
    expect(result.status).toBe('scanned');
  });

  it('looks inside web components and can screenshot what it finds there', async () => {
    const result = await scanner.scanPage(`${base}/shadow`, {
      ...QUICK,
      screenshotDir: mkdtempSync(join(tmpdir(), 'breakhound-shots-')),
    });
    expect(result.status).toBe('scanned');
    const overflow = result.issues.find((i) => i.detector === 'page-overflow');
    expect(overflow?.element.selector).toBe('promo-card >>> div.banner');
    expect(overflow?.ranges).toEqual([{ from: 320, to: 631 }]);
    expect(overflow?.screenshot).toBeDefined();
  });

  it('stops walking an infinite feed', async () => {
    const started = Date.now();
    const result = await scanner.scanPage(`${base}/feed`, QUICK);
    expect(result.status).toBe('scanned');
    expect(Date.now() - started).toBeLessThan(30_000);
  });

  it('gives up bisecting a layout that never holds still, and says so', async () => {
    const result = await scanner.scanPage(`${base}/restless`, QUICK);
    expect(result.status).toBe('scanned');
    expect(result.warnings.join(' ')).toMatch(/kept changing/);
    expect(result.measurements).toBeLessThan(400);
  });

  it('treats overflow to the left of a right-to-left page as scrolling', async () => {
    const file = join(import.meta.dirname, '../../../fixtures/pages/bug-rtl-overflow.html');
    const result = await scanner.scanPage(pathToFileURL(file).href, QUICK);
    const overflow = result.issues.find((i) => i.detector === 'page-overflow');
    expect(overflow?.severity).toBe('error');
    expect(overflow?.title).toMatch(/scrolls horizontally/);
  });

  it('launches one browser when several pages start at once', async () => {
    const launch = vi.spyOn(chromium, 'launch');
    const shared = new Scanner();
    try {
      const pages = await Promise.all([
        shared.scanPage(`${base}/csp`, QUICK),
        shared.scanPage(`${base}/shadow`, QUICK),
      ]);
      expect(pages.map((p) => p.status)).toEqual(['scanned', 'scanned']);
      expect(launch).toHaveBeenCalledTimes(1);
    } finally {
      await shared.close();
      launch.mockRestore();
    }
  });
});
