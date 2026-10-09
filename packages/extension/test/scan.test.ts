import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { type Issue, Scanner } from '@breakhound/engine';
import { type Browser, chromium, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Cdp } from '../src/cdp';
import { routeOf, scanTab } from '../src/scan';

const PAGES = join(import.meta.dirname, '../../../fixtures/pages');
const SCAN = { minWidth: 320, maxWidth: 1440 };
const analyzerScript = readFileSync(
  createRequire(import.meta.url).resolve('@breakhound/analyzers/inject'),
  'utf8',
);

let browser: Browser;
let scanner: Scanner;

beforeAll(async () => {
  // Narrower than the widest width scanned, so wide widths are zoomed out to fit, as in a docked DevTools.
  browser = await chromium.launch({ args: ['--window-size=1000,700'] });
  scanner = new Scanner();
});

afterAll(async () => {
  await scanner.close();
  await browser.close();
});

/** A tab the way a developer has it open, talked to over CDP the way the panel does. */
async function openTab(url: string): Promise<{ page: Page; cdp: Cdp }> {
  // No Playwright viewport, so the only device emulation is the panel's.
  const context = await browser.newContext({ viewport: null });
  const page = await context.newPage();
  await page.goto(url);
  const session = await context.newCDPSession(page);
  const cdp: Cdp = {
    send: (method, params) => session.send(method as 'Runtime.evaluate', params as never) as never,
  };
  return { page, cdp };
}

function summary(issues: Issue[]) {
  return issues
    .map((i) => ({ id: i.id, title: i.title, ranges: i.ranges }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

describe('scanning the inspected tab', () => {
  for (const [name, widths] of [
    ['bug-fixed-width.html', SCAN],
    ['bug-nav-wrap.html', SCAN],
    ['bug-sidebar-overlap.html', SCAN],
    // Every resize waits out its 300ms debounce, so a shorter sweep.
    ['bug-debounced-layout.html', { minWidth: 320, maxWidth: 900 }],
    ['bug-tap-targets.html', SCAN],
    ['clean-responsive.html', SCAN],
    ['clean-container-queries.html', SCAN],
  ] as const) {
    it(`finds what the CLI finds on ${name}`, async () => {
      const url = pathToFileURL(join(PAGES, name)).href;
      const cli = await scanner.scanPage(url, { ...widths, states: 0, concurrency: 1 });
      const { page, cdp } = await openTab(url);
      try {
        const panel = await scanTab(cdp, { analyzerScript, ...widths, reload: true });
        expect(panel.status).toBe('scanned');
        expect(summary(panel.issues)).toEqual(summary(cli.issues));
        expect(panel.breakpoints).toEqual(cli.breakpoints);
      } finally {
        await page.context().close();
      }
    });
  }

  it('scans the page as it is without reloading, and puts the tab back afterwards', async () => {
    const { page, cdp } = await openTab(pathToFileURL(join(PAGES, 'bug-fixed-width.html')).href);
    try {
      await page.evaluate(() => {
        (window as unknown as { mark: number }).mark = 1;
      });
      const before = await page.evaluate(() => window.innerWidth);
      expect(before).toBeLessThan(SCAN.maxWidth);
      const widths: number[] = [];
      const result = await scanTab(cdp, {
        analyzerScript,
        ...SCAN,
        onProgress: ({ width }) => widths.push(width),
      });
      expect(result.issues.map((i) => i.detector)).toContain('page-overflow');
      expect(widths[0]).toBe(320);
      expect(widths.length).toBe(result.measurements + 1);
      // Someone watching sees the page grow steadily: never more than one step back.
      const back = widths.slice(1).map((w, i) => (widths[i] as number) - w);
      expect(Math.max(...back)).toBeLessThanOrEqual(16);
      const after = await page.evaluate(() => ({
        width: window.innerWidth,
        mark: (window as unknown as { mark?: number }).mark,
        frozen: document.querySelectorAll('style[data-breakhound-freeze]').length,
        reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
      }));
      expect(after).toEqual({ width: before, mark: 1, frozen: 0, reduced: false });
    } finally {
      await page.context().close();
    }
  });

  it('stops when asked', async () => {
    const { page, cdp } = await openTab(pathToFileURL(join(PAGES, 'bug-nav-wrap.html')).href);
    try {
      let measured = 0;
      await expect(
        scanTab(cdp, {
          analyzerScript,
          ...SCAN,
          onProgress: () => measured++,
          cancelled: () => measured >= 3,
        }),
      ).rejects.toThrow('Stopped');
      expect(await page.evaluate(() => window.innerWidth)).not.toBe(320);
    } finally {
      await page.context().close();
    }
  });

  it('salts ids with a hash router path like the CLI', () => {
    expect(routeOf('http://localhost:3000/app/#/settings?tab=1')).toBe('/app/#/settings');
    expect(routeOf('http://localhost:3000/pricing#plans')).toBe('/pricing');
  });
});
