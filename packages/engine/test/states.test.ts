import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AnalyzeResult, Toggle } from '@breakhound/analyzers';
import { afterAll, describe, expect, it } from 'vitest';
import { Scanner } from '../src/index';
import { describeState, pickToggles } from '../src/states';

const toggle = (selector: string, over: Partial<Toggle> = {}): Toggle => ({
  selector,
  kind: 'disclosure',
  label: selector,
  group: selector,
  priority: 5,
  ...over,
});

function measured(byWidth: Record<number, Toggle[]>): Map<number, AnalyzeResult> {
  return new Map(
    Object.entries(byWidth).map(([w, toggles]) => [
      Number(w),
      { width: Number(w), findings: [], wraps: [], signature: '', toggles },
    ]),
  );
}

describe('choosing what to open', () => {
  const burger = toggle('button.burger', { kind: 'menu', priority: 0, label: 'Menu' });
  const faq1 = toggle('.faq button:nth-of-type(1)', { group: 'faq' });
  const faq2 = toggle('.faq button:nth-of-type(2)', { group: 'faq' });
  const details = toggle('summary', { kind: 'details', priority: 7 });

  it('opens menus first, and one question of an FAQ stands for the rest', () => {
    const results = measured({
      320: [faq1, faq2, details, burger],
      336: [faq1, faq2, details, burger],
      352: [faq1, faq2, details],
    });
    const picked = pickToggles(results, [320, 336, 352], 5);
    expect(picked.map((c) => c.toggle.selector)).toEqual([
      'button.burger',
      '.faq button:nth-of-type(1)',
      'summary',
    ]);
    expect(pickToggles(results, [320, 336, 352], 1)).toHaveLength(1);
  });

  it('sweeps one hidden width past each end, to find exactly where the toggle shows', () => {
    const results = measured({ 320: [], 336: [burger], 352: [burger], 368: [], 384: [] });
    const [picked] = pickToggles(results, [320, 336, 352, 368, 384], 5);
    expect(picked?.widths).toEqual([320, 336, 352, 368]);
  });

  it('says what was open in plain words', () => {
    expect(describeState({ kind: 'menu', label: 'Menu', trigger: 'b' })).toBe('with "Menu" open');
    expect(describeState({ kind: 'menu', label: 'menu', trigger: 'b' })).toBe('with the menu open');
    expect(describeState({ kind: 'dialog', label: 'Sign up', trigger: 'b' })).toBe(
      'with the "Sign up" dialog open',
    );
    expect(describeState({ kind: 'details', label: 'Specs', trigger: 'summary' })).toBe(
      'with "Specs" expanded',
    );
    expect(describeState({ kind: 'tab', label: 'Quizzes', trigger: 'b' })).toBe(
      'with the "Quizzes" tab open',
    );
  });
});

describe('scanning a page with a dialog', () => {
  const scanner = new Scanner();
  afterAll(() => scanner.close());
  const url = pathToFileURL(
    join(import.meta.dirname, '../../../fixtures/pages/bug-modal.html'),
  ).href;
  const QUICK = { minWidth: 320, maxWidth: 800 };

  it('screenshots the issue with the dialog open', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'breakhound-states-'));
    const result = await scanner.scanPage(url, { ...QUICK, screenshotDir: dir });
    expect(result.states).toEqual([
      {
        kind: 'dialog',
        label: 'Sign up',
        trigger: 'button.open-modal',
        ranges: [{ from: 320, to: 800 }],
      },
    ]);
    const [issue] = result.issues;
    expect(issue?.state?.trigger).toBe('button.open-modal');
    expect(issue?.title).toBe(
      'Content cut off at the right edge by 160px, with the "Sign up" dialog open',
    );
    expect(issue?.screenshot).toBeDefined();
    expect(readdirSync(dir)).toContain(issue?.screenshot);
  });

  it('leaves everything closed with states: 0', async () => {
    const result = await scanner.scanPage(url, { ...QUICK, states: 0 });
    expect(result.states).toBeUndefined();
    expect(result.issues).toEqual([]);
  });
});

describe('scanning a page with tabs', () => {
  const scanner = new Scanner();
  afterAll(() => scanner.close());
  const url = pathToFileURL(
    join(import.meta.dirname, '../../../fixtures/pages/bug-tabs.html'),
  ).href;

  it('opens each tab that is not selected, and finds what breaks only in it', async () => {
    const result = await scanner.scanPage(url, { minWidth: 320, maxWidth: 800 });
    // Its classes change once selected, so its selector no longer matches it then.
    expect(result.states?.map((s) => [s.kind, s.label])).toEqual([
      ['tab', 'Schedule'],
      ['tab', 'Settings'],
    ]);
    expect(result.issues.map((i) => i.title)).toEqual([
      'Page scrolls horizontally (160px wider than the viewport), with the "Schedule" tab open',
    ]);
  });
});
