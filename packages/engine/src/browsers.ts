import type { BrowserName, Issue, PageResult } from './types';

export const BROWSER_LABELS: Record<BrowserName, string> = {
  chromium: 'Chromium',
  webkit: 'WebKit',
  firefox: 'Firefox',
};

/**
 * Joins the scans of one page in several browsers. The same issue in two
 * browsers is one issue; one that shows in only some of them says which. The
 * first browser's breakpoints and details are kept.
 */
export function mergeBrowserResults(
  primary: PageResult,
  first: BrowserName,
  others: { browser: BrowserName; result: PageResult }[],
): PageResult {
  if (primary.status !== 'scanned' || !others.length) return primary;
  const scannedIn: BrowserName[] = [first];
  const issues: (Issue & { browsers: BrowserName[] })[] = primary.issues.map((i) => ({
    ...i,
    browsers: [first],
  }));
  const byId = new Map(issues.map((i) => [i.id, i]));
  const warnings = [...primary.warnings];
  let measurements = primary.measurements;
  let durationMs = primary.durationMs;

  for (const { browser, result } of others) {
    durationMs += result.durationMs;
    if (result.status !== 'scanned') {
      warnings.push(
        `Could not check it in ${BROWSER_LABELS[browser]}: ${result.error ?? result.status}`,
      );
      continue;
    }
    scannedIn.push(browser);
    measurements += result.measurements;
    for (const w of result.warnings) warnings.push(`${BROWSER_LABELS[browser]}: ${w}`);
    for (const issue of result.issues) {
      const known = byId.get(issue.id);
      if (known) {
        known.browsers.push(browser);
        continue;
      }
      const added = { ...issue, browsers: [browser] };
      byId.set(issue.id, added);
      issues.push(added);
    }
  }

  if (scannedIn.length === 1) return { ...primary, warnings, durationMs };
  for (const issue of issues) {
    if (issue.browsers.length < scannedIn.length) {
      issue.title += ` (only in ${issue.browsers.map((b) => BROWSER_LABELS[b]).join(' and ')})`;
    }
  }
  return { ...primary, issues, warnings, measurements, durationMs };
}
