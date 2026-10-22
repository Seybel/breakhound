import type {
  DetectorId,
  Issue,
  PageState,
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
  calendar: 'Calendar too narrow',
  'distorted-media': 'Distorted image',
  'small-tap-target': 'Small tap target',
  'tiny-text': 'Tiny text',
  'oversized-text': 'Oversized text',
  'edge-gutter': 'No edge spacing',
  'viewport-meta': 'Viewport meta',
  vision: 'Looks off',
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

/** How to get the page into the state an issue needs: click `button.burger` ("Menu"). */
export function openInstruction(state: PageState): string {
  const verb = state.kind === 'details' ? 'expand' : 'click';
  const name = state.label !== state.kind ? ` ("${state.label}")` : '';
  return `${verb} \`${state.trigger}\`${name}`;
}

/** "Open main menu" menu, "Contact us" dialog. */
export function stateName(state: PageState): string {
  const kind = state.kind === 'disclosure' || state.kind === 'details' ? 'section' : state.kind;
  return state.label !== state.kind ? `"${state.label}" ${kind}` : kind;
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

export function routeLabel(route: RouteResult): string {
  return route.route || new URL(route.url).pathname;
}

/**
 * What to add to the config for the dynamic routes no link fitted: values for the parameters
 * nothing gave one (named in the route's reason), or else a real URL for the first route.
 */
export function leftOutHint(
  routes: { route: string; status: string; error?: string }[],
): string | null {
  const skipped = routes.filter((r) => r.status === 'skipped');
  if (!skipped.length) return null;
  const names = new Set<string>();
  for (const r of skipped) {
    const named = r.error?.match(/nothing gives (.+) a value/)?.[1] ?? '';
    for (const m of named.matchAll(/\[([^\]]+)\]/g)) names.add(m[1] as string);
  }
  // A name like post-id needs quotes to be a valid key.
  const key = (n: string) => (/^[A-Za-z_$][\w$]*$/.test(n) ? n : `'${n}'`);
  if (names.size) return `params: { ${[...names].map((n) => `${key(n)}: '1'`).join(', ')} }`;
  const first = (skipped[0] as { route: string }).route;
  const example = first.replace(/\[\[?\.\.\.[^\]]+\]\]?/g, 'a/b').replace(/\[\[?[^\]]+\]\]?/g, '1');
  return `samples: { '${first}': '${example}' }`;
}
