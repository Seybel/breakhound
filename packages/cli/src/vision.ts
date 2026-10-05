import { createHash } from 'node:crypto';
import {
  captureIssues,
  type ElementInfo,
  type Issue,
  type RouteResult,
  type Scanner,
  settleResize,
} from '@breakhound/engine';
import type { ModelClient } from './model';

/**
 * Optional, with the developer's own vision model: screenshots of each page at
 * a phone, tablet and laptop width, and what the model says looks off. It
 * catches what rules can't (cramped, awkward, unbalanced), but a model's
 * opinion isn't a measurement, so these are only ever info-level suggestions
 * and verify leaves them out.
 */

export const VISION_WIDTHS = [375, 768, 1280];
/** Tall pages are cut here: the top of the page is where most layout lives, and images cost tokens. */
const MAX_SHOT_HEIGHT = 1800;
const MAX_PER_PAGE = 5;

const SYSTEM = `You review screenshots of one web page at several screen widths, looking for responsive layout problems a person would notice: content that is cramped, cut off, overlapping, misaligned, oddly wrapped, too small to read or tap, or surrounded by awkward empty space at that width.

Only report clear problems, not matters of taste. If the page looks fine, reply []. Reply with only a JSON array, at most ${MAX_PER_PAGE} items, each:
{"width": <the screen width it shows at>, "problem": "<short, specific title>", "text": "<a few words of visible text in or right next to the problem, copied exactly>", "fix": "<one sentence on a likely CSS fix>"}`;

export interface VisionFinding {
  width: number;
  problem: string;
  text?: string;
  fix?: string;
}

/** The JSON array in a model's reply, keeping only well-formed items at widths that were shown. */
export function parseVision(reply: string, widths: number[]): VisionFinding[] {
  const start = reply.indexOf('[');
  const end = reply.lastIndexOf(']');
  if (start === -1 || end < start) return [];
  let data: unknown;
  try {
    data = JSON.parse(reply.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const out: VisionFinding[] = [];
  for (const item of data as Record<string, unknown>[]) {
    const width = Number(item?.width);
    if (typeof item?.problem !== 'string' || !item.problem.trim() || !widths.includes(width))
      continue;
    out.push({
      width,
      problem: item.problem.trim().slice(0, 120),
      ...(typeof item.text === 'string' && item.text.trim()
        ? { text: item.text.trim().slice(0, 80) }
        : {}),
      ...(typeof item.fix === 'string' && item.fix.trim()
        ? { fix: item.fix.trim().slice(0, 300) }
        : {}),
    });
    if (out.length >= MAX_PER_PAGE) break;
  }
  return out;
}

const PAGE: ElementInfo = { selector: 'body', path: 'body', html: '<body>', text: null };

export interface VisionOptions {
  widths: number[];
  height: number;
  screenshotDir?: string;
}

/** Shows the model one page at each width, and turns what it noticed into info-level issues. */
export async function lookAtPage(
  scanner: Scanner,
  route: RouteResult,
  model: ModelClient,
  opts: VisionOptions,
): Promise<Issue[]> {
  return scanner.visit(route.url, async (page) => {
    const images = [];
    for (const width of opts.widths) {
      await page.setViewportSize({ width, height: opts.height });
      await settleResize(page, 1000);
      const height = await page.evaluate(() => document.documentElement.scrollHeight);
      const shot = await page.screenshot({
        type: 'jpeg',
        quality: 70,
        fullPage: true,
        clip: {
          x: 0,
          y: 0,
          width,
          height: Math.min(Math.max(height, opts.height), MAX_SHOT_HEIGHT),
        },
      });
      images.push({ mediaType: 'image/jpeg' as const, data: shot.toString('base64') });
    }
    const reply = await model.complete(
      SYSTEM,
      `The page ${route.route}, at ${opts.widths.map((w) => `${w}px`).join(', ')} wide, in that order.`,
      images,
    );

    const issues: Issue[] = [];
    for (const f of parseVision(reply, opts.widths)) {
      await page.setViewportSize({ width: f.width, height: opts.height });
      await settleResize(page, 1000);
      const found = f.text
        ? await page.evaluate((t) => window.__breakhound?.findByText(t) ?? null, f.text)
        : null;
      const element = found ?? PAGE;
      const key = `vision|${element.selector}|${f.problem}`;
      issues.push({
        id: createHash('sha1')
          .update(`${route.route}|${key}|${f.width}`)
          .digest('hex')
          .slice(0, 10),
        fingerprint: `${route.route}|${key}`,
        detector: 'vision',
        severity: 'info',
        title: f.problem,
        ranges: [{ from: f.width, to: f.width }],
        worstAt: f.width,
        element: { ...element, source: element.source ?? null },
        evidence: { seenBy: model.model, ...(f.text ? { near: f.text } : {}) },
        styles: {},
        ...(f.fix ? { suggestion: f.fix } : {}),
      });
    }
    if (opts.screenshotDir && issues.length) {
      const files = await captureIssues(page, issues, opts.screenshotDir, {
        height: opts.height,
        maxSettleMs: 1000,
        limit: issues.length,
      });
      for (const issue of issues) {
        const file = files.get(issue.id);
        if (file) issue.screenshot = file;
      }
    }
    return issues;
  });
}
