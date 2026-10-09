import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { styleText } from 'node:util';
import { launch } from '@breakhound/engine';
import { makeOutputFolder } from '@breakhound/report';
import type { Page } from 'playwright';
import { resolveServer } from './app';
import { ensureBrowsers } from './browser';
import type { BreakhoundConfig } from './config';

/** The saved login session. Always in the project folder, whatever --out says, and never committed. */
export const AUTH_FILE = '.breakhound/auth.json';

function waitForEnter(): { promise: Promise<void>; close: () => void } {
  if (!process.stdin.isTTY) return { promise: new Promise(() => {}), close: () => {} };
  const rl = createInterface({ input: process.stdin });
  const promise = new Promise<void>((resolve) => rl.once('line', () => resolve()));
  return { promise, close: () => rl.close() };
}

/**
 * Opens a real browser window on the app so you can log in yourself, then
 * saves the session (cookies and local storage) for later scans. breakhound
 * never sees the password.
 */
export interface LoginOptions {
  /** Starts the page where you log in, e.g. /login. */
  path?: string;
  /** For tests: log in with code instead of waiting for a person, in a hidden browser. */
  automate?: (page: Page) => Promise<void>;
  quiet?: boolean;
}

export async function runLogin(
  cwd: string,
  config: BreakhoundConfig,
  options: LoginOptions = {},
): Promise<void> {
  const { path, automate } = options;
  const log = (line: string) => {
    if (!options.quiet) console.log(line);
  };
  ensureBrowsers();
  const app = await resolveServer(cwd, config, options.quiet ?? false);
  const file = join(cwd, AUTH_FILE);
  const browser = await launch(Boolean(automate));
  try {
    const context = await browser.newContext({
      viewport: null,
      ignoreHTTPSErrors: true,
      ...(existsSync(file) ? { storageState: file } : {}),
    });
    const page = await context.newPage();
    await page.goto(new URL(path ?? '/', app.baseUrl).href).catch(() => {});

    log(
      `\n  Log in to your app in the browser window that just opened.\n  Then come back here and press ${styleText('bold', 'Enter')} (or just close the window).\n`,
    );
    // Keep a recent copy: once the window is closed the session can't be read any more.
    let state = await context.storageState();
    const timer = setInterval(() => {
      context
        .storageState()
        .then((s) => {
          state = s;
        })
        .catch(() => {});
    }, 1000);
    const enter = automate ? { promise: automate(page), close: () => {} } : waitForEnter();
    const closed = new Promise<void>((resolve) => {
      context.on('close', () => resolve());
      browser.on('disconnected', () => resolve());
      const watch = () => {
        if (context.pages().length === 0) resolve();
      };
      context.on('page', (p) => p.on('close', watch));
      page.on('close', watch);
    });
    await Promise.race([enter.promise, closed]);
    enter.close();
    clearInterval(timer);
    state = await context.storageState().catch(() => state);

    makeOutputFolder(dirname(file));
    writeFileSync(file, JSON.stringify(state, null, 2), { mode: 0o600 });
    const cookies = state.cookies.length;
    log(
      `${styleText('green', '✔')} Saved your session to ${AUTH_FILE} (${cookies} cookie${cookies === 1 ? '' : 's'}). Scans will now use it.`,
    );
    if (cookies === 0 && state.origins.length === 0) {
      log(
        styleText('yellow', '  Nothing was saved. Did the login finish before the window closed?'),
      );
    }
  } finally {
    await browser.close().catch(() => {});
    await app.server?.stop();
  }
}
