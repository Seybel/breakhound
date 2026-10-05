import { createHash } from 'node:crypto';
import type { AnalyzeResult, Finding } from '@breakhound/analyzers';
import type { Breakpoints, Issue, WidthRange } from './types';

/**
 * Detectors whose findings are only responsive bugs if they appear at narrower
 * widths. Present at the widest width means the design does it on purpose
 * (a teaser that fades into "read more", for example).
 */
const DESIGNED_IF_AT_WIDEST = new Set(['clipped-text']);
const FIXED_WIDTH_DETECTORS = new Set(['page-overflow', 'content-overflow']);

/** When several overflow detectors blame the same element, keep the most specific. */
const OVERFLOW_PRIORITY = ['page-overflow', 'media-overflow', 'content-overflow'] as const;

/**
 * Findings that group several elements under one container name one member as
 * `related` just as an example. That example can change from width to width,
 * so it is not part of what makes the finding the same issue.
 */
const RELATED_IS_EXAMPLE = new Set(['clipped-text', 'small-tap-target', 'tiny-text']);

/** Signature of a width where the state being scanned (a menu open) couldn't be reached. */
export const INACTIVE = 'inactive';

/** Identity of a finding across widths, tabs and (with the route) scans. */
export function findingKey(f: Finding): string {
  const related = RELATED_IS_EXAMPLE.has(f.detector) ? '' : (f.related?.selector ?? '');
  return `${f.detector}|${f.element.selector}|${related}`;
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
        suggestion:
          w.kind === 'row'
            ? 'Collapse this row into a menu below this width, tighten its spacing, or let it scroll sideways.'
            : 'Shorten the label, reduce its padding, or give the button room to grow at this width.',
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

  const widest = [...widths].reverse().find((w) => results.get(w)?.signature !== INACTIVE);
  const issues: Issue[] = [];
  const lineages = new Map<Issue, string[]>();
  for (const key of keys) {
    const ranges: WidthRange[] = [];
    let worst: { width: number; finding: Finding } | null = null;
    let open: WidthRange | null = null;
    const elementWidths = new Set<number>();

    const atWidest = widest !== undefined ? perWidth.get(widest)?.get(key) : undefined;
    if (atWidest && DESIGNED_IF_AT_WIDEST.has(atWidest.detector)) continue;

    for (const width of widths) {
      const f = perWidth.get(width)?.get(key);
      if (f) {
        if (typeof f.evidence.elementWidth === 'number') elementWidths.add(f.evidence.elementWidth);
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
    let evidence = f.evidence;
    let suggestion = f.suggestion;
    // Same width everywhere it overflows: the element has a hard-coded size.
    const spansWidths = ranges.some((r) => r.to > r.from);
    const [onlyWidth] = elementWidths;
    if (
      FIXED_WIDTH_DETECTORS.has(f.detector) &&
      elementWidths.size === 1 &&
      spansWidths &&
      onlyWidth !== undefined &&
      !f.evidence.causedByText
    ) {
      evidence = { ...evidence, fixedWidthPx: onlyWidth };
      suggestion = `It stays ${onlyWidth}px wide no matter the screen size. Replace the fixed width with max-width: 100% (or a fluid width) so it can shrink.`;
    }

    const issue: Issue = {
      id: issueId(route, f),
      fingerprint: findingKey(f),
      detector: f.detector,
      severity: f.severity,
      title: f.title,
      ranges,
      worstAt: worst.width,
      element: { ...f.element, source: f.element.source ?? null },
      ...(f.related ? { related: f.related } : {}),
      evidence,
      styles: f.styles,
      ...(suggestion ? { suggestion } : {}),
    };
    issues.push(issue);
    if (f.lineage) lineages.set(issue, f.lineage);
  }

  const order = { error: 0, warning: 1, info: 2 };
  return mergeRepeats(mergeOverflowFamily(issues, lineages)).sort(
    (a, b) =>
      order[a.severity] - order[b.severity] || (a.ranges[0]?.from ?? 0) - (b.ranges[0]?.from ?? 0),
  );
}

/** Joins ranges that touch or overlap into one. */
function joinRanges(ranges: WidthRange[]): WidthRange[] {
  const sorted = [...ranges].sort((a, b) => a.from - b.from);
  const out: WidthRange[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.from <= last.to + 1) last.to = Math.max(last.to, r.to);
    else out.push({ ...r });
  }
  return out;
}

/**
 * One element can be reported by several overflow detectors at different
 * widths (an image that makes the page scroll below 516px and only spills out
 * of its column up to 530px). That's one problem with one fix, so it becomes
 * one issue covering all of those widths, keeping the most severe details.
 */
function mergeOverflowFamily(issues: Issue[], lineages: Map<Issue, string[]>): Issue[] {
  const family = new Set<string>(OVERFLOW_PRIORITY);
  const byElement = new Map<string, Issue[]>();
  const out: Issue[] = [];
  const leads: Issue[] = [];
  for (const issue of issues) {
    if (!family.has(issue.detector)) {
      out.push(issue);
      continue;
    }
    const list = byElement.get(issue.element.selector);
    if (list) list.push(issue);
    else byElement.set(issue.element.selector, [issue]);
  }
  for (const list of byElement.values()) {
    const [lead, ...rest] = list.sort(
      (a, b) =>
        OVERFLOW_PRIORITY.indexOf(a.detector as (typeof OVERFLOW_PRIORITY)[number]) -
        OVERFLOW_PRIORITY.indexOf(b.detector as (typeof OVERFLOW_PRIORITY)[number]),
    );
    if (!lead) continue;
    if (rest.length) {
      lead.ranges = joinRanges(list.flatMap((i) => i.ranges));
      lead.evidence = { ...lead.evidence, alsoReportedAs: rest.map((i) => i.detector).join(', ') };
      if (!lead.related) {
        const withRelated = rest.find((i) => i.related);
        if (withRelated?.related) lead.related = withRelated.related;
      }
      const lineage = rest.map((i) => lineages.get(i)).find(Boolean);
      if (!lineages.has(lead) && lineage) lineages.set(lead, lineage);
    }
    leads.push(lead);
  }
  return [...out, ...mergeNested(leads, lineages)];
}

/** A selector with its position indexes removed: every card in a list gets the same template. */
function selectorTemplate(selector: string): string {
  return selector.replace(/:nth-(?:of-type|child)\(\d+\)/g, '');
}

/**
 * The same problem on each copy of a repeated element (every card in a list,
 * every row of a menu) is one fix in one component, so it's one issue that
 * says how many places it shows up in.
 */
function mergeRepeats(issues: Issue[]): Issue[] {
  const groups = new Map<string, Issue[]>();
  const out: Issue[] = [];
  for (const issue of issues) {
    const template = selectorTemplate(issue.element.selector);
    if (template === issue.element.selector) {
      out.push(issue);
      continue;
    }
    // Titles carry measurements that differ a little between copies.
    const key = `${issue.detector}|${template}|${issue.title.replace(/\d+/g, '#')}`;
    const list = groups.get(key);
    if (list) list.push(issue);
    else groups.set(key, [issue]);
  }
  for (const list of groups.values()) {
    const [lead, ...rest] = list;
    if (!lead) continue;
    const alike = rest.filter((i) => touches(i.ranges, lead.ranges));
    out.push(...rest.filter((i) => !alike.includes(i)));
    if (alike.length) {
      const count = alike.length + 1;
      lead.ranges = joinRanges([lead, ...alike].flatMap((i) => i.ranges));
      lead.title = `${lead.title} (${count} places)`;
      lead.evidence = { ...lead.evidence, similarElements: count };
    }
    out.push(lead);
  }
  return out;
}

function touches(a: WidthRange[], b: WidthRange[]): boolean {
  return a.some((x) => b.some((y) => x.from <= y.to + 1 && y.from <= x.to + 1));
}

/**
 * As the screen narrows, the outermost element sticking out changes: first a
 * fixed-width input, then the row holding it, then the form. Those are one
 * problem, so inner elements are folded into the outermost one when their
 * widths meet, and named in the evidence as places to look.
 */
function mergeNested(leads: Issue[], lineages: Map<Issue, string[]>): Issue[] {
  const bySelector = new Map(leads.map((i) => [i.element.selector, i]));
  const inner = new Map<Issue, string[]>();
  const absorbed = new Set<Issue>();
  const deepestFirst = [...leads].sort(
    (a, b) => (lineages.get(b)?.length ?? 0) - (lineages.get(a)?.length ?? 0),
  );
  const rank = { error: 0, warning: 1, info: 2 };
  for (const issue of deepestFirst) {
    for (const selector of lineages.get(issue) ?? []) {
      const outer = bySelector.get(selector);
      if (!outer || outer === issue || absorbed.has(outer)) continue;
      if (!touches(issue.ranges, outer.ranges)) continue;
      outer.ranges = joinRanges([...outer.ranges, ...issue.ranges]);
      if (rank[issue.severity] < rank[outer.severity]) outer.severity = issue.severity;
      inner.set(outer, [
        ...(inner.get(outer) ?? []),
        issue.element.selector,
        ...(inner.get(issue) ?? []),
      ]);
      absorbed.add(issue);
      break;
    }
  }
  for (const [outer, selectors] of inner) {
    outer.evidence = { ...outer.evidence, alsoOverflowing: selectors.join(', ') };
  }
  return leads.filter((i) => !absorbed.has(i));
}

/**
 * Widths where the layout signature changes, compared with what the CSS
 * declares. Each tab loaded the page separately and dynamic content can differ
 * between loads, so layouts are only compared within the tab that measured them.
 */
export function buildBreakpoints(
  tabs: Map<number, AnalyzeResult>[],
  declared: number[],
  minWidth: number,
  maxWidth: number,
): Breakpoints {
  const found = new Set<number>();
  for (const results of tabs) {
    const widths = [...results.keys()].sort((a, b) => a - b);
    for (let i = 1; i < widths.length; i++) {
      const prev = results.get(widths[i - 1] as number);
      const cur = results.get(widths[i] as number);
      if (prev && cur && prev.signature !== cur.signature) found.add(widths[i] as number);
    }
  }
  const observed = [...found].sort((a, b) => a - b);
  const inRange = declared.filter((w) => w > minWidth && w <= maxWidth);
  return {
    observed,
    declared: inRange,
    unexplained: observed.filter((w) => !inRange.some((d) => Math.abs(d - w) <= 1)),
  };
}
