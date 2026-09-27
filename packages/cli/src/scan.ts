import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { styleText } from 'node:util';
import {
  createScanResult,
  DEFAULTS,
  DETECTOR_IDS,
  type DetectorId,
  type PageSkip,
  type RouteResult,
  Scanner,
  type ScanOptions,
  type ScanResult,
  type Severity,
} from '@breakhound/engine';
import { type WrittenReports, writeReports } from '@breakhound/report';
import {
  Crawler,
  isCrawlable,
  type RoutePattern,
  readLinks,
  readRuntimeRoutes,
  routeFor,
  runtimeRoutes,
  staticUrlPath,
} from '@breakhound/routes';
import {
  type AppServer,
  applyFilters,
  DEFAULT_MAX_CRAWL,
  DEFAULT_MAX_ROUTES,
  isWanted,
  planRoutes,
  type RoutePlan,
  resolveServer,
} from './app';
import { AUTH_FILE } from './auth';
import { ensureChromium } from './browser';
import { type BreakhoundConfig, normalizeIgnore } from './config';
import { printDiscovery, printFooter, printIssues, printNotes, printRouteLine } from './print';

export interface ScanRequest {
  targets: string[];
  config: BreakhoundConfig;
  cwd: string;
  version: string;
  quiet: boolean;
}

export interface Target {
  url: string;
  route: string;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i;

/** A full URL, a localhost address or an HTML file: scanned as is, without looking for other routes. */
function isPageTarget(target: string, cwd: string): boolean {
  return (
    /^https?:\/\//i.test(target) ||
    target.startsWith('file:') ||
    LOCAL_HOST.test(target) ||
    isFile(resolve(cwd, target))
  );
}

function toUrl(target: string, baseUrl: string | undefined, cwd: string): string {
  if (/^https?:\/\//i.test(target) || target.startsWith('file:')) return target;
  if (LOCAL_HOST.test(target)) return `http://${target}`;
  const file = resolve(cwd, target);
  // A local HTML file wins; otherwise a path is a route on the app.
  if (isFile(file)) return pathToFileURL(file).href;
  if (baseUrl) return new URL(target, baseUrl).href;
  throw new Error(
    `Can't tell what "${target}" is. Pass a full URL like http://localhost:3000${target.startsWith('/') ? target : `/${target}`}`,
  );
}

function routeOf(url: string, cwd: string): string {
  const u = new URL(url);
  if (u.protocol === 'file:') {
    const path = fileURLToPath(u);
    const rel = relative(cwd, path);
    return rel.startsWith('..') ? path : rel;
  }
  return `${u.pathname}${u.search}` || '/';
}

/** Screenshots are named by issue id; only those are removed, never anything else in the folder. */
const SCREENSHOT_FILE = /^[0-9a-f]{10}\.png$/;

function clearScreenshots(dir: string): void {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (SCREENSHOT_FILE.test(name)) rmSync(join(dir, name), { force: true });
  }
}

/** Pages given on the command line as URLs or files. */
export function resolveTargets(targets: string[], config: BreakhoundConfig, cwd: string): Target[] {
  if (!targets.length) {
    throw new Error(
      'Nothing to scan. Pass a URL (breakhound http://localhost:3000) or run breakhound init to set up a config.',
    );
  }
  const seen = new Set<string>();
  const out: Target[] = [];
  for (const t of targets) {
    const url = toUrl(t, config.baseUrl, cwd);
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ url, route: routeOf(url, cwd) });
  }
  return out;
}

function enabledDetectors(config: BreakhoundConfig): DetectorId[] | undefined {
  const overrides = config.detectors;
  if (!overrides) return undefined;
  return DETECTOR_IDS.filter((id) => overrides[id] !== false);
}

function applySeverity(routes: RouteResult[], config: BreakhoundConfig): void {
  const overrides = config.detectors ?? {};
  for (const route of routes) {
    for (const issue of route.issues) {
      const o = overrides[issue.detector];
      if (o === 'error' || o === 'warning' || o === 'info') issue.severity = o as Severity;
    }
  }
}

function trimSlash(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, '') : path;
}

interface Job extends Target {
  order: number;
  /** Only visited to find links, because include or exclude leaves the page itself out. */
  linksOnly?: boolean;
}

/**
 * The routes still to scan. In a whole-app scan it keeps growing: links on
 * scanned pages give dynamic routes a real URL, and (when following links)
 * add new pages.
 */
class RouteQueue {
  readonly jobs: Job[] = [];
  /** App paths already scanned or planned, so redirects to them aren't scanned twice. */
  private readonly planned = new Set<string>();
  /** Dynamic routes still waiting for a link that fits them. */
  readonly waiting = new Map<string, RoutePattern>();
  readonly patterns = new Map<string, RoutePattern>();
  private order = 0;
  /** Where the app is mounted on its server, e.g. "/docs"; "" at the root. */
  private readonly basePath: string;

  constructor(
    private readonly baseUrl: string | null,
    private readonly samples: Record<string, string>,
    readonly crawler: Crawler | null,
    /** The app routes by hash, so its paths live after `/#`. */
    private readonly hashRouting = false,
  ) {
    this.basePath = baseUrl ? new URL(baseUrl).pathname.replace(/\/+$/, '') : '';
  }

  /** The full URL for an app path (or a full URL, as given). */
  private urlFor(path: string): string {
    if (/^https?:\/\//i.test(path)) return path;
    const base = (this.baseUrl ?? '').replace(/\/+$/, '');
    const clean = path.startsWith('/') ? path : `/${path}`;
    return this.hashRouting && !clean.includes('#') ? `${base}/#${clean}` : `${base}${clean}`;
  }

  /** The app path for a path on the server, or null when it's outside the app. */
  private appPath(pathname: string): string | null {
    const path = trimSlash(pathname);
    if (!this.basePath) return path;
    if (path === this.basePath) return '/';
    return path.startsWith(`${this.basePath}/`) ? path.slice(this.basePath.length) : null;
  }

  /** The key a full URL is planned under: its app path, with the hash route when there is one. */
  private keyOf(url: string): string {
    const u = new URL(url);
    const path = this.appPath(u.pathname) ?? trimSlash(u.pathname);
    if (!u.hash.startsWith('#/')) return path;
    const hash = trimSlash(u.hash.slice(1).split('?')[0] as string);
    if (this.hashRouting) return hash;
    return `${path === '/' ? '' : path}/#${hash}`;
  }

  /** The app path a link from a page points at, or null when it's outside the app. */
  private linkPath(link: string): string | null {
    const [pathname = '/', hash] = link.split('#');
    if (this.hashRouting) return hash?.startsWith('/') ? trimSlash(hash) : null;
    return hash === undefined ? this.appPath(pathname) : null;
  }

  add(target: Target, linksOnly = false): void {
    const key = target.url.startsWith('http') ? this.keyOf(target.url) : target.url;
    if (this.planned.has(key)) return;
    this.planned.add(key);
    this.crawler?.claim(key);
    this.jobs.push({ ...target, order: this.order++, ...(linksOnly ? { linksOnly } : {}) });
  }

  /** The home page when following links but include or exclude leaves it out. */
  addStart(path: string): void {
    this.add({ url: this.urlFor(path), route: path }, true);
  }

  addPattern(pattern: RoutePattern): void {
    if (this.patterns.has(pattern.path) || !this.baseUrl) return;
    this.patterns.set(pattern.path, pattern);
    const path = staticUrlPath(pattern);
    if (path !== null) {
      this.add({ url: this.urlFor(path), route: pattern.path });
      return;
    }
    const sample = this.samples[pattern.path];
    if (sample) this.add({ url: this.urlFor(sample), route: pattern.path });
    else this.waiting.set(pattern.path, pattern);
  }

  /** Links from a scanned page: samples for dynamic routes, and new pages when crawling. */
  addLinks(found: string[]): void {
    if (!this.baseUrl) return;
    // Never a logout, delete or file link, not even as a sample for a dynamic route.
    const links = found
      .map((link) => this.linkPath(link))
      .filter((p): p is string => p !== null && isCrawlable(p));
    if (this.waiting.size) {
      for (const link of links) {
        const route = routeFor(link, this.patterns.values());
        if (route && this.waiting.has(route.path)) {
          this.waiting.delete(route.path);
          this.add({ url: this.urlFor(link), route: route.path });
        }
      }
    }
    if (this.crawler) {
      for (const path of this.crawler.add(links)) this.add({ url: this.urlFor(path), route: path });
    }
  }

  /** A redirect to a page that's scanned anyway isn't worth scanning twice. */
  redirectTarget(requested: string, final: string): string | null {
    if (new URL(final).origin !== new URL(requested).origin) return null;
    const to = this.keyOf(final);
    if (to === this.keyOf(requested)) return null;
    if (this.planned.has(to)) return to;
    this.planned.add(to);
    return null;
  }
}

/** Runs `work` on queued jobs, `size` at a time, until the queue stays empty. */
async function drain(
  queue: RouteQueue,
  size: number,
  work: (job: Job) => Promise<void>,
): Promise<void> {
  const active = new Set<Promise<void>>();
  for (;;) {
    while (active.size < size && queue.jobs.length) {
      const job = queue.jobs.shift() as Job;
      const p: Promise<void> = work(job).finally(() => active.delete(p));
      active.add(p);
    }
    if (!active.size) return;
    await Promise.race(active);
  }
}

export interface ScanOutcome {
  result: ScanResult;
  reports: WrittenReports;
}

export async function runScan(req: ScanRequest): Promise<ScanOutcome> {
  const { config, cwd, quiet } = req;
  const minWidth = config.widths?.min ?? DEFAULTS.minWidth;
  const maxWidth = config.widths?.max ?? DEFAULTS.maxWidth;
  const step = config.widths?.step ?? DEFAULTS.step;
  if (minWidth >= maxWidth)
    throw new Error('The minimum width must be smaller than the maximum width.');

  // URLs and files on the command line are scanned as given; anything else scans the app.
  const pageMode = req.targets.length > 0 && req.targets.every((t) => isPageTarget(t, cwd));
  const pageTargets = pageMode ? resolveTargets(req.targets, config, cwd) : [];

  const outDir = resolve(cwd, config.outDir ?? '.breakhound');
  const screenshotDir = join(outDir, 'screenshots');
  ensureChromium();

  const authFile = join(cwd, AUTH_FILE);
  const scanner = new Scanner(existsSync(authFile) ? { storageState: authFile } : {});
  const startedAt = new Date();
  const routes: RouteResult[] = [];
  let app: AppServer | null = null;
  let plan: RoutePlan | null = null;
  let queue: RouteQueue;

  try {
    if (pageMode) {
      queue = new RouteQueue(null, {}, null);
      for (const t of pageTargets) queue.add(t);
    } else {
      app = await resolveServer(cwd, config, quiet);
      plan = await planRoutes(app, config, scanner, req.targets);
      const max = config.maxRoutes ?? (plan.crawl ? DEFAULT_MAX_CRAWL : DEFAULT_MAX_ROUTES);
      queue = new RouteQueue(
        app.baseUrl,
        config.samples ?? {},
        plan.crawl ? new Crawler(max, (path) => isWanted(path, config)) : null,
        plan.hashRouting,
      );
      for (const url of plan.urls) queue.add({ url, route: routeOf(url, cwd) });
      for (const p of plan.patterns) {
        if (plan.crawl && !isWanted(p.path, config)) queue.addStart(p.path);
        else queue.addPattern(p);
      }
      if (!quiet) printDiscovery(plan, max);
    }

    // Screenshots from the previous run would pile up otherwise.
    clearScreenshots(screenshotDir);
    const known = queue.jobs.length + queue.waiting.size;
    if (!quiet) {
      console.log(
        styleText(
          'dim',
          `breakhound ${req.version} · ${plan?.crawl ? 'following links' : known === 1 ? '1 page' : `${known} pages`} · ${minWidth}–${maxWidth}px\n`,
        ),
      );
    }

    const tabs = config.concurrency ?? DEFAULTS.concurrency;
    // Several pages at once hide the time a dev server spends compiling each one.
    const many = known > 1 || Boolean(plan?.crawl);
    const parallel = many ? Math.max(1, Math.floor(tabs / 2)) : 1;
    const tabsPerPage = Math.max(1, Math.floor(tabs / parallel));

    const detectors = enabledDetectors(config);
    const ignore = normalizeIgnore(config.ignore);
    const labels = [
      ...queue.jobs.filter((j) => !j.linksOnly).map((j) => j.route),
      ...queue.waiting.keys(),
    ];
    const width = Math.min(40, Math.max(12, ...labels.map((l) => l.length)));
    const max = config.maxRoutes ?? DEFAULT_MAX_ROUTES;
    const results: { order: number; route: RouteResult }[] = [];
    const baseOptions: ScanOptions = {
      minWidth,
      maxWidth,
      step,
      concurrency: tabsPerPage,
      ...(detectors ? { detectors } : {}),
      ...(ignore.length ? { ignore } : {}),
      ...(config.settle?.networkIdleMs ? { networkIdleMs: config.settle.networkIdleMs } : {}),
      ...(config.settle?.maxSettleMs ? { maxSettleMs: config.settle.maxSettleMs } : {}),
      ...(config.screenshots === false ? {} : { screenshotDir }),
    };

    await drain(queue, parallel, async (job) => {
      if (job.linksOnly) {
        const links = await scanner
          .visit(job.url, (page) => page.evaluate(readLinks))
          .catch(() => [] as string[]);
        queue.addLinks(links);
        return;
      }
      const afterLoad = pageMode
        ? undefined
        : async (page: import('playwright').Page): Promise<PageSkip | undefined> => {
            const links = await page.evaluate(readLinks).catch(() => [] as string[]);
            if (plan?.readRouterOnEveryPage) {
              const found = runtimeRoutes(
                await page.evaluate(readRuntimeRoutes).catch(() => ({ router: null, paths: [] })),
              );
              const fresh = (found?.routes ?? []).filter((r) => !queue.patterns.has(r.path));
              const room = Math.max(0, max - queue.patterns.size);
              for (const p of applyFilters(fresh, config, room).kept) queue.addPattern(p);
            }
            queue.addLinks(links);
            const to = queue.redirectTarget(job.url, page.url());
            return to
              ? { status: 'redirect', message: `Redirects to ${to}, which is scanned on its own` }
              : undefined;
          };
      const page = await scanner.scanPage(job.url, {
        ...baseOptions,
        route: job.route,
        ...(afterLoad ? { afterLoad } : {}),
      });
      const route: RouteResult = { ...page, route: job.route };
      results.push({ order: job.order, route });
      if (!quiet) printRouteLine(route, width);
    });

    // Dynamic routes no page linked to.
    let order = Number.MAX_SAFE_INTEGER - queue.waiting.size;
    for (const pattern of queue.waiting.values()) {
      const route: RouteResult = {
        route: pattern.path,
        url: '',
        finalUrl: '',
        status: 'skipped',
        error: 'No page links to it, so there was no real URL to try.',
        pageErrors: [],
        warnings: [],
        breakpoints: { observed: [], declared: [], unexplained: [] },
        issues: [],
        measurements: 0,
        durationMs: 0,
      };
      results.push({ order: order++, route });
      if (!quiet) printRouteLine(route, width);
    }
    routes.push(...results.sort((a, b) => a.order - b.order).map((r) => r.route));
  } finally {
    await scanner.close();
    await app?.server?.stop();
  }

  applySeverity(routes, config);
  const firstUrl = pageTargets[0]?.url;
  const baseUrl =
    app?.baseUrl ??
    config.baseUrl ??
    (firstUrl?.startsWith('http') ? new URL(firstUrl).origin : null);
  const framework = app?.project?.framework;
  const result = createScanResult(routes, {
    version: req.version,
    startedAt,
    minWidth,
    maxWidth,
    step,
    baseUrl,
    framework: framework && framework.id !== 'unknown' ? framework.name : null,
    root: cwd,
  });
  const reports = await writeReports(result, outDir, {
    screenshotDir,
    pdf: config.pdf ?? false,
    verifyCommand: 'npx breakhound',
  });

  if (!quiet) {
    printIssues(result);
    printNotes(result, existsSync(authFile));
    printFooter(reports, result, cwd);
  }
  return { result, reports };
}

export function readLastResult(
  cwd: string,
  outDir = '.breakhound',
): { result: ScanResult; dir: string } {
  const dir = resolve(cwd, outDir);
  const file = join(dir, 'result.json');
  if (!existsSync(file)) throw new Error('No scan yet. Run breakhound first.');
  return { result: JSON.parse(readFileSync(file, 'utf8')) as ScanResult, dir };
}
