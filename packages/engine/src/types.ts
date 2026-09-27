import type { DetectorId, ElementInfo, IgnoreRule, Severity } from '@breakhound/analyzers/types';

export type { DetectorId, ElementInfo, IgnoreRule, Severity };

export interface WidthRange {
  from: number;
  to: number;
}

export interface Issue {
  /** Stable across scans: hash of route, detector and element. */
  id: string;
  /** Route-independent key (detector + element), used to group the same issue across pages. */
  fingerprint: string;
  detector: DetectorId;
  severity: Severity;
  title: string;
  /** Inclusive viewport-width ranges where the issue occurs. */
  ranges: WidthRange[];
  /** Width where the issue is most severe; details below are taken from here. */
  worstAt: number;
  element: ElementInfo & { source: null };
  related?: ElementInfo;
  evidence: Record<string, number | string | boolean>;
  styles: Record<string, string>;
  /** Plain-language hint at the likely fix. */
  suggestion?: string;
  /** Screenshot file name inside the scan's screenshot directory. */
  screenshot?: string;
}

export interface Breakpoints {
  /** Widths where the layout actually changes. */
  observed: number[];
  /** Widths declared by CSS media queries. */
  declared: number[];
  /** Observed changes with no declared breakpoint nearby. */
  unexplained: number[];
}

export interface PageResult {
  url: string;
  /** Where the page ended up after redirects (e.g. a login page). */
  finalUrl: string;
  /**
   * `empty`: the page rendered (almost) nothing, usually because it crashed.
   * `login`: it sent the browser to a sign-in page instead.
   * `redirect` and `skipped`: left out on purpose; `error` says why.
   */
  status: PageStatus;
  error?: string;
  /** Uncaught exceptions thrown by the page while it was scanned. */
  pageErrors: string[];
  /** Things that made this page's results less exact than usual. */
  warnings: string[];
  breakpoints: Breakpoints;
  issues: Issue[];
  /** Number of distinct widths that were measured. */
  measurements: number;
  durationMs: number;
}

export type PageStatus = 'scanned' | 'empty' | 'error' | 'login' | 'redirect' | 'skipped';

/** Returned from `afterLoad` to stop scanning a page, e.g. because it redirected to one already covered. */
export interface PageSkip {
  status: 'redirect' | 'skipped';
  message: string;
}

export interface ScanOptions {
  minWidth?: number;
  maxWidth?: number;
  /** Coarse sweep step in px; changes are then bisected to the exact pixel. */
  step?: number;
  height?: number;
  detectors?: DetectorId[];
  /** Longest to wait for a page's own resize handlers (e.g. debounced ones) after each resize. */
  maxSettleMs?: number;
  /** Max time to wait for network idle after load. */
  networkIdleMs?: number;
  /** Used to salt issue ids; defaults to the URL path. */
  route?: string;
  /** Elements to leave out of the scan. */
  ignore?: IgnoreRule[];
  /** Browser tabs used to measure widths in parallel. */
  concurrency?: number;
  /** Where to write issue screenshots. No screenshots when omitted. */
  screenshotDir?: string;
  /** Most screenshots to take for one page. */
  screenshotLimit?: number;
}

export interface ScannerOptions {
  /** A Playwright storage state file (cookies and local storage) to start every page with. */
  storageState?: string;
}

export interface RouteResult extends PageResult {
  /** Route pattern, e.g. `/products/[id]`, or the URL path for a plain URL. */
  route: string;
}

/** Everything one run of breakhound produced. All reports are rendered from this. */
export interface ScanResult {
  schemaVersion: 1;
  tool: { name: 'breakhound'; version: string };
  project: { framework: string | null; baseUrl: string | null; root: string | null };
  startedAt: string;
  durationMs: number;
  settings: { minWidth: number; maxWidth: number; step: number; browsers: string[] };
  routes: RouteResult[];
  summary: {
    routes: number;
    issues: number;
    /** Issues counted once even when the same element breaks on several routes. */
    uniqueIssues: number;
    /** Unique issues by severity. */
    bySeverity: Record<Severity, number>;
  };
}
