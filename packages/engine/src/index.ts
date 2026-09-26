import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { cpus } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { AnalyzeResult } from '@breakhound/analyzers';
import { type Browser, type BrowserContext, chromium, type Page } from 'playwright';
import { buildBreakpoints, buildIssues } from './issues';
import { captureIssues } from './screenshots';
import { RESIZE_PROBE, settlePage } from './settle';
import { coarseWidths, Sweeper, splitWidths } from './sweep';
import type { Issue, PageResult, ScanOptions } from './types';

export { DETECTOR_IDS } from '@breakhound/analyzers/types';
export { createScanResult, type ResultMeta } from './result';
export type * from './types';

export const DEFAULTS = {
  minWidth: 320,
  maxWidth: 1920,
  step: 16,
  height: 900,
  maxSettleMs: 1000,
  networkIdleMs: 5000,
  concurrency: Math.max(1, Math.min(4, Math.floor(cpus().length / 2))),
  screenshotLimit: 25,
} satisfies ScanOptions;

/** Ranges this narrow get re-measured before being reported. */
const CONFIRM_BELOW_PX = 3;
const MAX_PAGE_ERRORS = 10;

let analyzerScript: string | undefined;

/** The injected analyzer bundle: next to this file when published, in the workspace in development. */
function loadAnalyzerScript(): string {
  if (!analyzerScript) {
    try {
      analyzerScript = readFileSync(fileURLToPath(new URL('./inject.js', import.meta.url)), 'utf8');
    } catch {
      const require = createRequire(import.meta.url);
      analyzerScript = readFileSync(require.resolve('@breakhound/analyzers/inject'), 'utf8');
    }
  }
  return analyzerScript;
}

async function hasContent(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const body = document.body;
    if (!body) return false;
    return (
      body.innerText.trim().length > 0 || !!body.querySelector('img, svg, canvas, video, iframe')
    );
  });
}

export class Scanner {
  private browser: Browser | null = null;

  private async ensureBrowser(): Promise<Browser> {
    if (!this.browser) this.browser = await chromium.launch({ headless: true });
    return this.browser;
  }

  private async openPage(
    context: BrowserContext,
    url: string,
    networkIdleMs: number,
    pageErrors: string[],
  ): Promise<Page> {
    const page = await context.newPage();
    page.on('pageerror', (e) => {
      if (pageErrors.length < MAX_PAGE_ERRORS)
        pageErrors.push(e.message.split('\n')[0] ?? e.message);
    });
    await page.goto(url, { waitUntil: 'load' });
    await settlePage(page, networkIdleMs);
    return page;
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
    const empty = {
      breakpoints: { observed: [], declared: [], unexplained: [] },
      issues: [],
      measurements: 0,
    };
    const pageErrors: string[] = [];

    try {
      await context.addInitScript({ content: RESIZE_PROBE });
      await context.addInitScript({ content: loadAnalyzerScript() });

      // Load once first: if the page is broken there's no point opening more tabs.
      const first = await this.openPage(context, url, opts.networkIdleMs, pageErrors);
      if (!(await hasContent(first))) {
        return {
          url,
          finalUrl: first.url(),
          status: 'empty',
          error: pageErrors[0]
            ? `The page rendered nothing. It threw: ${pageErrors[0]}`
            : 'The page rendered nothing.',
          pageErrors,
          ...empty,
          durationMs: Date.now() - started,
        };
      }

      const settings = {
        minWidth: opts.minWidth,
        maxWidth: opts.maxWidth,
        height: opts.height,
        maxSettleMs: opts.maxSettleMs,
        analyze: {
          ...(opts.detectors ? { detectors: opts.detectors } : {}),
          ...(opts.ignore ? { ignore: opts.ignore } : {}),
        },
      };
      const chunks = splitWidths(
        coarseWidths(opts.minWidth, opts.maxWidth, opts.step),
        opts.concurrency,
      );
      const pages = [
        first,
        ...(await Promise.all(
          chunks.slice(1).map(() => this.openPage(context, url, opts.networkIdleMs, [])),
        )),
      ];
      const sweepers = pages.map((p) => new Sweeper(p, settings));
      await Promise.all(sweepers.map((s, i) => s.run(chunks[i] ?? [])));

      const results = new Map<number, AnalyzeResult>();
      for (const s of sweepers)
        for (const [w, r] of s.results) if (!results.has(w)) results.set(w, r);
      const widths = [...results.keys()].sort((a, b) => a - b);

      const main = sweepers[0] as Sweeper;
      let issues = buildIssues(route, widths, results);
      issues = await confirmNarrowIssues(issues, main);

      if (opts.screenshotDir) {
        const files = await captureIssues(first, issues, opts.screenshotDir, {
          height: opts.height,
          maxSettleMs: opts.maxSettleMs,
          limit: opts.screenshotLimit,
        });
        for (const issue of issues) {
          const file = files.get(issue.id);
          if (file) issue.screenshot = file;
        }
      }

      const declared = await first.evaluate(() => window.__breakhound?.declaredBreakpoints() ?? []);
      return {
        url,
        finalUrl: first.url(),
        status: 'scanned',
        pageErrors,
        breakpoints: buildBreakpoints(widths, results, declared, opts.minWidth, opts.maxWidth),
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
        ...empty,
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
