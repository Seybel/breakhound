import type { AnalyzeResult } from '@breakhound/analyzers';
import {
  buildBreakpoints,
  buildIssues,
  coarseWidths,
  confirmNarrowIssues,
  FREEZE_CSS,
  RESIZE_PROBE,
  type RouteResult,
  Sweeper,
} from '@breakhound/engine/core';
import { type Cdp, evaluate, tabPage } from './cdp';

/** Same defaults as the CLI, so a page scans the same in both. */
export const TAB_DEFAULTS = {
  minWidth: 320,
  maxWidth: 1920,
  step: 16,
  height: 900,
  maxSettleMs: 1000,
};

export interface TabScanOptions {
  /** The analyzers bundle (`@breakhound/analyzers/inject`). */
  analyzerScript: string;
  minWidth?: number;
  maxWidth?: number;
  step?: number;
  height?: number;
  maxSettleMs?: number;
  /**
   * Reload the page first, with breakhound's resize tracking in it from the
   * start, as the CLI loads pages. Without it the page is scanned as it is
   * now, and handlers the page set up before can't be waited for exactly.
   */
  reload?: boolean;
  /** The route the page stands for, which salts issue ids (`/blog/[slug]`); its path otherwise. */
  route?: string;
  onProgress?: (progress: { width: number; measured: number }) => void;
  /** Every width measured for the sweep, with what was found there, as it happens. */
  onMeasure?: (width: number, result: AnalyzeResult) => void;
  cancelled?: () => boolean;
}

const RELOAD_TIMEOUT_MS = 60_000;
const FREEZE_ATTR = 'data-breakhound-freeze';

/** The path an issue id is salted with: the URL path, plus a hash router's path. */
export function routeOf(href: string): string {
  const url = new URL(href);
  return url.hash.startsWith('#/') ? `${url.pathname}${url.hash.split('?')[0]}` : url.pathname;
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Reloads with the resize probe and analyzers added before any page script, and waits for it to settle. */
/**
 * Adds breakhound's resize tracking and analyzers to every document the tab
 * loads from now on, as the CLI loads pages. Returns what to remove later.
 */
export async function addTracking(cdp: Cdp, analyzerScript: string): Promise<string[]> {
  // Scripts added for new documents only run once the Page domain is on.
  await cdp.send('Page.enable');
  const ids: string[] = [];
  for (const source of [RESIZE_PROBE, analyzerScript]) {
    const { identifier } = await cdp.send<{ identifier: string }>(
      'Page.addScriptToEvaluateOnNewDocument',
      { source },
    );
    ids.push(identifier);
  }
  return ids;
}

export async function removeTracking(cdp: Cdp, ids: string[]): Promise<void> {
  for (const identifier of ids) {
    await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier }).catch(() => {});
  }
}

/**
 * Loads `url` in the tab (or the page again, with null) and waits for it to
 * settle: the new document complete, a moment for requests started on load,
 * then web fonts. A link into a hash router only changes the hash, so that
 * page is shown without a new document.
 */
export async function loadPage(cdp: Cdp, url: string | null): Promise<void> {
  const here = await evaluate<string>(cdp, () => location.href);
  const sameDocument =
    url !== null &&
    new URL(url).hash.startsWith('#/') &&
    new URL(url).href.split('#')[0] === here.split('#')[0];
  if (sameDocument) {
    await evaluate(
      cdp,
      (to: string) => {
        location.href = to;
      },
      url,
    );
  } else {
    await evaluate(cdp, () => {
      (window as unknown as { __breakhound_old?: boolean }).__breakhound_old = true;
    });
    if (url === null) await cdp.send('Page.reload', { ignoreCache: false });
    else await cdp.send('Page.navigate', { url });
    const deadline = Date.now() + RELOAD_TIMEOUT_MS;
    for (;;) {
      const loaded = await evaluate<boolean>(
        cdp,
        () =>
          !(window as unknown as { __breakhound_old?: boolean }).__breakhound_old &&
          document.readyState === 'complete',
        undefined,
        5000,
      ).catch(() => false);
      if (loaded) break;
      if (Date.now() > deadline) throw new Error('The page took over a minute to load.');
      await pause(100);
    }
  }
  await pause(500);
  // Web fonts, but not forever: a font that never finishes loading shouldn't hold up the scan.
  await evaluate(cdp, () =>
    Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 3000))]).then(
      () => undefined,
    ),
  );
}

async function reloadTracked(cdp: Cdp, analyzerScript: string): Promise<string[]> {
  const ids = await addTracking(cdp, analyzerScript);
  await loadPage(cdp, null);
  return ids;
}

/** Freezes animations and transitions, which would otherwise be measured mid-flight. */
async function freeze(cdp: Cdp): Promise<void> {
  await evaluate(
    cdp,
    ({ css, attr }: { css: string; attr: string }) => {
      if (document.querySelector(`style[${attr}]`)) return;
      const style = document.createElement('style');
      style.setAttribute(attr, '');
      style.textContent = css;
      document.head.appendChild(style);
    },
    { css: FREEZE_CSS, attr: FREEZE_ATTR },
  );
  await cdp.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
  });
}

/** Puts the tab back the way the developer had it. Never throws: the tab may be gone. */
async function restore(cdp: Cdp, scroll: { x: number; y: number }): Promise<void> {
  await cdp.send('Emulation.clearDeviceMetricsOverride').catch(() => {});
  await cdp.send('Emulation.setEmulatedMedia', { features: [] }).catch(() => {});
  await evaluate(
    cdp,
    ({ attr, x, y }: { attr: string; x: number; y: number }) => {
      for (const el of document.querySelectorAll(`style[${attr}]`)) el.remove();
      window.__breakhound?.clearHighlights();
      window.scrollTo(x, y);
    },
    { attr: FREEZE_ATTR, ...scroll },
  ).catch(() => {});
}

/**
 * Sweeps the tab from the narrowest to the widest width with the engine's own
 * sweep, and turns what it measured into issues and breakpoints, the same way
 * `breakhound scan` does for one page.
 */
export async function scanTab(cdp: Cdp, options: TabScanOptions): Promise<RouteResult> {
  const opts = { ...TAB_DEFAULTS, ...options };
  const started = Date.now();
  const scripts = opts.reload ? await reloadTracked(cdp, opts.analyzerScript) : [];
  await evaluate(cdp, opts.analyzerScript);

  const where = await evaluate<{
    href: string;
    x: number;
    y: number;
    width: number;
    height: number;
    hasContent: boolean;
  }>(cdp, () => ({
    href: location.href,
    x: window.scrollX,
    y: window.scrollY,
    width: window.innerWidth,
    height: window.innerHeight,
    hasContent: window.__breakhound?.hasContent() ?? false,
  }));
  const route = opts.route ?? routeOf(where.href);
  const base = {
    url: where.href,
    finalUrl: where.href,
    route,
    pageErrors: [],
    warnings: [],
  };
  if (!where.hasContent) {
    return {
      ...base,
      status: 'empty',
      error: 'The page has nothing on it to measure.',
      breakpoints: { observed: [], declared: [], unexplained: [] },
      issues: [],
      measurements: 0,
      durationMs: Date.now() - started,
    };
  }

  let measured = 0;
  const page = tabPage(cdp, {
    fit: { width: where.width, height: where.height },
    onResize: (width) => opts.onProgress?.({ width, measured: ++measured }),
    ...(opts.cancelled ? { cancelled: opts.cancelled } : {}),
  });
  try {
    await freeze(cdp);
    const sweeper = new Sweeper(page, {
      minWidth: opts.minWidth,
      maxWidth: opts.maxWidth,
      height: opts.height,
      maxSettleMs: opts.maxSettleMs,
      analyze: {},
      // Someone is watching the tab: grow it steadily instead of jumping around.
      order: 'ascending',
      ...(opts.onMeasure ? { onMeasure: opts.onMeasure } : {}),
    });
    await sweeper.run(coarseWidths(opts.minWidth, opts.maxWidth, opts.step));
    const widths = [...sweeper.results.keys()].sort((a, b) => a - b);
    const issues = await confirmNarrowIssues(buildIssues(route, widths, sweeper.results), sweeper);
    const declared = await evaluate<number[]>(
      cdp,
      () => window.__breakhound?.declaredBreakpoints() ?? [],
    );
    return {
      ...base,
      status: 'scanned',
      warnings: sweeper.unstable
        ? [
            'The layout kept changing on its own (an auto-playing carousel or live content?), so some width ranges are approximate.',
          ]
        : [],
      breakpoints: buildBreakpoints([sweeper.results], declared, opts.minWidth, opts.maxWidth),
      issues,
      measurements: widths.length,
      durationMs: Date.now() - started,
    };
  } finally {
    await restore(cdp, where);
    await removeTracking(cdp, scripts);
  }
}
