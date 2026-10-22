import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { Scanner } from '../src/index';

const PAGES = join(import.meta.dirname, '../../../fixtures/pages');
const scanner = new Scanner();

afterAll(() => scanner.close());

describe('the likely fix', () => {
  it('says why two things overlap, not just that they do', async () => {
    const url = pathToFileURL(join(PAGES, 'bug-sidebar-overlap.html')).href;
    const result = await scanner.scanPage(url, { minWidth: 320, maxWidth: 1000, states: 0 });
    const overlap = result.issues.find((i) => i.detector === 'overlap');
    // The sidebar's image is wider than the sidebar and runs into the main column.
    expect(overlap?.suggestion).toMatch(/content of `aside\.sidebar` is wider than its box/);
    expect(overlap?.suggestion).toMatch(/max-width: 100%/);
  });

  it("doesn't ask for columns that shrink when the grid's already do", async () => {
    const url = pathToFileURL(join(PAGES, 'bug-gallery-columns.html')).href;
    const result = await scanner.scanPage(url, { minWidth: 320, maxWidth: 700, states: 0 });
    const overlap = result.issues.find((i) => i.detector === 'overlap');
    expect(overlap?.suggestion).toMatch(/Switch to fewer columns/);
    expect(overlap?.suggestion).not.toMatch(/minmax/);
  });
});
