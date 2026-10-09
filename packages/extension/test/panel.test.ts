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

describe('the DevTools panel', () => {
  it('scans the tab, shows the timeline, and shows an issue at its width', async () => {
    const { site, panel } = await open('bug-fixed-width.html');
    const width = await site.evaluate(() => window.innerWidth);

    await panel.fill('#min', '320');
    await panel.fill('#max', '1440');
    await panel.click('#scan');
    await panel.waitForSelector('#results:not([hidden])', { timeout: 60_000 });

    const titles = await panel.locator('.issue-title').allTextContents();
    expect(titles.some((t) => t.startsWith('Page scrolls horizontally'))).toBe(true);
    expect(await panel.locator('.lane').count()).toBe(titles.length);
    expect(await panel.textContent('#summary')).toMatch(/between 320px and 1440px/);
    // The tab is back to its own width and nobody is debugging it.
    expect(await site.evaluate(() => window.innerWidth)).toBe(width);
    expect(await panel.isHidden('#preview')).toBe(true);

    await panel.locator('.issue-head').first().click();
    await panel.waitForSelector('#preview:not([hidden])');
    const worst = Number((await panel.textContent('#preview-text'))?.match(/(\d+)px/)?.[1]);
    expect(await site.evaluate(() => window.innerWidth)).toBe(worst);
    expect(await site.locator('[data-breakhound-overlay]').count()).toBeGreaterThan(0);

    await panel.click('#preview-end');
    await panel.waitForSelector('#preview', { state: 'hidden' });
    expect(await site.evaluate(() => window.innerWidth)).toBe(width);
    expect(await site.locator('[data-breakhound-overlay]').count()).toBe(0);

    await site.close();
    await panel.close();
  });

  it('says so when a page has nothing wrong', async () => {
    const { site, panel } = await open('clean-responsive.html');
    await panel.fill('#min', '320');
    await panel.fill('#max', '1440');
    await panel.click('#scan');
    await panel.waitForSelector('#results:not([hidden])', { timeout: 60_000 });
    expect(await panel.textContent('#issues')).toContain('Nothing breaks.');
    expect(await panel.isHidden('#copy-all')).toBe(true);
    // Widths are remembered for next time.
    await panel.reload();
    expect(await panel.inputValue('#max')).toBe('1440');
    await site.close();
    await panel.close();
  });
});
