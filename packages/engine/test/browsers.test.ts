import { describe, expect, it } from 'vitest';
import { mergeBrowserResults } from '../src/browsers';
import type { Issue, PageResult } from '../src/types';

const issue = (id: string, title = `Issue ${id}`): Issue => ({
  id,
  fingerprint: id,
  detector: 'page-overflow',
  severity: 'error',
  title,
  ranges: [{ from: 320, to: 359 }],
  worstAt: 320,
  element: { selector: `.${id}`, path: '', html: '', text: null, source: null },
  evidence: {},
  styles: {},
});

const page = (issues: Issue[], over: Partial<PageResult> = {}): PageResult => ({
  url: 'http://localhost/',
  finalUrl: 'http://localhost/',
  status: 'scanned',
  pageErrors: [],
  warnings: [],
  breakpoints: { observed: [768], declared: [768], unexplained: [] },
  issues,
  measurements: 100,
  durationMs: 1000,
  ...over,
});

describe('merging browsers', () => {
  it('keeps one issue per id and says which browsers miss it', () => {
    const merged = mergeBrowserResults(page([issue('a'), issue('b')]), 'chromium', [
      { browser: 'webkit', result: page([issue('a'), issue('c')]) },
    ]);
    expect(merged.issues.map((i) => [i.id, i.browsers, i.title])).toEqual([
      ['a', ['chromium', 'webkit'], 'Issue a'],
      ['b', ['chromium'], 'Issue b (only in Chromium)'],
      ['c', ['webkit'], 'Issue c (only in WebKit)'],
    ]);
    expect(merged.measurements).toBe(200);
    expect(merged.breakpoints.observed).toEqual([768]);
  });

  it("notes a browser that couldn't load the page, without blaming the others' issues on it", () => {
    const merged = mergeBrowserResults(page([issue('a')]), 'chromium', [
      { browser: 'firefox', result: page([], { status: 'error', error: 'Timed out' }) },
    ]);
    expect(merged.issues[0]?.title).toBe('Issue a');
    expect(merged.warnings).toEqual(['Could not check it in Firefox: Timed out']);
  });
});
