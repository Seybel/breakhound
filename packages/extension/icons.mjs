import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// Renders the extension icon at the sizes Chrome asks for. Run once after changing the drawing:
// node packages/extension/icons.mjs
const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'static/icons');

// A width ruler: ticks across, with the range where something breaks in red.
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
  <rect x="4" y="4" width="120" height="120" rx="28" fill="#1f2328"/>
  <rect x="22" y="60" width="84" height="8" rx="4" fill="#e8eaed"/>
  <rect x="22" y="60" width="38" height="8" rx="4" fill="#f04438"/>
  <rect x="22" y="38" width="8" height="52" rx="4" fill="#e8eaed"/>
  <rect x="98" y="38" width="8" height="52" rx="4" fill="#e8eaed"/>
  <rect x="56" y="46" width="8" height="36" rx="4" fill="#f04438"/>
</svg>`;

mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  for (const size of [16, 32, 48, 128]) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(
      `<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`,
    );
    await page.screenshot({ path: join(out, `${size}.png`), omitBackground: true });
  }
} finally {
  await browser.close();
}
