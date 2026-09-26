import type {
  AnalyzeOptions,
  AnalyzeResult,
  HighlightOptions,
  Region,
} from '@breakhound/analyzers';
import type { Page } from 'playwright';
import { settleResize } from './settle';

export type Measurements = Map<number, AnalyzeResult>;

export interface SweepSettings {
  minWidth: number;
  maxWidth: number;
  height: number;
  maxSettleMs: number;
  analyze: AnalyzeOptions;
}

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

/** Everything that, if it changes between two widths, is worth locating to the pixel. */
export function stateKey(r: AnalyzeResult): string {
  const findings = r.findings
    .map((f) => `${f.detector}|${f.element.selector}|${f.related?.selector ?? ''}`)
    .sort()
    .join(',');
  const wraps = r.wraps
    .map((w) => `${w.kind}|${w.element.selector}|${w.lines}`)
    .sort()
    .join(',');
  return `${r.signature}#${findings}#${wraps}`;
}

export class Sweeper {
  readonly results: Measurements = new Map();
  private readonly keys = new Map<number, string>();

  constructor(
    private readonly page: Page,
    private readonly settings: SweepSettings,
  ) {}

  async measure(width: number, fresh = false): Promise<AnalyzeResult> {
    const cached = this.results.get(width);
    if (cached && !fresh) return cached;
    await this.page.setViewportSize({ width, height: this.settings.height });
    await settleResize(this.page, this.settings.maxSettleMs);
    const result = await this.page.evaluate((opts) => {
      const api = window.__breakhound;
      if (!api) throw new Error('breakhound analyzers were not injected into the page');
      return api.analyze(opts);
    }, this.settings.analyze);
    this.results.set(width, result);
    this.keys.set(width, stateKey(result));
    return result;
  }

  /** Measures a width from a different starting layout without touching the cache. */
  async probe(width: number): Promise<AnalyzeResult> {
    const { minWidth, maxWidth, height } = this.settings;
    const away = width - minWidth > maxWidth - width ? minWidth : maxWidth;
    await this.page.setViewportSize({ width: away, height });
    await settleResize(this.page, this.settings.maxSettleMs);
    await this.page.setViewportSize({ width, height });
    await settleResize(this.page, this.settings.maxSettleMs);
    return this.page.evaluate(
      (opts) => window.__breakhound?.analyze(opts) as AnalyzeResult,
      this.settings.analyze,
    );
  }

  private key(width: number): string {
    return this.keys.get(width) ?? '';
  }

  /** Coarse pass over the given widths, then bisect every interval whose state changed. */
  async run(coarse: number[]): Promise<void> {
    for (const w of coarse) await this.measure(w);
    for (let i = 0; i < coarse.length - 1; i++) {
      const a = coarse[i];
      const b = coarse[i + 1];
      if (a !== undefined && b !== undefined) await this.refine(a, b);
    }
  }

  private async refine(a: number, b: number): Promise<void> {
    if (b - a <= 1 || this.key(a) === this.key(b)) return;
    const mid = Math.floor((a + b) / 2);
    await this.measure(mid);
    await this.refine(a, mid);
    await this.refine(mid, b);
  }

  sortedWidths(): number[] {
    return [...this.results.keys()].sort((x, y) => x - y);
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
    };
  }
}
