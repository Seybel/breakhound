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
  | 'oversized-text'
  | 'edge-gutter'
  | 'viewport-meta'
  /** Opt-in: what a vision model noticed in screenshots. Never run in the page. */
  | 'vision';

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
  'oversized-text',
  'edge-gutter',
  'viewport-meta',
];

/** Where an element comes from in the project's code. */
export interface SourceLocation {
  /** Path relative to the project root, with `/` separators. */
  file: string;
  line?: number;
  column?: number;
  /** The component that renders the element, when known. */
  component?: string;
  /**
   * True when this is the element's own line (from a source plugin or the
   * framework's dev info). False when it's only the file or component that
   * renders it, so the element is somewhere inside.
   */
  exact: boolean;
}

export interface ElementInfo {
  /** Shortest unique CSS selector, stable across viewport widths. */
  selector: string;
  /** Readable ancestry, e.g. `header > nav > ul`. */
  path: string;
  /** Trimmed outerHTML of the opening tag plus a short text preview. */
  html: string;
  text: string | null;
  /** Where it's written in the code, when the page gives that away (dev builds only). */
  source?: SourceLocation | null;
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
  /** Also list the menus, dialogs, disclosures and tabs that can be opened at this width. */
  toggles?: boolean;
}

/**
 * What a toggle opens. `menu`: navigation menus, drawers and dropdowns.
 * `disclosure`: anything else with aria-expanded, such as accordions.
 * `tab`: a tab (role="tab") that isn't selected.
 */
export type ToggleKind = 'menu' | 'dialog' | 'popover' | 'details' | 'disclosure' | 'tab';

/** Something on the page that opens more of it when clicked. */
export interface Toggle {
  selector: string;
  kind: ToggleKind;
  /** Its accessible name, shortened: "Menu", "Open main menu". */
  label: string;
  /** Toggles that look and sit alike (the questions of an FAQ) share a group. */
  group: string;
  /** Lower first: menus and dialogs in the header before an accordion further down. */
  priority: number;
}

export interface AnalyzeResult {
  width: number;
  findings: Finding[];
  wraps: WrapStat[];
  /** Discrete description of the layout; changes only at behavioural breakpoints. */
  signature: string;
  /** Present when asked for with `toggles`. */
  toggles?: Toggle[];
  /** Which container query thresholds each size container is past; absent without container queries. */
  containers?: string;
}
