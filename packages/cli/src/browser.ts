import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { styleText } from 'node:util';
import { BROWSER_LABELS, BROWSER_TYPES, type BrowserName } from '@breakhound/engine';

/** Rough download sizes, so the first run says what it's about to fetch. */
const DOWNLOAD_MB: Record<BrowserName, number> = { chromium: 150, webkit: 80, firefox: 90 };

function installed(name: BrowserName): boolean {
  try {
    return existsSync(BROWSER_TYPES[name].executablePath());
  } catch {
    // Unknown platform layout; let the launch report the real error.
    return true;
  }
}

/** Downloads the Playwright browsers a scan needs the first time they're used on a machine. */
export function ensureBrowsers(names: BrowserName[] = ['chromium']): void {
  const missing = names.filter((n) => !installed(n));
  if (!missing.length) return;
  const size = missing.reduce((sum, n) => sum + DOWNLOAD_MB[n], 0);
  const what = missing.map((n) => BROWSER_LABELS[n]).join(' and ');
  // stderr, like everything the download prints: stdout may be an MCP connection.
  console.error(
    styleText(
      'dim',
      `First run: downloading ${what} for breakhound (one time, about ${size} MB)...`,
    ),
  );
  installBrowsers(missing, false);
}

/** Runs the bundled Playwright's installer, optionally with the system libraries the browsers need (Linux, CI). */
export function installBrowsers(names: BrowserName[], withDeps: boolean): void {
  const require = createRequire(import.meta.url);
  const cli = require.resolve('playwright/cli');
  const args = [cli, 'install', ...(withDeps ? ['--with-deps'] : []), ...names];
  const run = spawnSync(process.execPath, args, { stdio: ['ignore', 2, 2] });
  if (run.status !== 0) {
    const list = names.join(' ');
    throw new Error(
      `Could not install ${names.map((n) => BROWSER_LABELS[n]).join(' and ')}. Try running: npx breakhound install${withDeps ? ' --with-deps' : ''} ${list}`,
    );
  }
}
