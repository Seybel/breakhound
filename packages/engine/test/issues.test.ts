import type { AnalyzeResult, Finding } from '@breakhound/analyzers';
import { describe, expect, it } from 'vitest';
import { buildIssues } from '../src/issues';

function overflow(selector: string, lineage: string[], overflowPx: number): Finding {
  return {
    detector: 'page-overflow',
    severity: 'error',
    title: `Page scrolls horizontally (${overflowPx}px wider than the viewport)`,
    element: { selector, path: selector, html: '<div>', text: null },
    lineage,
    evidence: { overflowPx, elementWidth: 350 },
    styles: {},
  };
}

function results(byWidth: Record<number, Finding[]>): [number[], Map<number, AnalyzeResult>] {
  const map = new Map<number, AnalyzeResult>();
  for (const [w, findings] of Object.entries(byWidth)) {
    map.set(Number(w), { width: Number(w), findings, wraps: [], signature: '' });
  }
  return [[...map.keys()].sort((a, b) => a - b), map];
}

describe('building issues', () => {
  it('folds a nested element into the outer one when their widths meet', () => {
    const [widths, map] = results({
      320: [overflow('form', ['main'], 30)],
      346: [overflow('form', ['main'], 10)],
      347: [overflow('form input', ['form', 'main'], 3)],
      350: [overflow('form input', ['form', 'main'], 1)],
      351: [],
    });
    const issues = buildIssues('/', widths, map);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.element.selector).toBe('form');
    expect(issues[0]?.ranges).toEqual([{ from: 320, to: 350 }]);
    expect(issues[0]?.evidence.alsoOverflowing).toBe('form input');
  });

  it('keeps unrelated elements apart', () => {
    const [widths, map] = results({
      320: [overflow('header', ['body > div'], 30), overflow('footer', ['body > div'], 20)],
      400: [],
    });
    expect(buildIssues('/', widths, map)).toHaveLength(2);
  });

  it('keeps one issue when the example member of a group changes with width', () => {
    const tap = (first: string): Finding => ({
      detector: 'small-tap-target',
      severity: 'warning',
      title: 'tap targets crowd each other',
      element: { selector: 'ul.social', path: 'ul', html: '<ul>', text: null },
      related: { selector: first, path: first, html: '<a>', text: null },
      evidence: {},
      styles: {},
    });
    const [widths, map] = results({
      320: [tap('li:nth-of-type(1) > a')],
      400: [tap('li:nth-of-type(3) > a')],
    });
    expect(buildIssues('/', widths, map)).toHaveLength(1);
  });
});
