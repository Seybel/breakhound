import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type BrowserContext, chromium, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const here = import.meta.dirname;
const PAGES = join(here, '../../../fixtures/pages');

let server: Server;
let origin: string;
let context: BrowserContext;
let extensionId: string;

beforeAll(async () => {
  execFileSync(process.execPath, [join(here, '../build.mjs')], { stdio: 'inherit' });
  // A copy with an empty service worker, only so the test can learn the extension's id.
  const unpacked = mkdtempSync(join(tmpdir(), 'breakhound-ext-'));
  cpSync(join(here, '../dist'), unpacked, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(unpacked, 'manifest.json'), 'utf8'));
  manifest.background = { service_worker: 'test-worker.js' };
  writeFileSync(join(unpacked, 'manifest.json'), JSON.stringify(manifest));
  writeFileSync(join(unpacked, 'test-worker.js'), '');

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
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  extensionId = new URL(worker.url()).host;
});

afterAll(async () => {
  await context?.close();
  server?.close();
});

/** Opens a site page and the panel for it, the panel as a plain extension page. */
async function open(file: string): Promise<{ site: Page; panel: Page }> {
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
  await panel.goto(`chrome-extension://${extensionId}/panel.html?tab=${tab}`);
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
