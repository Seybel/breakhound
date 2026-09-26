import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createScanResult, type RouteResult, scanPage } from '@breakhound/engine';
import { describe, expect, it } from 'vitest';
import { renderHtml } from '../src/index';

function page(route: string): RouteResult {
  return {
    route,
    url: `http://localhost:3000${route}`,
    finalUrl: `http://localhost:3000${route}`,
    status: 'scanned',
    pageErrors: [],
    breakpoints: { observed: [640, 1024], declared: [640, 1024], unexplained: [] },
    measurements: 110,
    durationMs: 3000,
    issues: [
      {
        id: `${route}-1`,
        fingerprint: 'page-overflow|div.pricing-table|',
        detector: 'page-overflow',
        severity: 'error',
        title: 'Page scrolls horizontally (280px wider than the viewport)',
        ranges: [{ from: 320, to: 599 }],
        worstAt: 320,
        element: {
          selector: 'main > section.pricing > div.pricing-table:nth-of-type(2)',
          path: 'main > section.pricing > div.pricing-table',
          html: '<div class="pricing-table" data-plan="enterprise-annual-billing-with-a-very-long-attribute">',
          text: null,
          source: null,
        },
        evidence: { overflowPx: 280, viewportWidth: 320, elementWidth: 600, fixedWidthPx: 600 },
        styles: { width: '600px' },
        suggestion: 'It stays 600px wide no matter the screen size.',
      },
    ],
  };
}

describe('the HTML report', () => {
  it('passes its own responsive checks', async () => {
    const result = createScanResult([page('/'), page('/pricing/enterprise-customers-and-teams')], {
      version: '0.0.0',
      startedAt: new Date(),
      minWidth: 320,
      maxWidth: 1920,
      step: 16,
      baseUrl: 'http://localhost:3000',
    });
    const file = join(mkdtempSync(join(tmpdir(), 'breakhound-report-')), 'report.html');
    writeFileSync(file, renderHtml(result));

    const scanned = await scanPage(pathToFileURL(file).href, { maxWidth: 1440 });
    const problems = scanned.issues.filter((i) => i.severity !== 'info');
    expect(problems.map((i) => `${i.detector} ${i.element.selector} ${i.title}`)).toEqual([]);
  });
});
