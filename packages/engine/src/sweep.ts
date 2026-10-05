import type {
  AnalyzeOptions,
  AnalyzeResult,
  HighlightOptions,
  Region,
} from '@breakhound/analyzers';
import type { Page } from 'playwright';
import { findingKey, INACTIVE } from './issues';
import { settleResize } from './settle';

export type Measurements = Map<number, AnalyzeResult>;

export interface SweepSettings {
  minWidth: number;
  maxWidth: number;
  height: number;
  maxSettleMs: number;
  analyze: AnalyzeOptions;
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
    readonly page: Page,
    private readonly settings: SweepSettings,
    private readonly prepare?: Prepare,
  ) {}

  async measure(width: number): Promise<AnalyzeResult> {
    const cached = this.results.get(width);
    if (cached) return cached;
    const result = await this.analyzeAt(width);
    this.results.set(width, result);
    this.keys.set(width, stateKey(result));
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
    // Coming back to where we started should find the same layout.
    const start = coarse[0];
    if (start !== undefined && coarse.length > 1) {
      const again = await this.analyzeAt(start);
      if (stateKey(again) !== this.key(start)) this.unstable = true;
    }
  }
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
