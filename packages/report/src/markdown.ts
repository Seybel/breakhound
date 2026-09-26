import type { Issue, RouteResult, ScanResult, Severity } from '@breakhound/engine';
import {
  DETECTOR_LABELS,
  evidenceText,
  formatRanges,
  groupIssues,
  type IssueGroup,
  plural,
  routeLabel,
  SEVERITY_ORDER,
} from './format';

const SEVERITY_ICON: Record<Severity, string> = { error: '✖', warning: '⚠', info: 'ℹ' };

function headline(result: ScanResult): string {
  const { summary, settings } = result;
  const s = summary.bySeverity;
  const counts = [
    s.error ? plural(s.error, 'error') : '',
    s.warning ? plural(s.warning, 'warning') : '',
    s.info ? `${s.info} info` : '',
  ]
    .filter(Boolean)
    .join(', ');
  const found = summary.issues
    ? `${plural(summary.uniqueIssues, 'issue')} (${counts})`
    : 'no issues';
  return `Scanned ${plural(summary.routes, 'page')} from ${settings.minWidth}px to ${settings.maxWidth}px and found ${found}.`;
}

function routeStatus(route: RouteResult): string | null {
  if (route.status === 'scanned') return null;
  return route.status === 'empty' ? `rendered nothing: ${route.error}` : `failed: ${route.error}`;
}

function alsoOn(group: IssueGroup): string {
  return group.routes.length > 1
    ? group.routes
        .slice(1)
        .map((r) => routeLabel(r.route))
        .join(', ')
    : '';
}

/** Keeps a value from ending a Markdown table cell early. */
function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

/** One line per unique issue: quick to scan, easy to paste into a ticket. */
export function renderSummary(result: ScanResult): string {
  const lines = ['# Responsive report', '', headline(result), ''];
  const groups = groupIssues(result);
  if (groups.length) {
    lines.push('| | Widths | Issue | Element | Pages |', '|---|---|---|---|---|');
    for (const g of groups) {
      const pages = g.routes.map((r) => routeLabel(r.route)).join(', ');
      lines.push(
        `| ${SEVERITY_ICON[g.issue.severity]} | ${formatRanges(g.issue.ranges)} | ${cell(g.issue.title)} | \`${cell(g.issue.element.selector)}\` | ${cell(pages)} |`,
      );
    }
    lines.push('');
  }
  const failed = result.routes.filter((r) => r.status !== 'scanned');
  if (failed.length) {
    lines.push('## Pages that could not be checked', '');
    for (const r of failed) lines.push(`- ${routeLabel(r)}: ${routeStatus(r)}`);
    lines.push('');
  }
  return lines.join('\n');
}

function issueBlock(
  issue: Issue,
  heading: string,
  extra: string[],
  imageBase: string | null,
): string[] {
  const lines = [heading, ''];
  lines.push(`- **Widths:** ${formatRanges(issue.ranges)} (worst at ${issue.worstAt}px)`);
  lines.push(`- **Element:** \`${issue.element.selector}\` (${issue.element.path})`);
  if (issue.related) lines.push(`- **Related element:** \`${issue.related.selector}\``);
  lines.push(`- **HTML:** \`${issue.element.html.replace(/`/g, "'")}\``);
  if (Object.keys(issue.evidence).length) lines.push(`- **Evidence:** ${evidenceText(issue)}`);
  const styles = Object.entries(issue.styles);
  if (styles.length)
    lines.push(`- **Computed styles:** ${styles.map(([k, v]) => `${k}: ${v}`).join('; ')}`);
  if (issue.suggestion) lines.push(`- **Likely fix:** ${issue.suggestion}`);
  lines.push(...extra);
  if (imageBase !== null && issue.screenshot) {
    lines.push('', `![${issue.title}](${imageBase}${issue.screenshot})`);
  }
  lines.push('');
  return lines;
}

/** Every issue with its evidence and screenshot, grouped by page. */
export function renderDetailed(result: ScanResult, imageBase = 'screenshots/'): string {
  const lines = ['# Responsive report', '', headline(result), ''];
  lines.push(
    `Generated ${new Date(result.startedAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })} by breakhound ${result.tool.version}.`,
    '',
  );
  for (const route of result.routes) {
    lines.push(`## ${routeLabel(route)}`, '', `<${route.url}>`, '');
    const status = routeStatus(route);
    if (status) {
      lines.push(`This page ${status}`, '');
      continue;
    }
    const bp = route.breakpoints;
    lines.push(
      `Layout changes at: ${bp.observed.length ? bp.observed.map((w) => `${w}px`).join(', ') : 'none'}` +
        (bp.unexplained.length
          ? ` (no media query explains ${bp.unexplained.map((w) => `${w}px`).join(', ')})`
          : ''),
      '',
    );
    for (const w of route.warnings ?? []) lines.push(`> ${w}`, '');
    if (!route.issues.length) {
      lines.push('No issues found.', '');
      continue;
    }
    route.issues.forEach((issue, i) => {
      lines.push(
        ...issueBlock(
          issue,
          `### ${i + 1}. ${SEVERITY_ICON[issue.severity]} ${issue.title}`,
          [`- **Check:** ${DETECTOR_LABELS[issue.detector]} (\`${issue.detector}\`)`],
          imageBase,
        ),
      );
    });
  }
  return lines.join('\n');
}

export interface PromptOptions {
  /** Only include these severities (default: error and warning). */
  severities?: Severity[];
  /** Only include issues with these fingerprints (for "copy this issue"). */
  fingerprints?: string[];
  /** Command the agent should run to check its work. */
  verifyCommand?: string;
}

/**
 * Instructions a coding agent can act on in one go: concrete widths, the
 * element, the numbers, the likely fix, every page it affects, and how to
 * confirm the fix without breaking other widths.
 */
export function renderPrompt(result: ScanResult, options: PromptOptions = {}): string {
  const severities = new Set(options.severities ?? ['error', 'warning']);
  const only = options.fingerprints ? new Set(options.fingerprints) : null;
  const groups = groupIssues(result).filter(
    (g) => severities.has(g.issue.severity) && (!only || only.has(g.fingerprint)),
  );
  const { minWidth, maxWidth } = result.settings;

  const lines = [
    '# Fix these responsive layout issues',
    '',
    `Each issue below was measured in a real browser by resizing the page from ${minWidth}px to ${maxWidth}px. Widths are viewport widths in CSS pixels and are exact.`,
    '',
    'Rules:',
    '- Fix the cause in the source code (styles, markup or component), not by hiding the symptom with overflow: hidden.',
    '- Keep the layout the same at widths that are not listed.',
    '- Shared components may be the cause of issues listed on several pages; fix them once.',
  ];
  if (options.verifyCommand) {
    lines.push(
      `- When you are done, run \`${options.verifyCommand}\` and keep going until it reports no remaining issues and no new ones.`,
    );
  }
  lines.push('');

  if (!groups.length) {
    lines.push('No issues to fix.');
    return lines.join('\n');
  }

  groups
    .sort((a, b) => SEVERITY_ORDER[a.issue.severity] - SEVERITY_ORDER[b.issue.severity])
    .forEach((g, i) => {
      const pages = alsoOn(g);
      lines.push(
        ...issueBlock(
          g.issue,
          `## ${i + 1}. [${g.issue.severity}] ${g.issue.title}`,
          [
            `- **Page:** ${routeLabel(g.route)} (${g.route.url})`,
            ...(pages ? [`- **Also on:** ${pages}`] : []),
          ],
          null,
        ),
      );
    });
  return lines.join('\n');
}
