import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { type Browser, chromium } from 'playwright';
import { buildBreakpoints, buildIssues } from './issues';
import { RESIZE_PROBE, settlePage } from './settle';
import { Sweeper } from './sweep';
import type { Issue, PageResult, ScanOptions } from './types';

export type * from './types';

const DEFAULTS = {
  minWidth: 320,
  maxWidth: 1920,
  step: 16,
  height: 900,
  maxSettleMs: 1000,
  networkIdleMs: 5000,
} satisfies ScanOptions;

/** Ranges this narrow get re-measured before being reported. */
const CONFIRM_BELOW_PX = 3;
const MAX_PAGE_ERRORS = 10;

let analyzerScript: string | undefined;

function loadAnalyzerScript(): string {
  if (!analyzerScript) {
    const require = createRequire(import.meta.url);
    analyzerScript = readFileSync(require.resolve('@breakhound/analyzers/inject'), 'utf8');
  }
  return analyzerScript;
}

export class Scanner {
  private browser: Browser | null = null;

  private async ensureBrowser(): Promise<Browser> {
    if (!this.browser) this.browser = await chromium.launch({ headless: true });
    return this.browser;
  }

  async scanPage(url: string, options: ScanOptions = {}): Promise<PageResult> {
    const opts = { ...DEFAULTS, ...options };
    const route = opts.route ?? new URL(url).pathname;
    const started = Date.now();
    const browser = await this.ensureBrowser();
    const context = await browser.newContext({
      viewport: { width: opts.maxWidth, height: opts.height },
      deviceScaleFactor: 1,
      reducedMotion: 'reduce',
    });

    const pageErrors: string[] = [];
    try {
      await context.addInitScript({ content: RESIZE_PROBE });
      await context.addInitScript({ content: loadAnalyzerScript() });
      const page = await context.newPage();
      page.on('pageerror', (e) => {
        if (pageErrors.length < MAX_PAGE_ERRORS)
          pageErrors.push(e.message.split('\n')[0] ?? e.message);
      });
      await page.goto(url, { waitUntil: 'load' });
      await settlePage(page, opts.networkIdleMs);

      const rendered = await page.evaluate(() => {
        const body = document.body;
        if (!body) return false;
        return (
          body.innerText.trim().length > 0 ||
          !!body.querySelector('img, svg, canvas, video, iframe')
        );
      });
      if (!rendered) {
        return {
          url,
          finalUrl: page.url(),
          status: 'empty',
          error: pageErrors[0]
            ? `The page rendered nothing. It threw: ${pageErrors[0]}`
            : 'The page rendered nothing.',
          pageErrors,
          breakpoints: { observed: [], declared: [], unexplained: [] },
          issues: [],
          measurements: 0,
          durationMs: Date.now() - started,
        };
      }

      const sweeper = new Sweeper(page, {
        minWidth: opts.minWidth,
        maxWidth: opts.maxWidth,
        step: opts.step,
        height: opts.height,
        maxSettleMs: opts.maxSettleMs,
        analyze: {
          ...(opts.detectors ? { detectors: opts.detectors } : {}),
          ...(opts.ignore ? { ignore: opts.ignore } : {}),
        },
      });
      await sweeper.run();

      const widths = sweeper.sortedWidths();
      let issues = buildIssues(route, widths, sweeper.results);
      issues = await confirmNarrowIssues(issues, sweeper);

      const declared = await page.evaluate(() => window.__breakhound?.declaredBreakpoints() ?? []);
      return {
        url,
        finalUrl: page.url(),
        status: 'scanned',
        pageErrors,
        breakpoints: buildBreakpoints(
          widths,
          sweeper.results,
          declared,
          opts.minWidth,
          opts.maxWidth,
        ),
        issues,
        measurements: widths.length,
        durationMs: Date.now() - started,
      };
    } catch (error) {
      return {
        url,
        finalUrl: url,
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
        pageErrors,
        breakpoints: { observed: [], declared: [], unexplained: [] },
        issues: [],
        measurements: 0,
        durationMs: Date.now() - started,
      };
    } finally {
      await context.close();
    }
  }

  async close(): Promise<void> {
    await this.browser?.close();
    this.browser = null;
  }
}

async function confirmNarrowIssues(issues: Issue[], sweeper: Sweeper): Promise<Issue[]> {
  const kept: Issue[] = [];
  for (const issue of issues) {
    const narrow = issue.ranges.every((r) => r.to - r.from < CONFIRM_BELOW_PX);
    if (!narrow || issue.detector === 'unexpected-wrap') {
      kept.push(issue);
      continue;
    }
    const again = await sweeper.probe(issue.worstAt);
    const reproduced = again.findings.some(
      (f) =>
        f.detector === issue.detector &&
        f.element.selector === issue.element.selector &&
        (f.related?.selector ?? '') === (issue.related?.selector ?? ''),
    );
    if (reproduced) kept.push(issue);
  }
  return kept;
}

/** One-off scan that manages its own browser. */
export async function scanPage(url: string, options?: ScanOptions): Promise<PageResult> {
  const scanner = new Scanner();
  try {
    return await scanner.scanPage(url, options);
  } finally {
    await scanner.close();
  }
}
