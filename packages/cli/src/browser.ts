import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { styleText } from 'node:util';
import { chromium } from 'playwright';

/** Downloads Playwright's Chromium the first time breakhound runs on a machine. */
export function ensureChromium(): void {
  let executable = '';
  try {
    executable = chromium.executablePath();
  } catch {
    // Unknown platform layout; let the launch report the real error.
    return;
  }
  if (existsSync(executable)) return;

  console.log(
    styleText('dim', 'First run: downloading Chromium for breakhound (one time, about 150 MB)...'),
  );
  const require = createRequire(import.meta.url);
  const cli = require.resolve('playwright/cli');
  const run = spawnSync(process.execPath, [cli, 'install', 'chromium'], { stdio: 'inherit' });
  if (run.status !== 0) {
    throw new Error('Could not download Chromium. Try running: npx playwright install chromium');
  }
}
