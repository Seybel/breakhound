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

  // stderr, like everything the download prints: stdout may be an MCP connection.
  console.error(
    styleText('dim', 'First run: downloading Chromium for breakhound (one time, about 150 MB)...'),
  );
  installChromium(false);
}

/** Runs the bundled Playwright's installer, optionally with the system libraries Chromium needs (Linux, CI). */
export function installChromium(withDeps: boolean): void {
  const require = createRequire(import.meta.url);
  const cli = require.resolve('playwright/cli');
  const args = [cli, 'install', ...(withDeps ? ['--with-deps'] : []), 'chromium'];
  const run = spawnSync(process.execPath, args, { stdio: ['ignore', 2, 2] });
  if (run.status !== 0) {
    throw new Error(
      `Could not install Chromium. Try running: npx breakhound install${withDeps ? ' --with-deps' : ''}`,
    );
  }
}
