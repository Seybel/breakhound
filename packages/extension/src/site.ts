import type { AnalyzeResult } from '@breakhound/analyzers';
import type { RouteResult } from '@breakhound/engine/core';
import {
  Crawler,
  RouteQueue,
  readLinks,
  readRuntimeRoutes,
  routeFor,
  runtimeRoutes,
} from '@breakhound/routes/browser';
import { Cancelled, type Cdp, evaluate } from './cdp';
import {
  addTracking,
  loadPage,
  removeTracking,
  routeOf,
  scanTab,
  type TabScanOptions,
} from './scan';

/** Fewer than the CLI's 50: these pages load one after another in the tab someone is looking at. */
export const SITE_MAX_PAGES = 25;

export interface SiteScanOptions
  extends Omit<TabScanOptions, 'reload' | 'route' | 'onProgress' | 'onMeasure'> {
  maxPages?: number;
  /** A page is about to be loaded and scanned. */
  onPage?: (page: { index: number; planned: number; url: string; route: string }) => void;
  onProgress?: (progress: { width: number; measured: number }) => void;
  onMeasure?: (width: number, result: AnalyzeResult) => void;
  /** A page is done. */
  onResult?: (route: RouteResult) => void;
}

export interface SiteScan {
  routes: RouteResult[];
  /** Where the pages came from: the app's live router, or links. */
  from: string;
}

/** A page that couldn't be scanned, unless scanning can't go on at all (stopped, or the tab is gone). */
function failedPage(job: { url: string; route: string }, error: unknown): RouteResult {
  if (error instanceof Cancelled) throw error;
  const message = error instanceof Error ? error.message : String(error);
  if (/detached|target closed|No tab with given id/i.test(message)) throw error;
  return {
    url: job.url,
    finalUrl: job.url,
    route: job.route,
    status: 'error',
    error: message,
    pageErrors: [],
    warnings: [],
    breakpoints: { observed: [], declared: [], unexplained: [] },
    issues: [],
    measurements: 0,
    durationMs: 0,
  };
}

/**
 * Scans the given pages of the site the tab is on, loading each one fresh, then goes back to the
 * page it started on. How a coding agent's fixes are checked: the pages it was sent, again.
 */
export async function scanPages(
  cdp: Cdp,
  pages: { route: string; url: string }[],
  options: SiteScanOptions,
): Promise<RouteResult[]> {
  const start = await evaluate<string>(cdp, () => location.href);
  const routes: RouteResult[] = [];
  const scripts = await addTracking(cdp, options.analyzerScript);
  try {
    for (const [index, job] of pages.entries()) {
      if (options.cancelled?.()) throw new Cancelled();
      options.onPage?.({ index, planned: pages.length, url: job.url, route: job.route });
      let result: RouteResult;
      try {
        await loadPage(cdp, job.url);
        result = await scanTab(cdp, {
          ...options,
          route: job.route,
          onProgress: options.onProgress,
          onMeasure: options.onMeasure,
        } as TabScanOptions);
      } catch (error) {
        result = failedPage(job, error);
      }
      routes.push(result);
      options.onResult?.(result);
    }
  } finally {
    await removeTracking(cdp, scripts);
    await loadPage(cdp, start).catch(() => {});
  }
  return routes;
}

/**
 * Scans the site the tab is on, one page at a time, the way `breakhound`
 * scans a whole app: routes from the live router when the app has one
 * (dynamic ones filled in from links on scanned pages), otherwise links
 * followed from this page and the home page, with the CLI's own rules for
 * which links are safe and worth it. Ends back on the page it started from.
 */
export async function scanSite(cdp: Cdp, options: SiteScanOptions): Promise<SiteScan> {
  const max = options.maxPages ?? SITE_MAX_PAGES;
  const start = await evaluate<string>(cdp, () => location.href);
  const origin = new URL(start).origin;
  const hashRouting = new URL(start).hash.startsWith('#/');

  const found = runtimeRoutes(
    await evaluate<Parameters<typeof runtimeRoutes>[0]>(cdp, readRuntimeRoutes).catch(() => ({
      router: null,
      paths: [],
    })),
  );
  const queue = new RouteQueue(origin, {}, found ? null : new Crawler(max), hashRouting);
  const routeOfPath = (path: string) =>
    found ? (routeFor(path, found.routes)?.path ?? path) : path;
  // The page the developer is on comes first, then the home page.
  const startRoute = routeOfPath(routeOf(start));
  queue.add({ url: start, route: startRoute });
  queue.add({ url: `${origin}${hashRouting ? '/#/' : '/'}`, route: routeOfPath('/') });
  for (const pattern of found?.routes ?? []) queue.addPattern(pattern);
  // The page the developer is on is a real URL too: routes below it can reuse its values.
  if (found) {
    const at = new URL(start);
    queue.addLinks([hashRouting ? `${at.pathname}${at.hash.split('?')[0]}` : at.pathname]);
  }

  const routes: RouteResult[] = [];
  const scripts = await addTracking(cdp, options.analyzerScript);
  try {
    for (let i = 0; routes.length < max; i++) {
      // Links have had their chance: fill the routes still waiting from known values.
      if (i >= queue.jobs.length && !queue.fillWaiting()) break;
      if (options.cancelled?.()) throw new Cancelled();
      const job = queue.jobs[i];
      if (!job) continue;
      options.onPage?.({
        index: routes.length,
        planned: Math.min(max, queue.jobs.length - i + routes.length),
        url: job.url,
        route: job.route,
      });
      try {
        await loadPage(cdp, job.url);
        const final = await evaluate<string>(cdp, () => location.href);
        if (new URL(final).origin !== origin || queue.redirectTarget(job.url, final)) continue;
        const result = await scanTab(cdp, {
          ...options,
          route: job.route,
          onProgress: options.onProgress,
          onMeasure: options.onMeasure,
        } as TabScanOptions);
        routes.push(result);
        options.onResult?.(result);
        queue.addLinks(await evaluate<string[]>(cdp, readLinks).catch(() => []));
      } catch (error) {
        const failed = failedPage(job, error);
        routes.push(failed);
        options.onResult?.(failed);
      }
    }
  } finally {
    await removeTracking(cdp, scripts);
    // Back to where the developer was.
    await loadPage(cdp, start).catch(() => {});
  }
  return { routes, from: found?.from ?? 'links on your pages' };
}
