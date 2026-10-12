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

  it("names Safari's 11px form controls as the cause of their tiny text", async () => {
    const url = pathToFileURL(join(PAGES, 'bug-tiny-text.html')).href;
    const result = await scanner.scanPage(url, { minWidth: 320, maxWidth: 800 });
    const button = result.issues.find((i) => i.element.selector.includes('button'));
    expect(button?.evidence.fontSizePx).toBe(11);
    expect(button?.suggestion).toContain('font: inherit');
    // Text the page itself made small gets the usual advice.
    const legal = result.issues.find((i) => i.element.selector.includes('legal'));
    expect(legal?.suggestion).toContain('at least 12px');
  });
});
