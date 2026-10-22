import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { type BrowserContext, chromium, type Page, type Worker } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startBridge } from '../../cli/src/bridge';
import { loadConfig } from '../../cli/src/config';
import { runVerify } from '../../cli/src/verify';

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

type Chrome = {
  debugger: { getTargets: () => Promise<{ tabId?: number; url: string }[]> };
  windows: { create: (o: { url: string; width: number; height: number }) => Promise<unknown> };
};

/**
 * Opens a page, and the panel for it in a window of its own. DevTools and the side panel sit
 * beside the page, so the tab being scanned is in view. A panel opened as another tab of the
 * same window would put the page in the background, where Chrome can stop drawing it.
 */
async function openAt(url: string, query = ''): Promise<{ site: Page; panel: Page }> {
  const site = await context.newPage();
  await site.goto(url);
  // The debugger API lists tabs with their URLs, which chrome.tabs only does with more permissions.
  const tab = await worker.evaluate(async (url) => {
    const { chrome } = globalThis as unknown as { chrome: Chrome };
    return (await chrome.debugger.getTargets()).find((t) => t.url === url)?.tabId;
  }, url);
  const [panel] = await Promise.all([
    context.waitForEvent('page'),
    worker.evaluate(async (url) => {
      const { chrome } = globalThis as unknown as { chrome: Chrome };
      await chrome.windows.create({ url, width: 1000, height: 700 });
    }, `chrome-extension://${extensionId}/panel.html?tab=${tab}${query}`),
  ]);
  await panel.waitForLoadState();
  expect(await site.evaluate(() => document.visibilityState)).toBe('visible');
  return { site, panel };
}

const open = (file: string, query = '') => openAt(`${origin}/${file}`, query);

/** Where on the timeline a width is, in the layout band (above the issue bars, so nothing else is clicked). */
async function pointAt(panel: Page, width: number, range: { min: number; max: number }) {
  const zones = await panel.locator('#zones').boundingBox();
  if (!zones) throw new Error('No timeline');
  const frac = (width - range.min) / (range.max - range.min);
  return { x: zones.x + frac * zones.width, y: zones.y + zones.height / 2 };
}

/** Waits for the scan to end, and says what the panel shows if it doesn't, not just that time ran out. */
async function finished(panel: Page): Promise<void> {
  const done = await panel
    .waitForSelector('body[data-phase="done"]', { timeout: 45_000 })
    .then(() => true)
    .catch(() => false);
  if (done) return;
  const shown = await panel.evaluate(() => ({
    phase: document.body.dataset.phase,
    status: document.getElementById('status')?.textContent,
    notice: document.getElementById('notice')?.hidden
      ? null
      : document.getElementById('notice-text')?.textContent,
  }));
  throw new Error(`The scan didn't finish: ${JSON.stringify(shown)}`);
}

async function scanned(panel: Page): Promise<void> {
  await panel.fill('#min', '320');
  await panel.fill('#max', '1440');
  await panel.click('#scan');
  await finished(panel);
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

  it("waits for the page's own resize handlers when scanning it as it is", async () => {
    // A panel sized by a debounced resize handler the page set up on load, before breakhound came.
    const { site, panel } = await open('clean-debounced-layout.html');
    expect(await panel.isChecked('#reload')).toBe(false);
    await panel.fill('#min', '320');
    await panel.fill('#max', '900');
    await panel.click('#scan');
    await finished(panel);
    expect(await panel.locator('.issue-title').allTextContents()).toEqual([]);
    await site.close();
    await panel.close();
  }, 150_000);

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
    await finished(panel);
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
      const { site, panel } = await openAt(`${siteOrigin}/about`);
      await panel.setViewportSize({ width: 1000, height: 700 });
      expect(await panel.textContent('#intro-scan')).toBe('Scan this page');
      await panel.click('#mode-site');
      expect(await panel.isHidden('#reload-switch')).toBe(true);
      expect(await panel.textContent('#intro-scan')).toBe('Scan whole site');
      expect(await panel.textContent('#intro-title')).toBe('Find where this site breaks');
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

      // Opened again, the panel is back on the page: a whole-site scan is chosen each time.
      await panel.reload();
      expect(await panel.getAttribute('#mode-page', 'aria-pressed')).toBe('true');
      expect(await panel.textContent('#intro-scan')).toBe('Scan this page');
      await site.close();
      await panel.close();
    } finally {
      siteServer.close();
    }
  });

  it('fits the page to the tab as DevTools is resized, and its outlines go when the debugging bar is closed', async () => {
    const { site, panel } = await open('bug-fixed-width.html');
    await panel.setViewportSize({ width: 1000, height: 700 });
    await scanned(panel);
    const own = await site.evaluate(() => [window.outerWidth, window.outerHeight]);

    await panel.locator('.issue-head').first().click();
    await expect.poll(() => site.locator('[data-breakhound-overlay]').count()).toBeGreaterThan(0);
    // The widest width is wider than the tab, so it's zoomed out to fit.
    await panel.focus('#timeline');
    await panel.keyboard.press('End');
    await expect.poll(() => innerWidth(site)).toBe(1440);

    // Dragging DevTools makes the tab smaller. A zoomed-out width is fitted to the space it has now…
    const zoom = async () =>
      (await panel.textContent('#viewing-text'))?.match(/zoomed to (\d+)%/)?.[1];
    const before = await zoom();
    expect(before).toBeDefined();
    const cdp = await context.newCDPSession(site);
    const { windowId } = await cdp.send('Browser.getWindowForTarget');
    const [w, h] = own as [number, number];
    await cdp.send('Browser.setWindowBounds', {
      windowId,
      bounds: { width: w - 200, height: h - 200 },
    });
    await panel.setViewportSize({ width: 900, height: 700 });
    await expect.poll(zoom).not.toBe(before);
    // …and a width that fits fills the tab's height, as it changes.
    await panel.focus('#timeline');
    await panel.keyboard.press('Home');
    await expect.poll(() => innerWidth(site)).toBe(320);
    const short = await site.evaluate(() => window.innerHeight);
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { width: w, height: h } });
    await expect.poll(() => site.evaluate(() => window.innerHeight)).toBeGreaterThan(short);

    // Cancel on the bar ends the session without a word to the panel; the page cleans up anyway.
    await panel.evaluate(async () => {
      const tabId = Number(new URLSearchParams(location.search).get('tab'));
      await (
        globalThis as unknown as {
          chrome: { debugger: { detach: (t: { tabId: number }) => Promise<void> } };
        }
      ).chrome.debugger.detach({ tabId });
    });
    await expect
      .poll(() => site.locator('[data-breakhound-overlay]').count(), { timeout: 10_000 })
      .toBe(0);
    await site.close();
    await panel.close();
  });

  it('fills in the widths from Mobile, Tablet and Desktop, and picking neighbours checks both', async () => {
    const { site, panel } = await open('bug-fixed-width.html');
    const pick = (name: string) => panel.click(`#presets button:text-is("${name}")`);
    const picked = async () => ({
      widths: [await panel.inputValue('#min'), await panel.inputValue('#max')],
      pressed: await panel.locator('#presets [aria-pressed="true"]').allTextContents(),
    });

    await pick('All');
    expect(await picked()).toEqual({ widths: ['320', '1920'], pressed: ['All'] });
    await pick('Mobile');
    expect(await picked()).toEqual({ widths: ['320', '599'], pressed: ['Mobile'] });
    await pick('Tablet');
    expect(await picked()).toEqual({ widths: ['320', '1023'], pressed: ['Mobile', 'Tablet'] });
    await pick('Mobile');
    expect(await picked()).toEqual({ widths: ['600', '1023'], pressed: ['Tablet'] });
    // Mobile and Desktop take in Tablet too, since a range has no gaps: that's every width.
    await pick('Mobile');
    await pick('Desktop');
    expect(await picked()).toEqual({ widths: ['320', '1920'], pressed: ['All'] });
    await pick('Desktop');
    await pick('Desktop');
    expect(await picked()).toEqual({ widths: ['320', '1920'], pressed: ['All'] });

    // Widths of your own match none of them.
    await panel.fill('#max', '700');
    expect((await picked()).pressed).toEqual([]);

    await pick('Mobile');
    await panel.click('#scan');
    await finished(panel);
    expect(await panel.textContent('#stats')).toContain('320–599px');
    await panel.reload();
    expect((await picked()).pressed).toEqual(['Mobile']);
    await site.close();
    await panel.close();
  });

  it("sends the issues to the coding agent, and checks the agent's fixes in the tab", async () => {
    // The project the agent works in, with breakhound mcp running in it.
    const root = mkdtempSync(join(tmpdir(), 'breakhound-project-'));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'made-up-shop' }));
    writeFileSync(join(root, 'breakhound.config.json'), JSON.stringify({ baseUrl: origin }));
    const bridge = await startBridge({
      root,
      version: '1.0.0',
      loadConfig: async () => (await loadConfig(root)).config,
    });
    if (!bridge) throw new Error('No free port for the bridge');
    try {
      const { site, panel } = await open('bug-fixed-width.html');
      await panel.setViewportSize({ width: 1000, height: 700 });
      await scanned(panel);
      await panel.click('#send');
      await expect
        .poll(() => panel.textContent('#notice-text'))
        .toContain('to your agent in made-up-shop');
      expect(await panel.isVisible('#agent')).toBe(true);
      const sent = JSON.parse(readFileSync(join(root, '.breakhound/baseline.json'), 'utf8'));
      expect(sent.from).toBe('extension');
      expect(sent.routes[0].issues.length).toBeGreaterThan(0);

      // The agent verifies without having fixed anything: the panel scans the page again here.
      const { config } = await loadConfig(root);
      const v = await runVerify({
        cwd: root,
        config,
        version: '1.0.0',
        quiet: true,
        scanPages: (pages, widths) => bridge.scanInBrowser(pages, widths, origin),
      });
      // Same browser, same page: everything is still there, and nothing new.
      expect(v.fixed).toEqual([]);
      expect(v.regressions).toEqual([]);
      expect(v.failing.length).toBe(sent.routes[0].issues.length);
      await expect
        .poll(() => panel.textContent('#notice-text'))
        .toContain("Checked your agent's fixes");
      await site.close();
      await panel.close();
    } finally {
      await bridge.close();
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

describe('a page opened from a file', () => {
  it('asks for file access before scanning, and opens the setting', async () => {
    const { site, panel } = await openAt(pathToFileURL(join(PAGES, 'bug-fixed-width.html')).href);
    // Extensions loaded from the command line get file access; a store install starts without it.
    await panel.evaluate(() => {
      const { chrome } = globalThis as unknown as {
        chrome: { extension: { isAllowedFileSchemeAccess: () => Promise<boolean> } };
      };
      chrome.extension.isAllowedFileSchemeAccess = async () => false;
    });
    await panel.click('#scan');
    await expect
      .poll(() => panel.locator('#notice-text').textContent())
      .toContain('turn on "Allow access to file URLs" for breakhound');
    expect(await panel.evaluate(() => document.body.dataset.phase)).not.toBe('scanning');
    const [settings] = await Promise.all([
      context.waitForEvent('page'),
      panel.click('#notice-action'),
    ]);
    expect(settings.url()).toBe(`chrome://extensions/?id=${extensionId}`);
    await settings.close();
    await site.close();
    await panel.close();
  });
});
