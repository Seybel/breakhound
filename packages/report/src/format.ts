import type {
  DetectorId,
  Issue,
  RouteResult,
  ScanResult,
  Severity,
  WidthRange,
} from '@breakhound/engine';

export const DETECTOR_LABELS: Record<DetectorId, string> = {
  'page-overflow': 'Horizontal overflow',
  'content-overflow': 'Content spills out',
  'media-overflow': 'Media too wide',
  overlap: 'Overlap',
  'unexpected-wrap': 'Unexpected wrap',
  'clipped-text': 'Clipped text',
  'squished-text': 'Squished text',
  'distorted-media': 'Distorted image',
  'small-tap-target': 'Small tap target',
  'tiny-text': 'Tiny text',
  'edge-gutter': 'No edge spacing',
  'viewport-meta': 'Viewport meta',
};

export const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

export function formatRange(r: WidthRange): string {
  return r.from === r.to ? `${r.from}px` : `${r.from}–${r.to}px`;
}

export function formatRanges(ranges: WidthRange[]): string {
  return ranges.map(formatRange).join(', ');
}

/** The same element breaking the same way on several routes (shared layouts, components). */
export interface IssueGroup {
  fingerprint: string;
  /** Representative issue: the one from the first route it appeared on. */
  issue: Issue;
  route: RouteResult;
  /** Every route this issue appears on, including the first. */
  routes: { route: RouteResult; issue: Issue }[];
}

export function groupIssues(result: ScanResult): IssueGroup[] {
  const groups = new Map<string, IssueGroup>();
  for (const route of result.routes) {
    for (const issue of route.issues) {
      const g = groups.get(issue.fingerprint);
      if (g) g.routes.push({ route, issue });
      else
        groups.set(issue.fingerprint, {
          fingerprint: issue.fingerprint,
          issue,
          route,
          routes: [{ route, issue }],
        });
    }
  }
  return [...groups.values()].sort(
    (a, b) =>
      SEVERITY_ORDER[a.issue.severity] - SEVERITY_ORDER[b.issue.severity] ||
      b.routes.length - a.routes.length ||
      (a.issue.ranges[0]?.from ?? 0) - (b.issue.ranges[0]?.from ?? 0),
  );
}

export function evidenceText(issue: Issue): string {
  return Object.entries(issue.evidence)
    .map(([k, v]) => `${k.replace(/([A-Z])/g, ' $1').toLowerCase()}: ${v}`)
    .join(', ');
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

export function routeLabel(route: RouteResult): string {
  return route.route || new URL(route.url).pathname;
}
