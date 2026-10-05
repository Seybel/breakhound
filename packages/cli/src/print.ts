import { relative } from 'node:path';
import { styleText } from 'node:util';
import type { RouteResult, ScanResult, Severity } from '@breakhound/engine';
import { formatRanges, groupIssues } from '@breakhound/report';
import { examplePath } from '@breakhound/routes';
import type { RoutePlan } from './app';

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
  if (route.status === 'login' || route.status === 'redirect' || route.status === 'skipped') {
    const mark = route.status === 'login' ? styleText('yellow', '○') : styleText('dim', '–');
    const reason =
      route.status === 'skipped'
        ? 'skipped: no real URL found for this dynamic route'
        : (route.error ?? route.status);
    console.log(
      `  ${mark} ${label}  ${styleText(route.status === 'login' ? 'yellow' : 'dim', reason)}`,
    );
    return;
  }
  if (route.status !== 'scanned') {
    console.log(
      `  ${styleText('red', '!')} ${label}  ${styleText('red', route.error ?? route.status)}  ${time}`,
    );
    return;
  }
  const requested = new URL(route.url).pathname;
  const redirected = new URL(route.finalUrl).pathname !== requested;
  const bps = route.breakpoints.observed;
  const opened = (route.states ?? []).map((s) => s.label);
  const layout =
    (bps.length ? `layout changes at ${bps.join(', ')}` : 'no layout changes') +
    (opened.length
      ? ` · opened ${opened.slice(0, 2).join(', ')}${opened.length > 2 ? ` +${opened.length - 2}` : ''}`
      : '');
  const note = redirected
    ? styleText('yellow', `  redirected to ${new URL(route.finalUrl).pathname}`)
    : route.route.includes('[') && requested !== route.route
      ? styleText('dim', `  as ${requested}`)
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
  for (const w of route.warnings) console.log(styleText('yellow', `    ⚠ ${w}`));
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
  // The prompt leaves info-level issues out unless asked, so only offer it when it has something.
  if (result.summary.bySeverity.error + result.summary.bySeverity.warning > 0) {
    console.log(
      `  ${styleText('dim', 'Fix it')}  breakhound prompt --copy  ${styleText('dim', 'then paste into your coding agent')}`,
    );
    console.log(
      `  ${styleText('dim', '    or')}  breakhound mcp install  ${styleText('dim', 'so your agent can scan, verify and undo by itself')}`,
    );
  }
  console.log(styleText('dim', `  Done in ${seconds(result.durationMs)}`));
}

function plural2(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** What was found before scanning starts. */
export function printDiscovery(plan: RoutePlan, max: number): void {
  if (plan.crawl) {
    console.log(
      `${styleText('yellow', '•')} No route list found for this app, so breakhound follows links from / (up to ${max} pages)`,
    );
    return;
  }
  if (!plan.from) return;
  const dynamic = plan.patterns.filter((p) => p.dynamic).length;
  const extra = [
    dynamic ? `${dynamic} dynamic, filled in from links on your pages` : '',
    plan.filtered ? `${plan.filtered} left out by include, exclude or maxRoutes` : '',
  ].filter(Boolean);
  console.log(
    `${styleText('green', '✔')} ${plural2(plan.patterns.length, 'route', 'routes')} from ${plan.from}${extra.length ? styleText('dim', ` (${extra.join('; ')})`) : ''}`,
  );
}

/** Pages that weren't scanned on purpose, and how to get them scanned. */
export function printNotes(result: ScanResult, hasSavedLogin: boolean): void {
  const login = result.routes.filter((r) => r.status === 'login').length;
  const skipped = result.routes.filter((r) => r.status === 'skipped');
  if (!login && !skipped.length) return;
  console.log('');
  if (login) {
    const how = hasSavedLogin
      ? 'Your saved login may have expired: run breakhound login again, then scan.'
      : 'Run breakhound login once to sign in, then scan again.';
    console.log(
      `  ${styleText('yellow', '○')} ${plural2(login, 'page needs', 'pages need')} a login. ${how}`,
    );
  }
  if (skipped.length) {
    console.log(
      `  ${styleText('dim', '–')} ${plural2(skipped.length, 'dynamic route', 'dynamic routes')} had no link to follow. Give each a real URL with samples in your config, e.g.`,
    );
    const first = skipped[0]?.route;
    if (first)
      console.log(styleText('dim', `     samples: { '${first}': '${examplePath(first)}' }`));
  }
}
