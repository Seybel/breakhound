import { createScanResult, type Issue } from '@breakhound/engine';
import { describe, expect, it } from 'vitest';
import type { BreakhoundConfig } from '../src/config';
import { saveExtensionScan } from '../src/scan';
import { makeRepo } from './repo';

/**
 * A calendar issue stands for what the other checks found inside the calendar, so a project's
 * settings for those checks apply to it: switched off, or at another severity.
 */

function calendar(checksInside: string): Issue {
  return {
    id: 'calendar1',
    fingerprint: 'calendar|div.month|',
    detector: 'calendar',
    severity: 'error',
    title: "Calendar's 7 days don't fit side by side",
    ranges: [{ from: 320, to: 700 }],
    worstAt: 320,
    element: {
      selector: 'div.month',
      path: 'main > div',
      html: '<div class="month">',
      text: null,
      source: null,
    },
    evidence: { dayWidthPx: 40, checksInside },
    styles: {},
  };
}

/** What a scan sent from the browser, which runs every check, keeps under these settings. */
async function kept(issue: Issue, detectors: BreakhoundConfig['detectors']) {
  const sent = createScanResult(
    [
      {
        route: '/events',
        url: 'http://127.0.0.1:4999/events',
        finalUrl: 'http://127.0.0.1:4999/events',
        status: 'scanned',
        pageErrors: [],
        warnings: [],
        breakpoints: { observed: [], declared: [], unexplained: [] },
        issues: [issue],
        measurements: 40,
        durationMs: 1000,
      },
    ],
    { version: '1.0.0', startedAt: new Date(), minWidth: 320, maxWidth: 1440, step: 16 },
  );
  const result = await saveExtensionScan(sent, { detectors }, makeRepo());
  return result.routes[0]?.issues ?? [];
}

describe("a project's settings for the checks a calendar stands for", () => {
  it('give it their severities', async () => {
    const [lower] = await kept(calendar('overlap:error squished-text:warning'), {
      overlap: 'warning',
    });
    expect(lower?.severity).toBe('warning');
    const [info] = await kept(calendar('overlap:error'), { overlap: 'info' });
    expect(info?.severity).toBe('info');
    // Its own setting wins.
    const [own] = await kept(calendar('overlap:error'), { overlap: 'info', calendar: 'warning' });
    expect(own?.severity).toBe('warning');
  });

  it('leave out what switched-off checks found, and the calendar once all of them are', async () => {
    const [rest] = await kept(calendar('overlap:error squished-text:warning'), { overlap: false });
    expect(rest?.severity).toBe('warning');
    expect(
      await kept(calendar('overlap:error squished-text:warning'), {
        overlap: false,
        'squished-text': false,
      }),
    ).toEqual([]);
    expect(await kept(calendar('overlap:error'), { calendar: false })).toEqual([]);
  });
});
