export type Severity = 'error' | 'warning' | 'info';

export type DetectorId =
  | 'page-overflow'
  | 'content-overflow'
  | 'media-overflow'
  | 'overlap'
  | 'unexpected-wrap';

export interface ElementInfo {
  /** Shortest unique CSS selector, stable across viewport widths. */
  selector: string;
  /** Readable ancestry, e.g. `header > nav > ul`. */
  path: string;
  /** Trimmed outerHTML of the opening tag plus a short text preview. */
  html: string;
  text: string | null;
}

export interface Finding {
  detector: DetectorId;
  severity: Severity;
  title: string;
  element: ElementInfo;
  /** Second element for pairwise findings such as overlap. */
  related?: ElementInfo;
  /** Detector specific numbers, e.g. `{ overflowPx: 38 }`. */
  evidence: Record<string, number | string | boolean>;
  styles: Record<string, string>;
}

/** Line counts for elements that should normally stay on one line. */
export interface WrapStat {
  element: ElementInfo;
  kind: 'row' | 'label';
  lines: number;
  items: number;
}

export interface AnalyzeOptions {
  detectors?: DetectorId[];
}

export interface AnalyzeResult {
  width: number;
  findings: Finding[];
  wraps: WrapStat[];
  /** Discrete description of the layout; changes only at behavioural breakpoints. */
  signature: string;
}
