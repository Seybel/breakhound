import { createHash } from 'node:crypto';
import type { AnalyzeResult, Finding } from '@breakhound/analyzers';
import type { Breakpoints, Issue, WidthRange } from './types';

/** When several overflow detectors blame the same element, keep the most specific. */
const OVERFLOW_PRIORITY = ['page-overflow', 'media-overflow', 'content-overflow'] as const;

function findingKey(f: Finding): string {
  return `${f.detector}|${f.element.selector}|${f.related?.selector ?? ''}`;
}

function severityScore(f: Finding): number {
  const e = f.evidence;
  if (typeof e.overflowPx === 'number') return e.overflowPx;
  if (typeof e.overlapWidth === 'number' && typeof e.overlapHeight === 'number') {
    return e.overlapWidth * e.overlapHeight;
  }
  if (typeof e.lines === 'number') return e.lines;
  return 0;
}

/**
 * Turns wrap line counts into findings. A row or label only counts as
 * unexpectedly wrapped when it sits on a single line at the widest width where
 * it is shown, and takes more lines at narrower widths.
 */
function wrapFindings(
  widths: number[],
  results: Map<number, AnalyzeResult>,
): Map<number, Finding[]> {
  const baseline = new Map<string, number>();
  for (let i = widths.length - 1; i >= 0; i--) {
    const r = results.get(widths[i] as number);
    for (const w of r?.wraps ?? []) {
      const key = `${w.kind}|${w.element.selector}`;
      if (!baseline.has(key)) baseline.set(key, w.lines);
    }
  }

  const out = new Map<number, Finding[]>();
  for (const width of widths) {
    const list: Finding[] = [];
    for (const w of results.get(width)?.wraps ?? []) {
      const base = baseline.get(`${w.kind}|${w.element.selector}`);
      if (base !== 1 || w.lines <= 1) continue;
      list.push({
        detector: 'unexpected-wrap',
        severity: 'warning',
        title:
          w.kind === 'row'
            ? `Row of ${w.items} items wraps onto ${w.lines} lines`
            : `Label wraps onto ${w.lines} lines`,
        element: w.element,
        evidence: { lines: w.lines, linesAtWidest: base, items: w.items },
        styles: {},
      });
    }
    out.set(width, list);
  }
  return out;
}

function dedupe(findings: Finding[]): Finding[] {
  const bestOverflow = new Map<string, number>();
  for (const f of findings) {
    const rank = OVERFLOW_PRIORITY.indexOf(f.detector as (typeof OVERFLOW_PRIORITY)[number]);
    if (rank === -1) continue;
    const prev = bestOverflow.get(f.element.selector);
    if (prev === undefined || rank < prev) bestOverflow.set(f.element.selector, rank);
  }
  return findings.filter((f) => {
    const rank = OVERFLOW_PRIORITY.indexOf(f.detector as (typeof OVERFLOW_PRIORITY)[number]);
    return rank === -1 || bestOverflow.get(f.element.selector) === rank;
  });
}

export function issueId(route: string, f: Finding): string {
  return createHash('sha1')
    .update(`${route}|${findingKey(f)}`)
    .digest('hex')
    .slice(0, 10);
}

/** Groups per-width findings into issues with inclusive width ranges. */
export function buildIssues(
  route: string,
  widths: number[],
  results: Map<number, AnalyzeResult>,
): Issue[] {
  const wraps = wrapFindings(widths, results);
  const perWidth = new Map<number, Map<string, Finding>>();
  for (const width of widths) {
    const all = dedupe([...(results.get(width)?.findings ?? []), ...(wraps.get(width) ?? [])]);
    perWidth.set(width, new Map(all.map((f) => [findingKey(f), f])));
  }

  const keys = new Set<string>();
  for (const m of perWidth.values()) for (const k of m.keys()) keys.add(k);

  const issues: Issue[] = [];
  for (const key of keys) {
    const ranges: WidthRange[] = [];
    let worst: { width: number; finding: Finding } | null = null;
    let open: WidthRange | null = null;

    for (const width of widths) {
      const f = perWidth.get(width)?.get(key);
      if (f) {
        if (open) open.to = width;
        else {
          open = { from: width, to: width };
          ranges.push(open);
        }
        if (!worst || severityScore(f) > severityScore(worst.finding))
          worst = { width, finding: f };
      } else {
        open = null;
      }
    }
    if (!worst) continue;

    const f = worst.finding;
    issues.push({
      id: issueId(route, f),
      detector: f.detector,
      severity: f.severity,
      title: f.title,
      ranges,
      worstAt: worst.width,
      element: { ...f.element, source: null },
      ...(f.related ? { related: f.related } : {}),
      evidence: f.evidence,
      styles: f.styles,
    });
  }

  const order = { error: 0, warning: 1, info: 2 };
  return issues.sort(
    (a, b) =>
      order[a.severity] - order[b.severity] || (a.ranges[0]?.from ?? 0) - (b.ranges[0]?.from ?? 0),
  );
}

/** Widths where the layout signature changes, compared with what the CSS declares. */
export function buildBreakpoints(
  widths: number[],
  results: Map<number, AnalyzeResult>,
  declared: number[],
  minWidth: number,
  maxWidth: number,
): Breakpoints {
  const observed: number[] = [];
  for (let i = 1; i < widths.length; i++) {
    const prev = results.get(widths[i - 1] as number);
    const cur = results.get(widths[i] as number);
    if (prev && cur && prev.signature !== cur.signature) observed.push(widths[i] as number);
  }
  const inRange = declared.filter((w) => w > minWidth && w <= maxWidth);
  return {
    observed,
    declared: inRange,
    unexplained: observed.filter((w) => !inRange.some((d) => Math.abs(d - w) <= 1)),
  };
}
