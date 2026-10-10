import type {
  AnalyzeOptions,
  AnalyzeResult,
  HighlightOptions,
  Region,
} from '@breakhound/analyzers';
import { findingKey, INACTIVE } from './issues';
import { type SweepPage, settleResize } from './settle';
import type { Issue } from './types';

export type { SweepPage };

export type Measurements = Map<number, AnalyzeResult>;

export interface SweepSettings {
  minWidth: number;
  maxWidth: number;
  height: number;
  maxSettleMs: number;
  analyze: AnalyzeOptions;
  /**
   * `breadth` (default) bisects every change a little at a time, so running
   * out of budget leaves all of them roughly located. `ascending` settles each
   * change before moving on, so the page only ever grows, a few pixels at a
   * time: what someone watching the tab (the DevTools panel) wants to see.
   */
  order?: 'breadth' | 'ascending';
  /** Called with every width measured for the sweep, as it is measured. */
  onMeasure?: (width: number, result: AnalyzeResult) => void;
}

/**
 * Puts the page in the state being scanned (a menu open) at the current width.
 * False when that state can't be reached there, e.g. the menu button is hidden.
 */
export type Prepare = (width: number) => Promise<boolean>;

/** Coarse widths from min to max (inclusive), `step` apart. */
export function coarseWidths(minWidth: number, maxWidth: number, step: number): number[] {
  const out: number[] = [];
  for (let w = minWidth; w < maxWidth; w += step) out.push(w);
  out.push(maxWidth);
  return out;
}

/**
 * Splits the coarse widths into contiguous chunks, one per worker. Neighbouring
 * chunks share their boundary width so every interval is refined by someone.
 */
export function splitWidths(coarse: number[], workers: number): number[][] {
  const n = Math.max(1, Math.min(workers, Math.floor(coarse.length / 4)));
  if (n === 1) return [coarse];
  const size = Math.ceil((coarse.length - 1) / n);
  const chunks: number[][] = [];
  for (let i = 0; i < coarse.length - 1; i += size) chunks.push(coarse.slice(i, i + size + 1));
  return chunks;
}

/**
 * Extra widths one tab may measure per coarse width while bisecting. Real pages
 * use well under one; a page whose layout keeps changing on its own would
 * otherwise be bisected down to every single pixel.
 */
const REFINE_BUDGET_PER_WIDTH = 6;

/** Everything that, if it changes between two widths, is worth locating to the pixel. */
export function stateKey(r: AnalyzeResult): string {
  const findings = r.findings.map(findingKey).sort().join(',');
  const wraps = r.wraps
    .map((w) => `${w.kind}|${w.element.selector}|${w.lines}`)
    .sort()
    .join(',');
  return `${r.signature}#${findings}#${wraps}#${r.containers ?? ''}`;
}

export class Sweeper {
  readonly results: Measurements = new Map();
  /**
   * True when the page's layout changed while nobody resized it (an
   * auto-playing carousel, live data): measuring the same width twice
   * disagreed, or bisection ran out of budget chasing changes.
   */
  unstable = false;
  private readonly keys = new Map<number, string>();

  constructor(
    readonly page: SweepPage,
    private readonly settings: SweepSettings,
    private readonly prepare?: Prepare,
  ) {}

  async measure(width: number): Promise<AnalyzeResult> {
    const cached = this.results.get(width);
    if (cached) return cached;
    const result = await this.analyzeAt(width);
    this.results.set(width, result);
    this.keys.set(width, stateKey(result));
    this.settings.onMeasure?.(width, result);
    return result;
  }

  private async analyzeAt(width: number): Promise<AnalyzeResult> {
    await this.page.setViewportSize({ width, height: this.settings.height });
    await settleResize(this.page, this.settings.maxSettleMs);
    return this.analyzeHere(width);
  }

  private async analyzeHere(width: number): Promise<AnalyzeResult> {
    if (this.prepare && !(await this.prepare(width))) {
      return { width, findings: [], wraps: [], signature: INACTIVE };
    }
    return this.page.evaluate((opts) => {
      const api = window.__breakhound;
      if (!api) throw new Error('breakhound analyzers were not injected into the page');
      return api.analyze(opts);
    }, this.settings.analyze);
  }

  /** Measures a width from a different starting layout without touching the cache. */
  async probe(width: number): Promise<AnalyzeResult> {
    const { minWidth, maxWidth, height } = this.settings;
    const away = width - minWidth > maxWidth - width ? minWidth : maxWidth;
    await this.page.setViewportSize({ width: away, height });
    await settleResize(this.page, this.settings.maxSettleMs);
    await this.page.setViewportSize({ width, height });
    await settleResize(this.page, this.settings.maxSettleMs);
    return this.analyzeHere(width);
  }

  private key(width: number): string {
    return this.keys.get(width) ?? '';
  }

  /** Coarse pass over the given widths, then bisect every interval whose state changed. */
  async run(coarse: number[]): Promise<void> {
    if (this.settings.order === 'ascending') return this.runAscending(coarse);
    for (const w of coarse) await this.measure(w);
    let budget = Math.max(64, coarse.length * REFINE_BUDGET_PER_WIDTH);
    // Breadth first, so running out of budget leaves every change roughly located.
    const queue: [number, number][] = [];
    for (let i = 0; i < coarse.length - 1; i++) {
      queue.push([coarse[i] as number, coarse[i + 1] as number]);
    }
    for (let next = queue.shift(); next; next = queue.shift()) {
      const [a, b] = next;
      if (b - a <= 1 || this.key(a) === this.key(b)) continue;
      if (budget-- <= 0) {
        this.unstable = true;
        return;
      }
      const mid = Math.floor((a + b) / 2);
      await this.measure(mid);
      queue.push([a, mid], [mid, b]);
    }
    // Coming back to widths measured a while ago should find the same layouts. A few of them,
    // since a carousel can be back on the same slide by chance.
    if (coarse.length < 2) return;
    const again = new Set([
      coarse[0],
      coarse[Math.floor(coarse.length / 2)],
      coarse[coarse.length - 1],
    ]);
    for (const w of again) {
      if (w === undefined) continue;
      if (stateKey(await this.analyzeAt(w)) !== this.key(w)) {
        this.unstable = true;
        return;
      }
    }
  }

  /** The same measurements as the breadth-first run, taken from narrowest to widest. */
  private async runAscending(coarse: number[]): Promise<void> {
    let budget = Math.max(64, coarse.length * REFINE_BUDGET_PER_WIDTH);
    const refine = async (a: number, b: number): Promise<void> => {
      if (b - a <= 1 || this.key(a) === this.key(b)) return;
      if (budget-- <= 0) {
        // Keep sweeping; changes from here on are located to the coarse step only.
        this.unstable = true;
        return;
      }
      const mid = Math.floor((a + b) / 2);
      await this.measure(mid);
      await refine(a, mid);
      await refine(mid, b);
    };
    for (let i = 0; i < coarse.length; i++) {
      await this.measure(coarse[i] as number);
      if (i > 0) await refine(coarse[i - 1] as number, coarse[i] as number);
    }
    // One step back, rather than all the way to the start, should find the same layout.
    const back = coarse[coarse.length - 2];
    if (back !== undefined) {
      const again = await this.analyzeAt(back);
      if (stateKey(again) !== this.key(back)) this.unstable = true;
    }
  }
}

/** Ranges this narrow get re-measured before being reported. */
const CONFIRM_BELOW_PX = 3;

/**
 * Measures issues that only show across a pixel or two once more, coming from
 * the other end of the range, and drops the ones that don't show up again.
 */
export async function confirmNarrowIssues(issues: Issue[], sweeper: Sweeper): Promise<Issue[]> {
  const kept: Issue[] = [];
  for (const issue of issues) {
    const narrow = issue.ranges.every((r) => r.to - r.from < CONFIRM_BELOW_PX);
    if (!narrow || issue.detector === 'unexpected-wrap') {
      kept.push(issue);
      continue;
    }
    const again = await sweeper.probe(issue.worstAt);
    const reproduced = again.findings.some((f) => findingKey(f) === issue.fingerprint);
    if (reproduced) kept.push(issue);
  }
  return kept;
}

declare global {
  interface Window {
    __breakhound?: {
      analyze: (options?: AnalyzeOptions) => AnalyzeResult;
      declaredBreakpoints: () => number[];
      settleAfterResize: (maxWaitMs: number) => Promise<void>;
      highlight: (opts: HighlightOptions) => Region | null;
      clearHighlights: () => void;
      hasContent: () => boolean;
      resolveSelector: (selector: string) => Element | null;
      toggleState: (selector: string) => { shown: boolean; open: boolean | null };
      setDetails: (selector: string, open: boolean) => void;
      clickPoint: (selector: string) => { x: number; y: number } | null;
      markShown: () => void;
      newlyShown: (toggle: string) => string | null;
      selectorShown: (selector: string) => boolean;
      findByText: (text: string) => import('@breakhound/analyzers').ElementInfo | null;
    };
  }
}
