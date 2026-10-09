import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type BrowserContext, chromium, type Page, type Worker } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const here = import.meta.dirname;
const PAGES = join(here, '../../../fixtures/pages');

let server: Server;
let origin: string;
let context: BrowserContext;
let extensionId: string;
let worker: Worker;

beforeAll(async () => {
  execFileSync(process.execPath, [join(here, '../build.mjs')], { stdio: 'inherit' });
  // A copy, so a build running alongside can't change it under the browser.
  const unpacked = mkdtempSync(join(tmpdir(), 'breakhound-ext-'));
  cpSync(join(here, '../dist'), unpacked, { recursive: true });

  // Served over http: Chrome only lets extensions debug file:// pages when the user allows it.
  server = createServer((req, res) => {
    try {
      const body = readFileSync(
        join(PAGES, (req.url ?? '/').split('?')[0]?.replace(/^\/+/, '') ?? ''),
      );
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  context = await chromium.launchPersistentContext(
    mkdtempSync(join(tmpdir(), 'breakhound-profile-')),
    {
      // The full Chromium, since the headless shell can't load extensions.
      channel: 'chromium',
      headless: true,
      viewport: null,
      args: [`--disable-extensions-except=${unpacked}`, `--load-extension=${unpacked}`],
    },
  );
  worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  extensionId = new URL(worker.url()).host;
});

afterAll(async () => {
  await context?.close();
  server?.close();
});

/** Opens a site page and the panel for it, the panel as a plain extension page. */
async function open(file: string, query = ''): Promise<{ site: Page; panel: Page }> {
  const site = await context.newPage();
  await site.goto(`${origin}/${file}`);
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/panel.html`);
  // The debugger API lists tabs with their URLs, which chrome.tabs only does with more permissions.
  const tab = await panel.evaluate(async (url) => {
    const targets = await (
      globalThis as unknown as {
        chrome: { debugger: { getTargets: () => Promise<{ tabId?: number; url: string }[]> } };
      }
    ).chrome.debugger.getTargets();
    return targets.find((t) => t.url === url)?.tabId;
  }, `${origin}/${file}`);
  await panel.goto(`chrome-extension://${extensionId}/panel.html?tab=${tab}${query}`);
  return { site, panel };
}

/** Where on the timeline a width is, in the layout band (above the issue bars, so nothing else is clicked). */
async function pointAt(panel: Page, width: number, range: { min: number; max: number }) {
  const zones = await panel.locator('#zones').boundingBox();
  if (!zones) throw new Error('No timeline');
  const frac = (width - range.min) / (range.max - range.min);
  return { x: zones.x + frac * zones.width, y: zones.y + zones.height / 2 };
}

async function scanned(panel: Page): Promise<void> {
  await panel.fill('#min', '320');
  await panel.fill('#max', '1440');
  await panel.click('#scan');
  await panel.waitForSelector('body[data-phase="done"]', { timeout: 60_000 });
}

const innerWidth = (site: Page) => site.evaluate(() => window.innerWidth);

describe('the DevTools panel', () => {
  it('scans the tab, and shows an issue at the width where it is worst', async () => {
    const { site, panel } = await open('bug-fixed-width.html');
    await panel.setViewportSize({ width: 1000, height: 700 });
    const width = await innerWidth(site);
    await scanned(panel);

    const titles = await panel.locator('.issue-title').allTextContents();
    expect(titles.some((t) => t.startsWith('Page scrolls horizontally'))).toBe(true);
    expect(await panel.locator('.lane-bar').count()).toBeGreaterThanOrEqual(titles.length);
    expect(await panel.textContent('#stats')).toContain('320–1440px');
    // The tab is back to its own width and nobody is debugging it.
    expect(await innerWidth(site)).toBe(width);
    expect(await panel.isHidden('#viewing')).toBe(true);

    await panel.locator('.issue-head').first().click();
    await panel.waitForSelector('#viewing:not([hidden])');
    await expect.poll(() => site.locator('[data-breakhound-overlay]').count()).toBeGreaterThan(0);
    const worst = Number((await panel.textContent('#viewing-text'))?.match(/Showing (\d+)px/)?.[1]);
    expect(await innerWidth(site)).toBe(worst);

    await panel.click('#viewing-reset');
    await panel.waitForSelector('#viewing', { state: 'hidden' });
    expect(await innerWidth(site)).toBe(width);
    expect(await site.locator('[data-breakhound-overlay]').count()).toBe(0);
    await site.close();
    await panel.close();
  });

  it('shows the page at the width clicked or dragged to on the timeline', async () => {
    const { site, panel } = await open('bug-nav-wrap.html');
    await panel.setViewportSize({ width: 1000, height: 700 });
    const width = await innerWidth(site);
    await scanned(panel);
    const range = { min: 320, max: 1440 };

    // A click well away from where any issue is worst goes to that width, not to an issue.
    const at = await pointAt(panel, 1356, range);
    await panel.mouse.click(at.x, at.y);
    const shown = Number(await panel.getAttribute('#timeline', 'aria-valuenow'));
    expect(Math.abs(shown - 1356)).toBeLessThanOrEqual(2);
    await expect.poll(() => innerWidth(site)).toBe(shown);

    // So does a click on an issue's row away from its bar.
    const lane = await panel.locator('.lane').first().boundingBox();
    if (!lane) throw new Error('No issue row');
    const row = await pointAt(panel, 1200, range);
    await panel.mouse.click(row.x, lane.y + lane.height / 2);
    const inRow = Number(await panel.getAttribute('#timeline', 'aria-valuenow'));
    expect(Math.abs(inRow - 1200)).toBeLessThanOrEqual(2);
    await expect.poll(() => innerWidth(site)).toBe(inRow);

    // Dragging follows the pointer and lands where it is let go.
    const from = await pointAt(panel, 400, range);
    const to = await pointAt(panel, 900, range);
    await panel.mouse.move(from.x, from.y);
    await panel.mouse.down();
    for (let i = 1; i <= 10; i++)
      await panel.mouse.move(from.x + ((to.x - from.x) * i) / 10, from.y);
    await panel.mouse.up();
    const dropped = Number(await panel.getAttribute('#timeline', 'aria-valuenow'));
    expect(Math.abs(dropped - 900)).toBeLessThanOrEqual(2);
    await expect.poll(() => innerWidth(site)).toBe(dropped);

    // Arrow keys nudge it a pixel at a time.
    await panel.focus('#timeline');
    await panel.keyboard.press('ArrowRight');
    await expect.poll(() => innerWidth(site)).toBe(dropped + 1);

    await panel.keyboard.press('Escape');
    await expect.poll(() => innerWidth(site)).toBe(width);
    await site.close();
    await panel.close();
  });

  it('offers Scan with breakhound on the right-click menu, which opens the panel scanning', async () => {
    // The item exists once the extension is installed: updating a missing item fails.
    await expect
      .poll(() =>
        worker.evaluate(() =>
          (
            globalThis as unknown as {
              chrome: { contextMenus: { update: (id: string, p: object) => Promise<void> } };
            }
          ).chrome.contextMenus
            .update('breakhound-scan', { title: 'Scan with breakhound' })
            .then(() => true)
            .catch(() => false),
        ),
      )
      .toBe(true);

    // The menu opens the panel in the side panel with ?scan, and it starts on its own.
    const { site, panel } = await open('bug-fixed-width.html', `&scan=${Date.now()}`);
    await panel.waitForSelector('body[data-phase="done"]', { timeout: 60_000 });
    expect(await panel.locator('.issue-title').count()).toBeGreaterThan(0);
    await site.close();
    await panel.close();
  });

  it('keeps its console clean while DevTools is resized', async () => {
    const { site, panel } = await open('bug-sidebar-overlap.html');
    // Chrome reports a ResizeObserver loop as a window error event, which never reaches the console.
    await panel.evaluate(() => {
      const seen: string[] = [];
      (window as unknown as { seen: string[] }).seen = seen;
      addEventListener('error', (e) => seen.push(e.message));
    });
    const problems: string[] = [];
    panel.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning') problems.push(m.text());
    });
    panel.on('pageerror', (e) => problems.push(e.message));
    await panel.setViewportSize({ width: 1000, height: 700 });
    await scanned(panel);
    await panel.locator('.issue-head').first().click();
    for (const width of [520, 900, 400, 1100, 760, 759, 761, 1000]) {
      await panel.setViewportSize({ width, height: 700 });
      await panel.waitForTimeout(60);
    }
    await panel.waitForTimeout(200);
    problems.push(...(await panel.evaluate(() => (window as unknown as { seen: string[] }).seen)));
    expect(problems).toEqual([]);
    await site.close();
    await panel.close();
  });

  it('scans every page of the site, and shows an issue on the page it is on', async () => {
    // A small site: a few pages linking to each other, one with a banner that never shrinks.
    const page = (body: string) =>
      `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{margin:0;font:16px/1.4 Arial,sans-serif}main{padding:16px}</style></head><body><main>${body}</main></body></html>`;
    const nav = '<a href="/">Home</a> <a href="/about">About</a> <a href="/pricing">Pricing</a>';
    const pages: Record<string, string> = {
      '/': page(`<h1>Home</h1>${nav}`),
      '/about': page(`<h1>About</h1>${nav}`),
      '/pricing': page(
        `<h1>Pricing</h1>${nav}<div style="width:600px;height:40px;background:#eee">Plans</div>`,
      ),
    };
    const siteServer = createServer((req, res) => {
      const body = pages[req.url ?? '/'];
      if (!body) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' }).end(body);
    });
    await new Promise<void>((r) => siteServer.listen(0, '127.0.0.1', r));
    const siteOrigin = `http://127.0.0.1:${(siteServer.address() as AddressInfo).port}`;
    try {
      const site = await context.newPage();
      await site.goto(`${siteOrigin}/about`);
      const panel = await context.newPage();
      await panel.goto(`chrome-extension://${extensionId}/panel.html`);
      const tab = await panel.evaluate(async (url) => {
        const targets = await (
          globalThis as unknown as {
            chrome: { debugger: { getTargets: () => Promise<{ tabId?: number; url: string }[]> } };
          }
        ).chrome.debugger.getTargets();
        return targets.find((t) => t.url === url)?.tabId;
      }, `${siteOrigin}/about`);
      await panel.goto(`chrome-extension://${extensionId}/panel.html?tab=${tab}`);
      await panel.setViewportSize({ width: 1000, height: 700 });
      await panel.click('#mode-site');
      expect(await panel.isHidden('#reload-switch')).toBe(true);
      await scanned(panel);

      const chips = await panel.locator('.page-chip .path').allTextContents();
      expect(chips.sort()).toEqual(['/', '/about', '/pricing']);
      // It opens on the page with the worst problems, and the tab is back where it started.
      expect(await panel.locator('.page-chip[aria-selected="true"] .path').textContent()).toBe(
        '/pricing',
      );
      expect(site.url()).toBe(`${siteOrigin}/about`);
      expect(await panel.textContent('#stats')).toMatch(/Pages\s*3/);

      // Showing an issue from /pricing takes the tab there first.
      await panel.locator('.issue-head').first().click();
      await expect.poll(() => site.url()).toBe(`${siteOrigin}/pricing`);
      const worst = Number(
        (await panel.textContent('#viewing-text'))?.match(/Showing (\d+)px/)?.[1],
      );
      await expect.poll(() => innerWidth(site)).toBe(worst);

      // The choice is remembered.
      await panel.reload();
      expect(await panel.getAttribute('#mode-site', 'aria-pressed')).toBe('true');
      await panel.click('#mode-page');
      await site.close();
      await panel.close();
    } finally {
      siteServer.close();
    }
  });

  it('says so when a page has nothing wrong', async () => {
    const { site, panel } = await open('clean-responsive.html');
    await scanned(panel);
    expect(await panel.textContent('#issues')).toContain('Nothing breaks.');
    expect(await panel.isHidden('#copy-all')).toBe(true);
    // Widths are remembered for next time.
    await panel.reload();
    expect(await panel.inputValue('#max')).toBe('1440');
    await site.close();
    await panel.close();
  });
});
