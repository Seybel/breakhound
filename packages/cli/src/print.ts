import { relative } from 'node:path';
import { styleText } from 'node:util';
import type { RouteResult, ScanResult, Severity } from '@breakhound/engine';
import { formatRanges, groupIssues } from '@breakhound/report';

const BADGE: Record<Severity, string> = {
  error: styleText('red', '✖ error  '),
  warning: styleText('yellow', '⚠ warning'),
  info: styleText('blue', 'ℹ info   '),
};

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** One line per page as soon as it has been scanned. */
export function printRouteLine(route: RouteResult, width: number): void {
  const label = route.route.padEnd(width);
  const time = styleText('dim', seconds(route.durationMs));
  if (route.status !== 'scanned') {
    console.log(
      `  ${styleText('red', '!')} ${label}  ${styleText('red', route.error ?? route.status)}  ${time}`,
    );
    return;
  }
  const redirected = new URL(route.finalUrl).pathname !== new URL(route.url).pathname;
  const bps = route.breakpoints.observed;
  const layout = bps.length ? `layout changes at ${bps.join(', ')}` : 'no layout changes';
  const note = redirected
    ? styleText('yellow', `  redirected to ${new URL(route.finalUrl).pathname}`)
    : '';
  if (route.issues.length === 0) {
    console.log(
      `  ${styleText('green', '✔')} ${label}  ${styleText('dim', `clean · ${layout}`)}  ${time}${note}`,
    );
  } else {
    const worst = route.issues.some((i) => i.severity === 'error') ? 'red' : 'yellow';
    console.log(
      `  ${styleText(worst, '✖')} ${label}  ${styleText(worst, plural(route.issues.length, 'issue'))}${styleText('dim', ` · ${layout}`)}  ${time}${note}`,
    );
  }
}

export function printIssues(result: ScanResult): void {
  const groups = groupIssues(result);
  if (!groups.length) {
    const pages = result.routes.filter((r) => r.status === 'scanned').length;
    if (pages) {
      console.log(
        `\n  ${styleText('green', `No responsive issues on ${plural(pages, 'page')} from ${result.settings.minWidth} to ${result.settings.maxWidth}px.`)}`,
      );
    }
    return;
  }
  const pages = new Set(groups.flatMap((g) => g.routes.map((r) => r.route.route))).size;
  console.log(
    `\n  ${styleText('bold', `${plural(groups.length, 'issue')} on ${plural(pages, 'page')}`)}\n`,
  );
  for (const g of groups) {
    const where = g.routes.map((r) => r.route.route).join(', ');
    console.log(
      `  ${BADGE[g.issue.severity]}  ${styleText('bold', formatRanges(g.issue.ranges).padEnd(14))} ${g.issue.title}`,
    );
    console.log(styleText('dim', `              ${g.issue.element.selector} · ${where}`));
    if (g.issue.suggestion) console.log(styleText('dim', `              → ${g.issue.suggestion}`));
  }
}

export function printFooter(
  paths: { html: string; prompt: string },
  result: ScanResult,
  cwd: string,
): void {
  const rel = (p: string) => {
    const r = relative(cwd, p);
    return r.startsWith('..') ? p : r;
  };
  console.log('');
  console.log(
    `  ${styleText('dim', 'Report')}  ${rel(paths.html)}  ${styleText('dim', '(breakhound report to open it)')}`,
  );
  if (result.summary.issues) {
    console.log(
      `  ${styleText('dim', 'Fix it')}  breakhound prompt --copy  ${styleText('dim', 'then paste into your coding agent')}`,
    );
  }
  console.log(styleText('dim', `  Done in ${seconds(result.durationMs)}`));
}
