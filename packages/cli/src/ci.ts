import { appendFileSync, readFileSync } from 'node:fs';
import type { ScanResult, Severity } from '@breakhound/engine';
import { formatRanges, groupIssues } from '@breakhound/report';

export function isCI(): boolean {
  const ci = process.env.CI;
  return Boolean(ci && ci !== 'false' && ci !== '0');
}

const LEVEL: Record<Severity, string> = { error: 'error', warning: 'warning', info: 'notice' };

function escapeData(text: string): string {
  return text.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
}

function escapeProperty(text: string): string {
  return escapeData(text).replaceAll(':', '%3A').replaceAll(',', '%2C');
}

/**
 * On GitHub Actions: one annotation per unique issue on the run's summary
 * page, and the Markdown summary added to the job summary.
 */
export function reportToGitHub(result: ScanResult, summaryFile: string): void {
  if (process.env.GITHUB_ACTIONS !== 'true') return;
  for (const g of groupIssues(result)) {
    const where = g.routes.map((r) => r.route.route).join(', ');
    const message = `${formatRanges(g.issue.ranges)} on ${where}: ${g.issue.element.selector}${g.issue.suggestion ? `\n${g.issue.suggestion}` : ''}`;
    console.log(
      `::${LEVEL[g.issue.severity]} title=${escapeProperty(`breakhound: ${g.issue.title}`)}::${escapeData(message)}`,
    );
  }
  for (const r of result.routes) {
    if (r.status === 'error' || r.status === 'empty') {
      console.log(
        `::error title=${escapeProperty(`breakhound: ${r.route} wasn't checked`)}::${escapeData(r.error ?? r.status)}`,
      );
    }
  }
  const stepSummary = process.env.GITHUB_STEP_SUMMARY;
  if (stepSummary) {
    try {
      appendFileSync(stepSummary, `${readFileSync(summaryFile, 'utf8')}\n`);
    } catch {
      // The summary is a nice extra; the scan result stands without it.
    }
  }
}
