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

  const routes: RouteResult[] = [];
  const scripts = await addTracking(cdp, options.analyzerScript);
  try {
    for (let i = 0; i < queue.jobs.length && routes.length < max; i++) {
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
        if (error instanceof Cancelled) throw error;
        const message = error instanceof Error ? error.message : String(error);
        // The tab or the debugger went away: nothing more can be scanned.
        if (/detached|target closed|No tab with given id/i.test(message)) throw error;
        const failed: RouteResult = {
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
