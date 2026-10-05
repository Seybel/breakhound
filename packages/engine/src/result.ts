import type { BrowserName, RouteResult, ScanResult, Severity } from './types';

export interface ResultMeta {
  version: string;
  startedAt: Date;
  minWidth: number;
  maxWidth: number;
  step: number;
  framework?: string | null;
  baseUrl?: string | null;
  root?: string | null;
  browsers?: BrowserName[];
}

export function createScanResult(routes: RouteResult[], meta: ResultMeta): ScanResult {
  const bySeverity: Record<Severity, number> = { error: 0, warning: 0, info: 0 };
  const unique = new Set<string>();
  let issues = 0;
  for (const r of routes) {
    for (const issue of r.issues) {
      issues++;
      if (unique.has(issue.fingerprint)) continue;
      unique.add(issue.fingerprint);
      bySeverity[issue.severity]++;
    }
  }
  return {
    schemaVersion: 1,
    tool: { name: 'breakhound', version: meta.version },
    project: {
      framework: meta.framework ?? null,
      baseUrl: meta.baseUrl ?? null,
      root: meta.root ?? null,
    },
    startedAt: meta.startedAt.toISOString(),
    durationMs: Date.now() - meta.startedAt.getTime(),
    settings: {
      minWidth: meta.minWidth,
      maxWidth: meta.maxWidth,
      step: meta.step,
      browsers: meta.browsers ?? ['chromium'],
    },
    routes,
    summary: { routes: routes.length, issues, uniqueIssues: unique.size, bySeverity },
  };
}
