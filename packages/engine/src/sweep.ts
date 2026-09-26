import type { AnalyzeOptions, AnalyzeResult } from '@breakhound/analyzers';
import type { Page } from 'playwright';
import { settleResize } from './settle';

export type Measurements = Map<number, AnalyzeResult>;

export interface SweepSettings {
  minWidth: number;
  maxWidth: number;
  step: number;
  height: number;
  maxSettleMs: number;
  analyze: AnalyzeOptions;
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

  /** Coarse pass, then bisect every interval whose state changed. */
  async run(): Promise<void> {
    const { minWidth, maxWidth, step } = this.settings;
    const coarse: number[] = [];
    for (let w = minWidth; w < maxWidth; w += step) coarse.push(w);
    coarse.push(maxWidth);

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
    };
  }
}
