import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  createScanResult,
  FAILED_STATUSES,
  type Issue,
  type RouteResult,
  type ScanResult,
  type Severity,
} from '@breakhound/engine';
import { formatRanges, type WrittenReports } from '@breakhound/report';
import { globMatches } from '@breakhound/routes';
import type { AppServer } from './app';
import type { BreakhoundConfig } from './config';
import { BASELINE_FILE, mergeScans, runScan, saveReports } from './scan';

/** One issue in a verify run, with how it looked in the baseline when it was there. */
export interface IssueChange {
  route: string;
  issue: Issue;
  before?: Issue;
}

export interface VerifyResult {
  /** When the scan being compared with was made. */
  baselineAt: string;
  /** Routes scanned again. */
  checked: string[];
  fixed: IssueChange[];
  /** Still there, possibly at different widths. */
  failing: IssueChange[];
  /** Not in the baseline: a fix broke something, at another width or on another page. */
  regressions: IssueChange[];
  /** Pages that didn't load this time, so they couldn't be checked. */
  unchecked: RouteResult[];
  /** The baseline with the checked pages replaced: what's left to fix. */
  current: ScanResult;
}

export function readBaseline(cwd: string, outDir = '.breakhound'): ScanResult {
  const dir = resolve(cwd, outDir);
  for (const name of [BASELINE_FILE, 'result.json']) {
    const file = join(dir, name);
    if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8')) as ScanResult;
  }
  throw new Error('Nothing to verify against yet. Run breakhound first to scan the app.');
}

/** Tag and text of an element, as a fallback identity when its selector changed. */
function looks(issue: Issue): string {
  const tag = issue.element.html.match(/^<([\w-]+)/)?.[1] ?? '';
  return `${tag}|${issue.element.text ?? ''}`;
}

/** Which menu or dialog had to be open, so an issue in the open menu never matches one on the page. */
function stateOf(issue: Issue): string {
  return issue.state ? `${issue.state.kind}|${issue.state.label}` : '';
}

function sameSource(a: Issue, b: Issue): boolean {
  const x = a.element.source;
  const y = b.element.source;
  return Boolean(x?.exact && y?.exact && x.file === y.file && x.line === y.line);
}

/**
 * Matches the issues of one page before and after. Issue ids are stable, so
 * most match directly; when a fix changed an element's classes (and so its
 * selector), the same check on the same source line, or the same tag and
 * text, still counts as the same issue rather than a fix plus a new one.
 */
export function compareRoute(route: string, allBefore: Issue[], after: Issue[]) {
  // A vision model's opinion isn't measured again on verify, so it's neither fixed nor failing.
  const before = allBefore.filter((i) => i.detector !== 'vision');
  const fixed: IssueChange[] = [];
  const failing: IssueChange[] = [];
  const regressions: IssueChange[] = [];
  const left = new Map(before.map((i) => [i.id, i]));
  const unmatched: Issue[] = [];
  for (const issue of after) {
    const old = left.get(issue.id);
    if (old) {
      left.delete(issue.id);
      failing.push({ route, issue, before: old });
    } else {
      unmatched.push(issue);
    }
  }
  for (const issue of unmatched) {
    const old = [...left.values()].find(
      (o) =>
        o.detector === issue.detector &&
        stateOf(o) === stateOf(issue) &&
        (sameSource(o, issue) || (looks(o) === looks(issue) && issue.element.text !== null)),
    );
    if (old) {
      left.delete(old.id);
      failing.push({ route, issue, before: old });
    } else {
      regressions.push({ route, issue });
    }
  }
  for (const old of left.values()) fixed.push({ route, issue: old });
  return { fixed, failing, regressions };
}

export function compareScans(
  baseline: ScanResult,
  now: ScanResult,
): Omit<VerifyResult, 'current' | 'baselineAt'> {
  const out: Omit<VerifyResult, 'current' | 'baselineAt'> = {
    checked: [],
    fixed: [],
    failing: [],
    regressions: [],
    unchecked: [],
  };
  const byRoute = new Map(baseline.routes.map((r) => [r.route, r]));
  for (const route of now.routes) {
    out.checked.push(route.route);
    if (FAILED_STATUSES.includes(route.status)) {
      out.unchecked.push(route);
      continue;
    }
    const before = byRoute.get(route.route)?.issues ?? [];
    const diff = compareRoute(route.route, before, route.status === 'scanned' ? route.issues : []);
    out.fixed.push(...diff.fixed);
    out.failing.push(...diff.failing);
    out.regressions.push(...diff.regressions);
  }
  return out;
}

/** Which baseline pages to scan again: the ones asked for, or every page that was checked. */
export function pagesToVerify(baseline: ScanResult, routes: string[] = []): RouteResult[] {
  const checkable = baseline.routes.filter(
    (r) => r.url && (r.status === 'scanned' || FAILED_STATUSES.includes(r.status)),
  );
  if (!routes.length) return checkable;
  const picked = checkable.filter((r) =>
    routes.some((want) => want === r.route || globMatches(want, r.route)),
  );
  if (!picked.length) {
    throw new Error(
      `None of ${routes.join(', ')} was scanned before. Scanned routes: ${checkable.map((r) => r.route).join(', ')}`,
    );
  }
  return picked;
}

export interface VerifyRequest {
  cwd: string;
  config: BreakhoundConfig;
  version: string;
  quiet: boolean;
  /** Routes (or globs) to check; all scanned routes when empty. */
  routes?: string[];
  app?: AppServer;
  onPage?: (route: RouteResult) => void;
  /** Scans the pages somewhere else: the browser extension, for a baseline it sent. */
  scanPages?: (
    pages: { route: string; url: string }[],
    widths: { minWidth: number; maxWidth: number },
  ) => Promise<RouteResult[]>;
}

export interface VerifyOutcome extends VerifyResult {
  reports: WrittenReports;
}

/**
 * Scans pages again with the baseline's settings and compares: what got
 * fixed, what's still failing, and what's new. The baseline stays as it is,
 * so repeated verify runs always compare with the state before any fixes.
 */
export async function runVerify(req: VerifyRequest): Promise<VerifyOutcome> {
  const baseline = readBaseline(req.cwd, req.config.outDir);
  if (baseline.from === 'extension' && !req.scanPages) {
    throw new Error(
      'These issues were sent from the breakhound extension, so they are checked again in that browser. Run verify from your agent with the breakhound panel open, or scan again here to start over without it.',
    );
  }
  const pages = pagesToVerify(baseline, req.routes);
  if (req.scanPages) {
    const routes = await req.scanPages(
      pages.map((r) => ({ route: r.route, url: r.url })),
      {
        minWidth: baseline.settings.minWidth,
        maxWidth: baseline.settings.maxWidth,
      },
    );
    const now = createScanResult(routes, {
      version: req.version,
      startedAt: new Date(),
      minWidth: baseline.settings.minWidth,
      maxWidth: baseline.settings.maxWidth,
      step: baseline.settings.step,
      baseUrl: baseline.project.baseUrl,
      root: req.cwd,
    });
    // The browser scans with every check on; the project's own settings apply here.
    const off = req.config.detectors ?? {};
    for (const r of now.routes) r.issues = r.issues.filter((i) => off[i.detector] !== false);
    return finishVerify(req, baseline, now);
  }
  const { settings } = baseline;
  const { result } = await runScan({
    targets: [],
    config: {
      ...req.config,
      widths: { min: settings.minWidth, max: settings.maxWidth, step: settings.step },
    },
    cwd: req.cwd,
    version: req.version,
    quiet: req.quiet,
    jobs: pages.map((r) => ({ route: r.route, url: r.url })),
    jobsBaseUrl: baseline.project.baseUrl,
    ...(req.app ? { app: req.app } : {}),
    ...(req.onPage ? { onPage: req.onPage } : {}),
    write: false,
  });
  return finishVerify(req, baseline, result);
}

/** Compares a fresh scan with the baseline, and saves what's left to fix. */
async function finishVerify(
  req: VerifyRequest,
  baseline: ScanResult,
  result: ScanResult,
): Promise<VerifyOutcome> {
  const diff = compareScans(baseline, result);
  const current = mergeScans(baseline, result);
  const reports = await saveReports(current, req.config, req.cwd);
  const outcome: VerifyOutcome = { baselineAt: baseline.startedAt, ...diff, current, reports };
  const dir = resolve(req.cwd, req.config.outDir ?? '.breakhound');
  const { current: _, reports: __, ...saved } = outcome;
  writeFileSync(join(dir, 'verify.json'), `${JSON.stringify(saved, null, 2)}\n`);
  return outcome;
}

const RANK: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

/** Whether a verify run leaves nothing to do at these severities. */
export function verifyPassed(v: VerifyResult, severities: Severity[]): boolean {
  const counts = (list: IssueChange[]) => list.some((c) => severities.includes(c.issue.severity));
  return !v.unchecked.length && !counts(v.failing) && !counts(v.regressions);
}

export function severitiesAtOrAbove(level: Severity): Severity[] {
  return (Object.keys(RANK) as Severity[]).filter((s) => RANK[s] <= RANK[level]);
}

function changeLine(c: IssueChange): string {
  const now = formatRanges(c.issue.ranges);
  const was = c.before ? formatRanges(c.before.ranges) : null;
  const widths = was && was !== now ? `${now} (was ${was})` : now;
  return `${c.route}  ${widths}  [${c.issue.severity}] ${c.issue.title}  \`${c.issue.element.selector}\``;
}

/**
 * Plain text for people and agents alike: counts first, then each issue on
 * one line, then what to do next.
 */
export function formatVerify(v: VerifyResult, severities: Severity[]): string {
  const relevant = (list: IssueChange[]) =>
    list.filter((c) => severities.includes(c.issue.severity));
  const failing = relevant(v.failing);
  const regressions = relevant(v.regressions);
  const when = new Date(v.baselineAt).toLocaleString('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  const lines = [
    `Checked ${v.checked.length === 1 ? '1 page' : `${v.checked.length} pages`} against the scan from ${when}.`,
    `Fixed: ${v.fixed.length} · Still there: ${failing.length} · New: ${regressions.length}${v.unchecked.length ? ` · Not checked: ${v.unchecked.length}` : ''}`,
  ];
  const section = (title: string, list: IssueChange[]) => {
    if (!list.length) return;
    lines.push('', `${title}:`);
    for (const c of list) lines.push(`- ${changeLine(c)}`);
  };
  section('Fixed', v.fixed);
  section('Still there', failing);
  section('New since that scan (a change broke these, possibly at another width)', regressions);
  if (v.unchecked.length) {
    lines.push('', "Couldn't be checked:");
    for (const r of v.unchecked) lines.push(`- ${r.route}: ${r.error ?? r.status}`);
  }
  lines.push(
    '',
    verifyPassed(v, severities)
      ? 'Nothing left to fix on these pages.'
      : 'Not done yet. Fix what is still there or new, then verify again.',
  );
  return lines.join('\n');
}
