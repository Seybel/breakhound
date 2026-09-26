import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { styleText } from 'node:util';
import {
  createScanResult,
  DEFAULTS,
  DETECTOR_IDS,
  type DetectorId,
  type RouteResult,
  Scanner,
  type ScanResult,
  type Severity,
} from '@breakhound/engine';
import { type WrittenReports, writeReports } from '@breakhound/report';
import { ensureChromium } from './browser';
import { type BreakhoundConfig, normalizeIgnore } from './config';
import { printFooter, printIssues, printRouteLine } from './print';

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

function toUrl(target: string, baseUrl: string | undefined, cwd: string): string {
  if (/^https?:\/\//i.test(target) || target.startsWith('file:')) return target;
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(target)) return `http://${target}`;
  const file = resolve(cwd, target);
  // A local HTML file wins; otherwise a path is a route on the app.
  if (isFile(file)) return pathToFileURL(file).href;
  if (baseUrl) return new URL(target, baseUrl).href;
  throw new Error(
    `Can't tell what "${target}" is. Pass a full URL like http://localhost:3000${target.startsWith('/') ? target : `/${target}`}`,
  );
}

function routeOf(url: string): string {
  const u = new URL(url);
  if (u.protocol === 'file:') return basename(u.pathname);
  return `${u.pathname}${u.search}` || '/';
}

export function resolveTargets(targets: string[], config: BreakhoundConfig, cwd: string): Target[] {
  const list = targets.length ? targets : (config.routes ?? (config.baseUrl ? ['/'] : []));
  if (!list.length) {
    throw new Error(
      'Nothing to scan. Pass a URL (breakhound http://localhost:3000) or run breakhound init to set up a config.',
    );
  }
  const seen = new Set<string>();
  const out: Target[] = [];
  for (const t of list) {
    const url = toUrl(t, config.baseUrl, cwd);
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ url, route: routeOf(url) });
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

export interface ScanOutcome {
  result: ScanResult;
  reports: WrittenReports;
}

export async function runScan(req: ScanRequest): Promise<ScanOutcome> {
  const { config, cwd } = req;
  const targets = resolveTargets(req.targets, config, cwd);
  const minWidth = config.widths?.min ?? DEFAULTS.minWidth;
  const maxWidth = config.widths?.max ?? DEFAULTS.maxWidth;
  const step = config.widths?.step ?? DEFAULTS.step;
  if (minWidth >= maxWidth)
    throw new Error('The minimum width must be smaller than the maximum width.');

  const outDir = resolve(cwd, config.outDir ?? '.breakhound');
  const screenshotDir = join(outDir, 'screenshots');
  // Screenshots from the previous run would pile up otherwise.
  if (existsSync(screenshotDir)) rmSync(screenshotDir, { recursive: true, force: true });

  ensureChromium();
  if (!req.quiet) {
    console.log(
      styleText(
        'dim',
        `breakhound ${req.version} · ${targets.length === 1 ? '1 page' : `${targets.length} pages`} · ${minWidth}–${maxWidth}px\n`,
      ),
    );
  }

  const detectors = enabledDetectors(config);
  const ignore = normalizeIgnore(config.ignore);
  const startedAt = new Date();
  const scanner = new Scanner();
  const routes: RouteResult[] = [];
  const width = Math.min(40, Math.max(...targets.map((t) => t.route.length)));
  try {
    for (const target of targets) {
      const page = await scanner.scanPage(target.url, {
        route: target.route,
        minWidth,
        maxWidth,
        step,
        ...(detectors ? { detectors } : {}),
        ...(ignore.length ? { ignore } : {}),
        ...(config.concurrency ? { concurrency: config.concurrency } : {}),
        ...(config.settle?.networkIdleMs ? { networkIdleMs: config.settle.networkIdleMs } : {}),
        ...(config.settle?.maxSettleMs ? { maxSettleMs: config.settle.maxSettleMs } : {}),
        ...(config.screenshots === false ? {} : { screenshotDir }),
      });
      const route: RouteResult = { ...page, route: target.route };
      routes.push(route);
      if (!req.quiet) printRouteLine(route, width);
    }
  } finally {
    await scanner.close();
  }

  applySeverity(routes, config);
  const baseUrl =
    config.baseUrl ?? (targets[0]?.url.startsWith('http') ? new URL(targets[0].url).origin : null);
  const result = createScanResult(routes, {
    version: req.version,
    startedAt,
    minWidth,
    maxWidth,
    step,
    baseUrl,
    root: cwd,
  });
  const reports = await writeReports(result, outDir, {
    screenshotDir,
    pdf: config.pdf ?? false,
    verifyCommand: 'npx breakhound',
  });

  if (!req.quiet) {
    printIssues(result);
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
