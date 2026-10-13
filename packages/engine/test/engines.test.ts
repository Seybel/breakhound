import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { webkit } from 'playwright';
import { afterAll, describe, expect, it } from 'vitest';
import { Scanner } from '../src/index';

const PAGES = join(import.meta.dirname, '../../../fixtures/pages');
const hasWebkit = existsSync(webkit.executablePath());

/** What only shows in one engine, beyond the corpus's ranges. Needs `breakhound install webkit`. */
describe.skipIf(!hasWebkit)('in WebKit', () => {
  const scanner = new Scanner({ browser: 'webkit' });
  afterAll(() => scanner.close());

  const scan = () =>
    scanner.scanPage(pathToFileURL(join(PAGES, 'bug-tiny-text.html')).href, {
      minWidth: 320,
      maxWidth: 800,
    });

  // The 11px is Safari's: WebKit on macOS. Playwright's WebKit on Linux is another port,
  // which draws form controls at about 13px like Chrome.
  it.skipIf(process.platform !== 'darwin')(
    "names Safari's 11px form controls as the cause of their tiny text",
    async () => {
      const button = (await scan()).issues.find((i) => i.element.selector.includes('button'));
      expect(button?.evidence.fontSizePx).toBe(11);
      expect(button?.suggestion).toContain('font: inherit');
    },
  );

  it('gives text the page itself made small the usual advice', async () => {
    const legal = (await scan()).issues.find((i) => i.element.selector.includes('legal'));
    expect(legal?.suggestion).toContain('at least 12px');
  });
});
