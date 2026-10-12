import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { type Browser, chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type BrowserName, type Issue, type PageResult, Scanner } from '../src/index';

const PAGES = join(import.meta.dirname, '../../../fixtures/pages');
const RANGE_TOLERANCE = 1;
const SCAN = { minWidth: 320, maxWidth: 1440 };
/** The engine the pages are scanned in; BREAKHOUND_TEST_BROWSER=webkit or firefox checks the others. */
const BROWSER = (process.env.BREAKHOUND_TEST_BROWSER ?? 'chromium') as BrowserName;

interface Expectation {
  detector: string;
  range: { from: number; to: number } | null;
  selector: string;
  /** `:open` after the range: only shows with a menu, dialog or section opened. */
  open: boolean;
}

interface Scored {
  truePositives: number;
  falsePositives: Issue[];
  missed: Expectation[];
}

let scanner: Scanner;
let browser: Browser;
const totals = { tp: 0, fp: 0, fn: 0 };

beforeAll(async () => {
  scanner = new Scanner({ browser: BROWSER });
  browser = await chromium.launch();
});

afterAll(async () => {
  await scanner.close();
  await browser.close();
  const precision = totals.tp / Math.max(1, totals.tp + totals.fp);
  const recall = totals.tp / Math.max(1, totals.tp + totals.fn);
  console.log(
    `fixture accuracy in ${BROWSER}: precision ${(precision * 100).toFixed(1)}%, recall ${(recall * 100).toFixed(1)}% (tp ${totals.tp}, fp ${totals.fp}, fn ${totals.fn})`,
  );
});

/** Reads data-bh-expect markers and tags every issue with the markers on its element. */
async function score(url: string, result: PageResult): Promise<Scored> {
  const page = await browser.newPage();
  try {
    await page.goto(url);
    const expectations = await page.evaluate((browser) => {
      const out: {
        detector: string;
        range: { from: number; to: number } | null;
        selector: string;
        open: boolean;
      }[] = [];
      document.querySelectorAll('[data-bh-expect]').forEach((el, i) => {
        el.setAttribute('data-bh-test-id', String(i));
        for (const token of (el.getAttribute('data-bh-expect') ?? '')
          .split(/\s+/)
          .filter(Boolean)) {
          // `!firefox` after a marker: that engine lays the page out so the bug isn't there.
          const [marker = '', notIn = ''] = token.split('!');
          if (notIn.split(',').includes(browser)) continue;
          const [spec = '', state] = marker.split(':');
          const [detector = '', range] = spec.split('@');
          const [from, to] = (range ?? '').split('-').map(Number);
          out.push({
            detector,
            range: range ? { from: from ?? 0, to: to ?? 0 } : null,
            selector: `[data-bh-test-id="${i}"]`,
            open: state === 'open',
          });
        }
      });
      return out;
    }, BROWSER);

    const matched = new Set<Expectation>();
    const falsePositives: Issue[] = [];
    for (const issue of result.issues) {
      // An issue seen with a menu open can name it by classes it only has while open.
      const hit = await page.evaluate(
        ({ selector, trigger }) => {
          const toggle = trigger ? document.querySelector(trigger) : null;
          const press = () => {
            if (toggle?.matches('details > summary')) {
              const details = toggle.parentElement as HTMLDetailsElement;
              details.open = !details.open;
            } else (toggle as HTMLElement | null)?.click();
          };
          press();
          const id = document.querySelector(selector)?.getAttribute('data-bh-test-id') ?? null;
          press();
          return id;
        },
        { selector: issue.element.selector, trigger: issue.state?.trigger ?? null },
      );
      const exp = expectations.find(
        (e) =>
          !matched.has(e) &&
          hit !== null &&
          e.selector === `[data-bh-test-id="${hit}"]` &&
          e.detector === issue.detector &&
          e.open === Boolean(issue.state) &&
          (!e.range ||
            issue.ranges.some(
              (r) =>
                Math.abs(r.from - (e.range?.from ?? 0)) <= RANGE_TOLERANCE &&
                Math.abs(r.to - (e.range?.to ?? 0)) <= RANGE_TOLERANCE,
            )),
      );
      if (exp) matched.add(exp);
      else falsePositives.push(issue);
    }
    return {
      truePositives: matched.size,
      falsePositives,
      missed: expectations.filter((e) => !matched.has(e)),
    };
  } finally {
    await page.close();
  }
}

function describeIssues(issues: Issue[]): string {
  return issues
    .map(
      (i) =>
        `${i.detector} ${i.element.selector} ${i.ranges.map((r) => `${r.from}-${r.to}`).join(',')}${i.state ? ` (${i.state.kind} ${i.state.trigger} open)` : ''}`,
    )
    .join('\n');
}

const files = readdirSync(PAGES).filter((f) => f.endsWith('.html'));

describe(`fixture corpus in ${BROWSER}`, () => {
  for (const file of files) {
    it(file, async () => {
      const url = pathToFileURL(join(PAGES, file)).href;
      const result = await scanner.scanPage(url, SCAN);
      expect(result.status, result.error).toBe('scanned');
      expect(result.warnings).toEqual([]);

      const scored = await score(url, result);
      totals.tp += scored.truePositives;
      totals.fp += scored.falsePositives.length;
      totals.fn += scored.missed.length;

      expect(describeIssues(scored.falsePositives), 'unexpected issues').toBe('');
      expect(
        scored.missed.map(
          (m) =>
            `${m.detector}@${m.range ? `${m.range.from}-${m.range.to}` : '*'}${m.open ? ':open' : ''}`,
        ),
        `missed expectations; got:\n${describeIssues(result.issues)}`,
      ).toEqual([]);
    });
  }
});
