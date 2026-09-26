export type Severity = 'error' | 'warning' | 'info';

export type DetectorId =
  | 'page-overflow'
  | 'content-overflow'
  | 'media-overflow'
  | 'overlap'
  | 'unexpected-wrap'
  | 'clipped-text'
  | 'squished-text'
  | 'distorted-media'
  | 'small-tap-target'
  | 'tiny-text'
  | 'edge-gutter'
  | 'viewport-meta';

export const DETECTOR_IDS: readonly DetectorId[] = [
  'page-overflow',
  'content-overflow',
  'media-overflow',
  'overlap',
  'unexpected-wrap',
  'clipped-text',
  'squished-text',
  'distorted-media',
  'small-tap-target',
  'tiny-text',
  'edge-gutter',
  'viewport-meta',
];

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
  /** Plain-language hint at the likely fix. */
  suggestion?: string;
  /** Selectors of the element's ancestors, nearest first, so nested findings can be merged. */
  lineage?: string[];
}

/** Line counts for elements that should normally stay on one line. */
export interface WrapStat {
  element: ElementInfo;
  kind: 'row' | 'label';
  lines: number;
  items: number;
}

export interface IgnoreRule {
  /** CSS selector; matching elements and everything inside them are ignored. */
  selector: string;
  /** Limit the rule to these detectors. Omit to ignore every detector. */
  detectors?: DetectorId[];
}

export interface AnalyzeOptions {
  detectors?: DetectorId[];
  ignore?: IgnoreRule[];
}

export interface AnalyzeResult {
  width: number;
  findings: Finding[];
  wraps: WrapStat[];
  /** Discrete description of the layout; changes only at behavioural breakpoints. */
  signature: string;
}
