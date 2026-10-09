import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { styleText } from 'node:util';
import {
  BROWSER_LABELS,
  BROWSER_NAMES,
  type BrowserName,
  createScanResult,
  DEFAULTS,
  DETECTOR_IDS,
  type DetectorId,
  mergeBrowserResults,
  type PageResult,
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
  type Job,
  RouteQueue,
  readLinks,
  readRuntimeRoutes,
  runtimeRoutes,
  type Target,
} from '@breakhound/routes';

export type { Target };

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
import { ensureBrowsers } from './browser';
import { type BreakhoundConfig, normalizeIgnore } from './config';
import { guard, parseMemoryLimit } from './guard';
import { resolveModel } from './model';
import { printDiscovery, printFooter, printIssues, printNotes, printRouteLine } from './print';
import { touchSession } from './session';
import { lookAtPage, VISION_WIDTHS } from './vision';

export interface ScanRequest {
  targets: string[];
  config: BreakhoundConfig;
  cwd: string;
  version: string;
  quiet: boolean;
  /**
   * Pages to scan again exactly as an earlier scan did (for verify): its
   * route labels and URLs. URLs under `jobsBaseUrl` move to wherever the app
   * runs now.
   */
  jobs?: Target[];
  jobsBaseUrl?: string | null;
  /** An app that's already running (the MCP server keeps one up). It's left running. */
  app?: AppServer;
  /** false: only scan, and let the caller write reports. */
  write?: boolean;
  /** Called as each page finishes, for progress. */
  onPage?: (route: RouteResult) => void;
}

/** The same page on the app's current address. */
function rebase(url: string, from: string | null | undefined, to: string): string {
  const old = from?.replace(/\/+$/, '');
  if (!old || !(url === old || url.startsWith(`${old}/`) || url.startsWith(`${old}#`))) return url;
  return `${to.replace(/\/+$/, '')}${url.slice(old.length)}`;
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
    // Screenshots from a second or third browser sit in a folder named after it.
    else if ((BROWSER_NAMES as readonly string[]).includes(name)) clearScreenshots(join(dir, name));
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

/**
 * Source paths from the page can be absolute (Vue, React 18) or a dev server
 * URL path (React 19 stacks, Vite's /@fs/). Agents want them relative to the
 * project, and only when the file really is there.
 */
export function projectPath(file: string, root: string, basePath = ''): string | null {
  const candidates: string[] = [];
  let path = file.replace(/\\/g, '/');
  if (path.startsWith('/@fs/')) path = path.slice(4);
  if (isAbsolute(path)) candidates.push(path);
  if (path.startsWith('/')) {
    const inApp = basePath && path.startsWith(`${basePath}/`) ? path.slice(basePath.length) : path;
    candidates.push(join(root, inApp));
  } else {
    candidates.push(join(root, path));
  }
  for (const candidate of candidates) {
    const rel = relative(root, candidate);
    if (!rel.startsWith('..') && !isAbsolute(rel) && isFile(candidate))
      return rel.split(sep).join('/');
  }
  return null;
}

function relativeSources(routes: RouteResult[], root: string, basePath: string): void {
  for (const route of routes) {
    for (const issue of route.issues) {
      for (const element of [issue.element, issue.related]) {
        const source = element?.source;
        if (!element || !source) continue;
        const file = projectPath(source.file, root, basePath);
        element.source = file ? { ...source, file } : null;
      }
    }
  }
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

/** Runs `work` on every item, `size` at a time. */
async function pool<T>(items: T[], size: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    for (let item = items[next++]; item !== undefined; item = items[next++]) await work(item);
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
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
  /** Null when the request asked not to write them. */
  reports: WrittenReports | null;
  /** The app that was scanned, when it's still running (only for a request that passed one). */
  app: AppServer | null;
}

/** Name of the scan that later verify runs compare with. */
export const BASELINE_FILE = 'baseline.json';

/**
 * Scans the app or pages. The dev server and browser it starts are watched,
 * and shut down if they use more memory than the computer can spare.
 */
export function runScan(req: ScanRequest): Promise<ScanOutcome> {
  return guard.run({ limit: parseMemoryLimit(req.config.memoryLimit) }, () => scan(req));
}

async function scan(req: ScanRequest): Promise<ScanOutcome> {
  const { config, cwd, quiet } = req;
  const minWidth = config.widths?.min ?? DEFAULTS.minWidth;
  const maxWidth = config.widths?.max ?? DEFAULTS.maxWidth;
  const step = config.widths?.step ?? DEFAULTS.step;
  if (minWidth >= maxWidth)
    throw new Error('The minimum width must be smaller than the maximum width.');

  // URLs and files on the command line are scanned as given; anything else scans the app.
  const jobs = req.jobs;
  const pageMode = jobs
    ? jobs.every((j) => !j.url.startsWith('http'))
    : req.targets.length > 0 && req.targets.every((t) => isPageTarget(t, cwd));
  const pageTargets =
    jobs && pageMode ? jobs : pageMode ? resolveTargets(req.targets, config, cwd) : [];

  const outDir = resolve(cwd, config.outDir ?? '.breakhound');
  const screenshotDir = join(outDir, 'screenshots');
  const browsers: BrowserName[] = config.browsers?.length ? config.browsers : ['chromium'];
  const [firstBrowser = 'chromium', ...otherBrowsers] = browsers;
  ensureBrowsers(browsers);

  const authFile = join(cwd, AUTH_FILE);
  const auth = existsSync(authFile) ? { storageState: authFile } : {};
  const scanner = new Scanner({ ...auth, browser: firstBrowser });
  const startedAt = new Date();
  const routes: RouteResult[] = [];
  let app: AppServer | null = null;
  let plan: RoutePlan | null = null;
  let queue: RouteQueue;

  try {
    if (pageMode) {
      queue = new RouteQueue(null, {}, null);
      for (const t of pageTargets) queue.add(t);
    } else if (jobs) {
      app = req.app ?? (await resolveServer(cwd, config, quiet));
      queue = new RouteQueue(app.baseUrl, {}, null);
      const baseUrl = app.baseUrl;
      for (const j of jobs) queue.add({ ...j, url: rebase(j.url, req.jobsBaseUrl, baseUrl) });
    } else {
      app = req.app ?? (await resolveServer(cwd, config, quiet));
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

    // Screenshots from the previous run would pile up otherwise. A verify run
    // keeps them: the pages it doesn't scan again still show theirs.
    if (!jobs) clearScreenshots(screenshotDir);
    const known = queue.jobs.length + queue.waiting.size;
    if (!quiet) {
      console.log(
        styleText(
          'dim',
          `breakhound ${req.version} · ${plan?.crawl ? 'following links' : known === 1 ? '1 page' : `${known} pages`} · ${minWidth}–${maxWidth}px${browsers.length > 1 ? ` · ${browsers.map((b) => BROWSER_LABELS[b]).join(', ')}` : ''}\n`,
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
      ...(config.states === false
        ? { states: 0 }
        : typeof config.states === 'number'
          ? { states: config.states }
          : {}),
    };

    await drain(queue, parallel, async (job) => {
      if (job.linksOnly) {
        const links = await scanner
          .visit(job.url, (page) => page.evaluate(readLinks))
          .catch(() => [] as string[]);
        queue.addLinks(links);
        return;
      }
      const afterLoad =
        pageMode || jobs
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
      req.onPage?.(route);
      if (!quiet) printRouteLine(route, width);
    });

    // The other browsers check the pages the first one could scan, one browser at a time.
    const scanned = results.filter((r) => r.route.status === 'scanned');
    const checks = new Map<RouteResult, { browser: BrowserName; result: PageResult }[]>();
    for (const browser of otherBrowsers) {
      if (!scanned.length) break;
      if (!quiet) {
        console.log(
          styleText(
            'dim',
            `\n  Checking ${scanned.length === 1 ? '1 page' : `${scanned.length} pages`} again in ${BROWSER_LABELS[browser]}...`,
          ),
        );
      }
      const other = new Scanner({ ...auth, browser });
      try {
        await pool(scanned, parallel, async ({ route }) => {
          const result = await other.scanPage(route.url, {
            ...baseOptions,
            route: route.route,
            ...(baseOptions.screenshotDir
              ? { screenshotDir: join(baseOptions.screenshotDir, browser) }
              : {}),
          });
          for (const i of result.issues)
            if (i.screenshot) i.screenshot = `${browser}/${i.screenshot}`;
          checks.set(route, [...(checks.get(route) ?? []), { browser, result }]);
        });
      } finally {
        await other.close();
      }
    }
    for (const r of scanned) {
      const others = checks.get(r.route);
      if (others)
        r.route = { ...mergeBrowserResults(r.route, firstBrowser, others), route: r.route.route };
    }

    // A vision model's look at each page, when asked for. Never on verify: an opinion can't be verified.
    if (config.vision && !jobs && scanned.length) {
      const asked = typeof config.vision === 'object' ? config.vision : {};
      const provider = asked.provider ?? config.fix?.provider;
      const model = await resolveModel({
        ...(provider ? { provider } : {}),
        ...((asked.model ?? config.fix?.model) ? { model: asked.model ?? config.fix?.model } : {}),
      });
      const widths = (asked.widths ?? VISION_WIDTHS).filter((w) => w >= minWidth && w <= maxWidth);
      if (!quiet) {
        console.log(
          styleText(
            'dim',
            `\n  Showing ${scanned.length === 1 ? '1 page' : `${scanned.length} pages`} at ${widths.join(', ')}px to ${model.model}. Screenshots go to ${new URL(model.endpoint).origin}.`,
          ),
        );
      }
      await pool(scanned, parallel, async (r) => {
        try {
          const found = await lookAtPage(scanner, r.route, model, {
            widths,
            height: DEFAULTS.height,
            ...(baseOptions.screenshotDir ? { screenshotDir: baseOptions.screenshotDir } : {}),
          });
          r.route.issues.push(...found);
        } catch (error) {
          r.route.warnings.push(
            `The vision check failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      });
    }

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
    if (!req.app) await app?.server?.stop();
  }

  applySeverity(routes, config);
  relativeSources(routes, app?.project?.root ?? cwd, app?.project?.basePath ?? '');
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
    browsers,
  });
  const kept = req.app ? app : null;
  if (req.write === false) return { result, reports: null, app: kept };
  const reports = await saveReports(result, config, cwd);
  // A scan becomes what verify compares with. Scanning some routes of the app
  // only replaces those routes; a whole-app or URL scan replaces everything.
  const baselineFile = join(outDir, BASELINE_FILE);
  const partial = !pageMode && req.targets.length > 0 && existsSync(baselineFile);
  const baseline = partial
    ? mergeScans(JSON.parse(readFileSync(baselineFile, 'utf8')) as ScanResult, result)
    : result;
  writeFileSync(baselineFile, `${JSON.stringify(baseline, null, 2)}\n`);
  touchSession(cwd, config.outDir ?? '.breakhound');

  if (!quiet) {
    printIssues(result);
    printNotes(result, existsSync(authFile));
    printFooter(reports, result, cwd);
  }
  return { result, reports, app: kept };
}

/** Writes result.json and every report for a result into the configured folder. */
export function saveReports(
  result: ScanResult,
  config: BreakhoundConfig,
  cwd: string,
): Promise<WrittenReports> {
  const outDir = resolve(cwd, config.outDir ?? '.breakhound');
  return writeReports(result, outDir, {
    screenshotDir: join(outDir, 'screenshots'),
    pdf: config.pdf ?? false,
    verifyCommand: 'npx breakhound verify',
  });
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

/** An earlier scan with some pages scanned again. */
export function mergeScans(earlier: ScanResult, now: ScanResult): ScanResult {
  const fresh = new Map(now.routes.map((r) => [r.route, r]));
  const routes = earlier.routes.map((r) => fresh.get(r.route) ?? r);
  for (const r of now.routes) if (!earlier.routes.some((b) => b.route === r.route)) routes.push(r);
  const merged = createScanResult(routes, {
    version: now.tool.version,
    startedAt: new Date(now.startedAt),
    minWidth: earlier.settings.minWidth,
    maxWidth: earlier.settings.maxWidth,
    step: earlier.settings.step,
    framework: now.project.framework ?? earlier.project.framework,
    baseUrl: now.project.baseUrl ?? earlier.project.baseUrl,
    root: now.project.root ?? earlier.project.root,
    browsers: now.settings.browsers,
  });
  return { ...merged, durationMs: now.durationMs };
}
