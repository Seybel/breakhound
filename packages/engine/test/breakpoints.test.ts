import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { scanPage } from '../src/index';

const PAGES = join(import.meta.dirname, '../../../fixtures/pages');

describe('behavioural breakpoints', () => {
  it('finds exactly the breakpoints a well-built page declares', async () => {
    const file = join(PAGES, 'clean-responsive.html');
    const expected = readFileSync(file, 'utf8')
      .match(/data-bh-breakpoints="([^"]+)"/)?.[1]
      ?.split(',')
      .map(Number);

    const result = await scanPage(pathToFileURL(file).href);

    expect(result.breakpoints.observed).toEqual(expected);
    expect(result.breakpoints.declared).toEqual(expected);
    expect(result.breakpoints.unexplained).toEqual([]);
  });

  it('reads rem media queries against 16px and understands range syntax', async () => {
    const result = await scanPage(pathToFileURL(join(PAGES, 'clean-rem-breakpoints.html')).href);
    expect(result.breakpoints.declared).toEqual([768, 1024]);
    expect(result.breakpoints.observed).toEqual([768, 1024]);
    expect(result.breakpoints.unexplained).toEqual([]);
  });

  it('does not treat wrapping flex content as a breakpoint', async () => {
    const result = await scanPage(pathToFileURL(join(PAGES, 'clean-text.html')).href);
    expect(result.breakpoints.observed).toEqual([]);
  });
});
