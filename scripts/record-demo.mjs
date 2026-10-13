// Records docs/demo.gif: the extension scanning the example site, the page and the panel side
// by side. Needs ffmpeg. Run after `npm run build:extension`: node scripts/record-demo.mjs
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

const root = join(import.meta.dirname, '..');
const frames = mkdtempSync(join(tmpdir(), 'breakhound-demo-'));
const SITE = { width: 900, height: 640 };
const PANEL = { width: 560, height: 640 };
const FPS = 6;

const unpacked = mkdtempSync(join(tmpdir(), 'breakhound-ext-'));
cpSync(join(root, 'packages/extension/dist'), unpacked, { recursive: true });

const server = spawn(process.execPath, ['serve.mjs'], {
  cwd: join(root, 'examples/acme'),
  env: { ...process.env, PORT: '4174' },
  stdio: 'ignore',
});
const url = 'http://localhost:4174/';
await new Promise((r) => setTimeout(r, 500));

const context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'bh-profile-')), {
  channel: 'chromium',
  headless: true,
  viewport: null,
  args: [
    `--disable-extensions-except=${unpacked}`,
    `--load-extension=${unpacked}`,
    // The headless window keeps about 143px for browser chrome it doesn't draw.
    `--window-size=${SITE.width},${SITE.height + 143}`,
  ],
});
const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
const id = new URL(worker.url()).host;

const site = await context.newPage();
await site.goto(url);
const tab = await worker.evaluate(
  async (url) => (await chrome.debugger.getTargets()).find((t) => t.url === url)?.tabId,
  url,
);
const [panel] = await Promise.all([
  context.waitForEvent('page'),
  worker.evaluate((o) => chrome.windows.create(o), {
    url: `chrome-extension://${id}/panel.html?tab=${tab}`,
    ...PANEL,
  }),
]);
await panel.waitForLoadState();
await panel.setViewportSize(PANEL);

let n = 0;
// Playwright's own screenshots reset the width the extension gives the page, so the page is
// captured straight from the browser, as it's drawn.
const cdp = await context.newCDPSession(site);
const capture = {
  site: async (path) => {
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(path, Buffer.from(data, 'base64'));
  },
  panel: (path) => panel.screenshot({ path, timeout: 1500 }),
};

/** A screenshot, or the last one again when the page can't be captured (mid-navigation, say). */
async function shot(kind, name) {
  const path = join(frames, `${kind}-${name}.png`);
  try {
    await capture[kind](path);
  } catch {
    if (n > 1) copyFileSync(join(frames, `${kind}-${String(n - 2).padStart(4, '0')}.png`), path);
    else throw new Error(`Couldn't capture the ${kind}`);
  }
}
/** While breakhound scans, the page keeps the last frame: capturing it then holds up the scan. */
let scanning = false;
async function frame() {
  const name = String(n++).padStart(4, '0');
  if (scanning) {
    copyFileSync(
      join(frames, `site-${String(n - 2).padStart(4, '0')}.png`),
      join(frames, `site-${name}.png`),
    );
    await shot('panel', name);
  } else await Promise.all([shot('site', name), shot('panel', name)]);
}
/** Frames for a while, at the GIF's rate however long a screenshot takes. */
async function hold(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const started = Date.now();
    await frame();
    await new Promise((r) => setTimeout(r, Math.max(0, 1000 / FPS - (Date.now() - started))));
  }
}
/** Frames until the panel is done scanning, keeping one in every `every` so it plays faster. */
async function until(done, every) {
  let i = 0;
  while (!(await done())) {
    if (i++ % every === 0) await frame();
    else await new Promise((r) => setTimeout(r, 1000 / FPS));
  }
}

await hold(1200);
await panel.click('#mode-site');
await hold(500);
scanning = true;
await panel.click('#scan');
await until(() => panel.evaluate(() => document.body.dataset.phase === 'done'), 3);
// What it found, to check against the example's README: recording mustn't change the scan.
for (const chip of await panel.locator('.page-chip').all()) {
  await chip.click();
  for (const issue of await panel.locator('.issue-head').allInnerTexts())
    console.log(`${(await chip.innerText()).replace(/\s+/g, ' ')}: ${issue.replace(/\s+/g, ' ')}`);
}
await panel.locator('.page-chip').first().click();
scanning = false;
await hold(1800);
// The worst issue of a few pages: showing one takes the tab to its page and width.
for (const path of [/^\/pricing$/, /^\/about$/, /^\/$/]) {
  await panel
    .locator('.page-chip')
    .filter({ has: panel.locator('.path', { hasText: path }) })
    .click();
  await hold(600);
  await panel.locator('.issue-head').first().click();
  await hold(2600);
}

await context.close();
server.kill();

// The page is captured at the width breakhound gives it, so each frame is a different size:
// fit each into one frame, the way DevTools' device mode shows a page.
const ffmpeg = (...args) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...args]);
ffmpeg(
  '-framerate',
  String(FPS),
  '-i',
  join(frames, 'site-%04d.png'),
  '-vf',
  `scale=${SITE.width}:${SITE.height}:force_original_aspect_ratio=decrease,pad=${SITE.width}:${SITE.height}:(ow-iw)/2:(oh-ih)/2:color=0xe9e8ee`,
  '-start_number',
  '0',
  join(frames, 'fit-%04d.png'),
);

// Page on the left, panel on the right, then a palette so the GIF stays small and sharp.
const out = join(root, 'docs/demo.gif');
mkdirSync(join(root, 'docs'), { recursive: true });
ffmpeg(
  '-framerate',
  String(FPS),
  '-i',
  join(frames, 'fit-%04d.png'),
  '-framerate',
  String(FPS),
  '-i',
  join(frames, 'panel-%04d.png'),
  '-filter_complex',
  `[1:v]scale=-2:${SITE.height}[p];[0:v][p]hstack=inputs=2,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[c];[b][c]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`,
  out,
);
if (!process.env.KEEP_FRAMES) rmSync(frames, { recursive: true, force: true });
else console.log(`Frames kept in ${frames}`);
rmSync(unpacked, { recursive: true, force: true });
console.log(`Wrote ${out} from ${n} frames.`);
