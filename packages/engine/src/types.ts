import type { DetectorId, ElementInfo, Severity } from '@breakhound/analyzers';

export type { DetectorId, ElementInfo, Severity };

export interface WidthRange {
  from: number;
  to: number;
}

export interface Issue {
  /** Stable across scans: hash of route, detector and element. */
  id: string;
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
  status: 'scanned' | 'error';
  error?: string;
  breakpoints: Breakpoints;
  issues: Issue[];
  /** Number of distinct widths that were measured. */
  measurements: number;
  durationMs: number;
}

export interface ScanOptions {
  minWidth?: number;
  maxWidth?: number;
  /** Coarse sweep step in px; changes are then bisected to the exact pixel. */
  step?: number;
  height?: number;
  detectors?: DetectorId[];
  /** Extra wait after each resize when the page listens for window resize events. */
  resizeDebounceMs?: number;
  /** Max time to wait for network idle after load. */
  networkIdleMs?: number;
  /** Used to salt issue ids; defaults to the URL path. */
  route?: string;
}
