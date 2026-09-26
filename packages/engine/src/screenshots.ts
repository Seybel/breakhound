import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'playwright';
import { settleResize } from './settle';
import type { Issue } from './types';

/** Detectors whose problem is about the screen edge, so the edge is drawn in. */
const EDGE_DETECTORS = new Set(['page-overflow', 'edge-gutter']);

/**
 * Captures one image per issue at the width where it is worst, with the blamed
 * element outlined in red, the related element in amber, and the screen edge
 * marked for overflow issues. Returns issue id -> file name.
 */
export async function captureIssues(
  page: Page,
  issues: Issue[],
  dir: string,
  opts: { height: number; maxSettleMs: number; limit: number },
): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  if (issues.length === 0) return files;
  mkdirSync(dir, { recursive: true });

  for (const issue of issues.slice(0, opts.limit)) {
    if (issue.detector === 'viewport-meta') continue;
    await page.setViewportSize({ width: issue.worstAt, height: opts.height });
    await settleResize(page, opts.maxSettleMs);
    const region = await page.evaluate((o) => window.__breakhound?.highlight(o) ?? null, {
      selector: issue.element.selector,
      related: issue.related?.selector ?? null,
      showEdge: EDGE_DETECTORS.has(issue.detector),
      pad: 80,
      maxHeight: 900,
    });
    if (region) {
      const file = `${issue.id}.png`;
      try {
        await page.screenshot({ path: join(dir, file), clip: region, fullPage: true });
        files.set(issue.id, file);
      } catch {
        // A screenshot failing should never fail the scan.
      }
    }
    await page.evaluate(() => window.__breakhound?.clearHighlights());
  }
  return files;
}
