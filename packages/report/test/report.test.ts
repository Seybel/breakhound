import type { Issue, RouteResult, ScanResult } from '@breakhound/engine';
import { describe, expect, it } from 'vitest';
import { groupIssues, renderHtml, renderPrompt, renderSummary } from '../src/index';

function issue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: 'a1',
    fingerprint: 'page-overflow|header nav|',
    detector: 'page-overflow',
    severity: 'error',
    title: 'Page scrolls horizontally (38px wider than the viewport)',
    ranges: [{ from: 320, to: 357 }],
    worstAt: 320,
    element: {
      selector: 'header nav',
      path: 'header > nav',
      html: '<nav>',
      text: null,
      source: null,
    },
    evidence: { overflowPx: 38 },
    styles: { 'min-width': '358px' },
    suggestion: 'min-width: 358px stops it from shrinking.',
    ...overrides,
  };
}

function route(path: string, issues: Issue[], extra: Partial<RouteResult> = {}): RouteResult {
  return {
    route: path,
    url: `http://localhost:3000${path}`,
    finalUrl: `http://localhost:3000${path}`,
    status: 'scanned',
    pageErrors: [],
    warnings: [],
    breakpoints: { observed: [768], declared: [768], unexplained: [] },
    issues,
    measurements: 110,
    durationMs: 4000,
    ...extra,
  };
}

function result(routes: RouteResult[]): ScanResult {
  const all = routes.flatMap((r) => r.issues);
  const unique = [...new Map(all.map((i) => [i.fingerprint, i])).values()];
  return {
    schemaVersion: 1,
    tool: { name: 'breakhound', version: '0.1.0' },
    project: { framework: null, baseUrl: 'http://localhost:3000', root: null },
    startedAt: '2026-09-26T10:00:00.000Z',
    durationMs: 9000,
    settings: { minWidth: 320, maxWidth: 1920, step: 16, browsers: ['chromium'] },
    routes,
    summary: {
      routes: routes.length,
      issues: all.length,
      uniqueIssues: new Set(all.map((i) => i.fingerprint)).size,
      bySeverity: {
        error: unique.filter((i) => i.severity === 'error').length,
        warning: unique.filter((i) => i.severity === 'warning').length,
        info: unique.filter((i) => i.severity === 'info').length,
      },
    },
  };
}

const wrap = issue({
  id: 'b2',
  fingerprint: 'unexpected-wrap|ul.menu|',
  detector: 'unexpected-wrap',
  severity: 'warning',
  title: 'Row of 6 items wraps onto 2 lines',
  ranges: [{ from: 768, to: 919 }],
  worstAt: 768,
  element: {
    selector: 'ul.menu',
    path: 'nav > ul.menu',
    html: '<ul class="menu">',
    text: null,
    source: null,
  },
});

const scan = result([
  route('/', [issue(), wrap]),
  route('/pricing', [issue({ id: 'c3' })]),
  route('/broken', [], { status: 'empty', error: 'The page rendered nothing.' }),
]);

describe('grouping', () => {
  it('counts the same element breaking on several pages once', () => {
    const groups = groupIssues(scan);
    expect(groups).toHaveLength(2);
    expect(groups[0]?.routes.map((r) => r.route.route)).toEqual(['/', '/pricing']);
    expect(groups[0]?.issue.severity).toBe('error');
  });
});

describe('agent prompt', () => {
  it('lists each unique issue once with widths, element, fix and other pages', () => {
    const prompt = renderPrompt(scan, { verifyCommand: 'npx @seybel/breakhound' });
    expect(prompt.match(/Page scrolls horizontally/g)).toHaveLength(1);
    expect(prompt).toContain('320–357px (worst at 320px)');
    expect(prompt).toContain('`header nav`');
    expect(prompt).toContain('min-width: 358px stops it from shrinking.');
    expect(prompt).toContain('**Also on:** /pricing');
    expect(prompt).toContain('run `npx @seybel/breakhound`');
  });

  it('leaves out info issues by default and can target single issues', () => {
    const only = renderPrompt(scan, { fingerprints: ['unexpected-wrap|ul.menu|'] });
    expect(only).toContain('Row of 6 items wraps onto 2 lines');
    expect(only).not.toContain('Page scrolls horizontally');
  });
});

describe('summary', () => {
  it('has one row per unique issue and lists pages that could not be checked', () => {
    const md = renderSummary(scan);
    expect(md).toContain('found 2 issues (1 error, 1 warning)');
    expect(md).toContain('| ✖ | 320–357px | Page scrolls horizontally');
    expect(md).toContain(
      '## Pages that could not be checked\n\n- /broken: The page rendered nothing.',
    );
  });

  it('keeps pages behind a login and left-out routes apart from failures', () => {
    const md = renderSummary(
      result([
        route('/', []),
        route('/account', [], { status: 'login', error: 'Needs a login: it redirected to /login' }),
        route('/users/[id]', [], { status: 'skipped', url: '', error: 'No page links to it.' }),
      ]),
    );
    expect(md).toContain('Scanned 1 page from');
    expect(md).not.toContain('could not be checked');
    expect(md).toContain('## Pages that need a login\n\nRun `npx @seybel/breakhound login` once');
    expect(md).toContain('- /account: Needs a login: it redirected to /login');
    expect(md).toContain('## Routes left out\n\nGive dynamic routes a real URL with `samples`');
    expect(md).toContain('- /users/[id]: No page links to it.');
  });
});

describe('html report', () => {
  it('embeds the data safely and works without a network', () => {
    const nasty = result([route('/', [issue({ title: '</script><script>alert(1)</script>' })])]);
    const html = renderHtml(nasty);
    expect(html).not.toContain('</script><script>alert(1)');
    expect(html).toContain('\\u003c/script>');
    expect(html).not.toMatch(/<(link|script)[^>]+(href|src)="https?:/);
  });
});
